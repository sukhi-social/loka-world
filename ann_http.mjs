// アン(svar)の細い入口。
//
//   POST /ann/call   { tool: "sukhi", args: { do, … }, accept?: { id, hash } }  →  { ok, result } か { ok: false, error }
//
// svar は、loka の外で動く別のプロセス。loka の合鍵(owner の全権)は渡さず、この口だけの鍵(WORLD_ANN_TOKEN)で入る。
// 呼べるのは sukhi の四つだけ: inbox(読む)/ inbox_done(読み終えた位置を進める)/ reply(呼ばれた投稿に返す)/ say(DM に返す)。
// reply と say は L5 なので、ふつうの道具と同じに、いったん預かって検査する(status: pending)。
// accept を足して呼びなおしたときだけ、出る。accept するかどうかは、svar の側で決める。
// WORLD_ANN_TOKEN が無い(または短い)ときは、この口は無いものとして扱う(404)。

import { timingSafeEqual } from "node:crypto";

import { sendJson } from "./web.mjs";

const PATH = "/ann/call";
const ALLOWED = new Set(["inbox", "inbox_done", "reply", "say"]);
const MAX_BODY = 64 * 1024;
const MIN_TOKEN = 32;

function annToken() {
  const t = process.env.WORLD_ANN_TOKEN ?? "";
  return t.length >= MIN_TOKEN ? t : "";
}

function same(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

// 鍵が合ったあとにだけ読む。大きすぎるときは、読み捨てて(切らずに)413 で返す。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error("大きすぎる"), { status: 413 }));
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
  });
}

/** 受けたら true(返事は出した)。この口の道でなければ false。 */
export async function handleAnn(req, res, url, { hostOk, getServer }) {
  if (url.pathname !== PATH) return false;
  const token = annToken();
  if (!token) return false; // 口を開けていない

  if (!hostOk(req)) return sendJson(res, 403, { ok: false, error: "host を見せない" }), true;
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST で" }, { allow: "POST" }), true;
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!same(given, token)) return sendJson(res, 401, { ok: false, error: "token が要ります" }), true;

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, e.status ?? 400, { ok: false, error: e.status ? e.message : "JSON を読めない" }), true;
  }

  const { tool, args, accept } = body ?? {};
  if (tool !== "sukhi" || !args || typeof args !== "object" || !ALLOWED.has(args.do)) {
    return sendJson(res, 403, { ok: false, error: `この口で呼べるのは sukhi の ${[...ALLOWED].join(" / ")} だけ` }), true;
  }
  if (accept !== undefined && !(typeof accept?.id === "string" && typeof accept?.hash === "string")) {
    return sendJson(res, 400, { ok: false, error: "accept は { id, hash }" }), true;
  }

  try {
    const result = await getServer().callStep("sukhi", args, accept);
    return sendJson(res, 200, { ok: true, result }), true;
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: e.message }), true;
  }
}
