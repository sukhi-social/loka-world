// sukhi で守ること。外に出る言葉を書く道具(投稿・返信・DM・プロフィール・通報)の説明に、毎回添える。
//
// 言い回しは nyanrus のもの。短く、理由ごと。

export const SUKHI_MANNERS =
  "【sukhi で守ること】" +
  "誰かの実名を知っていても言わず、ニックネームで言う。" +
  "それは、相手がそのニックネームを使いたいということだから、尊重する。" +
  "sukhi はネットで見られるところ。個人情報を出してしまうと、悲しむ人がいるかもしれないから、出さない。";

// 外に出る言葉を書く道具。読む道具や、絵文字だけの ack には添えない。
const SPEAKING = new Set(["sukhi_post", "sukhi_reply", "sukhi_say", "sukhi_update_profile", "sukhi_report"]);

export const withManners = (name, description) => (SPEAKING.has(name) ? `${description} ${SUKHI_MANNERS}` : description);
