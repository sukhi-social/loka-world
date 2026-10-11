import assert from "node:assert/strict";
import test from "node:test";

import { check, resolve, runFlow, validate } from "./flow.mjs";

// 偽の道具。echo は引数を返し、boom は失敗する。
const call = async (tool, args) => {
  if (tool === "boom") throw new Error("こわれた");
  if (tool === "num") return { n: args.n };
  return { echoed: args };
};

test("結果を次の手順に渡す(まるごと ${} は型を保つ)", async () => {
  const out = await runFlow(
    [
      { id: "a", tool: "num", args: { n: 7 } },
      { id: "b", tool: "echo", args: { n: "${a.result.n}", text: "n は ${a.result.n}" } },
    ],
    call,
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps[1].result.echoed, { n: 7, text: "n は 7" });
});

test("失敗したら、既定ではそこで止まる", async () => {
  const out = await runFlow([{ id: "a", tool: "boom" }, { id: "b", tool: "echo" }], call);
  assert.equal(out.ok, false);
  assert.equal(out.stopped_at, "a");
  assert.deepEqual(out.steps.map((s) => s.status), ["failed", "not_run"]);
  assert.equal(out.steps[0].error, "こわれた");
});

test("continue なら失敗を記録して先へ、when で受けて別の手に進める", async () => {
  const out = await runFlow(
    [
      { id: "a", tool: "boom", on_error: "continue" },
      { id: "yes", tool: "echo", when: { ref: "a.ok" } },
      { id: "no", tool: "echo", args: { why: "${a.error}" }, when: { ref: "a.ok", eq: false } },
    ],
    call,
  );
  assert.deepEqual(out.steps.map((s) => s.status), ["failed", "skipped", "ok"]);
  assert.equal(out.steps[2].result.echoed.why, "こわれた");
  assert.equal(out.ok, false);
  assert.equal(out.stopped_at, null);
});

test("飛ばした手順の結果は、参照すると失敗する(あると思い込まない)", async () => {
  const out = await runFlow(
    [
      { id: "a", tool: "echo", when: { ref: "nothing", exists: true } },
      { id: "b", tool: "echo", args: { x: "${a.result}" } },
    ],
    call,
  );
  assert.deepEqual(out.steps.map((s) => s.status), ["skipped", "failed"]);
  assert.match(out.steps[1].error, /参照が見つからない: a.result/);
});

test("条件: 比べる・組み合わせる", () => {
  const ctx = { a: { ok: true, result: { n: 5, tags: ["x", "y"], s: "hello" } } };
  assert.equal(check({ ref: "a.result.n", gt: 3 }, ctx), true);
  assert.equal(check({ ref: "a.result.n", lt: 3 }, ctx), false);
  assert.equal(check({ ref: "a.result.tags", contains: "y" }, ctx), true);
  assert.equal(check({ ref: "a.result.s", contains: "ell" }, ctx), true);
  assert.equal(check({ all: [{ ref: "a.ok" }, { not: { ref: "a.result.n", eq: 4 } }] }, ctx), true);
  assert.equal(check({ any: [{ ref: "a.nope" }, { ref: "a.result.n", ne: 5 }] }, ctx), false);
  assert.throws(() => check({ eq: 1 }, ctx), /ref/);
});

test("参照は、持っている名前だけを辿る", () => {
  assert.throws(() => resolve("${a.__proto__}", { a: {} }), /参照が見つからない/);
  assert.throws(() => resolve("${a.constructor}", { a: {} }), /参照が見つからない/);
});

test("動かす前の確かめ: 空・多すぎ・id の重なり・呼べない道具", () => {
  const can = (t) => (t === "no" ? "それは呼べない" : null);
  assert.throws(() => validate([], can), /空/);
  assert.throws(() => validate(Array.from({ length: 21 }, () => ({ tool: "x" })), can), /20/);
  assert.throws(() => validate([{ id: "a", tool: "x" }, { id: "a", tool: "x" }], can), /重なって/);
  assert.throws(() => validate([{ tool: "x" }, { id: "s1", tool: "x" }], can), /重なって/);
  assert.throws(() => validate([{ id: "bad id", tool: "x" }], can), /id は/);
  assert.throws(() => validate([{ tool: "no" }], can), /呼べない/);
  validate([{ tool: "x" }], can);
});
