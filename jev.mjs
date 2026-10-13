// Jev(TypeSafe AI の System One)の呼び口。state と型つきの問いを渡して、確からしさつきの答えを受ける。
// 公式 quickstart(docs.typesafe.ai)の形: POST /v1/systemone、body は model・state・questions、返事は answers。
//
// state は外へ出る。呼ぶ側が、private なものを入れないこと。
// 鍵(TYPESAFE_API_KEY)が無ければ呼ばない。落ちていても、例外にしない(体を無理に作らない)。

const DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 10_000;

const retryable = (status) => status === 429 || status >= 500;

// 戻り: { ok: true, answers, model } か { ok: false, awake, reason }。
//   awake: false … 鍵が無い(体はまだ起きていない)。 true … 起きているが、いま答えられない。
export async function call(state, questions, opts = {}) {
  const key = opts.key ?? process.env.TYPESAFE_API_KEY;
  if (!key) return { ok: false, awake: false, reason: "体はまだ起きていない(TYPESAFE_API_KEY が無い)" };

  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = opts.url ?? process.env.TYPESAFE_JEV_URL ?? DEFAULT_URL;
  const model = opts.model ?? process.env.TYPESAFE_JEV_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({ model, state, questions });

  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const json = await res.json();
        if (!json?.answers || typeof json.answers !== "object") {
          return { ok: false, awake: true, reason: "Jev の返事に answers が無い" };
        }
        return { ok: true, answers: json.answers, model: json.model ?? model };
      }
      // 鍵や形が違うときは、やりなおしても同じ。落ちている・混んでいるときだけ、もう一度。
      reason = `Jev が ${res.status} を返した`;
      if (!retryable(res.status)) return { ok: false, awake: true, reason };
    } catch (error) {
      reason = error?.name === "TimeoutError" ? "Jev の返事が間に合わなかった" : `Jev に届かなかった: ${error?.message ?? error}`;
    }
  }
  return { ok: false, awake: true, reason };
}
