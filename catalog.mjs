// 道具の目録。registry(名前 → 説明 + zod)と LEVELS(段)から、そのつど作る。
// 新しい道具は reg() に足すだけで、ここには現れる。

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { LEVEL_LABEL, LEVELS } from "./tools.mjs";

// 説明の最初の一文(一覧のための短い要約)。
const summaryOf = (description = "") => {
  const first = description.split("\n")[0];
  const end = first.search(/[。]/);
  const sentence = end === -1 ? first : first.slice(0, end + 1);
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
};

// registry: Map<name, { description, schema(z.object) }>
export const catalog = (registry, { name, level, q } = {}) => {
  if (name !== undefined) {
    const tool = registry.get(name);
    if (!tool) throw new Error(`知らない道具: ${name}`);
    const lv = LEVELS[name] ?? 1;
    return {
      name,
      level: lv,
      label: LEVEL_LABEL[lv],
      description: tool.description,
      input: zodToJsonSchema(tool.schema, { $refStrategy: "none" }),
    };
  }
  const needle = q?.toLowerCase();
  return [...registry.entries()]
    .map(([n, t]) => ({ name: n, level: LEVELS[n] ?? 1, summary: summaryOf(t.description), description: t.description }))
    .filter((t) => level === undefined || t.level === level)
    .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
    .map(({ name: n, level: l, summary }) => ({ name: n, level: l, summary }));
};

export const catalogInput = {
  name: z.string().optional().describe("この道具のくわしい説明と、引数の形(JSON Schema)を見る。"),
  level: z.number().int().min(1).max(7).optional().describe("この段(1〜7)の道具だけ一覧する。"),
  q: z.string().optional().describe("名前か説明に、この言葉を含む道具だけ一覧する。"),
};
