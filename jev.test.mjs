import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { BODY_QUESTIONS, buildBody, karadaniKiku } from "./body.mjs";
import { call } from "./jev.mjs";

// 偽の Jev。受けた body を覚え、ふりだしに応じた返事をする。
const fakeJev = async (handler) => {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ auth: req.headers.authorization, body });
      const out = handler(seen.length, body);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1/systemone`, close: () => server.close() };
};

const answersFor = (body) => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(
    Object.entries(body.questions).map(([n, q]) => [
      n,
      q.type === "noul"
        ? { type: "noul", noul: 0.9 }
        : q.type === "choice"
          ? { type: "choice", choice: "yasumu", confidence: 0.8, probabilities: { yasumu: 0.8 } }
          : { type: "score", score: 2.6, confidence: 0.7, legend: { 2: "つかれている" }, probabilities: {} },
    ]),
  ),
});

const context = {
  current_time: { local: "2026-10-13 12:42" },
  focus_status: { focusing: true, task: "秘密の題目", minutes: 25 },
  pomodoro: { phase: "work", round: 3, remaining_minutes: 10 },
  todos: [{ id: 1, content: "秘密のタスク" }],
};

test("鍵が無ければ呼ばず、「体はまだ起きていない」。例外にしない", async () => {
  let called = false;
  const r = await call("x", {}, { key: "", fetch: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.ok, false);
  assert.equal(r.awake, false);
  assert.match(r.reason, /起きていない/);
});

test("鍵あり: Bearer・model・state・questions を POST して、answers が返る(偽の Jev)", async () => {
  const jev = await fakeJev((_n, body) => ({ json: answersFor(body) }));
  try {
    const r = await call({ a: 1 }, { shuchu_kireta: BODY_QUESTIONS.shuchu_kireta }, { key: "k-test", url: jev.url });
    assert.equal(r.ok, true);
    assert.equal(r.answers.shuchu_kireta.noul, 0.9);
    assert.equal(jev.seen[0].auth, "Bearer k-test");
    assert.equal(jev.seen[0].body.model, "jev-latest");
    assert.deepEqual(jev.seen[0].body.state, { a: 1 });
  } finally {
    jev.close();
  }
});

test("版を固定できる(model を渡す)", async () => {
  const jev = await fakeJev((_n, body) => ({ json: answersFor(body) }));
  try {
    await call("s", {}, { key: "k", url: jev.url, model: "jev-1.13.0" });
    assert.equal(jev.seen[0].body.model, "jev-1.13.0");
  } finally {
    jev.close();
  }
});

test("落ちている(5xx)ときは 1 回だけやりなおす。2 回目で通ればそれでよい", async () => {
  const jev = await fakeJev((n, body) => (n === 1 ? { status: 503 } : { json: answersFor(body) }));
  try {
    const r = await call("s", {}, { key: "k", url: jev.url });
    assert.equal(r.ok, true);
    assert.equal(jev.seen.length, 2);
  } finally {
    jev.close();
  }
});

test("鍵が違う(401)ときは、やりなおさない", async () => {
  const jev = await fakeJev(() => ({ status: 401 }));
  try {
    const r = await call("s", {}, { key: "bad", url: jev.url });
    assert.equal(r.ok, false);
    assert.equal(r.awake, true);
    assert.match(r.reason, /401/);
    assert.equal(jev.seen.length, 1);
  } finally {
    jev.close();
  }
});

test("間に合わないときは、間に合わなかったと言う", async () => {
  const slow = async (_u, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const r = await call("s", {}, { key: "k", fetch: slow, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /間に合わなかった/);
});

test("body には、集中の題目もタスクの中身も入らない。数と、つぶやきだけ", () => {
  const body = buildBody(context, "ちょっと眠い");
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /秘密/);
  assert.equal(body.open_tasks, 1);
  assert.equal(body.pomodoro.phase, "work");
  assert.equal(body.tsubuyaki, "ちょっと眠い");
  assert.equal("tsubuyaki" in buildBody(context), false);
});

test("体に聞く: 型どおりに答えが返る。Jev に渡す state に秘密が出ていない(偽の Jev)", async () => {
  const jev = await fakeJev((_n, body) => ({ json: answersFor(body) }));
  try {
    const r = await karadaniKiku({ ask: ["kizukare", "shuchu_kireta", "ima_no_heya"], tsubuyaki: "ふう", context }, { key: "k", url: jev.url });
    assert.equal(r.awake, true);
    assert.deepEqual(r.answers.shuchu_kireta, { noul: 0.9 });
    assert.equal(r.answers.ima_no_heya.choice, "yasumu");
    assert.equal(r.answers.kizukare.score, 2.6);
    assert.equal(r.answers.kizukare.confidence, 0.7);
    assert.deepEqual(Object.keys(jev.seen[0].body.questions), ["kizukare", "shuchu_kireta", "ima_no_heya"]);
    assert.doesNotMatch(JSON.stringify(jev.seen[0].body.state), /秘密/);
  } finally {
    jev.close();
  }
});

test("鍵なし・落ちている・形がおかしいとき、全部「わからない」(confidence 0)。取り繕わない", async () => {
  const noKey = await karadaniKiku({ ask: ["kizukare"], context }, { key: "" });
  assert.equal(noKey.awake, false);
  assert.deepEqual(noKey.answers.kizukare, { unknown: true, confidence: 0 });

  const down = await karadaniKiku({ ask: ["kizukare", "kurikaeshi"], context }, { key: "k", fetch: async () => ({ ok: false, status: 500 }) });
  assert.equal(down.awake, true);
  assert.equal(down.answers.kurikaeshi.confidence, 0);

  const odd = await karadaniKiku({ ask: ["kizukare"], context }, { key: "k", fetch: async () => ({ ok: true, json: async () => ({ answers: { kizukare: { type: "noul" } } }) }) });
  assert.deepEqual(odd.answers.kizukare, { unknown: true, confidence: 0 });
});

test("知らない問いは、知らないと言う", async () => {
  await assert.rejects(() => karadaniKiku({ ask: ["nothing"], context }), /知らない問い/);
});
