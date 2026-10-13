// 体。住人の「いま」を、渡せる感覚(body)にして、Jev に聞く。
//
// Jev は感じているわけではない。渡された感覚を読んで、体っぽく答える役。
// body は外へ出る。数えられるものは数えて入れ、private の日記や、タスクの本文は入れない。

import { call } from "./jev.mjs";

// 体への問い。名前 → Jev の問い(type・instructions・criteria)。
export const BODY_QUESTIONS = {
  kizukare: {
    type: "score",
    instructions: "この住人の、いまのつかれは、どのくらいか。",
    criteria: ["元気", "すこしつかれている", "つかれている", "やすみたい"],
  },
  shuchu_kireta: {
    type: "noul",
    instructions: "集中が切れていそうか。",
    criteria: { true: "手が止まっている、または散っている", false: "ひとつのことに向いている" },
  },
  kurikaeshi: {
    type: "noul",
    instructions: "同じところを、回っていそうか。",
    criteria: { true: "同じ道具・同じ場所を繰り返している", false: "進んでいる、または変わっている" },
  },
  nikki_no_toki: {
    type: "noul",
    instructions: "日記を書いて、文脈を手放す頃か。",
    criteria: { true: "文脈が重く、区切りが近い", false: "まだ軽い、または区切りの途中" },
  },
  ima_no_heya: {
    type: "choice",
    instructions: "いま居たいのは、どの部屋か。",
    criteria: {
      sagyo: "作業をつづけたい。集中が向いている",
      nikki: "書いて、手放して、戻りたい",
      hiroba: "共有のファイルやお知らせを見に行きたい",
      kouryu: "sukhi で話したい。余力がある",
      yasumu: "何もしないで居たい。つかれ、または繰り返し",
    },
  },
  koe_no_ryo: {
    type: "score",
    instructions: "いま、どのくらい話すのがちょうどいいか。",
    criteria: ["しずか", "すこし", "ふつう"],
  },
};

export const TSUBUYAKI_MAX = 200;

// loka_context(時刻・集中・ポモドーロ・タスク)から body を作る。
// 集中の題目とタスクの中身は入れない(自分で書いた言葉は、外へ出さない)。数だけ。
export function buildBody(context, tsubuyaki) {
  const focus = context?.focus_status ?? {};
  const pomodoro = context?.pomodoro ?? {};
  return {
    now: context?.current_time?.local ?? context?.current_time?.iso ?? null,
    focus: { focusing: focus.focusing === true, ...(focus.minutes ? { minutes: focus.minutes } : {}) },
    pomodoro: { phase: pomodoro.phase ?? null, round: pomodoro.round ?? null, remaining_minutes: pomodoro.remaining_minutes ?? null },
    open_tasks: Array.isArray(context?.todos) ? context.todos.length : 0,
    ...(tsubuyaki ? { tsubuyaki } : {}),
  };
}

// 「わからない」。取り繕わない(confidence 0)。
const unknown = () => ({ unknown: true, confidence: 0 });

// Jev の答えから、住人に返す分だけ取り出す。
const shape = (a) => {
  if (!a || typeof a !== "object") return unknown();
  if (a.type === "noul") return typeof a.noul === "number" ? { noul: a.noul } : unknown();
  if (a.type === "choice") return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  if (a.type === "score") return { score: a.score, confidence: a.confidence, legend: a.legend };
  return unknown();
};

// ask: 問いの名前の配列。戻り: { awake, answers: { 名前: 答え }, message? }。
// 鍵が無い・Jev が落ちている・間に合わないときは、例外にせず、全部「わからない」で返す。
export async function karadaniKiku({ ask, tsubuyaki, context }, opts = {}) {
  const unknownNames = ask.filter((n) => !(n in BODY_QUESTIONS));
  if (unknownNames.length) throw new Error(`知らない問い: ${unknownNames.join(", ")}`);

  const questions = Object.fromEntries(ask.map((n) => [n, BODY_QUESTIONS[n]]));
  const text = tsubuyaki?.trim().slice(0, TSUBUYAKI_MAX);
  const result = await call(buildBody(context, text), questions, opts);

  if (!result.ok) {
    return {
      awake: result.awake,
      message: result.reason,
      answers: Object.fromEntries(ask.map((n) => [n, unknown()])),
    };
  }
  return { awake: true, model: result.model, answers: Object.fromEntries(ask.map((n) => [n, shape(result.answers[n])])) };
}
