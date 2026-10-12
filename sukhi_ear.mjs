// 耳。sukhi の direct ストリームを聴いて、nyanrus たちの DM だけ拾って、控える。
//
// 返事はしない。気づくだけ。何をするかは、聞いたあとの誰かが決める
// (控えは state/sukhi_inbox.jsonl。sukhi_inbox の道具で読める)。
//
// 口は WebSocket の direct 一本。SSE の /api/v1/streaming/user は notification しか
// 流さず、ローカル同士の DM は notification を立てないので、何も来ない。
//
// 居ない時間がある前提で書く(再起動もある)。繋がるたびに /api/v1/conversations を
// 見て、留守のあいだのぶんを拾い直す。ストリームは呼び鈴で、ほんとうのことは API に訊く。
//
// 垣根は sukhi_filter.mjs にある(書き直さない)。ここは、その外側 ──
// 聴く・拾い直す・控える。芯(createEar)は、ソケットなしで試験できる。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { conversationIsWith, decide, decideMention, decideStatus } from "./sukhi_filter.mjs";
import { heardFrom } from "./sukhi_text.mjs";

const SEEN_MAX = 500;
const INBOX_KEEP = 1000;
const BACKOFF_MAX_MS = 30_000;

// 別のサーバーから来た DM は、sukhi が direct の流れにも通知にも載せない(保存するだけ)。
// 会話の一覧には出るので、定期的に拾い直して聞く。0 で、定期はやめる(繋ぎなおしのときだけ)。
const pollSeconds = () => {
  const n = Number(process.env.SUKHI_EAR_POLL_SECONDS ?? 30);
  return Number.isFinite(n) && n >= 0 ? n : 30;
};

// snowflake は数字の文字列。数として比べる。
function newer(a, b) {
  if (b === null || b === undefined) return true;
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a.length === b.length ? a > b : a.length > b.length;
  }
}

// ── 控え ─────────────────────────────────────────────────────────────────
//
// 声(voice.mjs)の置き場の中に、三つ:
//   sukhi_inbox.jsonl  聞いた一通ずつ(seq つき)。出ていったぶん(itta)も。
//   sukhi_heard.json   人ごとに、最後に聞いた一通。sukhi_say / sukhi_ack の返す先。
//   sukhi_ear.json     どこまで見たか(lastSeen)。

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
};

const readLines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf-8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return []; // 壊れた一行は、飛ばす
          }
        })
    : [];

export function fileStore(dir) {
  const inbox = join(dir, "sukhi_inbox.jsonl");
  const earFile = join(dir, "sukhi_ear.json");
  const heardFile = join(dir, "sukhi_heard.json");

  // 起動のとき、古いぶんを刈る。seq は続きから。
  let events = readLines(inbox);
  if (events.length > INBOX_KEEP) {
    events = events.slice(-INBOX_KEEP);
    mkdirSync(dir, { recursive: true });
    writeFileSync(inbox, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  let seq = events.at(-1)?.seq ?? 0;

  return {
    // どこまで見たか。DM(direct の流れ)と mention(通知)は、別々の印を持つ。
    lastSeen: () => readJson(earFile, {}).lastSeen ?? null,
    saveLastSeen: (lastSeen) => writeJson(earFile, { ...readJson(earFile, {}), lastSeen }),
    lastSeenMention: () => readJson(earFile, {}).lastSeenMention ?? null,
    saveLastSeenMention: (lastSeenMention) => writeJson(earFile, { ...readJson(earFile, {}), lastSeenMention }),

    append(event) {
      const row = { seq: ++seq, at: new Date().toISOString(), ...event };
      mkdirSync(dir, { recursive: true });
      appendFileSync(inbox, `${JSON.stringify(row)}\n`);
      return row;
    },

    // 聞いた一通(kind: dm)だけ。出ていったぶんは、返す先にならない。
    hear(row) {
      if (!row.acct) return;
      const all = readJson(heardFile, {});
      all[row.acct] = { status_id: row.status_id, text: row.text, media: row.media?.length ?? 0, at: row.at };
      writeJson(heardFile, all);
    },
  };
}

// 控えを読む。since より後ろの、古いほうから limit 件。
export function readInbox({ dir, sinceSeq = 0, limit = 50 }) {
  const rows = readLines(join(dir, "sukhi_inbox.jsonl")).filter((e) => e.seq > sinceSeq);
  return { events: rows.slice(0, limit), has_more: rows.length > limit };
}

// ── 芯 ───────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {(path: string) => Promise<any>} o.api     sukhi の API(GET)
 * @param {{acct: string, uri: string}[]} o.watched  拾う相手
 * @param {string} o.me                              自分の account id(出ていったぶんを見分ける)
 * @param {ReturnType<typeof fileStore>} o.store
 * @param {(...a: any[]) => void} [o.log]
 */
export function createEar({ api, watched, me, store, log = () => {} }) {
  const uris = watched.map((w) => w.uri);
  const acctByUri = new Map(watched.map((w) => [w.uri, w.acct]));

  // 印の意味は「拾う相手のを、どこまで読んだか」。よその人の一通では動かさない
  // ── 動かすと、その手前にある未読を、拾い直しが飛び越してしまう。
  let lastSeen = store.lastSeen();
  const markSeen = (id) => {
    if (!newer(id, lastSeen)) return;
    lastSeen = id;
    store.saveLastSeen(lastSeen);
  };

  // mention 通知の印。通知の id で数える(status の id とは別の並び)。
  let lastSeenMention = store.lastSeenMention();
  const markSeenMention = (id) => {
    if (!id || !newer(id, lastSeenMention)) return;
    lastSeenMention = id;
    store.saveLastSeenMention(lastSeenMention);
  };

  const seen = new Set();
  const remember = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    return true;
  };

  // kind: dm(direct の流れで聞こえた)か mention(通知で、名前を呼ばれた)。
  // DM のぶんだけ、「聞いた一通」(sukhi_say / sukhi_ack の返す先)として覚える。
  const heard = (d, conversationId, { kind = "dm", ...extra } = {}) => {
    const row = store.append({
      kind,
      acct: acctByUri.get(d.fromUri) ?? null,
      text: heardFrom(d.text),
      status_id: d.statusId,
      conversation_id: conversationId ?? null,
      ...(kind === "mention" ? { visibility: d.visibility } : {}),
      media: d.media ?? [],
      ...extra,
    });
    if (kind === "dm") store.hear(row);
    log(`拾った  ${extra.late ? "(留守のぶん) " : ""}${kind} @${row.acct} status=${d.statusId}`);
    return row;
  };

  // 拾い直しの最中に来たものは、いったん脇に置く。途中で印が動くと、
  // まさに読もうとしていた一通を飛び越すので。
  let catchingUp = false;
  const queued = [];

  function handleFrame(raw) {
    if (catchingUp) {
      queued.push(raw);
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.event !== "conversation" && frame.event !== "notification") return;

    // Mastodon は payload を二重に JSON 文字列化する。
    let payload = frame.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }

    if (frame.event === "notification") return handleNotification(payload);

    // 出ていったぶん。自分の名前で何が言われたかは、ここでしか知れない。
    // 外に出たという事実で、「言えた」が分かる(自己申告ではなく)。
    const last = payload?.last_status;
    if (last?.account?.id === me) {
      if (!remember(last.id)) return;
      const other = (payload.accounts ?? []).find((a) => a.id !== me);
      store.append({
        kind: "itta",
        acct: other?.acct ?? null,
        text: heardFrom(last.content ?? ""),
        status_id: last.id,
        conversation_id: payload.id ?? null,
      });
      return;
    }

    // ここが垣根。通らなかったものは、出来事にならない。
    const d = decide(payload, uris);
    if (!d.ok) return;
    if (!remember(d.statusId)) {
      markSeen(d.statusId);
      return;
    }
    heard(d, payload.id);
    markSeen(d.statusId);
  }

  // 名前を呼ばれた(mention 通知)。DM は direct の流れのほうが決めるので、ここでは通らない。
  function handleNotification(payload) {
    const d = decideMention(payload, uris);
    if (!d.ok) return;
    markSeenMention(d.notificationId);
    if (!remember(d.statusId)) return;
    heard(d, null, { kind: "mention" });
  }

  // 拾い直しの最中に来たフレームは、DM も mention も、ぜんぶ脇に置く(終わってから処理する)。
  async function catchUp() {
    if (catchingUp) return; // 走っているあいだに、もう一度呼ばれても重ねない
    catchingUp = true;
    try {
      await catchUpInner();
      await catchUpMentions();
    } finally {
      catchingUp = false;
      for (const raw of queued.splice(0)) handleFrame(raw);
    }
  }

  async function catchUpMentions() {
    let list;
    try {
      list = await api("/api/v1/notifications?types[]=mention&limit=40");
    } catch (e) {
      log(`mention の留守のぶんを見にいけなかった: ${e.message}`);
      return;
    }
    if (!Array.isArray(list)) return;

    // はじめての起動なら、過去を蒸し返さず、いまの位置から聴く。
    if (lastSeenMention === null) {
      for (const n of list) markSeenMention(n.id);
      log(`mention も、いまの位置(${lastSeenMention ?? "なし"})から聴きます。`);
      return;
    }

    const pending = list
      .filter((n) => newer(n.id, lastSeenMention))
      .map((n) => ({ n, d: decideMention(n, uris) }))
      .sort((x, y) => (newer(x.n.id, y.n.id) ? 1 : -1)); // 古いほうから
    for (const { n, d } of pending) {
      markSeenMention(n.id); // 通らなかった通知も、印は進める(読んだ、という意味で)
      if (d.ok && remember(d.statusId)) heard(d, null, { kind: "mention", late: true });
    }
  }

  async function catchUpInner() {
    let convs;
    try {
      convs = await api("/api/v1/conversations");
    } catch (e) {
      log(`留守のぶんを見にいけなかった: ${e.message}`);
      return;
    }
    if (!Array.isArray(convs)) return;

    // 会話を選ぶのは「二人きりか」だけで決める。誰が最後に書いたかは見ない
    // ── 返事をすると last_status は自分のものになるので、そこで会話ごと落とすと、
    // 裏に残っている相手の未読まで一緒に消える。
    const mine = convs.filter((c) => conversationIsWith(c, uris).ok && c.last_status?.id);

    // はじめての起動なら、過去をぜんぶ蒸し返さない。いまの位置から聴く。
    if (lastSeen === null) {
      for (const c of mine) markSeen(c.last_status.id);
      log(`はじめまして。いまの位置(${lastSeen ?? "なし"})から聴きます。`);
      return;
    }

    const pending = [];
    for (const c of mine) {
      const last = c.last_status;
      if (!newer(last.id, lastSeen)) continue;

      // 会話の途中の何通かも拾いたい。会話を列で返す口が無いので、返信鎖を辿る。
      // 注意: 鎖に乗っていない一通(スレッドの外から新しく書いた DM)は、拾えない。
      let ancestors = [];
      try {
        const ctx = await api(`/api/v1/statuses/${encodeURIComponent(last.id)}/context`);
        if (Array.isArray(ctx?.ancestors)) ancestors = ctx.ancestors;
      } catch (e) {
        log(`途中のぶんが辿れなかった (${e.message}) — 最後の一通だけ拾います`);
      }

      // 書いた人は、その会話の相手その人。狭いほうで照らす。
      const withUri = conversationIsWith(c, uris).withUri;
      for (const a of [...ancestors, last]) {
        if (!newer(a.id, lastSeen)) continue;
        const d = decideStatus(a, withUri);
        if (d.ok) pending.push({ ...d, fromUri: withUri, conversationId: c.id });
      }
    }
    if (pending.length === 0) return;

    // 古いものから順に。逆だと、文脈が後ろから届く。
    pending.sort((x, y) => (newer(x.statusId, y.statusId) ? 1 : -1));
    log(`留守のあいだに ${pending.length} 通。古いほうから読みます。`);
    for (const p of pending) {
      if (!remember(p.statusId)) continue;
      heard(p, p.conversationId, { late: true });
      markSeen(p.statusId);
    }
  }

  return { handleFrame, catchUp, lastSeen: () => lastSeen };
}

// ── 聴く ─────────────────────────────────────────────────────────────────

// 名簿を actor URI に直す。引けなかった人は黙って外す
// ── まだアカウントを作っていない相手を、名前だけ並べておけるように。
export async function lookupWatched(api, accts, log) {
  const out = [];
  for (const acct of accts) {
    try {
      const uri = (await api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}&resolve=1`)).uri;
      if (uri) out.push({ acct, uri });
    } catch (e) {
      log(`(まだ居ないみたい: @${acct} — ${e.message})`);
    }
  }
  return out;
}

/**
 * 耳を立てる。切れたら、黙って繋ぎ直す(切断そのものは出来事ではない)。
 * @param {object} o
 * @param {ReturnType<import("./sukhi.mjs").createSukhi>} o.sukhi  この耳の声
 * @param {string[]} o.accts  聴く相手
 * @param {string} o.dir      控えの置き場(声の dir)
 */
export async function startEar({ sukhi, accts, dir, log = console.error }) {
  const { api, streamUrl } = sukhi;
  const watched = await lookupWatched(api, accts, log);
  if (watched.length === 0) throw new Error("見る相手が一人も引けませんでした");
  const me = (await api("/api/v1/accounts/verify_credentials")).id;
  const ear = createEar({ api, watched, me, store: fileStore(dir), log });
  log(`耳: ${watched.map((w) => `@${w.acct}`).join(" ")}  最後=${ear.lastSeen() ?? "(まだ何も)"}`);

  let backoff = 1000;
  let stopping = false;
  let ws = null;
  let timer = null;

  const connect = () => {
    if (stopping) return;
    ws = new WebSocket(streamUrl("direct"));
    ws.addEventListener("open", () => {
      backoff = 1000;
      // direct(DM)は繋ぐときに選んである。名前を呼ばれたぶん(mention 通知)は user の流れ。
      ws.send(JSON.stringify({ type: "subscribe", stream: "user" }));
      // 繋がった「あと」に拾い直す。逆だと、その隙間がまた空く。
      ear.catchUp().catch((e) => log(`拾い直しで転んだ: ${e.message}`));
    });
    ws.addEventListener("message", (ev) => ear.handleFrame(ev.data));
    ws.addEventListener("error", () => {}); // close も呼ばれる。繋ぎ直しは close だけで持つ。
    ws.addEventListener("close", () => {
      if (stopping) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    });
  };
  connect();

  // 流れが切れているあいだも、流れに載らない DM があるので、流れとは別に回す。
  const every = pollSeconds();
  const poll = every > 0 ? setInterval(() => ear.catchUp().catch((e) => log(`拾い直しで転んだ: ${e.message}`)), every * 1000) : null;

  return {
    stop() {
      stopping = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      ws?.close();
    },
  };
}
