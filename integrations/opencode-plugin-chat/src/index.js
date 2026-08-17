import { tool } from "@opencode-ai/plugin";

// opencode-plugin-chat — chat-to-chat messaging for OpenCode.
//
// Tools:
//   chat_list  — list sessions; ACTIVE sessions first, then the rest (newest first)
//   chat_read  — read another chat's message history (text parts only, secrets redacted)
//   chat_steer — send a steering message into another chat via prompt_async
//
// Safety rules enforced here:
//   - chat_read is read-only and redacts secrets in output.
//   - chat_steer only appends a text part to the target session through the
//     server's own prompt_async endpoint; it never mutates storage directly.
//   - Text is size-bounded (16 KiB) and arguments are validated.

const MAX_STEER_BYTES = 16 * 1024;
const MAX_READ_LIMIT = 200;
const DEFAULT_READ_LIMIT = 50;

// Same secret-class patterns the bridge uses: bearer tokens, private keys,
// credential-ish assignments, and common prefixed tokens.
const SECRET =
  /(?:bearer\s+|-----BEGIN [^-]+ PRIVATE KEY-----|(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|auth|cookie|credential)\s*[:=]|\b(?:sk|gh[pousr]|xox[baprs])[-_][a-z0-9-]{12,})/giu;

function redact(value) {
  return String(value).replace(SECRET, "[REDACTED]");
}

// Statuses reported by GET /session/status. "Active" = the session is
// currently working (busy/working/running/pending/queued). Everything else
// (idle, retry, error, unknown) sorts after active sessions.
const ACTIVE_STATUSES = new Set(["busy", "working", "running", "pending", "queued"]);

function statusOf(statuses, id) {
  const entry = statuses ? statuses[id] : undefined;
  if (!entry) return "idle";
  return typeof entry === "string" ? entry : entry.type || "idle";
}

export function sortActiveFirst(sessions, statuses) {
  return [...sessions].sort((a, b) => {
    const ra = ACTIVE_STATUSES.has(statusOf(statuses, a.id)) ? 0 : 1;
    const rb = ACTIVE_STATUSES.has(statusOf(statuses, b.id)) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
  });
}

function dataOf(result) {
  return result && typeof result === "object" && "data" in result ? result.data : result;
}

export function chatListHandler(client) {
  return async () => {
    const [sessionsResult, statusResult] = await Promise.all([
      client.session.list(),
      client.session.status(),
    ]);
    const sessions = dataOf(sessionsResult);
    const statuses = dataOf(statusResult) || {};
    const sorted = sortActiveFirst(Array.isArray(sessions) ? sessions : [], statuses);
    return sorted.map((s) => ({
      id: s.id,
      title: s.title || "(untitled)",
      status: statusOf(statuses, s.id),
      active: ACTIVE_STATUSES.has(statusOf(statuses, s.id)),
      updated: s.time?.updated ?? 0,
    }));
  };
}

export function chatReadHandler(client) {
  return async ({ id, limit = DEFAULT_READ_LIMIT, since } = {}) => {
    if (!id || typeof id !== "string" || id.length === 0) {
      throw new Error("chat_read: 'id' (target session id) is required");
    }
    const capped = Math.min(Math.max(1, Number(limit) || DEFAULT_READ_LIMIT), MAX_READ_LIMIT);
    const result = await client.session.messages({
      path: { id },
      query: { limit: capped },
    });
    const messages = dataOf(result);
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const message of messages) {
      const created = message.time?.created ?? 0;
      if (since && created < Number(since)) continue;
      const text = (message.parts ?? [])
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      out.push({
        id: message.id,
        role: message.role ?? "unknown",
        time: created,
        text: redact(text),
      });
    }
    return out;
  };
}

export function chatSteerHandler(client) {
  return async ({ to, text, noReply = false } = {}) => {
    if (!to || typeof to !== "string" || to.length === 0) {
      throw new Error("chat_steer: 'to' (target session id) is required");
    }
    if (!text || typeof text !== "string" || text.length === 0) {
      throw new Error("chat_steer: 'text' is required");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_STEER_BYTES) {
      throw new Error(`chat_steer: text exceeds ${MAX_STEER_BYTES} bytes`);
    }
    const result = await client.session.prompt_async({
      path: { id: to },
      body: {
        parts: [{ type: "text", text }],
        noReply: Boolean(noReply),
      },
    });
    const data = dataOf(result);
    return {
      sent: true,
      to,
      noReply: Boolean(noReply),
      messageID: data?.messageID ?? null,
    };
  };
}

function result(title, value) {
  return { title, output: JSON.stringify(value, null, 2) };
}

export const chatTools = {
  chat_list: tool({
    description:
      "List opencode sessions (chats). Active sessions (busy/working/running) are listed FIRST, then the rest, newest first.",
    args: {},
    async execute(_, context) {
      return result("chat list", await chatListHandler(context.client)());
    },
  }),
  chat_read: tool({
    description:
      "Read another opencode chat's message history (text parts only; secrets redacted). Read-only.",
    args: {
      id: tool.schema.string().describe("Target session id (from chat_list)"),
      limit: tool.schema.number().optional().describe("Max messages to return (default 50, max 200)"),
      since: tool.schema.number().optional().describe("Only messages with time.created >= this epoch ms"),
    },
    async execute(args, context) {
      return result("chat read", await chatReadHandler(context.client)(args));
    },
  }),
  chat_steer: tool({
    description:
      "Send a steering message into another opencode chat. The target agent sees it in its context and acts on it; with noReply=true the message is injected without triggering a response.",
    args: {
      to: tool.schema.string().describe("Target session id (from chat_list)"),
      text: tool.schema.string().describe("Steer text (max 16 KiB)"),
      noReply: tool.schema.boolean().optional().describe("Inject without triggering a response (default false)"),
    },
    async execute(args, context) {
      return result("chat steer", await chatSteerHandler(context.client)(args));
    },
  }),
};

export default chatTools;