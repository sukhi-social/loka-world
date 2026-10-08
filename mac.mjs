// Mac のシェルへの道(サーバー側)。
//
// 開けるのは、Mac の持ち主だけ。Mac で agent を起動し(`--hours` で期間を決める。上限12時間)、
// agent が loka へ外向きに繋ぐ。サーバーから Mac へ入る道は無い。
//
//   POST /mac/poll    agent が待つ(long-poll)。命令があれば受け取る。
//   POST /mac/result  agent が結果を返す。
//
// 入口は sukhi ログイン。agent が起動すると、ブラウザで sukhi にログインし(oauth.mjs の
// /oauth/sukhi/mac)、持ち主(kuro43_)と確かめられたら、--hours だけ生きる専用トークンが渡る。
// 期限はそのトークンが持ち、サーバーが数える(agent の自己申告は信じない)。agent 自身も守る(二重)。
// トークンは memory だけに置く。サーバーを再起動したら閉じる。
// 命令を出せるのは MCP の mac_exec だけで、agent が繋がっていて、期限内の間だけ通る。

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { ownerAccount } from "./auth.mjs";
import { STATE_DIR } from "./paths.mjs";
import { sendJson } from "./web.mjs";

export const MAX_HOURS = 12;
const HOLD_MS = 25_000; // poll を握っておく長さ
const SEEN_MS = 45_000; // これより長く poll が来なければ、繋がっていないとみなす
const MAX_TIMEOUT_S = 600;
const LOG_FILE = join(STATE_DIR, "mac_exec.log");

const CODE_TTL_MS = 2 * 60_000;
const codes = new Map(); // code -> { challenge, hours, account, expiresAt }
const tokens = new Map(); // token -> { account, until }

// sukhi ログインが済んだあと、agent の手元(loopback)へ返す、一回きりの code。
export function mintMacCode({ challenge, hours, account }) {
  if (account !== ownerAccount()) throw new Error("Mac の道は、持ち主のアカウントだけ。");
  if (!(hours > 0 && hours <= MAX_HOURS)) throw new Error(`hours は 0 より大きく ${MAX_HOURS} 以下。`);
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { challenge, hours, account, expiresAt: now() + CODE_TTL_MS });
  return code;
}

function exchangeCode(code, verifier) {
  const rec = codes.get(code);
  codes.delete(code); // 一回きり
  if (!rec || rec.expiresAt < now() || !verifier) return null;
  const got = Buffer.from(createHash("sha256").update(String(verifier)).digest("base64url"));
  const want = Buffer.from(rec.challenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const token = `m_${randomBytes(32).toString("hex")}`;
  const until = now() + rec.hours * 3600_000;
  tokens.set(token, { account: rec.account, until });
  audit({ event: "login", account: rec.account, until: new Date(until).toISOString() });
  return { token, until };
}

function liveToken(given) {
  const rec = tokens.get(given);
  if (!rec) return null;
  if (rec.until <= now()) return tokens.delete(given), null;
  return rec;
}

// 繋がっている agent は一つだけ(個人の Mac ひとつ)。
let agent = null; // { until, seenAt, host }
let waiting = null; // 待っている poll の resolve
const queue = []; // まだ渡していない命令
const inflight = new Map(); // id -> { resolve, timer }

const now = () => Date.now();

function audit(entry) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    // 記録できなくても、実行そのものは止めない
  }
}

export function macStatus() {
  const live = agent !== null && now() - agent.seenAt < SEEN_MS && agent.until > now();
  return {
    connected: live,
    minutes_left: live ? Math.max(0, Math.floor((agent.until - now()) / 60_000)) : 0,
    until: live ? new Date(agent.until).toISOString() : null,
    host: live ? agent.host : null,
    max_hours: MAX_HOURS,
    how_to_open: live
      ? null
      : "Mac の持ち主が、Mac で `LOKA_KEY=… node mac/loka-mac-agent.mjs --hours N`(N は 12 以下)を動かすと開く。AI からは開けない。",
  };
}

export async function macExec({ cmd, cwd, timeoutSeconds }) {
  const status = macStatus();
  if (!status.connected) throw new Error(`Mac の道は閉じている。${status.how_to_open ?? ""}`);
  const secs = Math.min(timeoutSeconds, MAX_TIMEOUT_S, status.minutes_left * 60);
  if (secs < 1) throw new Error("許可の期限が、もうほとんど残っていない。");

  const id = randomUUID();
  const job = { id, cmd, cwd: cwd || null, timeout_seconds: secs };
  audit({ event: "exec", id, cwd: job.cwd, cmd });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      resolve({ error: "agent から結果が戻らなかった(繋がりが切れたかもしれない)" });
    }, (secs + 15) * 1000);
    inflight.set(id, { resolve, timer });
    if (waiting) {
      const give = waiting;
      waiting = null;
      give({ job });
    } else {
      queue.push(job);
    }
  });
  if (result.error) throw new Error(result.error);
  return result;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const bearer = (req) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

// agent の二つの口。取り扱ったら true。
export async function handleMac(req, res, url) {
  if (!["/mac/token", "/mac/poll", "/mac/result"].includes(url.pathname)) return false;
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST のみ" }), true;

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "読めない body" }), true;
  }

  // code(+ verifier)を、期限つきのトークンに替える。
  if (url.pathname === "/mac/token") {
    const got = exchangeCode(String(body.code ?? ""), body.verifier);
    if (!got) return sendJson(res, 400, { error: "code が合わない、または期限切れ" }), true;
    return sendJson(res, 200, { access_token: got.token, until: got.until }), true;
  }

  const grant = liveToken(bearer(req));
  if (!grant) return sendJson(res, 401, { error: "トークンが無効、または期限切れ。sukhi ログインからやりなおし" }), true;

  if (url.pathname === "/mac/result") {
    const entry = inflight.get(body.id);
    if (!entry) return sendJson(res, 404, { error: "待っている命令が無い" }), true;
    clearTimeout(entry.timer);
    inflight.delete(body.id);
    audit({ event: "result", id: body.id, exit: body.exit_code ?? null, signal: body.signal ?? null });
    entry.resolve({
      exit_code: body.exit_code ?? null,
      signal: body.signal ?? null,
      timed_out: body.timed_out === true,
      stdout: String(body.stdout ?? ""),
      stderr: String(body.stderr ?? ""),
      truncated: body.truncated === true,
      duration_ms: Number(body.duration_ms) || null,
    });
    return sendJson(res, 200, { ok: true }), true;
  }

  // poll。期限はトークンのもの(mint のとき 12 時間以下に切ってある)。
  const until = grant.until;
  const first = !agent || now() - agent.seenAt >= SEEN_MS;
  agent = { until, seenAt: now(), host: String(body.host ?? "mac").slice(0, 80) };
  if (first) audit({ event: "connected", host: agent.host, until: new Date(until).toISOString() });

  if (queue.length) return sendJson(res, 200, { job: queue.shift() }), true;
  if (waiting) waiting({ idle: true }); // 古い poll は手放す
  const out = await new Promise((resolve) => {
    const give = (value) => {
      clearTimeout(timer);
      if (waiting === give) waiting = null;
      resolve(value);
    };
    const timer = setTimeout(() => give({ idle: true }), HOLD_MS);
    waiting = give;
    // 待っている間に agent が切れたら、手放す
    res.on("close", () => give({ idle: true, gone: true }));
  });
  if (out.gone || res.destroyed) {
    // 切れた poll に命令は渡せない。キューへ戻す
    if (out.job) queue.unshift(out.job);
  } else {
    sendJson(res, 200, out);
  }
  return true;
}
