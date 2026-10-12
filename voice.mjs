// 声 ── アカウントごとの、sukhi への鍵。
//
// loka のアカウントごとに、別のボットの声を持てる。ボットのアカウントに sukhi で
// ログインして、その token をここにしまう(設定ページの「声を繋ぐ」)。
//
//   state/voices/<account>/
//     voice.json        鍵(0600)。繋ぎなおすと置き換わる
//     sukhi_inbox.jsonl 耳が聞いたもの
//     sukhi_heard.json  人ごとに、最後に聞いた一通(sukhi_say / sukhi_ack の返す先)
//     sukhi_ear.json    どこまで見たか
//
// 持ち主だけ、まだ声が無ければ、環境変数(MASTODON_*)を種にする。
// 取り直した token は voice.json に残るので、そのあとは state のほうが先に使われる。

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ownerAccount } from "./auth.mjs";
import { STATE_DIR } from "./paths.mjs";

// アカウント名をそのまま道にしない。".." などで外へ出ないように。
const safeName = (account) => String(account).toLowerCase().replace(/[^a-z0-9._-]/g, "_").replace(/^\.+/, "_");

export const voiceDir = (account) => join(STATE_DIR, "voices", safeName(account));
const voiceFile = (account) => join(voiceDir(account), "voice.json");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

const listFromEnv = (value, fallback) =>
  (value ?? fallback).split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);

// 持ち主の、環境変数からの声。繋がっていなければ null。
function envVoice(account) {
  if (account !== ownerAccount()) return null;
  const { MASTODON_API_BASE_URL: base, MASTODON_ACCESS_TOKEN: accessToken } = process.env;
  if (!base || !accessToken) return null;
  return {
    base: base.replace(/\/+$/, ""),
    accessToken,
    refreshToken: process.env.MASTODON_REFRESH_TOKEN ?? null,
    clientId: process.env.MASTODON_CLIENT_ID ?? null,
    clientSecret: process.env.MASTODON_CLIENT_SECRET ?? null,
    scope: process.env.MASTODON_SCOPE ?? "read write",
    acct: null,
    watch: listFromEnv(process.env.SUKHI_EAR_ACCTS, "nyanrus,kuro43_"),
    connectedAt: "env",
  };
}

/** その部屋の声。無ければ null。返すのは写しなので、書き換えても残らない(残すなら saveVoice)。 */
export function loadVoice(account) {
  const stored = readJson(voiceFile(account));
  const voice = stored ?? envVoice(account);
  return voice ? { ...voice, account, dir: voiceDir(account) } : null;
}

export function saveVoice(account, voice) {
  const { dir: _dir, ...keep } = voice;
  mkdirSync(voiceDir(account), { recursive: true, mode: 0o700 });
  const tmp = `${voiceFile(account)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...keep, account }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, voiceFile(account));
  chmodSync(voiceFile(account), 0o600);
}

/** 声を外す。聞いた控えは残す(繋ぎなおしたとき、続きから読めるように)。 */
export function dropVoice(account) {
  rmSync(voiceFile(account), { force: true });
}

/** 声を持っているアカウントの一覧(環境変数の持ち主も含む)。 */
export function voiceAccounts() {
  let names = [];
  try {
    names = readdirSync(join(STATE_DIR, "voices"));
  } catch {
    // まだ誰も繋いでいない
  }
  const accounts = new Set();
  for (const dir of names) {
    const v = readJson(join(STATE_DIR, "voices", dir, "voice.json"));
    if (v?.account) accounts.add(v.account);
  }
  if (envVoice(ownerAccount())) accounts.add(ownerAccount());
  return [...accounts];
}

// 聴く相手の入力(改行かカンマ区切り)。`user` か `user@host`(別のサーバーの人)。先頭の @ は落とす。
const WATCH_ONE = /^[A-Za-z0-9_.-]+(@[A-Za-z0-9.-]+)?$/;
export const WATCH_MAX = 20;

export function parseWatch(input) {
  const names = [...new Set(String(input ?? "").split(/[\s,]+/).map((a) => a.replace(/^@/, "")).filter(Boolean))];
  const bad = names.find((a) => !WATCH_ONE.test(a));
  if (bad) throw new Error(`「${bad}」は、acct の形(user か user@host)ではありません。`);
  if (names.length > WATCH_MAX) throw new Error(`聴く相手は ${WATCH_MAX} 人までです。`);
  return names;
}
