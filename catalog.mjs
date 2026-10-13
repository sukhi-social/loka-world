// 道具の目録。registry(内部の名前 op → 説明 + zod)と LEVELS(段)から、そのつど作る。
// 新しい道具は reg() に足すだけで、ここには現れる。
//
// 見える名前は、ファミリー(sukhi・task など)と、ファミリーに入らない道具(run_flow など)。
//   loka_tools()                       … 全部の一覧 { name, levels, summary, do? }
//   loka_tools({ name: "sukhi" })      … ファミリーの動作の一覧 { do, level, summary }
//   loka_tools({ name: "sukhi", do })  … その動作のくわしい説明と、引数の形(JSON Schema)
//   loka_tools({ name: "run_flow" })   … ファミリーに入らない道具の、くわしい説明と引数の形

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { FAMILIES, LEVEL_LABEL, LEVELS, resolveTool, toolOf, verbsOf } from "./tools.mjs";

// 説明の最初の一文(一覧のための短い要約)。
const summaryOf = (description = "") => {
  const first = description.split("\n")[0];
  const end = first.search(/[。]/);
  const sentence = end === -1 ? first : first.slice(0, end + 1);
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
};

const levelOf = (op) => LEVELS[op] ?? 1;
const detailOf = (registry, op, extra = {}) => ({
  ...extra,
  level: levelOf(op),
  label: LEVEL_LABEL[levelOf(op)],
  description: registry.get(op).description,
  input: zodToJsonSchema(registry.get(op).schema, { $refStrategy: "none" }),
});

// registry: Map<op, { description, schema(z.object) }>
export const catalog = (registry, { name, do: verb, level, q } = {}) => {
  if (name !== undefined) {
    if (name in FAMILIES) {
      const verbs = verbsOf(name).filter((v) => registry.has(`${name}_${v}`));
      if (verb === undefined) {
        return {
          name,
          summary: FAMILIES[name],
          do: verbs
            .map((v) => ({ do: v, level: levelOf(`${name}_${v}`), summary: summaryOf(registry.get(`${name}_${v}`).description) }))
            .filter((o) => level === undefined || o.level === level),
          call: `tool: "${name}", args: { do: "<動作>", … }`,
        };
      }
      const r = resolveTool(name, { do: verb });
      if (r.error) throw new Error(r.error);
      return detailOf(registry, r.op, { name, do: verb, call: `tool: "${name}", args: { do: "${verb}", … }(input の項目を並べる)` });
    }
    const r = resolveTool(name, {});
    if (r.error) throw new Error(r.error);
    if (!registry.has(r.op)) throw new Error(`知らない道具: ${name}`);
    return detailOf(registry, r.op, { name });
  }

  // 一覧: 見える名前ごとに、まとめる。
  const groups = new Map();
  for (const [op, tool] of registry) {
    const { tool: shown, do: v } = toolOf(op);
    if (!groups.has(shown)) groups.set(shown, []);
    groups.get(shown).push({ op, verb: v, level: levelOf(op), description: tool.description });
  }
  const needle = q?.toLowerCase();
  return [...groups.entries()]
    .map(([shown, ops]) => {
      const family = shown in FAMILIES;
      const summary = family ? FAMILIES[shown] : summaryOf(ops[0].description);
      const levels = [...new Set(ops.map((o) => o.level))].sort((a, b) => a - b);
      return { shown, family, summary, levels, ops };
    })
    .filter((t) => level === undefined || t.levels.includes(level))
    .filter(
      (t) =>
        !needle ||
        t.shown.toLowerCase().includes(needle) ||
        t.summary.toLowerCase().includes(needle) ||
        t.ops.some((o) => o.op.toLowerCase().includes(needle) || o.description.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.levels[0] - b.levels[0] || a.shown.localeCompare(b.shown))
    .map((t) => ({
      name: t.shown,
      levels: t.levels,
      summary: t.summary,
      ...(t.family ? { do: t.ops.map((o) => o.verb).sort() } : {}),
    }));
};

export const catalogInput = {
  name: z.string().optional().describe("ファミリー(sukhi など)なら動作の一覧。ファミリーに入らない道具なら、くわしい説明と引数の形(JSON Schema)。"),
  do: z.string().optional().describe("name がファミリーのとき、その動作のくわしい説明と引数の形を見る。"),
  level: z.number().int().min(1).max(7).optional().describe("この段(1〜7)の動作を持つ道具だけ一覧する。"),
  q: z.string().optional().describe("名前か説明に、この言葉を含む道具だけ一覧する。"),
};
