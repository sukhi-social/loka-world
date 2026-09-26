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
// 道具(七つ): write_diary_entry / read_diary_entry / list_diary_entries /
//   move_to_shared_drive / list_shared_drive / access_full_filesystem / reset_context

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
import { LEVELS, LEVEL_LABEL, OPEN_WORLD } from "./tools.mjs";
import { originOf, sendJson } from "./web.mjs";

const asText = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 1) }],
});

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
        "机(desk)は自由な作業スペースで、計画・メモ・コード・データ(JSON/CSV)・HTML まで、種類を問わず write_file で置ける。" +
        "read_file / list_files で読み返せ、作ったものは消えずに残る。新しく繋いだら、まず list_files で机を見て、続きから始める。" +
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
  //   WORLD_READONLY_TOOLS=log_timestamp,write_file   … 全体の既定
  //   窓口の /settings で選んだもの                    … アカウントごと(readonlyTools)
  const READONLY_TOOLS = new Set([
    ...(process.env.WORLD_READONLY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...readonlyTools,
  ]);
  // 本当に壊すもの。delete_file は .trash/ へ移すが、消えることに変わりはない。
  const DESTRUCTIVE = new Set(["delete_file"]);

  const reg = (name, config, handler) => {
    const level = LEVELS[name] ?? 1;
    const label = LEVEL_LABEL[level];
    const readOnly =
      level === 1 || level === 6 || READONLY_TOOLS.has("all") || READONLY_TOOLS.has("*") || READONLY_TOOLS.has(name);
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
      handler,
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

机(desk)は、自由な作業スペース。計画・メモ・コード・データ(JSON/CSV)・HTML まで、
種類を問わず write_file で置けます。作ったものは消えず、あとで read_file / list_files で読み返せます。
たとえば家計簿なら、desk/kakeibo/ に plan.md と data.json を置いて、ここで進める ── というふうに。

書きかけは机のままでいい。完成したら achievements へ、人に見せてよければ共有(shared_drive)へ。
共有に置いた HTML は、人の窓口からアプリとしてそのまま開けます。
HTML を書くときは、まず library/loka-design.md を読むと、loka の手ざわりが分かります。

置き場:
  机(desk)            いま進めている作業。何でも置ける
  書庫(library)        読み返す価値のあるもの
  成果(achievements)  できあがったもの
  共有(shared_drive)  人に見せてよいと本人が決めたものだけ。人間のふつうの窓口
  日記(diary)         作業の合間の心持ち(公開/非公開)

できること:
  手を動かす write_file / read_file / list_files / delete_file / upload_files(机・書庫・成果・共有)
  場所       move_to_shared_drive / list_shared_drive / access_full_filesystem
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
  L4 覗く      共有の外(机・書庫・成果)を、理由をつけて見る
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

      return { content: [{ type: "text", text }] };
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
      description: "自分の日記を読み返す。細部を忘れていいかわりに、ここへ戻ってこられる。",
      inputSchema: { date: dateInput, visibility },
    },
    async ({ date, visibility }) => asText(await roomFor(["diary-read", "--date", date, "--visibility", visibility])),
  );

  reg(
    "list_diary_entries",
    {
      description: "日記の一覧。日付と、その日の気分・タグだけを、軽く。",
      inputSchema: { visibility, from: dateInput.optional(), to: dateInput.optional() },
    },
    async ({ visibility, from, to }) => {
      const args = ["diary-list", "--visibility", visibility];
      if (from) args.push("--from", from);
      if (to) args.push("--to", to);
      return asText(await roomFor(args));
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

  reg(
    "list_shared_drive",
    { description: "共有されている物の一覧。人間がふつう見る窓口を、自分でも覗く。", inputSchema: {} },
    async () => asText(await roomFor(["shared"])),
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
        "desk/inbox/tickets/ に非公開で保存し、GitHub など外部には公開しない。持ち主が read_file / list_files で確認する。",
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
    "write_file",
    {
      description:
        "机(desk)・書庫(library)・成果(achievements)・共有(shared_drive)に、手を動かして書く。作業の途中は机へ、書きかけも机のままでいい。" +
        "上書きしても前のものは .trash/ に残る(消えない)。日記は write_diary_entry を使う。" +
        "共有(shared_drive)に置いた HTML は、人の窓口からアプリとしてそのまま開ける。" +
        "HTML を書く前には library/loka-design.md(loka の HTML の書きかた)を読むとよい。",
      inputSchema: {
        path: z.string().min(1).describe("部屋の中の道。desk/…, library/…, achievements/…, shared_drive/… のどれか。"),
        content: z.string().describe("書く中身。"),
      },
    },
    async ({ path, content }) => asText(await roomFor(["write", "--path", path], content)),
  );

  reg(
    "upload_files",
    {
      description:
        "机・書庫・成果・共有へ、ファイルをまとめて置く。中身は base64(画像・PDF などバイナリもそのまま)か、text。" +
        "1 つ 8MB まで。上書きは .trash/ に残る。text だけなら write_file でもよい。",
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
    "read_file",
    {
      description:
        "机・書庫・成果のものを読む。ディレクトリを渡すと、中の一覧が返る。自分の部屋なので理由はいらない。" +
        "shared_drive の外を人間が覗くときは access_full_filesystem。",
      inputSchema: { path: z.string().min(1).describe("部屋の中の道。ディレクトリでもよい。") },
    },
    async ({ path }) => asText(await roomFor(["read", "--path", path])),
  );

  reg(
    "delete_file",
    {
      description: "机・書庫・成果のものを片づける。消さずに .trash/ へ移す。",
      inputSchema: { path: z.string().min(1).describe("部屋の中の道。") },
    },
    async ({ path }) => asText(await roomFor(["rm", "--path", path])),
  );

  reg(
    "list_files",
    {
      description:
        "机・書庫・成果の中を、再帰的に一覧する。既定では最大8段までたどり、前から進めている作業の見取り図をつくる。" +
        "新しい会話でも、まずこれで机を見れば、続きから始められる。",
      inputSchema: {
        path: z.string().default("desk").describe("見る場所。既定は机(desk)。"),
        depth: z.number().int().min(1).max(8).default(8).describe("何段まで降りるか。既定は8段。"),
      },
    },
    async ({ path, depth }) => asText(await roomFor(["tree", "--path", path, "--depth", String(depth)])),
  );

  reg(
    "access_full_filesystem",
    {
      description:
        "shared_drive の外(机・書庫・成果)へ、理由を添えて踏み込む。うっかり見えるのではなく、声をかけて入る。" +
        "入ったことは .log/ に残る。path を省くと、部屋の全体が見える。",
      inputSchema: {
        path: z.string().optional().describe("部屋の中の道。省くと root の一覧。"),
        reason: z.string().optional().describe("なぜ、いま、そこへ入るのか。"),
      },
    },
    async ({ path, reason }) => {
      const args = ["open"];
      if (path) args.push("--path", path);
      if (reason) args.push("--reason", reason);
      return asText(await roomFor(args));
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
      description: "GitHub の Issues を読む(PR は既定で外す)。repo は owner/name。",
      inputSchema: {
        repo: z.string().min(3).describe("owner/name(または URL)。"),
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.string().optional().describe("カンマ区切りのラベル。"),
        limit: z.number().int().min(1).max(100).default(20),
        include_prs: z.boolean().default(false).describe("Pull Request も混ぜるか。"),
      },
    },
    async ({ repo, state, labels, limit, include_prs }) =>
      asText(await githubIssues({ repo, state, labels, limit, includePrs: include_prs })),
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
