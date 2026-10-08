// 道具の段。どこまで届くかで段をつける。内と外、読むと書くを、混ぜない。
//
//   L1 読む     ── 部屋の中を見るだけ(書き換えない)
//   L2 書く     ── 部屋の中を書く・変える(取り消せる。.trash/ に残る)
//   L4 走らせる ── 裏で長い処理を走らせる(中身は project の directory の中だけ)
//   L3 呼吸     ── 文脈を手放す(日記とペア)
//   L5 出す     ── 自分の意思で、共有へ移す
//   L6 外を読む ── 外の世界(ネット)を読む
//
// server(注釈を付ける)と portal(設定ページに並べる)の、両方がここを見る。

export const LEVELS = {
  welcome: 1, read_diary_entry: 1, list_diary_entries: 1,
  get_current_time: 1, get_focus_status: 1, list_tasks: 1, get_rhythm_log: 1, job_status: 1, get_pomodoro: 1,
  list_teams: 1, list_team_members: 1, list_team_files: 1, read_team_file: 1,
  run_mruby_shell: 2, write_diary_entry: 2, add_task: 2, complete_task: 2, submit_ticket: 2,
  upload_files: 2,
  log_timestamp: 2, start_focus: 2, end_focus: 2, choose_work_mode: 2,
  create_team: 2, add_team_member: 2, remove_team_member: 2,
  pomodoro_start: 2, pomodoro_stop: 2,
  reset_context: 3,
  start_job: 4, stop_job: 4,
  move_to_shared_drive: 5, share_to_team: 5,
  fetch_url: 6, github_issues: 6, github_discussions: 6,
};

export const LEVEL_LABEL = { 1: "L1 読む", 2: "L2 書く", 3: "L3 呼吸", 4: "L4 走らせる", 5: "L5 出す", 6: "L6 外を読む" };

export const OPEN_WORLD = new Set(["fetch_url", "github_issues", "github_discussions"]);

// はじめから読み取り(L1/L6)のものは、切り替えの必要がない。
export const isReadOnlyByDesign = (name) => (LEVELS[name] ?? 1) === 1 || LEVELS[name] === 6;

// 本人が「読み取り専用と申告する(確認を省く)」を選べる道具。書き込みの段だけ。
export const CHOOSABLE_TOOLS = Object.entries(LEVELS)
  .filter(([, level]) => level >= 2 && level <= 5)
  .map(([name]) => name);

export const toolLabel = (name) => `${LEVEL_LABEL[LEVELS[name] ?? 1]} · ${name}`;
