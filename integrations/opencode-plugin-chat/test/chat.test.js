import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chatListHandler,
  chatReadHandler,
  chatSteerHandler,
  chatStartHandler,
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
      create: overrides.create ?? (async () => ({ data: { id: "new-session" } })),
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

test("chatTools registers chat_list, chat_read, chat_steer, chat_start with execute returning title+output", async () => {
  for (const name of ["chat_list", "chat_read", "chat_steer", "chat_start"]) {
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
  const startRes = await chatTools.chat_start.execute(
    { prompt: "do the thing" },
    { client: mockClient() },
  );
  assert.equal(startRes.title, "chat start");
  assert.equal(JSON.parse(startRes.output).started, true);
});

test("chat_start requires a prompt", async () => {
  const handler = chatStartHandler(mockClient());
  await assert.rejects(() => handler({}), /'prompt' \(the new task's first message\) is required/);
  await assert.rejects(() => handler({ prompt: "" }), /'prompt' \(the new task's first message\) is required/);
});

test("chat_start rejects oversized prompts", async () => {
  const handler = chatStartHandler(mockClient());
  await assert.rejects(
    () => handler({ prompt: "x".repeat(17 * 1024) }),
    /exceeds 16384 bytes/,
  );
});

test("chat_start creates a session and sends the first prompt", async () => {
  let createCalled = null;
  let promptCalled = null;
  const create = async (opts) => {
    createCalled = opts;
    return { data: { id: "ses_newtask" } };
  };
  const prompt_async = async (opts) => {
    promptCalled = opts;
    return { data: { messageID: "mid-1" } };
  };
  const handler = chatStartHandler(mockClient({ create, prompt_async }));
  const out = await handler({
    prompt: "Investigate the 401",
    title: "Fix auth",
    directory: "C:\\VectorHQ\\worktree-proof-workflow",
    parentID: "ses_parent",
  });
  assert.deepEqual(createCalled, {
    body: { title: "Fix auth", parentID: "ses_parent" },
    query: { directory: "C:\\VectorHQ\\worktree-proof-workflow" },
  });
  assert.deepEqual(promptCalled, {
    path: { id: "ses_newtask" },
    body: { parts: [{ type: "text", text: "Investigate the 401" }], noReply: true },
  });
  assert.deepEqual(out, {
    started: true,
    id: "ses_newtask",
    title: "Fix auth",
    parentID: "ses_parent",
    promptSent: true,
  });
});

test("chat_start accepts a bare prompt with defaults", async () => {
  const create = async () => ({ data: "ses_plain" });
  const handler = chatStartHandler(mockClient({ create }));
  const out = await handler({ prompt: "just do it" });
  assert.equal(out.id, "ses_plain");
  assert.equal(out.title, null);
  assert.equal(out.parentID, null);
  assert.equal(out.promptSent, true);
});