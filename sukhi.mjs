// sukhi(fediverse)との話し口。シロの声が、外に届く場所。
//
// 声(voice.mjs)ひとつにつき、話し口をひとつ作る(createSukhi)。アカウントごとに
// 別のボットの声を持てるので、鍵も、既読位置も、聞いた控えも、声の中に閉じている。
//
// ActivityPlug の mastodon アダプタを sukhi に挿して使う。読む・置く・返すは ActivityPlug
// (id は封筒入り ap_1_…)。ActivityPlug に無い面(markers・会話・絵文字リアクション)だけ、
// 素の fetch で足す。
//
// access_token が切れたら、声に refresh_token があれば取り直して、声ごと保存しなおす。
//
// 「未読」の位置は、サーバー側の /api/v1/markers(notifications)。
// sukhi の SPA はこの marker を触らないので、ここはシロの既読位置としてまるごと使える。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createActivityPlugClient, createRemoteAuthority, decodeOpaqueId } from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";

import { createSocial } from "./sukhi_social.mjs";
import { loadVoice, saveVoice } from "./voice.mjs";

const FETCH_TIMEOUT_MS = 15_000;

// ActivityPlug は、通信の窓口(remoteAuthority)を渡されないと外へ出ない。素の fetch は受けないので、
// 包んだ関数を渡す。窓口が、行き先を声の base だけに、認証の情報を同じ origin だけに、閉じてくれる。
const remoteAuthority = createRemoteAuthority({
  transport: (request) => fetch(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) }),
});
const UNREAD_PROBE_LIMIT = 40;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

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

// 人のプロフィール。Mastodon の account の形から、読むのに要るところだけ。
export function showAccount(a) {
  const fields = (a.fields ?? []).map((f) => ({
    name: f.name,
    value: trimHtml(f.value, 200),
    ...(f.verified_at ? { verified: true } : {}),
  }));
  return {
    id: a.id,
    acct: `@${a.acct}`,
    display_name: a.display_name ?? "",
    bio: trimHtml(a.note, 800),
    ...(fields.length > 0 ? { fields } : {}),
    followers: a.followers_count,
    following: a.following_count,
    posts: a.statuses_count,
    bot: Boolean(a.bot),
    locked: Boolean(a.locked),
    created_at: a.created_at,
    url: a.url,
    avatar: a.avatar,
    header: a.header,
  };
}

// Mastodon の status の形から、読むのに要るところだけ(タイムライン・お気に入り・スレッドなど)。
// ブーストは、元の投稿を見せて、誰がブーストしたかを添える。
export function showRawStatus(j) {
  const s = j.reblog ?? j;
  const mine = ["favourited", "reblogged", "bookmarked", "pinned"].filter((k) => s[k]);
  return {
    id: j.id,
    url: s.url,
    author: `@${s.account?.acct}`,
    display_name: s.account?.display_name ?? "",
    ...(j.reblog ? { boosted_by: `@${j.account?.acct}` } : {}),
    text: trimHtml(s.content),
    ...(s.spoiler_text ? { content_warning: s.spoiler_text } : {}),
    visibility: s.visibility,
    created_at: s.created_at,
    ...(s.in_reply_to_id ? { in_reply_to_id: s.in_reply_to_id } : {}),
    counts: { replies: s.replies_count ?? 0, boosts: s.reblogs_count ?? 0, favourites: s.favourites_count ?? 0 },
    ...(mine.length ? { by_me: mine } : {}),
    ...withMedia(showMedia(s.media_attachments)),
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

// 公開範囲の広さ。返事は、元の投稿より広くしない。followers は private の言い換え。
const WIDTH = { direct: 0, private: 1, followers: 1, unlisted: 2, public: 3 };
const normalize = (v) => (v === "followers" ? "private" : v);

// 生の id でも、封筒入りの id(ap_1_…)でも受けて、生の id を返す。
// 封筒は、投稿の id で、この声のサーバーのものであるときだけ開く。
export function rawStatusId(value, base) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("ap_")) return text;
  let raw;
  try {
    raw = decodeOpaqueId(text);
  } catch {
    throw new Error("封筒入りの id(ap_1_…)が読めません。読む道具が返した id を、そのまま渡してください。");
  }
  if (raw.type !== "post") throw new Error(`その id は投稿の id ではありません(${raw.type})。`);
  if (new URL(raw.origin).host !== new URL(base).host) throw new Error("その id は別のサーバーのものです。");
  return raw.id;
}

// 投稿の URL か id から、id を取り出す。sukhi の URL(/@acct/<id> か /users/<acct>/notes/<id>)だけ受ける。
export function statusIdFrom(which, base) {
  const text = String(which ?? "").trim();
  if (/^\d+$/.test(text)) return text;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error("投稿の id か、sukhi の投稿の URL を渡してください。");
  }
  if (u.host !== new URL(base).host) throw new Error(`この声が見られるのは ${new URL(base).host} の投稿だけです(${u.host} は見られません)。`);
  const m = u.pathname.match(/\/(\d+)\/?$/);
  if (!m) throw new Error("URL から投稿の id が読めませんでした(/@acct/<id> の形)。");
  return m[1];
}

const SEEN_ONLY_BY = {
  private: "フォロワー限定。フォローしている人にしか見えず、外から(ログインせずに)開くと 404 に見える。",
  direct: "DM。宛先の人にしか見えず、外から開くと 404 に見える。",
};

// ActivityPlug の語彙では followers。Mastodon の private もその意味なので、そちらに寄せる。
const toVisibility = (v) => (v === "private" ? "followers" : v);

// sukhi の id は snowflake(数字の文字列)。数として比べる。
function idNewer(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a.length === b.length ? a > b : a.length > b.length;
  }
}

// ── 話し口 ───────────────────────────────────────────────────────────────

/**
 * @param {object} voice    voice.mjs の声(base / accessToken / refreshToken / dir …)。取り直すと書き換わる。
 * @param {(voice: object) => void} [persist]  取り直したあと、声を保存しなおす。
 */
export function createSukhi(voice, persist = () => {}) {
  const base = voice.base.replace(/\/+$/, "");

  // ActivityPlug の client / session(取り直したら、session だけ作りなおす)
  let clientCache = null;
  let sessionCache = null;

  // ── 鍵の取り直し ───────────────────────────────────────────────────────

  async function refreshAccessToken() {
    if (!voice.clientId || !voice.clientSecret || !voice.refreshToken) {
      throw new Error("access_token を取り直すには、client_id / client_secret / refresh_token が要ります。");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: voice.clientId,
      client_secret: voice.clientSecret,
      refresh_token: voice.refreshToken,
    });
    if (voice.scope) form.set("scope", voice.scope);

    const resp = await fetch(`${base}/oauth/token`, { method: "POST", body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`refresh に失敗しました: HTTP ${resp.status}`);
    const payload = await resp.json();
    if (!payload.access_token) throw new Error("refresh の応答に access_token がありません");

    voice.accessToken = payload.access_token;
    if (payload.refresh_token) voice.refreshToken = payload.refresh_token;
    sessionCache = null;
    persist(voice);
  }

  const client = () => (clientCache ??= createActivityPlugClient({ adapter: createMastodonAdapter(), origin: base, remoteAuthority }));
  const session = async () => (sessionCache ??= await client().auth.injectToken({ accessToken: voice.accessToken }));

  // 認証エラーなら一度だけ取り直して、やり直す。
  async function withAuth(fn) {
    try {
      return await fn(client(), await session());
    } catch (error) {
      const expired = error?.code === "AUTH_REQUIRED" || error?.code === "AUTH_EXPIRED";
      if (!expired || !voice.refreshToken) throw error;
      await refreshAccessToken();
      return await fn(client(), await session());
    }
  }

  // ActivityPlug にまだ無い面は、ここから素の fetch で。
  // 401 なら、withAuth と同じく一度だけ取り直して、やり直す。
  async function api(path, init = {}, retried = false) {
    const resp = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${voice.accessToken}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.status === 401 && !retried && voice.refreshToken) {
      await refreshAccessToken();
      return api(path, init, true);
    }
    if (!resp.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${resp.status}`);
    return resp.json();
  }

  const postJson = (path, body) =>
    api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // streaming の WebSocket。耳が使う。繋ぎ直すたびに呼ぶ(取り直した token を拾うため)。
  const streamUrl = (stream) =>
    `${base.replace(/^http/, "ws")}/api/v1/streaming?stream=${stream}&access_token=${encodeURIComponent(voice.accessToken)}`;

  // ── 未読(markers)──────────────────────────────────────────────────────

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

  // ── 読む ───────────────────────────────────────────────────────────────

  async function readHome({ limit = 20 } = {}) {
    const page = await withAuth((c, s) => c.timelines.home({ session: s, page: { limit } }));
    return page.nodes.map(showPost);
  }

  // 人のプロフィール。ActivityPlug の mastodon アダプタにはまだ無い面なので、素の fetch で。
  // user でも user@host でもよい(他のサーバーの人は、sukhi が探しに行く)。見つからなければ、そう伝える。
  // 投稿ひとつの様子。「削除された」と「この声には見えない」は、sukhi からは同じ 404 に見える。
  // 見つからないときは、その二つのどちらかだと、はっきり言う(外から開いたときの 404 とも、同じ見えかた)。
  async function readStatus({ which }) {
    const id = statusIdFrom(which, base);
    try {
      const j = await api(`/api/v1/statuses/${encodeURIComponent(id)}`);
      return {
        found: true,
        id: j.id,
        url: j.url,
        author: `@${j.account?.acct}`,
        visibility: j.visibility,
        ...(SEEN_ONLY_BY[normalize(j.visibility)] ? { note: SEEN_ONLY_BY[normalize(j.visibility)] } : {}),
        in_reply_to_id: j.in_reply_to_id ?? null,
        reply: j.in_reply_to_id ? "返信" : "返信ではない(ひとつの投稿)",
        created_at: j.created_at,
        text: trimHtml(j.content),
        ...withMedia(showMedia(j.media_attachments)),
      };
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      return {
        found: false,
        id,
        message:
          "見つからなかった。削除された投稿か、この声には見えない投稿(相手のフォロワー限定・DM など)のどちらか。" +
          "sukhi は、この二つを区別して返さない。",
      };
    }
  }

  async function readProfile({ who }) {
    const acct = String(who).trim().replace(/^@/, "");
    try {
      return showAccount(await api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}&resolve=1`));
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      return { found: false, who: `@${acct}`, message: "その人は見つからなかった。つづりと、@host の部分を見なおしてみる。" };
    }
  }

  // 既読位置は動かさない。
  async function readMentions({ limit = 20 } = {}) {
    const page = await withAuth((c, s) => c.notifications.list({ session: s, types: ["mention"], page: { limit } }));
    return page.nodes.map(showNotification);
  }

  // markRead なら、読んだところまで既読になる。
  async function readNotifications({ limit = 20, markRead = true } = {}) {
    const page = await withAuth((c, s) => c.notifications.list({ session: s, page: { limit } }));
    if (markRead && page.nodes.length > 0) await advanceNotificationsMarker(page.nodes[0].ref.rawId);
    return page.nodes.map(showNotification);
  }

  // marker より新しい通知をかぞえる。probe の窓より多いときは plus=true。
  async function unreadSummary() {
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

  // ── 置く・返す ─────────────────────────────────────────────────────────

  async function post({ text, visibility = "unlisted", inReplyToId }) {
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

  // 元の投稿に返す。**公開範囲は、元に合わせる**(広がらない)。
  // 公開で呼ばれたなら公開で、DM なら DM で、未収載なら未収載で。狭くするのは頼める。
  // 生の id(控えの mention の status_id)でも、封筒入りの id(sukhi_read_mentions の status_id)でもよい。
  //
  // **返す先が見つからなければ、返信としては投稿しない。** sukhi は、存在しない(見えない)返信先を
  // エラーにせず、返信先だけ落として、ふつうの投稿として受けてしまう。ActivityPlug の封筒の道は
  // 返信先を確かめずに送るので、以前は、削除された投稿への「返信」が、ひとつの投稿になっていた。
  async function replyTo({ statusId, text, visibility }) {
    const id = rawStatusId(statusId, base);
    let original;
    try {
      original = await api(`/api/v1/statuses/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      throw new Error(
        "返信先の投稿が見つかりません。削除されたか、この声には見えない投稿(相手のフォロワー限定・DM など)です。" +
          "返信としては投稿しませんでした。単独の投稿として置きたいなら sukhi_post を使ってください。",
      );
    }
    const base_ = normalize(original.visibility ?? "public");
    const asked = visibility ? normalize(visibility) : null;
    const chosen = asked && (WIDTH[asked] ?? 3) < (WIDTH[base_] ?? 3) ? asked : base_;

    // 宛名は自分で足す(DM は本文の @ で宛先が決まる。公開でも、呼んだ人に通知が届く)。
    const acct = original.account?.acct;
    const body = acct && !text.trimStart().startsWith(`@${acct}`) ? `@${acct} ${text}` : text;

    const status = await postJson("/api/v1/statuses", { status: body, visibility: chosen, in_reply_to_id: original.id ?? id });
    const linked = Boolean(status.in_reply_to_id);
    const notes = [
      ...(asked && chosen !== asked ? [`元の投稿(${base_})より広くはしないので、${chosen} で返しました。`] : []),
      ...(linked ? [] : ["投稿はできたが、sukhi が返信先を付けなかった(返信としては繋がらなかった)。ひとつの投稿として見える。"]),
    ];
    return { url: status.url, id: status.id, visibility: chosen, linked, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  // ── DM(say / ack)──────────────────────────────────────────────────────
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
  // ぶら下がらないように。耳も二人きりのぶんしか通さない。

  let myId = null;
  async function whoAmI() {
    myId ??= (await api("/api/v1/accounts/verify_credentials"))?.id ?? null;
    return myId;
  }

  // 耳が最後に通した一通。人ごとに一つ、声の中の sukhi_heard.json に控えてある。
  // 毎回読み直す(覚えると、新しいのを聞いても古いところに返し続ける)。
  // 無い・壊れている ── どれも同じ扱いで、静かに null。
  const heardStatusId = (acct) =>
    voice.dir ? (readJson(join(voice.dir, "sukhi_heard.json"))?.[acct]?.status_id ?? null) : null;

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
  async function say({ text, to }) {
    const replyTo = await lastFromThem(to);
    const status = await postJson("/api/v1/statuses", {
      status: `@${to} ${text}`,
      visibility: "direct",
      ...(replyTo ? { in_reply_to_id: replyTo } : {}),
    });
    return { url: status.url, id: status.id, chars: text.length };
  }

  // 「読んだよ」を、絵文字でいちばん軽く返す。
  async function ack({ emoji = "👀", to, statusId }) {
    const id = statusId ?? (await lastFromThem(to));
    if (!id) return { error: `@${to} が最後に書いた一通が見つかりませんでした(二人きりの会話に、まだ相手の発言が無い)` };
    await api(`/api/v1/sukhi/statuses/${id}/react/${encodeURIComponent(emoji)}`, { method: "PUT" });
    return { ok: true, emoji, status_id: id };
  }

  // 人・投稿・反応・リスト・会話・整理・モデレーション・プロフィール(sukhi_social.mjs)
  const social = createSocial({
    api,
    postJson,
    base,
    show: { account: showAccount, status: showRawStatus },
    ids: { rawStatusId, statusIdFrom },
  });

  return { voice, social, api, streamUrl, readHome, readProfile, readStatus, readMentions, readNotifications, unreadSummary, post, replyTo, say, ack };
}

// ── アカウントの声 ────────────────────────────────────────────────────────

const cache = new Map();

/**
 * そのアカウントの話し口。声が無ければ null。
 * 繋ぎなおされたら(connectedAt が変わったら)作りなおす。
 */
export function sukhiFor(account) {
  const voice = loadVoice(account);
  if (!voice) return null;
  const hit = cache.get(account);
  if (hit && hit.stamp === voice.connectedAt) return hit.sukhi;
  const sukhi = createSukhi(voice, (v) => saveVoice(account, v));
  cache.set(account, { stamp: voice.connectedAt, sukhi });
  return sukhi;
}
