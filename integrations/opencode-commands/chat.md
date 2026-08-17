---
description: Chat-to-chat messaging - list sessions (active first), read another chat's history, or send a steer into another chat
agent: build
---
Use the opencode chat tools for the requested chat-to-chat action:

- `/chat list` — call `chat_list` and present the sessions. ACTIVE sessions
  (busy/working/running) must be shown FIRST, then the rest, newest first.
  Show id, title, status, and updated time for each.
- `/chat read <session-id> [limit]` — call `chat_read` with the given session
  id (and optional limit, default 50, max 200). Present the message history
  as role + text. Output is already redacted; never echo raw secrets.
- `/chat steer <session-id> <text>` — call `chat_steer` with `to` = session
  id and `text` = the steer message. Confirm delivery (sent, target id,
  message id). To inject without triggering a response, append
  `--no-reply` and pass noReply: true.

Rules: messaging is for active chats only; never steer or read sessions the
owner did not name; keep text under 16 KiB; never include secrets in steers.

Chat action: $ARGUMENTS