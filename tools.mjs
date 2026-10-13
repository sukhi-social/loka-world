// 道具の段。どこまで届くかで段をつける。内と外、読むと書くを、混ぜない。
//
//   L1 読む     ── 部屋の中を見るだけ(書き換えない)
//   L2 書く     ── 部屋の中を書く・変える(取り消せる。.trash/ に残る)
//   L4 走らせる ── 裏で長い処理を走らせる(中身は project の directory の中だけ)
//   L3 呼吸     ── 文脈を手放す(日記とペア)
//   L5 出す     ── 自分の意思で、共有へ移す
//   L6 外を読む ── 外の世界(ネット)を読む
//   L7 Mac を触る ── 持ち主の Mac のシェル(持ち主が agent を起動した時間だけ。申告で確認を省けない)
//
// server(注釈を付ける)と portal(設定ページに並べる)の、両方がここを見る。

export const LEVELS = {
  welcome: 1, skill_loka_pace: 1, diary_read: 1, diary_list: 1,
  loka_tools: 1, clock_now: 1, focus_status: 1, status_get: 1, task_list: 1, clock_rhythm: 1, job_status: 1, pomodoro_get: 1,
  team_list: 1, team_members: 1, team_files: 1, team_read: 1,
  run_mruby_shell: 2, run_flow: 2, diary_write: 2, task_add: 2, task_complete: 2, submit_ticket: 2,
  upload_files: 2,
  clock_log: 2, status_set: 2, focus_start: 2, focus_end: 2, focus_work_mode: 2,
  team_create: 2, team_add_member: 2, team_remove_member: 2,
  pomodoro_start: 2, pomodoro_stop: 2,
  reset_context: 3,
  job_start: 4, job_stop: 4,
  move_to_shared_drive: 5, team_share: 5,
  karadani_kiku: 6, web_fetch: 6, web_github_issues: 6, web_github_discussions: 6,
  sukhi_read_home: 6, sukhi_profile: 6, sukhi_status: 6, sukhi_read_mentions: 6, sukhi_read_notifications: 6, sukhi_unread_count: 6,
  sukhi_post: 5, sukhi_reply: 5, sukhi_say: 5, sukhi_ack: 5,
  zulip_read: 6, zulip_say: 5,
  sukhi_timeline: 6, sukhi_posts_of: 6, sukhi_people: 6, sukhi_relationships: 6, sukhi_thread: 6, sukhi_search: 6, sukhi_collection: 6, sukhi_conversations: 6, sukhi_lists: 6, sukhi_poll: 6,
  sukhi_follow: 5, sukhi_follow_request: 5, sukhi_account_note: 5, sukhi_interact: 5, sukhi_react: 5, sukhi_poll_vote: 5, sukhi_manage_list: 5, sukhi_tidy: 5, sukhi_delete_post: 5, sukhi_moderate: 5, sukhi_report: 5, sukhi_clear_notifications: 5, sukhi_update_profile: 5,
  sukhi_inbox: 1, sukhi_inbox_done: 2,
  watch_start: 2, watch_list: 1, watch_take: 2, watch_stop: 2,
  mac_status: 1, mac_exec: 7,
};

// ── ファミリー ───────────────────────────────────────────────────────────
//
// 道具を、ファミリーごとにひとつにまとめて呼ぶ。シェルが、ファイルの読む・書く・並べるを一つにしているのと同じ。
//   tool: "sukhi", args: { do: "post", text: "…" }
// 内部の名前(op)は「<ファミリー>_<動作>」(sukhi_post)。段は op ごとに持ち、二段・見張り・wait の判断は op を見て決める。
// ファミリーに入らない道具は、そのままの名前で呼ぶ(run_flow・run_mruby_shell など)。

export const FAMILIES = {
  sukhi: "sukhi(fediverse)。読む(timeline・thread・search など)も、出す(post・reply・say など)も、これひとつ。",
  zulip: "Zulip を読む・言う。",
  team: "チーム。作る・メンバーやファイルを見る・共有する。",
  task: "やること。一覧・足す・終える。",
  focus: "集中。はじめる・終える・いまの状態・働きかたを選ぶ。",
  pomodoro: "ポモドーロ。はじめる・止める・いまの区切りを見る。",
  diary: "日記。書く・読む・一覧。",
  job: "裏で走らせる処理。はじめる・止める・結果を見る。",
  watch: "見張り。待つことを、loka の時計に預ける。",
  web: "外を読む。URL と、GitHub の issue・discussion。",
  clock: "時刻とリズム。いま・時刻の記録・リズムの記録。",
  status: "いまの状態(ひとこと)。見る・置く。",
};

export const familyOfOp = (op) => Object.keys(FAMILIES).find((f) => op.startsWith(`${f}_`));

// 呼ぶときの名前。ファミリーに入る道具は { tool: ファミリー, do: 動作 }、入らない道具は { tool: 名前 }。
export const toolOf = (op) => {
  const family = familyOfOp(op);
  return family ? { tool: family, do: op.slice(family.length + 1) } : { tool: op };
};

// ファミリーの動作の一覧(段、名前の順)。
export const verbsOf = (family) =>
  Object.keys(LEVELS)
    .filter((op) => op.startsWith(`${family}_`))
    .sort((a, b) => LEVELS[a] - LEVELS[b] || a.localeCompare(b))
    .map((op) => op.slice(family.length + 1));

// 呼ぶ名前と引数から、内部の道具(op)と、道具に渡す引数を決める。戻り: { op, args } か { error }。
// do は ${} で埋めず、そのまま書く(動かす前に、段で断れるように)。
export function resolveTool(tool, args = {}) {
  if (tool in FAMILIES) {
    const verbs = verbsOf(tool);
    const verb = args?.do;
    if (typeof verb !== "string" || verb.includes("${")) {
      return { error: `${tool} は args.do で動作を選ぶ(${verbs.join(" / ")})。do は \${} で埋めず、そのまま書く` };
    }
    if (!verbs.includes(verb)) return { error: `${tool} に do: "${verb}" は無い。あるのは: ${verbs.join(" / ")}` };
    const { do: _verb, ...rest } = args;
    return { op: `${tool}_${verb}`, args: rest };
  }
  if (tool in LEVELS) {
    const family = familyOfOp(tool);
    if (family) return { error: `${tool} という名前では呼べない。tool: "${family}", args: { do: "${tool.slice(family.length + 1)}", … } で呼ぶ` };
    return { op: tool, args };
  }
  return { error: `知らない道具: ${tool}` };
}

// ファミリーになる前の名前(見張りに預けたまま残っているもの)を、いまの呼びかたに直す。時計が回すときだけ使う。
const LEGACY_NAMES = {
  create_team: "team_create", list_teams: "team_list", add_team_member: "team_add_member", remove_team_member: "team_remove_member",
  list_team_members: "team_members", list_team_files: "team_files", read_team_file: "team_read", share_to_team: "team_share",
  list_tasks: "task_list", add_task: "task_add", complete_task: "task_complete",
  get_focus_status: "focus_status", start_focus: "focus_start", end_focus: "focus_end", choose_work_mode: "focus_work_mode",
  get_pomodoro: "pomodoro_get", list_diary_entries: "diary_list", read_diary_entry: "diary_read", write_diary_entry: "diary_write",
  start_job: "job_start", stop_job: "job_stop", fetch_url: "web_fetch", github_issues: "web_github_issues", github_discussions: "web_github_discussions",
  get_current_time: "clock_now", log_timestamp: "clock_log", get_rhythm_log: "clock_rhythm", get_status: "status_get", set_status: "status_set",
};

export const modernize = (tool, args = {}) => {
  const op = LEGACY_NAMES[tool] ?? tool;
  const family = tool in FAMILIES ? undefined : familyOfOp(op);
  return family ? { tool: family, args: { do: op.slice(family.length + 1), ...args } } : { tool, args };
};

// 入口(窓)。MCP の道具として直接呼べるのは、この三つだけ。ほかの道具は、run_flow の手順に名前を書いて呼ぶ。
export const WINDOWS = new Set(["run_flow", "loka_tools", "welcome"]);

// 二段(下書き → accept)ができるまで、直接呼びのまま残すもの。いまは Mac を触る L7 だけ(段 5 で二段に入れたら、この印を外す)。
// 外に出る L5 は、段 4 で二段に入った(outgoing.mjs)。流れに書くと、下書きとして預かられる。
export const STILL_DIRECT = new Set(Object.keys(LEVELS).filter((name) => LEVELS[name] === 7));

// 二段で守る道具(L5)。流れの手順に書くと、実行せずに預かられる。
export const needsReview = (name) => LEVELS[name] === 5;

export const isDirect = (name) => WINDOWS.has(name) || STILL_DIRECT.has(name);

// 流れから呼べるのは、窓のほかの道具。入れ子にしない(run_flow)・挨拶は窓で受ける(welcome)・
// L7 は二段ができるまで、まだ直接。
const flowRefusalOp = (name) => {
  if (!(name in LEVELS)) return `知らない道具: ${name}`;
  if (name === "run_flow" || name === "welcome") return `${name} は、流れからは呼ばない`;
  if (STILL_DIRECT.has(name)) return `${name} は ${LEVEL_LABEL[LEVELS[name]]} の道具。二段(下書き → accept)ができるまでは、直接呼ぶ`;
  return null;
};

// wait は、同じ道具を何度も呼ぶ。下書きを繰り返し作らないよう、二段の道具(L5)は置かない。
const waitRefusalOp = (name) => {
  const why = flowRefusalOp(name);
  if (why) return why;
  if (needsReview(name)) return `${name} は ${LEVEL_LABEL[LEVELS[name]]} の道具。二段(下書き → accept)の道具は、wait で繰り返し呼ばない`;
  return null;
};

// 見張り(watch)が読める道具。loka の時計が、持ち主に代わって、間をおいて何度も呼ぶ。
// だから、読むだけの道具(L1 部屋の中・L6 外を読む)に絞る。何かを書く道具を、勝手に繰り返さない。
//   見張りの道具そのもの                       … 見張りが見張りを増やさない
//   sukhi_read_notifications                   … 読んだところまで既読にする(読むだけではない)
//   run_flow / run_mruby_shell / 日記 / welcome / upload_files … 入れ子にしない・日記は流れ作業にしない・挨拶とバイナリは向かない
const WATCH_EXCLUDED = new Set([
  "run_flow", "run_mruby_shell", "diary_write", "diary_read", "diary_list", "welcome", "upload_files",
  "sukhi_read_notifications",
]);

// 呼べるなら null、呼べないなら理由。
const watchRefusalOp = (name) => {
  if (!(name in LEVELS)) return `知らない道具: ${name}`;
  if (WATCH_EXCLUDED.has(name) || name.startsWith("watch_")) return `${name} は、見張りからは呼ばない`;
  if (LEVELS[name] !== 1 && LEVELS[name] !== 6) {
    return `${name} は ${LEVEL_LABEL[LEVELS[name]]} の道具。見張りが読めるのは L1(部屋の中)と L6(外を読む)だけ`;
  }
  return null;
};

// 見張りの間隔の下限(秒)。外のサーバーを叩く道具は、さらにゆっくり。
export const watchMinSeconds = (tool, args) => {
  const r = resolveTool(tool, args);
  return LEVELS[r.op] === 6 ? 300 : 60;
};

// 呼ぶ名前(tool と args)を受けて、呼べるなら null、呼べないなら理由。
const viaOp = (check) => (tool, args) => {
  const r = resolveTool(tool, args);
  return r.error ?? check(r.op);
};
export const flowRefusal = viaOp(flowRefusalOp);
export const waitRefusal = viaOp(waitRefusalOp);
export const watchRefusal = viaOp(watchRefusalOp);

export const LEVEL_LABEL = { 1: "L1 読む", 2: "L2 書く", 3: "L3 呼吸", 4: "L4 走らせる", 5: "L5 出す", 6: "L6 外を読む", 7: "L7 Mac を触る" };

export const OPEN_WORLD = new Set([
  "karadani_kiku", "web_fetch", "web_github_issues", "web_github_discussions",
  "sukhi_read_home", "sukhi_profile", "sukhi_status", "sukhi_read_mentions", "sukhi_read_notifications", "sukhi_unread_count",
  "sukhi_post", "sukhi_reply", "sukhi_say", "sukhi_ack",
  "zulip_read", "zulip_say",
  "sukhi_timeline", "sukhi_posts_of", "sukhi_people", "sukhi_relationships", "sukhi_thread", "sukhi_search", "sukhi_collection", "sukhi_conversations", "sukhi_lists", "sukhi_poll", "sukhi_follow", "sukhi_follow_request", "sukhi_account_note", "sukhi_interact", "sukhi_react", "sukhi_poll_vote", "sukhi_manage_list", "sukhi_tidy", "sukhi_delete_post", "sukhi_moderate", "sukhi_report", "sukhi_clear_notifications", "sukhi_update_profile",
]);

// はじめから読み取り(L1/L6)のものは、切り替えの必要がない。
export const isReadOnlyByDesign = (name) => (LEVELS[name] ?? 1) === 1 || LEVELS[name] === 6;

// 消す・取り返しにくい・見える場所の身元を変える道具。確認が出る側のままにする。
// 設定ページで「読み取り専用と申告」には選べず、all / * を指定しても含まれない。
export const CONFIRM_ALWAYS = new Set([
  "sukhi_delete_post", "sukhi_moderate", "sukhi_report", "sukhi_clear_notifications", "sukhi_update_profile",
]);

// 本人が「読み取り専用と申告する(確認を省く)」を選べる道具。書き込みの段だけ。確認が要る道具は除く。
export const CHOOSABLE_TOOLS = Object.entries(LEVELS)
  .filter(([name, level]) => level >= 2 && level <= 5 && !CONFIRM_ALWAYS.has(name))
  .map(([name]) => name);

export const toolLabel = (name) => `${LEVEL_LABEL[LEVELS[name] ?? 1]} · ${name}`;
