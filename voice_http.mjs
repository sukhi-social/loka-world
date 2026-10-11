// 声を繋ぐ道。窓口にいる人が、ボットのアカウントで sukhi にログインして、その声を自分の部屋のものにする。
//
//   GET  /voice/connect                 窓口の設定ページから。sukhi の同意へ(read write の、声専用アプリ)
//   GET  /oauth/sukhi/voice-callback    sukhi からの戻り。token をしまって、耳を立てる
//   POST /voice/disconnect              声を外す(聞いた控えは残る)
//
// 戻ってきたとき、「いま窓口に入っている人」が「繋ぎにいった人」と同じかを必ず確かめる。
// そうでないと、他の人の声を、うっかり自分の部屋に繋げてしまう(逆も)。

import { accountFrom, signState, verifyState, visitOk } from "./auth.mjs";
import { sukhiAuthorizeUrl, sukhiBase, sukhiExchange, sukhiVerify } from "./sukhi_login.mjs";
import { ensureEar, stopEar } from "./sukhi_ears.mjs";
import { dropVoice, saveVoice } from "./voice.mjs";
import { escapeHtml, originOf, page, parseCookies, sendHtml } from "./web.mjs";

const STATE_TTL_MS = 10 * 60 * 1000;
const PATHS = new Set(["/voice/connect", "/voice/disconnect", "/oauth/sukhi/voice-callback"]);

const back = (res, query) => {
  res.writeHead(302, { location: `/settings?${query}` });
  res.end();
  return true;
};

const fail = (res, status, message) => {
  sendHtml(res, page(status, "声を繋ぐ", `<div class="card"><p>${escapeHtml(message)}</p></div><p><a href="/settings">設定へ戻る</a></p>`));
  return true;
};

export async function handleVoiceHttp(req, res, url) {
  const path = url.pathname;
  if (!PATHS.has(path)) return false;

  const cookies = parseCookies(req);
  const account = visitOk(req, cookies) ? accountFrom(req, cookies) : null;
  if (!account) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("合鍵が要ります。\n");
    return true;
  }

  if (path === "/voice/connect" && req.method === "GET") {
    try {
      const state = signState({ purpose: "voice", account, at: Date.now() });
      res.writeHead(302, { location: await sukhiAuthorizeUrl({ origin: originOf(req), state, kind: "voice" }) });
      res.end();
      return true;
    } catch (e) {
      return fail(res, 502, `sukhi と話せません: ${e.message}`);
    }
  }

  if (path === "/voice/disconnect" && req.method === "POST") {
    dropVoice(account);
    stopEar(account);
    ensureEar(account).catch(() => {}); // 持ち主なら、環境の声に戻る
    return back(res, "voice=dropped");
  }

  if (path === "/oauth/sukhi/voice-callback" && req.method === "GET") {
    const p = url.searchParams;
    const st = verifyState(p.get("state"));
    if (!st || st.purpose !== "voice" || !(Date.now() - st.at < STATE_TTL_MS))
      return fail(res, 400, "state が読めません(もう一度、設定ページから)。");
    if (st.account !== account)
      return fail(res, 403, "繋ぎにいった人と、いま入っている人が違います。もう一度、設定ページから。");
    if (p.get("error")) return fail(res, 400, `sukhi: ${p.get("error")}`);

    try {
      const tok = await sukhiExchange({ origin: originOf(req), code: p.get("code"), kind: "voice" });
      const me = await sukhiVerify(tok.access_token);
      const acct = String(me.acct ?? "").replace(/^@/, "");
      saveVoice(account, {
        base: sukhiBase(),
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        clientId: tok.client_id,
        clientSecret: tok.client_secret,
        scope: tok.scope,
        acct,
        // 聴く相手は、声を繋いだ人。ボットが自分自身で繋いだなら、聴く相手は居ない。
        watch: acct.toLowerCase() === account.toLowerCase() ? [] : [account],
        connectedAt: new Date().toISOString(),
      });
      ensureEar(account).catch(() => {}); // 待たない。立てられなくても、声は繋がっている
      return back(res, "voice=connected");
    } catch (e) {
      return fail(res, 502, `声を繋げませんでした: ${e.message}`);
    }
  }

  return false;
}
