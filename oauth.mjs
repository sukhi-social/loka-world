// OAuth 2.1 の最小のシム。Web の AI のコネクタ登録を通すためだけのもの。
//
//   /.well-known/oauth-protected-resource     この resource の AS はここ
//   /.well-known/oauth-authorization-server   AS のメタデータ
//   POST /oauth/register                      DCR(client_id を発行)
//   GET  /oauth/authorize                     合鍵を尋ねるページ
//   POST /oauth/authorize                     合鍵を見て code を返す
//   POST /oauth/token                         code / refresh を token に
//
// 個人の一人用なので、同意は「合鍵を一度入れるだけ」。玄関(genkan)の文化を
// そのまま持ち込む。PKCE(S256)は必須で、redirect_uri は登録したものだけ。

import { createHash } from "node:crypto";

import {
  clientSecretOk,
  getClient,
  makeCode,
  redirectAllowed,
  registerClient,
  signState,
  takeCode,
  takeRefresh,
  issueTokens,
  passphraseOk,
  verifyState,
  visitCookieHeader,
  accountCookieHeader,
} from "./auth.mjs";
import { accountAllowed, sukhiAuthorizeUrl, sukhiExchange, sukhiVerify } from "./sukhi_login.mjs";
import { escapeHtml, originOf, page, parseCookies, readBody, sendHtml, sendJson } from "./web.mjs";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };

function pkceOk(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const h = createHash("sha256").update(verifier).digest("base64url");
  return h === challenge;
}

function protectedResource(origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["world", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  };
}

function authServer(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: ["world", "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  };
}

function errorRedirect(res, redirectUri, state, code, description) {
  const u = new URL(redirectUri);
  u.searchParams.set("error", code);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  res.writeHead(302, { location: u.toString() });
  res.end();
}

function authorizeForm(origin, params, message) {
  const hidden = [...params.entries()]
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const body = `
  <div class="card">
    <p>AI に、シロの部屋への入口を渡します。</p>
    <p><a href="/oauth/sukhi/start?${escapeHtml(params.toString())}">sukhi アカウントでログインして渡す</a>
       <span class="muted">(推奨)</span></p>
    <hr>
    <p class="muted">または、合鍵を入れて渡す:</p>
    ${message ? `<p class="muted">${escapeHtml(message)}</p>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <input type="password" name="passphrase" autocomplete="current-password" placeholder="合鍵">
      <p><button type="submit">合鍵で渡す</button></p>
    </form>
  </div>`;
  return page(200, "入口を渡す", body);
}

// req/res を扱ったら true を返す。
export async function handleOAuth(req, res, url) {
  const origin = originOf(req);
  const path = url.pathname;

  if (req.method === "OPTIONS" && (path.startsWith("/oauth/") || path.startsWith("/.well-known/"))) {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    return sendJson(res, 200, protectedResource(origin), CORS), true;
  }

  if (path === "/.well-known/oauth-authorization-server") {
    return sendJson(res, 200, authServer(origin), CORS), true;
  }

  // ── sukhi でログイン ──────────────────────────────────────────────────
  //
  // 人間が sukhi のアカウントでログインし、その人に入口(鍵)を渡す。
  //   /oauth/sukhi/login    … 人間が自分の鍵を取りに来る(その場に表示)
  //   /oauth/sukhi/start    … MCP クライアントへの同意(sukhi の後、code を返す)
  //   /oauth/sukhi/callback … sukhi からの戻り
  if (path === "/oauth/sukhi/login" && req.method === "GET") {
    try {
      const state = signState({ purpose: "key" });
      res.writeHead(302, { location: await sukhiAuthorizeUrl({ origin: originOf(req), state }) });
      res.end();
    } catch (e) {
      return sendHtml(res, page(502, "sukhi と話せません", `<p>${escapeHtml(e.message)}</p>`)), true;
    }
    return true;
  }

  if (path === "/oauth/sukhi/start" && req.method === "GET") {
    const p = url.searchParams;
    const client = getClient(p.get("client_id"));
    if (!client || !redirectAllowed(client, p.get("redirect_uri")))
      return sendHtml(res, page(400, "入口を渡せません", "<p>client か redirect_uri が違います。</p>")), true;
    try {
      const state = signState({
        purpose: "client",
        client_id: p.get("client_id"),
        redirect_uri: p.get("redirect_uri"),
        state: p.get("state") ?? "",
        code_challenge: p.get("code_challenge") ?? null,
        scope: p.get("scope") ?? "world",
        resource: p.get("resource") ?? null,
      });
      res.writeHead(302, { location: await sukhiAuthorizeUrl({ origin: originOf(req), state }) });
      res.end();
    } catch (e) {
      return sendHtml(res, page(502, "sukhi と話せません", `<p>${escapeHtml(e.message)}</p>`)), true;
    }
    return true;
  }

  if (path === "/oauth/sukhi/callback" && req.method === "GET") {
    const p = url.searchParams;
    const st = verifyState(p.get("state"));
    if (!st) return sendHtml(res, page(400, "ログイン", "<p>state が読めません。もう一度、最初から。</p>")), true;
    if (p.get("error")) return sendHtml(res, page(400, "ログイン", `<p>sukhi: ${escapeHtml(p.get("error"))}</p>`)), true;
    try {
      const tok = await sukhiExchange({ origin: originOf(req), code: p.get("code") });
      const me = await sukhiVerify(tok.access_token);
      const acct = String(me.acct ?? "").replace(/^@/, "");
      if (!accountAllowed(acct))
        return sendHtml(res, page(403, "通せません", `<p>@${escapeHtml(acct)} は、この部屋の許容に居ません。</p>`)), true;

      if (st.purpose === "key") {
        const t = issueTokens({ clientId: "sukhi-login", scope: "world" });
        const rooms = [
          ["共有ドライブ", "/"],
          ["机(desk)", "/peek?path=desk"],
          ["書庫(library)", "/peek?path=library"],
          ["成果(achievements)", "/peek?path=achievements"],
          ["公開の日記", "/"],
        ];
        const roomItems = rooms.map(([label, href]) => `<li><a href="${href}">${escapeHtml(label)}</a></li>`).join("");
        const body = `<div class="card">
          <p>@${escapeHtml(acct)} として入れました。これで、この部屋に入れます。</p>
          <p class="muted">AI に渡す鍵:</p>
          <p><code style="word-break:break-all">${escapeHtml(t.access_token)}</code></p>
          <p class="muted">AI に渡すときは、この鍵を Bearer トークンとして使わせてください。
            期限は ${Math.round(t.expires_in / 86400)} 日。</p>
        </div>
        <div class="card">
          <h2>入れる部屋</h2>
          <ul>${roomItems}</ul>
        </div><p><a href="/">窓口へ</a></p>`;
        return sendHtml(
          res,
          page(200, "鍵", body),
          [["set-cookie", [visitCookieHeader(req), accountCookieHeader(req, acct)]]],
        ), true;
      }

      // MCP クライアントへの同意 ── 元の要求に code を返す。
      const code = makeCode({
        clientId: st.client_id,
        redirectUri: st.redirect_uri,
        codeChallenge: st.code_challenge,
        scope: st.scope,
        resource: st.resource,
        account: acct,
      });
      const u = new URL(st.redirect_uri);
      u.searchParams.set("code", code);
      if (st.state) u.searchParams.set("state", st.state);
      res.writeHead(302, { location: u.toString() });
      res.end();
      return true;
    } catch (e) {
      return sendHtml(res, page(502, "sukhi と話せません", `<p>${escapeHtml(e.message)}</p>`)), true;
    }
  }

  if (path === "/oauth/register") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }, CORS), true;
    let meta = {};
    try {
      const raw = await readBody(req);
      meta = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid_client_metadata" }, CORS), true;
    }
    const client = registerClient(meta);
    return sendJson(res, 201, client, CORS), true;
  }

  if (path === "/oauth/authorize") {
    const p = url.searchParams;
    if (req.method === "GET") {
      const client = getClient(p.get("client_id"));
      if (!client) return sendHtml(res, page(400, "入口を渡せません", "<p>知らない client です。</p>")), true;
      if (!redirectAllowed(client, p.get("redirect_uri")))
        return sendHtml(res, page(400, "入口を渡せません", "<p>redirect_uri が登録と違います。</p>")), true;
      if (p.get("response_type") !== "code")
        return errorRedirect(res, p.get("redirect_uri"), p.get("state"), "unsupported_response_type"), true;
      return sendHtml(res, authorizeForm(origin, p)), true;
    }
    if (req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const clientId = form.get("client_id");
      const redirectUri = form.get("redirect_uri");
      const state = form.get("state");
      const client = getClient(clientId);
      if (!client || !redirectAllowed(client, redirectUri))
        return sendHtml(res, page(400, "入口を渡せません", "<p>client か redirect_uri が違います。</p>")), true;
      if (!passphraseOk(form.get("passphrase")))
        return sendHtml(res, authorizeForm(origin, form, "合鍵が違うようです。")), true;
      const code = makeCode({
        clientId,
        redirectUri,
        codeChallenge: form.get("code_challenge"),
        scope: form.get("scope"),
        resource: form.get("resource"),
      });
      const u = new URL(redirectUri);
      u.searchParams.set("code", code);
      if (state) u.searchParams.set("state", state);
      res.writeHead(302, { location: u.toString() });
      res.end();
      return true;
    }
  }

  if (path === "/oauth/token") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }, CORS), true;
    const raw = await readBody(req);
    const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const form = new URLSearchParams(raw);
    if (ctype === "application/json") {
      try {
        for (const [k, v] of Object.entries(JSON.parse(raw))) form.set(k, v);
      } catch {
        return sendJson(res, 400, { error: "invalid_request" }, CORS), true;
      }
    }

    // client を、body か Basic 認証から。固定クライアント(confidential)は secret を見る。
    let clientId = form.get("client_id");
    let clientSecret = form.get("client_secret");
    const auth = req.headers.authorization ?? "";
    if (auth.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
      const idx = decoded.indexOf(":");
      const id = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const sec = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (!clientId) clientId = decodeURIComponent(id);
      if (!clientSecret) clientSecret = decodeURIComponent(sec);
    }
    const client = getClient(clientId);
    if (!client || !clientSecretOk(client, clientSecret))
      return sendJson(res, 401, { error: "invalid_client" }, CORS), true;

    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const rec = takeCode(form.get("code"));
      if (!rec) return sendJson(res, 400, { error: "invalid_grant" }, CORS), true;
      if (rec.client_id !== clientId) return sendJson(res, 400, { error: "invalid_grant" }, CORS), true;
      if (rec.redirect_uri !== form.get("redirect_uri")) return sendJson(res, 400, { error: "invalid_grant" }, CORS), true;
      // PKCE は、送られてきたときだけ見る(confidential クライアントは送らないことがある)。
      if (rec.code_challenge && !pkceOk(form.get("code_verifier"), rec.code_challenge))
        return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE が合いません" }, CORS), true;
      const t = issueTokens({ clientId: rec.client_id, scope: rec.scope, account: rec.account });
      return sendJson(res, 200, { token_type: "Bearer", scope: rec.scope, ...t }, CORS), true;
    }

    if (grant === "refresh_token") {
      const rec = takeRefresh(form.get("refresh_token"));
      if (!rec) return sendJson(res, 400, { error: "invalid_grant" }, CORS), true;
      if (rec.client_id !== clientId) return sendJson(res, 400, { error: "invalid_grant" }, CORS), true;
      const t = issueTokens({ clientId: rec.client_id, scope: rec.scope, account: rec.account });
      return sendJson(res, 200, { token_type: "Bearer", scope: rec.scope, ...t }, CORS), true;
    }

    return sendJson(res, 400, { error: "unsupported_grant_type" }, CORS), true;
  }

  return false;
}

export { parseCookies };
