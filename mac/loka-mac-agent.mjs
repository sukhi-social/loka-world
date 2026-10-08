#!/usr/bin/env node
// loka の Mac agent。Mac の持ち主が、自分で起動する。
//
//   node mac/loka-mac-agent.mjs --hours 2 [--server https://loka.f3liz.casa]
//
// 起動するとブラウザが開き、sukhi でログインする(持ち主のアカウントだけ通る)。
// 戻りは、この Mac の 127.0.0.1 の一時ポートだけで受ける(PKCE。code は一回きり)。
// --hours が許可の長さ(0 より大きく 12 以下)。過ぎたら自分で止まる。Ctrl-C でいつでも閉じる。
// loka へ外向きに繋ぐだけで、外からのポートは開かない。来た命令は、すべてこの端末に表示される。

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname, homedir } from "node:os";
import { parseArgs } from "node:util";

const MAX_HOURS = 12;
const OUT_MAX = 64 * 1024;

const { values } = parseArgs({
  options: {
    hours: { type: "string" },
    server: { type: "string", default: process.env.LOKA_URL ?? "https://loka.f3liz.casa" },
  },
});

const hours = Number(values.hours);
if (!(hours > 0 && hours <= MAX_HOURS)) {
  console.error(`--hours は 0 より大きく ${MAX_HOURS} 以下で、かならず指定してください。`);
  process.exit(2);
}
const server = values.server.replace(/\/$/, "");
let key = null;
let until = 0;
let current = null; // 走っている子
let closing = false;

const stamp = () => new Date().toLocaleTimeString("ja-JP", { hour12: false });
const say = (msg) => console.error(`[${stamp()}] ${msg}`);

// sukhi ログイン。ブラウザを開き、戻りの code を loopback で受けて、トークンに替える。
async function login() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await new Promise((resolve, reject) => {
    const http = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") return res.writeHead(404).end();
      const got = u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(got ? "loka に繋ぎました。この画面は閉じて、ターミナルに戻ってください。" : "code がありません。");
      http.close();
      got ? resolve(got) : reject(new Error("code が戻らなかった"));
    });
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address();
      const url = `${server}/oauth/sukhi/mac?${new URLSearchParams({ port, challenge, hours })}`;
      say(`sukhi でログインします。ブラウザが開かなければ、これを開いてください:\n  ${url}`);
      spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
    });
    setTimeout(() => (http.close(), reject(new Error("ログインが 3 分以内に済まなかった"))), 180_000).unref();
  });
  const t = await (await fetch(`${server}/mac/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  })).json();
  if (!t.access_token) throw new Error(t.error ?? "token を受けとれなかった");
  key = t.access_token;
  until = Math.min(t.until, Date.now() + hours * 3600_000);
}

async function post(path, body, signal) {
  const res = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) shutdown("トークンが無効になりました(サーバーの再起動かもしれません)。もう一度起動してください");
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function run(job) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/bin/zsh", ["-c", job.cmd], {
      cwd: job.cwd || homedir(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    current = child;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (chunk, which) => {
      const text = chunk.toString("utf-8");
      if (which === "out") stdout += text;
      else stderr += text;
      if (stdout.length > OUT_MAX) (stdout = stdout.slice(0, OUT_MAX)), (truncated = true);
      if (stderr.length > OUT_MAX) (stderr = stderr.slice(0, OUT_MAX)), (truncated = true);
    };
    child.stdout.on("data", (c) => take(c, "out"));
    child.stderr.on("data", (c) => take(c, "err"));
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // もう居ない
      }
    };
    const timer = setTimeout(() => ((timedOut = true), killGroup()), job.timeout_seconds * 1000);
    const done = (extra) => {
      clearTimeout(timer);
      current = null;
      resolve({
        id: job.id,
        stdout,
        stderr,
        truncated,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        ...extra,
      });
    };
    child.on("error", (e) => {
      stderr += `spawn failed: ${e.message}`;
      done({ exit_code: null, signal: null });
    });
    child.on("close", (code, signal) => done({ exit_code: code, signal }));
  });
}

function shutdown(why) {
  if (closing) return;
  closing = true;
  say(`閉じます(${why})。`);
  if (current) {
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch {
      // もう居ない
    }
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("Ctrl-C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await login();
} catch (e) {
  console.error(`ログインできませんでした: ${e.message}`);
  process.exit(1);
}
say(`loka(${server})へ繋ぎます。あと ${hours} 時間(${new Date(until).toLocaleString("ja-JP")} まで)。Ctrl-C で閉じます。`);

while (!closing) {
  const left = until - Date.now();
  if (left <= 0) shutdown("許可の時間が過ぎました");
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 40_000);
    const reply = await post("/mac/poll", { host: hostname() }, ctl.signal).finally(() => clearTimeout(t));
    if (reply.expired) shutdown("サーバー側でも期限切れ");
    if (reply.job) {
      say(`$ ${reply.job.cmd}  (cwd: ${reply.job.cwd || "~"}, 最大 ${reply.job.timeout_seconds}s)`);
      const result = await run(reply.job);
      say(`→ exit ${result.exit_code ?? result.signal}${result.timed_out ? " (時間切れ)" : ""}`);
      await post("/mac/result", result);
    }
  } catch (e) {
    if (closing) break;
    say(`繋ぎなおします: ${e.message}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
