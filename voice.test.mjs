import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.WORLD_DATA = mkdtempSync(join(tmpdir(), "loka-voice-"));
delete process.env.MASTODON_API_BASE_URL;
delete process.env.MASTODON_ACCESS_TOKEN;

const { dropVoice, loadVoice, parseWatch, saveVoice, voiceAccounts, voiceDir } = await import("./voice.mjs");
const { ownerAccount } = await import("./auth.mjs");

const bot = { base: "https://sukhi.test", accessToken: "tok", acct: "shiro_bot", watch: ["kuro"], connectedAt: "2026-10-12T00:00:00Z" };

test("声が無ければ null", () => assert.equal(loadVoice("nobody"), null));

test("しまった声は、そのまま読める。鍵のファイルは自分だけ", () => {
  saveVoice("kuro", bot);
  const v = loadVoice("kuro");
  assert.deepEqual([v.base, v.accessToken, v.acct, v.watch, v.account], [bot.base, "tok", "shiro_bot", ["kuro"], "kuro"]);
  assert.equal(v.dir, voiceDir("kuro"));
  assert.equal(statSync(join(v.dir, "voice.json")).mode & 0o777, 0o600);
});

test("アカウントごとに、別々の声", () => {
  saveVoice("kuro", bot);
  saveVoice("mio", { ...bot, accessToken: "other", acct: "mio_bot" });
  assert.deepEqual([loadVoice("kuro").acct, loadVoice("mio").acct], ["shiro_bot", "mio_bot"]);
  assert.deepEqual(voiceAccounts().sort(), ["kuro", "mio"]);
});

test("アカウント名で、道の外へは出られない", () => {
  assert.equal(voiceDir("../../etc").startsWith(join(process.env.WORLD_DATA, "state", "voices")), true);
  assert.equal(voiceDir("..").endsWith("/voices/_"), true);
  assert.equal(voiceDir("a/b").endsWith("/voices/a_b"), true);
  saveVoice("../escape", bot);
  assert.equal(loadVoice("../escape").accessToken, "tok");
});

test("外すと声は無くなるが、聞いた控えは残る", () => {
  saveVoice("kuro", bot);
  dropVoice("kuro");
  assert.equal(loadVoice("kuro"), null);
});

test("環境変数の声は、持ち主だけ。しまった声のほうが先", () => {
  process.env.MASTODON_API_BASE_URL = "https://env.test/";
  process.env.MASTODON_ACCESS_TOKEN = "envtok";
  try {
    assert.equal(loadVoice("someone"), null);
    const owner = ownerAccount();
    assert.deepEqual([loadVoice(owner).base, loadVoice(owner).accessToken], ["https://env.test", "envtok"]);
    assert.deepEqual(loadVoice(owner).watch, ["nyanrus", "kuro43_"]);
    assert.equal(voiceAccounts().includes(owner), true);
    saveVoice(owner, { ...bot, accessToken: "stored" });
    assert.equal(loadVoice(owner).accessToken, "stored");
  } finally {
    delete process.env.MASTODON_API_BASE_URL;
    delete process.env.MASTODON_ACCESS_TOKEN;
  }
});

test("聴く相手は、改行・空白・カンマ区切り。別のサーバーの人も書ける", () => {
  assert.deepEqual(parseWatch("@nyanrus\nkuro43_@misskey.io, kuro43_  nyanrus"), ["nyanrus", "kuro43_@misskey.io", "kuro43_"]);
  assert.deepEqual(parseWatch("  \n "), []);
});

test("acct の形でないものは断る。多すぎるのも", () => {
  assert.throws(() => parseWatch("good\nhttps://evil.example/users/x"), /acct の形/);
  assert.throws(() => parseWatch("a@b@c"), /acct の形/);
  assert.throws(() => parseWatch(Array.from({ length: 21 }, (_, i) => `u${i}`).join(",")), /20 人まで/);
});

test.after(() => rmSync(process.env.WORLD_DATA, { recursive: true, force: true }));
