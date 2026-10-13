// run_flow の中身。道具の名前と引数を並べた流れを、上から順に動かす。
//
//   steps: [{ id?, tool, args?, when?, on_error?, accept? }]
//          [{ id?, wait: { ... }, when?, on_error? }]      条件が整うまで待つ(下)
//
//   id        手順の名前。あとの手順から ${id.result.xxx} / ${id.ok} / ${id.error} で結果を使える。
//   when      条件。合わなければ、その手順は飛ばす。
//               { ref: "a.ok" }                       … 値が真なら
//               { ref: "a.result.n", eq|ne|gt|lt|contains: 値 } / { ref: "a.result", exists: true }
//               { ref: "a.result.events", nonempty: true }   … 空でない配列・文字列・オブジェクトなら
//               { all: [...] } / { any: [...] } / { not: {...} }
//   on_error  "stop"(既定: そこで止まる)か "continue"(失敗を記録して先へ。次の when で受ける)。
//   accept    L5 の道具の下書きを、実行にする印 { id, hash }(中身は outgoing.mjs。flow は step ごと call に渡すだけ)。
//
//   wait      条件が整うまで、能動的に待つ。
//               { seconds: 20 }                           … ただ待つ
//               { tool, args?, until: <条件>, every?: 5, every_ref?, timeout?: 30, on_timeout?: "continue"|"stop" }
//                 … every 秒ごとに tool を呼び、until が成り立つまで繰り返す。
//                   every_ref は、道具が「次は何秒あとに来て」と教えてくれる値の参照(例: "w.result.next_check_in")。
//                   あれば、every より長いほうに従う(のぞきこまず、道具のペースで待つ)。
//                   until は when と同じ書きかたで、いま引いた結果は ${id.result} で見える。
//               時間切れは失敗ではない(status: "timed_out"、${id.wait.satisfied} が false)。
//               止めたいなら on_timeout: "stop"。待てる合計は、流れ全体の持ち時間(budget)まで。
//
// 道具を呼ぶ部分(call)は外から渡す。ここは順番と条件と待ちかただけを知っている。

import { isDeepStrictEqual } from "node:util";

export const MAX_STEPS = 20;
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ctx の中を "a.b.0.c" で辿る。持っていない名前は辿らない。
export function lookup(ctx, path) {
  let cur = ctx;
  for (const key of String(path).trim().split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function need(ctx, path) {
  const value = lookup(ctx, path);
  if (value === undefined) throw new Error(`参照が見つからない: ${path.trim()}`);
  return value;
}

// 文字列の ${...} を埋める。文字列まるごと ${...} なら、型を保ったまま渡す。
export function resolve(value, ctx) {
  if (typeof value === "string") {
    const whole = value.match(/^\$\{([^}]+)\}$/);
    if (whole) return need(ctx, whole[1]);
    return value.replace(/\$\{([^}]+)\}/g, (_, path) => {
      const v = need(ctx, path);
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]));
  }
  return value;
}

const filled = (v) =>
  Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.length > 0 : v !== null && typeof v === "object" && Object.keys(v).length > 0;

export function check(cond, ctx) {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) throw new Error("when は { ... } の形で");
  if ("all" in cond) return cond.all.every((c) => check(c, ctx));
  if ("any" in cond) return cond.any.some((c) => check(c, ctx));
  if ("not" in cond) return !check(cond.not, ctx);
  if (typeof cond.ref !== "string") throw new Error("when には ref(参照)か all / any / not が要る");

  const v = lookup(ctx, cond.ref);
  if ("exists" in cond) return (v !== undefined) === Boolean(cond.exists);
  if ("nonempty" in cond) return filled(v) === Boolean(cond.nonempty);
  if ("eq" in cond) return isDeepStrictEqual(v, cond.eq);
  if ("ne" in cond) return !isDeepStrictEqual(v, cond.ne);
  if ("gt" in cond) return typeof v === "number" && v > cond.gt;
  if ("lt" in cond) return typeof v === "number" && v < cond.lt;
  if ("contains" in cond) {
    if (typeof v === "string") return v.includes(String(cond.contains));
    if (Array.isArray(v)) return v.some((x) => isDeepStrictEqual(x, cond.contains));
    return false;
  }
  return Boolean(v);
}

// 動かす前に、形を確かめる。ひとつも動かさずに断れるものは、ここで断る。
export function validate(steps, canCall, canWait = canCall) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("steps が空");
  if (steps.length > MAX_STEPS) throw new Error(`手順は ${MAX_STEPS} まで`);
  const seen = new Set();
  steps.forEach((step, i) => {
    const id = stepId(step, i);
    if (!ID.test(id)) throw new Error(`id は英数字と _ で: ${id}`);
    if (seen.has(id)) throw new Error(`id が重なっている: ${id}`);
    seen.add(id);
    if (step.wait !== undefined) {
      if (step.tool) throw new Error(`手順 ${id}: tool と wait は同時に書けない`);
      const w = step.wait;
      if (w.tool === undefined) {
        if (!(typeof w.seconds === "number" && w.seconds > 0)) throw new Error(`手順 ${id}: wait は seconds か tool + until のどちらか`);
        return;
      }
      if (!w.until) throw new Error(`手順 ${id}: wait に tool を書くなら、until(条件)が要る`);
      const why = canWait(w.tool, w.args);
      if (why) throw new Error(`手順 ${id}: ${why}`);
      return;
    }
    if (!step.tool) throw new Error(`手順 ${id}: tool か wait のどちらかが要る`);
    const why = canCall(step.tool, step.args);
    if (why) throw new Error(`手順 ${id}: ${why}`);
  });
}

const stepId = (step, i) => step.id ?? `s${i + 1}`;

// 待っているあいだに呼び手が切れたら(signal)、すぐ起きる。
const realSleep = (ms, signal) =>
  new Promise((done) => {
    const t = setTimeout(finish, ms);
    function finish() {
      clearTimeout(t);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });

const clamp = (n, lo, hi) => Math.min(Math.max(Number(n), lo), hi);
const MAX_WAIT_SECONDS = 3600;

// wait の一手。いま引いた結果は ctx[id].result に毎回置くので、until から ${id.result} で見える。
async function waitStep(step, id, ctx, call, env, remainingMs) {
  const w = step.wait;
  const started = env.now();
  const waited = () => Math.round((env.now() - started) / 100) / 10;

  if (w.tool === undefined) {
    await env.sleep(Math.min(clamp(w.seconds, 0, MAX_WAIT_SECONDS) * 1000, remainingMs()), env.signal);
    return { wait: { satisfied: true, polls: 0, waited_seconds: waited() } };
  }

  const every = clamp(w.every ?? 5, 1, 300) * 1000;
  const deadline = started + Math.min(clamp(w.timeout ?? 30, 1, MAX_WAIT_SECONDS) * 1000, remainingMs());
  const args = resolve(w.args ?? {}, ctx);
  let polls = 0;
  let result;
  for (;;) {
    result = await call(w.tool, args);
    polls++;
    ctx[id] = { ok: true, result };
    if (check(w.until, ctx)) return { result, wait: { tool: w.tool, satisfied: true, polls, waited_seconds: waited() } };
    const left = deadline - env.now();
    const aborted = Boolean(env.signal?.aborted);
    if (left <= 0 || aborted) {
      return { result, wait: { tool: w.tool, satisfied: false, polls, waited_seconds: waited(), ...(aborted ? { aborted: true } : {}) } };
    }
    // 道具が「次は何秒あとに」と教えてくれるなら、それに従う(every より短くはしない)。
    const hint = typeof w.every_ref === "string" ? lookup(ctx, w.every_ref) : undefined;
    const gap = typeof hint === "number" && hint > 0 ? Math.max(every, Math.min(hint * 1000, 300_000)) : every;
    await env.sleep(Math.min(gap, left), env.signal);
  }
}

/**
 * @param {object[]} steps
 * @param {(tool: string, args: object) => Promise<any>} call
 * @param {{ now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal, budgetMs?: number }} [env]
 *   now / sleep は試験用に差し替えられる。budgetMs は、流れ全体で待てる合計(既定: 制限なし)。
 */
export async function runFlow(steps, call, env = {}) {
  const e = { now: env.now ?? Date.now, sleep: env.sleep ?? realSleep, signal: env.signal };
  const budgetMs = env.budgetMs ?? Number.POSITIVE_INFINITY;
  const flowStart = e.now();
  const remainingMs = () => Math.max(0, budgetMs - (e.now() - flowStart));

  const ctx = {};
  const done = [];
  let stoppedAt = null;

  for (const [i, step] of steps.entries()) {
    const id = stepId(step, i);
    const entry = step.wait !== undefined ? { id } : { id, tool: step.tool };
    if (stoppedAt) {
      done.push({ ...entry, status: "not_run" });
      continue;
    }
    try {
      if (step.when && !check(step.when, ctx)) {
        ctx[id] = { skipped: true };
        done.push({ ...entry, status: "skipped" });
        continue;
      }
      if (step.wait !== undefined) {
        const { result, wait } = await waitStep(step, id, ctx, call, e, remainingMs);
        ctx[id] = { ok: true, ...(result !== undefined ? { result } : {}), wait };
        if (!wait.satisfied && step.wait.on_timeout === "stop") {
          throw new Error(`条件が成り立たないまま、時間切れ(${wait.waited_seconds} 秒、${wait.polls} 回)`);
        }
        done.push({ ...entry, status: wait.satisfied ? "ok" : "timed_out", wait, ...(result !== undefined ? { result } : {}) });
        continue;
      }
      const result = await call(step.tool, resolve(step.args ?? {}, ctx), step);
      ctx[id] = { ok: true, result };
      done.push({ ...entry, status: "ok", result });
    } catch (err) {
      const error = String(err?.message ?? err);
      ctx[id] = { ok: false, error };
      done.push({ ...entry, status: "failed", error });
      if ((step.on_error ?? "stop") === "stop") stoppedAt = id;
    }
  }
  return { ok: !done.some((s) => s.status === "failed"), stopped_at: stoppedAt, steps: done };
}
