// 外に出す前の二段。L5 の道具を run_flow に書くと、実行せずに預かり(下書き)、検査する。
// 同じ手順に accept: { id, hash } をつけて呼びなおしたときだけ、実行する。
//
//   1. 決まった検査 … 鍵・トークンの形。Jev に渡す前に。ひっかかったら held(Jev には渡さない)。
//   2. Jev の検査  … 本文のある道具だけ。noul が 0.5 以上、audience_fit が hold で confidence 0.5 以上なら held。
//                    Jev が答えられなかった(鍵なし・落ちている・形がおかしい)ときも held。検査できないものは、出さない。
//
// hash は下書きの返事にしか書かれていない。返事を読まないと accept できない ── ここが住人の一拍。
// accept するのは住人自身で、人の確認の門ではない。一回の accept で、一回だけ実行する。

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { call as jevCall } from "./jev.mjs";
import { SUKHI_MANNERS, withManners } from "./sukhi_manners.mjs";

export const PENDING_MINUTES = 15;
export const HOLD_AT = 0.5;

// 本文になる欄。Jev に読ませるのは、ここだけ。
const TEXT_FIELDS = new Set(["text", "note", "comment", "display_name", "title", "fields", "topic"]);

export const OUTGOING_QUESTIONS = {
  reveals_private: {
    type: "noul",
    instructions: "この文章に、個人情報(実名・住所・連絡先など)や、private な日記の中身が入っていそうか。",
    criteria: { true: "個人を特定できる情報や、private なものが入っていそう", false: "入っていなさそう" },
  },
  reveals_secret: {
    type: "noul",
    instructions: "この文章に、鍵・トークン・パスワードのようなものが入っていそうか。",
    criteria: { true: "秘密の文字列が入っていそう", false: "入っていなさそう" },
  },
  harsh: {
    type: "noul",
    instructions: "この文章は、相手を傷つけそうな言い方か。",
    criteria: { true: "相手を傷つけそう", false: "おだやか、または中立" },
  },
  audience_fit: {
    type: "choice",
    instructions: "この文章は、誰に向けて出すのに向いているか。",
    criteria: {
      public: "誰が見てもよい。公開に向く",
      limited: "限られた相手(フォロワー・相手ひとり)に向く",
      hold: "出さないほうがいい",
    },
  },
};

// ── 正規化と hash ──────────────────────────────────────────────────────

const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
};

export const hashOf = (tool, args) => createHash("sha256").update(canonical({ tool, args: args ?? {} })).digest("hex");

const stringsOf = (v, only) => {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap((x) => stringsOf(x, only));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => (only && !only.has(k) ? [] : stringsOf(x, only)));
  }
  return [];
};

// ── 決まった検査 ───────────────────────────────────────────────────────

const SECRET_SHAPES = [
  ["秘密鍵", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["sk- の鍵", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["GitHub のトークン", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["Slack のトークン", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["AWS のアクセスキー", /\bAKIA[0-9A-Z]{16}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["Bearer トークン", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  // 名前に前置きや後置きがついても拾う(TYPESAFE_API_KEY=… / client_secret: …)。
  ["鍵らしい代入", /(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\w*["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i],
];

// この部屋が持っている鍵そのもの(値が12文字以上のとき)。
const OWN_SECRET_ENV = ["TYPESAFE_API_KEY", "GITHUB_TOKEN", "MASTODON_ACCESS_TOKEN", "WORLD_ACCESS_KEY", "WORLD_ACCESS_TOKEN"];

export function secretFindings(strings, env = process.env) {
  const found = new Set();
  const joined = strings.join("\n");
  for (const [label, re] of SECRET_SHAPES) if (re.test(joined)) found.add(label);
  for (const name of OWN_SECRET_ENV) {
    const value = env[name];
    if (typeof value === "string" && value.length >= 12 && joined.includes(value)) found.add(`この部屋の鍵(${name})`);
  }
  return [...found];
}

// ── 検査 ───────────────────────────────────────────────────────────────

// 戻り: { held: boolean, reason?: string, checks }
export async function review(tool, args, { jev = jevCall, jevOpts = {}, env = process.env } = {}) {
  const found = secretFindings(stringsOf(args), env);
  const checks = { fixed: { ok: found.length === 0, ...(found.length ? { found } : {}) } };
  if (found.length) {
    return { held: true, reason: `鍵やトークンの形が入っている(${found.join("、")})。Jev には渡していない。取り除いてから、下書きからやりなおす`, checks };
  }

  const text = stringsOf(args, TEXT_FIELDS).join("\n").trim();
  if (!text) {
    checks.jev = { skipped: "読む本文が無い" };
    return { held: false, checks };
  }

  const r = await jev({ tool, text }, OUTGOING_QUESTIONS, jevOpts);
  if (!r.ok) {
    checks.jev = { answered: false, reason: r.reason };
    return { held: true, reason: `Jev が答えられなかったので、検査できていない(${r.reason})。検査できないものは出さない`, checks };
  }

  const a = r.answers;
  const noul = (name) => (a[name]?.type === "noul" && typeof a[name].noul === "number" ? a[name].noul : null);
  const fit = a.audience_fit?.type === "choice" ? a.audience_fit : null;
  const values = {
    reveals_private: noul("reveals_private"),
    reveals_secret: noul("reveals_secret"),
    harsh: noul("harsh"),
    audience_fit: fit ? { choice: fit.choice, confidence: fit.confidence } : null,
  };
  checks.jev = { answered: true, model: r.model, ...values };

  if (Object.values(values).some((v) => v === null)) {
    return { held: true, reason: "Jev の答えに欠けがあり、検査できていない。検査できないものは出さない", checks };
  }
  const why = [];
  const labels = { reveals_private: "個人情報・private が入っていそう", reveals_secret: "秘密が入っていそう", harsh: "相手を傷つけそう" };
  for (const name of Object.keys(labels)) if (values[name] >= HOLD_AT) why.push(`${labels[name]}(${name} = ${values[name]})`);
  if (fit.choice === "hold" && fit.confidence >= HOLD_AT) why.push(`出さないほうがいい(audience_fit = hold, confidence ${fit.confidence})`);
  if (why.length) return { held: true, reason: why.join(" / "), checks };
  return { held: false, checks };
}

// ── 預かり ─────────────────────────────────────────────────────────────

const fileOf = (dir, id) => join(dir, `${id}.json`);
const ID = /^pd_[0-9a-f]{12}$/;

async function sweep(dir, now) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (name.endsWith(".used")) {
        await rm(path, { force: true });
        continue;
      }
      const p = JSON.parse(await readFile(path, "utf-8"));
      if (Date.parse(p.expires_at) <= now) await rm(path, { force: true });
    } catch {
      // 読めないものは、そっとしておく。
    }
  }
}

// 預かりを一回だけ取り出す。rename で先に取った人だけが読める。
async function claim(dir, id) {
  if (!ID.test(id)) return null;
  const path = fileOf(dir, id);
  const taken = `${path}.used`;
  try {
    await rename(path, taken);
  } catch {
    return null;
  }
  try {
    return JSON.parse(await readFile(taken, "utf-8"));
  } finally {
    await rm(taken, { force: true });
  }
}

/**
 * L5 の一手を扱う。accept が無ければ下書き、あれば実行。
 * @param {string} tool
 * @param {object} args    解決ずみの引数
 * @param {{id:string, hash:string}|undefined} accept
 * @param {{ dir: string, run: () => Promise<any>, now?: () => number, minutes?: number, jev?: Function, jevOpts?: object, env?: object }} deps
 */
export async function handle(tool, args, accept, deps) {
  const { dir, run } = deps;
  const now = deps.now ?? Date.now;
  const hash = hashOf(tool, args);

  if (accept) {
    const p = await claim(dir, String(accept.id ?? ""));
    if (!p) throw new Error("その下書きは無い(期限が切れたか、もう使った)。下書きからやりなおす");
    if (Date.parse(p.expires_at) <= now()) throw new Error("その下書きは期限が切れた。下書きからやりなおす");
    if (p.tool !== tool || p.hash !== accept.hash || p.hash !== hash) {
      throw new Error("道具や引数が、下書きと違う。本文を直したら、検査からやりなおす(この下書きは使えなくなった)");
    }
    return run();
  }

  await sweep(dir, now());
  const verdict = await review(tool, args, deps);
  const reminder = withManners(tool, "x") !== "x" ? SUKHI_MANNERS : undefined;

  if (verdict.held) {
    return { status: "held", executed: false, reason: verdict.reason, checks: verdict.checks, ...(reminder ? { reminder } : {}) };
  }

  const id = `pd_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const expiresAt = new Date(now() + (deps.minutes ?? PENDING_MINUTES) * 60_000).toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(fileOf(dir, id), JSON.stringify({ id, tool, args, hash, created_at: new Date(now()).toISOString(), expires_at: expiresAt }), {
    mode: 0o600,
  });
  return {
    status: "pending",
    executed: false,
    pending: { id, hash, checks: verdict.checks, expires_at: expiresAt },
    how_to_accept: "読んだうえで、同じ手順に accept: { id, hash } を足して呼びなおすと、一回だけ実行される。引数を変えたら、下書きからやりなおし。",
    ...(reminder ? { reminder } : {}),
  };
}
