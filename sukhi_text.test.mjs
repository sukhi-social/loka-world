// 本文をほどくところの試験。
//
//   node --test

import { test } from "node:test";
import assert from "node:assert/strict";

import { heardFrom, plain, stripLeadingMentions } from "./sukhi_text.mjs";

// sukhi が実際に返してくる形。言及は h-card の span に包まれている。
const REAL = '<p><span class="h-card"><a href="https://sukhi.f3liz.casa/@shiro_mudita">@<span>shiro_mudita</span></a></span>　はへー</p>';

test("HTML をほどく", () => {
  assert.equal(plain("<p>こんばんは</p>"), "こんばんは");
  assert.equal(plain("<p>一行目<br>二行目</p>"), "一行目 二行目");
});

test("あたまの言及を落とす", () => {
  assert.equal(stripLeadingMentions("@shiro_mudita はへー"), "はへー");
  assert.equal(stripLeadingMentions("@a @b やあ"), "やあ");
  assert.equal(stripLeadingMentions("@user@remote.example やあ"), "やあ");
});

test("全角の空白でも落とす", () => {
  // nyanrus の DM は実際これだった(U+3000)。
  assert.equal(stripLeadingMentions("@shiro_mudita　はへー"), "はへー");
});

test("途中の言及は残す — 落とすのは、あたまだけ", () => {
  assert.equal(stripLeadingMentions("@me これは @someone のこと"), "これは @someone のこと");
});

test("言及だけの一通は、空になる", () => {
  assert.equal(stripLeadingMentions("@shiro_mudita"), "");
});

test("言及が無ければ、そのまま", () => {
  assert.equal(stripLeadingMentions("ただの文"), "ただの文");
});

test("本物の HTML から、聞こえた文を取り出す", () => {
  // ここが、一度すべらせたところ。HTML のまま剥がすと言及が残る。
  assert.equal(heardFrom(REAL), "はへー");
});

test("順番を逆にすると落ちない(すべった形を、忘れないために)", () => {
  // plain を後にすると、行頭が `<p><span…` なので ^@ に当たらない。
  assert.equal(plain(stripLeadingMentions(REAL)), "@shiro_mudita はへー");
});

test("空でも転ばない", () => {
  assert.equal(heardFrom(null), "");
  assert.equal(heardFrom(undefined), "");
  assert.equal(heardFrom(""), "");
});
