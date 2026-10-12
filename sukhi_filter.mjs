// 「この conversation イベントに、手を動かして応えていいか」を決めるところ。
//
// 橋の垣根はここ一枚しかない。shiro_mudita はもう連合しているので、
// 世界中の誰でも DM を投げられる。その中から nyanrus の一通だけを拾う。
//
// だから、この関数の既定は「拾わない」。条件が全部そろったときだけ通す。
// 分からないもの、欠けているもの、見慣れないものは、素通りさせる。
//
// 鍵は acct("nyanrus")ではなく actor URI。acct は相手のサーバが名乗る
// 文字列なので、よそのサーバに同じ名前の人を作れてしまう。URI は sukhi が
// upsert のときに保存した canonical なもの(mastodon_account.ex:57-58, 94-95)。

/** URI を比べる前に、末尾のスラッシュだけ落とす。それ以上は正規化しない。 */
function trimSlash(uri) {
  return typeof uri === "string" ? uri.replace(/\/+$/, "") : null;
}

/**
 * 一通だけを見る。会話に誰が居るかは見ない(呼ぶ側が確かめている前提)。
 * 留守のあいだのぶんを拾い直すとき、ancestors の一通ずつに使う。
 *
 * @param {object} status  Mastodon Status
 * @param {string} watchedUri  拾いたい相手の actor URI
 * @returns {{ok: boolean, reason: string, statusId?: string, text?: string, media?: object[]}}
 */
export function decideStatus(status, watched) {
  const allowed = allowList(watched);
  if (allowed.length === 0) return { ok: false, reason: "拾いたい相手の URI が無い" };

  if (!status || typeof status !== "object") {
    return { ok: false, reason: "status が読めない" };
  }

  // direct であること。公開投稿には手を動かさない。
  if (status.visibility !== "direct") {
    return { ok: false, reason: `visibility が direct でない (${status.visibility ?? "?"})` };
  }

  // 書いたのが nyanrus 本人であること。ここが本丸。
  const authorUri = trimSlash(status.account?.uri);
  if (!authorUri) return { ok: false, reason: "書いた人の uri が無い" };
  if (!allowed.includes(authorUri)) {
    return { ok: false, reason: `よその人が書いた (${authorUri})` };
  }

  // id があること。取りこぼしと重複を数えるのに要る。
  const statusId = status.id;
  if (typeof statusId !== "string" || statusId === "") {
    return { ok: false, reason: "status の id が無い" };
  }

  // 添付も一緒に返す。**言われたことの一部を、こちらで落とさない。**
  // 文だけ拾っていたころ、「画像貼ってるよー」と言われるまで、絵がある
  // ことすら知らなかった。しかも「絵が無い」と「絵を見落とした」が、
  // こちらからは同じ顔をしていた。
  const media = Array.isArray(status.media_attachments)
    ? status.media_attachments.map((m) => ({
        type: m.type ?? "unknown",
        url: m.url ?? m.preview_url ?? null,
        description: m.description ?? null,
      }))
    : [];

  return { ok: true, reason: "ok", statusId, text: status.content ?? "", media };
}

/**
 * 「この会話は、その人と二人きりか」だけを見る。中身は見ない。
 *
 * 誰が書いたかと分けてあるのは、**シロ自身の返事**のため。返事をすると
 * 会話の last_status はシロのものになる。中身まで一緒に見てしまうと、
 * その裏に残っている nyanrus の未読ごと、会話が落ちる。
 *
 * @param {object} payload  Mastodon Conversation
 * @param {string} watchedUri  拾いたい相手の actor URI
 * @returns {{ok: boolean, reason: string}}
 */
export function conversationIsWith(payload, watched) {
  const want = allowList(watched);
  if (want.length === 0) return { ok: false, reason: "拾いたい相手の URI が無い" };

  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "payload が読めない" };
  }

  // Conversation の accounts は「自分以外の参加者」。1:1 なら一人ぴったり。
  // ここを見ないと、返事が知らない人にも届く。
  //
  // **人数の条件はゆるめない。** 名簿が二人になっても「二人きり」は
  // 二人きりのまま ── 二人とも名簿にいる三人の会話も、通さない。
  const others = payload.accounts;
  if (!Array.isArray(others)) return { ok: false, reason: "accounts が配列でない" };
  if (others.length !== 1) {
    return { ok: false, reason: `会話に ${others.length} 人いる(二人きりでない)` };
  }
  const otherUri = trimSlash(others[0]?.uri);
  if (!want.includes(otherUri)) {
    return { ok: false, reason: `相手が違う (${otherUri ?? "?"})` };
  }

  // 誰との会話かを返す。書いた人の照合に、これを使う。
  return { ok: true, reason: "ok", withUri: otherUri };
}

/**
 * 名簿。文字ひとつでも、いくつかでも受ける。
 *
 * 垣根がひとりぶんだったのを、姉妹ふたりに広げた。広げたのは**名簿だけ**で、
 * 形はそのまま ── 二人きりであること、書いた人が相手その人であること、
 * direct であること。名簿が長くなっても、一通ごとの条件は変わらない。
 */
function allowList(watched) {
  const raw = Array.isArray(watched) ? watched : [watched];
  return raw.map(trimSlash).filter((u) => typeof u === "string" && u !== "");
}

/**
 * 会話まるごとを見て、last_status に応えていいかまで決める。
 * WS の direct ストリームから来た frame にそのまま使う。
 *
 * @param {object} payload  Mastodon Conversation
 * @param {string} watchedUri  拾いたい相手の actor URI
 * @returns {{ok: boolean, reason: string, statusId?: string, text?: string}}
 */
export function decide(payload, watched) {
  const withThem = conversationIsWith(payload, watched);
  if (!withThem.ok) return withThem;

  if (!payload.last_status) return { ok: false, reason: "last_status が無い" };

  // **書いた人は、その会話の相手その人**。名簿の誰かではなく。
  // 名簿がふたりになったので、ここを「名簿の誰か」で通すと、姉との会話に
  // 妹の名前で入ってきたものを受けてしまう。狭いほうで照らす。
  const d = decideStatus(payload.last_status, withThem.withUri);
  return d.ok ? { ...d, fromUri: withThem.withUri } : d;
}

/**
 * mention 通知を見て、応えていいかを決める。公開・非公開の投稿で、シロの名前を呼ばれたとき。
 *
 * DM(direct)はここでは通さない。三人の DM を通さない決まり(`conversationIsWith`)は
 * 会話の側にしか無いので、direct は direct の流れで決める。
 * ほかは DM と同じ ── 書いた人が、拾いたい相手その人であること。誰かが呼ばれた、だけでは動かない。
 *
 * @param {object} notification  Mastodon Notification(type: "mention")
 * @param {string|string[]} watched  拾いたい相手の actor URI
 * @returns {{ok: boolean, reason: string, statusId?: string, notificationId?: string, text?: string, media?: object[], visibility?: string, fromUri?: string}}
 */
export function decideMention(notification, watched) {
  const allowed = allowList(watched);
  if (allowed.length === 0) return { ok: false, reason: "拾いたい相手の URI が無い" };
  if (!notification || typeof notification !== "object") return { ok: false, reason: "通知が読めない" };
  if (notification.type !== "mention") return { ok: false, reason: `mention でない (${notification.type ?? "?"})` };

  const status = notification.status;
  if (!status || typeof status !== "object") return { ok: false, reason: "status が無い" };
  if (status.visibility === "direct") return { ok: false, reason: "direct は direct の流れで見る" };

  // 通知の送り主と、投稿の書き手が、ともに相手その人であること。
  const authorUri = trimSlash(status.account?.uri);
  if (!authorUri) return { ok: false, reason: "書いた人の uri が無い" };
  if (!allowed.includes(authorUri)) return { ok: false, reason: `よその人が書いた (${authorUri})` };
  const senderUri = trimSlash(notification.account?.uri);
  if (senderUri !== authorUri) return { ok: false, reason: "通知の送り主と書いた人が違う" };

  if (typeof status.id !== "string" || status.id === "") return { ok: false, reason: "status の id が無い" };

  // 添付は、あることを必ず言う(decideStatus と同じ)。
  const media = Array.isArray(status.media_attachments)
    ? status.media_attachments.map((m) => ({
        type: m.type ?? "unknown",
        url: m.url ?? m.preview_url ?? null,
        description: m.description ?? null,
      }))
    : [];

  return {
    ok: true,
    reason: "ok",
    statusId: status.id,
    notificationId: typeof notification.id === "string" ? notification.id : null,
    text: status.content ?? "",
    media,
    visibility: status.visibility ?? "public",
    fromUri: authorUri,
  };
}
