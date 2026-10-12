import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.WORLD_DATA = mkdtempSync(join(tmpdir(), "loka-ear-"));
const { createEar, fileStore, lookupWatched, readInbox } = await import("./sukhi_ear.mjs");

const NYAN = { acct: "nyanrus", uri: "https://sukhi/users/nyanrus" };
const STRANGER = { acct: "evil", uri: "https://other/users/evil" };
const ME = "me-id";

const status = (id, who, text = "<p>やあ</p>", extra = {}) => ({
  id, visibility: "direct", account: { uri: who.uri }, content: text, media_attachments: [], ...extra,
});
const conv = (id, who, last) => ({ id, accounts: [{ uri: who.uri, acct: who.acct }], last_status: last });
const frame = (payload) => JSON.stringify({ event: "conversation", payload: JSON.stringify(payload) });

function setup({ api = async () => [], lastSeen, lastSeenMention } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loka-ear-store-"));
  if (lastSeen || lastSeenMention) writeFileSync(join(dir, "sukhi_ear.json"), JSON.stringify({ lastSeen, lastSeenMention }));
  const store = fileStore(dir);
  const ear = createEar({ api, watched: [NYAN], me: ME, store });
  return { dir, ear, inbox: () => readInbox({ dir }).events, heard: () => JSON.parse(readFileSync(join(dir, "sukhi_heard.json"), "utf-8")) };
}

test("二人きりで、相手本人が direct で書いた一通を拾う", () => {
  const { ear, inbox, heard, dir } = setup();
  ear.handleFrame(frame(conv("c1", NYAN, status("100", NYAN, "<p>@shiro おはよう</p>"))));
  const [e] = inbox();
  assert.deepEqual([e.seq, e.kind, e.acct, e.text, e.status_id], [1, "dm", "nyanrus", "おはよう", "100"]);
  assert.equal(heard().nyanrus.status_id, "100");
  assert.equal(JSON.parse(readFileSync(join(dir, "sukhi_ear.json"), "utf-8")).lastSeen, "100");
});

test("よその人の一通は、出来事にならない", () => {
  const { ear, inbox } = setup();
  ear.handleFrame(frame(conv("c1", STRANGER, status("100", STRANGER))));
  assert.deepEqual(inbox(), []);
});

test("同じ一通は一度だけ", () => {
  const { ear, inbox } = setup();
  const f = frame(conv("c1", NYAN, status("100", NYAN)));
  ear.handleFrame(f);
  ear.handleFrame(f);
  assert.equal(inbox().length, 1);
});

test("出ていったぶんは itta として控え、返す先(heard)にはしない", () => {
  const { ear, inbox, dir } = setup();
  const mine = status("200", NYAN, "<p>うん</p>", { account: { id: ME, uri: "https://sukhi/users/shiro" } });
  ear.handleFrame(frame({ id: "c1", accounts: [{ id: "n", acct: "nyanrus", uri: NYAN.uri }], last_status: mine }));
  assert.deepEqual(inbox().map((e) => [e.kind, e.acct, e.text]), [["itta", "nyanrus", "うん"]]);
  assert.throws(() => readFileSync(join(dir, "sukhi_heard.json")));
});

test("読めないフレームは、静かに捨てる", () => {
  const { ear, inbox } = setup();
  ear.handleFrame("{");
  ear.handleFrame(JSON.stringify({ event: "update" }));
  ear.handleFrame(JSON.stringify({ event: "conversation", payload: "{" }));
  assert.deepEqual(inbox(), []);
});

test("はじめての拾い直しは、過去を蒸し返さず、いまの位置に印をつける", async () => {
  const api = async () => [conv("c1", NYAN, status("500", NYAN))];
  const { ear, inbox } = setup({ api });
  await ear.catchUp();
  assert.deepEqual(inbox(), []);
  assert.equal(ear.lastSeen(), "500");
});

test("留守のぶんは、返信鎖ごと、古いほうから拾う", async () => {
  const api = async (path) => {
    if (path === "/api/v1/conversations") return [conv("c1", NYAN, status("300", NYAN, "<p>三</p>"))];
    if (path === "/api/v1/statuses/300/context")
      return { ancestors: [status("50", NYAN, "<p>古い</p>"), status("200", NYAN, "<p>二</p>"), { ...status("250", NYAN), account: { uri: "x" } }] };
    throw new Error(path);
  };
  const { ear, inbox } = setup({ api, lastSeen: "100" });
  await ear.catchUp();
  assert.deepEqual(inbox().map((e) => [e.status_id, e.text, e.late]), [["200", "二", true], ["300", "三", true]]);
  assert.equal(ear.lastSeen(), "300");
});

test("拾い直しの最中に来たフレームは、終わってから処理される", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const api = async () => (await gate, []);
  const { ear, inbox } = setup({ api, lastSeen: "1" });
  const running = ear.catchUp();
  ear.handleFrame(frame(conv("c1", NYAN, status("900", NYAN, "<p>いま</p>"))));
  assert.deepEqual(inbox(), []);
  release();
  await running;
  assert.deepEqual(inbox().map((e) => e.status_id), ["900"]);
});

test("控えは seq で続きから読める。seq は再起動をまたいで続く", () => {
  const { ear, dir } = setup();
  for (const id of ["1", "2", "3"]) ear.handleFrame(frame(conv("c", NYAN, status(id, NYAN))));
  const after1 = readInbox({ dir, sinceSeq: 1, limit: 1 });
  assert.deepEqual([after1.events.map((e) => e.seq), after1.has_more], [[2], true]);
  assert.equal(fileStore(dir).append({ kind: "dm" }).seq, 4);
});

// ── 名前を呼ばれた(mention 通知)──────────────────────────────────────────

const REMOTE = { acct: "kuro43_@misskey.io", uri: "https://misskey.io/users/abc" };
const notif = (id, who, statusId, vis = "public", text = "<p>@shiro やあ</p>") => ({
  id, type: "mention", account: { uri: who.uri },
  status: { id: statusId, visibility: vis, content: text, account: { uri: who.uri }, media_attachments: [] },
});
const nframe = (n) => JSON.stringify({ event: "notification", stream: ["user"], payload: JSON.stringify(n) });
function setupRemote(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loka-ear-store-"));
  if (opts.lastSeen || opts.lastSeenMention) writeFileSync(join(dir, "sukhi_ear.json"), JSON.stringify(opts));
  const ear = createEar({ api: opts.api ?? (async () => []), watched: [NYAN, REMOTE], me: ME, store: fileStore(dir) });
  return { dir, ear, inbox: () => readInbox({ dir }).events };
}

test("公開メンションを拾う。公開範囲を添え、DM の返す先(heard)にはしない", () => {
  const { ear, inbox, dir } = setupRemote();
  ear.handleFrame(nframe(notif("n1", REMOTE, "p1", "public", "<p>@shiro おはよう</p>")));
  const [e] = inbox();
  assert.deepEqual([e.kind, e.acct, e.text, e.status_id, e.visibility], ["mention", "kuro43_@misskey.io", "おはよう", "p1", "public"]);
  assert.throws(() => readFileSync(join(dir, "sukhi_heard.json")));
});

test("非公開(private)・未収載のメンションも拾う", () => {
  const { ear, inbox } = setupRemote();
  ear.handleFrame(nframe(notif("n1", REMOTE, "p1", "unlisted")));
  ear.handleFrame(nframe(notif("n2", REMOTE, "p2", "private")));
  assert.deepEqual(inbox().map((e) => e.visibility), ["unlisted", "private"]);
});

test("direct の mention 通知は、ここでは通さない(三人の DM を守るため)", () => {
  const { ear, inbox } = setupRemote();
  ear.handleFrame(nframe(notif("n1", REMOTE, "p1", "direct")));
  assert.deepEqual(inbox(), []);
});

test("よその人のメンションと、mention 以外の通知は、出来事にならない", () => {
  const { ear, inbox } = setupRemote();
  ear.handleFrame(nframe(notif("n1", STRANGER, "p1")));
  ear.handleFrame(nframe({ ...notif("n2", REMOTE, "p2"), type: "favourite" }));
  assert.deepEqual(inbox(), []);
});

test("同じ投稿が、通知と direct の両方から来ても一度だけ", () => {
  const { ear, inbox } = setupRemote();
  ear.handleFrame(frame(conv("c1", REMOTE, status("200", REMOTE))));
  ear.handleFrame(nframe(notif("n1", REMOTE, "200", "public")));
  assert.deepEqual(inbox().map((e) => [e.kind, e.status_id]), [["dm", "200"]]);
});

test("リモートの相手の DM(direct の流れ)も、これまで通り拾う", () => {
  const { ear, inbox, dir } = setupRemote();
  ear.handleFrame(frame(conv("c1", REMOTE, status("300", REMOTE, "<p>こんにちは</p>"))));
  assert.deepEqual(inbox().map((e) => [e.kind, e.acct, e.text]), [["dm", "kuro43_@misskey.io", "こんにちは"]]);
  assert.equal(JSON.parse(readFileSync(join(dir, "sukhi_heard.json"), "utf-8"))["kuro43_@misskey.io"].status_id, "300");
});

test("はじめての mention の拾い直しは、過去を蒸し返さない", async () => {
  const api = async (path) => (path.startsWith("/api/v1/notifications") ? [notif("90", REMOTE, "p9")] : []);
  const { ear, inbox, dir } = setupRemote({ api });
  await ear.catchUp();
  assert.deepEqual(inbox(), []);
  assert.equal(JSON.parse(readFileSync(join(dir, "sukhi_ear.json"), "utf-8")).lastSeenMention, "90");
});

test("留守のあいだの mention を、古いほうから拾い、印を進める", async () => {
  const api = async (path) =>
    path.startsWith("/api/v1/notifications?types[]=mention")
      ? [notif("30", REMOTE, "p3"), notif("25", STRANGER, "p25"), notif("20", REMOTE, "p2"), notif("5", REMOTE, "p0")]
      : [];
  const { ear, inbox, dir } = setupRemote({ api, lastSeen: "1", lastSeenMention: "10" });
  await ear.catchUp();
  assert.deepEqual(inbox().map((e) => [e.status_id, e.late]), [["p2", true], ["p3", true]]);
  assert.equal(JSON.parse(readFileSync(join(dir, "sukhi_ear.json"), "utf-8")).lastSeenMention, "30");
  assert.equal(JSON.parse(readFileSync(join(dir, "sukhi_ear.json"), "utf-8")).lastSeen, "1"); // DM の印は動かない
});

test("拾い直しの最中に来た通知は、終わってから処理される(印を飛び越さない)", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const api = async (path) => {
    await gate;
    return path.startsWith("/api/v1/notifications") ? [notif("20", REMOTE, "p2"), notif("12", REMOTE, "p1")] : [];
  };
  const { ear, inbox } = setupRemote({ api, lastSeen: "1", lastSeenMention: "10" });
  const running = ear.catchUp();
  ear.handleFrame(nframe(notif("50", REMOTE, "p5"))); // 拾い直しの最中。ここで印が進むと p1, p2 を飛び越す
  release();
  await running;
  assert.deepEqual(inbox().map((e) => e.status_id).sort(), ["p1", "p2", "p5"]);
});

test("別のサーバーから来た DM は、流れに載らなくても、会話の一覧を見れば拾える(定期の拾い直し)", async () => {
  // 一度目: 印をつけるだけ。そのあとに届いた DM が、二度目の拾い直しで拾われる。
  let convs = [conv("c0", REMOTE, status("100", REMOTE, "<p>前</p>"))];
  const api = async (path) => (path === "/api/v1/conversations" ? convs : path.endsWith("/context") ? { ancestors: [] } : []);
  const { ear, inbox } = setupRemote({ api });
  await ear.catchUp();
  assert.deepEqual(inbox(), []);

  convs = [conv("c1", REMOTE, status("200", REMOTE, "<p>@shiro DM だよ</p>")), ...convs];
  await ear.catchUp();
  assert.deepEqual(inbox().map((e) => [e.kind, e.acct, e.text, e.late]), [["dm", "kuro43_@misskey.io", "DM だよ", true]]);

  await ear.catchUp(); // 三度目は、もう何も増えない
  assert.equal(inbox().length, 1);
});

test("拾い直しが走っているあいだに呼ばれても、重ならない", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const api = async (path) => {
    if (path === "/api/v1/conversations") {
      calls++;
      await gate;
    }
    return [];
  };
  const { ear } = setupRemote({ api, lastSeen: "1", lastSeenMention: "1" });
  const first = ear.catchUp();
  await ear.catchUp(); // すぐ戻る
  release();
  await first;
  assert.equal(calls, 1);
});

test("相手を引くとき resolve を付ける。引けない相手は黙って外す", async () => {
  const asked = [];
  const api = async (path) => {
    asked.push(path);
    if (path.includes("nobody")) throw new Error("HTTP 404");
    return { uri: "https://misskey.io/users/abc" };
  };
  const logs = [];
  const out = await lookupWatched(api, ["kuro43_@misskey.io", "nobody"], (m) => logs.push(m));
  assert.deepEqual(out, [{ acct: "kuro43_@misskey.io", uri: "https://misskey.io/users/abc" }]);
  assert.match(asked[0], /acct=kuro43_%40misskey\.io&resolve=1/);
  assert.match(logs[0], /nobody/);
});

test.after(() => rmSync(process.env.WORLD_DATA, { recursive: true, force: true }));
