// loka の外を読む。ほんとうのことだけ ── 作り話はしない。
//
// 行き先は、許可した host だけ(既定: api.github.com)。 WORLD_FETCH_HOSTS で足せる。
// https だけ。応答に上限と時間の上限。GitHub は GITHUB_TOKEN(環境か state/github_token)。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_HOSTS = ["api.github.com"];
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export function allowedHosts() {
  const extra = (process.env.WORLD_FETCH_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_HOSTS, ...extra]);
}

export async function fetchExternal(url, { method = "GET", headers = {}, body, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL が読めない: ${url}`);
  }
  if (u.protocol !== "https:") throw new Error(`https だけ: ${u.protocol}`);
  const hosts = allowedHosts();
  if (!hosts.has(u.hostname)) throw new Error(`そこへは行かない: ${u.hostname}(許可: ${[...hosts].join(", ")})`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(u, { method, headers, body, redirect: "follow", signal: ac.signal });
    const finalHost = resp.url ? new URL(resp.url).hostname : u.hostname;
    if (!hosts.has(finalHost)) throw new Error(`行き先が変わった: ${finalHost}`);

    const chunks = [];
    let received = 0;
    let truncated = false;
    const reader = resp.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - received));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        received += value.length;
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    return {
      status: resp.status,
      ok: resp.ok,
      content_type: resp.headers.get("content-type") ?? "",
      bytes: received,
      truncated,
      body: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── GitHub ────────────────────────────────────────────────────────────────

function ghToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return readFileSync(join(STATE_DIR, "github_token"), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function ghHeaders(extra = {}) {
  const h = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "loka-world",
    ...extra,
  };
  const token = ghToken();
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// "owner/name" でも "https://github.com/owner/name" でも受ける。
export function parseRepo(repo) {
  const s = String(repo ?? "").trim().replace(/\.git$/, "");
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)/) || s.match(/^([^/]+)\/([^/]+)$/);
  if (!m) throw new Error(`repo は owner/name の形で: ${repo}`);
  return [m[1], m[2].replace(/^#.*/, "")];
}

function shapeIssue(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    author: i.user?.login,
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

function ghError(r) {
  const hint =
    r.status === 403 || r.status === 429
      ? "レート上限の可能性(state/github_token を置くと上がる)。private はトークンが要る。"
      : r.status === 404
        ? "見つからない(private リポジトリなら GITHUB_TOKEN が要る)。"
      : r.status === 422
        ? "リポジトリが見つからないか、権限がない(owner/name とトークンを確認)。"
        : "";
  return { error: `GitHub が ${r.status}`, ...(hint ? { hint } : {}), detail: r.body.slice(0, 300) };
}

export async function githubIssues({ repo, state = "open", labels, limit = 20, includePrs = false, sort = "updated", query, page = 1 }) {
  const [owner, name] = parseRepo(repo);
  const capped = Math.min(Math.max(limit, 1), 100);

  if (!includePrs) {
    // issues だけを確実に取るには Search API(REST /issues は PR が混じり、更新順だと 0 になりやすい)。
    const q = [];
    if (query && String(query).trim()) q.push(String(query).trim());
    q.push(`repo:${owner}/${name}`, "type:issue");
    if (state !== "all") q.push(`state:${state}`);
    for (const l of String(labels ?? "").split(",").map((s) => s.trim()).filter(Boolean)) q.push(`label:"${l}"`);
    const u = new URL("https://api.github.com/search/issues");
    u.searchParams.set("q", q.join(" "));
    u.searchParams.set("sort", { created: "created", comments: "comments" }[sort] ?? "updated");
    u.searchParams.set("order", "desc");
    u.searchParams.set("per_page", String(capped));
    u.searchParams.set("page", String(page));
    const r = await fetchExternal(u.toString(), { headers: ghHeaders() });
    if (!r.ok) return ghError(r);
    const data = JSON.parse(r.body);
    if (data.message) return { error: `GitHub: ${data.message}` };
    const items = data.items ?? [];
    return {
      repo: `${owner}/${name}`,
      state,
      via: "search",
      authenticated: Boolean(ghToken()),
      total: data.total_count,
      page,
      count: items.length,
      // Search API は先頭 1000 件までしか返さない。それより先は query / labels で絞る。
      has_more: page * capped < Math.min(data.total_count ?? 0, 1000),
      ...(items.length === 0
        ? { note: "この条件では 0 件。state や labels を外して試せる(この repo には無いかもしれない)。" }
        : {}),
      issues: items.map(shapeIssue),
    };
  }

  const u = new URL(`https://api.github.com/repos/${owner}/${name}/issues`);
  u.searchParams.set("state", state);
  u.searchParams.set("per_page", String(capped));
  u.searchParams.set("page", String(page));
  u.searchParams.set("sort", sort);
  u.searchParams.set("direction", "desc");
  if (labels) u.searchParams.set("labels", labels);
  const r = await fetchExternal(u.toString(), { headers: ghHeaders() });
  if (!r.ok) return ghError(r);
  const list = JSON.parse(r.body);
  if (!Array.isArray(list)) return { error: "予想と違う返し", detail: r.body.slice(0, 300) };
  return {
    repo: `${owner}/${name}`,
    state,
    via: "issues",
    authenticated: Boolean(ghToken()),
    page,
    count: Math.min(list.length, capped),
    has_more: list.length >= capped,
    ...(list.length === 0 ? { note: "この条件では 0 件。state や labels を外して試せる。" } : {}),
    issues: list.slice(0, capped).map(shapeIssue),
  };
}

export async function githubDiscussions({ repo, limit = 20, category }) {
  const [owner, name] = parseRepo(repo);
  const token = ghToken();
  if (!token) {
    return { error: "GitHub Discussions は GITHUB_TOKEN が要ります(repo と read:discussion の権限)。" };
  }
  const query = `query($owner:String!,$name:String!,$first:Int!){
    repository(owner:$owner,name:$name){
      discussions(first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){
        nodes{ number title url createdAt updatedAt isAnswered category{name} author{login} comments{totalCount} }
        totalCount
      }
    }
  }`;
  const r = await fetchExternal("https://api.github.com/graphql", {
    method: "POST",
    headers: ghHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ query, variables: { owner, name, first: Math.min(Math.max(limit, 1), 100) } }),
  });
  if (!r.ok) return ghError(r);
  const data = JSON.parse(r.body);
  if (data.errors) return { error: "GraphQL が断った", errors: data.errors.map((e) => e.message) };
  const repoNode = data?.data?.repository;
  if (!repoNode) return { error: "repository が引けなかった(owner/name か権限を確かめて)" };
  let list = repoNode.discussions?.nodes ?? [];
  if (category) list = list.filter((d) => (d.category?.name ?? "") === category);
  const total = repoNode.discussions?.totalCount;
  return {
    repo: `${owner}/${name}`,
    total,
    count: list.length,
    ...(list.length === 0
      ? { note: total ? "この category では 0 件。" : "この repo には Discussions が無いか、0 件。" }
      : {}),
    discussions: list.map((d) => ({
      number: d.number,
      title: d.title,
      url: d.url,
      category: d.category?.name,
      author: d.author?.login,
      answered: d.isAnswered,
      comments: d.comments?.totalCount,
      created_at: d.createdAt,
      updated_at: d.updatedAt,
    })),
  };
}
