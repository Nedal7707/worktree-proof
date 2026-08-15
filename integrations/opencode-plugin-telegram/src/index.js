import { tool } from "@opencode-ai/plugin";
import Ws from "ws";

const WebSocketImpl = globalThis.WebSocket ?? Ws;
const CDP = "http://127.0.0.1:9222";

const state = { socket: null, nextId: 0, pending: new Map() };

function output(title, value) {
  return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

async function targets() {
  const response = await fetch(`${CDP}/json/list`);
  return (await response.json()).filter((t) => t.type === "page" && t.url.includes("web.telegram.org"));
}

function connectTarget(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => reject(new Error("Telegram CDP connect timeout")), 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(socket); });
    socket.addEventListener("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function ensureConnected() {
  if (state.socket && state.socket.readyState === WebSocketImpl.OPEN) return;
  const pages = await targets();
  if (pages.length === 0) throw new Error("Telegram Web is not open in the logged-in Chrome. Open https://web.telegram.org/a/ first.");
  state.socket = await connectTarget(pages[0].webSocketDebuggerUrl);
  state.socket.addEventListener("message", (event) => {
    const raw = event?.data ?? event;
    const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    if (msg.id && state.pending.has(msg.id)) {
      const p = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {});
    }
  });
}

function send(method, params = {}) {
  const id = ++state.nextId;
  return new Promise((resolvePromise, reject) => {
    state.pending.set(id, { resolve: resolvePromise, reject });
    state.socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error(`Telegram CDP timeout: ${method}`));
      }
    }, 20000);
  });
}

async function evaluate(expression) {
  await ensureConnected();
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Telegram evaluation failed");
  return result.result?.value;
}

const telegramTools = {
  telegram_status: tool({
    description: "Check whether Telegram Web is open and logged in in the user's Chrome.",
    args: {},
    async execute() {
      const pages = await targets();
      if (pages.length === 0) return output("Telegram status", { open: false, hint: "Open https://web.telegram.org/a/ in the logged-in Chrome" });
      const loggedIn = await evaluate("document.body.innerText.includes('Search') || document.body.innerText.includes('Saved Messages') || !!document.querySelector('.chat-list')");
      return output("Telegram status", { open: true, loggedIn, url: pages[0].url });
    },
  }),
  telegram_send: tool({
    description: "Send a Telegram message to a chat by name using the logged-in Telegram Web session in Chrome.",
    args: { chat: tool.schema.string().describe("Chat title, e.g. 'My Channel' or contact name"), text: tool.schema.string().describe("Message text") },
    async execute(args) {
      await ensureConnected();
      // Open search, type the chat name, open the first result
      await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').toLowerCase().includes('search')); if(b) b.click(); return !!b; })()`);
      await new Promise((r) => setTimeout(r, 500));
      await evaluate(`(() => { const i = document.querySelector('input[placeholder*="Search"]'); if(i){ i.value = ${JSON.stringify(args.chat)}; i.dispatchEvent(new Event('input', {bubbles:true})); i.dispatchEvent(new Event('change', {bubbles:true})); } return !!i; })()`);
      await new Promise((r) => setTimeout(r, 1200));
      await evaluate(`(() => { const el = [...document.querySelectorAll('.chatlist-chat, .ListItem')].find(x => (x.textContent||'').includes(${JSON.stringify(args.chat)})); if(el){ el.click(); return true; } return false; })()`);
      await new Promise((r) => setTimeout(r, 800));
      const sent = await evaluate(`(() => { const ta = document.querySelector('div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"]'); if(!ta) return { error: 'message input not found' }; ta.focus(); document.execCommand('insertText', false, ${JSON.stringify(args.text)}); ta.dispatchEvent(new Event('input', {bubbles:true})); const btn = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').toLowerCase().includes('send')); if(btn){ btn.click(); return { sent: true }; } return { error: 'send button not found' }; })()`);
      return output("Telegram send", { chat: args.chat, ...sent });
    },
  }),
  telegram_read: tool({
    description: "Read recent messages from the currently open Telegram chat (bounded).",
    args: { limit: tool.schema.number().int().min(1).max(20).optional() },
    async execute(args) {
      await ensureConnected();
      const messages = await evaluate(`(() => [...document.querySelectorAll('.message')].slice(-${args.limit || 10}).map(m => (m.textContent||'').trim().slice(0,300)))()`);
      return output("Telegram read", messages);
    },
  }),
};

export const TelegramPlugin = async ({ client }) => {
  await client.app.log({ body: { service: "worktreeproof-telegram", level: "info", message: "Telegram tools loaded" } }).catch(() => {});
  return { tool: telegramTools };
};
