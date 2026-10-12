// sukhi のユーザーができること ── 人・投稿・反応・リスト・会話・整理・モデレーション・プロフィール。
//
// 声(sukhi.mjs の createSukhi)の api を借りて、Mastodon 互換の口をそのまま叩く。
// 口の一覧は sukhi-fedi の api/lib/sukhi_api/capabilities/*.ex の経路表から。ここに無いもの
// (ボットの作成・token を回す・アカウントの移行・admin・push)は、鍵や身元そのものを動かすので、道具にしない。
//
// 道具は意図ごとにまとめてある(action で選ぶ)。強い操作(消す・取り返しにくい)は
// tools.mjs の CONFIRM_ALWAYS にいて、確認が出る側のまま。

const MAX_LIMIT = 40;
const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || lo, lo), hi);

/**
 * @param {object} o
 * @param {(path: string, init?: object) => Promise<any>} o.api
 * @param {(path: string, body: object) => Promise<any>} o.postJson
 * @param {string} o.base         この声の sukhi の origin
 * @param {{account: Function, status: Function}} o.show   形を整える関数
 * @param {{rawStatusId: Function, statusIdFrom: Function}} o.ids   投稿の id を読む関数(sukhi.mjs のもの)
 */
export function createSocial({ api, postJson, base, show, ids: idOf }) {
  const query = (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) q.append(`${k}[]`, String(x));
      else q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  const put = (path, body) => api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const patch = (path, body) => api(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const del = (path, body) =>
    api(path, { method: "DELETE", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });

  // ── 人・投稿を指す ─────────────────────────────────────────────────────

  const notFound = (what, who) => Object.assign(new Error(`${what}が見つからなかった: ${who}`), { notFound: true });

  // user / user@host / 数字の id から、数字の id。別のサーバーの人は sukhi に探してもらう。
  async function accountId(who) {
    const text = String(who ?? "").trim().replace(/^@/, "");
    if (/^\d+$/.test(text)) return text;
    if (!text) throw new Error("人を指してください(user か user@host)。");
    try {
      return (await api(`/api/v1/accounts/lookup${query({ acct: text, resolve: 1 })}`)).id;
    } catch (e) {
      if (/HTTP 404/.test(e.message)) throw notFound("その人", `@${text}`);
      throw e;
    }
  }

  // 投稿の URL・数字の id・封筒入りの id のどれでも。
  const postId = (which) => (String(which ?? "").trim().startsWith("ap_") ? idOf.rawStatusId(which, base) : idOf.statusIdFrom(which, base));

  const page = (items, shaped) => ({
    count: shaped.length,
    ...(shaped.length ? { next_max_id: items.at(-1)?.id } : {}),
    items: shaped,
  });

  // ── 読む ───────────────────────────────────────────────────────────────

  // home 以外のタイムライン。home は sukhi_read_home。
  async function timeline({ kind, tag, listId, local, onlyMedia, limit = 20, maxId }) {
    const params = { limit: clamp(limit, 1, MAX_LIMIT), max_id: maxId };
    let path;
    if (kind === "public") {
      path = "/api/v1/timelines/public";
      params.local = local === false ? 0 : 1; // 既定はこの sukhi の中だけ
      if (onlyMedia) params.only_media = 1;
    } else if (kind === "tag") {
      if (!tag) throw new Error("tag の timeline には、タグ名が要ります。");
      path = `/api/v1/timelines/tag/${encodeURIComponent(String(tag).replace(/^#/, ""))}`;
      if (local) params.local = 1;
    } else if (kind === "list") {
      if (!listId) throw new Error("list の timeline には、list_id が要ります。");
      path = `/api/v1/timelines/list/${encodeURIComponent(listId)}`;
    } else throw new Error(`知らない種類: ${kind}`);
    const items = await api(`${path}${query(params)}`);
    return page(items, items.map(show.status));
  }

  async function postsOf({ who, limit = 20, maxId, onlyMedia, excludeReplies }) {
    const id = await accountId(who);
    const items = await api(
      `/api/v1/accounts/${encodeURIComponent(id)}/statuses${query({
        limit: clamp(limit, 1, MAX_LIMIT),
        max_id: maxId,
        only_media: onlyMedia ? 1 : undefined,
        exclude_replies: excludeReplies ? 1 : undefined,
      })}`,
    );
    return page(items, items.map(show.status));
  }

  async function people({ who, relation, limit = 20, maxId }) {
    const id = await accountId(who);
    const items = await api(`/api/v1/accounts/${encodeURIComponent(id)}/${relation}${query({ limit: clamp(limit, 1, MAX_LIMIT), max_id: maxId })}`);
    return page(items, items.map(show.account));
  }

  const showRelationship = (r, acct) => ({
    ...(acct ? { who: acct } : {}),
    id: r.id,
    following: Boolean(r.following),
    followed_by: Boolean(r.followed_by),
    requested: Boolean(r.requested),
    blocking: Boolean(r.blocking),
    muting: Boolean(r.muting),
    ...(r.note ? { note: r.note } : {}),
  });

  async function relationships({ who }) {
    const names = [].concat(who);
    const ids = await Promise.all(names.map(accountId));
    const list = await api(`/api/v1/accounts/relationships${query({ id: ids })}`);
    return { items: list.map((r) => showRelationship(r, names[ids.indexOf(r.id)] ? `@${String(names[ids.indexOf(r.id)]).replace(/^@/, "")}` : undefined)) };
  }

  async function thread({ which }) {
    const id = postId(which);
    try {
      const ctx = await api(`/api/v1/statuses/${encodeURIComponent(id)}/context`);
      return {
        found: true,
        id,
        ancestors: (ctx.ancestors ?? []).map(show.status),
        descendants: (ctx.descendants ?? []).map(show.status),
      };
    } catch (e) {
      if (!/HTTP 404/.test(e.message)) throw e;
      return { found: false, id, message: "見つからなかった。削除された投稿か、この声には見えない投稿のどちらか。" };
    }
  }

  async function search({ q, type, resolve, limit = 10 }) {
    const r = await api(`/api/v2/search${query({ q, type, resolve: resolve ? 1 : undefined, limit: clamp(limit, 1, MAX_LIMIT) })}`);
    return {
      accounts: (r.accounts ?? []).map(show.account),
      statuses: (r.statuses ?? []).map(show.status),
      hashtags: (r.hashtags ?? []).map((h) => ({ name: h.name, url: h.url })),
    };
  }

  // 自分の持ち物。投稿の入れもの(ブックマーク・お気に入り)と、人の入れもの。
  async function collection({ kind, limit = 20, maxId }) {
    const paths = {
      bookmarks: "/api/v1/bookmarks",
      favourites: "/api/v1/favourites",
      follow_requests: "/api/v1/follow_requests",
      blocks: "/api/v1/blocks",
      mutes: "/api/v1/mutes",
    };
    if (!paths[kind]) throw new Error(`知らない入れもの: ${kind}`);
    const items = await api(`${paths[kind]}${query({ limit: clamp(limit, 1, MAX_LIMIT), max_id: maxId })}`);
    return page(items, items.map(kind === "bookmarks" || kind === "favourites" ? show.status : show.account));
  }

  async function conversations({ limit = 20 }) {
    const items = await api(`/api/v1/conversations${query({ limit: clamp(limit, 1, MAX_LIMIT) })}`);
    return {
      count: items.length,
      items: items.map((c) => ({
        id: c.id,
        with: (c.accounts ?? []).map((a) => `@${a.acct}`),
        unread: Boolean(c.unread),
        ...(c.last_status ? { last: show.status(c.last_status) } : {}),
      })),
    };
  }

  const showList = (l) => ({ id: l.id, title: l.title, ...(l.replies_policy ? { replies_policy: l.replies_policy } : {}) });

  async function lists({ listId }) {
    if (!listId) return { items: (await api("/api/v1/lists")).map(showList) };
    const [list, members] = await Promise.all([
      api(`/api/v1/lists/${encodeURIComponent(listId)}`),
      api(`/api/v1/lists/${encodeURIComponent(listId)}/accounts${query({ limit: MAX_LIMIT })}`),
    ]);
    return { ...showList(list), members: members.map(show.account) };
  }

  async function poll({ id }) {
    const p = await api(`/api/v1/polls/${encodeURIComponent(id)}`);
    return showPoll(p);
  }

  const showPoll = (p) => ({
    id: p.id,
    expired: Boolean(p.expired),
    multiple: Boolean(p.multiple),
    voted: Boolean(p.voted),
    votes: p.votes_count,
    options: (p.options ?? []).map((o, i) => ({ index: i, title: o.title, votes: o.votes_count })),
    ...(p.own_votes ? { own_votes: p.own_votes } : {}),
  });

  // ── 人との関わり ───────────────────────────────────────────────────────

  async function follow({ who, action = "follow" }) {
    if (!["follow", "unfollow"].includes(action)) throw new Error(`知らない action: ${action}`);
    const id = await accountId(who);
    const r = await postJson(`/api/v1/accounts/${encodeURIComponent(id)}/${action}`, {});
    return { action, ...showRelationship(r, `@${String(who).replace(/^@/, "")}`) };
  }

  async function followRequest({ who, action }) {
    if (!["accept", "reject"].includes(action)) throw new Error(`知らない action: ${action}`);
    const id = await accountId(who);
    await postJson(`/api/v1/follow_requests/${encodeURIComponent(id)}/${action === "accept" ? "authorize" : "reject"}`, {});
    return { ok: true, action, who: `@${String(who).replace(/^@/, "")}` };
  }

  // その人への、自分だけが見える覚え書き。
  async function accountNote({ who, note }) {
    const id = await accountId(who);
    const r = await postJson(`/api/v1/accounts/${encodeURIComponent(id)}/note`, { comment: note });
    return showRelationship(r, `@${String(who).replace(/^@/, "")}`);
  }

  // ミュート・ブロック(取り返しにくい。強い操作)
  async function moderate({ who, action, notifications }) {
    if (!["mute", "unmute", "block", "unblock"].includes(action)) throw new Error(`知らない action: ${action}`);
    const id = await accountId(who);
    const body = action === "mute" && notifications !== undefined ? { notifications } : {};
    const r = await postJson(`/api/v1/accounts/${encodeURIComponent(id)}/${action}`, body);
    return { action, ...showRelationship(r, `@${String(who).replace(/^@/, "")}`) };
  }

  async function report({ who, which, comment, category }) {
    const id = await accountId(who);
    const r = await postJson("/api/v1/reports", {
      account_id: id,
      ...(which?.length ? { status_ids: which.map(postId) } : {}),
      comment,
      ...(category ? { category } : {}),
    });
    return { ok: true, id: r.id, who: `@${String(who).replace(/^@/, "")}` };
  }

  // ── 投稿への反応 ───────────────────────────────────────────────────────

  const INTERACT = {
    favourite: "favourite", unfavourite: "unfavourite",
    boost: "reblog", unboost: "unreblog",
    bookmark: "bookmark", unbookmark: "unbookmark",
    pin: "pin", unpin: "unpin",
  };

  async function interact({ which, action }) {
    const path = INTERACT[action];
    if (!path) throw new Error(`知らない action: ${action}`);
    const id = postId(which);
    const s = await postJson(`/api/v1/statuses/${encodeURIComponent(id)}/${path}`, {});
    // boost は、返ってくるのが「ブーストした投稿」で、中に元の投稿が入っている。
    return { action, ...show.status(s.reblog ?? s) };
  }

  async function react({ which, emoji, remove }) {
    const id = postId(which);
    const path = `/api/v1/sukhi/statuses/${encodeURIComponent(id)}/react/${encodeURIComponent(emoji)}`;
    await (remove ? del(path) : put(path, {}));
    return { ok: true, status_id: id, emoji, removed: Boolean(remove) };
  }

  async function pollVote({ id, choices }) {
    const p = await postJson(`/api/v1/polls/${encodeURIComponent(id)}/votes`, { choices });
    return showPoll(p);
  }

  // 自分の投稿を消す(取り返しがつかない。強い操作)。
  async function deletePost({ which }) {
    const id = postId(which);
    try {
      await del(`/api/v1/statuses/${encodeURIComponent(id)}`);
    } catch (e) {
      if (/HTTP 404/.test(e.message)) return { ok: false, id, message: "見つからなかった(もう消えているか、この声の投稿ではない)。" };
      if (/HTTP 40[13]/.test(e.message)) return { ok: false, id, message: "消せなかった(この声の投稿ではない)。" };
      throw e;
    }
    return { ok: true, id, deleted: true };
  }

  // ── リスト ─────────────────────────────────────────────────────────────

  async function manageList({ action, listId, title, who }) {
    const needId = () => {
      if (!listId) throw new Error(`${action} には list_id が要ります。`);
      return encodeURIComponent(listId);
    };
    if (action === "create") {
      if (!title) throw new Error("create には title が要ります。");
      return showList(await postJson("/api/v1/lists", { title }));
    }
    if (action === "rename") {
      if (!title) throw new Error("rename には title が要ります。");
      return showList(await put(`/api/v1/lists/${needId()}`, { title }));
    }
    if (action === "delete") {
      await del(`/api/v1/lists/${needId()}`);
      return { ok: true, list_id: listId, deleted: true };
    }
    if (action === "add_members" || action === "remove_members") {
      const ids = await Promise.all([].concat(who ?? []).map(accountId));
      if (ids.length === 0) throw new Error(`${action} には who が要ります。`);
      const path = `/api/v1/lists/${needId()}/accounts`;
      await (action === "add_members" ? postJson(path, { account_ids: ids }) : del(path, { account_ids: ids }));
      // 追加は、フォロー中の人だけが入る。入らなかった人は黙って飛ばされるので、見直して返す。
      const members = await api(`${path}${query({ limit: MAX_LIMIT })}`);
      const now = new Set(members.map((m) => String(m.id)));
      return { action, list_id: listId, members: members.map(show.account), left_out: ids.filter((id) => (action === "add_members") !== now.has(String(id))) };
    }
    throw new Error(`知らない action: ${action}`);
  }

  // ── 会話・通知の整理 ───────────────────────────────────────────────────

  async function tidy({ action, id }) {
    if (action === "dismiss_notification") {
      if (!id) throw new Error("dismiss_notification には id が要ります。");
      await postJson(`/api/v1/notifications/${encodeURIComponent(id)}/dismiss`, {});
      return { ok: true, action, id };
    }
    if (action === "read_conversation") {
      if (!id) throw new Error("read_conversation には id が要ります。");
      await postJson(`/api/v1/conversations/${encodeURIComponent(id)}/read`, {});
      return { ok: true, action, id };
    }
    throw new Error(`知らない action: ${action}`);
  }

  // 通知をぜんぶ消す(取り返しがつかない。強い操作)。
  async function clearNotifications() {
    await postJson("/api/v1/notifications/clear", {});
    return { ok: true, cleared: true };
  }

  // ── プロフィール ───────────────────────────────────────────────────────

  // この声自身のプロフィール(表示名・自己紹介・項目)。見える場所に出るので、強い操作。
  async function updateProfile({ displayName, note, bot, locked, fields }) {
    const body = {
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(bot !== undefined ? { bot } : {}),
      ...(locked !== undefined ? { locked } : {}),
      ...(fields ? { fields_attributes: Object.fromEntries(fields.map((f, i) => [String(i), { name: f.name, value: f.value }])) } : {}),
    };
    if (Object.keys(body).length === 0) throw new Error("変えるところを、ひとつは渡してください。");
    return show.account(await patch("/api/v1/accounts/update_credentials", body));
  }

  return {
    timeline, postsOf, people, relationships, thread, search, collection, conversations, lists, poll,
    follow, followRequest, accountNote, moderate, report,
    interact, react, pollVote, deletePost,
    manageList, tidy, clearNotifications, updateProfile,
  };
}
