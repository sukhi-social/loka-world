// アカウントごとの好み。いまは「読み取り専用と申告する(確認を省く)道具」だけ。
//
// loka.f3liz.casa の設定ページから選ぶ。state/settings.json に一つ。
//   { "kuro43_": { "readonly": ["log_timestamp", "write_file"] }, ... }
//
// これは申告であって、鍵ではない。印をつけた道具は、readOnlyHint を尊重する
// クライアントで、確認なしに走るようになる。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.mjs";

const FILE = join(STATE_DIR, "settings.json");

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    store = {};
  }
  return store;
}

function save() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function readonlyTools(account) {
  const list = load()[String(account)]?.readonly;
  return Array.isArray(list) ? list : [];
}

export function setReadonlyTools(account, list) {
  const s = load();
  const key = String(account);
  const readonly = [...new Set(list.map(String))];
  s[key] = { ...(s[key] ?? {}), readonly };
  save();
  return readonly;
}
