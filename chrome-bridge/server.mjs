#!/usr/bin/env node
// Chrome Bridge relay server.
// Listens on 127.0.0.1:9333 and exposes CDP-compatible endpoints that agents
// connect to (chrome_connect / chrome_* tools). The real CDP backend is the
// Chrome Bridge extension running inside the user's NORMAL Chrome (no debug
// port): the extension connects OUT to ws://127.0.0.1:9333/bridge and this
// relay proxies commands/events between agents and the extension.
//
// Endpoints:
//   GET  /json/version          -> browser info (CDP-compatible)
//   GET  /json/list             -> tabs reported by the extension
//   WS   /devtools/page/<id>    -> CDP session proxy for one tab
//   WS   /bridge                -> extension uplink (internal)
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.CHROME_BRIDGE_PORT || 9333);
const HOST = "127.0.0.1";

let extensionSocket = null; // the single extension uplink
let lastPongAt = 0; // last keepalive pong from the extension (0 = none yet)
let tabCache = []; // last tabs payload from the extension
const browserVersion = `Chrome/151.0.7922.138 (via chrome-bridge)`;
let nextConnId = 1;
const pageSockets = new Map(); // tabId(string) -> Set<agent ws>
const pendingByRelayId = new Map(); // relayId -> { socket, tabId }

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (req.method === "GET" && url.pathname === "/json/version") {
    sendJson(res, 200, {
      Browser: browserVersion,
      "Protocol-Version": "1.3",
      "User-Agent": browserVersion,
      "V8-Version": "13.0",
      "WebKit-Version": "615.1",
      webSocketDebuggerUrl: `ws://${HOST}:${PORT}/devtools/browser/0`,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/json/list") {
    const list = tabCache.map((t) => ({
      id: t.id,
      type: "page",
      title: t.title || "",
      url: t.url || "",
      webSocketDebuggerUrl: `ws://${HOST}:${PORT}/devtools/page/${t.id}`,
      devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${HOST}:${PORT}/devtools/page/${t.id}`,
    }));
    sendJson(res, 200, list);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/json/")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("chrome-bridge relay: use /json/version, /json/list, /devtools/page/<id>, /bridge");
});

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

function isExtensionUplink(req) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  return url.pathname === "/bridge";
}

function pageTargetIdFromUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const m = url.pathname.match(/^\/devtools\/page\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

wss.on("connection", (socket, req) => {
  if (isExtensionUplink(req)) {
    // Extension uplink: replace any previous socket (stale/zombie sockets from
    // a terminated service worker must never block a live reconnect).
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      try {
        extensionSocket.terminate();
      } catch {}
    }
    extensionSocket = socket;
    lastPongAt = Date.now();
    socket.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "tabs") {
        tabCache = Array.isArray(msg.tabs) ? msg.tabs : [];
      } else if (msg.type === "result" || msg.type === "error") {
        routeToPageSocket(msg);
      } else if (msg.type === "event") {
        routeEventToPageSockets(msg);
      } else if (msg.type === "pong") {
        // keepalive ack
        lastPongAt = Date.now();
      }
    });
    socket.on("close", () => {
      if (extensionSocket === socket) extensionSocket = null;
    });
    socket.on("error", () => {
      if (extensionSocket === socket) extensionSocket = null;
    });
    return;
  }

  const tabId = pageTargetIdFromUrl(req);
  if (tabId === null) {
    socket.close(4001, "expected /devtools/page/<id> or /bridge");
    return;
  }

  // Agent page session.
  const connId = nextConnId++;
  if (!pageSockets.has(tabId)) pageSockets.set(tabId, new Set());
  const set = pageSockets.get(tabId);
  set.add(socket);

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    const relayId = `${connId}:${msg.id}`;
    pendingByRelayId.set(relayId, { socket, tabId });
    const ok = sendToExtension({
      type: "command",
      id: relayId,
      tabId: Number(tabId),
      method: msg.method,
      params: msg.params || {},
    });
    if (!ok) {
      pendingByRelayId.delete(relayId);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            id: msg.id,
            error: { message: "chrome-bridge: extension not connected" },
          })
        );
      }
    }
  });

  socket.on("close", () => {
    set.delete(socket);
    if (set.size === 0) pageSockets.delete(tabId);
    for (const [rid, entry] of pendingByRelayId) {
      if (entry.socket === socket) pendingByRelayId.delete(rid);
    }
  });
  socket.on("error", () => socket.close());
});

function sendToExtension(obj) {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    extensionSocket.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function routeToPageSocket(msg) {
  const rid = String(msg.id || "");
  const sep = rid.indexOf(":");
  if (sep < 0) return;
  const origId = Number(rid.slice(sep + 1));
  const entry = pendingByRelayId.get(rid);
  if (!entry) return;
  pendingByRelayId.delete(rid);
  const { socket } = entry;
  if (socket.readyState !== WebSocket.OPEN) return;
  const out = { id: origId };
  if (msg.type === "result") out.result = msg.result || {};
  else out.error = msg.error || { message: "unknown error" };
  socket.send(JSON.stringify(out));
}

function routeEventToPageSockets(msg) {
  const set = pageSockets.get(String(msg.tabId));
  if (!set) return;
  const out = JSON.stringify({ method: msg.method, params: msg.params || {} });
  for (const sock of set) {
    if (sock.readyState === WebSocket.OPEN) sock.send(out);
  }
}

// Keepalive ping to the extension every 20s (keeps SW alive + detects dead link).
setInterval(() => {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    // If the extension has not answered a ping in 60s, the socket is a zombie
    // (e.g. Chrome terminated the service worker without a clean close).
    // Terminate it so the next reconnect is accepted instead of rejected.
    if (lastPongAt > 0 && Date.now() - lastPongAt > 60000) {
      try {
        extensionSocket.terminate();
      } catch {}
      return;
    }
    try {
      extensionSocket.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
}, 20000);

server.listen(PORT, HOST, () => {
  console.log(`chrome-bridge relay listening on http://${HOST}:${PORT}`);
  console.log(`  /json/version  /json/list  /devtools/page/<id>  /bridge`);
});