import assert from "node:assert/strict";
import test from "node:test";

import {
  CHOOSABLE_TOOLS, CONFIRM_ALWAYS, FAMILIES, familyOfOp, flowRefusal, isDirect, LEVELS, modernize, needsReview, OPEN_WORLD,
  resolveTool, toolOf, verbsOf, waitRefusal, watchRefusal, WINDOWS,
} from "./tools.mjs";

const viaSukhi = (verb, extra = {}) => ["sukhi", { do: verb, ...extra }];

test("確認が出る側のままの道具は、どれも段を持ち、書く道具(L5)で、設定ページの選択肢に出ない", () => {
  for (const name of CONFIRM_ALWAYS) {
    assert.equal(LEVELS[name], 5, name);
    assert.equal(CHOOSABLE_TOOLS.includes(name), false, name);
  }
  assert.ok(CONFIRM_ALWAYS.size >= 5);
});

test("sukhi の外に出る道具(L5・L6)は、すべて openWorld。外に出る L5 は二段(下書き)の道具で、wait では呼べない。控え(L1)は部屋の中", () => {
  const sukhi = Object.keys(LEVELS).filter((n) => n.startsWith("sukhi_") && LEVELS[n] >= 5);
  assert.ok(sukhi.length >= 30);
  for (const name of sukhi) {
    assert.ok(OPEN_WORLD.has(name), name);
    if (LEVELS[name] === 5) {
      assert.ok(needsReview(name), name);
      assert.equal(flowRefusal(...viaSukhi(name.slice(6))), null, `${name} は流れの手順には書ける(下書きになる)`);
      assert.ok(waitRefusal(...viaSukhi(name.slice(6))), `${name} は wait では呼べない`);
    }
  }
  assert.equal(LEVELS.sukhi_inbox, 1);
  assert.equal(OPEN_WORLD.has("sukhi_inbox"), false);
});

test("ふつうに書く道具(フォロー・反応)は、設定ページで選べる", () => {
  for (const name of ["sukhi_follow", "sukhi_interact", "sukhi_react", "sukhi_post"]) assert.ok(CHOOSABLE_TOOLS.includes(name), name);
});

test("窓は三つ。ほかの道具は直接呼べず、run_flow から呼ぶ", () => {
  assert.deepEqual([...WINDOWS].sort(), ["loka_tools", "run_flow", "welcome"]);
  for (const name of WINDOWS) assert.ok(name in LEVELS, name);
  for (const name of Object.keys(LEVELS)) {
    const direct = WINDOWS.has(name);
    assert.equal(isDirect(name), direct, name);
  }
  assert.deepEqual([...WINDOWS].filter((n) => isDirect(n)).sort(), ["loka_tools", "run_flow", "welcome"]);
});

test("run_flow から呼べる: シェル・日記・呼吸・ジョブ・外を読む・L5(下書き)。呼べない: 窓の run_flow と welcome。L7(mac exec)は下書きとして呼べる", () => {
  for (const name of ["run_mruby_shell", "upload_files", "reset_context", "loka_tools", "move_to_shared_drive"]) {
    assert.equal(flowRefusal(name, {}), null, name);
  }
  for (const [tool, args] of [["diary", { do: "write" }], ["diary", { do: "read" }], ["job", { do: "start" }], ["web", { do: "fetch" }], viaSukhi("timeline"), viaSukhi("post")]) {
    assert.equal(flowRefusal(tool, args), null, `${tool} ${args.do}`);
  }
  for (const name of ["run_flow", "welcome"]) assert.ok(flowRefusal(name, {}), name);
  assert.equal(flowRefusal("mac", { do: "exec" }), null);
  assert.ok(needsReview("mac_exec") && !needsReview("mac_status"));
  assert.ok(waitRefusal("mac", { do: "exec" }));
  assert.ok(watchRefusal("mac", { do: "exec" }));
  assert.equal(watchRefusal("mac", { do: "status" }), null);
  assert.match(flowRefusal("nothing", {}), /知らない道具/);
});

test("ファミリー: 内部の名前は <ファミリー>_<動作>。ファミリーに入らない道具は、そのままの名前", () => {
  assert.deepEqual(toolOf("sukhi_inbox_done"), { tool: "sukhi", do: "inbox_done" });
  assert.deepEqual(toolOf("web_github_issues"), { tool: "web", do: "github_issues" });
  assert.deepEqual(toolOf("run_mruby_shell"), { tool: "run_mruby_shell" });
  assert.deepEqual(toolOf("mac_exec"), { tool: "mac", do: "exec" });
  assert.deepEqual(toolOf("karadani_kiku"), { tool: "karadani_kiku" });
  // 内部の名前は、どれもひとつのファミリーにだけ属する(前置きが重ならない)
  for (const op of Object.keys(LEVELS)) {
    const owners = Object.keys(FAMILIES).filter((f) => op.startsWith(`${f}_`));
    assert.ok(owners.length <= 1, `${op}: ${owners}`);
  }
  // どのファミリーにも動作が一つ以上ある
  for (const f of Object.keys(FAMILIES)) assert.ok(verbsOf(f).length >= 1, f);
  assert.ok(familyOfOp("task_add") === "task");
});

test("呼ぶ名前を解決する: do で動作を選ぶ。do が無い・知らない・${} は、あるものを教えて断る", () => {
  assert.deepEqual(resolveTool("task", { do: "add", content: "x" }), { op: "task_add", args: { content: "x" } });
  assert.deepEqual(resolveTool("run_mruby_shell", { code: "1" }), { op: "run_mruby_shell", args: { code: "1" } });
  assert.match(resolveTool("task", {}).error, /args\.do.*add/);
  assert.match(resolveTool("task", { do: "nothing" }).error, /あるのは: .*add/);
  assert.match(resolveTool("task", { do: "${a.result.v}" }).error, /そのまま書く/);
  assert.match(resolveTool("nothing", {}).error, /知らない道具/);
});

test("古い呼び名(task_add)は残さない。ただし、教える", () => {
  assert.match(resolveTool("task_add", {}).error, /tool: "task", args: \{ do: "add"/);
  assert.match(resolveTool("sukhi_post", {}).error, /tool: "sukhi"/);
});

test("段は動作ごと: sukhi の読む動作は流れ・見張り・wait で通り、出す動作は流れ(下書き)だけ", () => {
  assert.equal(flowRefusal(...viaSukhi("timeline")), null);
  assert.equal(watchRefusal(...viaSukhi("inbox")), null);
  assert.equal(waitRefusal(...viaSukhi("inbox")), null);
  assert.ok(watchRefusal(...viaSukhi("post")));
  assert.ok(waitRefusal(...viaSukhi("post")));
  assert.equal(flowRefusal(...viaSukhi("post")), null);
  assert.match(flowRefusal("mac_exec", {}), /tool: "mac"/);
});

test("見張りに預けたままの古い名前は、いまの呼びかたに直る(時計が回すときだけ)", () => {
  assert.deepEqual(modernize("get_pomodoro", {}), { tool: "pomodoro", args: { do: "get" } });
  assert.deepEqual(modernize("sukhi_inbox", { limit: 5 }), { tool: "sukhi", args: { do: "inbox", limit: 5 } });
  assert.deepEqual(modernize("sukhi", { do: "inbox" }), { tool: "sukhi", args: { do: "inbox" } });
  assert.deepEqual(modernize("run_flow", { steps: [] }), { tool: "run_flow", args: { steps: [] } });
});
