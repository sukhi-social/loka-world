import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// server.mjs から import で辿れる自前のファイルが、ぜんぶ Dockerfile の COPY にあるか。
// 漏れると、本番の箱で起動できない(ローカルでは、ファイルがあるので気づけない)。
const imports = (file) =>
  [...readFileSync(file, "utf-8").matchAll(/from "\.\/([\w-]+\.mjs)"|import\("\.\/([\w-]+\.mjs)"\)|import "\.\/([\w-]+\.mjs)"/g)].flatMap((m) =>
    m.slice(1).filter(Boolean),
  );

test("server.mjs から辿れる .mjs は、すべて Dockerfile の COPY にある", () => {
  const copyLine = readFileSync("Dockerfile", "utf-8")
    .split("\n")
    .find((l) => l.startsWith("COPY server.mjs"));
  assert.ok(copyLine, "COPY server.mjs … の行が見つからない");
  const copied = new Set(copyLine.match(/[\w-]+\.mjs/g));

  const reached = new Set(["server.mjs"]);
  for (const file of reached) for (const dep of imports(file)) reached.add(dep);

  const missing = [...reached].filter((f) => !copied.has(f)).sort();
  assert.deepEqual(missing, [], `Dockerfile の COPY に無い: ${missing.join(", ")}`);
});
