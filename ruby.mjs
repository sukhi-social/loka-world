// Ruby の声を聞く、共通の耳。
//
// どの ruby スクリプトも、いつも JSON を一つ返す。失敗も {"error": "..."}。
// 引数は --key value。本文は stdin から渡す(長くても、引用符に怯えなくていい)。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function runRuby(script, args = [], input, extraEnv) {
  const file = join(HERE, "ruby", script);
  const pathEnv = process.env.PATH ? `/opt/homebrew/bin:${process.env.PATH}` : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  return new Promise((resolve, reject) => {
    const child = spawn("ruby", [file, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: pathEnv,
        ...(extraEnv ?? {}),
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new Error(`${script} の返しが読み取れません(exit ${code}): ${out || err}`));
      }
      if (parsed?.error) return reject(new Error(parsed.error));
      if (code !== 0) return reject(new Error(err || `${script} が exit ${code}`));
      resolve(parsed);
    });
    child.stdin.end(input ?? "");
  });
}
