import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

const dir = `${process.env.TMPDIR ?? "/tmp"}/loka-sukhi-test-${process.pid}`;
process.env.WORLD_DATA = dir;

// 偽の sukhi。会話と文脈を、テストごとに差し替える。
const calls = [];
let conversations = [];
let context = { ancestors: [] };

const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    const send = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.url === "/api/v1/accounts/verify_credentials") return send({ id: "me" });
    if (req.url.startsWith("/api/v1/conversations")) return send(conversations);
    if (req.url.endsWith("/context")) return send(context);
    if (req.url === "/api/v1/statuses") return send({ id: "new", url: "https://x/new" });
    send({});
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.MASTODON_API_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.MASTODON_ACCESS_TOKEN = "t";

const { say, ack, sukhiConfigured, trimHtml } = await import("./sukhi.mjs");

const convo = (accounts, last) => ({ accounts: accounts.map((acct) => ({ acct })), last_status: last });
const reset = () => {
  calls.length = 0;
  rmSync(`${dir}/state`, { recursive: true, force: true });
};

test("繋がっているか", () => assert.equal(sukhiConfigured(), true));

test("相手が最後なら、その一通に返す", async () => {
  reset();
  conversations = [convo(["nyanrus"], { id: "s1", account: { id: "them" } })];
  const r = await say({ text: "うん" });
  assert.equal(r.chars, 2);
  const sent = calls.find((c) => c.path === "/api/v1/statuses");
  assert.equal(sent.body.in_reply_to_id, "s1");
  assert.equal(sent.body.status, "@nyanrus うん");
  assert.equal(sent.body.visibility, "direct");
});

test("自分が最後なら、相手が最後に書いたところまで遡る", async () => {
  reset();
  conversations = [convo(["nyanrus"], { id: "s3", account: { id: "me" } })];
  context = { ancestors: [{ id: "s1", account: { id: "them" } }, { id: "s2", account: { id: "me" } }] };
  await say({ text: "つづき" });
  assert.equal(calls.find((c) => c.path === "/api/v1/statuses").body.in_reply_to_id, "s1");
});

test("相手がまだ何も言っていなければ、ぶら下げずに置く", async () => {
  reset();
  conversations = [convo(["nyanrus"], { id: "s1", account: { id: "me" } })];
  context = { ancestors: [] };
  await say({ text: "はじめまして" });
  assert.equal("in_reply_to_id" in calls.find((c) => c.path === "/api/v1/statuses").body, false);
});

test("三人の会話には、ぶら下がらない", async () => {
  reset();
  conversations = [
    convo(["nyanrus", "kuro"], { id: "group", account: { id: "them" } }),
    convo(["nyanrus"], { id: "pair", account: { id: "them" } }),
  ];
  await say({ text: "やあ" });
  assert.equal(calls.find((c) => c.path === "/api/v1/statuses").body.in_reply_to_id, "pair");
});

test("bridge が聞いた一通があれば、会話より先にそちらへ返す", async () => {
  reset();
  mkdirSync(`${dir}/state`, { recursive: true });
  writeFileSync(`${dir}/state/sukhi_heard.json`, JSON.stringify({ nyanrus: { status_id: "heard" } }));
  conversations = [convo(["nyanrus"], { id: "newer", account: { id: "them" } })];
  await say({ text: "聞こえたよ" });
  assert.equal(calls.find((c) => c.path === "/api/v1/statuses").body.in_reply_to_id, "heard");
});

test("ack は絵文字を、相手の一通に押す", async () => {
  reset();
  conversations = [convo(["nyanrus"], { id: "s1", account: { id: "them" } })];
  const r = await ack({});
  assert.deepEqual(r, { ok: true, emoji: "👀", status_id: "s1" });
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.path, `/api/v1/sukhi/statuses/s1/react/${encodeURIComponent("👀")}`);
});

test("ack は、相手の発言が無ければ押さずに伝える", async () => {
  reset();
  conversations = [];
  const r = await ack({});
  assert.match(r.error, /見つかりませんでした/);
  assert.equal(calls.some((c) => c.method === "PUT"), false);
});

test("trimHtml はタグを落として、長ければ切る", () => {
  assert.equal(trimHtml("<p>あ<br>い</p>"), "あ\nい");
  assert.equal(trimHtml("x".repeat(600)).length, 501);
});

test.after(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});
