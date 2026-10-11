// 耳の管理。声を持っているアカウントごとに、耳をひとつ。
//
// 起動のときに全員ぶん立てて、声が繋がれたら(繋ぎなおされたら)その人のぶんを立てなおし、
// 声が外されたら止める。SUKHI_EAR=off で、ぜんぶ止める。

import { sukhiFor } from "./sukhi.mjs";
import { startEar } from "./sukhi_ear.mjs";
import { loadVoice, voiceAccounts } from "./voice.mjs";

const ears = new Map(); // account → { stamp, stop }

export function stopEar(account) {
  ears.get(account)?.stop();
  ears.delete(account);
}

export async function ensureEar(account, log = (...a) => console.error(`sukhi-ear(${account}):`, ...a)) {
  if (process.env.SUKHI_EAR === "off") return;
  const voice = loadVoice(account);
  if (!voice) return stopEar(account);
  const hit = ears.get(account);
  if (hit?.stamp === voice.connectedAt) return;

  stopEar(account);
  // 立てているあいだに、もう一度呼ばれても二重にならないよう、先に席を取る。
  const seat = { stamp: voice.connectedAt, stop: () => {} };
  ears.set(account, seat);
  try {
    const ear = await startEar({ sukhi: sukhiFor(account), accts: voice.watch ?? [], dir: voice.dir, log });
    if (ears.get(account) === seat) seat.stop = ear.stop;
    else ear.stop(); // 立てているあいだに、外された・立てなおされた
  } catch (e) {
    if (ears.get(account) === seat) ears.delete(account);
    log(`立てられませんでした (${e.message})`); // 耳が無くても、部屋は開ける
  }
}

export const startAllEars = () => Promise.all(voiceAccounts().map((a) => ensureEar(a)));
