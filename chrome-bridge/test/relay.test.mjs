import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PORT = 19333; // test port
let serverProc = null;
const BRIDGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ["server.mjs"], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, CHROME_BRIDGE_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    serverProc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("listening")) resolve();
    });
    serverProc.stderr.on("data", (d) => {
      out += d.toString();
    });
    setTimeout(() => reject(new Error("server did not start: " + out)), 8000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.on("exit", () => resolve());
    serverProc.kill();
    setTimeout(resolve, 1500);
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${path}`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}

function openWs(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("relay: /json/version and /json/list before extension", async (t) => {
  await startServer();
  t.after(stopServer);
  const v = await getJson("/json/version");
  assert.equal(v.status, 200);
  assert.match(v.body.Browser, /chrome-bridge/);
  const l = await getJson("/json/list");
  assert.equal(l.status, 200);
  assert.deepEqual(l.body, []);
});

test("relay: extension uplink pushes tabs and command round-trips", async (t) => {
  await startServer();
  t.after(stopServer);

  // Simulate the extension: connect to /bridge, push tabs, answer commands.
  const ext = await openWs("/bridge");
  ext.send(
    JSON.stringify({
      type: "tabs",
      tabs: [{ id: "7", type: "page", title: "Test", url: "https://example.com", active: true }],
    })
  );
  await new Promise((r) => setTimeout(r, 200));

  const l = await getJson("/json/list");
  assert.equal(l.body.length, 1);
  assert.equal(l.body[0].id, "7");
  assert.equal(l.body[0].title, "Test");
  assert.equal(l.body[0].url, "https://example.com");

  // Agent connects to the page target and sends a CDP command.
  const agent = await openWs(`/devtools/page/7`);
  const cmdPromise = new Promise((resolve) => {
    agent.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
  agent.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1+1" } }));

  // Extension receives the command and replies.
  const cmdFromRelay = await new Promise((resolve) => {
    ext.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "command") resolve(msg);
    });
  });
  assert.equal(cmdFromRelay.tabId, 7);
  assert.equal(cmdFromRelay.method, "Runtime.evaluate");
  ext.send(
    JSON.stringify({
      type: "result",
      id: cmdFromRelay.id,
      tabId: 7,
      result: { result: { type: "number", value: 2 } },
    })
  );

  const reply = await cmdPromise;
  assert.equal(reply.id, 1);
  assert.equal(reply.result.result.value, 2);

  // Event fan-out to the agent.
  const eventPromise = new Promise((resolve) => {
    agent.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method) resolve(msg);
    });
  });
  ext.send(JSON.stringify({ type: "event", tabId: 7, method: "Page.loadEventFired", params: { t: 1 } }));
  const ev = await eventPromise;
  assert.equal(ev.method, "Page.loadEventFired");

  agent.close();
  ext.close();
});

test("relay: command with no extension returns error to agent", async (t) => {
  await startServer();
  t.after(stopServer);
  // No extension connected; push a tab cache manually is impossible without
  // extension, so connect agent to a fake tab id and expect error response.
  const agent = await openWs(`/devtools/page/99`);
  const replyPromise = new Promise((resolve) => {
    agent.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
  agent.send(JSON.stringify({ id: 5, method: "Runtime.evaluate", params: {} }));
  const reply = await replyPromise;
  assert.equal(reply.id, 5);
  assert.match(reply.error.message, /extension not connected/);
  agent.close();
});