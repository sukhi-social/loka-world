import assert from "node:assert/strict";
import test from "node:test";

import { CHOOSABLE_TOOLS, CONFIRM_ALWAYS, flowRefusal, isDirect, LEVELS, OPEN_WORLD, STILL_DIRECT, WINDOWS } from "./tools.mjs";

test("確認が出る側のままの道具は、どれも段を持ち、書く道具(L5)で、設定ページの選択肢に出ない", () => {
  for (const name of CONFIRM_ALWAYS) {
    assert.equal(LEVELS[name], 5, name);
    assert.equal(CHOOSABLE_TOOLS.includes(name), false, name);
  }
  assert.ok(CONFIRM_ALWAYS.size >= 5);
});

test("sukhi の外に出る道具(L5・L6)は、すべて openWorld。外に出る L5 は、二段ができるまで run_flow から呼べない。控え(L1)は部屋の中", () => {
  const sukhi = Object.keys(LEVELS).filter((n) => n.startsWith("sukhi_") && LEVELS[n] >= 5);
  assert.ok(sukhi.length >= 30);
  for (const name of sukhi) {
    assert.ok(OPEN_WORLD.has(name), name);
    if (LEVELS[name] === 5) assert.ok(flowRefusal(name), `${name} は run_flow から呼べてはいけない`);
  }
  assert.equal(LEVELS.sukhi_inbox, 1);
  assert.equal(OPEN_WORLD.has("sukhi_inbox"), false);
});

test("ふつうに書く道具(フォロー・反応)は、設定ページで選べる", () => {
  for (const name of ["sukhi_follow", "sukhi_interact", "sukhi_react", "sukhi_post"]) assert.ok(CHOOSABLE_TOOLS.includes(name), name);
});

test("窓は三つ。ほかの道具は、L5・L7 のほかは直接呼べず、run_flow から名前で呼ぶ", () => {
  assert.deepEqual([...WINDOWS].sort(), ["loka_tools", "run_flow", "welcome"]);
  for (const name of WINDOWS) assert.ok(name in LEVELS, name);
  for (const name of Object.keys(LEVELS)) {
    const direct = WINDOWS.has(name) || LEVELS[name] === 5 || LEVELS[name] === 7;
    assert.equal(isDirect(name), direct, name);
  }
  assert.ok(STILL_DIRECT.size >= 20);
});

test("run_flow から呼べる: シェル・日記・呼吸・ジョブ・外を読む。呼べない: 窓の run_flow と welcome、L5・L7", () => {
  for (const name of ["run_mruby_shell", "write_diary_entry", "read_diary_entry", "upload_files", "reset_context", "start_job", "fetch_url", "sukhi_timeline", "loka_tools"]) {
    assert.equal(flowRefusal(name), null, name);
  }
  for (const name of ["run_flow", "welcome", "sukhi_post", "mac_exec", "move_to_shared_drive"]) assert.ok(flowRefusal(name), name);
  assert.match(flowRefusal("nothing"), /知らない道具/);
});
