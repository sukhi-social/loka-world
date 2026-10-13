import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { catalog } from "./catalog.mjs";

const registry = new Map([
  ["task_add", { description: "やることを足す。期日は任意。\n二行目。", schema: z.object({ content: z.string().describe("中身"), due: z.string().optional() }) }],
  ["task_list", { description: "やることの一覧。", schema: z.object({}) }],
  ["pomodoro_get", { description: "ポモドーロの今を見る。", schema: z.object({}) }],
  ["sukhi_post", { description: "sukhi に投稿する。", schema: z.object({ text: z.string() }) }],
  ["sukhi_inbox", { description: "控えを読む。", schema: z.object({}) }],
  ["run_mruby_shell", { description: "シェルでファイルを触る。", schema: z.object({ code: z.string() }) }],
]);

test("一覧は、見える名前ごと。ファミリーは動作を持ち、ファミリーに入らない道具はそのまま", () => {
  const list = catalog(registry);
  assert.deepEqual(list.map((t) => t.name), ["pomodoro", "sukhi", "task", "run_mruby_shell"]);
  const sukhi = list.find((t) => t.name === "sukhi");
  assert.deepEqual(sukhi.levels, [1, 5]);
  assert.deepEqual(sukhi.do, ["inbox", "post"]);
  assert.match(sukhi.summary, /sukhi/);
  const shell = list.find((t) => t.name === "run_mruby_shell");
  assert.deepEqual(shell, { name: "run_mruby_shell", levels: [2], summary: "シェルでファイルを触る。" });
});

test("level と q で絞れる(q は名前・動作・説明を見る)", () => {
  assert.deepEqual(catalog(registry, { level: 5 }).map((t) => t.name), ["sukhi"]);
  assert.deepEqual(catalog(registry, { q: "ポモドーロ" }).map((t) => t.name), ["pomodoro"]);
  assert.deepEqual(catalog(registry, { q: "ADD" }).map((t) => t.name), ["task"]);
});

test("ファミリーの name だけで、動作の一覧(段つき)。level で絞れる", () => {
  const one = catalog(registry, { name: "sukhi" });
  assert.deepEqual(one.do, [
    { do: "inbox", level: 1, summary: "控えを読む。" },
    { do: "post", level: 5, summary: "sukhi に投稿する。" },
  ]);
  assert.deepEqual(catalog(registry, { name: "sukhi", level: 5 }).do.map((o) => o.do), ["post"]);
});

test("name と do で、説明まるごとと、引数の JSON Schema が返る", () => {
  const one = catalog(registry, { name: "task", do: "add" });
  assert.equal(one.description, "やることを足す。期日は任意。\n二行目。");
  assert.equal(one.input.type, "object");
  assert.deepEqual(one.input.required, ["content"]);
  assert.equal(one.input.properties.content.description, "中身");
  assert.match(one.call, /tool: "task", args: \{ do: "add"/);
});

test("ファミリーに入らない道具は、name だけで説明と引数の形", () => {
  const one = catalog(registry, { name: "run_mruby_shell" });
  assert.equal(one.level, 2);
  assert.deepEqual(one.input.required, ["code"]);
});

test("知らない名前・動作は、知らないと言う。古い呼び名は、いまの呼びかたを教える", () => {
  assert.throws(() => catalog(registry, { name: "nothing" }), /知らない道具/);
  assert.throws(() => catalog(registry, { name: "task", do: "nothing" }), /あるのは/);
  assert.throws(() => catalog(registry, { name: "task_add" }), /tool: "task"/);
});
