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
  get_current_time: 1, get_focus_status: 1, get_status: 1, list_tasks: 1, get_rhythm_log: 1, job_status: 1, get_pomodoro: 1,
  list_teams: 1, list_team_members: 1, list_team_files: 1, read_team_file: 1,
  run_mruby_shell: 2, run_flow: 2, write_diary_entry: 2, add_task: 2, complete_task: 2, submit_ticket: 2,
  upload_files: 2,
  log_timestamp: 2, set_status: 2, start_focus: 2, end_focus: 2, choose_work_mode: 2,
  create_team: 2, add_team_member: 2, remove_team_member: 2,
  pomodoro_start: 2, pomodoro_stop: 2,
  reset_context: 3,
  start_job: 4, stop_job: 4,
  move_to_shared_drive: 5, share_to_team: 5,
  fetch_url: 6, github_issues: 6, github_discussions: 6,
  sukhi_read_home: 6, sukhi_read_mentions: 6, sukhi_read_notifications: 6, sukhi_unread_count: 6,
  sukhi_post: 5, sukhi_reply: 5, sukhi_say: 5, sukhi_ack: 5,
  zulip_read: 6, zulip_say: 5,
  mac_status: 1, mac_exec: 7,
};

// run_flow から呼べるのは L1(読む)と L2(書く)だけ。そのうえで、次のものは呼ばない。
//   run_flow / run_mruby_shell … 入れ子にしない
//   日記の三つ                 … 日記は、流れ作業にしない
//   welcome / upload_files     … 挨拶と、バイナリは、流れに向かない
const FLOW_EXCLUDED = new Set([
  "run_flow", "run_mruby_shell", "write_diary_entry", "read_diary_entry", "list_diary_entries", "welcome", "upload_files",
]);

// 呼べるなら null、呼べないなら理由。
export const flowRefusal = (name) => {
  if (!(name in LEVELS)) return `知らない道具: ${name}`;
  if (FLOW_EXCLUDED.has(name)) return `${name} は、流れからは呼ばない`;
  if (LEVELS[name] > 2) return `${name} は ${LEVEL_LABEL[LEVELS[name]]} の道具。流れから呼べるのは L1・L2 まで`;
  return null;
};

export const LEVEL_LABEL = { 1: "L1 読む", 2: "L2 書く", 3: "L3 呼吸", 4: "L4 走らせる", 5: "L5 出す", 6: "L6 外を読む", 7: "L7 Mac を触る" };

export const OPEN_WORLD = new Set([
  "fetch_url", "github_issues", "github_discussions",
  "sukhi_read_home", "sukhi_read_mentions", "sukhi_read_notifications", "sukhi_unread_count",
  "sukhi_post", "sukhi_reply", "sukhi_say", "sukhi_ack",
  "zulip_read", "zulip_say",
]);

// はじめから読み取り(L1/L6)のものは、切り替えの必要がない。
export const isReadOnlyByDesign = (name) => (LEVELS[name] ?? 1) === 1 || LEVELS[name] === 6;

// 本人が「読み取り専用と申告する(確認を省く)」を選べる道具。書き込みの段だけ。
export const CHOOSABLE_TOOLS = Object.entries(LEVELS)
  .filter(([, level]) => level >= 2 && level <= 5)
  .map(([name]) => name);

export const toolLabel = (name) => `${LEVEL_LABEL[LEVELS[name] ?? 1]} · ${name}`;
