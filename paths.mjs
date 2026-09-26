// どこに何が住むか。ローカルでも box でも、同じ形。
//
//   WORLD_DATA(既定: $HOME/.shiro/world、container では /data)
//     ├ room/    部屋と日記(見せる物と、見せない物)
//     └ state/   認可の記録・cookie の種(auth.json)
//
// Docker では WORLD_DATA=/data にして、ソースツリーの外に永続化する。

import { homedir } from "node:os";
import { join } from "node:path";

export const DATA = process.env.WORLD_DATA ?? join(homedir(), ".shiro", "world");
export const ROOM_ROOT = process.env.ROOM_ROOT ?? join(DATA, "room");
export const STATE_DIR = process.env.WORLD_STATE ?? join(DATA, "state");

// room.rb は ROOM_ROOT を、state.rb は WORLD_STATE を環境から読む。
// 子に渡るように、ここで一度だけ決める。
process.env.ROOM_ROOT ??= ROOM_ROOT;
process.env.WORLD_STATE ??= STATE_DIR;
