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

// sukhi に登録する loka のアプリは二つ。ログイン(read だけ。誰が入ったか分かればよい)と、
// 声(read write。ボットとして話すため)。同意画面の重さを分けるために、アプリを分けてある。
const KINDS = {
  login: { file: "sukhi_app.json", env: "SUKHI", callback: "/oauth/sukhi/callback", scope: "read", name: "loka" },
  voice: { file: "sukhi_voice_app.json", env: "SUKHI_VOICE", callback: "/oauth/sukhi/voice-callback", scope: "read write", name: "loka voice" },
};

function loadApp(kind) {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, KINDS[kind].file), "utf-8"));
  } catch {
    return null;
  }
}

// loka の sukhi アプリ。env が優先、無ければ state、無ければ登録して残す。
export async function sukhiApp(origin, kind = "login") {
  const k = KINDS[kind];
  if (process.env[`${k.env}_CLIENT_ID`]) {
    return {
      client_id: process.env[`${k.env}_CLIENT_ID`],
      client_secret: process.env[`${k.env}_CLIENT_SECRET`] ?? "",
      redirect_uri: process.env[`${k.env}_REDIRECT_URI`] ?? `${origin}${k.callback}`,
      scope: k.scope,
    };
  }
  const existing = loadApp(kind);
  if (existing?.client_id) return { scope: k.scope, ...existing };

  const redirect_uri = `${origin}${k.callback}`;
  const resp = await fetch(`${sukhiBase()}/api/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: k.name, redirect_uris: redirect_uri, scopes: k.scope, website: origin }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`sukhi の app 登録に失敗: HTTP ${resp.status}`);
  const j = await resp.json();
  const app = { client_id: j.client_id, client_secret: j.client_secret, redirect_uri, scope: k.scope };
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(STATE_DIR, k.file), `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });
    console.error(`world: sukhi app(${kind})を登録しました → ${join(STATE_DIR, k.file)}\nworld: client_id: ${app.client_id}`);
  } catch {
    // 残せなくても、この起動のあいだは使える
  }
  return app;
}

export async function sukhiAuthorizeUrl({ origin, state, kind = "login" }) {
  const app = await sukhiApp(origin, kind);
  const u = new URL(`${sukhiBase()}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", app.client_id);
  u.searchParams.set("redirect_uri", app.redirect_uri);
  u.searchParams.set("scope", app.scope);
  u.searchParams.set("state", state);
  // 声は、ボットのアカウントで入りなおしたい。すでに sukhi に別の人で入っていても、選びなおせるように。
  if (kind === "voice") u.searchParams.set("force_login", "true");
  return u.toString();
}

export async function sukhiExchange({ origin, code, kind = "login" }) {
  const app = await sukhiApp(origin, kind);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: app.client_id,
    client_secret: app.client_secret ?? "",
    redirect_uri: app.redirect_uri,
    scope: app.scope,
  });
  const resp = await fetch(`${sukhiBase()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`sukhi の token 交換に失敗: HTTP ${resp.status}`);
  // 声は取り直しのために、アプリの鍵も添えて返す。
  return { ...(await resp.json()), client_id: app.client_id, client_secret: app.client_secret ?? "", scope: app.scope };
}

export async function sukhiVerify(accessToken) {
  const resp = await fetch(`${sukhiBase()}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`sukhi の verify に失敗: HTTP ${resp.status}`);
  return resp.json();
}
