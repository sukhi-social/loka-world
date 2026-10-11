import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.WORLD_DATA = mkdtempSync(join(tmpdir(), "loka-voicehttp-"));
process.env.WORLD_PASSPHRASE = "test-key";
process.env.SUKHI_EAR = "off"; // 耳は、ここでは立てない

// 偽の sukhi(アプリ登録・token 交換・verify だけ)
const seen = [];
const sukhi = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, path: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/apps") return res.end(JSON.stringify({ client_id: "cid", client_secret: "csec" }));
    if (req.url === "/oauth/token") return res.end(JSON.stringify({ access_token: "bot-token", refresh_token: "bot-refresh" }));
    if (req.url === "/api/v1/accounts/verify_credentials") return res.end(JSON.stringify({ acct: "shiro_bot" }));
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => sukhi.listen(0, "127.0.0.1", r));
process.env.SUKHI_BASE_URL = `http://127.0.0.1:${sukhi.address().port}`;

const { handleVoiceHttp } = await import("./voice_http.mjs");
const { accountCookieHeader, visitCookieHeader } = await import("./auth.mjs");
const { loadVoice, voiceDir } = await import("./voice.mjs");

const loka = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!(await handleVoiceHttp(req, res, url))) res.writeHead(404).end();
});
await new Promise((r) => loka.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${loka.address().port}`;

const fakeReq = { headers: {} };
const cookieFor = (account) =>
  [visitCookieHeader(fakeReq), accountCookieHeader(fakeReq, account)].map((c) => c.split(";")[0]).join("; ");
const get = (path, account) =>
  fetch(base + path, { redirect: "manual", headers: account ? { cookie: cookieFor(account) } : {} });
const post = (path, account) => fetch(base + path, { method: "POST", redirect: "manual", headers: { cookie: cookieFor(account) } });

async function startConnect(account) {
  const r = await get("/voice/connect", account);
  assert.equal(r.status, 302);
  return new URL(r.headers.get("location"));
}

test("窓口に入っていない人は、通さない", async () => {
  assert.equal((await get("/voice/connect")).status, 401);
});

test("声を繋ぐと、ボットの token がその人の部屋にしまわれる", async () => {
  const authorize = await startConnect("kuro");
  assert.equal(authorize.pathname, "/oauth/authorize");
  assert.equal(authorize.searchParams.get("scope"), "read write");
  assert.match(authorize.searchParams.get("redirect_uri"), /\/oauth\/sukhi\/voice-callback$/);
  assert.equal(JSON.parse(seen.find((s) => s.path === "/api/v1/apps").body).scopes, "read write");

  const back = await get(`/oauth/sukhi/voice-callback?code=abc&state=${encodeURIComponent(authorize.searchParams.get("state"))}`, "kuro");
  assert.equal(back.status, 302);
  assert.equal(back.headers.get("location"), "/settings?voice=connected");

  const v = loadVoice("kuro");
  assert.deepEqual([v.accessToken, v.refreshToken, v.acct, v.watch, v.clientId], ["bot-token", "bot-refresh", "shiro_bot", ["kuro"], "cid"]);
});

test("別の人が戻ってきても、繋がない", async () => {
  const authorize = await startConnect("mio");
  const back = await get(`/oauth/sukhi/voice-callback?code=abc&state=${encodeURIComponent(authorize.searchParams.get("state"))}`, "kuro");
  assert.equal(back.status, 403);
  assert.equal(loadVoice("mio"), null);
});

test("書き換えられた state は通さない", async () => {
  // mio 用に作った署名のまま、中身を kuro に書き換えて、kuro として戻ってくる。
  const state = (await startConnect("mio")).searchParams.get("state");
  const forged = `${Buffer.from(JSON.stringify({ purpose: "voice", account: "kuro", at: Date.now() })).toString("base64url")}.${state.split(".")[1]}`;
  const before = loadVoice("kuro").accessToken;
  assert.equal((await get(`/oauth/sukhi/voice-callback?code=abc&state=${forged}`, "kuro")).status, 400);
  assert.equal(loadVoice("kuro").accessToken, before);
});

test("古くなった state は通さない", async () => {
  const { signState } = await import("./auth.mjs");
  const old = signState({ purpose: "voice", account: "mio", at: Date.now() - 11 * 60 * 1000 });
  assert.equal((await get(`/oauth/sukhi/voice-callback?code=abc&state=${encodeURIComponent(old)}`, "mio")).status, 400);
  assert.equal(loadVoice("mio"), null);
});

test("ボットが自分自身で繋いだなら、聴く相手は居ない", async () => {
  const authorize = await startConnect("shiro_bot");
  await get(`/oauth/sukhi/voice-callback?code=abc&state=${encodeURIComponent(authorize.searchParams.get("state"))}`, "shiro_bot");
  assert.deepEqual(loadVoice("shiro_bot").watch, []);
});

test("声を外す。ファイルは消える", async () => {
  assert.equal(existsSync(join(voiceDir("kuro"), "voice.json")), true);
  const r = await post("/voice/disconnect", "kuro");
  assert.equal(r.headers.get("location"), "/settings?voice=dropped");
  assert.equal(loadVoice("kuro"), null);
});

test("声専用のアプリは、ログイン用とは別に登録される", () => {
  const app = JSON.parse(readFileSync(join(process.env.WORLD_DATA, "state", "sukhi_voice_app.json"), "utf-8"));
  assert.equal(app.scope, "read write");
  assert.equal(existsSync(join(process.env.WORLD_DATA, "state", "sukhi_app.json")), false);
});

test.after(() => {
  loka.close();
  sukhi.close();
  rmSync(process.env.WORLD_DATA, { recursive: true, force: true });
});
