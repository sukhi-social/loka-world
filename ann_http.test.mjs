import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { handleAnn } from "./ann_http.mjs";

const TOKEN = "a".repeat(40);
const calls = [];
let fail = null;
const fakeServer = {
  callStep: async (name, args, accept) => {
    calls.push({ name, args, accept });
    if (fail) throw new Error(fail);
    return { echo: args.do };
  },
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!(await handleAnn(req, res, url, { hostOk: () => true, getServer: () => fakeServer }))) res.writeHead(404).end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${http.address().port}`;
test.after(() => http.close());

const post = (body, { token = TOKEN, raw } = {}) =>
  fetch(`${base}/ann/call`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? JSON.stringify(body),
  });

test("鍵が無い(または短い)ときは、口が無いものとして 404", async () => {
  delete process.env.WORLD_ANN_TOKEN;
  assert.equal((await post({ tool: "sukhi", args: { do: "inbox" } })).status, 404);
  process.env.WORLD_ANN_TOKEN = "short";
  assert.equal((await post({ tool: "sukhi", args: { do: "inbox" } }, { token: "short" })).status, 404);
});

test("鍵が合わなければ 401、GET は 405", async () => {
  process.env.WORLD_ANN_TOKEN = TOKEN;
  assert.equal((await post({ tool: "sukhi", args: { do: "inbox" } }, { token: "b".repeat(40) })).status, 401);
  assert.equal((await post({ tool: "sukhi", args: { do: "inbox" } }, { token: null })).status, 401);
  assert.equal((await fetch(`${base}/ann/call`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
});

test("呼べるのは sukhi の inbox / inbox_done / reply / say だけ。ほかは 403", async () => {
  process.env.WORLD_ANN_TOKEN = TOKEN;
  calls.length = 0;
  for (const body of [
    { tool: "sukhi", args: { do: "post", text: "x" } },
    { tool: "sukhi", args: { do: "follow", acct: "x" } },
    { tool: "sukhi", args: { do: "update_profile", bot: false } },
    { tool: "mac", args: { do: "exec", cmd: "ls" } },
    { tool: "diary", args: { do: "read" } },
    { tool: "sukhi" },
    {},
  ]) assert.equal((await post(body)).status, 403, JSON.stringify(body));
  assert.equal(calls.length, 0);
});

test("四つの動作は通り、accept もそのまま渡る。失敗は 502", async () => {
  process.env.WORLD_ANN_TOKEN = TOKEN;
  calls.length = 0;
  const r = await post({ tool: "sukhi", args: { do: "inbox" } });
  assert.deepEqual(await r.json(), { ok: true, result: { echo: "inbox" } });
  await post({ tool: "sukhi", args: { do: "inbox_done", seq: 3 } });
  await post({ tool: "sukhi", args: { do: "say", text: "やあ", to: "a@x" } });
  await post({ tool: "sukhi", args: { do: "reply", text: "やあ", status_id: "s1" }, accept: { id: "pd_1", hash: "h" } });
  assert.deepEqual(calls.map((c) => c.args.do), ["inbox", "inbox_done", "say", "reply"]);
  assert.deepEqual(calls[3].accept, { id: "pd_1", hash: "h" });
  assert.equal((await post({ tool: "sukhi", args: { do: "reply", text: "x" }, accept: { id: 1 } })).status, 400);
  fail = "sukhi が答えない";
  const bad = await post({ tool: "sukhi", args: { do: "inbox" } });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /sukhi が答えない/);
  fail = null;
});

test("読めない JSON は 400、大きすぎるものは 413", async () => {
  process.env.WORLD_ANN_TOKEN = TOKEN;
  assert.equal((await post(null, { raw: "{" })).status, 400);
  assert.equal((await post(null, { raw: JSON.stringify({ tool: "sukhi", args: { do: "reply", text: "あ".repeat(70_000) } }) })).status, 413);
});
