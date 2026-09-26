// 部屋(机・書庫・成果・shared_drive・日記)は ruby/room.rb が持つ。
// ここは、その声を道具に通すだけの細い橋。
//
// 部屋はアカウントごとに分かれている(ruby/room.rb が account を見る)。
// チーム・グループの記録は state/registry.json に一つ。

import { join } from "node:path";

import { ownerAccount } from "./auth.mjs";
import { STATE_DIR } from "./paths.mjs";
import { runRuby } from "./ruby.mjs";

export const room = (args, input, account = ownerAccount()) =>
  runRuby("room.rb", args, input, {
    WORLD_ACCOUNT: account,
    WORLD_REGISTRY: join(STATE_DIR, "registry.json"),
  });
