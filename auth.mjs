// 認可の記録。WORLD_DATA/state/auth.json に一つ。
//
// 二人ぶんの入口がある:
//   - AI  : OAuth で得た access token(または合鍵そのものの静的トークン)
//   - 人間: 合鍵(passphrase)を通って、cookie をもらう
//
// 合鍵のありか(この順で探す):
//   1. WORLD_PASSPHRASE  環境変数(box では sops から)
//   2. WORLD_TOKEN       環境変数(ローカルの Claude Code / opencode 用)
//   3. state/passphrase  無ければ作って、ここに置く(玄関と同じ、生成して残す)
//
// 合鍵は AI の静的トークンも兼ねる。二つ覚えなくていい。

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.mjs";

const AUTH_FILE = join(STATE_DIR, "auth.json");
const KEY_FILE = join(STATE_DIR, "passphrase");
const CLIENT_FILE = join(STATE_DIR, "oauth_client.json");
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const VISIT_TTL_S = 7 * 24 * 60 * 60;
const OWNER_ACCOUNT = "kuro43_";

function empty() {
  return { clients: {}, codes: {}, tokens: {}, refresh: {} };
}

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    for (const k of Object.keys(empty())) store[k] ??= {};
  } catch {
    store = empty();
  }
  return store;
}

function save() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, AUTH_FILE);
  try {
    chmodSync(AUTH_FILE, 0o600);
  } catch {
    // chmod が効かない環境でも、書けたならよい
  }
}

function constant(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

function token(prefix) {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

// ── 合鍵 ──────────────────────────────────────────────────────────────────

let cachedKey = null;

export function accessKey() {
  if (cachedKey) return cachedKey;
  let key = process.env.WORLD_PASSPHRASE || process.env.WORLD_TOKEN || "";
  if (!key) {
    try {
      key = readFileSync(KEY_FILE, "utf-8").trim();
    } catch {
      // まだ無い
    }
  }
  if (!key) {
    key = randomBytes(24).toString("base64url");
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 });
    console.error(`world: 合鍵を作りました → ${KEY_FILE}\nworld: 合鍵: ${key}`);
  }
  cachedKey = key;
  return key;
}

export function passphraseOk(given) {
  const want = accessKey();
  return want !== "" && constant(given, want);
}

// ── client(DCR)────────────────────────────────────────────────────────────

export function registerClient(meta = {}) {
  const s = load();
  const clientId = token("c_");
  const client = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: meta.client_name ?? "unknown",
    redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: meta.scope ?? "world",
  };
  s.clients[clientId] = client;
  save();
  return client;
}

export function getClient(clientId) {
  const s = load();
  if (s.clients[clientId]) return s.clients[clientId];
  const sc = oauthClient();
  if (sc && sc.client_id === clientId) {
    return {
      ...sc,
      token_endpoint_auth_method: sc.client_secret ? "client_secret_post" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "world",
    };
  }
  return null;
}

// 固定の OAuth クライアント(Gemini Enterprise など、DCR を使わない相手)。
//   1. 環境変数 WORLD_OAUTH_CLIENT_ID / _SECRET / _REDIRECT_URIS
//   2. state/oauth_client.json
//   3. 無ければ作って state/oauth_client.json に残す
// redirect_uris の "*" は「どこへでも」、末尾 "*" は前方一致。
let cachedClient = null;

export function oauthClient() {
  if (cachedClient) return cachedClient;
  const id = process.env.WORLD_OAUTH_CLIENT_ID;
  if (id) {
    cachedClient = {
      client_id: id,
      client_secret: process.env.WORLD_OAUTH_CLIENT_SECRET || null,
      client_name: "static",
      redirect_uris: (process.env.WORLD_OAUTH_REDIRECT_URIS ?? "*").split(",").map((s) => s.trim()).filter(Boolean),
    };
    return cachedClient;
  }
  try {
    cachedClient = JSON.parse(readFileSync(CLIENT_FILE, "utf-8"));
    return cachedClient;
  } catch {
    // まだ無い
  }
  cachedClient = {
    client_id: `c_${randomBytes(16).toString("hex")}`,
    client_secret: randomBytes(24).toString("base64url"),
    client_name: "static",
    redirect_uris: ["*"],
  };
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CLIENT_FILE, `${JSON.stringify(cachedClient, null, 2)}\n`, { mode: 0o600 });
    console.error(
      `world: OAuth client を作りました → ${CLIENT_FILE}\n` +
        `world: client_id: ${cachedClient.client_id}\nworld: client_secret: ${cachedClient.client_secret}`,
    );
  } catch {
    // 書けなくても、この起動のあいだは使える
  }
  return cachedClient;
}

export function clientSecretOk(client, provided) {
  if (!client?.client_secret) return true; // 公開クライアント
  return constant(provided ?? "", client.client_secret);
}

export function redirectAllowed(client, redirectUri) {
  if (!redirectUri) return false;
  return (client.redirect_uris ?? []).some((p) =>
    p === "*" ? true : p.endsWith("*") ? redirectUri.startsWith(p.slice(0, -1)) : p === redirectUri,
  );
}

// ── code → token ──────────────────────────────────────────────────────────

export function makeCode({ clientId, redirectUri, codeChallenge, scope, resource, account }) {
  const s = load();
  const code = token("x_");
  s.codes[code] = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge ?? null,
    scope: scope ?? "world",
    resource: resource ?? null,
    account: account ?? null,
    expires_at: Date.now() + CODE_TTL_MS,
  };
  save();
  return code;
}

export function takeCode(code) {
  const s = load();
  const rec = s.codes[code];
  if (!rec) return null;
  delete s.codes[code];
  save();
  if (rec.expires_at < Date.now()) return null;
  return rec;
}

export function issueTokens({ clientId, scope, account }) {
  const s = load();
  const access = token("a_");
  const refresh = token("r_");
  s.tokens[access] = { client_id: clientId, scope, account: account ?? null, expires_at: Date.now() + ACCESS_TTL_MS };
  s.refresh[refresh] = { client_id: clientId, scope, account: account ?? null, expires_at: Date.now() + REFRESH_TTL_MS };
  save();
  return { access_token: access, refresh_token: refresh, expires_in: Math.floor(ACCESS_TTL_MS / 1000) };
}

export function takeRefresh(refreshToken) {
  const s = load();
  const rec = s.refresh[refreshToken];
  if (!rec) return null;
  delete s.refresh[refreshToken];
  save();
  if (rec.expires_at < Date.now()) return null;
  return rec;
}

// ── 検証 ──────────────────────────────────────────────────────────────────
//
// 静的トークン(WORLD_TOKEN)と、OAuth で出した access token の、両方を通す。
export function bearerOk(given) {
  if (!given) return false;
  if (constant(given, accessKey())) return true;
  const s = load();
  const rec = s.tokens[given];
  if (!rec) return false;
  if (rec.expires_at < Date.now()) {
    delete s.tokens[given];
    save();
    return false;
  }
  return true;
}

// トークンの持ち主。sukhi で入った人なら、そのアカウント。合鍵そのもの(静的トークン)や、
// アカウントを知らずに出したトークンは、持ち主(kuro43_)とみなす。
export function tokenAccount(given) {
  if (!given) return null;
  if (constant(given, accessKey())) return OWNER_ACCOUNT;
  const rec = load().tokens[given];
  if (!rec || rec.expires_at < Date.now()) return null;
  const account = rec.account ?? OWNER_ACCOUNT;
  return account === "owner" ? OWNER_ACCOUNT : account;
}

// ── cookie(人間)─────────────────────────────────────────────────────────
//
// 合鍵を種で押した印。玄関(genkan)と同じ考え方。
function visitValue() {
  return createHmac("sha256", accessKey()).update("world_visit").digest("hex");
}

export function issueVisit() {
  return visitValue();
}

export function visitOk(req, cookies) {
  const got = cookies?.world_visit;
  return typeof got === "string" && got.length > 0 && constant(got, visitValue());
}

export function visitCookieHeader(req) {
  const secure = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const parts = [
    `world_visit=${visitValue()}`,
    `Max-Age=${VISIT_TTL_S}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearVisitCookieHeader(req) {
  const secure = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const parts = ["world_visit=", "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// 窓口のセッションが、どのアカウントのものか。合鍵で入った人は kuro43_。
// 合鍵で押した印なので、書き換えられても気づく(署名つき)。
export function accountCookieHeader(req, account) {
  const secure = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const parts = [
    `world_acct=${encodeURIComponent(signState({ account: String(account), version: 2 }))}`,
    `Max-Age=${VISIT_TTL_S}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearAccountCookieHeader(req) {
  const secure = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const parts = ["world_acct=", "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function accountFrom(_req, cookies) {
  const v = verifyState(cookies?.world_acct);
  if (!v || typeof v.account !== "string") return null;
  if (v.version === 2) return v.account;
  return v.account === "owner" ? OWNER_ACCOUNT : null;
}

export function ownerAccount() {
  return OWNER_ACCOUNT;
}

// ── 署名つきの state ─────────────────────────────────────────────────────
//
// sukhi へ渡して戻ってくるあいだ、こちらの持ち物を預ける。合鍵で押すので、
// 途中で書き換えられても気づく。
export function signState(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const mac = createHmac("sha256", accessKey()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyState(str) {
  const [payload, mac] = String(str ?? "").split(".");
  if (!payload || !mac) return null;
  const want = createHmac("sha256", accessKey()).update(payload).digest("base64url");
  if (!constant(mac, want)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}
