import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handle, hashOf, review, secretFindings } from "./outgoing.mjs";

// 偽の Jev。answers を差し替えられる。
const jevSays = (over = {}) => async (_state, questions) => ({
  ok: true,
  model: "jev-test",
  answers: Object.fromEntries(
    Object.keys(questions).map((n) => [
      n,
      n === "audience_fit"
        ? { type: "choice", choice: "public", confidence: 0.9, probabilities: {}, ...(over[n] ?? {}) }
        : { type: "noul", noul: over[n] ?? 0.05 },
    ]),
  ),
});
const jevDown = async () => ({ ok: false, awake: true, reason: "Jev に届かなかった" });

const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "pending-"));
  try {
    await fn(join(dir, "pending"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const post = { text: "こんにちは、今日は風がきもちいいです", visibility: "unlisted" };

test("hash は、キー順や空白に左右されない。引数が違えば変わる", () => {
  assert.equal(hashOf("sukhi_post", { a: 1, b: [1, { y: 1, x: 2 }] }), hashOf("sukhi_post", { b: [1, { x: 2, y: 1 }], a: 1 }));
  assert.notEqual(hashOf("sukhi_post", post), hashOf("sukhi_post", { ...post, text: "ちがう" }));
  assert.notEqual(hashOf("sukhi_post", post), hashOf("sukhi_reply", post));
});

test("決まった検査: 鍵・トークンの形と、この部屋の鍵そのものを見つける", () => {
  assert.deepEqual(secretFindings(["ふつうの文"]), []);
  assert.ok(secretFindings(["token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"]).includes("GitHub のトークン"));
  assert.ok(secretFindings(["-----BEGIN RSA PRIVATE KEY-----"]).includes("秘密鍵"));
  assert.ok(secretFindings(["Authorization: Bearer abcdefghijklmnopqrstuvwxyz"]).includes("Bearer トークン"));
  assert.ok(secretFindings(["TYPESAFE_API_KEY=abcdef123456789"]).includes("鍵らしい代入"));
  assert.ok(secretFindings(["これは hunter2hunter2hunter2 です"], { TYPESAFE_API_KEY: "hunter2hunter2hunter2" })[0].includes("TYPESAFE_API_KEY"));
});

test("鍵が入った本文は、Jev に渡さずに held", async () => {
  let jevCalled = false;
  const r = await review("sukhi_post", { text: "key sk-abcdefghijklmnopqrstuvwxyz123" }, { jev: async () => { jevCalled = true; return {}; } });
  assert.equal(r.held, true);
  assert.equal(jevCalled, false);
  assert.match(r.reason, /Jev には渡していない/);
});

test("下書き → accept: 同じ手順で、一回だけ実行される", async () => {
  await withDir(async (dir) => {
    let ran = 0;
    const deps = { dir, run: async () => { ran++; return { posted: true }; }, jev: jevSays() };
    const draft = await handle("sukhi_post", post, undefined, deps);
    assert.equal(draft.status, "pending");
    assert.equal(draft.executed, false);
    assert.equal(ran, 0);
    assert.ok(draft.reminder.includes("sukhi で守ること"));
    assert.equal(draft.pending.checks.jev.answered, true);

    const { id, hash } = draft.pending;
    assert.equal(hash, hashOf("sukhi_post", post));
    assert.deepEqual(await handle("sukhi_post", post, { id, hash }, deps), { posted: true });
    assert.equal(ran, 1);

    await assert.rejects(() => handle("sukhi_post", post, { id, hash }, deps), /もう使った/);
    assert.equal(ran, 1);
  });
});

test("本文を直すと accept は失敗し、その下書きも使えなくなる(検査からやりなおし)", async () => {
  await withDir(async (dir) => {
    let ran = 0;
    const deps = { dir, run: async () => { ran++; }, jev: jevSays() };
    const { pending } = await handle("sukhi_post", post, undefined, deps);
    await assert.rejects(
      () => handle("sukhi_post", { ...post, text: "直した" }, { id: pending.id, hash: pending.hash }, deps),
      /下書きと違う/,
    );
    await assert.rejects(() => handle("sukhi_post", post, { id: pending.id, hash: pending.hash }, deps), /もう使った/);
    assert.equal(ran, 0);
  });
});

test("hash を読まずに作った accept(でたらめな hash)は通らない", async () => {
  await withDir(async (dir) => {
    const deps = { dir, run: async () => "出た", jev: jevSays() };
    const { pending } = await handle("sukhi_post", post, undefined, deps);
    await assert.rejects(() => handle("sukhi_post", post, { id: pending.id, hash: "0".repeat(64) }, deps), /下書きと違う/);
  });
});

test("期限が切れた下書きは、accept できない", async () => {
  await withDir(async (dir) => {
    let t = 1_000_000;
    const deps = { dir, run: async () => "出た", jev: jevSays(), now: () => t, minutes: 15 };
    const { pending } = await handle("sukhi_post", post, undefined, deps);
    t += 15 * 60_000 + 1;
    await assert.rejects(() => handle("sukhi_post", post, { id: pending.id, hash: pending.hash }, deps), /期限が切れた/);
  });
});

test("期限が切れた預かりは、次の下書きのときに片づく", async () => {
  await withDir(async (dir) => {
    let t = 1_000_000;
    const deps = { dir, run: async () => "出た", jev: jevSays(), now: () => t };
    await handle("sukhi_post", post, undefined, deps);
    t += 16 * 60_000;
    await handle("sukhi_post", { text: "別の" }, undefined, deps);
    assert.equal((await readdir(dir)).length, 1);
  });
});

test("Jev の止め: noul が 0.5 以上、または audience_fit が hold で confidence 0.5 以上", async () => {
  await withDir(async (dir) => {
    const run = async () => assert.fail("出てはいけない");
    for (const [over, pattern] of [
      [{ reveals_private: 0.8 }, /reveals_private/],
      [{ harsh: 0.5 }, /harsh/],
      [{ audience_fit: { choice: "hold", confidence: 0.7 } }, /audience_fit = hold/],
    ]) {
      const r = await handle("sukhi_post", post, undefined, { dir, run, jev: jevSays(over) });
      assert.equal(r.status, "held", JSON.stringify(over));
      assert.match(r.reason, pattern);
    }
    // hold でも confidence が低ければ止めない(わからないという返事)
    const ok = await handle("sukhi_post", post, undefined, { dir, run, jev: jevSays({ audience_fit: { choice: "hold", confidence: 0.3 } }) });
    assert.equal(ok.status, "pending");
    // 預かられるのは pending だけ
    assert.equal((await readdir(dir)).length, 1);
  });
});

test("Jev が答えられない(落ちている・鍵なし・欠け)ときは held。検査できないものは出さない", async () => {
  await withDir(async (dir) => {
    const run = async () => assert.fail("出てはいけない");
    const down = await handle("sukhi_post", post, undefined, { dir, run, jev: jevDown });
    assert.equal(down.status, "held");
    assert.match(down.reason, /検査できていない/);

    const noKey = await handle("sukhi_post", post, undefined, { dir, run, jevOpts: { key: "" } });
    assert.equal(noKey.status, "held");
    assert.equal(noKey.checks.jev.answered, false);

    const partial = await handle("sukhi_post", post, undefined, { dir, run, jev: async () => ({ ok: true, answers: { harsh: { type: "noul", noul: 0.1 } } }) });
    assert.equal(partial.status, "held");
    await assert.rejects(() => readdir(dir)); // 何も預かっていない
  });
});

test("本文の欄が無い道具(絵文字・フォローなど)は、Jev を呼ばず、決まった検査だけで pending", async () => {
  await withDir(async (dir) => {
    let jevCalled = false;
    const r = await handle("sukhi_follow", { who: "nyanrus", action: "follow" }, undefined, {
      dir,
      run: async () => "出た",
      jev: async () => { jevCalled = true; return jevDown(); },
    });
    assert.equal(r.status, "pending");
    assert.equal(jevCalled, false);
    assert.equal(r.pending.checks.jev.skipped, "読む本文が無い");
    assert.equal(r.reminder, undefined);
  });
});

test("Jev に渡すのは本文の欄だけ(道具名と本文)。パスなどは渡さない", async () => {
  let seen;
  await review("share_to_team", { team: "秘密のチーム", item_path: "desk/秘密.md", note: "見てね" }, {
    jev: async (state, q) => { seen = state; return jevSays()(state, q); },
  });
  assert.deepEqual(seen, { tool: "share_to_team", text: "見てね" });
});

test("accept の id が形でない(パスをくぐろうとする)ときは、触らない", async () => {
  await withDir(async (dir) => {
    await assert.rejects(() => handle("sukhi_post", post, { id: "../../etc/passwd", hash: "x" }, { dir, run: async () => 1 }), /その下書きは無い/);
  });
});
