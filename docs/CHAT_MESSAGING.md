# Chat-to-Chat Messaging for OpenCode

`opencode-plugin-chat` lets any opencode chat talk to any other opencode chat,
in both directions:

- **Read** another chat's history (read-only, secrets redacted).
- **Steer** another chat: inject a steering message into its context via the
  server's own `prompt_async` endpoint, so the target agent sees it and acts
  on it (optionally without triggering a response).

It is the opencode equivalent of the Codex app's inter-chat messaging/handoff.

## Tools

| Tool | Purpose |
|---|---|
| `chat_list` | List sessions. **Active sessions (busy/working/running) are listed FIRST**, then the rest, newest first. Each entry: id, title, status, active flag, updated. |
| `chat_read` | Read another chat's message history. Args: `id` (required), `limit` (default 50, max 200), `since` (epoch ms). Text parts only; secrets redacted. |
| `chat_steer` | Send a steer into another chat. Args: `to` (required), `text` (required, max 16 KiB), `noReply` (optional, default false). Calls `prompt_async`. |

## Usage

### Humans (`/chat` command)

```
/chat list                     # sessions, active first
/chat read <session-id> [50]   # read that chat's history
/chat steer <session-id> <text>   # steer that chat (it will respond)
/chat steer <session-id> <text> --no-reply   # inject without a response
```

### Agents (tools)

```js
// list chats, active first
const sessions = await chat_list();

// read another chat's history
const history = await chat_read({ id: "session-abc", limit: 50 });

// steer another chat
await chat_steer({ to: "session-abc", text: "Please review the bridge PR", noReply: false });
```

## How it works

The plugin uses the opencode server SDK client (`ctx.client`), the same
authoritative surface the TUI uses:

- `chat_list` → `GET /session` + `GET /session/status`, sorted active-first.
- `chat_read` → `GET /session/{id}/message` (read-only).
- `chat_steer` → `POST /session/{id}/prompt_async` with a text part.

No direct storage access, no file bridges, no side channels — the server is
the single source of truth.

## Safety rules

- **Active chats only.** Messaging is for chats the owner names; `chat_list`
  surfaces active sessions first so targets are picked deliberately.
- **Read-only read.** `chat_read` never mutates the target session.
- **No secrets.** `chat_read` redacts credential-class patterns
  (bearer tokens, private keys, `sk-`/`gh*`/`xox*` tokens, `key=`/`token=`
  assignments) before returning text. Never put secrets inside steers.
- **Bounded.** Steers are capped at 16 KiB; reads are capped at 200 messages.
- **Server-mediated.** Steers go through `prompt_async` — the target session's
  normal message pipeline — never by editing another session's storage.

## Install

Add the plugin to the global opencode config:

```jsonc
// ~/.config/opencode/opencode.json(c)
{ "plugin": [ ..., "opencode-plugin-chat" ] }
```

and copy `integrations/opencode-commands/chat.md` into
`~/.config/opencode/commands/` (or keep it in the repo's
`integrations/opencode-commands/` if the repo is the plugin source).

## Tests

```bash
node --test integrations/opencode-plugin-chat/test/chat.test.js
```

Covers active-first sorting, argument validation, redaction, size caps, and
the exact client call shapes with a mocked client.