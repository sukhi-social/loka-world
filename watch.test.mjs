import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.WORLD_DATA = mkdtempSync(join(tmpdir(), "loka-watch-"));
const W = await import("./watch.mjs");

const DAY = 24 * 60 * 60 * 1000;
let t = Date.parse("2026-10-12T00:00:00Z");
const now = () => t;
const advance = (sec) => (t += sec * 1000);
const until = { ref: "w.result.events", nonempty: true };
const spec = (over = {}) => ({ name: "DM を待つ", tool: "sukhi", args: { do: "inbox" }, until, every: 60, ...over });
const file = (a = "kuro") => join(process.env.WORLD_DATA, "state", "watches", `${a}.json`);
const reset = () => rmSync(join(process.env.WORLD_DATA, "state", "watches"), { recursive: true, force: true });

// 偽の道具。events の中身を、テストごとに差し替える。
let events = [];
const calls = [];
const run = async (account, tool, args) => (calls.push({ account, tool, args }), { events });

// ── 預ける ────────────────────────────────────────────────────────────────

test("預けると、active で保存される。ファイルは自分だけ", () => {
  reset();
  const w = W.addWatch("kuro", spec({ args: { do: "inbox", limit: 5 } }), { now });
  assert.deepEqual([w.state, w.tool, w.every, w.expires_at], ["active", "sukhi", 60, new Date(t + 7 * DAY).toISOString()]);
  assert.equal(statSync(file()).mode & 0o777, 0o600);
  assert.equal(W.listWatches("kuro").length, 1);
});

test("書く道具・見張りの道具・流れの道具は、見張れない", () => {
  reset();
  assert.throws(() => W.addWatch("kuro", spec({ tool: "sukhi", args: { do: "follow" } })), /L5.*見張りが読めるのは/);
  assert.throws(() => W.addWatch("kuro", spec({ tool: "watch", args: { do: "start" } })), /見張りからは呼ばない/);
  assert.throws(() => W.addWatch("kuro", spec({ tool: "run_flow" })), /見張りからは呼ばない/);
  assert.throws(() => W.addWatch("kuro", spec({ tool: "sukhi", args: { do: "read_notifications" }, every: 600 })), /見張りからは呼ばない/);
  assert.throws(() => W.addWatch("kuro", spec({ tool: "nothing_like_this" })), /知らない道具/);
});

test("間隔の下限: 部屋の中は 60 秒、外を読む道具は 300 秒", () => {
  reset();
  assert.throws(() => W.addWatch("kuro", spec({ every: 30 })), /60 秒以上/);
  assert.throws(() => W.addWatch("kuro", spec({ tool: "sukhi", args: { do: "unread_count" }, every: 120 })), /300 秒以上/);
  assert.doesNotThrow(() => W.addWatch("kuro", spec({ tool: "sukhi", args: { do: "unread_count" }, every: 300, until: { ref: "w.result.count", gt: 0 } }), { now }));
});

test("期限は最長 30 日。条件の形が壊れていたら、預かる前に断る", () => {
  reset();
  assert.throws(() => W.addWatch("kuro", spec({ days: 31 })), /1〜30 日/);
  assert.throws(() => W.addWatch("kuro", spec({ days: 0 })), /1〜30 日/);
  assert.throws(() => W.addWatch("kuro", spec({ until: "events" })), /until/);
  assert.throws(() => W.addWatch("kuro", spec({ until: {} })), /until/);
  assert.doesNotThrow(() => W.addWatch("kuro", spec({ days: 30 }), { now }));
});

test("同時に見張れるのは 10 個まで", () => {
  reset();
  for (let i = 0; i < 10; i++) W.addWatch("kuro", spec({ name: `w${i}` }), { now });
  assert.throws(() => W.addWatch("kuro", spec()), /10 個/);
  const [first] = W.listWatches("kuro");
  W.stopWatch("kuro", first.id);
  assert.doesNotThrow(() => W.addWatch("kuro", spec(), { now }));
});

// ── 時計 ──────────────────────────────────────────────────────────────────

test("時が来るまでは回さない。来たら回し、条件が成り立たなければ、そのまま見張る", async () => {
  reset();
  calls.length = 0;
  events = [];
  W.addWatch("kuro", spec(), { now });
  assert.deepEqual(await W.tickWatches({ accounts: ["kuro"], run, now }), { checked: 1, fired: 0 }); // 最初は、すぐ
  assert.deepEqual(await W.tickWatches({ accounts: ["kuro"], run, now }), { checked: 0, fired: 0 }); // まだ
  advance(59);
  assert.equal((await W.tickWatches({ accounts: ["kuro"], run, now })).checked, 0);
  advance(1);
  assert.equal((await W.tickWatches({ accounts: ["kuro"], run, now })).checked, 1);
  assert.deepEqual([calls.length, W.listWatches("kuro")[0].checks, W.listWatches("kuro")[0].state], [2, 2, "active"]);
});

test("条件が成り立ったら fired で結果をしまい、それ以上は回さない", async () => {
  reset();
  calls.length = 0;
  events = [{ seq: 7, kind: "dm" }];
  W.addWatch("kuro", spec({ args: { do: "inbox", limit: 5 } }), { now });
  assert.deepEqual(await W.tickWatches({ accounts: ["kuro"], run, now }), { checked: 1, fired: 1 });
  assert.deepEqual(calls[0], { account: "kuro", tool: "sukhi", args: { do: "inbox", limit: 5 } });
  assert.equal(W.listWatches("kuro")[0].state, "fired");
  advance(600);
  assert.equal((await W.tickWatches({ accounts: ["kuro"], run, now })).checked, 0);
});

test("loka_context には、届いている見張りだけが載る。何も無ければ空", async () => {
  reset();
  assert.deepEqual(W.watchContext("kuro"), {});
  events = [];
  const w = W.addWatch("kuro", spec(), { now });
  assert.deepEqual(W.watchContext("kuro"), { watches: { active: 1 } });
  events = [{ seq: 1 }];
  advance(60);
  await W.tickWatches({ accounts: ["kuro"], run, now });
  const ctx = W.watchContext("kuro").watches;
  assert.deepEqual([ctx.active, ctx.ready.map((r) => [r.id, r.state])], [0, [[w.id, "fired"]]]);
  assert.match(ctx.hint, /watch_take/);
});

test("takeWatch: 届いたものは、結果を渡して消える。二度は受け取れない", async () => {
  reset();
  events = [{ seq: 3, kind: "mention", text: "こんにちは" }];
  const w = W.addWatch("kuro", spec(), { now });
  await W.tickWatches({ accounts: ["kuro"], run, now });
  const got = W.takeWatch("kuro", w.id);
  assert.deepEqual([got.found, got.state, got.result], [true, "fired", { events }]);
  assert.equal(W.listWatches("kuro").length, 0);
  assert.equal(W.takeWatch("kuro", w.id).found, false);
});

test("takeWatch: まだ見張っているものは、様子だけ返して、消さない", () => {
  reset();
  events = [];
  const w = W.addWatch("kuro", spec(), { now });
  const got = W.takeWatch("kuro", w.id);
  assert.deepEqual([got.state, "result" in got, W.listWatches("kuro").length], ["active", false, 1]);
});

test("期限が来たら expired。受け取ると消え、条件が成り立たなかったと言う", async () => {
  reset();
  events = [];
  const w = W.addWatch("kuro", spec({ days: 1 }), { now });
  advance(2 * 24 * 3600);
  await W.tickWatches({ accounts: ["kuro"], run, now });
  assert.equal(W.listWatches("kuro")[0].state, "expired");
  assert.match(W.takeWatch("kuro", w.id).message, /成り立たなかった/);
  assert.equal(W.listWatches("kuro").length, 0);
});

test("見に行く道具が続けて 10 回失敗したら、止める。一度の失敗では止めない", async () => {
  reset();
  const boom = async () => {
    throw new Error("sukhi へは、まだ繋がっていません");
  };
  const w = W.addWatch("kuro", spec(), { now });
  for (let i = 0; i < 9; i++) {
    await W.tickWatches({ accounts: ["kuro"], run: boom, now });
    advance(60);
  }
  assert.deepEqual([W.listWatches("kuro")[0].state, W.listWatches("kuro")[0].last_error], ["active", "sukhi へは、まだ繋がっていません"]);
  await W.tickWatches({ accounts: ["kuro"], run: boom, now });
  assert.equal(W.listWatches("kuro")[0].state, "failed");
  assert.match(W.takeWatch("kuro", w.id).message, /失敗して、止めた/);
});

test("失敗のあとに成功したら、失敗の数は数えなおす", async () => {
  reset();
  let fail = true;
  const flaky = async () => (fail ? Promise.reject(new Error("一度だけ")) : { events: [] });
  W.addWatch("kuro", spec(), { now });
  await W.tickWatches({ accounts: ["kuro"], run: flaky, now });
  fail = false;
  advance(60);
  await W.tickWatches({ accounts: ["kuro"], run: flaky, now });
  assert.equal(JSON.parse(readFileSync(file(), "utf-8")).watches[0].errors, 0);
});

test("大きすぎる結果は、切って渡す", async () => {
  reset();
  const big = async () => ({ events: [{ text: "あ".repeat(20_000) }] });
  const w = W.addWatch("kuro", spec(), { now });
  await W.tickWatches({ accounts: ["kuro"], run: big, now });
  const got = W.takeWatch("kuro", w.id);
  assert.equal(got.truncated, true);
  assert.ok(JSON.stringify(got.result).length < 17_000);
});

test("道具を待っているあいだに受け取られた見張りは、時計が復活させない", async () => {
  reset();
  events = [{ seq: 1 }];
  const a = W.addWatch("kuro", spec({ name: "a" }), { now });
  const b = W.addWatch("kuro", spec({ name: "b" }), { now });
  // a を回している最中に、b が受け取られ(外され)、c が預けられる
  let c;
  const slow = async (account, tool, args) => {
    if (!c) {
      W.stopWatch("kuro", b.id);
      c = W.addWatch("kuro", spec({ name: "c" }), { now });
    }
    return run(account, tool, args);
  };
  await W.tickWatches({ accounts: ["kuro"], run: slow, now });
  const names = W.listWatches("kuro").map((w) => w.name).sort();
  assert.deepEqual(names, ["a", "c"]); // b は戻らず、c は消えない
  assert.equal(W.listWatches("kuro").find((w) => w.id === a.id).state, "fired");
});

test("アカウントごとに別。一覧は見張りのあるアカウントだけ", async () => {
  reset();
  W.addWatch("kuro", spec(), { now });
  W.addWatch("mio", spec({ name: "mio の" }), { now });
  assert.deepEqual(W.listWatches("mio").map((w) => w.name), ["mio の"]);
  assert.deepEqual(W.watchAccounts().sort(), ["kuro", "mio"]);
  assert.deepEqual(W.watchContext("nobody"), {});
});

test("長く置かれた済みの見張りは、片づける", async () => {
  reset();
  events = [{ seq: 1 }];
  W.addWatch("kuro", spec(), { now });
  await W.tickWatches({ accounts: ["kuro"], run, now });
  assert.equal(W.listWatches("kuro").length, 1);
  advance(15 * 24 * 3600);
  await W.tickWatches({ accounts: ["kuro"], run, now });
  assert.equal(W.listWatches("kuro").length, 0);
});

test.after(() => rmSync(process.env.WORLD_DATA, { recursive: true, force: true }));
