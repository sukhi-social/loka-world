import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

const dir = `${process.env.TMPDIR ?? "/tmp"}/loka-sukhi-test-${process.pid}`;
process.env.WORLD_DATA = dir;
const voiceDir = join(dir, "voice");

// 偽の sukhi。会話と文脈を、テストごとに差し替える。
const calls = [];
let conversations = [];
let context = { ancestors: [] };
let tokenOk = (t) => t === "t"; // 401 を返すかどうかは、テストごとに差し替える

const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    calls.push({ method: req.method, path: req.url, bearer, body: body && req.headers["content-type"] === "application/json" ? JSON.parse(body) : body || undefined });
    const send = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.url === "/oauth/token") return send({ access_token: "t2", refresh_token: "r2" });
    if (!tokenOk(bearer)) return res.writeHead(401).end("{}");
    if (req.url === "/api/v1/accounts/verify_credentials") return send({ id: "me" });
    if (req.url.startsWith("/api/v1/accounts/lookup")) {
      const acct = new URL(req.url, "http://x").searchParams.get("acct");
      if (acct === "nobody") return res.writeHead(404).end("{}");
      return send({
        id: "7", acct, display_name: "Mi", note: "<p>はじめまして</p>",
        fields: [{ name: "web", value: '<a href="https://x">x</a>', verified_at: "2026-01-01T00:00:00Z" }, { name: "memo", value: "ねこ", verified_at: null }],
        followers_count: 3, following_count: 4, statuses_count: 5, bot: false, locked: true,
        created_at: "2025-01-01T00:00:00Z", url: "https://x/@mi", avatar: "https://x/a.png", header: "https://x/h.png",
      });
    }
    if (req.url.startsWith("/api/v1/timelines/home")) return send([]);
    if (req.url.startsWith("/api/v1/conversations")) return send(conversations);
    if (req.url.endsWith("/context")) return send(context);
    if (req.url === "/api/v1/statuses") return send({ id: "new", url: "https://x/new" });
    send({});
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;

const { createSukhi, trimHtml } = await import("./sukhi.mjs");
const makeVoice = (extra = {}) => ({ base, accessToken: "t", dir: voiceDir, ...extra });
let sukhi = createSukhi(makeVoice());
const say = (a) => sukhi.say({ to: "nyanrus", ...a });
const ack = (a) => sukhi.ack({ to: "nyanrus", ...a });

const convo = (accounts, last) => ({ accounts: accounts.map((acct) => ({ acct })), last_status: last });
const reset = () => {
  calls.length = 0;
  tokenOk = (t) => t === "t";
  sukhi = createSukhi(makeVoice());
  rmSync(voiceDir, { recursive: true, force: true });
};

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
  mkdirSync(voiceDir, { recursive: true });
  writeFileSync(`${voiceDir}/sukhi_heard.json`, JSON.stringify({ nyanrus: { status_id: "heard" } }));
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

test("401 なら、取り直して保存し、一度だけやり直す", async () => {
  reset();
  const saved = [];
  sukhi = createSukhi(
    makeVoice({ refreshToken: "r", clientId: "id", clientSecret: "sec", account: "x" }),
    (v) => saved.push({ accessToken: v.accessToken, refreshToken: v.refreshToken }),
  );
  tokenOk = (t) => t === "t2";
  conversations = [convo(["nyanrus"], { id: "s1", account: { id: "them" } })];
  await ack({});
  assert.deepEqual(saved, [{ accessToken: "t2", refreshToken: "r2" }]);
  assert.equal(calls.find((c) => c.path === "/oauth/token").body.includes("grant_type=refresh_token"), true);
  assert.equal(calls.at(-1).bearer, "t2");
});

test("取り直せない声では、401 をそのまま伝える", async () => {
  reset();
  tokenOk = () => false;
  await assert.rejects(() => ack({}), /HTTP 401/);
});

test("ActivityPlug 越しに読める(通信の窓口を渡している)", async () => {
  reset();
  assert.deepEqual(await sukhi.readHome({ limit: 5 }), []);
  assert.equal(calls.at(-1).path.startsWith("/api/v1/timelines/home"), true);
  assert.equal(calls.at(-1).bearer, "t");
});

test("プロフィールを見に行く(@ は付けても付けなくてもよい。他のサーバーの人は resolve で探す)", async () => {
  reset();
  const p = await sukhi.readProfile({ who: " @mi@other.example " });
  assert.equal(p.acct, "@mi@other.example");
  assert.equal(p.display_name, "Mi");
  assert.equal(p.bio, "はじめまして");
  assert.deepEqual(p.fields, [{ name: "web", value: "x", verified: true }, { name: "memo", value: "ねこ" }]);
  assert.deepEqual([p.followers, p.following, p.posts, p.locked, p.bot], [3, 4, 5, true, false]);
  const call = calls.at(-1);
  assert.equal(call.path, "/api/v1/accounts/lookup?acct=mi%40other.example&resolve=1");
  assert.equal(call.bearer, "t");
});

test("プロフィールが見つからなければ、見つからないと伝える(エラーにしない)", async () => {
  reset();
  const p = await sukhi.readProfile({ who: "nobody" });
  assert.equal(p.found, false);
  assert.equal(p.who, "@nobody");
});

test("プロフィール: 見つからない以外のエラー(401 など)は、そのまま伝える", async () => {
  reset();
  tokenOk = () => false;
  await assert.rejects(() => sukhi.readProfile({ who: "mi" }), /HTTP 401/);
});

test("trimHtml はタグを落として、長ければ切る", () => {
  assert.equal(trimHtml("<p>あ<br>い</p>"), "あ\nい");
  assert.equal(trimHtml("x".repeat(600)).length, 501);
});

test.after(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});
