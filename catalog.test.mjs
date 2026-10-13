import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { catalog } from "./catalog.mjs";
import { LEVELS } from "./tools.mjs";

const registry = new Map([
  ["add_task", { description: "やることを足す。期日は任意。\n二行目。", schema: z.object({ content: z.string().describe("中身"), due: z.string().optional() }) }],
  ["get_pomodoro", { description: "ポモドーロの今を見る。", schema: z.object({}) }],
  ["sukhi_post", { description: "sukhi に投稿する。", schema: z.object({ text: z.string() }) }],
]);

test("一覧は、段・名前の順で { name, level, summary }。要約は説明の最初の一文", () => {
  const list = catalog(registry);
  assert.deepEqual(list.map((t) => t.name), ["get_pomodoro", "add_task", "sukhi_post"]);
  assert.deepEqual(list[1], { name: "add_task", level: LEVELS.add_task, summary: "やることを足す。" });
});

test("level と q で絞れる(q は名前も説明も見る)", () => {
  assert.deepEqual(catalog(registry, { level: 5 }).map((t) => t.name), ["sukhi_post"]);
  assert.deepEqual(catalog(registry, { q: "ポモドーロ" }).map((t) => t.name), ["get_pomodoro"]);
  assert.deepEqual(catalog(registry, { q: "ADD_" }).map((t) => t.name), ["add_task"]);
});

test("name を渡すと、説明まるごとと、引数の JSON Schema が返る", () => {
  const one = catalog(registry, { name: "add_task" });
  assert.equal(one.description, "やることを足す。期日は任意。\n二行目。");
  assert.equal(one.input.type, "object");
  assert.deepEqual(one.input.required, ["content"]);
  assert.equal(one.input.properties.content.description, "中身");
});

test("知らない名前は、知らないと言う", () => {
  assert.throws(() => catalog(registry, { name: "nothing" }), /知らない道具/);
});
