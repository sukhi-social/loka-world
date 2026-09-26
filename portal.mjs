// 人間の窓口。loka.f3liz.casa を開いた人に見せる面。
//
// 見せるもの : shared_drive(一手間の向こう側)、diary/public、登録の手引き。
// 見せないもの: diary/private、.trash、.log。
// 「踏み込み」: 机・書庫・成果は、理由を添えてはじめて開く。開いた先は、
//   一覧からファイルをたどって読める(/peek?path=…)。HTML はアプリとして開ける(/raw/…)。
//   やったことは .log に残る。
//
// 入口は合鍵ひとつ。通ったら cookie。玄関(genkan)と同じ考え方。
// Google アカウント(@floorp.app)でも入れる ── GSI が渡す ID トークンを、
// ここで検証してから cookie を張る(クライアント側の見せかけは信じない)。

import { createPublicKey, createVerify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  accountCookieHeader,
  accountFrom,
  clearAccountCookieHeader,
  clearVisitCookieHeader,
  ownerAccount,
  passphraseOk,
  visitCookieHeader,
  visitOk,
} from "./auth.mjs";
import { room } from "./room.mjs";
import { STATE_DIR } from "./paths.mjs";
import { readonlyTools, setReadonlyTools } from "./settings.mjs";
import { state } from "./state.mjs";
import { CHOOSABLE_TOOLS, toolLabel } from "./tools.mjs";
import { escapeHtml, originOf, page, parseCookies, readBody, sendHtml, sendJson } from "./web.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PEEKABLE = new Set(["desk", "library", "achievements"]);
const PUBLIC_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PUBLIC_ACCOUNT_RE = /^(?:[A-Za-z0-9_.-]{1,64}|[A-Za-z0-9_.+-]{1,64}@floorp\.app)$/;
const PUBLIC_PAGES_FILE = join(STATE_DIR, "public-pages.json");

// ── Google サインイン ─────────────────────────────────────────────────────
//
// 設定は env で:
//   WORLD_GOOGLE_CLIENT_ID  OAuth クライアントID(.apps.googleusercontent.com)
//   WORLD_GOOGLE_DOMAIN     許可するメールのドメイン(既定 floorp.app)
// client_id が無ければ、ボタンは出さない(壊れたボタンを置かない)。
const GOOGLE_CLIENT_ID = process.env.WORLD_GOOGLE_CLIENT_ID ?? "";
const GOOGLE_DOMAIN = (process.env.WORLD_GOOGLE_DOMAIN ?? "floorp.app").replace(/^@/, "").toLowerCase();
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

let googleJwks = { keys: [], at: 0 };

async function googleKeys() {
  if (googleJwks.keys.length && Date.now() - googleJwks.at < 3600 * 1000) return googleJwks.keys;
  const res = await fetch(GOOGLE_JWKS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("Google の鍵を取れませんでした");
  const data = await res.json();
  googleJwks = { keys: Array.isArray(data.keys) ? data.keys : [], at: Date.now() };
  return googleJwks.keys;
}

const b64urlBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64urlJson = (s) => JSON.parse(b64urlBuf(s).toString("utf-8"));

// GSI の credential(ID トークン)を検証する。署名・aud・iss・exp・ドメイン。
async function verifyGoogleCredential(credential, clientId) {
  const parts = String(credential ?? "").split(".");
  if (parts.length !== 3) throw new Error("credential の形が不正");
  const [h, p, sig] = parts;
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (header.alg !== "RS256") throw new Error("alg が RS256 でない");
  const now = Math.floor(Date.now() / 1000);
  if (!(Number(payload.exp) > now)) throw new Error("credential が切れている");
  if (payload.aud !== clientId) throw new Error("aud が合わない");
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") throw new Error("iss が合わない");
  if (payload.email_verified !== true) throw new Error("メールが未確認");
  const email = String(payload.email ?? "").toLowerCase();
  if (!email.endsWith(`@${GOOGLE_DOMAIN}`)) throw new Error(`@${GOOGLE_DOMAIN} のアカウントだけ入れます`);
  const keys = await googleKeys();
  const jwk = keys.find((k) => k.kid === header.kid && k.alg === "RS256");
  if (!jwk) throw new Error("合う鍵が無い");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(key, b64urlBuf(sig));
  if (!ok) throw new Error("署名が合わない");
  return { email, sub: payload.sub, name: payload.name };
}

const accountFromEmail = (email) => String(email).toLowerCase();

// ── ページ ────────────────────────────────────────────────────────────────

// 窓口から来た道を、.. や絶対の道なしの、まっすぐな相対の道に直す。
// 通せないときは null(shared_drive/../../diary/private のような抜け道を断つ)。
function safeRel(path) {
  const parts = String(path ?? "")
    .split("/")
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === ".." || p.includes("\0"))) return null;
  return parts.join("/");
}

function publicSites() {
  try {
    const data = JSON.parse(readFileSync(PUBLIC_PAGES_FILE, "utf-8"));
    if (!data || typeof data.sites !== "object" || Array.isArray(data.sites)) return {};
    return Object.fromEntries(
      Object.entries(data.sites).filter(
        ([slug, site]) =>
          PUBLIC_SLUG_RE.test(slug) &&
          site &&
          typeof site.account === "string" &&
          PUBLIC_ACCOUNT_RE.test(site.account) &&
          site.folder === slug,
      ),
    );
  } catch {
    return {};
  }
}

function savePublicSites(sites) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${PUBLIC_PAGES_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ sites }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, PUBLIC_PAGES_FILE);
}

function publicIndexPage() {
  const sites = Object.keys(publicSites()).sort();
  const entries = sites.length
    ? `<ul>${sites.map((slug) => `<li><a href="/open/${encodeURIComponent(slug)}/">${escapeHtml(slug)}</a></li>`).join("")}</ul>`
    : `<p class="muted">まだ公開されたページはありません。</p>`;
  return page(200, "公開ページ", `<p class="muted">loka から公開されているページです。</p><div class="card">${entries}</div>`);
}

async function publicationPage(account, saved, message = "") {
  const sites = publicSites();
  const tree = await room(["tree", "--path", "shared_drive", "--depth", "2"], undefined, account).catch(() => ({ tree: [] }));
  const candidates = (tree.tree ?? [])
    .filter((node) => node.type === "dir" && PUBLIC_SLUG_RE.test(node.name))
    .filter((node) => (node.children ?? []).some((child) => child.type === "file" && child.name === "index.html"))
    .map((node) => node.name);
  const options = candidates.length
    ? `<select name="folder" required><option value="">公開するフォルダー</option>${candidates.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("")}</select>`
    : `<p class="muted">shared_drive 内に index.html を持つフォルダーがあると、ここから公開できます。</p>`;
  const visibleSites = Object.entries(sites).filter(([, site]) => site.account === account || account === ownerAccount());
  const published = visibleSites.length
    ? `<ul>${visibleSites
        .map(
          ([slug, site]) =>
            `<li><a href="/open/${encodeURIComponent(slug)}/">${escapeHtml(slug)}</a> <span class="muted">${escapeHtml(site.account)}</span>` +
            `<form method="post" action="/publish"><input type="hidden" name="action" value="unpublish"><input type="hidden" name="folder" value="${escapeHtml(slug)}"><button type="submit">公開をやめる</button></form></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">公開中のページはありません。</p>`;
  const notice = message || (saved === "published" ? "公開しました。" : saved === "unpublished" ? "公開をやめました。" : "");
  const body = `
  <div class="card">
    <p>shared_drive 内のフォルダーを、公開ページとして一覧と個別 URL に載せます。</p>
    <p class="muted">公開すると、そのフォルダー内のすべてのファイルが誰でも見られます。index.html が入口です。</p>
    ${notice ? `<p class="muted">${escapeHtml(notice)}</p>` : ""}
    <form method="post" action="/publish">
      <input type="hidden" name="action" value="publish">
      ${options}
      <p><button type="submit"${candidates.length ? "" : " disabled"}>公開する</button></p>
    </form>
  </div>
  <h2>公開中</h2><div class="card">${published}</div>
  <p><a href="/open">公開ページ一覧を見る</a></p>${backHome}`;
  return page(200, "公開ページの管理", body);
}

function publicBundleMarkers(html) {
  const fileMarker = /<!--\s*loka:bundle\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\s*-->/g;
  const globMarker = /<!--\s*loka:bundle-glob\s+([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,32})\*\.md\s+as\s+([A-Za-z0-9_-]{1,64})\s*-->/g;
  const markers = [
    ...[...html.matchAll(fileMarker)].map((match) => ({
      position: match.index,
      placeholder: match[0],
      id: `loka-bundle-${match[1]}`,
      type: "file",
      name: match[1],
    })),
    ...[...html.matchAll(globMarker)].map((match) => ({
      position: match.index,
      placeholder: match[0],
      id: `loka-bundle-${match[3]}`,
      type: "glob",
      directory: match[1],
      prefix: match[2],
    })),
  ].sort((a, b) => a.position - b.position);
  if (markers.length > 4 || new Set(markers.map((marker) => marker.id)).size !== markers.length) {
    throw new Error("公開データの指定が多すぎます");
  }
  return markers;
}

async function bundledScript(marker, site, total) {
  let value;
  if (marker.type === "file") {
    const result = await room(["serve", "--path", `shared_drive/${site.folder}/${marker.name}`], undefined, site.account);
    if (!String(result.mime ?? "").startsWith("text/")) throw new Error("公開データはテキストだけ使えます");
    const bytes = Buffer.from(result.base64 ?? "", "base64");
    total.bytes += bytes.length;
    value = bytes.toString("utf-8");
  } else {
    const result = await room(
      ["bundle-markdown", "--path", `shared_drive/${site.folder}/${marker.directory}`, "--prefix", marker.prefix],
      undefined,
      site.account,
    );
    const files = result.files ?? [];
    total.bytes += files.reduce((sum, file) => sum + Buffer.byteLength(file.content ?? ""), 0);
    value = files.map((file) => file.content);
  }
  if (total.bytes > 1024 * 1024) throw new Error("公開データの合計が大きすぎます");
  const json = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<script type="application/json" id="${marker.id}">${json}</script>`;
}

async function streamBundledHtml(html, markers, site, res) {
  let cursor = 0;
  const total = { bytes: 0 };
  for (const marker of markers) {
    res.write(html.slice(cursor, marker.position));
    try {
      res.write(await bundledScript(marker, site, total));
    } catch (error) {
      console.error(`loka public bundle failed (${site.folder}): ${error.message}`);
      res.write(marker.placeholder);
    }
    cursor = marker.position + marker.placeholder.length;
  }
  res.end(html.slice(cursor));
}

async function servePublicPage(req, res, url) {
  if (url.pathname === "/open" || url.pathname === "/open/") {
    sendHtml(res, publicIndexPage());
    return true;
  }

  let segments;
  try {
    segments = url.pathname.slice("/open/".length).split("/").map(decodeURIComponent);
  } catch {
    return sendHtml(res, page(400, "その道は通らない", backHome)), true;
  }
  const trailingSlash = segments.at(-1) === "";
  if (trailingSlash) segments.pop();
  const [slug, ...assetParts] = segments;
  if (!slug || segments.some((part) => part.includes("/") || part.includes("\\") || part.includes("\0"))) {
    return sendHtml(res, page(400, "その道は通らない", backHome)), true;
  }
  const site = publicSites()[slug];
  if (!site) return sendHtml(res, page(404, "公開ページがありません", backHome)), true;
  if (assetParts.length === 0 || trailingSlash) assetParts.push("index.html");
  const asset = safeRel(assetParts.join("/"));
  if (!asset) return sendHtml(res, page(400, "その道は通らない", backHome)), true;

  try {
    const result = await room(["serve", "--path", `shared_drive/${site.folder}/${asset}`], undefined, site.account);
    const bytes = Buffer.from(result.base64 ?? "", "base64");
    const contentType = result.mime ?? "application/octet-stream";
    const html = asset === "index.html" && contentType.startsWith("text/html") ? bytes.toString("utf-8") : null;
    const markers = html === null ? [] : publicBundleMarkers(html);
    const headers = {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    };
    if (contentType.startsWith("text/html")) {
      headers["content-security-policy"] = "sandbox allow-scripts allow-top-navigation-by-user-activation";
    }
    if (html !== null && markers.length > 0) {
      res.writeHead(200, headers);
      await streamBundledHtml(html, markers, site, res);
      return true;
    }
    res.writeHead(200, { ...headers, "content-length": bytes.length });
    res.end(bytes);
    return true;
  } catch {
    return sendHtml(res, page(404, "公開ページがありません", backHome)), true;
  }
}

// 道を、URL に載せられる形へ(区切りは残し、各断片だけ encode)。
const encPath = (rel) => rel.split("/").map(encodeURIComponent).join("/");
const rawHref = (rel) => `/raw/${encPath(rel)}`;
const peekHref = (path, reason) =>
  `/peek?path=${encodeURIComponent(path)}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
const backHome = `<p><a href="/">窓口へ戻る</a></p>`;

// 共有 HTML から、同じフォルダのデータを読みやすくする小さな助手。
//   <script src="/loka.js"></script>
//   const data = await loka.json("data.json");            // 同じフォルダ
//   const cfg  = await loka.sharedJson("config.json");    // shared_drive の直下
const LOKA_JS = `(function () {
  var base = null;
  try {
    var s = document.currentScript;
    if (s && s.dataset && s.dataset.base) base = new URL(s.dataset.base, location.href);
  } catch (e) {}
  function url(name) {
    return new URL(String(name), base || location.href);
  }
  function get(name, opt) {
    var u = url(name);
    return fetch(u, opt).then(function (r) {
      if (!r.ok) throw new Error("loka: " + r.status + " " + u.pathname);
      return r;
    });
  }
  function shared(name, opt) {
    var p = String(name).split("/").map(encodeURIComponent).join("/");
    return fetch("/raw/shared_drive/" + p, opt).then(function (r) {
      if (!r.ok) throw new Error("loka: " + r.status + " shared_drive/" + p);
      return r;
    });
  }
  window.loka = {
    get: get,
    text: function (n, o) { return get(n, o).then(function (r) { return r.text(); }); },
    json: function (n, o) { return get(n, o).then(function (r) { return r.json(); }); },
    blob: function (n, o) { return get(n, o).then(function (r) { return r.blob(); }); },
    shared: shared,
    sharedText: function (n, o) { return shared(n, o).then(function (r) { return r.text(); }); },
    sharedJson: function (n, o) { return shared(n, o).then(function (r) { return r.json(); }); },
  };
})();
`;

function loginPage(message, req) {
  const googleLogin = GOOGLE_CLIENT_ID
    ? `<p class="muted">@${escapeHtml(GOOGLE_DOMAIN)} の Google アカウントで入れます。</p>
    <div id="g_id_onload" data-client_id="${escapeHtml(GOOGLE_CLIENT_ID)}" data-login_uri="${escapeHtml(`${originOf(req)}/enter/google`)}" data-auto_prompt="false"></div>
    <div class="g_id_signin" data-type="standard" data-size="large" data-theme="outline" data-text="signin_with" data-shape="rectangular"></div>
    <script src="https://accounts.google.com/gsi/client" async defer></script>`
    : "";
  const body = `
  <div class="card">
    <p>ここは、シロの部屋の窓口です。</p>
    ${message ? `<p class="muted">${escapeHtml(message)}</p>` : ""}
    ${googleLogin}
    <form method="post" action="/enter">
      <input type="password" name="passphrase" placeholder="合鍵" autocomplete="current-password" autofocus>
      <p><button type="submit">入る</button></p>
    </form>
    <p class="muted">または <a href="/oauth/sukhi/login">sukhi アカウントでログイン</a> すると、この部屋に入って、AI に渡す鍵も取れます。</p>
  </div>`;
  return page(200, "シロの部屋", body);
}

// アカウントごとの設定。いまは「読み取り専用と申告する道具」だけ。
function settingsPage(account, saved) {
  const current = new Set(readonlyTools(account));
  const rows = CHOOSABLE_TOOLS.map((name) => {
    const on = current.has(name) ? " checked" : "";
    return `<li><label><input type="checkbox" name="tool" value="${escapeHtml(name)}"${on}> ${escapeHtml(toolLabel(name))}</label></li>`;
  }).join("");
  const body = `
  <div class="card">
    <p><b>${escapeHtml(account)}</b> の設定。</p>
    <p class="muted">印をつけた道具は「読み取り専用」と申告され、Gemini Enterprise などの
      ユーザー確認が省かれます。readOnlyHint を尊重する他のクライアントでも、確認なしで走ります。
      既定は、正直なまま(印なし)。</p>
    ${saved ? `<p class="muted">保存しました。</p>` : ""}
    <form method="post" action="/settings">
      <ul>${rows || `<li class="muted">選べる道具がありません。</li>`}</ul>
      <p><button type="submit">保存する</button></p>
    </form>
  </div>
  <p><a href="/">窓口へ戻る</a></p>`;
  return page(200, "設定", body);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 共有の一覧。HTML は /raw へ直行(アプリとして開く)。
function entriesHtml(entries, baseHref, { rawBase = null } = {}) {
  if (!entries || entries.length === 0) return `<p class="muted">まだ何もありません。</p>`;
  const items = entries
    .filter((e) => e.type === "file")
    .map((e) => {
      const isHtml = /\.html?$/i.test(e.name);
      const href = rawBase && isHtml ? `${rawBase}${encodeURIComponent(e.name)}` : baseHref ? `${baseHref}${encodeURIComponent(e.name)}` : null;
      const label = escapeHtml(e.name) + (rawBase && isHtml ? " ↗" : "");
      const link = href ? `<a href="${href}">${label}</a>` : label;
      return `<li>${link} <span class="muted">${fmtSize(e.size)}</span></li>`;
    })
    .join("");
  return items ? `<ul>${items}</ul>` : `<p class="muted">ファイルはありません。</p>`;
}

// 踏み込んだ先の一覧。ディレクトリもファイルも、そのままたどれる。
function peekListing(entries, curPath, reason) {
  if (!entries || entries.length === 0) return `<p class="muted">空です。</p>`;
  const rows = entries
    .map((e) => {
      const child = `${curPath}/${e.name}`;
      const href = peekHref(child, reason);
      if (e.type === "dir") return `<li><a href="${href}">${escapeHtml(e.name)}/</a></li>`;
      return `<li><a href="${href}">${escapeHtml(e.name)}</a> <span class="muted">${fmtSize(e.size)}</span></li>`;
    })
    .join("");
  return `<ul>${rows}</ul>`;
}

async function homePage(req, account) {
  const origin = originOf(req);
  const [shared, diary, focus, teams] = await Promise.all([
    room(["shared"], undefined, account).catch((e) => ({ entries: [], error: e.message })),
    room(["diary-list", "--visibility", "public"], undefined, account).catch(() => []),
    state(["focus"], undefined, account).catch(() => ({ focusing: false })),
    room(["team-list"], undefined, account).catch(() => ({ teams: [] })),
  ]);

  const focusText =
    focus?.focusing === false
      ? "いまは、扉が開いている。"
      : `いまは集中中${focus.task ? `: ${escapeHtml(focus.task)}` : ""}${focus.minutes ? `(${focus.minutes}分のつもり)` : ""}。`;

  const diaryHtml = diary.length
    ? `<ul>${diary
        .map(
          (d) =>
            `<li><a href="/diary/public/${encodeURIComponent(d.date)}">${escapeHtml(d.date)}</a>` +
            `<span class="muted">${d.mood ? ` · ${escapeHtml(d.mood)}` : ""}</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">まだ公開の日記はありません。</p>`;

  const teamList = teams.teams ?? [];
  const teamsHtml = teamList.length
    ? `<ul>${teamList
        .map(
          (t) =>
            `<li><a href="/team/${encodeURIComponent(t.id ?? t.name)}">${escapeHtml(t.name)}</a>` +
            `<span class="muted"> · ${(t.members ?? []).length} 人${t.owner === account ? " · 持ち主" : ""}</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">まだチームはありません。</p>`;
  const teamsForm = `
    <form method="post" action="/teams">
      <p class="muted">チームは、みんなで見る共有の部屋です。作った人が持ち主になります。</p>
      <input type="text" name="name" placeholder="新しいチームの名前">
      <p><button type="submit">作る</button></p>
    </form>`;

  const peekForm = `
    <form method="post" action="/peek">
      <p class="muted">机・書庫・成果は、理由を添えてはじめて開きます。開いた先は、一覧からファイルをたどって読めます。開いたことは記録されます。</p>
      <input type="text" name="path" placeholder="desk / library / achievements" value="desk">
      <p><input type="text" name="reason" placeholder="なぜ見るのか、ひとこと"></p>
      <p><button type="submit">踏み込む</button></p>
    </form>`;

  const htmlRead = `<p class="muted">共有ドライブの HTML は、同じフォルダのファイルを相対パスで読めます。助手を使うと、すこし楽です。</p>
    <pre>${escapeHtml('<script src="/loka.js"></script>\n<script>\n  const data = await loka.json("data.json");\n</script>')}</pre>`;

  const body = `
  <p class="muted">ここは、シロの部屋の窓口です。共有された物と、公開の日記だけが見えます。</p>

  <div class="card"><p>${focusText}</p></div>

  <h2>チーム</h2>
  <div class="card">${teamsHtml}${teamsForm}</div>

  <h2>共有ドライブ</h2>
  <div class="card">${entriesHtml(shared.entries, "/shared/", { rawBase: "/raw/shared_drive/" })}${
    shared.error ? `<p class="muted">(読めませんでした: ${escapeHtml(shared.error)})</p>` : ""
  }</div>
  <p><a href="/publish">公開ページを管理する</a></p>

  <h2>公開の日記</h2>
  <div class="card">${diaryHtml}</div>

  <h2>共有 HTML からデータを読む</h2>
  <div class="card">${htmlRead}</div>

  <h2>AI から繋ぐ</h2>
  <div class="card">
    <p>MCP の endpoint は <code>${escapeHtml(origin)}/mcp</code>。<br>
       Web の AI からは、URL を入れて、この合鍵で認可します。</p>
  </div>

  <h2>踏み込む</h2>
  <div class="card">${peekForm}</div>

  <p><a href="/settings">設定(確認なしにする道具)</a></p>
  <form method="post" action="/leave"><p><button type="submit">出る</button></p></form>`;

  return page(200, "シロの部屋", body);
}

function renderResult(result) {
  if (result.entries) return entriesHtml(result.entries, null);
  return `<pre>${escapeHtml(result.content ?? "")}</pre>`;
}

// 踏み込んだ先の一枚。ディレクトリなら一覧、ファイルなら中身。行き来できる。
async function peekPage(target, reason, account) {
  const top = target.split("/")[0];
  const up = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : null;
  const crumb =
    `<p class="muted">${escapeHtml(target)} · ${escapeHtml(reason || "理由なし")}</p>` +
    (up && PEEKABLE.has(up) ? `<p><a href="${peekHref(up, reason)}">↑ ${escapeHtml(up)}</a></p>` : "");
  try {
    const result = await room(["open", "--path", target, "--reason", reason || "理由なし"], undefined, account);
    let inner;
    if (result.entries) {
      inner = peekListing(result.entries, target, reason);
    } else {
      const isHtml = /\.html?$/i.test(target);
      const open = isHtml
        ? `<p><a href="${rawHref(target)}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}">アプリとして開く ↗</a></p>`
        : "";
      inner = `<div class="card"><pre>${escapeHtml(result.content ?? "")}</pre></div>${open}`;
    }
    return page(200, target, `${crumb}<div class="card">${inner}</div>${backHome}`);
  } catch (e) {
    return page(404, "開けません", `${crumb}<p>${escapeHtml(e.message)}</p>${backHome}`);
  }
}

// チームの一枚。メンバーと、共有の中身。
async function teamPage(ref, account, saved) {
  let data;
  let files;
  try {
    [data, files] = await Promise.all([
      room(["team-members", "--team", ref], undefined, account),
      room(["team-files", "--team", ref], undefined, account),
    ]);
  } catch (e) {
    return page(404, "チームが無い", `<p>${escapeHtml(e.message)}</p>${backHome}`);
  }
  const id = data.id ?? ref;
  const members = (data.members ?? [])
    .map((m) => `<li>${escapeHtml(m)}${m === data.owner ? ` <span class="muted">· 持ち主</span>` : ""}</li>`)
    .join("");
  const entries = files.entries ?? [];
  const filesHtml = entries.filter((e) => e.type === "file").length
    ? `<ul>${entries
        .filter((e) => e.type === "file")
        .map((e) => {
          const isHtml = /\.html?$/i.test(e.name);
          const href = `/team/${encodeURIComponent(id)}/raw/${encodeURIComponent(e.name)}`;
          return `<li><a href="${href}">${escapeHtml(e.name)}${isHtml ? " ↗" : ""}</a> <span class="muted">${fmtSize(e.size)}</span></li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">まだ何もありません。AI が share_to_team で、ここへ移せます。</p>`;
  const body = `
  <div class="card">
    <p class="muted">${escapeHtml(data.team)} — みんなで見る共有の部屋。</p>
    ${saved ? `<p class="muted">加えました。</p>` : ""}
    <h3>共有</h3>${filesHtml}
    <h3>メンバー</h3><ul>${members}</ul>
    <h3>招く</h3>
    <form method="post" action="/team/${encodeURIComponent(id)}/member">
      <input type="text" name="account" placeholder="招く相手のアカウント名">
      <p><button type="submit">招く</button></p>
    </form>
  </div>
  ${backHome}`;
  return page(200, data.team, body);
}

// req/res を扱ったら true。
export async function handlePortal(req, res, url) {
  const path = url.pathname;
  const cookies = parseCookies(req);
  const sessionAccount = accountFrom(req, cookies);
  const authed = visitOk(req, cookies) && sessionAccount !== null;
  const account = sessionAccount ?? ownerAccount();

  if (req.method === "GET" && (path === "/open" || path === "/open/" || path.startsWith("/open/"))) {
    return servePublicPage(req, res, url);
  }

  if (path === "/enter/google" && req.method === "POST") {
    if (!GOOGLE_CLIENT_ID) return sendHtml(res, loginPage("Google ログインは設定されていません。", req)), true;
    const form = new URLSearchParams(await readBody(req));
    const csrfCookie = cookies.g_csrf_token;
    const csrfBody = form.get("g_csrf_token");
    if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
      return sendHtml(res, loginPage("Google ログインを確認できませんでした。もう一度お試しください。", req)), true;
    }
    try {
      const identity = await verifyGoogleCredential(form.get("credential"), GOOGLE_CLIENT_ID);
      res.writeHead(302, {
        location: "/",
        "set-cookie": [visitCookieHeader(req), accountCookieHeader(req, accountFromEmail(identity.email))],
      });
      res.end();
      return true;
    } catch (e) {
      return sendHtml(res, loginPage(`Google ログインを確認できませんでした: ${e.message}`, req)), true;
    }
  }

  if (path === "/enter" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    if (!passphraseOk(form.get("passphrase"))) return sendHtml(res, loginPage("合鍵が違うようです。", req)), true;
    res.writeHead(302, {
      location: "/",
      "set-cookie": [visitCookieHeader(req), accountCookieHeader(req, ownerAccount())],
    });
    res.end();
    return true;
  }

  if (path === "/leave" && req.method === "POST") {
    res.writeHead(302, {
      location: "/",
      "set-cookie": [clearVisitCookieHeader(req), clearAccountCookieHeader(req)],
    });
    res.end();
    return true;
  }

  // OAuth の同意そのものは oauth.mjs が持つ。ここからは、門の内側だけ。
  if (!path.startsWith("/.well-known/") && !path.startsWith("/oauth/")) {
    if (!authed) {
      if (path === "/" && req.method === "GET") return sendHtml(res, loginPage(null, req)), true;
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("合鍵が要ります。\n");
      return true;
    }
  } else {
    return false;
  }

  if (path === "/" && req.method === "GET") {
    return sendHtml(res, await homePage(req, account)), true;
  }

  if (path === "/publish" && req.method === "GET") {
    return sendHtml(res, await publicationPage(account, url.searchParams.get("saved"))), true;
  }

  if (path === "/publish" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const folder = (form.get("folder") ?? "").trim();
    const sites = publicSites();
    if (form.get("action") === "unpublish") {
      const site = sites[folder];
      if (!site) return sendHtml(res, await publicationPage(account, null, "そのページは公開中ではありません。")), true;
      if (site.account !== account && account !== ownerAccount()) {
        return sendHtml(res, page(403, "公開をやめられません", backHome)), true;
      }
      delete sites[folder];
      savePublicSites(sites);
      res.writeHead(303, { location: "/publish?saved=unpublished" });
      res.end();
      return true;
    }
    if (form.get("action") !== "publish" || !PUBLIC_SLUG_RE.test(folder)) {
      return sendHtml(res, await publicationPage(account, null, "公開するフォルダーを選んでください。")), true;
    }
    if (sites[folder] && sites[folder].account !== account) {
      return sendHtml(res, await publicationPage(account, null, "その URL はすでに使われています。")), true;
    }
    try {
      const index = await room(["serve", "--path", `shared_drive/${folder}/index.html`], undefined, account);
      if (!String(index.mime ?? "").startsWith("text/html")) {
        return sendHtml(res, await publicationPage(account, null, "index.html を確認できませんでした。")), true;
      }
    } catch {
      return sendHtml(res, await publicationPage(account, null, "index.html を確認できませんでした。")), true;
    }
    savePublicSites({ ...sites, [folder]: { account, folder } });
    res.writeHead(303, { location: "/publish?saved=published" });
    res.end();
    return true;
  }

  // 共有 HTML が使う小さな助手。同じフォルダのデータを読みやすくする。
  if (path === "/loka.js" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(LOKA_JS);
    return true;
  }

  // アカウントごとの設定。読み取り専用と申告する道具を選ぶ。
  if (path === "/settings" && req.method === "GET") {
    return sendHtml(res, settingsPage(account, url.searchParams.get("saved") === "1")), true;
  }

  if (path === "/settings" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const chosen = form.getAll("tool").filter((t) => CHOOSABLE_TOOLS.includes(t));
    setReadonlyTools(account, chosen);
    res.writeHead(302, { location: "/settings?saved=1" });
    res.end();
    return true;
  }

  if (path.startsWith("/shared/") && req.method === "GET") {
    const rel = safeRel(decodeURIComponent(path.slice("/shared/".length)));
    if (!rel) return sendHtml(res, page(400, "その道は通らない", backHome)), true;
    try {
      const result = await room(["read", "--path", `shared_drive/${rel}`], undefined, account);
      const openLink = /\.html?$/i.test(rel) ? `<p><a href="${rawHref(`shared_drive/${rel}`)}">アプリとして開く ↗</a></p>` : "";
      const body = `<div class="card">${renderResult(result)}</div>${openLink}${backHome}`;
      return sendHtml(res, page(200, rel, body)), true;
    } catch (e) {
      return sendHtml(res, page(404, "無い", `<p>${escapeHtml(e.message)}</p>${backHome}`)), true;
    }
  }

  // ファイルを、そのままの種類で返す。HTML なら、そのまま動くアプリとして開く。
  // shared_drive/… も desk/… も、合鍵があれば開ける(日記は出さない)。
  if (path.startsWith("/raw/") && req.method === "GET") {
    const rel = safeRel(decodeURIComponent(path.slice("/raw/".length)));
    if (!rel) return sendHtml(res, page(400, "その道は通らない", backHome)), true;
    const reason = (url.searchParams.get("reason") ?? "").trim();
    try {
      const args = ["serve", "--path", rel];
      if (reason) args.push("--reason", reason);
      const result = await room(args, undefined, account);
      const bytes = Buffer.from(result.base64 ?? "", "base64");
      res.writeHead(200, {
        "content-type": result.mime ?? "application/octet-stream",
        "content-length": bytes.length,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.end(bytes);
      return true;
    } catch (e) {
      return sendHtml(res, page(404, "無い", `<p>${escapeHtml(e.message)}</p>${backHome}`)), true;
    }
  }

  if (path.startsWith("/diary/public/") && req.method === "GET") {
    const date = decodeURIComponent(path.slice("/diary/public/".length));
    if (!DATE_RE.test(date)) return sendHtml(res, page(400, "日付が変", backHome)), true;
    try {
      const entry = await room(["diary-read", "--date", date, "--visibility", "public"], undefined, account);
      const meta = `date: ${escapeHtml(entry.meta?.date ?? date)}${entry.meta?.mood ? ` · mood: ${escapeHtml(entry.meta.mood)}` : ""}`;
      const body = `<p class="muted">${meta}</p><div class="card"><pre>${escapeHtml(entry.body ?? "")}</pre></div>${backHome}`;
      return sendHtml(res, page(200, date, body)), true;
    } catch (e) {
      return sendHtml(res, page(404, "無い", `<p>${escapeHtml(e.message)}</p>${backHome}`)), true;
    }
  }

  // 踏み込む(フォーム)。理由つきで、たどれる一覧へ回す。
  if (path === "/peek" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const target = safeRel(form.get("path"));
    const reason = (form.get("reason") ?? "").trim();
    if (!target || !PEEKABLE.has(target.split("/")[0])) return sendHtml(res, page(400, "そこは開かない", backHome)), true;
    res.writeHead(302, { location: peekHref(target, reason) });
    res.end();
    return true;
  }

  if (path === "/peek" && req.method === "GET") {
    const target = safeRel(url.searchParams.get("path") ?? "desk");
    const reason = (url.searchParams.get("reason") ?? "").trim();
    if (!target || !PEEKABLE.has(target.split("/")[0])) return sendHtml(res, page(400, "そこは開かない", backHome)), true;
    return sendHtml(res, await peekPage(target, reason, account)), true;
  }

  // ── チーム ─────────────────────────────────────────────────────────────
  // 作る → 一枚 → 招く。共有への移動は AI の share_to_team が持つ。

  if (path === "/teams" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    try {
      const t = await room(["team-create", "--name", form.get("name") ?? ""], undefined, account);
      res.writeHead(302, { location: `/team/${encodeURIComponent(t.id)}` });
      res.end();
      return true;
    } catch (e) {
      return sendHtml(res, page(400, "作れません", `<p>${escapeHtml(e.message)}</p>${backHome}`)), true;
    }
  }

  if (path.startsWith("/team/") && path.endsWith("/member") && req.method === "POST") {
    const teamRef = decodeURIComponent(path.slice("/team/".length, -"/member".length));
    const form = new URLSearchParams(await readBody(req));
    try {
      await room(["team-add-member", "--team", teamRef, "--account", form.get("account") ?? ""], undefined, account);
      res.writeHead(302, { location: `/team/${encodeURIComponent(teamRef)}?saved=1` });
      res.end();
      return true;
    } catch (e) {
      return sendHtml(res, page(400, "招けません", `<p>${escapeHtml(e.message)}</p>${backHome}`)), true;
    }
  }

  // チームの共有のものを、そのまま返す(HTML はアプリとして開く)。
  if (path.startsWith("/team/") && path.includes("/raw/") && req.method === "GET") {
    const after = path.slice("/team/".length);
    const idx = after.indexOf("/raw/");
    const teamRef = decodeURIComponent(after.slice(0, idx));
    const rel = safeRel(decodeURIComponent(after.slice(idx + "/raw/".length)));
    if (!teamRef || !rel) return sendHtml(res, page(400, "その道は通らない", backHome)), true;
    try {
      const result = await room(["team-read", "--team", teamRef, "--path", `shared_drive/${rel}`], undefined, account);
      const isHtml = /\.html?$/i.test(rel);
      res.writeHead(200, {
        "content-type": isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(result.content ?? "");
      return true;
    } catch (e) {
      return sendHtml(res, page(404, "無い", `<p>${escapeHtml(e.message)}</p>${backHome}`)), true;
    }
  }

  if (path.startsWith("/team/") && req.method === "GET") {
    const ref = decodeURIComponent(path.slice("/team/".length));
    if (!ref || ref.includes("/")) return sendHtml(res, page(404, "無い", backHome)), true;
    return sendHtml(res, await teamPage(ref, account, url.searchParams.get("saved") === "1")), true;
  }

  if (path === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }

  return sendHtml(res, page(404, "無い", backHome)), true;
}
