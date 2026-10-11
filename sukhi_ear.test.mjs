import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.WORLD_DATA = mkdtempSync(join(tmpdir(), "loka-ear-"));
const { createEar, fileStore, readInbox } = await import("./sukhi_ear.mjs");

const NYAN = { acct: "nyanrus", uri: "https://sukhi/users/nyanrus" };
const STRANGER = { acct: "evil", uri: "https://other/users/evil" };
const ME = "me-id";

const status = (id, who, text = "<p>やあ</p>", extra = {}) => ({
  id, visibility: "direct", account: { uri: who.uri }, content: text, media_attachments: [], ...extra,
});
const conv = (id, who, last) => ({ id, accounts: [{ uri: who.uri, acct: who.acct }], last_status: last });
const frame = (payload) => JSON.stringify({ event: "conversation", payload: JSON.stringify(payload) });

function setup({ api = async () => [], lastSeen } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loka-ear-store-"));
  if (lastSeen) writeFileSync(join(dir, "sukhi_ear.json"), JSON.stringify({ lastSeen }));
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

test.after(() => rmSync(process.env.WORLD_DATA, { recursive: true, force: true }));
