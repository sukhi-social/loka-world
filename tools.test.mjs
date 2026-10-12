import assert from "node:assert/strict";
import test from "node:test";

import { CHOOSABLE_TOOLS, CONFIRM_ALWAYS, flowRefusal, LEVELS, OPEN_WORLD } from "./tools.mjs";

test("確認が出る側のままの道具は、どれも段を持ち、書く道具(L5)で、設定ページの選択肢に出ない", () => {
  for (const name of CONFIRM_ALWAYS) {
    assert.equal(LEVELS[name], 5, name);
    assert.equal(CHOOSABLE_TOOLS.includes(name), false, name);
  }
  assert.ok(CONFIRM_ALWAYS.size >= 5);
});

test("sukhi の外に出る道具(L5・L6)は、すべて openWorld で、流れ(run_flow)からは呼べない。控え(L1)は部屋の中", () => {
  const sukhi = Object.keys(LEVELS).filter((n) => n.startsWith("sukhi_") && LEVELS[n] >= 5);
  assert.ok(sukhi.length >= 30);
  for (const name of sukhi) {
    assert.ok(OPEN_WORLD.has(name), name);
    assert.ok(flowRefusal(name), `${name} は run_flow から呼べてはいけない`);
  }
  assert.equal(LEVELS.sukhi_inbox, 1);
  assert.equal(OPEN_WORLD.has("sukhi_inbox"), false);
});

test("ふつうに書く道具(フォロー・反応)は、設定ページで選べる", () => {
  for (const name of ["sukhi_follow", "sukhi_interact", "sukhi_react", "sukhi_post"]) assert.ok(CHOOSABLE_TOOLS.includes(name), name);
});
