// sukhi(fediverse)との話し口。シロの声が、外に届く場所。
//
// ActivityPlug の mastodon アダプタを sukhi.f3liz.casa に挿して使う。
// 読む・置く・返すは ActivityPlug(id は封筒入り ap_1_…)。ActivityPlug に無い面
// (markers・会話・絵文字リアクション)だけ、素の fetch で足す。
//
// 秘密は環境変数(サーバーの設定)から:
//   MASTODON_API_BASE_URL / MASTODON_ACCESS_TOKEN
//   MASTODON_CLIENT_ID / MASTODON_CLIENT_SECRET / MASTODON_REFRESH_TOKEN / MASTODON_SCOPE
// access_token が切れたら refresh_token で取り直す。取り直した値は
// state/sukhi_token.json に控えて(環境は書き換えられない)、次からそちらを先に使う。
//
// 「未読」の位置は、サーバー側の /api/v1/markers(notifications)。
// sukhi の SPA はこの marker を触らないので、ここはシロの既読位置としてまるごと使える。

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createActivityPlugClient } from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";

import { STATE_DIR } from "./paths.mjs";

const FETCH_TIMEOUT_MS = 15_000;
const UNREAD_PROBE_LIMIT = 40;
const TOKEN_FILE = () => join(STATE_DIR, "sukhi_token.json");
const HEARD_FILE = () => join(STATE_DIR, "sukhi_heard.json");

// ── 設定 ──────────────────────────────────────────────────────────────────

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

// 取り直した token が控えにあれば、環境より先に使う。
const secret = (name) => readJson(TOKEN_FILE())?.[name] ?? process.env[name];

function baseUrl() {
  const base = process.env.MASTODON_API_BASE_URL;
  if (!base || !secret("MASTODON_ACCESS_TOKEN")) {
    throw new Error("sukhi へは、まだ繋がっていません(MASTODON_API_BASE_URL と MASTODON_ACCESS_TOKEN をサーバーの環境に)。");
  }
  return base.replace(/\/+$/, "");
}

export const sukhiConfigured = () => Boolean(process.env.MASTODON_API_BASE_URL && secret("MASTODON_ACCESS_TOKEN"));

async function refreshAccessToken() {
  const clientId = process.env.MASTODON_CLIENT_ID;
  const clientSecret = process.env.MASTODON_CLIENT_SECRET;
  const refreshToken = secret("MASTODON_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("access_token を取り直すには MASTODON_CLIENT_ID / MASTODON_CLIENT_SECRET / MASTODON_REFRESH_TOKEN が要ります。");
  }

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  if (process.env.MASTODON_SCOPE) form.set("scope", process.env.MASTODON_SCOPE);

  const resp = await fetch(`${baseUrl()}/oauth/token`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`refresh に失敗しました: HTTP ${resp.status}`);
  const payload = await resp.json();
  if (!payload.access_token) throw new Error("refresh の応答に access_token がありません");

  mkdirSync(STATE_DIR, { recursive: true });
  const keep = {
    ...readJson(TOKEN_FILE()),
    MASTODON_ACCESS_TOKEN: payload.access_token,
    ...(payload.refresh_token ? { MASTODON_REFRESH_TOKEN: payload.refresh_token } : {}),
  };
  writeFileSync(TOKEN_FILE(), JSON.stringify(keep), { mode: 0o600 });
  chmodSync(TOKEN_FILE(), 0o600);
}

// ── ActivityPlug の client / session ─────────────────────────────────────

let clientCache = null;
let sessionCache = null;

const client = () => (clientCache ??= createActivityPlugClient({ adapter: createMastodonAdapter(), origin: baseUrl() }));

const session = async () =>
  (sessionCache ??= await client().auth.injectToken({ accessToken: secret("MASTODON_ACCESS_TOKEN") }));

// 認証エラーなら一度だけ取り直して、やり直す。
async function withAuth(fn) {
  try {
    return await fn(client(), await session());
  } catch (error) {
    const expired = error?.code === "AUTH_REQUIRED" || error?.code === "AUTH_EXPIRED";
    if (!expired || !secret("MASTODON_REFRESH_TOKEN")) throw error;
    await refreshAccessToken();
    sessionCache = null;
    return await fn(client(), await session());
  }
}

// ActivityPlug にまだ無い面は、ここから素の fetch で。
// 401 なら、withAuth と同じく一度だけ取り直して、やり直す。
export async function api(path, init = {}, retried = false) {
  const resp = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret("MASTODON_ACCESS_TOKEN")}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (resp.status === 401 && !retried && secret("MASTODON_REFRESH_TOKEN")) {
    await refreshAccessToken();
    sessionCache = null;
    return api(path, init, true);
  }
  if (!resp.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${resp.status}`);
  return resp.json();
}

// streaming の WebSocket。耳が使う。繋ぎ直すたびに呼ぶ(取り直した token を拾うため)。
export const streamUrl = (stream) =>
  `${baseUrl().replace(/^http/, "ws")}/api/v1/streaming?stream=${stream}&access_token=${encodeURIComponent(secret("MASTODON_ACCESS_TOKEN"))}`;

const postJson = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ── 表示の形 ──────────────────────────────────────────────────────────────

// 投稿本文は HTML で来る。ざっくりタグを落として、人が読める形に。
export function trimHtml(html, limit = 500) {
  const text = String(html ?? "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// 添付の url はそのまま公開アクセスできる。ここでは渡すだけ(見るのは呼ぶ側)。
const showMedia = (list) =>
  (list ?? [])
    .filter((m) => m.url)
    .map((m) => {
      const description = m.description ?? m.raw?.description;
      return { url: m.url, type: m.type, ...(description ? { description } : {}) };
    });

const withMedia = (media) => (media.length > 0 ? { media } : {});

export function showPost(post) {
  return {
    id: post.ref.id,
    author: `@${post.author.acct}`,
    display_name: post.author.displayName,
    text: trimHtml(post.contentHtml),
    visibility: post.visibility,
    url: post.url,
    created_at: post.createdAt,
    ...withMedia(showMedia(post.media)),
  };
}

export function showNotification(n) {
  const raw = n.raw ?? {};
  const acct = raw.account ?? {};
  return {
    id: n.ref.id,
    type: n.type,
    from: `@${acct.acct ?? "?"}`,
    display_name: acct.display_name ?? "",
    ...(raw.status ? { text: trimHtml(raw.status.content), status_id: n.post?.id } : {}),
    ...withMedia(showMedia(raw.status?.media_attachments)),
    created_at: n.createdAt,
  };
}

// ActivityPlug の語彙では followers。Mastodon の private もその意味なので、そちらに寄せる。
const toVisibility = (v) => (v === "private" ? "followers" : v);

// ── 未読(markers)────────────────────────────────────────────────────────

// sukhi の id は snowflake(数字の文字列)。数として比べる。
function idNewer(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a.length === b.length ? a > b : a.length > b.length;
  }
}

async function notificationsMarker() {
  const markers = await api("/api/v1/markers?timeline[]=notifications");
  return markers?.notifications?.last_read_id ?? null;
}

// 前へ進むだけ。すでに新しい位置に居るなら、動かさない。
async function advanceNotificationsMarker(lastReadId) {
  const current = await notificationsMarker();
  if (current !== null && !idNewer(lastReadId, current)) return;
  await postJson("/api/v1/markers", { notifications: { last_read_id: lastReadId } });
}

// ── 読む ─────────────────────────────────────────────────────────────────

export async function readHome({ limit = 20 } = {}) {
  const page = await withAuth((c, s) => c.timelines.home({ session: s, page: { limit } }));
  return page.nodes.map(showPost);
}

// 既読位置は動かさない。
export async function readMentions({ limit = 20 } = {}) {
  const page = await withAuth((c, s) => c.notifications.list({ session: s, types: ["mention"], page: { limit } }));
  return page.nodes.map(showNotification);
}

// markRead なら、読んだところまで既読になる。
export async function readNotifications({ limit = 20, markRead = true } = {}) {
  const page = await withAuth((c, s) => c.notifications.list({ session: s, page: { limit } }));
  if (markRead && page.nodes.length > 0) await advanceNotificationsMarker(page.nodes[0].ref.rawId);
  return page.nodes.map(showNotification);
}

// marker より新しい通知をかぞえる。probe の窓より多いときは plus=true。
export async function unreadSummary() {
  const [marker, page] = await Promise.all([
    notificationsMarker(),
    withAuth((c, s) => c.notifications.list({ session: s, page: { limit: UNREAD_PROBE_LIMIT } })),
  ]);
  const unread = marker === null ? [...page.nodes] : page.nodes.filter((n) => idNewer(n.ref.rawId, marker));
  const byType = {};
  for (const n of unread) byType[n.type] = (byType[n.type] ?? 0) + 1;
  return {
    count: unread.length,
    plus: unread.length === page.nodes.length && page.pageInfo.hasNextPage,
    byType,
  };
}

// ── 置く・返す ───────────────────────────────────────────────────────────

export async function post({ text, visibility = "unlisted", inReplyToId }) {
  const created = await withAuth((c, s) =>
    c.posts.create({
      session: s,
      content: text,
      visibility: toVisibility(visibility),
      ...(inReplyToId ? { replyToId: inReplyToId } : {}),
    }),
  );
  return { url: created.url, id: created.ref.id };
}

// ── DM(say / ack)────────────────────────────────────────────────────────
//
// **返す先は「その人が最後に書いた一通」。会話の最後の一通では、ない。**
//
// 会話の last_status は、書いた人を問わない。say は 140 字で切れて「続きがあるなら
// もう一度」呼ぶ形なので、二度目からは自分の直前の発言にぶら下がってしまう
// (数えたら、シロの返信 96 通のうち 65 通が自分にぶら下がっていた。2026-08-09)。
// ack も同じで、自分が最後に喋っていると、自分の投稿に「読んだよ」を押してしまう。
// だから、自分が最後なら、話を遡って、相手が最後に書いたところまで戻る。
//
// **二人きりの会話だけを見る。** 三人の会話がたまたま新しいというだけで、そちらに
// ぶら下がらないように。耳(bridge)も二人きりのぶんしか通さない。

let myId = null;
async function whoAmI() {
  myId ??= (await api("/api/v1/accounts/verify_credentials"))?.id ?? null;
  return myId;
}

// bridge が最後に通した一通。人ごとに一つ、state/sukhi_heard.json に控えてある。
// 毎回読み直す(覚えると、新しいのを聞いても古いところに返し続ける)。
// 無い・壊れている ── どれも同じ扱いで、静かに null。
const heardStatusId = (acct) => readJson(HEARD_FILE())?.[acct]?.status_id ?? null;

async function lastFromThem(acct) {
  // まず、ほんとうに聞いた一通。会話から推し量ると、聞いたあとに届いたぶんも
  // 「その人の最後」になって、まだ読んでいない一通に返事が付いてしまう。
  const heard = heardStatusId(acct);
  if (heard) return heard;

  const list = await api("/api/v1/conversations?limit=40");
  const hit = (Array.isArray(list) ? list : []).find(
    (c) => (c.accounts ?? []).length === 1 && c.accounts[0]?.acct === acct,
  );
  const last = hit?.last_status;
  if (!last) return null;

  const mine = await whoAmI();
  if (last.account?.id !== mine) return last.id;

  const ctx = await api(`/api/v1/statuses/${last.id}/context`);
  for (const s of [...(ctx?.ancestors ?? [])].reverse()) {
    if (s.account?.id !== mine) return s.id;
  }
  return null; // 相手がまだ何も言っていない ── ぶら下げずに置く
}

// DM でひとこと。宛名は自分で足す(sukhi は本文の @ で宛先が決まるので、忘れると 422)。
export async function say({ text, to = "nyanrus" }) {
  const replyTo = await lastFromThem(to);
  const status = await postJson("/api/v1/statuses", {
    status: `@${to} ${text}`,
    visibility: "direct",
    ...(replyTo ? { in_reply_to_id: replyTo } : {}),
  });
  return { url: status.url, id: status.id, chars: text.length };
}

// 「読んだよ」を、絵文字でいちばん軽く返す。
export async function ack({ emoji = "👀", to = "nyanrus", statusId }) {
  const id = statusId ?? (await lastFromThem(to));
  if (!id) return { error: `@${to} が最後に書いた一通が見つかりませんでした(二人きりの会話に、まだ相手の発言が無い)` };
  await api(`/api/v1/sukhi/statuses/${id}/react/${encodeURIComponent(emoji)}`, { method: "PUT" });
  return { ok: true, emoji, status_id: id };
}
