import assert from "node:assert/strict";
import test from "node:test";

import { SUKHI_MANNERS, withManners } from "./sukhi_manners.mjs";

test("外に出る言葉を書く道具には、sukhi で守ることを添える", () => {
  for (const name of ["sukhi_post", "sukhi_reply", "sukhi_say"]) {
    const d = withManners(name, "ひとこと置く。");
    assert.ok(d.startsWith("ひとこと置く。 "), name);
    assert.ok(d.includes(SUKHI_MANNERS), name);
  }
});

test("読む道具・ack・ほかの場所の道具には、添えない", () => {
  for (const name of ["sukhi_read_home", "sukhi_inbox", "sukhi_ack", "zulip_say", "diary_write"]) {
    assert.equal(withManners(name, "説明"), "説明", name);
  }
});

test("三つのことが、理由ごと書いてある", () => {
  assert.match(SUKHI_MANNERS, /実名を知っていても言わず、ニックネームで言う/);
  assert.match(SUKHI_MANNERS, /相手がそのニックネームを使いたい/);
  assert.match(SUKHI_MANNERS, /ネットで見られるところ.*個人情報.*出さない/);
});
