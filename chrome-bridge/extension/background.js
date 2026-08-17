// Chrome Bridge background service worker (MV3).
// Connects OUT to the local relay (ws://127.0.0.1:9333/bridge) so the normal
// Chrome needs NO --remote-debugging-port. The relay exposes CDP-compatible
// HTTP/WS endpoints that agents connect to; this worker is the CDP backend.

const RELAY_URL = "ws://127.0.0.1:9333/bridge";
const PROTOCOL_VERSION = "1.3";
const RECONNECT_ALARM = "chrome-bridge-reconnect";
const RECONNECT_ALARM_PERIOD_MIN = 0.5; // keep SW alive; MV3 SWs die after ~30s idle

let ws = null;
let reconnectDelayMs = 1000;
let attachedTabs = new Set(); // tabId -> true (debugger attached)

// ---------------------------------------------------------------------------
// MV3 service-worker keep-alive (pattern copied from the ChatGPT/Codex
// extension: chrome.alarms wakes the SW so the outbound WS survives).
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm();
  connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm();
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  }
});

function ensureReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_PERIOD_MIN });
}

// ---------------------------------------------------------------------------
// Relay connection (outbound)
// ---------------------------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // already connected or connecting — never duplicate
  }
  let socket;
  try {
    socket = new WebSocket(RELAY_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    reconnectDelayMs = 1000;
    sendTabs();
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "command") {
      handleCommand(msg).catch((err) => {
        send({
          type: "error",
          id: msg.id,
          tabId: msg.tabId,
          error: { message: String((err && err.message) || err) },
        });
      });
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "getTabs") {
      sendTabs();
    }
  };
  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      attachedTabs.clear();
      scheduleReconnect();
    }
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CDP command handling
// ---------------------------------------------------------------------------

async function handleCommand(msg) {
  const { id, tabId, method, params } = msg;
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error(`chrome-bridge: command ${method} requires numeric tabId`);
  }
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
  send({ type: "result", id, tabId, result: result || {} });
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attachedTabs.add(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) {
    send({ type: "event", tabId: source.tabId, method, params: params || {} });
  }
});

// ---------------------------------------------------------------------------
// Tab inventory (kept fresh for /json/list)
// ---------------------------------------------------------------------------

function sendTabs() {
  chrome.tabs
    .query({})
    .then((tabs) => {
      const list = tabs.map((t) => ({
        id: String(t.id),
        type: "page",
        title: t.title || "",
        url: t.url || "",
        active: !!t.active,
        windowId: t.windowId,
      }));
      send({ type: "tabs", tabs: list });
    })
    .catch(() => {});
}

chrome.tabs.onCreated.addListener(sendTabs);
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  sendTabs();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.title || info.status) sendTabs();
});
chrome.tabs.onActivated.addListener(sendTabs);

connect();