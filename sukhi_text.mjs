// 本文をほどくところ。
//
// 投稿は HTML で来る。そこから「人が読む文」と「そのまま返していい文」を
// 作る。順番があるので、独立した関数にして試験できるようにした
// (HTML のまま言及を剥がそうとして、一度すべらせたので)。

/** タグを落として、人が読める一行にする。 */
export function plain(html, limit = 200) {
  let text = String(html ?? "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/p>/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim()
    .replace(/\s+/gu, " ");
  if (text.length > limit) text = text.slice(0, limit) + "…";
  return text;
}

/**
 * 本文あたまの @言及 を落とす。
 *
 * DM の宛先は本文の @ 言及から決まる(notes/create.ex:246)ので、聞こえた文を
 * そのまま返すと、自分自身を宛先に足してしまう。
 *
 * **`plain()` を通したあとに呼ぶこと。** 言及は h-card の span に包まれて
 * 来るため、HTML のままだと行頭が `<p><span…` で `^@` に当たらない。
 */
export function stripLeadingMentions(text) {
  return String(text ?? "")
    .replace(/^(?:\s*@[\w.\-]+(?:@[\w.\-]+)?)+/u, "")
    .trim();
}

/** 聞こえた文。HTML をほどいてから、あたまの言及を落とす。 */
export function heardFrom(html) {
  return stripLeadingMentions(plain(html));
}
