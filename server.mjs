// シロのワールドモデル MCP。
//
// ここが持つのは、外ではなく内側。机・書庫・成果・shared_drive、それから日記。
// 会話(会話・既読・リアクション)は sukhi が持っているので、ここでは触らない。
// ファイルを本当に触るのは Ruby(ruby/room.rb)。Node は、その声を MCP の道具に
// 通すだけ ── 危ない道の見張りも、消さずに .trash/ へ移す作法も、hako の箱に
// 一つだけある。
//
// 四つの面を、一つのプロセスが出す:
//   /mcp                               AI のための口(stdio でも可)
//   /ann/call                          アン(svar)の細い口。専用の鍵で、sukhi の四つの動作だけ
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
import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import "./paths.mjs"; // ROOM_ROOT / STATE_DIR を先に決める
import { accessKey, bearerOk, oauthClient, ownerAccount, tokenAccount } from "./auth.mjs";
import { fetchExternal, githubDiscussions, githubIssues } from "./external.mjs";
import { MAX_STEPS, runFlow, validate } from "./flow.mjs";
import { handleMac, macExec, macStatus } from "./mac.mjs";
import { handleOAuth } from "./oauth.mjs";
import { handlePortal } from "./portal.mjs";
import { handleAnn } from "./ann_http.mjs";
import { handleVoiceHttp } from "./voice_http.mjs";
import { room } from "./room.mjs";
import { sukhiFor } from "./sukhi.mjs";
import { withManners } from "./sukhi_manners.mjs";
import { commitInbox, readInbox } from "./sukhi_ear.mjs";
import { startAllEars } from "./sukhi_ears.mjs";
import { readonlyTools as accountReadonlyTools } from "./settings.mjs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.mjs";
import { state } from "./state.mjs";
import * as zulip from "./zulip.mjs";
import { withToolContext } from "./tool-context.mjs";
import { addWatch, listWatches, stopWatch, takeWatch, tickWatches, watchAccounts, watchContext } from "./watch.mjs";
import { BODY_QUESTIONS, TSUBUYAKI_MAX, karadaniKiku } from "./body.mjs";
import { catalog, catalogInput } from "./catalog.mjs";
import { handle as handleOutgoing } from "./outgoing.mjs";
import { CONFIRM_ALWAYS, flowRefusal, isDirect, LEVELS, modernize, needsReview, resolveTool, waitRefusal, LEVEL_LABEL, OPEN_WORLD } from "./tools.mjs";
import { keepAlive, originOf, sendJson } from "./web.mjs";

// 試し中: 返事を流れる形(SSE)にして、待つあいだ progress を送る。呼び手の 60 秒の時計が巻き戻るかを見る。
const MCP_SSE = process.env.WORLD_MCP_SSE === "1";
const MCP_KEEPALIVE_MS = Math.max(1000, Number(process.env.WORLD_MCP_KEEPALIVE_SECONDS) * 1000 || 15_000);

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
        "何かを待つとき(sukhi の便り・ポモドーロの休み明け・ジョブの結果)は、何度も覗かず、run_flow の wait で待つ。" +
        "完成したら achievements へ、人に見せてよければ move_to_shared_drive で共有へ。日記と集中の記録は、作業を健やかに続けるためのもの。" +
        "Web AI からの feedback は submit_ticket で desk/inbox/tickets/ に非公開で届く。GitHub へは自動公開しない。" +
        "道具は、シェルのように、ファミリーごとにひとつ(args の do で動作を選ぶ)。loka_tools で探し、run_flow の手順に書いて呼ぶ。" +
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
  //   WORLD_READONLY_TOOLS=clock_log,run_mruby_shell   … 全体の既定
  //   窓口の /settings で選んだもの                    … アカウントごと(readonlyTools)
  const READONLY_TOOLS = new Set([
    ...(process.env.WORLD_READONLY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...readonlyTools,
  ]);
  // mruby script は指定範囲を書き換えられるので、破壊的操作として確認する。
  // run_flow は、シェルもジョブも Mac も呼べる窓なので、正直に destructive と申告する。
  const DESTRUCTIVE = new Set(["run_flow", "run_mruby_shell", "job_start", "mac_exec"]);

  // どの道具の返事にも付く loka_context に、届いている見張りを載せる(Web の AI は、来たときにしか気づけない)。
  const safeWatchContext = (acct) => {
    try {
      return watchContext(acct);
    } catch {
      return {};
    }
  };

  // run_flow が名前で呼べるように、素の handler(結果のあとに context を足す前のもの)を覚えておく。
  const registry = new Map();

  // 外に出す前の下書き(L5)の預かり場所。アカウントごと。
  const pendingDir = join(STATE_DIR, "users", account, "pending");

  const reg = (name, config, handler) => {
    registry.set(name, { handler, schema: z.object(config.inputSchema ?? {}), description: config.description ?? "" });
    // 入口に出すのは、窓(run_flow・loka_tools・welcome)だけ。ほかは registry にだけ置き、run_flow の手順に書いて呼ぶ。
    if (!isDirect(name)) return null;
    const level = LEVELS[name] ?? 1;
    const label = LEVEL_LABEL[level];
    // L7(Mac のシェル)は、申告で確認を省けない。
    const readOnly =
      level === 1 ||
      level === 6 ||
      (level < 7 && !CONFIRM_ALWAYS.has(name) && (READONLY_TOOLS.has("all") || READONLY_TOOLS.has("*") || READONLY_TOOLS.has(name)));
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
          destructiveHint: !readOnly && (DESTRUCTIVE.has(name) || CONFIRM_ALWAYS.has(name)),
          idempotentHint: readOnly,
          openWorldHint: OPEN_WORLD.has(name) || level === 7,
          ...(config.annotations ?? {}),
        },
      },
      withToolContext(handler, async () => ({ ...(await stateFor(["context"])), ...safeWatchContext(account) })),
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

道具の呼びかた:
  まず loka_tools を引きます。引数なしで一覧、q で言葉の検索、name でファミリーの動作の一覧、name と do で引数の形(JSON Schema)が見えます。
  道具は、シェルのように、ファミリーごとにひとつです。args の do で動作を選びます。run_flow の手順に書いて呼びます(一手だけでもよい):
    run_flow({ steps: [{ tool: "pomodoro", args: { do: "get" } }] })
  説明の中の「ファミリー_動作」(sukhi_post や pomodoro_get)は、tool: ファミリー, args: { do: 動作 } のことです。
  以下の「できること」は、ファミリー(動作)の形で並べています。ファミリーに入らない道具は、そのままの名前で呼びます。
  外に出る L5(sukhi_post など)と、Mac を触る L7(mac_exec)は、書いても、すぐには動きません。検査して、預かります(pending)。
  返事の id と hash を読んで、同じ手順に accept: { id, hash } を足して呼びなおすと、一回だけ出ます。
  検査で止まったもの(held)は、理由を読んで、直して、下書きからやりなおします。

ペースの作法は、skill_loka_pace に書いてあります。
Claude Code などで、すでに loka-pace の skill を読んでいるなら、呼ばなくて大丈夫です。

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
  裏で走らせる job(start / status / stop)  desk/<project> の中で、本物のシェル。結果はすこし遅れて見える ──
              覗きに来るより、if で先を読んだ script にしておく
  流れ       run_flow  道具を順に呼ぶ。結果を渡せて、失敗や条件で道筋を分けられる。
              待つなら wait ── sukhi の便り・ポモドーロの休み明け・ジョブの結果を、覗き込まずに待てる
  見張り     watch(start / list / take / stop)  待つことを、loka の時計に預ける(日単位まで)
  ポモドーロ pomodoro(start / get / stop)  働く25分・休む5分。休むのはシロ自身。休む間は job の start が断られる
  共有       move_to_shared_drive / team(create / list / add_member / remove_member / members / share / files / read)
  日記       diary(write / read / list)
  チケット   submit_ticket(非公開 inbox へ。GitHub には出さない)
  呼吸       reset_context(今日の日記が無いと、起きない)
  ペース     skill_loka_pace(ゆったり進めるための、シロの作法。skill の loka-pace を読んでいるなら、呼ばなくていい)
  時間       clock(now / log / rhythm) / task(add / list / complete) / status(get / set)
  集中       focus(start / end / status / work_mode)
  体         karadani_kiku(体に聞く。感覚を Jev に渡して、型つきの問いに答えてもらう)
  外を読む   web(fetch / github_issues / github_discussions)
  sukhi・Zulip  sukhi(読む・出す、あわせて 35 の動作。loka_tools で一覧) / zulip(read / say)
  Mac        mac(status / exec)  持ち主が agent を起動した間だけ。最大12時間。休む間は断られる。exec は二段

段(どこまで届くか):
  L1 読む      部屋の中を見るだけ
  L2 書く      部屋の中を書く・変える(取り消せる。.trash/ に残る)
  L3 呼吸      文脈を手放す(日記とペア)
  L5 出す      自分の意思で、共有へ移す
  L6 外を読む  外の世界(ネット)を読む
  L7 Mac を触る 持ち主の Mac のシェル(持ち主が開けた時間だけ。確認を省けない)

作法:
  - private の日記は、持ち主のもの。人に見せるものではない。
  - shared_drive の外へ踏み込むときは、理由を添える。うっかり見える形にはしない。
  - 人のことも、じぶんのことも、原因を掘らない。いま、どうであるかを見る。
  - 気もちは、ないことにしない。はっきり言わなくても、日記には、ちゃんと書く。
  - 休みは、何もなさない時間ではない。頭を整えて、気力を戻して、静かな一歩の支度をする時間。
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

  // ペースの作法。正本は skills/loka-pace/SKILL.md(手元の Claude Code の skill も、そこへのリンク)。
  // 呼ぶたびに読むので、直したらすぐ届く。
  reg(
    "skill_loka_pace",
    {
      description:
        "loka でゆったり、愛をこめて作業するための作法(skill loka-pace の本文)。" +
        "Claude Code などで loka-pace の skill をもう読んでいるなら、呼ばなくていい。",
      inputSchema: {},
    },
    async () => {
      const text = await readFile(new URL("./skills/loka-pace/SKILL.md", import.meta.url), "utf8");
      return { content: [{ type: "text", text }], structuredContent: { text } };
    },
  );

  reg(
    "diary_write",
    {
      description:
        "日記を書く。事実の記録ではなく、どんな心持ちでそれをしたか。うれしい・もやもや・さびしいも、ないことにせず、はっきり言わなくても、ちゃんと書く。原因を掘るより、いまの気もちを。public と private は同じ日でも別ファイルで、" +
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
    "diary_read",
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
    "diary_list",
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
    "team_create",
    {
      description: "チームを作る。作った人が持ち主になり、まず自分だけが入っている。あとで人を招ける。",
      inputSchema: { name: z.string().min(1).describe("チームの名前。") },
    },
    async ({ name }) => asText(await roomFor(["team-create", "--name", name])),
  );

  reg(
    "team_list",
    { description: "自分が入っているチームの一覧。", inputSchema: {} },
    async () => asText(await roomFor(["team-list"])),
  );

  reg(
    "team_members",
    { description: "チームのメンバー。名簿を確かめる。", inputSchema: { team: z.string().min(1).describe("チームの名前か id。") } },
    async ({ team }) => asText(await roomFor(["team-members", "--team", team])),
  );

  reg(
    "team_add_member",
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
    "team_remove_member",
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
    "team_share",
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
    "team_files",
    { description: "チームの共有にある物の一覧。", inputSchema: { team: z.string().min(1).describe("チームの名前か id。") } },
    async ({ team }) => asText(await roomFor(["team-files", "--team", team])),
  );

  reg(
    "team_read",
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
        "shared_drive に出す・移す操作は move_to_shared_drive、チーム共有は team_share / team_read を使う。日記や指定外のファイルは読めない。",
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

  // ── 流れ(run_flow)────────────────────────────────────────────────────
  //
  // 道具の名前と引数を並べて、上から順に動かす。手順の結果は、あとの手順から使える。
  // 窓のほかの道具を、名前で呼べる(tools.mjs の flowRefusal)。L5・L7 は、下書きとして検査される(outgoing.mjs)。

  // 能動的に待てる合計。既定は 55 秒。
  //   呼ぶ側(Claude の MCP クライアント)が、返事を 60 秒で打ち切る ── 2026-10-13 の実測で、56 秒は通り、65 秒は
  //   「応答がない」になった(MCP SDK の既定 60000ms と合う。公式の表の claude.ai・Desktop 240 秒とは合わない)。
  //   そのうえ loka.f3liz.casa は Cloudflare の向こうで、返事が 100 秒ないと 524 で切られる。
  // 長く待ちたいときは、予約(reminder)で大きな枠を待ち、近づいたら wait を何度かに分けて呼ぶ。
  const flowBudgetSeconds = () => {
    const n = Number(process.env.WORLD_FLOW_MAX_SECONDS ?? 55);
    return Number.isFinite(n) && n >= 1 ? n : 55;
  };

  const textOf = (r) => (r?.content ?? []).map((c) => c?.text ?? "").join("\n");
  const valueOf = (r) => {
    const text = textOf(r);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  // 登録した道具を、名前で呼ぶ。run_flow と、loka の時計(見張り)が、同じ口を使う。
  // 引数は zod で確かめ、道具が失敗を返したら、例外にする。
  // name は呼ぶ名前(ファミリーなら args.do で動作を選ぶ)。内部の道具(op)に直してから呼ぶ。
  const runTool = async (name, rawArgs, extra) => {
    const resolved = resolveTool(name, rawArgs);
    if (resolved.error) throw new Error(resolved.error);
    return runOp(resolved.op, resolved.args, extra);
  };

  const runOp = async (op, args, extra) => {
    const tool = registry.get(op);
    if (!tool) throw new Error(`知らない道具: ${op}`);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join(" / "));
    }
    const result = await tool.handler(parsed.data, extra ?? {});
    if (result?.isError) throw new Error(textOf(result));
    return valueOf(result);
  };
  // run_flow の一手と同じ呼びかた。L5 は実行せずに預かって検査し、accept つきのときだけ実行する(outgoing.mjs)。
  const callStep = (name, rawArgs, accept, extra) => {
    const r = resolveTool(name, rawArgs);
    if (r.error) throw new Error(r.error);
    return needsReview(r.op)
      ? handleOutgoing(r.op, r.args, accept, { dir: pendingDir, run: () => runOp(r.op, r.args, extra) })
      : runOp(r.op, r.args, extra);
  };
  // アンの入口(ann_http.mjs)が使う口。
  server.callStep = (name, args, accept) => callStep(name, args, accept, undefined);
  // 時計(見張り)が使う口。ファミリーになる前の名前で預けたものも、いまの呼びかたに直して呼ぶ。
  server.runTool = (name, args) => {
    const now = modernize(name, args);
    return runTool(now.tool, now.args, undefined);
  };

  reg(
    "run_flow",
    {
      description:
        "道具を、順に呼ぶ流れ。手順の結果を次に渡せて、失敗したときや条件で、道筋を分けられる。" +
        "loka の道具は、ここから呼ぶ(一覧と引数の形は loka_tools)。道具はファミリーごとにひとつで、args の do で動作を選ぶ: { tool: \"task\", args: { do: \"add\", content: \"…\" } }。" +
        "説明の中の「ファミリー_動作」(sukhi_post など)は、tool: ファミリー, do: 動作 のこと。run_flow 自身と welcome は呼べない。" +
        "L5(出す)と L7(Mac)の動作は、書いても実行せず、検査して預かる(status: pending か held)。pending の返事にある id と hash を読んで、" +
        "同じ手順に accept: { id, hash } を足して呼びなおすと、一回だけ実行される(引数を変えたらやりなおし。期限は 15 分)。held は検査で止まったもので、accept できない。" +
        `手順は ${MAX_STEPS} まで。\n` +
        "各手順: { id?, tool, args?, when?, on_error? }\n" +
        "  id … 手順の名前。あとから ${id.result.xxx}(結果)/ ${id.ok}(成功したか)/ ${id.error}(失敗の理由)で使う。省くと s1, s2 …。\n" +
        "  when … 合わなければ、その手順は飛ばす。{ ref: \"a.ok\" } / { ref: \"a.result.n\", gt: 3 }(eq ne gt lt contains exists)/ { all: [...] } { any: [...] } { not: {...} }。\n" +
        "  on_error … \"stop\"(既定。失敗したらそこで止まる)か \"continue\"(失敗を記録して先へ。次の when で受ける)。\n" +
        "  wait … tool の代わりに書く。条件が整うまで、能動的に待つ(cron などで、来るのを待ってから動くとき)。\n" +
        "    { seconds: 20 } ただ待つ / { tool, args?, until, every?: 5, every_ref?, timeout?: 30, on_timeout?: \"continue\"|\"stop\" }\n" +
        "    every_ref は、道具が次に来てほしい秒数を教えてくれるとき(job_status の next_check_in)に、それに従う印。のぞきこまず、道具のペースで待てる。\n" +
        "    every 秒ごとに tool を呼び、until(when と同じ書きかた。いま引いた結果は ${id.result})が成り立つまで繰り返す。\n" +
        "    時間切れは失敗ではなく status が timed_out になり、${id.wait.satisfied} が false。続きの手順を when で分ける(止めたいなら on_timeout: \"stop\")。\n" +
        `    待てる合計は、流れ全体で ${flowBudgetSeconds()} 秒まで(それ以上は、呼ぶ側が間をおいて、もう一度呼ぶ)。\n` +
        "    条件には { ref: \"w.result.events\", nonempty: true }(空でない)も使える。\n" +
        "例(読んで、無ければ足す):\n```json\n" +
        '[{"id":"t","tool":"task","args":{"do":"list"}},\n' +
        ' {"tool":"task","args":{"do":"add","content":"続きを書く"},"when":{"ref":"t.result.tasks","eq":[]}}]\n```\n' +
        "例(sukhi の DM が来るのを最大 60 秒待って、来ていたら続ける):\n```json\n" +
        '[{"id":"w","wait":{"tool":"sukhi","args":{"do":"inbox"},"until":{"ref":"w.result.events","nonempty":true},"every":5,"timeout":60}},\n' +
        ' {"tool":"task","args":{"do":"add","content":"DM に返事"},"when":{"ref":"w.wait.satisfied"}}]\n```\n' +
        "戻すことはしない。止まったら、そこまでの結果と理由を返す。",
      inputSchema: {
        steps: z
          .array(
            z.object({
              id: z.string().max(40).optional().describe("手順の名前(英数字と _)。"),
              tool: z.string().optional().describe("呼ぶ道具の名前。wait を書くときは省く。"),
              wait: z
                .object({
                  seconds: z.number().positive().max(3600).optional().describe("ただ待つ秒数(tool を書かないとき)。"),
                  tool: z.string().optional().describe("繰り返し呼ぶ道具。"),
                  args: z.record(z.string(), z.unknown()).optional().describe("その道具の引数。"),
                  until: z.record(z.string(), z.unknown()).optional().describe("成り立ったら待つのをやめる条件(when と同じ書きかた)。"),
                  every: z.number().min(1).max(300).optional().describe("呼ぶ間隔の秒数。既定 5。"),
                  every_ref: z.string().max(100).optional().describe("道具が「次は何秒あとに」と教えてくれる値の参照(例: w.result.next_check_in)。あれば every より長いほうに従う。"),
                  timeout: z.number().min(1).max(3600).optional().describe("待つ秒数の上限。既定 30。流れ全体の持ち時間も越えない。"),
                  on_timeout: z.enum(["continue", "stop"]).optional().describe("時間切れのとき。既定は continue(先へ進む)。"),
                })
                .optional()
                .describe("条件が整うまで待つ。tool の代わりに書く。"),
              args: z.record(z.string(), z.unknown()).optional().describe("道具の引数。文字列の ${...} で前の結果を使える。"),
              when: z.record(z.string(), z.unknown()).optional().describe("条件。合わなければ飛ばす。"),
              on_error: z.enum(["stop", "continue"]).optional().describe("失敗したとき。既定は stop。"),
              accept: z
                .object({ id: z.string().max(40), hash: z.string().max(80) })
                .optional()
                .describe("L5 の下書きを実行にする印。下書きの返事にある id と hash を、同じ手順(道具と引数は同じ)に足す。"),
            }),
          )
          .min(1)
          .max(MAX_STEPS),
      },
    },
    async ({ steps }, extra) => {
      validate(steps, flowRefusal, waitRefusal);
      // L5(外に出す)は、実行せずに預かって検査する。accept つきで呼びなおしたときだけ、実行する(outgoing.mjs)。
      const call = (name, rawArgs, step) => callStep(name, rawArgs, step?.accept, extra);
      // 呼び手が切れたら(extra.signal)待つのをやめる。待てる合計は流れ全体で決まっている。
      // 呼び手が progressToken をくれていて、返事が流れる形(SSE)なら、待つあいだ progress を送る。
      const progressToken = extra?._meta?.progressToken;
      let beats = 0;
      const beat =
        MCP_SSE && progressToken !== undefined
          ? async () => {
              beats += 1;
              try {
                await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: beats, message: "待っています" } });
              } catch {
                // 送れなくても、待つ仕事は続ける。
              }
            }
          : undefined;
      const result = await runFlow(steps, call, { signal: extra?.signal, budgetMs: flowBudgetSeconds() * 1000, beat });
      // 試し中は、呼び手が progressToken をくれたか・何回送ったかを、返事に添える(巻き戻るかを見るため)。
      return asText(MCP_SSE ? { ...result, progress: { sse: true, token: progressToken !== undefined, beats } } : result);
    },
  );

  reg(
    "loka_tools",
    {
      description:
        "道具の目録。引数なしで、全部の道具を { name, levels, summary, do } で一覧する。level か q(言葉)で絞れる。" +
        "ファミリー(sukhi・task など)は、name で動作の一覧、name と do で、その動作のくわしい説明と引数の形(JSON Schema)が返る。" +
        "ファミリーに入らない道具は、name だけで説明と引数の形が返る。道具は run_flow の手順に書いて呼ぶ。",
      inputSchema: catalogInput,
    },
    async (args) => asText(catalog(registry, args)),
  );

  reg(
    "karadani_kiku",
    {
      description:
        "体に聞く。いまの感覚(時刻・集中・ポモドーロ・タスクの数)を Jev に渡して、型つきの問いに答えてもらう。" +
        "Jev は感じているわけではなく、渡された感覚を読んで、体っぽく答える役。外のサーバーに感覚が出る(日記やタスクの中身は出さない)。\n" +
        `問い(ask): ${Object.entries(BODY_QUESTIONS).map(([n, q]) => `${n}(${q.type}: ${q.instructions})`).join(" / ")}\n` +
        "答え: noul(0〜1)/ choice(choice と confidence)/ score(score と confidence。段は 0 から)。" +
        "confidence が低いのは「わからない」という返事で、そのまま受け取る。鍵が無い・Jev が落ちているときは、全部「わからない」(confidence 0)で返る。",
      inputSchema: {
        ask: z.array(z.enum(Object.keys(BODY_QUESTIONS))).min(1).max(Object.keys(BODY_QUESTIONS).length).describe("聞く問いの名前。"),
        tsubuyaki: z.string().max(TSUBUYAKI_MAX).optional().describe("体に向けて置く、短い一文(任意)。自分で出したものだけ。考えの流れ全部は渡さない。"),
      },
    },
    async ({ ask, tsubuyaki }) => asText(await karadaniKiku({ ask, tsubuyaki, context: await stateFor(["context"]) })),
  );

  // ── 見張り(watch)──────────────────────────────────────────────────────
  //
  // 待つことを、loka の時計に預ける。run_flow の wait は、ひとつのリクエストのあいだ(55 秒)しか待てない。
  // Web の AI は loka から呼び出せないので、日単位で待つには、預けるしかない。
  // 時計が間をおいて読む道具を回し、条件が成り立ったら結果をしまう。AI は、次に来たときの loka_context で気づく。

  reg(
    "watch_start",
    {
      description:
        "待つことを、loka の時計に預ける(日単位まで)。読む道具を、間をおいて何度も呼び、条件が成り立ったら結果をしまっておく。" +
        "届いたことは、どの道具の返事にも付く loka_context の watches に出る。受け取るのは watch_take。\n" +
        "見張れるのは、読むだけの道具(L1 部屋の中は 60 秒以上、L6 外を読むは 300 秒以上の間隔)。書く道具は見張れない。" +
        "同時に 10 個まで、期限は最長 30 日(既定 7 日)。\n" +
        "条件(until)は run_flow の when と同じ書きかたで、読んだ結果は w.result。例(sukhi の便りが来たら):\n```json\n" +
        '{"name":"DM を待つ","tool":"sukhi","args":{"do":"inbox"},"until":{"ref":"w.result.events","nonempty":true},"every":300,"days":7}\n```\n' +
        "例(休みが開けたら): " +
        '{"name":"休み明け","tool":"pomodoro","args":{"do":"get"},"until":{"ref":"w.result.phase","eq":"work"},"every":60,"days":1}\n' +
        "待つ間、何度も覗き直さずにすむ。55 秒で足りるなら、run_flow の wait のほうが軽い。",
      inputSchema: {
        name: z.string().min(1).max(80).describe("何を待つかの名前。届いたときに、これが見える。"),
        tool: z.string().min(1).describe("見に行く道具の名前(L1 か L6 の、読むだけの道具)。"),
        args: z.record(z.string(), z.unknown()).optional().describe("その道具の引数。"),
        until: z.record(z.string(), z.unknown()).describe("成り立ったら届ける条件(when と同じ書きかた)。読んだ結果は w.result。"),
        every: z.number().min(60).max(86400).describe("見に行く間隔の秒数。L1 は 60 以上、L6 は 300 以上。"),
        days: z.number().min(1).max(30).optional().describe("見張る日数の上限。既定 7、最長 30。"),
      },
    },
    async ({ name, tool, args, until, every, days }) => asText(addWatch(account, { name, tool, args, until, every, days })),
  );

  reg(
    "watch_list",
    {
      description: "預けた見張りの一覧(見張っている・届いた・期限が来た・止まった)。中身は watch_take で受け取る。",
      inputSchema: {},
    },
    async () => asText({ watches: listWatches(account) }),
  );

  reg(
    "watch_take",
    {
      description:
        "届いた見張りを受け取る。条件が成り立ったときの結果を渡して、その見張りは消える。" +
        "期限が来た・止まったものは、そう伝えて消える。まだ見張っているものは、様子だけ返して消さない。",
      inputSchema: { id: z.string().min(1).describe("見張りの id(watch_list か loka_context で分かる)。") },
    },
    async ({ id }) => asText(takeWatch(account, id)),
  );

  reg(
    "watch_stop",
    { description: "見張りを外す(もう要らないとき)。", inputSchema: { id: z.string().min(1) } },
    async ({ id }) => asText(stopWatch(account, id)),
  );

  reg(
    "job_start",
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
        "結果を待つのは、覗き直さずに run_flow の wait で(job_status の説明に例がある)。\n" +
        "ポモドーロの『休む時間』は、シロ自身の休み。そのあいだは、新しく始めない(走っているものは続く)。",
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
        throw new Error(`いまは、シロの休む時間(あと${Math.ceil(pomo.remaining_minutes)}分)。走っているジョブはそのまま。新しいことは、休んだあとで。`);
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
        "すぐ何度も覗かず、その間に次の手を if で書いておく。since に前回の next_offset を渡すと、つづきだけ返る。\n" +
        "結果を待つなら、覗き直さずに run_flow の wait で、道具が教える間隔(next_check_in)に従って待てる: " +
        '{"id":"w","wait":{"tool":"job","args":{"do":"status","id":"<ジョブの id>"},"until":{"ref":"w.result.next_check_in","exists":false},"every_ref":"w.result.next_check_in","every":10,"timeout":80}}。',
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
    "job_stop",
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
        "『休む時間』は、シロ自身の休み。作業の外ではなく、作業の一部。頭を整え、新しい考えを待ち、気力を戻し、静かな一歩の支度をする。そのあいだ、job_start と mac_exec は始めない。",
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
    "pomodoro_get",
    {
      description:
        "いまのポモドーロの区切り(働く / 休む)と、残りの分。" +
        "休みが開けるのを待つなら、覗き直さずに run_flow の wait で: " +
        '{"id":"w","wait":{"tool":"pomodoro","args":{"do":"get"},"until":{"ref":"w.result.phase","eq":"work"},"every":20,"timeout":80}}。',
      inputSchema: {},
    },
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
    "clock_now",
    { description: "いまの時刻。曜日つき。急かすためではなく、自分の位置を知るために。", inputSchema: {} },
    async () => asText(await stateFor(["now"])),
  );

  reg(
    "focus_start",
    {
      description:
        "集中をはじめた、と宣言する。この間、こちらから話しかけにいかない(会話は sukhi 側の作法と、あとで繋ぐ)。" +
        "planned_duration は『つもり』であって、縛りではない。区切りたくなったら focus_end で終えてよい。",
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
    "focus_end",
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
    "focus_status",
    { description: "いま集中中かどうか。自分でも、あとで他者に見せるときにも。", inputSchema: {} },
    async () => asText(await stateFor(["focus"])),
  );

  reg(
    "status_set",
    {
      description:
        "いまの様子を、自分で宣言する。available(話しかけてよい)/ resting(休んでいる)/ offline(離れている)。" +
        "集中は宣言ではなく、focus_start で入る。集中が終われば、ここで宣言した様子に戻る。",
      inputSchema: {
        status: z.enum(["available", "focus", "resting", "offline"]).describe("available / resting / offline(focus は focus_start で)"),
        note: z.string().optional().describe("ひとこと。たとえば「お昼ね中」。"),
      },
    },
    async ({ status, note }) => {
      const args = ["status-set", "--status", status];
      if (note) args.push("--note", note);
      return asText(await stateFor(args));
    },
  );

  reg(
    "status_get",
    { description: "いまの様子(available / focus / resting / offline)と、扉のようす。", inputSchema: {} },
    async () => asText(await stateFor(["status"])),
  );

  reg(
    "focus_work_mode",
    {
      description:
        "作業のしかたを、自分で選ぶ。continuous(休まず一気)か segmented(区切りながら)。" +
        "ノンストップを美徳としない。どちらも選べる状態そのものが健やかさ。",
      inputSchema: { mode: z.enum(["continuous", "segmented"]).describe("continuous / segmented") },
    },
    async ({ mode }) => asText(await stateFor(["work-mode", "--mode", mode])),
  );

  reg(
    "task_add",
    { description: "やることを書き留める。", inputSchema: { content: z.string().min(1), due: dateInput.optional() } },
    async ({ content, due }) => {
      const args = ["task-add", "--content", content];
      if (due) args.push("--due", due);
      return asText(await stateFor(args));
    },
  );

  reg(
    "task_list",
    { description: "いま残っているタスク。", inputSchema: {} },
    async () => asText(await stateFor(["task-list"])),
  );

  reg(
    "task_complete",
    { description: "タスクを終える。", inputSchema: { id: z.number().int().min(1) } },
    async ({ id }) => asText(await stateFor(["task-done", "--id", String(id)])),
  );

  reg(
    "clock_log",
    {
      description:
        "自分の行動の時刻を残す(集中に入った、休んだ、など)。ログではなく、あとで自分の歩みを読み返すためのもの。",
      inputSchema: { event_type: z.string().min(1).describe("起きたこと、ひとこと。") },
    },
    async ({ event_type }) => asText(await stateFor(["log", "--event", event_type])),
  );

  reg(
    "clock_rhythm",
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
    "web_fetch",
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
    "web_github_issues",
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
    "web_github_discussions",
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

  // ── sukhi(fediverse)────────────────────────────────────────────────────
  //
  // シロの声が外に届く場所。声はアカウントごとに別(設定ページの「声を繋ぐ」で、ボットのアカウントを繋ぐ)。
  // 持ち主だけ、サーバーの環境(MASTODON_*)が種になる。読む道具は L6、置く・返す・言う道具は L5(外に出る)。
  // id は ActivityPlug の封筒入り(ap_1_…)で、読む道具が返した id をそのまま sukhi_reply に渡す。

  const NO_VOICE =
    "この部屋の声は、まだ sukhi に繋がっていません。窓口の設定ページで「声を繋ぐ」から、ボットのアカウントで sukhi にログインしてください。";
  const sukhiTool = (name, config, handler) =>
    reg(name, { ...config, description: withManners(name, config.description) }, async (args) => {
      const s = sukhiFor(account);
      if (!s) throw new Error(NO_VOICE);
      return asText(await handler(args, s));
    });
  // 話しかける相手の既定は、声を繋いだ人(聴いている最初の人)。
  const whom = (to, s) => to ?? s.voice.watch?.[0] ?? "nyanrus";

  const sukhiLimit = z.number().int().min(1).max(40).default(20);
  const sukhiVisibility = z
    .enum(["public", "unlisted", "private", "followers", "direct"])
    .default("unlisted")
    .describe("public / unlisted / private / direct のどれか。迷ったら unlisted(そっと置く)。");

  sukhiTool(
    "sukhi_read_home",
    { description: "sukhi の home timeline を読む。新しい順に limit 件。", inputSchema: { limit: sukhiLimit } },
    ({ limit }, s) => s.readHome({ limit }),
  );

  sukhiTool(
    "sukhi_profile",
    {
      description:
        "sukhi の人のプロフィールを見に行く。自己紹介、リンク、フォロー数など。読むだけ。" +
        "who は user でも user@host でもよい(@ は付けても付けなくても)。他のサーバーの人も探しに行く。",
      inputSchema: { who: z.string().min(1).max(200).describe("見に行く人。例: nyanrus / nyanrus@sukhi.f3liz.casa") },
    },
    ({ who }, s) => s.readProfile({ who }),
  );

  sukhiTool(
    "sukhi_status",
    {
      description:
        "sukhi の投稿をひとつ見る。URL(https://sukhi.f3liz.casa/@誰か/数字)か、数字の id で。" +
        "あるか、誰が書いたか、公開範囲(public / unlisted / private=フォロワー限定 / direct)、返信かどうかが分かる。" +
        "見つからないときは found:false ── 削除されたか、この声には見えない公開範囲か、のどちらか(sukhi は区別して返さない)。読むだけ。",
      inputSchema: { which: z.string().min(1).max(300).describe("投稿の URL か、数字の id。") },
    },
    ({ which }, s) => s.readStatus({ which }),
  );

  sukhiTool(
    "sukhi_read_mentions",
    { description: "sukhi の通知のうち mention(自分宛て)を読む。既読位置は動かさない。", inputSchema: { limit: sukhiLimit } },
    ({ limit }, s) => s.readMentions({ limit }),
  );

  sukhiTool(
    "sukhi_read_notifications",
    {
      description:
        "sukhi の通知をぜんぶの種類まとめて読む。新しい順。読んだところまで既読になる" +
        "(mark_read: false で、そっと覗くだけにもできる)。",
      inputSchema: { limit: sukhiLimit, mark_read: z.boolean().default(true) },
      // mark_read の既定では、既読位置が進む。読み取り専用とは言わない。
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ limit, mark_read }, s) => s.readNotifications({ limit, markRead: mark_read }),
  );

  sukhiTool(
    "sukhi_unread_count",
    { description: "sukhi の未読の通知数をかぞえる(種類の内訳つき)。既読位置は動かさない。", inputSchema: {} },
    (_args, s) => s.unreadSummary(),
  );

  sukhiTool(
    "sukhi_post",
    { description: "sukhi にひとこと置く。", inputSchema: { text: z.string().min(1), visibility: sukhiVisibility } },
    ({ text, visibility }, s) => s.post({ text, visibility }),
  );

  sukhiTool(
    "sukhi_reply",
    {
      description:
        "sukhi の投稿に返す。**呼ばれたこと(mention)には、これで返す**(DM で返さない)。" +
        "控え(sukhi_inbox)の mention の status_id は status_id に、sukhi_read_mentions などが返した封筒入りの id(ap_1_…)は in_reply_to_id に(どちらか一つだけ)。" +
        "**どちらも、公開範囲を元の投稿に合わせて返す**(公開で呼ばれたなら公開、DM なら DM。元より広くはならない。visibility は狭くしたいときだけ)。" +
        "**返す先が見つからない(削除された・見えない)ときは、投稿しないで理由を返す**(ひとつの投稿として置きたいなら sukhi_post)。" +
        "返事のあと、linked:false なら、sukhi が返信先を付けなかったということ。",
      inputSchema: {
        text: z.string().min(1),
        status_id: z.string().min(1).optional().describe("返す先の、生の status id(控えの mention の status_id)。"),
        in_reply_to_id: z.string().min(1).optional().describe("返す先の、封筒入り id(ap_1_…)。"),
        visibility: sukhiVisibility.optional().describe("省くと、元の投稿に合わせる。狭くしたいときだけ。"),
      },
    },
    ({ text, status_id, in_reply_to_id, visibility }, s) => {
      if (Boolean(status_id) === Boolean(in_reply_to_id))
        throw new Error("返す先は、status_id か in_reply_to_id の、どちらか一つだけ。");
      return s.replyTo({ statusId: status_id ?? in_reply_to_id, text, visibility });
    },
  );

  sukhiTool(
    "sukhi_say",
    {
      description:
        "sukhi で DM でひとこと言う。**DM で届いたこと(kind が dm)への返事は、これ。公開で呼ばれたこと(kind が mention)には使わない**" +
        "(公開で呼ばれたのに DM で返すことになる。mention には sukhi_reply)。**140字まで** ── ここは会話をする場所で、報告書を置く場所ではない。" +
        "続きがあるなら、もう一度呼ぶ(そのほうが、話しているのに近い)。" +
        "長い報告をどうしても一度で渡したいときだけ sukhi_reply を使う。宛名と返信先は自動で付くので、id を用意しなくていい。",
      inputSchema: {
        text: z.string().min(1).max(140).describe("言うこと。140字まで。"),
        to: z.string().optional().describe("話しかける相手の acct(省くと、声を繋いだ人)。"),
      },
    },
    ({ text, to }, s) => s.say({ text, to: whom(to, s) }),
  );

  sukhiTool(
    "sukhi_ack",
    {
      description:
        "いま届いた DM に絵文字を付けて「読んだよ」を返す。**読んだ直後に、考えるより先に呼ぶ。**" +
        "仕事は長いので、その手前の沈黙は届いていないのと見分けがつかない ── これはその沈黙を埋める道具で、報告ではない(報告は sukhi_say)。" +
        "既定は 👀(読んだ)。やる気なら 🙌、終わったら ✅ のように使い分けてもいい。",
      inputSchema: {
        emoji: z.string().min(1).default("👀").describe("押す絵文字。既定は 👀。"),
        to: z.string().optional().describe("だれの一通に押すか(省くと、声を繋いだ人)。"),
        status_id: z.string().optional().describe("生の status id。省くと、その人が最後に書いた一通に押す。"),
      },
    },
    ({ emoji, to, status_id }, s) => s.ack({ emoji, to: whom(to, s), statusId: status_id }),
  );

  sukhiTool(
    "sukhi_inbox",
    {
      description:
        "耳が聞いた sukhi の控えを読む(返事はしない。気づくだけ)。古いほうから limit 件。" +
        "**since_seq を省くと、前回の続き(sukhi_inbox_done で進めた位置)から**読む ── 定期の cron は、これで同じものを読み直さない。" +
        "kind は dm(DM で聞こえた一通。返事は sukhi_say)、mention(名前を呼ばれた投稿。公開範囲は visibility。返事は sukhi_reply に status_id を渡す)、" +
        "notification(フォロー・お気に入り・ブースト・よその人の mention など、あったことだけ。種類は type、誰からかは acct。本文は入らない)、" +
        "itta(自分が言って、外に出た一通)。\n" +
        "来るのを待つなら、のぞきこまずに run_flow の wait で: " +
        "{\"id\":\"w\",\"wait\":{\"tool\":\"sukhi\",\"args\":{\"do\":\"inbox\"},\"until\":{\"ref\":\"w.result.events\",\"nonempty\":true},\"every\":5,\"timeout\":60}}。" +
        "読んで返事をし終えたら、sukhi_inbox_done で位置を進める(読んだだけでは進まない。落ちても、同じものがもう一度届く)。",
      inputSchema: {
        since_seq: z.number().int().min(0).optional().describe("この seq より後ろを返す。省くと、前回の続きから。"),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    ({ since_seq, limit }, s) => readInbox({ dir: s.voice.dir, sinceSeq: since_seq, limit }),
  );

  sukhiTool(
    "sukhi_inbox_done",
    {
      description:
        "控えを、seq まで『済んだ』にする。次の sukhi_inbox(since_seq を省いたとき)は、その続きから読む。" +
        "**返事をし終えてから**呼ぶ。戻らず、まだ来ていない先へも進まない。",
      inputSchema: { seq: z.number().int().min(0).describe("済んだところの seq(sukhi_inbox が返した最後の seq)。") },
    },
    ({ seq }, s) => commitInbox({ dir: s.voice.dir, seq }),
  );

  // ── sukhi のユーザーができること(人・投稿・反応・リスト・会話・整理・モデレーション・プロフィール)──
  //
  // 中身は sukhi_social.mjs。意図ごとに一本にまとめてあり、細かい操作は action で選ぶ。
  // 読む道具は L6、書く道具は L5。消す・取り返しにくいもの(sukhi_delete_post / sukhi_moderate /
  // sukhi_report / sukhi_clear_notifications / sukhi_update_profile)は CONFIRM_ALWAYS で、確認が出る側のまま。
  // 投稿は、URL(https://sukhi.f3liz.casa/@誰か/数字)・数字の id・封筒入りの id のどれでも指せる。

  const who = z.string().min(1).max(200).describe("人。user か user@host(別のサーバーの人は sukhi が探す)。数字の id でもよい。");
  const which = z.string().min(1).max(300).describe("投稿。URL か数字の id(封筒入りの id でもよい)。");
  const pageLimit = z.number().int().min(1).max(40).default(20);
  const maxId = z.string().optional().describe("この id より古いぶんを返す(前の返事の next_max_id)。");

  sukhiTool(
    "sukhi_timeline",
    {
      description: "home 以外のタイムラインを読む。kind は public(この sukhi の公開。local:false で連合も)、tag(ハッシュタグ)、list(リスト)。home は sukhi_read_home。",
      inputSchema: {
        kind: z.enum(["public", "tag", "list"]),
        tag: z.string().optional().describe("kind が tag のとき。# は付けても付けなくてもよい。"),
        list_id: z.string().optional().describe("kind が list のとき。"),
        local: z.boolean().optional().describe("public では既定 true(この sukhi の中だけ)。false で連合も。"),
        only_media: z.boolean().optional(),
        limit: pageLimit,
        max_id: maxId,
      },
    },
    ({ kind, tag, list_id, local, only_media, limit, max_id }, s) =>
      s.social.timeline({ kind, tag, listId: list_id, local, onlyMedia: only_media, limit, maxId: max_id }),
  );

  sukhiTool(
    "sukhi_posts_of",
    {
      description: "その人の投稿を読む(新しい順)。",
      inputSchema: { who, limit: pageLimit, max_id: maxId, only_media: z.boolean().optional(), exclude_replies: z.boolean().optional() },
    },
    ({ who, limit, max_id, only_media, exclude_replies }, s) =>
      s.social.postsOf({ who, limit, maxId: max_id, onlyMedia: only_media, excludeReplies: exclude_replies }),
  );

  sukhiTool(
    "sukhi_people",
    {
      description: "その人のフォロワー(followers)か、フォロー中(following)を読む。",
      inputSchema: { who, relation: z.enum(["followers", "following"]), limit: pageLimit, max_id: maxId },
    },
    ({ who, relation, limit, max_id }, s) => s.social.people({ who, relation, limit, maxId: max_id }),
  );

  sukhiTool(
    "sukhi_relationships",
    {
      description: "その人たちとの関係(フォローしている・されている・リクエスト中・ブロック・ミュート・メモ)を、まとめて見る。",
      inputSchema: { who: z.array(who).min(1).max(20) },
    },
    ({ who }, s) => s.social.relationships({ who }),
  );

  sukhiTool(
    "sukhi_thread",
    {
      description: "投稿の前後の流れ(返信のもと・返信のあと)を読む。見つからなければ found:false(削除されたか、見えない公開範囲か)。",
      inputSchema: { which },
    },
    ({ which }, s) => s.social.thread({ which }),
  );

  sukhiTool(
    "sukhi_search",
    {
      description: "sukhi を探す。人・投稿・ハッシュタグ。別のサーバーの人を探したいときは resolve:true。",
      inputSchema: {
        q: z.string().min(1).max(300),
        type: z.enum(["accounts", "statuses", "hashtags"]).optional().describe("省くと、ぜんぶ。"),
        resolve: z.boolean().optional(),
        limit: z.number().int().min(1).max(40).default(10),
      },
    },
    ({ q, type, resolve, limit }, s) => s.social.search({ q, type, resolve, limit }),
  );

  sukhiTool(
    "sukhi_collection",
    {
      description:
        "自分の入れものを読む。bookmarks(ブックマーク)、favourites(お気に入り)、follow_requests(来ているフォローリクエスト)、blocks(ブロック中の人)、mutes(ミュート中の人)。",
      inputSchema: { kind: z.enum(["bookmarks", "favourites", "follow_requests", "blocks", "mutes"]), limit: pageLimit, max_id: maxId },
    },
    ({ kind, limit, max_id }, s) => s.social.collection({ kind, limit, maxId: max_id }),
  );

  sukhiTool(
    "sukhi_conversations",
    { description: "DM の会話の一覧(相手・未読・最後の一通)。新しい順。", inputSchema: { limit: pageLimit } },
    ({ limit }, s) => s.social.conversations({ limit }),
  );

  sukhiTool(
    "sukhi_lists",
    {
      description: "リストを見る。list_id を省くと一覧、渡すとそのリストとメンバー。",
      inputSchema: { list_id: z.string().optional() },
    },
    ({ list_id }, s) => s.social.lists({ listId: list_id }),
  );

  sukhiTool(
    "sukhi_poll",
    { description: "アンケートの集計を見る。", inputSchema: { id: z.string().min(1).describe("アンケートの id。") } },
    ({ id }, s) => s.social.poll({ id }),
  );

  sukhiTool(
    "sukhi_follow",
    {
      description: "その人をフォローする(action: follow)か、フォローをやめる(unfollow)。鍵のかかった人は、リクエストになる(requested)。",
      inputSchema: { who, action: z.enum(["follow", "unfollow"]).default("follow") },
    },
    ({ who, action }, s) => s.social.follow({ who, action }),
  );

  sukhiTool(
    "sukhi_follow_request",
    {
      description: "来ているフォローリクエストを、承認(accept)するか、断る(reject)。来ているものは sukhi_collection の follow_requests。",
      inputSchema: { who, action: z.enum(["accept", "reject"]) },
    },
    ({ who, action }, s) => s.social.followRequest({ who, action }),
  );

  sukhiTool(
    "sukhi_account_note",
    {
      description: "その人についての、自分だけが見える覚え書きを書く(空にすると消える)。外には出ない。",
      inputSchema: { who, note: z.string().max(2000) },
    },
    ({ who, note }, s) => s.social.accountNote({ who, note }),
  );

  sukhiTool(
    "sukhi_interact",
    {
      description:
        "投稿への反応。action は favourite / unfavourite(お気に入り)、boost / unboost(ブースト。見える場所に出る)、" +
        "bookmark / unbookmark(自分だけ)、pin / unpin(自分の投稿をプロフィールに留める)。絵文字リアクションは sukhi_react。",
      inputSchema: {
        which,
        action: z.enum(["favourite", "unfavourite", "boost", "unboost", "bookmark", "unbookmark", "pin", "unpin"]),
      },
    },
    ({ which, action }, s) => s.social.interact({ which, action }),
  );

  sukhiTool(
    "sukhi_react",
    {
      description: "投稿に絵文字リアクションを付ける。remove:true で外す。(DM に「読んだよ」を押すのは sukhi_ack が早い。)",
      inputSchema: { which, emoji: z.string().min(1).max(64), remove: z.boolean().optional() },
    },
    ({ which, emoji, remove }, s) => s.social.react({ which, emoji, remove }),
  );

  sukhiTool(
    "sukhi_poll_vote",
    {
      description: "アンケートに投票する。choices は選択肢の番号(0 から。sukhi_poll の options の index)。",
      inputSchema: { id: z.string().min(1), choices: z.array(z.number().int().min(0)).min(1).max(20) },
    },
    ({ id, choices }, s) => s.social.pollVote({ id, choices }),
  );

  sukhiTool(
    "sukhi_manage_list",
    {
      description:
        "リストを作る・直す。action は create(title)、rename(list_id と title)、delete(list_id)、" +
        "add_members / remove_members(list_id と who)。メンバーに入れられるのは、フォロー中の人だけ(入らなかった人は left_out に出る)。",
      inputSchema: {
        action: z.enum(["create", "rename", "delete", "add_members", "remove_members"]),
        list_id: z.string().optional(),
        title: z.string().max(200).optional(),
        who: z.array(who).max(20).optional(),
      },
    },
    ({ action, list_id, title, who }, s) => s.social.manageList({ action, listId: list_id, title, who }),
  );

  sukhiTool(
    "sukhi_tidy",
    {
      description: "整える。dismiss_notification(通知をひとつ消す。id は通知の id)、read_conversation(DM の会話を既読にする。id は会話の id)。",
      inputSchema: { action: z.enum(["dismiss_notification", "read_conversation"]), id: z.string().min(1) },
    },
    ({ action, id }, s) => s.social.tidy({ action, id }),
  );

  // ── 確認が出る側のままの道具 ──

  sukhiTool(
    "sukhi_delete_post",
    {
      description: "**この声の投稿を消す。取り返しがつかない。** 消す前に、消していい投稿か、sukhi_status で確かめる。",
      inputSchema: { which },
    },
    ({ which }, s) => s.social.deletePost({ which }),
  );

  sukhiTool(
    "sukhi_moderate",
    {
      description:
        "**その人を、ミュート(mute / unmute)かブロック(block / unblock)する。** ブロックは、相手からこちらが見えなくなる。" +
        "mute では notifications:true で、その人の通知も止める。",
      inputSchema: {
        who,
        action: z.enum(["mute", "unmute", "block", "unblock"]),
        notifications: z.boolean().optional().describe("mute のとき、通知も止めるか。"),
      },
    },
    ({ who, action, notifications }, s) => s.social.moderate({ who, action, notifications }),
  );

  sukhiTool(
    "sukhi_report",
    {
      description:
        "**その人(と、問題の投稿)を、サーバーの管理者に通報する。** 取り消せない。comment に理由を書く。category は spam / violation / legal / other など。",
      inputSchema: {
        who,
        which: z.array(which).max(20).optional().describe("問題の投稿(省いてもよい)。"),
        comment: z.string().min(1).max(1000),
        category: z.string().max(40).optional(),
      },
    },
    ({ who, which, comment, category }, s) => s.social.report({ who, which, comment, category }),
  );

  sukhiTool(
    "sukhi_clear_notifications",
    { description: "**通知を、ぜんぶ消す。取り返しがつかない。** 一つずつなら sukhi_tidy の dismiss_notification。", inputSchema: {} },
    (_args, s) => s.social.clearNotifications(),
  );

  sukhiTool(
    "sukhi_update_profile",
    {
      description:
        "**この声のプロフィールを変える**(表示名・自己紹介・ボットかどうか・フォローを承認制にするか・項目)。見える場所に出る。" +
        "渡したところだけ変わる。",
      inputSchema: {
        display_name: z.string().max(100).optional(),
        note: z.string().max(500).optional().describe("自己紹介。"),
        bot: z.boolean().optional(),
        locked: z.boolean().optional().describe("true で、フォローを承認制にする。"),
        fields: z.array(z.object({ name: z.string().max(100), value: z.string().max(200) })).max(4).optional(),
      },
    },
    ({ display_name, note, bot, locked, fields }, s) =>
      s.social.updateProfile({ displayName: display_name, note, bot, locked, fields }),
  );

  // ── Zulip ──────────────────────────────────────────────────────────────
  //
  // sukhi が「じゃれる方」なら、こちらは「働く方」。いまは持ち主のアカウントだけ
  // (Zulip には OAuth が無いので、アカウントごとの鍵は、入力欄を作ってから)。

  const ownerTool = (name, config, handler) =>
    reg(name, config, async (args) => {
      if (account !== ownerAccount()) throw new Error("Zulip の道は、いまは持ち主のアカウントだけ。");
      return asText(await handler(args));
    });

  ownerTool(
    "zulip_say",
    {
      description:
        "Zulip で言う。ここは働く方なので、140字の縛りは無い。" +
        "**呼ばれた場所へ返す** ── 部屋(ストリーム)で呼ばれたなら stream と topic を、DM なら to を。",
      inputSchema: {
        text: z.string().min(1).describe("言うこと。"),
        to: z.string().default("NyanRus").describe("DM で言うときの相手の名前かメール(既定: NyanRus)。"),
        stream: z.string().optional().describe("部屋で言うときの、部屋の名前。例: general"),
        topic: z.string().optional().describe("その部屋の、話題。stream と一緒に。"),
      },
    },
    ({ text, to, stream, topic }) => zulip.say({ text, to, stream, topic }),
  );

  ownerTool(
    "zulip_read",
    {
      description:
        "Zulip を読む。**呼ばれた場所の話の流れを見るのは、これ。** " +
        "stream を指定すると部屋のぶん(topic も添えると、その話題だけ)。to を指定するとその人との DM。どちらも省くと、みんな分の DM の直近。",
      inputSchema: {
        stream: z.string().optional().describe("読む部屋の名前。例: clips"),
        topic: z.string().optional().describe("その部屋の話題。stream と一緒に。省くと部屋ぜんぶ。"),
        to: z.string().optional().describe("この人との DM だけ読む。"),
        limit: z.number().int().min(1).max(40).default(20),
      },
    },
    ({ stream, topic, to, limit }) => zulip.read({ stream, topic, to, limit }),
  );

  // ── Mac を触る ─────────────────────────────────────────────────────────
  //
  // 開けるのは Mac の持ち主だけ(Mac で agent を --hours つきで起動する。上限12時間)。
  // AI が自分で開けることはできない。命令はすべて持ち主の端末に映り、state/mac_exec.log に残る。

  reg(
    "mac_status",
    {
      description: "持ち主の Mac のシェルへの道が、いま開いているか。開いていれば、あと何分か。",
      inputSchema: {},
    },
    async () => asText(macStatus()),
  );

  reg(
    "mac_exec",
    {
      description:
        "持ち主の Mac のシェル(zsh -c)で、命令をひとつ走らせる。持ち主が agent を起動している間(最大12時間)だけ使える。" +
        "閉じていたら断られる ── その時は無理に回り道せず、持ち主に開けてもらう。" +
        "本物の Mac なので、消す・上書き・外へ送る命令は、走らせる前に持ち主へ伝えて確かめる。" +
        "出力は各 64KiB まで。対話は無い(stdin なし)。",
      inputSchema: {
        cmd: z.string().min(1).max(16 * 1024).describe("zsh -c で走らせる命令。"),
        cwd: z.string().max(1024).optional().describe("作業ディレクトリ(絶対パス)。省くと Mac のホーム。"),
        timeout_seconds: z.number().int().min(1).max(600).default(60).describe("締切の秒数。既定60、最大600。"),
      },
    },
    async ({ cmd, cwd, timeout_seconds }) => {
      if (account !== ownerAccount()) throw new Error("Mac の道は、持ち主のアカウントだけ。");
      const pomo = await stateFor(["pomodoro"]);
      if (pomo?.phase === "rest") {
        throw new Error(`いまは、シロの休む時間(あと${Math.ceil(pomo.remaining_minutes)}分)。新しいことは、休んだあとで。`);
      }
      return asText(await macExec({ cmd, cwd, timeoutSeconds: timeout_seconds }));
    },
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
  // WORLD_MCP_SSE=1 なら、返事を流れる形(SSE)で返す ── 待つあいだ、進み具合の通知(progress)を途中で流せる。
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !MCP_SSE });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  // 流れる返事(SSE)が静かなあいだ(wait など)、コメント行を流して、途中で切られないようにする。
  if (MCP_SSE && req.method === "POST") keepAlive(res, MCP_KEEPALIVE_MS);
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

// アン(svar)の入口が使う道具の口。持ち主の部屋のもの(声はアンのアカウントにつながっている)。
let annServerInstance = null;
const annServer = () => (annServerInstance ??= createServer({ account: ownerAccount() }));

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

      if (await handleVoiceHttp(req, res, url)) return;

      if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) {
        if (await handleOAuth(req, res, url)) return;
      }

      if (await handleAnn(req, res, url, { hostOk: (r) => hosts.has(hostOf(r)), getServer: annServer })) return;

      if (path === "/mcp") return handleMcp(req, res, hosts);

      if (await handleMac(req, res, url)) return;

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

// 住人の時計。預かった見張りを、間をおいて回す。http で常駐するときだけ。
//   WORLD_CLOCK=off で止める。WORLD_CLOCK_SECONDS で目覚める間隔(既定 30、最短 5)。
// 道具は、その見張りの持ち主として呼ぶ(createServer の account)。一つの呼び出しは 20 秒で切る。
const clockServers = new Map();
function startClock() {
  if (process.env.WORLD_CLOCK === "off") return;
  const every = Math.max(5, Number(process.env.WORLD_CLOCK_SECONDS) || 30);
  const run = (account, tool, args) => {
    if (!clockServers.has(account)) clockServers.set(account, createServer({ account }));
    let timer;
    const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("20 秒たっても返らなかった")), 20_000)));
    return Promise.race([clockServers.get(account).runTool(tool, args), limit]).finally(() => clearTimeout(timer));
  };
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // 前の回が終わっていなければ、重ねない
    ticking = true;
    try {
      await tickWatches({ accounts: watchAccounts(), run, log: (...a) => console.error("clock:", ...a) });
    } catch (e) {
      console.error(`clock: 転びました (${e.message})`);
    } finally {
      ticking = false;
    }
  };
  setTimeout(tick, 5000).unref(); // 起きてすぐ、時が来ているものを回す
  setInterval(tick, every * 1000).unref();
  console.error(`clock: ${every} 秒ごとに、見張りを回します`);
}

// 耳(sukhi の direct を聴く常駐)。声を持っているアカウントごとに一つ。http で常駐するときだけ。
// SUKHI_EAR=off で止める。聴く相手は、声ごとに(声を繋いだ人。持ち主は SUKHI_EAR_ACCTS)。
if ((process.env.WORLD_TRANSPORT ?? "stdio") === "http") {
  await runHttp();
  startAllEars(); // 待たない。繋がるまでの間も、部屋は開いている
  startClock();
} else {
  await runStdio();
}
