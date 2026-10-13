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
let droppedReply = false; // true なら、POST /statuses の返事で in_reply_to_id を落とす(sukhi が存在しない返信先を捨てるのを真似る)
let original = null; // GET /api/v1/statuses/:id が返す、元の投稿
let tokenOk = (t) => t === "t"; // 401 を返すかどうかは、テストごとに差し替える
let refuseStatuses = null; // 文字列なら、POST /api/v1/statuses を 422 とその本文で断る(sukhi の validation を真似る)

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
    if (req.method === "GET" && /^\/api\/v1\/statuses\/[^/]+$/.test(req.url)) return original ? send(original) : res.writeHead(404).end("{}");
    if (req.url === "/api/v1/statuses" && refuseStatuses) return res.writeHead(422, { "content-type": "application/json" }).end(refuseStatuses);
    if (req.url === "/api/v1/statuses") {
      const sent = body ? JSON.parse(body) : {};
      return send({ id: "new", url: "https://x/new", in_reply_to_id: droppedReply ? null : (sent.in_reply_to_id ?? null) });
    }
    send({});
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;

const { createSukhi, statusIdFrom, trimHtml } = await import("./sukhi.mjs");
const { encodeOpaqueId } = await import("@activityplug/core");
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

// ── mention への返事(元の投稿に合わせる)────────────────────────────────────

const orig = (visibility, acct = "kuro43_@misskey.io") => ({ id: "m1", visibility, account: { acct } });
const sentStatus = () => calls.find((c) => c.method === "POST" && c.path === "/api/v1/statuses").body;

for (const v of ["public", "unlisted", "private", "direct"]) {
  test(`replyTo: 元が ${v} なら、同じ ${v} で返す。宛名と返信先が付く`, async () => {
    reset();
    original = orig(v);
    const r = await sukhi.replyTo({ statusId: "m1", text: "こんにちは" });
    assert.equal(r.visibility, v);
    assert.deepEqual(
      [sentStatus().status, sentStatus().visibility, sentStatus().in_reply_to_id],
      ["@kuro43_@misskey.io こんにちは", v, "m1"],
    );
  });
}

test("replyTo: 元より広くは出さない。狭くするのは頼める", async () => {
  reset();
  original = orig("unlisted");
  assert.equal((await sukhi.replyTo({ statusId: "m1", text: "a", visibility: "public" })).visibility, "unlisted");
  assert.equal(sentStatus().visibility, "unlisted");

  reset();
  original = orig("public");
  assert.equal((await sukhi.replyTo({ statusId: "m1", text: "a", visibility: "unlisted" })).visibility, "unlisted");
  assert.equal((await sukhi.replyTo({ statusId: "m1", text: "a", visibility: "followers" })).visibility, "private"); // 言い換えも受ける
});

test("replyTo: DM への返事を、公開にはしない", async () => {
  reset();
  original = orig("direct");
  assert.equal((await sukhi.replyTo({ statusId: "m1", text: "a", visibility: "public" })).visibility, "direct");
});

test("replyTo: 宛名を二重に付けない", async () => {
  reset();
  original = orig("public");
  await sukhi.replyTo({ statusId: "m1", text: "@kuro43_@misskey.io もう書いてある" });
  assert.equal(sentStatus().status, "@kuro43_@misskey.io もう書いてある");
});

test("replyTo: 元の投稿が見つからなければ、返信としては投稿しない(理由と、別の道を言う)", async () => {
  reset();
  original = null;
  await assert.rejects(() => sukhi.replyTo({ statusId: "gone", text: "a" }), /見つかりません.*削除.*見えない.*投稿しませんでした.*sukhi_post/s);
  assert.equal(calls.some((c) => c.method === "POST" && c.path === "/api/v1/statuses"), false);
});

const envelope = (id, over = {}) => encodeOpaqueId({ adapter: "mastodon", origin: base, type: "post", id, ...over });

test("replyTo: 封筒入りの id も開けて、同じ確認を通す(元に合わせる)", async () => {
  reset();
  original = orig("private");
  const r = await sukhi.replyTo({ statusId: envelope("m1"), text: "a" });
  assert.equal(r.visibility, "private");
  assert.equal(sentStatus().in_reply_to_id, "m1"); // 封筒ではなく、生の id で送る
});

test("replyTo: 封筒の先の投稿が無ければ、封筒でも投稿しない(単独の投稿にならない)", async () => {
  reset();
  original = null;
  await assert.rejects(() => sukhi.replyTo({ statusId: envelope("gone"), text: "a" }), /見つかりません/);
  assert.equal(calls.some((c) => c.method === "POST" && c.path === "/api/v1/statuses"), false);
});

test("replyTo: 壊れた封筒・別のサーバーの封筒・投稿でない封筒は断る", async () => {
  reset();
  original = orig("public");
  await assert.rejects(() => sukhi.replyTo({ statusId: "ap_1_garbage", text: "a" }), /封筒|id/);
  await assert.rejects(() => sukhi.replyTo({ statusId: envelope("m1", { origin: "https://other.example" }), text: "a" }), /別のサーバー/);
  await assert.rejects(() => sukhi.replyTo({ statusId: envelope("m1", { type: "account" }), text: "a" }), /投稿の id ではありません/);
  assert.equal(calls.some((c) => c.method === "POST" && c.path === "/api/v1/statuses"), false);
});

test("replyTo: 送ったのに sukhi が返信先を落としたら、そう伝える", async () => {
  reset();
  original = orig("public");
  droppedReply = true; // sukhi が in_reply_to_id を捨てる
  try {
    const r = await sukhi.replyTo({ statusId: "m1", text: "a" });
    assert.equal(r.linked, false);
    assert.match(r.note, /返信としては繋がらなかった/);
  } finally {
    droppedReply = false;
  }
});

test("replyTo: 返信先がちゃんと付いたら linked:true", async () => {
  reset();
  original = orig("public");
  assert.equal((await sukhi.replyTo({ statusId: "m1", text: "a" })).linked, true);
});

// ── sukhi_status(投稿をひとつ見る)────────────────────────────────────────

const wire = (over = {}) => ({
  id: "5748676545293750", url: "https://sukhi.test/@shiro/5748676545293750", visibility: "public", in_reply_to_id: null,
  created_at: "2026-10-12T06:04:02Z", content: "<p>こんにちは</p>", account: { acct: "shiro_bot" }, media_attachments: [], ...over,
});

test("statusIdFrom: 数字の id・/@acct/<id>・/users/<acct>/notes/<id> から id を取る", () => {
  const b = base;
  assert.equal(statusIdFrom("5748676545293750", b), "5748676545293750");
  assert.equal(statusIdFrom(`${b}/@shiro_bot/5748676545293750`, b), "5748676545293750");
  assert.equal(statusIdFrom(`${b}/@shiro_bot/5748676545293750/`, b), "5748676545293750");
  assert.equal(statusIdFrom(`${b}/users/shiro_bot/notes/5748676545293750`, b), "5748676545293750");
});

test("statusIdFrom: ほかのサーバーの URL・id の無い URL・ただの文字は断る", () => {
  assert.throws(() => statusIdFrom("https://other.example/@a/123", base), /見られません/);
  assert.throws(() => statusIdFrom(`${base}/@shiro_bot`, base), /id が読めません/);
  assert.throws(() => statusIdFrom("hello", base), /id か、sukhi の投稿の URL/);
});

test("readStatus: あれば、誰が・公開範囲・返信かどうかを返す", async () => {
  reset();
  original = wire();
  const r = await sukhi.readStatus({ which: `${base}/@shiro_bot/5748676545293750` });
  assert.deepEqual(
    [r.found, r.author, r.visibility, r.in_reply_to_id, r.reply, r.text, "note" in r],
    [true, "@shiro_bot", "public", null, "返信ではない(ひとつの投稿)", "こんにちは", false],
  );
});

test("readStatus: フォロワー限定・DM には、外から 404 に見える理由を添える", async () => {
  reset();
  original = wire({ visibility: "private" });
  assert.match((await sukhi.readStatus({ which: "5748676545293750" })).note, /フォロワー限定.*404/);
  original = wire({ visibility: "direct" });
  assert.match((await sukhi.readStatus({ which: "5748676545293750" })).note, /DM.*404/);
});

test("readStatus: 返信なら、返信先の id を返す", async () => {
  reset();
  original = wire({ in_reply_to_id: "111" });
  const r = await sukhi.readStatus({ which: "5748676545293750" });
  assert.deepEqual([r.in_reply_to_id, r.reply], ["111", "返信"]);
});

test("readStatus: 見つからなければ found:false で、削除か見えない公開範囲か、と言う", async () => {
  reset();
  original = null;
  const r = await sukhi.readStatus({ which: "42" });
  assert.deepEqual([r.found, r.id], [false, "42"]);
  assert.match(r.message, /削除された.*見えない/);
});

test("readStatus: 404 以外の失敗は、そのまま伝える", async () => {
  reset();
  tokenOk = () => false;
  await assert.rejects(() => sukhi.readStatus({ which: "42" }), /HTTP 401/);
});

test("trimHtml はタグを落として、長ければ切る", () => {
  assert.equal(trimHtml("<p>あ<br>い</p>"), "あ\nい");
  assert.equal(trimHtml("x".repeat(600)).length, 501);
});

test.after(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 断られたとき、sukhi の返した理由を伝える ──────────────────────────────────

test("ActivityPlug の道(post)で 422 なら、sukhi が返した理由を添える", async () => {
  tokenOk = (t) => t === "t";
  sukhi = createSukhi(makeVoice());
  refuseStatuses = JSON.stringify({ error: "validation_failed", details: { visibility: ["is invalid"] } });
  try {
    await assert.rejects(() => sukhi.post({ text: "こんにちは", visibility: "unlisted" }), (e) => {
      assert.match(e.message, /HTTP 422/);
      assert.match(e.message, /理由: .*validation_failed.*visibility/);
      return true;
    });
  } finally {
    refuseStatuses = null;
  }
});

test("素の fetch の道(say)で 422 なら、同じく理由を添える", async () => {
  tokenOk = (t) => t === "t";
  sukhi = createSukhi(makeVoice());
  refuseStatuses = JSON.stringify({ error: "validation_failed" });
  conversations = [convo(["nyanrus"], { id: "1", account: { acct: "nyanrus" }, visibility: "direct", content: "<p>やあ</p>" })];
  try {
    await assert.rejects(() => say({ text: "はい" }), /HTTP 422 理由: .*validation_failed/);
  } finally {
    refuseStatuses = null;
  }
});

test("理由が長ければ切る。理由が空なら、何も足さない", async () => {
  const { explained } = await import("./sukhi.mjs");
  const long = explained(Object.assign(new Error("HTTP 422."), { context: { raw: { body: "x".repeat(1000) } } }));
  assert.ok(long.message.length < 400);
  assert.match(long.message, /…$/);
  assert.equal(explained(Object.assign(new Error("HTTP 500."), { context: { raw: {} } })).message, "HTTP 500.");
  assert.equal(explained(new Error("plain")).message, "plain");
  // 本文が context に無くても、HTTP の部品が読み終えた形(cause.data)から拾う
  const viaData = explained(Object.assign(new Error("HTTP 422."), { context: { raw: { status: 422 } }, cause: { data: { error: "validation_failed" } } }));
  assert.match(viaData.message, /理由: \{"error":"validation_failed"\}/);
  assert.equal(explained(Object.assign(new Error("HTTP 404."), { context: { raw: { body: "{}" } } })).message, "HTTP 404.");
});
