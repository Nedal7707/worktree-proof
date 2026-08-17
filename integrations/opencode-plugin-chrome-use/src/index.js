import { tool } from "@opencode-ai/plugin";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ws from "ws";

const WebSocketImpl = globalThis.WebSocket ?? Ws;
const DEFAULT_CDP = "http://127.0.0.1:9333"; // Chrome Bridge extension relay (user's normal no-port Chrome)

const state = {
  endpoint: DEFAULT_CDP,
  target: null,
  socket: null,
  nextId: 0,
  pending: new Map(),
  console: [],
  network: [],
};

function output(title, value) {
  return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function addListener(socket, event, handler) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(event, handler);
  else socket.on(event, handler);
}

function isOpen(socket) {
  return socket && socket.readyState === (WebSocketImpl.OPEN ?? 1);
}

async function targets() {
  const response = await fetch(`${state.endpoint}/json/list`);
  if (!response.ok) throw new Error(`Chrome CDP list failed: HTTP ${response.status}`);
  return (await response.json()).filter((item) => item.type === "page");
}

async function disconnect() {
  for (const pending of state.pending.values()) pending.reject(new Error("Chrome CDP disconnected"));
  state.pending.clear();
  if (state.socket) state.socket.close();
  state.socket = null;
  state.target = null;
}

async function connect(targetId) {
  const available = await targets();
  const target = targetId ? available.find((item) => item.id === targetId) : available[0];
  if (!target) throw new Error("No Chrome page target found. Open the user's normal Chrome with the Chrome Bridge extension loaded (relay http://127.0.0.1:9333).");
  await disconnect();
  state.target = target;
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  state.socket = socket;

  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome CDP connection timed out")), 10000);
    addListener(socket, "open", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    addListener(socket, "error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  addListener(socket, "message", (event) => {
    const raw = event?.data ?? event;
    const message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    if (message.id && state.pending.has(message.id)) {
      const pending = state.pending.get(message.id);
      state.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      state.console.push({ type: message.params.type, args: message.params.args?.map((arg) => arg.value ?? arg.description) });
      state.console = state.console.slice(-100);
    }
    if (message.method === "Network.requestWillBeSent") {
      state.network.push({ method: message.params.request.method, url: message.params.request.url, type: message.params.type });
      state.network = state.network.slice(-200);
    }
  });
  addListener(socket, "close", () => {
    if (state.socket === socket) {
      state.socket = null;
      state.target = null;
    }
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Runtime.consoleAPICalled").catch(() => {});
  await send("Network.enable");
  return target;
}

function send(method, params = {}) {
  if (!isOpen(state.socket)) throw new Error("Chrome CDP is not connected");
  const id = ++state.nextId;
  return new Promise((resolvePromise, reject) => {
    state.pending.set(id, { resolve: resolvePromise, reject });
    state.socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error(`Chrome CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

async function ensureConnected(targetId) {
  if (!isOpen(state.socket)) await connect(targetId);
  else if (targetId && state.target?.id !== targetId) await connect(targetId);
  return state.target;
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Page evaluation failed");
  return result.result?.value;
}

async function waitForReady(timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate("document.readyState") === "complete") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for document readiness");
}

async function clickElement(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Element not found: ${selector}`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return point;
}

async function navigate({ url, waitMs = 500 }) {
  await ensureConnected();
  await send("Page.navigate", { url });
  if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
  return output("Chrome navigation", { url: await evaluate("location.href") });
}

const chromeTools = {
  chrome_connect: tool({
    description: "Connect to an existing Chrome instance through CDP. Never enter credentials or OTPs with this tool.",
    args: { endpoint: tool.schema.string().optional().describe("CDP HTTP endpoint, default http://127.0.0.1:9333 (Chrome Bridge extension relay)") },
    async execute(args) {
      state.endpoint = args.endpoint || DEFAULT_CDP;
      const target = await connect();
      return output("Chrome connected", { title: target.title, url: target.url, endpoint: state.endpoint });
    },
  }),
  chrome_navigate: tool({
    description: "Navigate the active Chrome page to a URL.",
    args: { url: tool.schema.string().url(), waitMs: tool.schema.number().int().min(0).max(30000).optional() },
    async execute(args) { return navigate(args); },
  }),
  chrome_click: tool({
    description: "Click a visible page element using its CSS selector.",
    args: { selector: tool.schema.string() },
    async execute(args) { await ensureConnected(); return output("Chrome click", { selector: args.selector, point: await clickElement(args.selector) }); },
  }),
  chrome_fill: tool({
    description: "Fill an input or textarea using its CSS selector and dispatch normal input/change events.",
    args: { selector: tool.schema.string(), text: tool.schema.string() },
    async execute(args) {
      await ensureConnected();
      const result = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(args.selector)});
        if (!element) return { error: "not found" };
        element.focus();
        if (element.isContentEditable) element.textContent = ${JSON.stringify(args.text)};
        else {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, ${JSON.stringify(args.text)});
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(args.text)} }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { tag: element.tagName };
      })()`);
      if (result?.error) throw new Error(`Element not found: ${args.selector}`);
      return output("Chrome fill", { selector: args.selector, filled: true });
    },
  }),
  chrome_type: tool({
    description: "Type text into the currently focused Chrome element. Do not use for passwords, OTPs, or other secrets.",
    args: { text: tool.schema.string() },
    async execute(args) { await ensureConnected(); await send("Input.insertText", { text: args.text }); return output("Chrome type", { characters: args.text.length }); },
  }),
  chrome_scroll: tool({
    description: "Scroll the active Chrome page or bring a selector into view.",
    args: { direction: tool.schema.enum(["up", "down"]).optional(), amount: tool.schema.number().int().min(1).max(10000).optional(), selector: tool.schema.string().optional() },
    async execute(args) {
      await ensureConnected();
      if (args.selector) await evaluate(`document.querySelector(${JSON.stringify(args.selector)})?.scrollIntoView({ block: "center" })`);
      else await evaluate(`window.scrollBy(0, ${(args.direction === "up" ? -1 : 1) * (args.amount || 600)})`);
      return output("Chrome scroll", { selector: args.selector, direction: args.direction || "down", amount: args.amount || 600 });
    },
  }),
  chrome_screenshot: tool({
    description: "Capture the active Chrome page. The screenshot is returned as an image attachment and can optionally be saved.",
    args: { savePath: tool.schema.string().optional(), fullPage: tool.schema.boolean().optional() },
    async execute(args, context) {
      await ensureConnected();
      const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(args.fullPage) });
      const bytes = Buffer.from(result.data, "base64");
      let saved;
      if (args.savePath) {
        saved = resolve(context.worktree, args.savePath);
        await writeFile(saved, bytes);
      }
      return { title: "Chrome screenshot", output: saved ? `Saved to ${saved}` : "Screenshot captured", attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${result.data}`, filename: "chrome-screenshot.png" }] };
    },
  }),
  chrome_extract: tool({
    description: "Extract text, outer HTML, or an attribute from a page element.",
    args: { selector: tool.schema.string(), attribute: tool.schema.string().optional() },
    async execute(args) {
      await ensureConnected();
      const expression = args.attribute === "html"
        ? `document.querySelector(${JSON.stringify(args.selector)})?.outerHTML ?? ""`
        : args.attribute
          ? `document.querySelector(${JSON.stringify(args.selector)})?.getAttribute(${JSON.stringify(args.attribute)}) ?? ""`
          : `document.querySelector(${JSON.stringify(args.selector)})?.innerText ?? ""`;
      return output("Chrome extract", { selector: args.selector, value: await evaluate(expression) });
    },
  }),
  chrome_wait: tool({
    description: "Wait for a page element, text, URL substring, or document readiness.",
    args: { kind: tool.schema.enum(["element", "text", "url", "ready"]).optional(), selector: tool.schema.string().optional(), text: tool.schema.string().optional(), url: tool.schema.string().optional(), timeoutMs: tool.schema.number().int().min(1).max(120000).optional() },
    async execute(args) {
      await ensureConnected();
      const kind = args.kind || "ready";
      const deadline = Date.now() + (args.timeoutMs || 30000);
      while (Date.now() < deadline) {
        const found = kind === "element" ? await evaluate(`Boolean(document.querySelector(${JSON.stringify(args.selector || "")}))`)
          : kind === "text" ? await evaluate(`document.body?.innerText.includes(${JSON.stringify(args.text || "")})`)
            : kind === "url" ? (await evaluate("location.href")).includes(args.url || "")
              : (await evaluate("document.readyState")) === "complete";
        if (found) return output("Chrome wait", { kind, found: true });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      }
      throw new Error(`Chrome wait timed out: ${kind}`);
    },
  }),
  chrome_tabs: tool({
    description: "List, activate, open, or close Chrome tabs.",
    args: { action: tool.schema.enum(["list", "activate", "new", "close"]).optional(), targetId: tool.schema.string().optional(), url: tool.schema.string().optional() },
    async execute(args) {
      const action = args.action || "list";
      if (action === "list") return output("Chrome tabs", (await targets()).map((item) => ({ id: item.id, title: item.title, url: item.url })));
      if (action === "new") {
        const response = await fetch(`${state.endpoint}/json/new?${encodeURIComponent(args.url || "about:blank")}`, { method: "PUT" });
        if (!response.ok) throw new Error(`Chrome new tab failed: HTTP ${response.status}`);
        const target = await response.json();
        await connect(target.id);
        return output("Chrome tab opened", { id: target.id, url: target.url });
      }
      if (!args.targetId) throw new Error(`${action} requires targetId`);
      if (action === "activate") {
        await fetch(`${state.endpoint}/json/activate/${args.targetId}`);
        const target = await connect(args.targetId);
        return output("Chrome tab activated", { id: target.id, title: target.title, url: target.url });
      }
      const response = await fetch(`${state.endpoint}/json/close/${args.targetId}`);
      if (!response.ok) throw new Error(`Chrome close tab failed: HTTP ${response.status}`);
      if (state.target?.id === args.targetId) await disconnect();
      return output("Chrome tab closed", { id: args.targetId });
    },
  }),
  chrome_evaluate: tool({
    description: "Evaluate JavaScript in the active page. Use only for the user's explicitly requested page interaction; never inspect cookies or storage.",
    args: { expression: tool.schema.string() },
    async execute(args) { await ensureConnected(); return output("Chrome evaluate", await evaluate(args.expression)); },
  }),
  chrome_console: tool({
    description: "Read recent browser console events collected since the Chrome connection.",
    args: { clear: tool.schema.boolean().optional() },
    async execute(args) { const value = [...state.console]; if (args.clear) state.console.length = 0; return output("Chrome console", value); },
  }),
  chrome_network: tool({
    description: "Read recent browser network request metadata collected since the Chrome connection (URLs only, no response bodies or credentials).",
    args: { clear: tool.schema.boolean().optional() },
    async execute(args) { const value = [...state.network]; if (args.clear) state.network.length = 0; return output("Chrome network", value); },
  }),
};

export const ChromeUsePlugin = async ({ client }) => {
  await client.app.log({ body: { service: "worktreeproof-chrome-use", level: "info", message: "Chrome Use tools loaded" } }).catch(() => {});
  return { tool: chromeTools };
};
