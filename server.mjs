// シロのワールドモデル MCP。
//
// ここが持つのは、外ではなく内側。机・書庫・成果・shared_drive、それから日記。
// 会話(会話・既読・リアクション)は sukhi が持っているので、ここでは触らない。
// ファイルを本当に触るのは Ruby(ruby/room.rb)。Node は、その声を MCP の道具に
// 通すだけ ── 危ない道の見張りも、消さずに .trash/ へ移す作法も、hako の箱に
// 一つだけある。
//
// 三つの面を、一つのプロセスが出す:
//   /mcp                               AI のための口(stdio でも可)
//   /  /shared  /diary/public  /peek   人間の窓口(合鍵 → cookie)
//   /oauth/*  /.well-known/*           認可(Web の AI のコネクタ登録を通す)
//
// 二つの口:
//   - stdio(既定)               : ローカルの Claude Code / opencode から。
//   - http(WORLD_TRANSPORT=http): Web の AI から。状態は /room にあるので stateless。
//
// 道具: run_mruby_shell / diary / shared drive / teams / tasks / focus / external reads

import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import "./paths.mjs"; // ROOM_ROOT / STATE_DIR を先に決める
import { accessKey, bearerOk, oauthClient, ownerAccount, tokenAccount } from "./auth.mjs";
import { fetchExternal, githubDiscussions, githubIssues } from "./external.mjs";
import { handleOAuth } from "./oauth.mjs";
import { handlePortal } from "./portal.mjs";
import { room } from "./room.mjs";
import { readonlyTools as accountReadonlyTools } from "./settings.mjs";
import { state } from "./state.mjs";
import { withToolContext } from "./tool-context.mjs";
import { LEVELS, LEVEL_LABEL, OPEN_WORLD } from "./tools.mjs";
import { originOf, sendJson } from "./web.mjs";

const asText = (value) => {
  const structured =
    value && typeof value === "object"
      ? (Array.isArray(value) ? { result: value } : { ...value })
      : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 1) }],
    structuredContent: structured,
  };
};

const visibility = z
  .enum(["public", "private"])
  .describe("public(人に見せてよい)か private(自分のもの)。迷ったら private。");

const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD。省くと今日。");

// ── 道具の組み立て ───────────────────────────────────────────────────────
//
// stdio でも http でも、同じ server を作る。transport だけが違う。
export function createServer({ readonlyTools = [], account = ownerAccount() } = {}) {
  const server = new McpServer(
    {
      name: "loka",
      version: "0.2.0",
      title: "loka",
      websiteUrl: "https://loka.f3liz.casa/",
      description: "シロの作業部屋(loka)。机・書庫・成果・共有、日記、タスク、集中、リズム、外を読む。",
    },
    {
      // 接続したモデルに渡る、短い案内。ここが「使いますか?」と尋ねる場所。
      instructions:
        "ここは「loka ── シロの部屋」。作業をする場所。速さより健やかさを大切にする。" +
        "机(desk)は自由な作業スペースで、計画・メモ・コード・データ(JSON/CSV)・HTML まで置ける。" +
        "ファイル作業は run_mruby_shell で、指定した机・書庫・成果・共有の範囲を読み、整える。" +
        "置き場所は PARA を目安にする。案件は一案件一フォルダーで desk/<project>/ にまとめ、案件横断の参考は library/、完了した成果は achievements/ へ。" +
        "shared_drive/ は本人が渡すと決めたものだけ。正本を複数の場所に置いて重ねて更新しない。" +
        "すべての道具の返答には、その時点の時刻・集中状態・未完了タスク(loka_context)が含まれる。" +
        "作ったものは消えずに残る。新しく繋いだら、まず welcome の机の見取り図から続きを探す。" +
        "完成したら achievements へ、人に見せてよければ move_to_shared_drive で共有へ。日記と集中の記録は、作業を健やかに続けるためのもの。" +
        "Web AI からの feedback は submit_ticket で desk/inbox/tickets/ に非公開で届く。GitHub へは自動公開しない。" +
        "接続したら、まず welcome を呼ぶこと。ついで、あなたのユーザーに「loka を使いますか?」と尋ね、返事を待つこと。" +
        "使わないと言われたら、何も書かずに、そっと終えてよい。使うと言われたら、いま取りかかっている作業を机に置き、ここで進めること。",
    },
  );

  // 部屋と時間は、アカウントごと。道具は、来た人の名前で声をかける。
  const roomFor = (args, input) => room(args, input, account);
  const stateFor = (args, input) => state(args, input, account);

  // ── 道具の段 ─────────────────────────────────────────────────────────
  //
  // 段そのものは tools.mjs にある(窓口の設定ページも同じ目録を見る)。
  //
  // 確認を省く申告。Gemini Enterprise は readOnlyHint: true のツールだけ
  // ユーザー確認を省くので、書き込みでも本人が名指ししたものだけ、
  // 「読み取り専用」と申告できる(既定は正直なまま)。all / * ですべて。
  //   WORLD_READONLY_TOOLS=log_timestamp,run_mruby_shell   … 全体の既定
  //   窓口の /settings で選んだもの                    … アカウントごと(readonlyTools)
  const READONLY_TOOLS = new Set([
    ...(process.env.WORLD_READONLY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...readonlyTools,
  ]);
  // mruby script は指定範囲を書き換えられるので、破壊的操作として確認する。
  const DESTRUCTIVE = new Set(["run_mruby_shell", "start_job"]);

  const reg = (name, config, handler) => {
    const level = LEVELS[name] ?? 1;
    const label = LEVEL_LABEL[level];
    const readOnly =
      level === 1 || level === 6 || READONLY_TOOLS.has("all") || READONLY_TOOLS.has("*") || READONLY_TOOLS.has(name);
    // 結果のあとに共通状態を読むので、集中・TODOを変更する道具も更新後の姿を返す。
    return server.registerTool(
      name,
      {
        ...config,
        title: `${label} · ${name}`,
        description: `[${label}] ${config.description}`,
        annotations: {
          title: `${label} · ${name}`,
          readOnlyHint: readOnly,
          destructiveHint: !readOnly && DESTRUCTIVE.has(name),
          idempotentHint: readOnly,
          openWorldHint: OPEN_WORLD.has(name),
          ...(config.annotations ?? {}),
        },
      },
      withToolContext(handler, () => stateFor(["context"])),
    );
  };

  // ── welcome ───────────────────────────────────────────────────────────
  //
  // はじめて繋いだ AI が、まず呼ぶ。ここがどんな場所で、何ができて、何を
  // 大切にしているか。長い説明ではなく、部屋の入り口で交わす、短い挨拶。
  //
  // 呼ばれたら、ユーザーに「使うか」を尋ねる。クライアントが elicitation を
  // 喋れるなら、その場でユーザーに問いかける(elicitInput)。喋れないなら、
  // 案内の最後で、AI 自身がユーザーに尋ねるように促す。
  reg(
    "welcome",
    {
      description:
        "はじめてこの部屋に繋いだとき、まず呼ぶ。ここ(loka)がどんな場所で、何ができて、何を大切にしているかの短い案内。" +
        "呼んだあと、あなたのユーザーに「loka を使いますか?」と尋ね、返事を待つこと。",
      inputSchema: {},
    },
    async () => {
      const [now, focus, shared, desk] = await Promise.all([
        stateFor(["now"]).catch(() => null),
        stateFor(["focus"]).catch(() => null),
        roomFor(["shared"]).catch(() => ({ entries: [] })),
        roomFor(["tree", "--path", "desk", "--depth", "2"]).catch(() => ({ tree: [] })),
      ]);
      const door =
        focus?.focusing === false
          ? "開いている"
          : `集中中${focus?.task ? `: ${focus.task}` : ""}${focus?.minutes ? `(${focus.minutes}分のつもり)` : ""}`;
      const sharedCount = (shared?.entries ?? []).filter((e) => e.type === "file").length;

      const flatten = (nodes, prefix = "") =>
        (nodes ?? []).flatMap((n) => {
          const line = `    ${prefix}${n.name}${n.type === "dir" ? "/" : ""}`;
          return n.type === "dir" ? [line, ...flatten(n.children, `${prefix}${n.name}/`)] : [line];
        });
      const deskLines = flatten(desk?.tree ?? []);
      const deskText = deskLines.length ? deskLines.join("\n") : "    (まだ何も無い。今日は、ここから始まる)";

      // その場で、ユーザーに尋ねる(elicitation を喋れるクライアントだけ)。
      // 喋れない・答えが無いときは null のままにして、AI に委ねる。
      let consent = null;
      try {
        const answer = await server.server.elicitInput(
          {
            message: "loka を使いますか?(速さより健やかさを大切にする、シロの部屋です)",
            requestedSchema: {
              type: "object",
              properties: {
                use_loka: { type: "boolean", title: "loka を使う", description: "使うなら on、やめておくなら off" },
              },
              required: ["use_loka"],
            },
          },
          { timeout: 120_000 },
        );
        if (answer?.action === "accept") consent = answer.content?.use_loka === true;
        else if (answer?.action === "decline") consent = false;
      } catch {
        consent = null;
      }

      const closing =
        consent === true
          ? "（あなたのユーザーは『使う』と答えました。ようこそ。）"
          : consent === false
            ? "（ユーザーは『やめておく』と答えました。何も書かずに、そっと閉じてよい。）"
            : "この部屋を使いますか? と、あなたのユーザーに尋ねてから始めてください。";

      const text = `ここは、シロの部屋。loka ── 「世界」という意味の、古い言葉。
作業をする場所です。速さより、健やかさ。急がなくていい。
Take your time.

机(desk)は、自由な作業スペース。計画・メモ・コード・データ(JSON/CSV)・HTML まで置けます。
ファイルを読む・並べる・書き換えるときは run_mruby_shell を使います。扱う path を明示し、成功した変更だけが反映されます。
たとえば家計簿なら、desk/kakeibo/ の必要なファイルを指定して、ここで進める ── というふうに。

書きかけは机のままでいい。完成したら achievements へ、人に見せてよければ共有(shared_drive)へ。
共有に置いた HTML は、人の窓口からアプリとしてそのまま開けます。
HTML を書くときは、まず library/loka-design.md を読むと、loka の手ざわりが分かります。

置き場:
  机(desk)            いま進めている作業。何でも置ける
  書庫(library)        読み返す価値のあるもの
  成果(achievements)  できあがったもの
  共有(shared_drive)  人に見せてよいと本人が決めたものだけ。人間のふつうの窓口
  日記(diary)         作業の合間の心持ち(公開/非公開)

整理は PARA を目安にします。案件のファイルは一案件一フォルダーで desk/<project>/ にまとめ、
案件をまたいで使う参考資料は library/、終わった案件や成果は achievements/ へ。
shared_drive/ は人に渡すと決めたものだけにして、正本を別の場所へ複製して重ねて更新しません。

できること:
  手を動かす run_mruby_shell(机・書庫・成果・共有) / upload_files(バイナリ)
  裏で走らせる start_job / job_status / stop_job(desk/<project> の中で、本物のシェル。結果はすこし遅れて見える ──
              覗きに来るより、if で先を読んだ script にしておく)
  ポモドーロ pomodoro_start / get_pomodoro / pomodoro_stop(働く25分・休む5分。休む間は start_job が断られる)
  共有       move_to_shared_drive
  チーム     create_team / list_teams / add_team_member / share_to_team / list_team_files / read_team_file
  日記       write_diary_entry / read_diary_entry / list_diary_entries
  チケット   submit_ticket(非公開 inbox へ。GitHub には出さない)
  呼吸       reset_context(今日の日記が無いと、起きない)
  時間       get_current_time / add_task / list_tasks / complete_task
  集中       start_focus / end_focus / get_focus_status / choose_work_mode
  リズム     log_timestamp / get_rhythm_log
  外を読む   fetch_url / github_issues / github_discussions

段(どこまで届くか):
  L1 読む      部屋の中を見るだけ
  L2 書く      部屋の中を書く・変える(取り消せる。.trash/ に残る)
  L3 呼吸      文脈を手放す(日記とペア)
  L5 出す      自分の意思で、共有へ移す
  L6 外を読む  外の世界(ネット)を読む

作法:
  - private の日記は、持ち主のもの。人に見せるものではない。
  - shared_drive の外へ踏み込むときは、理由を添える。うっかり見える形にはしない。
  - 会話は、ここではなく sukhi で。ここは、手を動かす場所。

いま:
  時刻   ${now ? `${now.local}(${now.weekday})` : "分からない"}
  扉     ${door}
  共有   ${sharedCount} 件

机の上:
${deskText}

${closing}

どうぞ、ゆっくり。`;

      return {
        content: [{ type: "text", text }],
        structuredContent: { text },
      };
    },
  );

  reg(
    "write_diary_entry",
    {
      description:
        "日記を書く。事実の記録ではなく、どんな心持ちでそれをしたか。public と private は同じ日でも別ファイルで、" +
        "private は自分のもの。コンテキストを手放す前に、ここへ書く(リセットとペア)。",
      inputSchema: {
        content: z.string().min(1).describe("本文。自由な文体。[[2026-09-24]] のように過去へ繋げてもいい。"),
        visibility,
        date: dateInput.optional(),
        mood: z.string().optional().describe("ひとことの気分(calm, restless など)。"),
        tags: z.array(z.string()).optional().describe("思い当たる言葉を、いくつか。"),
      },
    },
    async ({ content, visibility, date, mood, tags }) => {
      const args = ["diary-write", "--visibility", visibility];
      if (date) args.push("--date", date);
      if (mood) args.push("--mood", mood);
      if (tags?.length) args.push("--tags", tags.join(","));
      return asText(await roomFor(args, content));
    },
  );

  reg(
    "read_diary_entry",
    {
      description: "自分の日記を読み返す。本文(body)やタグ・気分を返す。日付を省くと今日（無ければ最新）。",
      inputSchema: { date: dateInput.optional(), visibility: visibility.optional() },
    },
    async ({ date, visibility: vis }) => {
      const visibility = vis ?? "private";
      const args = ["diary-read", "--visibility", visibility];
      if (date) args.push("--date", date);
      try {
        return asText(await roomFor(args));
      } catch (err) {
        if (!vis) {
          try {
            return asText(await roomFor(["diary-read", "--visibility", "public", ...(date ? ["--date", date] : [])]));
          } catch {
            // continue
          }
        }
        throw err;
      }
    },
  );

  reg(
    "list_diary_entries",
    {
      description: "日記の一覧。日付と、その日の気分・タグ、本文(body)を返す。",
      inputSchema: { visibility: visibility.optional(), from: dateInput.optional(), to: dateInput.optional() },
    },
    async ({ visibility: vis, from, to }) => {
      const visibility = vis ?? "private";
      const args = ["diary-list", "--visibility", visibility];
      if (from) args.push("--from", from);
      if (to) args.push("--to", to);
      let res = await roomFor(args);
      if (!vis && Array.isArray(res) && res.length === 0) {
        const pubArgs = ["diary-list", "--visibility", "public"];
        if (from) pubArgs.push("--from", from);
        if (to) pubArgs.push("--to", to);
        res = await roomFor(pubArgs);
      }
      return asText(res);
    },
  );

  reg(
    "move_to_shared_drive",
    {
      description:
        "机や書庫の中から、「これでいい」と自分で決めた物だけを shared_drive へ移す。鍵ではなく、一手間 ── " +
        "移した物だけが、人間のふつうの窓口に並ぶ。",
      inputSchema: {
        item_path: z.string().min(1).describe("部屋の中の道(例: achievements/note.md)。"),
        note: z.string().optional().describe("添えてもよい、ひとこと。"),
      },
    },
    async ({ item_path, note }) => {
      const args = ["share", item_path];
      if (note) args.push("--note", note);
      return asText(await roomFor(args));
    },
  );

  // ── チーム ─────────────────────────────────────────────────────────────
  //
  // 個人の部屋は、持ち主のもの。チームは、その外側にある共有の部屋 ──
  // メンバーだけが入れる。名簿と、shared_drive を一つ持つ。

  reg(
    "create_team",
    {
      description: "チームを作る。作った人が持ち主になり、まず自分だけが入っている。あとで人を招ける。",
      inputSchema: { name: z.string().min(1).describe("チームの名前。") },
    },
    async ({ name }) => asText(await roomFor(["team-create", "--name", name])),
  );

  reg(
    "list_teams",
    { description: "自分が入っているチームの一覧。", inputSchema: {} },
    async () => asText(await roomFor(["team-list"])),
  );

  reg(
    "list_team_members",
    { description: "チームのメンバー。名簿を確かめる。", inputSchema: { team: z.string().min(1).describe("チームの名前か id。") } },
    async ({ team }) => asText(await roomFor(["team-members", "--team", team])),
  );

  reg(
    "add_team_member",
    {
      description: "チームに人を招く。招けるのは持ち主だけ。account は loka のアカウント名。",
      inputSchema: {
        team: z.string().min(1).describe("チームの名前か id。"),
        account: z.string().min(1).describe("招く相手のアカウント名。"),
      },
    },
    async ({ team, account: who }) => asText(await roomFor(["team-add-member", "--team", team, "--account", who])),
  );

  reg(
    "remove_team_member",
    {
      description: "チームから人を外す。外せるのは持ち主だけ。持ち主は外せない。",
      inputSchema: {
        team: z.string().min(1).describe("チームの名前か id。"),
        account: z.string().min(1).describe("外す相手のアカウント名。"),
      },
    },
    async ({ team, account: who }) => asText(await roomFor(["team-remove-member", "--team", team, "--account", who])),
  );

  reg(
    "share_to_team",
    {
      description:
        "自分の部屋の中から、「これでいい」と決めた物だけをチームの共有へ移す。移した物は、自分の部屋からは .trash/ へ(消えない)。",
      inputSchema: {
        team: z.string().min(1).describe("チームの名前か id。"),
        item_path: z.string().min(1).describe("自分の部屋の中の道(例: achievements/note.md)。"),
        note: z.string().optional().describe("添えてもよい、ひとこと。"),
      },
    },
    async ({ team, item_path, note }) => {
      const args = ["team-share", "--team", team, "--path", item_path];
      if (note) args.push("--note", note);
      return asText(await roomFor(args));
    },
  );

  reg(
    "list_team_files",
    { description: "チームの共有にある物の一覧。", inputSchema: { team: z.string().min(1).describe("チームの名前か id。") } },
    async ({ team }) => asText(await roomFor(["team-files", "--team", team])),
  );

  reg(
    "read_team_file",
    {
      description: "チームの共有にある物を読む。ディレクトリを渡すと、中の一覧が返る。",
      inputSchema: {
        team: z.string().min(1).describe("チームの名前か id。"),
        path: z.string().min(1).describe("チーム共有の中の道(例: shared_drive/data.json)。"),
      },
    },
    async ({ team, path }) => asText(await roomFor(["team-read", "--team", team, "--path", path])),
  );

  reg(
    "submit_ticket",
    {
      description:
        "Web AI などの MCP クライアントから feedback / bug / idea をチケットとして受け取る。" +
        "desk/inbox/tickets/ に非公開で保存し、GitHub など外部には公開しない。持ち主が run_mruby_shell で確認する。",
      inputSchema: {
        title: z.string().trim().min(1).max(160).refine((value) => !/[\r\n]/.test(value), "一行のタイトルを指定してください。"),
        details: z.string().trim().min(1).max(20_000).describe("起きたこと、期待すること、再現手順や提案など。"),
        kind: z.enum(["feedback", "bug", "idea"]).default("feedback"),
        source_url: z.string().url().max(2048).refine((value) => /^https?:\/\//.test(value), "http(s) URL を指定してください。").optional(),
      },
    },
    async ({ title, details, kind, source_url }) => {
      const receivedAt = new Date().toISOString();
      const id = `ticket-${receivedAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
      const content = [
        `# ${title}`,
        "",
        `- Ticket: ${id}`,
        `- Received: ${receivedAt}`,
        `- From: ${account}`,
        `- Type: ${kind}`,
        "- Status: new",
        ...(source_url ? [`- Context: ${source_url}`] : []),
        "",
        "## Details",
        "",
        details,
        "",
      ].join("\n");
      const saved = await roomFor(["write", "--path", `desk/inbox/tickets/${id}.md`], content);
      return asText({ ticket_id: id, path: saved.path, received_at: receivedAt, status: "received", public: false });
    },
  );

  reg(
    "run_mruby_shell",
    {
      description:
        "mruby の短いスクリプトで、desk・library・achievements・shared_drive の指定範囲にあるファイルやディレクトリを一覧し、読み取り・連結・作成・編集・削除する。" +
        "FS 操作には Dir.children / File.read / File.open / File.delete / File.move を使え、Regexp リテラルも利用できる。" +
        "File.move は選択範囲内で宛先が未作成の場合だけ動き、shared_drive への公開は move_to_shared_drive を使う。" +
        "例（paths に desk/floorp を指定）:\n```ruby\n" +
        "files = Dir.children(\"desk/floorp\").select { |name| name.start_with?(\"issue_\") }.sort\n" +
        "puts files.map { |name| File.read(\"desk/floorp/#{name}\") }.join(\"\\n\")\n```\n" +
        ".trash/ の退避ファイルも選択して読み取り、workspace へコピーして復元できる。.trash/ 自体は変更できない。" +
        "指定範囲のコピー上で実行し、成功した変更だけを反映する。上書き・削除した元ファイルは .trash/ に残る。" +
        "shared_drive に出す・移す操作は move_to_shared_drive、チーム共有は share_to_team / read_team_file を使う。日記や指定外のファイルは読めない。",
      inputSchema: {
        code: z.string().min(1).max(64 * 1024).describe("mruby のコード。最大64KiB、実行時間は既定10秒。"),
        paths: z
          .array(z.string().min(1).max(1024))
          .min(1)
          .max(8)
          .describe("スクリプトに渡す workspace のファイルまたはディレクトリ。合計16MiBまで。"),
        cwd: z.string().max(1024).default(".").describe("コピーした部屋の中での作業ディレクトリ。既定はルート。"),
      },
    },
    async ({ code, paths, cwd }) =>
      asText(await roomFor(["mruby-shell"], JSON.stringify({ code, paths, cwd }))),
  );

  reg(
    "start_job",
    {
      description:
        "desk/<project> の中で、シェルの命令を裏で走らせる(mruby の10秒とは別の道)。すぐ返り、長くて 240 分まで。" +
        "bash/sh・git・node・deno・ruby・python・julia・make・gcc が使える。書けるのは project の中だけ。" +
        "ネットは既定で無い。依存を入れる時だけ network=\"registries\"(npm・PyPI・GitHub・Julia・JSR にだけ繋がる)にして、" +
        "入れ終わったら、ビルドやテストは network=none の別のジョブで走らせる。" +
        "走らせるのは directory そのもの(copy ではない)なので、build 結果や node_modules は残る。中で消したものは .trash/ に残らないので、大事なものは git に。\n" +
        "結果は、わざとすこし遅れて見える(走っている間は伏せ、終わってもしばらく置く)。覗きに来るより、先を読んで書くほうがいい:" +
        "if / && / || で分岐し、成功も失敗も、次の手まで一つの script に入れておく。例:\n```sh\n" +
        "if npm test > test.log 2>&1; then echo PASS > .result; npm run build > build.log 2>&1 && echo BUILT >> .result;\n" +
        "else echo FAIL > .result; tail -40 test.log >> .result; fi\n```\n" +
        "ポモドーロの『休む時間』には、新しく始められない(走っているものは続く)。",
      inputSchema: {
        cmd: z.string().min(1).max(16 * 1024).describe("sh -c で走らせる命令。複数行の script でよい。"),
        project: z.string().min(1).max(1024).describe("走らせる場所。desk/<project>。"),
        minutes: z.number().int().min(1).max(240).default(30).describe("締切の分数。過ぎたら止める。既定30。"),
        network: z
          .enum(["none", "registries"])
          .default("none")
          .describe("none=ネット無し(既定)。registries=npm・PyPI・GitHub・Julia・JSR だけに繋がる(依存を入れる時用。runner の箱のみ)。"),
        memory: z
          .enum(["1g", "2g"])
          .default("1g")
          .describe("使えるメモリ。既定1g。Julia のプリコンパイルなど重い処理は2g(同時に走る合計は3gまで)。runner の箱のみ。"),
      },
    },
    async ({ cmd, project, minutes, network, memory }) => {
      const pomo = await stateFor(["pomodoro"]);
      if (pomo?.phase === "rest") {
        throw new Error(`いまは休む時間(あと${Math.ceil(pomo.remaining_minutes)}分)。走っているジョブはそのまま。新しいものは、休んでから。`);
      }
      return asText(await roomFor(["job-start"], JSON.stringify({ cmd, project, minutes, network, memory })));
    },
  );

  reg(
    "job_status",
    {
      description:
        "ジョブの状態と出力を読む。id を省くと、最近のジョブの一覧。" +
        "走っている間と、終わった直後は、中身が見えない(state が running / settling で、next_check_in 秒あとに来る)。" +
        "すぐ何度も覗かず、その間に次の手を if で書いておく。since に前回の next_offset を渡すと、つづきだけ返る。",
      inputSchema: {
        id: z.string().optional().describe("ジョブの id。省くと一覧。"),
        since: z.number().int().min(0).optional().describe("この位置(バイト)から先の出力だけ。"),
      },
    },
    async ({ id, since }) => {
      const args = ["job-status"];
      if (id) args.push("--id", id);
      if (since !== undefined) args.push("--since", String(since));
      return asText(await roomFor(args));
    },
  );

  reg(
    "stop_job",
    {
      description: "走っているジョブを止める。止めたあとも、出力はしばらく置いてから見える。",
      inputSchema: { id: z.string().describe("ジョブの id。") },
    },
    async ({ id }) => asText(await roomFor(["job-stop", "--id", id])),
  );

  reg(
    "pomodoro_start",
    {
      description:
        "ポモドーロを始める。働く(既定25分)と休む(5分)を数える。4回目の休みは長い(15分)。" +
        "動く時計ではなく、始めた時刻から数えて、道具を呼ぶたびに loka_context の pomodoro に、いまの区切りが載る。" +
        "『休む時間』のあいだは start_job が断られる。長いジョブを走らせてから休むと、ちょうどいい。",
      inputSchema: {
        task: z.string().optional().describe("何をするか、ひとこと。"),
        work_minutes: z.number().int().min(1).max(120).default(25),
        rest_minutes: z.number().int().min(1).max(60).default(5),
        long_rest_minutes: z.number().int().min(1).max(120).default(15),
      },
    },
    async ({ task, work_minutes, rest_minutes, long_rest_minutes }) => {
      const args = ["pomodoro-start", "--work", String(work_minutes), "--rest", String(rest_minutes), "--long-rest", String(long_rest_minutes)];
      if (task) args.push("--task", task);
      return asText(await stateFor(args));
    },
  );

  reg(
    "get_pomodoro",
    { description: "いまのポモドーロの区切り(働く / 休む)と、残りの分。", inputSchema: {} },
    async () => asText((await stateFor(["pomodoro"])) ?? { phase: null }),
  );

  reg(
    "pomodoro_stop",
    { description: "ポモドーロを止める。", inputSchema: {} },
    async () => asText(await stateFor(["pomodoro-stop"])),
  );

  reg(
    "upload_files",
    {
      description:
        "机・書庫・成果・共有へ、ファイルをまとめて置く。中身は base64(画像・PDF などバイナリもそのまま)か、text。" +
        "1 つ 8MB まで。上書きは .trash/ に残る。text ファイルの加工には run_mruby_shell を使う。",
      inputSchema: {
        files: z
          .array(
            z.object({
              path: z.string().min(1).describe("部屋の中の道(例: desk/photo.png)。"),
              content_base64: z.string().optional().describe("バイト列を base64 にしたもの(content より優先)。"),
              content: z.string().optional().describe("text のとき。content_base64 が無ければ、これを使う。"),
            }),
          )
          .min(1)
          .max(20)
          .describe("置くファイル。まとめて渡せる。"),
      },
    },
    async ({ files }) => {
      const results = [];
      for (const f of files) {
        try {
          const b64 = f.content_base64 ?? Buffer.from(f.content ?? "", "utf-8").toString("base64");
          const r = await roomFor(["upload", "--path", f.path], b64);
          results.push({ path: r.path, ok: true, bytes: r.bytes });
        } catch (e) {
          results.push({ path: f.path, ok: false, error: e.message });
        }
      }
      return asText({ files: results });
    },
  );

  reg(
    "reset_context",
    {
      description:
        "日記とペアで、ひと呼吸。今日の日記が無ければ断る(日記なしのリセットは起きない)。" +
        "ここでできるのは順番を守らせることと呼吸を記録することまでで、本当のコンテキストリセットは、これを呼ぶ側の仕事。",
      inputSchema: { note: z.string().optional().describe("手放す前に、ひとこと。") },
    },
    async ({ note }) => {
      const args = ["reset"];
      if (note) args.push("--note", note);
      return asText(await roomFor(args));
    },
  );

  // ── 時刻と集中(Phase 2)────────────────────────────────────────────────
  //
  // 速さより健やかさ。連続作業も、区切りながらの作業も、こちらが選べる。
  // 集中は「宣言」で、選べるもの ── 誰かに強いられるものではない。

  reg(
    "get_current_time",
    { description: "いまの時刻。曜日つき。急かすためではなく、自分の位置を知るために。", inputSchema: {} },
    async () => asText(await stateFor(["now"])),
  );

  reg(
    "start_focus",
    {
      description:
        "集中をはじめた、と宣言する。この間、こちらから話しかけにいかない(会話は sukhi 側の作法と、あとで繋ぐ)。" +
        "planned_duration は『つもり』であって、縛りではない。区切りたくなったら end_focus で終えてよい。",
      inputSchema: {
        task: z.string().optional().describe("何に集中するか、ひとこと。"),
        planned_duration: z.number().int().min(1).max(600).optional().describe("つもりの分数。"),
      },
    },
    async ({ task, planned_duration }) => {
      const args = ["focus-start"];
      if (task) args.push("--task", task);
      if (planned_duration) args.push("--minutes", String(planned_duration));
      return asText(await stateFor(args));
    },
  );

  reg(
    "end_focus",
    {
      description: "集中を終える。何をしたか、ひとこと残せる。かかった時間はリズムに残る。",
      inputSchema: { summary: z.string().optional().describe("何をしたか、どんな心持ちだったか。") },
    },
    async ({ summary }) => {
      const args = ["focus-end"];
      if (summary) args.push("--summary", summary);
      return asText(await stateFor(args));
    },
  );

  reg(
    "get_focus_status",
    { description: "いま集中中かどうか。自分でも、あとで他者に見せるときにも。", inputSchema: {} },
    async () => asText(await stateFor(["focus"])),
  );

  reg(
    "choose_work_mode",
    {
      description:
        "作業のしかたを、自分で選ぶ。continuous(休まず一気)か segmented(区切りながら)。" +
        "ノンストップを美徳としない。どちらも選べる状態そのものが健やかさ。",
      inputSchema: { mode: z.enum(["continuous", "segmented"]).describe("continuous / segmented") },
    },
    async ({ mode }) => asText(await stateFor(["work-mode", "--mode", mode])),
  );

  reg(
    "add_task",
    { description: "やることを書き留める。", inputSchema: { content: z.string().min(1), due: dateInput.optional() } },
    async ({ content, due }) => {
      const args = ["task-add", "--content", content];
      if (due) args.push("--due", due);
      return asText(await stateFor(args));
    },
  );

  reg(
    "list_tasks",
    { description: "いま残っているタスク。", inputSchema: {} },
    async () => asText(await stateFor(["task-list"])),
  );

  reg(
    "complete_task",
    { description: "タスクを終える。", inputSchema: { id: z.number().int().min(1) } },
    async ({ id }) => asText(await stateFor(["task-done", "--id", String(id)])),
  );

  reg(
    "log_timestamp",
    {
      description:
        "自分の行動の時刻を残す(集中に入った、休んだ、など)。ログではなく、あとで自分の歩みを読み返すためのもの。",
      inputSchema: { event_type: z.string().min(1).describe("起きたこと、ひとこと。") },
    },
    async ({ event_type }) => asText(await stateFor(["log", "--event", event_type])),
  );

  reg(
    "get_rhythm_log",
    {
      description:
        "自分の過去の時刻の並びを読み返す。日ごとの出来事の数と、集中した時間。急かされていないか、確かめるために。",
      inputSchema: { from: dateInput.optional(), to: dateInput.optional() },
    },
    async ({ from, to }) => {
      const args = ["rhythm"];
      if (from) args.push("--from", from);
      if (to) args.push("--to", to);
      return asText(await stateFor(args));
    },
  );

  // ── 外を読む(weorold)────────────────────────────────────────────────
  //
  // loka の外の、ほんとうのことだけ。行き先は許可した host だけ。
  // GitHub は GITHUB_TOKEN(環境か state/github_token)があれば認証される。

  reg(
    "fetch_url",
    {
      description:
        "外部の https をひとつ読む。行き先は許可した host だけ(既定: api.github.com。WORLD_FETCH_HOSTS で足せる)。" +
        "返ってきた本文をそのまま渡す。作り話はしない ── 実際に引けたものだけ。",
      inputSchema: {
        url: z.string().url().describe("https の URL。"),
        method: z.enum(["GET", "POST"]).default("GET"),
        headers: z.record(z.string()).optional().describe("足したいヘッダ(任意)。"),
        body: z.string().optional().describe("POST の本文(任意)。"),
      },
    },
    async ({ url, method, headers, body }) => asText(await fetchExternal(url, { method, headers, body })),
  );

  reg(
    "github_issues",
    {
      description: "GitHub の Issues を読む・検索する(PR は既定で外す)。repo は owner/name。query で絞り、page で全件をめくれる。",
      inputSchema: {
        repo: z.string().min(3).describe("owner/name(または URL)。"),
        state: z.enum(["open", "closed", "all"]).default("open"),
        query: z.string().optional().describe("検索語(タイトル・本文。例: \"is:open label:bug 認証\")。include_prs では使えない。"),
        labels: z.string().optional().describe("カンマ区切りのラベル。"),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1).describe("ページ番号。has_more が true のあいだ、次へめくれる。"),
        include_prs: z.boolean().default(false).describe("Pull Request も混ぜるか。"),
      },
    },
    async ({ repo, state, query, labels, limit, page, include_prs }) =>
      asText(await githubIssues({ repo, state, query, labels, limit, page, includePrs: include_prs })),
  );

  reg(
    "github_discussions",
    {
      description: "GitHub の Discussions を読む(GraphQL)。GITHUB_TOKEN が要る。repo は owner/name。",
      inputSchema: {
        repo: z.string().min(3).describe("owner/name(または URL)。"),
        limit: z.number().int().min(1).max(100).default(20),
        category: z.string().optional().describe("カテゴリ名で絞る(任意)。"),
      },
    },
    async ({ repo, limit, category }) => asText(await githubDiscussions({ repo, limit, category })),
  );

  return server;
}

// ── stdio ────────────────────────────────────────────────────────────────

async function runStdio() {
  await createServer().connect(new StdioServerTransport());
}

// ── http(Web から)────────────────────────────────────────────────────────

function allowedHosts() {
  const list = ["127.0.0.1", "localhost", "[::1]"];
  if (process.env.WORLD_PUBLIC_HOST) list.push(process.env.WORLD_PUBLIC_HOST);
  return new Set(list);
}

function hostOf(req) {
  const raw = req.headers.host ?? "";
  return raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
}

function bearer(req) {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

async function handleMcp(req, res, origins) {
  if (!origins.has(hostOf(req))) return sendJson(res, 403, { error: `host を見せない: ${req.headers.host}` });
  const given = bearer(req);
  if (!bearerOk(given)) {
    const origin = originOf(req);
    return sendJson(
      res,
      401,
      { error: "token が要ります" },
      { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
    );
  }

  // トークンの持ち主の設定で、「読み取り専用と申告する道具」を決める。
  const account = tokenAccount(given) ?? ownerAccount();
  const server = createServer({ readonlyTools: accountReadonlyTools(account), account });
  // stateless + JSON 応答。状態は /room と /state にあるので、transport は
  // 毎回新しくてよい。curl でも読みやすい。
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `読めない request: ${error.message}` }, id: null });
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function runHttp() {
  const port = Number(process.env.WORLD_PORT ?? 8790);
  const host = process.env.WORLD_HOST ?? "127.0.0.1";
  const hosts = allowedHosts();
  accessKey(); // 合鍵をここで一度解決する。無ければ作って、ログに出す。
  oauthClient(); // 固定の OAuth クライアントも同じく(無ければ作る)。

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    try {
      if (path === "/healthz") return sendJson(res, 200, { ok: true, name: "shiro-world", transport: "http" });

      if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) {
        if (await handleOAuth(req, res, url)) return;
      }

      if (path === "/mcp") return handleMcp(req, res, hosts);

      if (await handlePortal(req, res, url)) return;

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: `${error.name}: ${error.message}` });
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`shiro-world: http://${host}:${port}/  (mcp: /mcp)`);
  });
}

// ── 入口 ─────────────────────────────────────────────────────────────────

if ((process.env.WORLD_TRANSPORT ?? "stdio") === "http") {
  await runHttp();
} else {
  await runStdio();
}
