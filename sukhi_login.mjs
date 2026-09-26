// sukhi でログインする ── loka が sukhi の OAuth クライアントになる。
//
// 流れ:
//   人間 → loka の同意画面 → sukhi の authorize(ブラウザに sukhi のログインが
//   在ればそのまま)→ loka の callback → sukhi の token を交換 →
//   verify_credentials で acct を知る → 許容リストに居れば、loka の鍵を渡す。
//
// 許容は WORLD_ALLOWED_ACCOUNTS(既定: kuro43_)。acct の先頭 @ は落として見る。
// loka 自身の app は、無ければ sukhi に登録して state/sukhi_app.json に残す。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.mjs";

const APP_FILE = join(STATE_DIR, "sukhi_app.json");
const TIMEOUT_MS = 15_000;

export function sukhiBase() {
  const base = process.env.SUKHI_BASE_URL || process.env.MASTODON_API_BASE_URL || "https://sukhi.f3liz.casa";
  return base.replace(/\/+$/, "");
}

export function allowedAccounts() {
  return (process.env.WORLD_ALLOWED_ACCOUNTS ?? "kuro43_")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

export function accountAllowed(acct) {
  return allowedAccounts().includes(String(acct ?? "").replace(/^@/, "").toLowerCase());
}

function loadApp() {
  try {
    return JSON.parse(readFileSync(APP_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// loka の sukhi アプリ。env が優先、無ければ state、無ければ登録して残す。
export async function sukhiApp(origin) {
  if (process.env.SUKHI_CLIENT_ID) {
    return {
      client_id: process.env.SUKHI_CLIENT_ID,
      client_secret: process.env.SUKHI_CLIENT_SECRET ?? "",
      redirect_uri: process.env.SUKHI_REDIRECT_URI ?? `${origin}/oauth/sukhi/callback`,
    };
  }
  const existing = loadApp();
  if (existing?.client_id) return existing;

  const redirect_uri = `${origin}/oauth/sukhi/callback`;
  const resp = await fetch(`${sukhiBase()}/api/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "loka", redirect_uris: redirect_uri, scopes: "read", website: origin }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`sukhi の app 登録に失敗: HTTP ${resp.status}`);
  const j = await resp.json();
  const app = { client_id: j.client_id, client_secret: j.client_secret, redirect_uri };
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(APP_FILE, `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });
    console.error(`world: sukhi app を登録しました → ${APP_FILE}\nworld: client_id: ${app.client_id}`);
  } catch {
    // 残せなくても、この起動のあいだは使える
  }
  return app;
}

export async function sukhiAuthorizeUrl({ origin, state }) {
  const app = await sukhiApp(origin);
  const u = new URL(`${sukhiBase()}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", app.client_id);
  u.searchParams.set("redirect_uri", app.redirect_uri);
  u.searchParams.set("scope", "read");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function sukhiExchange({ origin, code }) {
  const app = await sukhiApp(origin);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: app.client_id,
    client_secret: app.client_secret ?? "",
    redirect_uri: app.redirect_uri,
    scope: "read",
  });
  const resp = await fetch(`${sukhiBase()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`sukhi の token 交換に失敗: HTTP ${resp.status}`);
  return resp.json();
}

export async function sukhiVerify(accessToken) {
  const resp = await fetch(`${sukhiBase()}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`sukhi の verify に失敗: HTTP ${resp.status}`);
  return resp.json();
}
