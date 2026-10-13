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

// ── wait(能動的に待つ)────────────────────────────────────────────────────

import { runFlow as run } from "./flow.mjs";

// 時計と眠りを差し替える。眠ると、時計がその分だけ進む。
function fakeClock() {
  let t = 0;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept, get t() { return t; } };
}
const inbox = (events) => async () => ({ events });

test("wait: 条件が成り立つまで、決めた間隔で道具を呼ぶ", async () => {
  const clock = fakeClock();
  let n = 0;
  const call = async (tool) => (tool === "poll" ? { events: ++n >= 3 ? [{ seq: 1 }] : [] } : { echoed: true });
  const out = await run(
    [{ id: "w", wait: { tool: "poll", until: { ref: "w.result.events", nonempty: true }, every: 5, timeout: 60 } }],
    call,
    clock,
  );
  assert.equal(out.ok, true);
  assert.deepEqual(clock.slept, [5000, 5000]); // 三度目で成り立つ。眠ったのは二度
  assert.deepEqual(out.steps[0].wait, { tool: "poll", satisfied: true, polls: 3, waited_seconds: 10 });
  assert.deepEqual(out.steps[0].result, { events: [{ seq: 1 }] }); // 結果は最後に引いたもの
});

test("wait: 最初から成り立っていれば、眠らない", async () => {
  const clock = fakeClock();
  const out = await run([{ id: "w", wait: { tool: "poll", until: { ref: "w.result.events", nonempty: true } } }], inbox([1]), clock);
  assert.deepEqual([clock.slept, out.steps[0].wait.polls], [[], 1]);
});

test("wait: 時間切れは失敗ではない。status は timed_out で、続きの手順は when で分けられる", async () => {
  const clock = fakeClock();
  const out = await run(
    [
      { id: "w", wait: { tool: "poll", until: { ref: "w.result.events", nonempty: true }, every: 10, timeout: 25 } },
      { id: "got", tool: "echo", when: { ref: "w.wait.satisfied" } },
      { id: "none", tool: "echo", args: { text: "来なかった" }, when: { ref: "w.wait.satisfied", eq: false } },
    ],
    async (tool, args) => (tool === "poll" ? { events: [] } : { echoed: args }),
    clock,
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.map((s) => s.status), ["timed_out", "skipped", "ok"]);
  assert.deepEqual([out.steps[0].wait.satisfied, out.steps[0].wait.waited_seconds], [false, 25]);
  assert.deepEqual(clock.slept, [10000, 10000, 5000]); // 最後は残りの 5 秒だけ眠る
});

test("wait: on_timeout が stop なら、時間切れで止まる", async () => {
  const out = await run(
    [{ id: "w", wait: { tool: "poll", until: { ref: "w.result.events", nonempty: true }, timeout: 1, on_timeout: "stop" } }, { id: "b", tool: "echo" }],
    inbox([]),
    fakeClock(),
  );
  assert.deepEqual([out.ok, out.stopped_at, out.steps.map((s) => s.status)], [false, "w", ["failed", "not_run"]]);
  assert.match(out.steps[0].error, /時間切れ/);
});

test("wait: 流れ全体の持ち時間(budget)を越えては待たない", async () => {
  const clock = fakeClock();
  const out = await run(
    [{ id: "w", wait: { tool: "poll", until: { ref: "w.result.events", nonempty: true }, every: 10, timeout: 600 } }],
    inbox([]),
    { ...clock, budgetMs: 25_000 },
  );
  assert.equal(out.steps[0].wait.waited_seconds, 25);
  assert.equal(out.steps[0].status, "timed_out");
});

test("wait: 前の手順の結果を引数に使える。毎回同じ引数で呼ぶ", async () => {
  const seen = [];
  const out = await run(
    [
      { id: "a", tool: "num", args: { n: 7 } },
      { id: "w", wait: { tool: "poll", args: { since: "${a.result.n}" }, until: { ref: "w.result.events", nonempty: true } } },
    ],
    async (tool, args) => (tool === "num" ? { n: args.n } : (seen.push(args), { events: seen.length >= 2 ? [1] : [] })),
    fakeClock(),
  );
  assert.deepEqual([out.ok, seen], [true, [{ since: 7 }, { since: 7 }]]);
});

test("wait: every_ref があれば、道具が教えてくれる間隔に従う(例: job_status の next_check_in)", async () => {
  const clock = fakeClock();
  const seq = [{ state: "running", next_check_in: 30 }, { state: "settling", next_check_in: 12 }, { state: "done", out: "PASS" }];
  let i = 0;
  const out = await run(
    [{ id: "w", wait: { tool: "job_status", args: { id: "j1" }, until: { ref: "w.result.next_check_in", exists: false }, every: 5, every_ref: "w.result.next_check_in", timeout: 120 } }],
    async () => seq[i++],
    clock,
  );
  assert.deepEqual([clock.slept, out.steps[0].wait.satisfied, out.steps[0].result.out], [[30000, 12000], true, "PASS"]);
});

test("wait: every_ref が every より短ければ every に従う。数でなければ every のまま", async () => {
  const clock = fakeClock();
  let n = 0;
  await run(
    [{ id: "w", wait: { tool: "p", until: { ref: "w.result.done" }, every: 10, every_ref: "w.result.hint", timeout: 60 } }],
    async () => (++n === 1 ? { hint: 3 } : n === 2 ? { hint: "x" } : { done: true }),
    clock,
  );
  assert.deepEqual(clock.slept, [10000, 10000]);
});

test("wait: ポモドーロが開ける(休みが終わって work になる)のを待つ", async () => {
  const clock = fakeClock();
  const phases = ["rest", "rest", "work"];
  let i = 0;
  const out = await run(
    [{ id: "w", wait: { tool: "pomodoro_get", until: { ref: "w.result.phase", eq: "work" }, every: 20, timeout: 90 } }, { id: "go", tool: "echo", when: { ref: "w.wait.satisfied" } }],
    async (tool) => (tool === "pomodoro_get" ? { phase: phases[i++], remaining_minutes: 1 } : { echoed: true }),
    clock,
  );
  assert.deepEqual([out.steps.map((s) => s.status), clock.slept], [["ok", "ok"], [20000, 20000]]);
});

test("wait: seconds だけなら、ただ待つ", async () => {
  const clock = fakeClock();
  const out = await run([{ id: "z", wait: { seconds: 20 } }, { tool: "echo" }], call, clock);
  assert.deepEqual([clock.slept, out.steps[0].wait, out.steps[0].status], [[20000], { satisfied: true, polls: 0, waited_seconds: 20 }, "ok"]);
});

test("wait: 呼び手が切れたら(abort)、そこで待つのをやめる", async () => {
  const ctl = new AbortController();
  const clock = fakeClock();
  let n = 0;
  const out = await run(
    [{ id: "w", wait: { tool: "poll", until: { ref: "w.result.events", nonempty: true }, every: 5, timeout: 600 } }],
    async () => (++n === 2 && ctl.abort(), { events: [] }),
    { ...clock, signal: ctl.signal },
  );
  assert.deepEqual([out.steps[0].status, out.steps[0].wait.aborted, n], ["timed_out", true, 2]);
});

test("wait: 道具が失敗したら、wait も失敗として扱う(on_error に従う)", async () => {
  const out = await run([{ id: "w", wait: { tool: "boom", until: { ref: "w.ok" } } }, { id: "b", tool: "echo" }], call, fakeClock());
  assert.deepEqual([out.ok, out.stopped_at, out.steps[0].error], [false, "w", "こわれた"]);
});

test("nonempty: 配列・文字列・オブジェクトが空でないか", () => {
  const ctx = { a: { list: [1], none: [], s: "x", e: "", o: { k: 1 }, z: {} } };
  const yes = (ref) => check({ ref, nonempty: true }, ctx);
  assert.deepEqual([yes("a.list"), yes("a.none"), yes("a.s"), yes("a.e"), yes("a.o"), yes("a.z"), yes("a.missing")], [true, false, true, false, true, false, false]);
  assert.equal(check({ ref: "a.none", nonempty: false }, ctx), true);
});

test("validate: wait の形を、動かす前に確かめる", () => {
  const ok = () => null;
  assert.doesNotThrow(() => validate([{ wait: { seconds: 5 } }], ok));
  assert.doesNotThrow(() => validate([{ wait: { tool: "poll", until: { ref: "x" } } }], ok));
  assert.throws(() => validate([{ tool: "a", wait: { seconds: 1 } }], ok), /同時/);
  assert.throws(() => validate([{ wait: {} }], ok), /seconds か tool/);
  assert.throws(() => validate([{ wait: { tool: "poll" } }], ok), /until/);
  assert.throws(() => validate([{ wait: { tool: "poll", until: { ref: "x" } } }], () => "呼べない"), /呼べない/);
  assert.throws(() => validate([{ wait: { seconds: -1 } }], ok), /seconds か tool/);
});
