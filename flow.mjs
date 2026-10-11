// run_flow の中身。道具の名前と引数を並べた流れを、上から順に動かす。
//
//   steps: [{ id?, tool, args?, when?, on_error? }]
//
//   id        手順の名前。あとの手順から ${id.result.xxx} / ${id.ok} / ${id.error} で結果を使える。
//   when      条件。合わなければ、その手順は飛ばす。
//               { ref: "a.ok" }                       … 値が真なら
//               { ref: "a.result.n", eq|ne|gt|lt|contains: 値 } / { ref: "a.result", exists: true }
//               { all: [...] } / { any: [...] } / { not: {...} }
//   on_error  "stop"(既定: そこで止まる)か "continue"(失敗を記録して先へ。次の when で受ける)。
//
// 道具を呼ぶ部分(call)は外から渡す。ここは順番と条件だけを知っている。

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

export function check(cond, ctx) {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) throw new Error("when は { ... } の形で");
  if ("all" in cond) return cond.all.every((c) => check(c, ctx));
  if ("any" in cond) return cond.any.some((c) => check(c, ctx));
  if ("not" in cond) return !check(cond.not, ctx);
  if (typeof cond.ref !== "string") throw new Error("when には ref(参照)か all / any / not が要る");

  const v = lookup(ctx, cond.ref);
  if ("exists" in cond) return (v !== undefined) === Boolean(cond.exists);
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
export function validate(steps, canCall) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("steps が空");
  if (steps.length > MAX_STEPS) throw new Error(`手順は ${MAX_STEPS} まで`);
  const seen = new Set();
  steps.forEach((step, i) => {
    const id = stepId(step, i);
    if (!ID.test(id)) throw new Error(`id は英数字と _ で: ${id}`);
    if (seen.has(id)) throw new Error(`id が重なっている: ${id}`);
    seen.add(id);
    const why = canCall(step.tool);
    if (why) throw new Error(`手順 ${id}: ${why}`);
  });
}

const stepId = (step, i) => step.id ?? `s${i + 1}`;

export async function runFlow(steps, call) {
  const ctx = {};
  const done = [];
  let stoppedAt = null;

  for (const [i, step] of steps.entries()) {
    const id = stepId(step, i);
    const entry = { id, tool: step.tool };
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
      const result = await call(step.tool, resolve(step.args ?? {}, ctx));
      ctx[id] = { ok: true, result };
      done.push({ ...entry, status: "ok", result });
    } catch (e) {
      const error = String(e?.message ?? e);
      ctx[id] = { ok: false, error };
      done.push({ ...entry, status: "failed", error });
      if ((step.on_error ?? "stop") === "stop") stoppedAt = id;
    }
  }
  return { ok: !done.some((s) => s.status === "failed"), stopped_at: stoppedAt, steps: done };
}
