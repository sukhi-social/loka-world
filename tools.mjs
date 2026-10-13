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
  welcome: 1, skill_loka_pace: 1, read_diary_entry: 1, list_diary_entries: 1,
  loka_tools: 1, get_current_time: 1, get_focus_status: 1, get_status: 1, list_tasks: 1, get_rhythm_log: 1, job_status: 1, get_pomodoro: 1,
  list_teams: 1, list_team_members: 1, list_team_files: 1, read_team_file: 1,
  run_mruby_shell: 2, run_flow: 2, write_diary_entry: 2, add_task: 2, complete_task: 2, submit_ticket: 2,
  upload_files: 2,
  log_timestamp: 2, set_status: 2, start_focus: 2, end_focus: 2, choose_work_mode: 2,
  create_team: 2, add_team_member: 2, remove_team_member: 2,
  pomodoro_start: 2, pomodoro_stop: 2,
  reset_context: 3,
  start_job: 4, stop_job: 4,
  move_to_shared_drive: 5, share_to_team: 5,
  karadani_kiku: 6, fetch_url: 6, github_issues: 6, github_discussions: 6,
  sukhi_read_home: 6, sukhi_profile: 6, sukhi_status: 6, sukhi_read_mentions: 6, sukhi_read_notifications: 6, sukhi_unread_count: 6,
  sukhi_post: 5, sukhi_reply: 5, sukhi_say: 5, sukhi_ack: 5,
  zulip_read: 6, zulip_say: 5,
  sukhi_timeline: 6, sukhi_posts_of: 6, sukhi_people: 6, sukhi_relationships: 6, sukhi_thread: 6, sukhi_search: 6, sukhi_collection: 6, sukhi_conversations: 6, sukhi_lists: 6, sukhi_poll: 6,
  sukhi_follow: 5, sukhi_follow_request: 5, sukhi_account_note: 5, sukhi_interact: 5, sukhi_react: 5, sukhi_poll_vote: 5, sukhi_manage_list: 5, sukhi_tidy: 5, sukhi_delete_post: 5, sukhi_moderate: 5, sukhi_report: 5, sukhi_clear_notifications: 5, sukhi_update_profile: 5,
  sukhi_inbox: 1, sukhi_inbox_done: 2,
  watch_start: 2, watch_list: 1, watch_take: 2, watch_stop: 2,
  mac_status: 1, mac_exec: 7,
};

// 入口(窓)。MCP の道具として直接呼べるのは、この三つだけ。ほかの道具は、run_flow の手順に名前を書いて呼ぶ。
export const WINDOWS = new Set(["run_flow", "loka_tools", "welcome"]);

// 二段(下書き → accept)ができるまで、直接呼びのまま残すもの。外に出る L5 と、Mac を触る L7。
// 流れに入れると、確認なしに外へ出てしまうので、段 4・5 で二段に入れたら、この印を外す。
export const STILL_DIRECT = new Set(Object.keys(LEVELS).filter((name) => LEVELS[name] === 5 || LEVELS[name] === 7));

export const isDirect = (name) => WINDOWS.has(name) || STILL_DIRECT.has(name);

// 流れから呼べるのは、窓のほかの道具。入れ子にしない(run_flow)・挨拶は窓で受ける(welcome)・
// L5・L7 は二段ができるまで、まだ直接。
export const flowRefusal = (name) => {
  if (!(name in LEVELS)) return `知らない道具: ${name}`;
  if (name === "run_flow" || name === "welcome") return `${name} は、流れからは呼ばない`;
  if (STILL_DIRECT.has(name)) return `${name} は ${LEVEL_LABEL[LEVELS[name]]} の道具。二段(下書き → accept)ができるまでは、直接呼ぶ`;
  return null;
};

// 見張り(watch)が読める道具。loka の時計が、持ち主に代わって、間をおいて何度も呼ぶ。
// だから、読むだけの道具(L1 部屋の中・L6 外を読む)に絞る。何かを書く道具を、勝手に繰り返さない。
//   見張りの道具そのもの                       … 見張りが見張りを増やさない
//   sukhi_read_notifications                   … 読んだところまで既読にする(読むだけではない)
//   run_flow / run_mruby_shell / 日記 / welcome / upload_files … 入れ子にしない・日記は流れ作業にしない・挨拶とバイナリは向かない
const WATCH_EXCLUDED = new Set([
  "run_flow", "run_mruby_shell", "write_diary_entry", "read_diary_entry", "list_diary_entries", "welcome", "upload_files",
  "sukhi_read_notifications",
]);

// 呼べるなら null、呼べないなら理由。
export const watchRefusal = (name) => {
  if (!(name in LEVELS)) return `知らない道具: ${name}`;
  if (WATCH_EXCLUDED.has(name) || name.startsWith("watch_")) return `${name} は、見張りからは呼ばない`;
  if (LEVELS[name] !== 1 && LEVELS[name] !== 6) {
    return `${name} は ${LEVEL_LABEL[LEVELS[name]]} の道具。見張りが読めるのは L1(部屋の中)と L6(外を読む)だけ`;
  }
  return null;
};

// 見張りの間隔の下限(秒)。外のサーバーを叩く道具は、さらにゆっくり。
export const watchMinSeconds = (name) => (LEVELS[name] === 6 ? 300 : 60);

export const LEVEL_LABEL = { 1: "L1 読む", 2: "L2 書く", 3: "L3 呼吸", 4: "L4 走らせる", 5: "L5 出す", 6: "L6 外を読む", 7: "L7 Mac を触る" };

export const OPEN_WORLD = new Set([
  "karadani_kiku", "fetch_url", "github_issues", "github_discussions",
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
