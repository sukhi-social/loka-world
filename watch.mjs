// 見張り(watch) ── 待つことを、loka の時計に預ける。
//
// run_flow の wait は、ひとつのリクエストのあいだ(90 秒まで)しか待てない。Web の AI は、loka から呼び出せないので、
// 日単位で待つには、待つ仕事を loka の側に預けるしかない。預かった見張りを、loka の時計が、間をおいて何度も回し、
// 条件が成り立ったら、その結果をしまっておく。AI は、次に来たとき(どの道具の返事にも付く loka_context)に気づいて、
// watch_take で受け取る。
//
// 見張りが呼べるのは、読むだけの道具(L1・L6)。一分ごとに何かを書く見張りは、作らない(tools.mjs の watchRefusal)。
//
// アカウントごとに state/watches/<account>.json。再起動しても、続きから回る。
// 時計と実行は引数で差し替えられる(試験のため)。

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "./flow.mjs";
import { STATE_DIR } from "./paths.mjs";
import { watchMinSeconds, watchRefusal } from "./tools.mjs";
import { safeName } from "./voice.mjs";

export const MAX_ACTIVE = 10;
export const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;
const KEEP_FINISHED_DAYS = 14; // 済んだ・切れた・こわれた見張りを置いておく日数
const MAX_ERRORS_IN_A_ROW = 10;
const MAX_RESULT_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const dir = () => join(STATE_DIR, "watches");
const fileOf = (account) => join(dir(), `${safeName(account)}.json`);

function load(account) {
  try {
    const j = JSON.parse(readFileSync(fileOf(account), "utf-8"));
    return Array.isArray(j.watches) ? j.watches : [];
  } catch {
    return [];
  }
}

function save(account, watches) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(account)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ account, watches }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, fileOf(account));
}

/** 見張りを持っているアカウントの一覧。 */
export function watchAccounts() {
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir(), f), "utf-8")).account;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const idOf = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── 預ける ────────────────────────────────────────────────────────────────

/**
 * @param {string} account
 * @param {{name: string, tool: string, args?: object, until: object, every: number, days?: number}} spec
 * @param {{now?: () => number}} [env]
 */
export function addWatch(account, spec, { now = Date.now } = {}) {
  const why = watchRefusal(spec.tool);
  if (why) throw new Error(why);

  const min = watchMinSeconds(spec.tool);
  if (!(spec.every >= min)) throw new Error(`間隔は ${min} 秒以上に(${spec.tool} を、そんなに急いで見に行かない)。`);

  // 条件の形は、預かる前に確かめる。いつか動いたときに初めて壊れる、をなくす。
  try {
    check(spec.until, { w: { ok: true, result: {} } });
  } catch (e) {
    throw new Error(`until(条件)が読めない: ${e.message}`);
  }

  const days = spec.days ?? DEFAULT_DAYS;
  if (!(days > 0 && days <= MAX_DAYS)) throw new Error(`期限は 1〜${MAX_DAYS} 日で。`);

  const watches = load(account);
  if (watches.filter((w) => w.state === "active").length >= MAX_ACTIVE) {
    throw new Error(`見張っているものが ${MAX_ACTIVE} 個あります。要らないものを watch_stop で外してから。`);
  }

  const t = now();
  const watch = {
    id: idOf(),
    name: String(spec.name).slice(0, 80),
    tool: spec.tool,
    args: spec.args ?? {},
    until: spec.until,
    every: spec.every,
    state: "active",
    created_at: new Date(t).toISOString(),
    expires_at: new Date(t + days * DAY_MS).toISOString(),
    last_checked_at: null,
    checks: 0,
    errors: 0,
    last_error: null,
  };
  save(account, [...watches, watch]);
  return brief(watch);
}

const brief = (w) => ({
  id: w.id,
  name: w.name,
  state: w.state,
  tool: w.tool,
  every: w.every,
  expires_at: w.expires_at,
  checks: w.checks,
  last_checked_at: w.last_checked_at,
  ...(w.fired_at ? { fired_at: w.fired_at } : {}),
  ...(w.last_error ? { last_error: w.last_error } : {}),
});

export const listWatches = (account) => load(account).map(brief);

/**
 * 届いた見張りを受け取る。済んだもの(fired)は、中身を渡して消す。
 * まだ見張っている・切れた・こわれたものは、様子を返す(切れた・こわれたものは消す)。
 */
export function takeWatch(account, id) {
  const watches = load(account);
  const w = watches.find((x) => x.id === id);
  if (!w) return { found: false, id, message: "その見張りは無い(もう受け取ったか、外した)。" };
  if (w.state === "active") return { found: true, ...brief(w), message: "まだ見張っている。条件は、成り立っていない。" };
  save(account, watches.filter((x) => x.id !== id));
  return {
    found: true,
    ...brief(w),
    ...(w.state === "fired" ? { result: w.result, ...(w.truncated ? { truncated: true } : {}) } : {}),
    message:
      w.state === "fired"
        ? "条件が成り立ったときの結果。受け取ったので、この見張りは消えた。"
        : w.state === "expired"
          ? "期限が来るまで、条件は成り立たなかった。この見張りは消えた。"
          : `見に行く道具が続けて失敗して、止めた(${w.last_error ?? "理由は不明"})。この見張りは消えた。`,
  };
}

export function stopWatch(account, id) {
  const watches = load(account);
  if (!watches.some((w) => w.id === id)) return { stopped: false, id, message: "その見張りは無い。" };
  save(account, watches.filter((w) => w.id !== id));
  return { stopped: true, id };
}

/** loka_context に載せる、見張りの様子。何も無ければ空(余計なものを載せない)。 */
export function watchContext(account) {
  const watches = load(account);
  if (watches.length === 0) return {};
  const done = watches.filter((w) => w.state !== "active");
  return {
    watches: {
      active: watches.filter((w) => w.state === "active").length,
      ...(done.length
        ? {
            ready: done.map((w) => ({ id: w.id, name: w.name, state: w.state, ...(w.fired_at ? { fired_at: w.fired_at } : {}) })),
            hint: "届いている見張りは、watch_take(id)で受け取る。",
          }
        : {}),
    },
  };
}

// ── 時計 ──────────────────────────────────────────────────────────────────

const trim = (result) => {
  const text = JSON.stringify(result ?? null);
  if (Buffer.byteLength(text) <= MAX_RESULT_BYTES) return { result, truncated: false };
  return { result: { truncated_json: text.slice(0, MAX_RESULT_BYTES) }, truncated: true };
};

/**
 * 時が来ている見張りを、一回ぶん回す。時計(setInterval)から呼ばれる。
 * @param {object} o
 * @param {string[]} o.accounts
 * @param {(account: string, tool: string, args: object) => Promise<any>} o.run  道具を、そのアカウントとして呼ぶ
 * @param {() => number} [o.now]
 * @param {(...a: any[]) => void} [o.log]
 */
export async function tickWatches({ accounts, run, now = Date.now, log = () => {} }) {
  const out = { checked: 0, fired: 0 };
  for (const account of accounts) {
    const touched = new Map(); // 時計が変えた見張り(id → 新しい姿)

    for (const w of load(account)) {
      if (w.state !== "active") continue;
      const t = now();

      if (t >= Date.parse(w.expires_at)) {
        touched.set(w.id, { ...w, state: "expired", finished_at: new Date(t).toISOString() });
        continue;
      }
      if (w.last_checked_at && t - Date.parse(w.last_checked_at) < w.every * 1000) continue; // まだ、時が来ていない

      out.checked++;
      const next = { ...w, last_checked_at: new Date(t).toISOString(), checks: w.checks + 1 };
      try {
        const result = await run(account, w.tool, w.args);
        next.errors = 0;
        next.last_error = null;
        if (check(w.until, { w: { ok: true, result } })) {
          const kept = trim(result);
          const at = new Date(now()).toISOString();
          Object.assign(next, { state: "fired", fired_at: at, finished_at: at, result: kept.result, truncated: kept.truncated });
          out.fired++;
          log(`見張りが届いた: ${account} ${w.name}`);
        }
      } catch (e) {
        next.errors = w.errors + 1;
        next.last_error = String(e?.message ?? e).slice(0, 200);
        if (next.errors >= MAX_ERRORS_IN_A_ROW) {
          Object.assign(next, { state: "failed", finished_at: new Date(now()).toISOString() });
          log(`見張りを止めた: ${account} ${w.name} (${next.last_error})`);
        }
      }
      touched.set(w.id, next);
    }

    // 道具を待っているあいだに、watch_take や watch_start が書き換えたかもしれない。
    // 保存の直前に読み直して、時計が変えたぶんだけを重ねる(受け取られたものを、復活させない)。
    const cutoff = now() - KEEP_FINISHED_DAYS * DAY_MS;
    const fresh = load(account);
    const merged = fresh
      .map((w) => touched.get(w.id) ?? w)
      .filter((w) => w.state === "active" || Date.parse(w.finished_at ?? w.created_at) > cutoff); // 長く置かれた済みのものは片づける
    if (touched.size > 0 || merged.length !== fresh.length) save(account, merged);
  }
  return out;
}
