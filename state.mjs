// 時刻と集中とタスクは ruby/state.rb が持つ。細い橋。
//
// 集中・タスク・リズムは、アカウントごとに分ける(部屋と同じ持ち主)。
// state/users/<account>/ の下だけを見る。認可の記録(state/直下)は、ここでは触らない。

import { join } from "node:path";

import { ownerAccount } from "./auth.mjs";
import { STATE_DIR } from "./paths.mjs";
import { runRuby } from "./ruby.mjs";

export const state = (args, input, account = ownerAccount()) =>
  runRuby("state.rb", args, input, {
    WORLD_ACCOUNT: account,
    WORLD_STATE: join(STATE_DIR, "users", account),
  });
