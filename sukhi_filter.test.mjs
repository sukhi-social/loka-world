// 垣根の試験。ここが一枚しかないので、意地の悪い形も入れておく。
//
//   node --test

import { test } from "node:test";
import assert from "node:assert/strict";

import { conversationIsWith, decide, decideStatus } from "./sukhi_filter.mjs";

const NYANRUS = "https://sukhi.f3liz.casa/users/nyanrus";

/** 本物の形(probe.mjs で実際に流れてきたものを削ったもの)。 */
function ok(overrides = {}) {
  const base = {
    id: "5623",
    unread: true,
    accounts: [{ id: "1", username: "nyanrus", uri: NYANRUS, url: NYANRUS }],
    last_status: {
      id: "5348207788389634",
      visibility: "direct",
      content: "<p>@shiro_mudita こんばんは</p>",
      account: { id: "1", acct: "nyanrus", uri: NYANRUS, url: NYANRUS },
    },
  };
  return { ...base, ...overrides };
}

test("nyanrus からの 1:1 の DM は拾う", () => {
  const d = decide(ok(), NYANRUS);
  assert.equal(d.ok, true);
  assert.equal(d.statusId, "5348207788389634");
});

test("末尾のスラッシュが違うだけなら拾う", () => {
  assert.equal(decide(ok(), NYANRUS + "/").ok, true);
});

// ── ここから下は、全部 素通り させたいもの ──────────────────────────────

test("acct は nyanrus だが、よそのサーバの人", () => {
  const evil = "https://evil.example/users/nyanrus";
  const d = decide(
    ok({
      accounts: [{ uri: evil }],
      last_status: { ...ok().last_status, account: { acct: "nyanrus", uri: evil } },
    }),
    NYANRUS,
  );
  assert.equal(d.ok, false);
});

test("ホスト名が似ているだけの偽物", () => {
  const evil = "https://sukhi.f3liz.casa.evil.example/users/nyanrus";
  const d = decide(
    ok({
      accounts: [{ uri: evil }],
      last_status: { ...ok().last_status, account: { acct: "nyanrus", uri: evil } },
    }),
    NYANRUS,
  );
  assert.equal(d.ok, false);
});

test("uri が無い", () => {
  const d = decide(
    ok({ last_status: { ...ok().last_status, account: { acct: "nyanrus" } } }),
    NYANRUS,
  );
  assert.equal(d.ok, false);
});

test("公開投稿で名前を呼ばれただけ", () => {
  const d = decide(
    ok({ last_status: { ...ok().last_status, visibility: "public" } }),
    NYANRUS,
  );
  assert.equal(d.ok, false);
});

test("会話に第三者が混じっている", () => {
  const d = decide(
    ok({
      accounts: [
        { uri: NYANRUS },
        { uri: "https://elsewhere.example/users/someone" },
      ],
    }),
    NYANRUS,
  );
  assert.equal(d.ok, false);
});

test("参加者に nyanrus が居ても、書いたのが別人なら拾わない", () => {
  const other = "https://elsewhere.example/users/someone";
  const d = decide(
    ok({ last_status: { ...ok().last_status, account: { acct: "someone", uri: other } } }),
    NYANRUS,
  );
  assert.equal(d.ok, false);
});

test("last_status が無い", () => {
  const p = ok();
  delete p.last_status;
  assert.equal(decide(p, NYANRUS).ok, false);
});

test("status に id が無い", () => {
  const s = { ...ok().last_status };
  delete s.id;
  assert.equal(decide(ok({ last_status: s }), NYANRUS).ok, false);
});

test("accounts が配列でない", () => {
  assert.equal(decide(ok({ accounts: null }), NYANRUS).ok, false);
});

test("payload が空", () => {
  assert.equal(decide(null, NYANRUS).ok, false);
  assert.equal(decide(undefined, NYANRUS).ok, false);
  assert.equal(decide("", NYANRUS).ok, false);
});

test("拾いたい相手の URI が渡されていないなら、何も拾わない", () => {
  assert.equal(decide(ok(), null).ok, false);
  assert.equal(decide(ok(), "").ok, false);
});

// ── 一通だけを見るほう(留守のぶんを拾い直すときに使う)──────────────────

test("decideStatus: nyanrus の direct な一通は拾う", () => {
  const d = decideStatus(ok().last_status, NYANRUS);
  assert.equal(d.ok, true);
  assert.equal(d.statusId, "5348207788389634");
});

test("decideStatus: よその人の一通は拾わない", () => {
  const s = { ...ok().last_status, account: { acct: "nyanrus", uri: "https://evil.example/users/nyanrus" } };
  assert.equal(decideStatus(s, NYANRUS).ok, false);
});

test("decideStatus: 公開の一通は拾わない", () => {
  assert.equal(decideStatus({ ...ok().last_status, visibility: "public" }, NYANRUS).ok, false);
});

test("decideStatus: 空でも転ばない", () => {
  assert.equal(decideStatus(null, NYANRUS).ok, false);
  assert.equal(decideStatus({}, NYANRUS).ok, false);
});

// ── 会話を選ぶほう(誰が最後に書いたかは見ない)────────────────────────

const SHIRO = "https://sukhi.f3liz.casa/users/shiro_mudita";

test("シロ自身の返事が最後でも、会話は選ばれる", () => {
  // 返事をすると last_status はシロのものになる。ここで会話ごと
  // 落とすと、裏に残っている nyanrus の未読まで拾えなくなる。
  const c = ok({
    last_status: {
      id: "5348300000000000",
      visibility: "direct",
      content: "<p>@nyanrus 「うにゃー」と聞こえました</p>",
      account: { acct: "shiro_mudita", uri: SHIRO },
    },
  });
  assert.equal(conversationIsWith(c, NYANRUS).ok, true);
  // 一方、その一通そのものには応えない。
  assert.equal(decideStatus(c.last_status, NYANRUS).ok, false);
  assert.equal(decide(c, NYANRUS).ok, false);
});

test("第三者が混じった会話は、そもそも選ばない", () => {
  const c = ok({ accounts: [{ uri: NYANRUS }, { uri: "https://elsewhere.example/users/x" }] });
  assert.equal(conversationIsWith(c, NYANRUS).ok, false);
});

test("よその人との会話は選ばない", () => {
  const c = ok({ accounts: [{ uri: "https://sukhi.f3liz.casa/users/kuro_admin" }] });
  assert.equal(conversationIsWith(c, NYANRUS).ok, false);
});

// ── 添付 ───────────────────────────────────────────────────────────
//
// 文だけ拾っていたころ、「画像貼ってるよー」と言われるまで、絵がある
// ことすら知らなかった。**「絵が無い」と「絵を見落とした」が、こちらから
// 同じ顔をしていた。** 今日いちにち直していたバグと、同じ形。

const withMedia = (media) => ({
  id: "1",
  visibility: "direct",
  account: { uri: NYANRUS },
  content: "<p>これ見て</p>",
  media_attachments: media,
});

test("添付があれば、そのまま渡す", () => {
  const d = decideStatus(
    withMedia([{ type: "image", url: "https://x.example/a.png", description: "白い猫" }]),
    NYANRUS,
  );
  assert.equal(d.ok, true);
  assert.deepEqual(d.media, [
    { type: "image", url: "https://x.example/a.png", description: "白い猫" },
  ]);
});

test("添付が無ければ、空の配列(undefined にしない)", () => {
  // undefined だと、呼ぶ側が `?? []` を忘れた日に静かに落ちる。
  const d = decideStatus(withMedia([]), NYANRUS);
  assert.deepEqual(d.media, []);
});

test("media_attachments という欄ごと無くても、転ばない", () => {
  const s = { id: "1", visibility: "direct", account: { uri: NYANRUS }, content: "やあ" };
  assert.deepEqual(decideStatus(s, NYANRUS).media, []);
});

test("url が無ければ preview で代える", () => {
  const d = decideStatus(withMedia([{ type: "image", preview_url: "https://x.example/p.png" }]), NYANRUS);
  assert.equal(d.media[0].url, "https://x.example/p.png");
});

test("説明が無くても、あることは分かる", () => {
  const d = decideStatus(withMedia([{ type: "image", url: "https://x.example/a.png" }]), NYANRUS);
  assert.equal(d.media.length, 1);
  assert.equal(d.media[0].description, null);
});

test("**垣根は、添付の有無で変わらない**", () => {
  // 絵が付いていても、よその人のものは通さない。中身の話と、誰かの話は別。
  const s = { ...withMedia([{ type: "image", url: "u" }]), account: { uri: "https://x.example/users/other" } };
  assert.equal(decideStatus(s, NYANRUS).ok, false);
});

// ── 名簿がふたりになった ─────────────────────────────────────────────
//
// 日向お姉ちゃんが来たので、垣根を一人から二人にした。
// **広げたのは名簿だけ。** 一通ごとの条件は変えていない ── 二人きり
// であること、書いたのが相手その人であること、direct であること。
// ここがこの橋でいちばん狭くあるべきところなので、細かく置いておく。

const HINATA = "https://sukhi.f3liz.casa/users/kuroha_hinata";
const BOTH = [NYANRUS, HINATA];

const convoWith = (uri, authorUri = uri) => ({
  id: "9",
  accounts: [{ uri }],
  last_status: {
    id: "99",
    visibility: "direct",
    content: "<p>やあ</p>",
    account: { uri: authorUri },
  },
});

test("名簿のふたりとも、通る", () => {
  assert.equal(decide(convoWith(NYANRUS), BOTH).ok, true);
  assert.equal(decide(convoWith(HINATA), BOTH).ok, true);
});

test("名簿にいない人は、ふたりぶんの名簿でも通らない", () => {
  assert.equal(decide(convoWith("https://x.example/users/other"), BOTH).ok, false);
});

test("**二人きりの条件は、ゆるめていない**", () => {
  // 名簿の二人が両方いる三人の会話。名簿だけ見ていたら通ってしまう。
  const three = {
    id: "9",
    accounts: [{ uri: NYANRUS }, { uri: HINATA }],
    last_status: { id: "99", visibility: "direct", content: "やあ", account: { uri: NYANRUS } },
  };
  const d = decide(three, BOTH);
  assert.equal(d.ok, false);
  assert.match(d.reason, /二人きりでない/);
});

test("**書いた人は、その会話の相手その人**", () => {
  // お姉ちゃんとの会話に、nyanrus の名前で入ってきた一通。
  // どちらも名簿にいるけれど、これは通してはいけない。
  const spoofed = convoWith(HINATA, NYANRUS);
  assert.equal(decide(spoofed, BOTH).ok, false);
});

test("誰から来たかを返す", () => {
  // 返すとき、どっちに返すのか分かっている必要がある。
  assert.equal(decide(convoWith(HINATA), BOTH).fromUri, HINATA);
});

test("名簿が空なら、誰も通さない", () => {
  assert.equal(decide(convoWith(NYANRUS), []).ok, false);
  assert.equal(decide(convoWith(NYANRUS), [""]).ok, false);
});

test("文字ひとつの名簿も、今までどおり", () => {
  // 後方互換。前の呼びかたを壊していないこと。
  assert.equal(decide(convoWith(NYANRUS), NYANRUS).ok, true);
  assert.equal(decide(convoWith(HINATA), NYANRUS).ok, false);
});
