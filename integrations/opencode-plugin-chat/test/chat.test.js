import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chatListHandler,
  chatReadHandler,
  chatSteerHandler,
  sortActiveFirst,
  chatTools,
} from "../src/index.js";

function mockClient(overrides = {}) {
  return {
    session: {
      list: overrides.list ?? (async () => ({ data: [] })),
      status: overrides.status ?? (async () => ({ data: {} })),
      messages: overrides.messages ?? (async () => ({ data: [] })),
      prompt_async: overrides.prompt_async ?? (async () => ({ data: { messageID: "m1" } })),
    },
  };
}

test("sortActiveFirst puts active sessions first, then newest first", () => {
  const sessions = [
    { id: "a", time: { updated: 100 } },
    { id: "b", time: { updated: 300 } },
    { id: "c", time: { updated: 200 } },
    { id: "d", time: { updated: 400 } },
  ];
  const statuses = {
    b: { type: "busy" },
    d: { type: "working" },
    a: { type: "idle" },
    c: { type: "retry" },
  };
  const sorted = sortActiveFirst(sessions, statuses);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["d", "b", "c", "a"],
  );
});

test("chat_list calls list+status and annotates active flag", async () => {
  const list = async () => ({
    data: [
      { id: "s1", title: "Idle chat", time: { updated: 10 } },
      { id: "s2", title: "Busy chat", time: { updated: 20 } },
    ],
  });
  const status = async () => ({ data: { s1: { type: "idle" }, s2: { type: "busy" } } });
  const handler = chatListHandler(mockClient({ list, status }));
  const out = await handler();
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "s2");
  assert.equal(out[0].active, true);
  assert.equal(out[0].status, "busy");
  assert.equal(out[1].id, "s1");
  assert.equal(out[1].active, false);
});

test("chat_read requires an id", async () => {
  const handler = chatReadHandler(mockClient());
  await assert.rejects(() => handler({}), /'id' \(target session id\) is required/);
  await assert.rejects(() => handler({ id: "" }), /'id' \(target session id\) is required/);
});

test("chat_read calls session.messages with path+query and returns text parts only, redacted", async () => {
  let called = null;
  const messages = async (opts) => {
    called = opts;
    return {
      data: [
        {
          id: "m1",
          role: "user",
          time: { created: 1000 },
          parts: [{ type: "text", text: "hello" }, { type: "tool", tool: "x" }],
        },
        {
          id: "m2",
          role: "assistant",
          time: { created: 2000 },
          parts: [{ type: "text", text: "token: sk-abcdefghijklmnopqrstuvwxyz123" }],
        },
      ],
    };
  };
  const handler = chatReadHandler(mockClient({ messages }));
  const out = await handler({ id: "target", limit: 500, since: 1500 });
  assert.deepEqual(called, { path: { id: "target" }, query: { limit: 200 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "m2");
  assert.equal(out[0].role, "assistant");
  assert.match(out[0].text, /\[REDACTED\]/);
  assert.doesNotMatch(out[0].text, /sk-abcdefghijklmnopqrstuvwxyz123/);
});

test("chat_steer requires to and text", async () => {
  const handler = chatSteerHandler(mockClient());
  await assert.rejects(() => handler({ text: "hi" }), /'to' \(target session id\) is required/);
  await assert.rejects(() => handler({ to: "s1" }), /'text' is required/);
});

test("chat_steer rejects oversized text", async () => {
  const handler = chatSteerHandler(mockClient());
  await assert.rejects(
    () => handler({ to: "s1", text: "x".repeat(17 * 1024) }),
    /exceeds 16384 bytes/,
  );
});

test("chat_steer calls prompt_async with text part and noReply flag", async () => {
  let called = null;
  const prompt_async = async (opts) => {
    called = opts;
    return { data: { messageID: "mid-42" } };
  };
  const handler = chatSteerHandler(mockClient({ prompt_async }));
  const out = await handler({ to: "target-chat", text: "Please check the bridge tests", noReply: true });
  assert.deepEqual(called, {
    path: { id: "target-chat" },
    body: { parts: [{ type: "text", text: "Please check the bridge tests" }], noReply: true },
  });
  assert.deepEqual(out, { sent: true, to: "target-chat", noReply: true, messageID: "mid-42" });
});

test("chat_steer defaults noReply to false", async () => {
  let body = null;
  const prompt_async = async (opts) => {
    body = opts.body;
    return { data: {} };
  };
  const handler = chatSteerHandler(mockClient({ prompt_async }));
  await handler({ to: "t", text: "steer" });
  assert.equal(body.noReply, false);
});

test("chatTools registers chat_list, chat_read, chat_steer with execute returning title+output", async () => {
  for (const name of ["chat_list", "chat_read", "chat_steer"]) {
    assert.ok(chatTools[name], `missing tool ${name}`);
    assert.equal(typeof chatTools[name].execute, "function");
  }
  const context = { client: mockClient() };
  const listRes = await chatTools.chat_list.execute({}, context);
  assert.equal(listRes.title, "chat list");
  assert.ok(Array.isArray(JSON.parse(listRes.output)));
  const readRes = await chatTools.chat_read.execute({ id: "x" }, context);
  assert.equal(readRes.title, "chat read");
  const steerRes = await chatTools.chat_steer.execute(
    { to: "x", text: "hello" },
    { client: mockClient() },
  );
  assert.equal(steerRes.title, "chat steer");
  assert.equal(JSON.parse(steerRes.output).sent, true);
});