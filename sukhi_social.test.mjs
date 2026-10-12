import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

process.env.WORLD_DATA = `${process.env.TMPDIR ?? "/tmp"}/loka-social-test-${process.pid}`;

// 偽の sukhi。「METHOD /path」ごとの返事を、テストごとに差し替える。
const calls = [];
let routes = {};
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body: body ? JSON.parse(body) : undefined });
    const hit = routes[`${req.method} ${url.pathname}`];
    res.setHeader("content-type", "application/json");
    if (hit === undefined) return res.writeHead(404).end("{}");
    if (typeof hit === "number") return res.writeHead(hit).end("{}");
    res.end(JSON.stringify(typeof hit === "function" ? hit(url, body ? JSON.parse(body) : undefined) : hit));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;

const { createSukhi } = await import("./sukhi.mjs");
const { social } = createSukhi({ base, accessToken: "t", dir: "/nonexistent" });
const last = () => calls.at(-1);
const reset = (r = {}) => ((calls.length = 0), (routes = { "GET /api/v1/accounts/lookup": { id: "7", acct: "kuro43_" }, ...r }));

const acct = (id, a) => ({ id, acct: a, display_name: a, note: "<p>自己紹介</p>", followers_count: 1, following_count: 2, statuses_count: 3, fields: [] });
const st = (id, over = {}) => ({
  id, url: `https://x/${id}`, account: acct("7", "kuro43_"), content: "<p>こんにちは</p>", visibility: "public", created_at: "2026-10-12T00:00:00Z",
  replies_count: 1, reblogs_count: 2, favourites_count: 3, media_attachments: [], ...over,
});
const rel = (over = {}) => ({ id: "7", following: true, followed_by: false, requested: false, blocking: false, muting: false, ...over });

// ── 人 ────────────────────────────────────────────────────────────────────

test("follow: 名前から id を引いて、follow / unfollow を叩く。別のサーバーの人は resolve を付ける", async () => {
  reset({ "POST /api/v1/accounts/7/follow": rel(), "POST /api/v1/accounts/7/unfollow": rel({ following: false }) });
  const r = await social.follow({ who: "@kuro43_@misskey.io" });
  assert.deepEqual([r.action, r.following, r.who], ["follow", true, "@kuro43_@misskey.io"]);
  const lookup = calls.find((c) => c.path.endsWith("/lookup"));
  assert.deepEqual([lookup.query.get("acct"), lookup.query.get("resolve")], ["kuro43_@misskey.io", "1"]);
  assert.equal((await social.follow({ who: "kuro43_", action: "unfollow" })).following, false);
  assert.equal(last().path, "/api/v1/accounts/7/unfollow");
});

test("follow: 数字の id はそのまま使う。知らない人・知らない action は断る", async () => {
  reset({ "POST /api/v1/accounts/42/follow": rel({ id: "42" }) });
  await social.follow({ who: "42" });
  assert.equal(calls.some((c) => c.path.endsWith("/lookup")), false);
  reset({ "GET /api/v1/accounts/lookup": 404 });
  await assert.rejects(() => social.follow({ who: "nobody" }), /その人が見つからなかった: @nobody/);
  await assert.rejects(() => social.follow({ who: "7", action: "poke" }), /知らない action/);
});

test("relationships: 複数の人を id[] で一度に引く", async () => {
  reset({ "GET /api/v1/accounts/relationships": [rel({ id: "7", followed_by: true })] });
  const r = await social.relationships({ who: ["kuro43_"] });
  assert.deepEqual(calls.at(-1).query.getAll("id[]"), ["7"]);
  assert.deepEqual([r.items[0].who, r.items[0].followed_by], ["@kuro43_", true]);
});

test("followRequest: accept は authorize、reject は reject", async () => {
  reset({ "POST /api/v1/follow_requests/7/authorize": {}, "POST /api/v1/follow_requests/7/reject": {} });
  await social.followRequest({ who: "kuro43_", action: "accept" });
  assert.equal(last().path, "/api/v1/follow_requests/7/authorize");
  await social.followRequest({ who: "kuro43_", action: "reject" });
  assert.equal(last().path, "/api/v1/follow_requests/7/reject");
});

test("accountNote: 自分だけの覚え書きを comment で送る", async () => {
  reset({ "POST /api/v1/accounts/7/note": rel({ note: "友だち" }) });
  const r = await social.accountNote({ who: "kuro43_", note: "友だち" });
  assert.deepEqual([last().body, r.note], [{ comment: "友だち" }, "友だち"]);
});

test("people: followers / following を人の形で返す。次の頁の目印つき", async () => {
  reset({ "GET /api/v1/accounts/7/followers": [acct("1", "a"), acct("2", "b")] });
  const r = await social.people({ who: "kuro43_", relation: "followers", limit: 2 });
  assert.deepEqual([r.count, r.next_max_id, r.items[0].acct], [2, "2", "@a"]);
  assert.equal(last().query.get("limit"), "2");
});

// ── 投稿 ──────────────────────────────────────────────────────────────────

test("timeline: public は既定でこの sukhi の中だけ。tag・list は必須の引数を確かめる", async () => {
  reset({ "GET /api/v1/timelines/public": [st("1")], "GET /api/v1/timelines/tag/neko": [st("2")], "GET /api/v1/timelines/list/9": [st("3")] });
  const r = await social.timeline({ kind: "public" });
  assert.deepEqual([last().query.get("local"), r.items[0].author, r.items[0].counts.favourites], ["1", "@kuro43_", 3]);
  await social.timeline({ kind: "public", local: false });
  assert.equal(last().query.get("local"), "0");
  await social.timeline({ kind: "tag", tag: "#neko" });
  assert.equal(last().path, "/api/v1/timelines/tag/neko");
  await social.timeline({ kind: "list", listId: "9" });
  assert.equal(last().path, "/api/v1/timelines/list/9");
  await assert.rejects(() => social.timeline({ kind: "tag" }), /タグ名/);
  await assert.rejects(() => social.timeline({ kind: "list" }), /list_id/);
});

test("ブーストは、元の投稿を見せて、誰がブーストしたかを添える", async () => {
  reset({ "GET /api/v1/timelines/public": [{ id: "50", account: acct("8", "booster"), reblog: st("5", { content: "<p>元</p>" }) }] });
  const [it] = (await social.timeline({ kind: "public" })).items;
  assert.deepEqual([it.text, it.boosted_by, it.author], ["元", "@booster", "@kuro43_"]);
});

test("postsOf: その人の投稿。返信を除く・画像だけ、が頼める", async () => {
  reset({ "GET /api/v1/accounts/7/statuses": [st("1")] });
  await social.postsOf({ who: "kuro43_", onlyMedia: true, excludeReplies: true });
  assert.deepEqual([last().query.get("only_media"), last().query.get("exclude_replies")], ["1", "1"]);
});

test("thread: 前後の流れ。見つからなければ found:false", async () => {
  reset({ "GET /api/v1/statuses/5/context": { ancestors: [st("4")], descendants: [st("6"), st("7")] } });
  const r = await social.thread({ which: `${base}/@kuro43_/5` });
  assert.deepEqual([r.found, r.ancestors.length, r.descendants.length], [true, 1, 2]);
  const gone = await social.thread({ which: "999" });
  assert.deepEqual([gone.found, gone.id], [false, "999"]);
});

test("search: 人・投稿・タグを分けて返す。resolve は頼んだときだけ", async () => {
  reset({ "GET /api/v2/search": { accounts: [acct("1", "a")], statuses: [st("2")], hashtags: [{ name: "neko", url: "https://x/tags/neko" }] } });
  const r = await social.search({ q: "ねこ", type: "accounts", resolve: true });
  assert.deepEqual([r.accounts[0].acct, r.statuses[0].id, r.hashtags[0].name], ["@a", "2", "neko"]);
  assert.deepEqual([last().query.get("q"), last().query.get("resolve")], ["ねこ", "1"]);
  await social.search({ q: "x" });
  assert.equal(last().query.has("resolve"), false);
});

test("collection: ブックマーク・お気に入りは投稿の形、フォローリクエスト・ブロック・ミュートは人の形", async () => {
  reset({ "GET /api/v1/bookmarks": [st("1")], "GET /api/v1/blocks": [acct("9", "bad")] });
  assert.equal((await social.collection({ kind: "bookmarks" })).items[0].text, "こんにちは");
  assert.equal((await social.collection({ kind: "blocks" })).items[0].acct, "@bad");
  await assert.rejects(() => social.collection({ kind: "secrets" }), /知らない入れもの/);
});

test("conversations: 相手・未読・最後の一通", async () => {
  reset({ "GET /api/v1/conversations": [{ id: "c1", unread: true, accounts: [acct("7", "kuro43_")], last_status: st("1", { visibility: "direct" }) }] });
  const r = await social.conversations({});
  assert.deepEqual([r.items[0].with, r.items[0].unread, r.items[0].last.visibility], [["@kuro43_"], true, "direct"]);
});

// ── 反応 ──────────────────────────────────────────────────────────────────

test("interact: action ごとに、決まった経路を叩く。URL・数字の id のどちらでも", async () => {
  const table = { favourite: "favourite", unfavourite: "unfavourite", boost: "reblog", unboost: "unreblog", bookmark: "bookmark", unbookmark: "unbookmark", pin: "pin", unpin: "unpin" };
  reset(Object.fromEntries(Object.values(table).map((p) => [`POST /api/v1/statuses/5/${p}`, st("5", { favourited: true })])));
  for (const [action, path] of Object.entries(table)) {
    await social.interact({ which: `${base}/@kuro43_/5`, action });
    assert.equal(last().path, `/api/v1/statuses/5/${path}`, action);
  }
  assert.deepEqual((await social.interact({ which: "5", action: "favourite" })).by_me, ["favourited"]);
  await assert.rejects(() => social.interact({ which: "5", action: "poke" }), /知らない action/);
});

test("interact: boost の返事は、中の元の投稿を見せる(unboost に要るのは元の id)", async () => {
  reset({ "POST /api/v1/statuses/5/reblog": { id: "60", account: acct("8", "me"), reblog: st("5", { reblogged: true }) } });
  const r = await social.interact({ which: "5", action: "boost" });
  assert.deepEqual([r.id, r.by_me], ["5", ["reblogged"]]);
});

test("react: 付ける(PUT)と外す(DELETE)。絵文字は URL に安全に入れる", async () => {
  reset({ "PUT /api/v1/sukhi/statuses/5/react/%F0%9F%91%80": {}, "DELETE /api/v1/sukhi/statuses/5/react/%F0%9F%91%80": {} });
  await social.react({ which: "5", emoji: "👀" });
  assert.equal(last().method, "PUT");
  assert.equal((await social.react({ which: "5", emoji: "👀", remove: true })).removed, true);
  assert.equal(last().method, "DELETE");
});

test("pollVote: 選んだ番号を送り、集計を返す", async () => {
  reset({ "POST /api/v1/polls/3/votes": { id: "3", multiple: false, voted: true, votes_count: 5, options: [{ title: "a", votes_count: 2 }, { title: "b", votes_count: 3 }] } });
  const r = await social.pollVote({ id: "3", choices: [1] });
  assert.deepEqual([last().body, r.voted, r.options[1]], [{ choices: [1] }, true, { index: 1, title: "b", votes: 3 }]);
});

test("deletePost: 消す。もう無い・自分のでないときは、止まらずに理由を返す", async () => {
  reset({ "DELETE /api/v1/statuses/5": st("5") });
  assert.deepEqual(await social.deletePost({ which: "5" }), { ok: true, id: "5", deleted: true });
  reset({ "DELETE /api/v1/statuses/5": 404 });
  assert.match((await social.deletePost({ which: "5" })).message, /もう消えている/);
  reset({ "DELETE /api/v1/statuses/5": 403 });
  assert.match((await social.deletePost({ which: "5" })).message, /この声の投稿ではない/);
});

// ── リスト ────────────────────────────────────────────────────────────────

test("lists: 一覧と、ひとつの中身(メンバーつき)", async () => {
  reset({ "GET /api/v1/lists": [{ id: "9", title: "友だち" }], "GET /api/v1/lists/9": { id: "9", title: "友だち" }, "GET /api/v1/lists/9/accounts": [acct("7", "kuro43_")] });
  assert.equal((await social.lists({})).items[0].title, "友だち");
  const one = await social.lists({ listId: "9" });
  assert.deepEqual([one.title, one.members[0].acct], ["友だち", "@kuro43_"]);
});

test("manageList: create / rename / delete", async () => {
  reset({ "POST /api/v1/lists": { id: "9", title: "新" }, "PUT /api/v1/lists/9": { id: "9", title: "改" }, "DELETE /api/v1/lists/9": {} });
  assert.deepEqual([(await social.manageList({ action: "create", title: "新" })).id, last().body], ["9", { title: "新" }]);
  assert.equal((await social.manageList({ action: "rename", listId: "9", title: "改" })).title, "改");
  assert.equal((await social.manageList({ action: "delete", listId: "9" })).deleted, true);
  await assert.rejects(() => social.manageList({ action: "rename", listId: "9" }), /title/);
  await assert.rejects(() => social.manageList({ action: "delete" }), /list_id/);
});

test("manageList: フォローしていない人は入らない。入らなかった人を教える", async () => {
  reset({ "POST /api/v1/lists/9/accounts": {}, "GET /api/v1/lists/9/accounts": [] });
  const r = await social.manageList({ action: "add_members", listId: "9", who: ["kuro43_"] });
  assert.deepEqual([calls.find((c) => c.method === "POST").body, r.left_out], [{ account_ids: ["7"] }, ["7"]]);
});

// ── 整理・モデレーション・プロフィール ────────────────────────────────────

test("tidy / clearNotifications", async () => {
  reset({ "POST /api/v1/notifications/4/dismiss": {}, "POST /api/v1/conversations/c1/read": {}, "POST /api/v1/notifications/clear": {} });
  await social.tidy({ action: "dismiss_notification", id: "4" });
  await social.tidy({ action: "read_conversation", id: "c1" });
  assert.equal((await social.clearNotifications()).cleared, true);
  await assert.rejects(() => social.tidy({ action: "dismiss_notification" }), /id が要ります/);
});

test("moderate: mute / unmute / block / unblock。mute は通知も止めるか選べる", async () => {
  reset({ "POST /api/v1/accounts/7/mute": rel({ muting: true }), "POST /api/v1/accounts/7/block": rel({ blocking: true }) });
  assert.equal((await social.moderate({ who: "kuro43_", action: "mute", notifications: true })).muting, true);
  assert.deepEqual(last().body, { notifications: true });
  assert.equal((await social.moderate({ who: "kuro43_", action: "block" })).blocking, true);
  await assert.rejects(() => social.moderate({ who: "kuro43_", action: "ban" }), /知らない action/);
});

test("report: 人と投稿と理由を送る", async () => {
  reset({ "POST /api/v1/reports": { id: "r1" } });
  const r = await social.report({ who: "kuro43_", which: ["5"], comment: "理由", category: "spam" });
  assert.deepEqual([last().body, r.id], [{ account_id: "7", status_ids: ["5"], comment: "理由", category: "spam" }, "r1"]);
});

test("updateProfile: 渡したところだけ送る。項目は fields_attributes に", async () => {
  reset({ "PATCH /api/v1/accounts/update_credentials": acct("1", "shiro_bot") });
  await social.updateProfile({ displayName: "シロ", fields: [{ name: "好き", value: "ねこ" }] });
  assert.deepEqual(last().body, { display_name: "シロ", fields_attributes: { 0: { name: "好き", value: "ねこ" } } });
  await social.updateProfile({ bot: true });
  assert.deepEqual(last().body, { bot: true });
  await assert.rejects(() => social.updateProfile({}), /ひとつは/);
});

test.after(() => fake.close());
