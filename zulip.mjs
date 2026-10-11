// Zulip との話し口。sukhi が「じゃれる方」なら、こちらは「働く方」。
//
// 間に層は挟まず、Zulip の REST API を直に叩く。
// 秘密は環境変数(サーバーの設定)から。.zuliprc の [api] と同じ三つ:
//   ZULIP_SITE / ZULIP_EMAIL / ZULIP_API_KEY

const FETCH_TIMEOUT_MS = 15_000;

export const zulipConfigured = () => Boolean(process.env.ZULIP_SITE && process.env.ZULIP_EMAIL && process.env.ZULIP_API_KEY);

function config() {
  if (!zulipConfigured()) {
    throw new Error("Zulip へは、まだ繋がっていません(ZULIP_SITE / ZULIP_EMAIL / ZULIP_API_KEY をサーバーの環境に)。");
  }
  const { ZULIP_SITE: site, ZULIP_EMAIL: email, ZULIP_API_KEY: key } = process.env;
  return { site: site.replace(/\/+$/, ""), auth: `Basic ${Buffer.from(`${email}:${key}`).toString("base64")}` };
}

async function api(path, { method = "GET", params } = {}) {
  const { site, auth } = config();
  const url = new URL(`${site}${path}`);
  const init = { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  if (params && method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else if (params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    init.body = body;
  }
  const data = await (await fetch(url, init)).json();
  if (data.result !== "success") throw new Error(`${method} ${path}: ${data.msg ?? "unknown error"}`);
  return data;
}

// ── 人を探す ──────────────────────────────────────────────────────────────

// 名前・メール・user_id のどれでも。bot は除く。
async function findUser(query) {
  const { members } = await api("/api/v1/users");
  const hit = members.find((u) => !u.is_bot && (u.full_name === query || u.email === query || String(u.user_id) === query));
  if (!hit) throw new Error(`@${query} が見つかりませんでした`);
  return { id: hit.user_id, name: hit.full_name };
}

// ── 言う ──────────────────────────────────────────────────────────────────
//
// **呼ばれた場所へ返す。** 部屋(stream)で呼ばれたなら stream と topic を、DM なら to を。
// ここは働く方なので、140 字の縛りは無い。

export async function say({ text, to = "NyanRus", stream, topic }) {
  if (stream) {
    const topicName = topic ?? "(no topic)";
    const sent = await api("/api/v1/messages", { method: "POST", params: { type: "stream", to: stream, topic: topicName, content: text } });
    return { id: sent.id, stream, topic: topicName };
  }
  const user = await findUser(to);
  const sent = await api("/api/v1/messages", { method: "POST", params: { type: "direct", to: [user.id], content: text } });
  return { id: sent.id, to: user.name };
}

// ── 読む ──────────────────────────────────────────────────────────────────

const showMessage = (m) => ({
  id: m.id,
  from: m.sender_full_name,
  from_id: m.sender_id,
  text: m.content.replace(/<[^>]+>/g, "").trim(),
  ...(m.type === "stream" ? { stream: m.display_recipient, topic: m.subject } : {}),
  timestamp: new Date(m.timestamp * 1000).toISOString(),
});

const newest = async (narrow, limit) =>
  (
    await api("/api/v1/messages", {
      params: { anchor: "newest", num_before: limit, num_after: 0, narrow: JSON.stringify(narrow) },
    })
  ).messages.map(showMessage);

// 呼ばれた場所の話の流れが見えないと、そこだけ切り取って返すことになる。
//   stream … 部屋のぶん(topic も添えると、その話題だけ)
//   to     … その人との DM
//   どちらも省くと、みんな分の DM の直近
export async function read({ stream, topic, to, limit = 20 }) {
  if (stream) {
    const narrow = [{ operator: "stream", operand: stream }];
    if (topic) narrow.push({ operator: "topic", operand: topic });
    return newest(narrow, limit);
  }
  if (to) return newest([{ operator: "dm", operand: [(await findUser(to)).id] }], limit);
  return newest([{ operator: "is", operand: "dm" }], limit);
}
