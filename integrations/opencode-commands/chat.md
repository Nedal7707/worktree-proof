---
description: Chat-to-chat messaging - list chats (active first), read another chat, or steer it. Target chats by number or name - no IDs needed.
agent: build
---
Use the opencode chat tools for the requested chat-to-chat action. Targets are
resolved for the user - never make them paste raw session IDs:

- `/chat list` — call `chat_list` and present the sessions as a NUMBERED list.
  ACTIVE sessions (busy/working/running) must be shown FIRST, then the rest,
  newest first. Each row: number, title, status, updated time.
- `/chat read <target> [limit]` — resolve `<target>` (see resolution rules),
  then call `chat_read` with that session id (optional limit, default 50,
  max 200). Present the history as role + text. Output is already redacted;
  never echo raw secrets.
- `/chat steer <target> <text>` — resolve `<target>`, then call `chat_steer`
  with `to` = session id and `text` = the steer message. Confirm delivery
  (sent, target title, message id). If the user appends `--no-reply`, pass
  noReply: true.

TARGET RESOLUTION RULES (in order):
1. A plain number N = the Nth row in the most recent `chat_list` output
   (re-run `chat_list` if the list is stale or unknown).
2. Otherwise, a case-insensitive substring match against chat titles. If
   exactly one chat matches, use it. If several match, show the numbered
   list and ask the user to pick a number.
3. If nothing matches, show the numbered list and say no match was found.

Rules: messaging is for active chats only; never steer or read chats the
owner did not name; keep text under 16 KiB; never include secrets in steers.

Chat action: $ARGUMENTS