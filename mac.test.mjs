import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

process.env.WORLD_DATA = `${process.env.TMPDIR ?? "/tmp"}/loka-mac-test-${process.pid}`;
process.env.WORLD_PASSPHRASE = "test-key";
process.env.SUKHI_CLIENT_ID = "cid";

const { handleMac, macExec, macStatus, mintMacCode, MAX_HOURS } = await import("./mac.mjs");
const { handleOAuth } = await import("./oauth.mjs");
const { ownerAccount } = await import("./auth.mjs");

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if ((await handleMac(req, res, url)) || (await handleOAuth(req, res, url))) return;
  res.writeHead(404).end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${http.address().port}`;
const post = (path, body, key) =>
  fetch(base + path, { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {}, body: JSON.stringify(body) });

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const login = async (hours) => {
  const code = mintMacCode({ challenge, hours, account: ownerAccount() });
  const r = await (await post("/mac/token", { code, verifier })).json();
  return r.access_token;
};

test("closed until an agent connects", async () => {
  assert.equal(macStatus().connected, false);
  await assert.rejects(macExec({ cmd: "ls", timeoutSeconds: 5 }), /閉じている/);
});

test("the passphrase and random tokens are refused", async () => {
  assert.equal((await post("/mac/poll", {}, "test-key")).status, 401);
  assert.equal((await post("/mac/poll", {}, "m_nope")).status, 401);
});

test("only the owner, and at most 12 hours, can get a code", () => {
  assert.throws(() => mintMacCode({ challenge, hours: 1, account: "someone" }), /持ち主/);
  assert.throws(() => mintMacCode({ challenge, hours: MAX_HOURS + 1, account: ownerAccount() }), /12/);
});

test("code is single-use and needs the verifier", async () => {
  const code = mintMacCode({ challenge, hours: 1, account: ownerAccount() });
  assert.equal((await post("/mac/token", { code, verifier: "x".repeat(43) })).status, 400);
  assert.equal((await post("/mac/token", { code, verifier })).status, 400); // 失敗で燃える
  const ok = mintMacCode({ challenge, hours: 1, account: ownerAccount() });
  assert.equal((await post("/mac/token", { code: ok, verifier })).status, 200);
  assert.equal((await post("/mac/token", { code: ok, verifier })).status, 400);
});

test("/oauth/sukhi/mac validates its query, then goes to sukhi", async () => {
  const q = (o) => new URLSearchParams(o);
  const bad = await fetch(`${base}/oauth/sukhi/mac?${q({ port: 5000, challenge, hours: 13 })}`, { redirect: "manual" });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/oauth/sukhi/mac?${q({ port: 5000, challenge, hours: 2 })}`, { redirect: "manual" });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("location"), /\/oauth\/authorize\?/);
});

test("a job reaches the agent and the result comes back", async () => {
  const token = await login(2);
  const first = post("/mac/poll", { host: "t" }, token).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(macStatus().minutes_left <= 120);
  const pending = macExec({ cmd: "echo hi", timeoutSeconds: 5 });
  const { job } = await first;
  assert.equal(job.cmd, "echo hi");
  await post("/mac/result", { id: job.id, exit_code: 0, stdout: "hi\n", stderr: "" }, token);
  const result = await pending;
  assert.equal(result.stdout, "hi\n");
});

test.after(() => http.close());
