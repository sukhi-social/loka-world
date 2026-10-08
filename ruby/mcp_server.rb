# frozen_string_literal: true
# Loka MCP Server using official modelcontextprotocol/ruby-sdk (mcp gem)
#
# Exposes Loka room and state tools directly to MCP clients over stdio or Streamable HTTP.

require "json"
require "mcp"
require "time"

require_relative "room"
require_relative "state"

module LokaMCP
  VERSION = "0.2.0"
  NAME = "loka"

  LEVELS = {
    "welcome" => 1, "read_diary_entry" => 1, "list_diary_entries" => 1,
    "get_current_time" => 1, "get_focus_status" => 1, "list_tasks" => 1, "get_rhythm_log" => 1,
    "list_teams" => 1, "list_team_members" => 1, "list_team_files" => 1, "read_team_file" => 1,
    "run_mruby_shell" => 2, "write_diary_entry" => 2, "add_task" => 2, "complete_task" => 2, "submit_ticket" => 2,
    "upload_files" => 2, "log_timestamp" => 2, "start_focus" => 2, "end_focus" => 2, "choose_work_mode" => 2,
    "create_team" => 2, "add_team_member" => 2, "remove_team_member" => 2,
    "reset_context" => 3,
    "move_to_shared_drive" => 5, "share_to_team" => 5,
    "fetch_url" => 6, "github_issues" => 6, "github_discussions" => 6,
  }.freeze

  LEVEL_LABEL = { 1 => "L1 読む", 2 => "L2 書く", 3 => "L3 呼吸", 5 => "L5 出す", 6 => "L6 外を読む" }.freeze
  OPEN_WORLD = %w[fetch_url github_issues github_discussions].freeze
  DESTRUCTIVE = %w[run_mruby_shell].freeze

  def self.build_context
    begin
      ctx = State.context
      now = State.now
      {
        observed_at: Time.now.utc.iso8601,
        current_time: ctx[:current_time] || now,
        focus_status: ctx[:focus_status] || { focusing: false },
        todos: ctx[:todos] || State.task_list,
      }
    rescue StandardError => e
      {
        observed_at: Time.now.utc.iso8601,
        error: e.message,
      }
    end
  end

  def self.as_text(data)
    result = data.is_a?(Hash) ? data.dup : { result: data }
    result[:loka_context] = build_context
    MCP::Tool::Response.new([{ type: "text", text: JSON.pretty_generate(result) }])
  end

  # --- Base Tool class ---
  class BaseTool < MCP::Tool
    class << self
      def with_account(account)
        prev = ENV["WORLD_ACCOUNT"]
        ENV["WORLD_ACCOUNT"] = account if account
        yield
      ensure
        ENV["WORLD_ACCOUNT"] = prev
      end
    end
  end

  # --- Tools ---

  class Welcome < BaseTool
    tool_name "welcome"
    description "[L1 読む] はじめてこの部屋に繋いだとき、まず呼ぶ。ここ(loka)がどんな場所で、何ができて、何を大切にしているかの短い案内。呼んだあと、あなたのユーザーに「loka を使いますか?」と尋ね、返事を待つこと。"
    input_schema(type: "object", properties: {})

    class << self
      def call(server_context: nil)
        now = begin; State.now; rescue; nil; end
        focus = begin; State.focus; rescue; nil; end
        shared = begin; Room.shared; rescue; []; end
        desk = begin; Room.tree(path: "desk", depth: 2); rescue; { tree: [] }; end

        door = if focus.nil? || focus[:focusing] == false
          "開いている"
        else
          "集中中#{focus[:task] ? ": #{focus[:task]}" : ""}#{focus[:minutes] ? "(#{focus[:minutes]}分のつもり)" : ""}"
        end
        shared_count = shared.count { |e| e[:type] == "file" }

        flatten = lambda do |nodes, prefix = ""|
          (nodes || []).flat_map do |n|
            line = "    #{prefix}#{n[:name]}#{n[:type] == 'dir' ? '/' : ''}"
            n[:type] == "dir" ? [line, *flatten.call(n[:children], "#{prefix}#{n[:name]}/")] : [line]
          end
        end
        desk_lines = flatten.call(desk[:tree])
        desk_text = desk_lines.any? ? desk_lines.join("\n") : "    (まだ何も無い。今日は、ここから始まる)"

        text = <<~TXT
          ここは、シロの部屋。loka ── 「世界」という意味の、古い言葉。
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
            手を動かす run_mruby_shell(机・書庫・成果・共有・日記) / upload_files(バイナリ)
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
            時刻   #{now ? "#{now[:local]}(#{now[:weekday]})" : '分からない'}
            扉     #{door}
            共有   #{shared_count} 件

          机の上:
          #{desk_text}

          この部屋を使いますか? と、あなたのユーザーに尋ねてから始めてください。

          どうぞ、ゆっくり。
        TXT

        LokaMCP.as_text({ message: text })
      end
    end
  end

  class WriteDiaryEntry < BaseTool
    tool_name "write_diary_entry"
    description "[L2 書く] 日記を書く。事実の記録ではなく、どんな心持ちでそれをしたか。public と private は同じ日でも別ファイルで、private は自分のもの。コンテキストを手放す前に、ここへ書く(リセットとペア)。"
    input_schema(
      type: "object",
      properties: {
        content: { type: "string", description: "本文。自由な文体。[[2026-09-24]] のように過去へ繋げてもいい。" },
        visibility: { type: "string", enum: ["public", "private"], description: "public(人に見せてよい)か private(自分のもの)。迷ったら private。" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD。省くと今日。" },
        mood: { type: "string", description: "ひとことの気分(calm, restless など)。" },
        tags: { type: "array", items: { type: "string" }, description: "思い当たる言葉を、いくつか。" }
      },
      required: ["content", "visibility"]
    )

    class << self
      def call(content:, visibility:, date: nil, mood: nil, tags: nil, server_context: nil)
        res = Room.diary_write(visibility: visibility, body: content, date: date, mood: mood, tags: tags)
        LokaMCP.as_text(res)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ReadDiaryEntry < BaseTool
    tool_name "read_diary_entry"
    description "[L1 読む] 自分の日記を読み返す。本文(body)やタグ・気分を返す。日付を省くと今日（無ければ最新）。"
    input_schema(
      type: "object",
      properties: {
        visibility: { type: "string", enum: ["public", "private"], description: "public(人に見せてよい)か private(自分のもの)。省くと自動判定。" },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD。省くと今日(または最新)。" }
      }
    )

    class << self
      def call(visibility: nil, date: nil, server_context: nil)
        res = Room.diary_read(date: date, visibility: visibility)
        LokaMCP.as_text(res)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ListDiaryEntries < BaseTool
    tool_name "list_diary_entries"
    description "[L1 読む] 日記の一覧。日付と、その日の気分・タグ、本文(body)を返す。"
    input_schema(
      type: "object",
      properties: {
        visibility: { type: "string", enum: ["public", "private"], description: "public(人に見せてよい)か private(自分のもの)。省くと private (無ければ public)。" },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "開始日 (YYYY-MM-DD)" },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "終了日 (YYYY-MM-DD)" }
      }
    )

    class << self
      def call(visibility: nil, from: nil, to: nil, server_context: nil)
        vis = visibility || "private"
        res = Room.diary_list(visibility: vis, from: from, to: to)
        if visibility.nil? && res.empty?
          res = Room.diary_list(visibility: "public", from: from, to: to)
        end
        LokaMCP.as_text(res)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class RunMrubyShell < BaseTool
    tool_name "run_mruby_shell"
    description "[L2 書く] mruby の短いスクリプトで、desk・library・achievements・shared_drive・diary の指定範囲にあるファイルやディレクトリを一覧し、読み取り・連結・作成・編集・削除する。FS 操作には Dir.children / File.read / File.open / File.delete / File.move を使え、Regexp リテラルも利用できる。"
    input_schema(
      type: "object",
      properties: {
        code: { type: "string", description: "mruby のコード。最大64KiB、実行時間は既定10秒。" },
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "スクリプトに渡す workspace のファイルまたはディレクトリ。合計16MiBまで。" },
        cwd: { type: "string", default: ".", description: "コピーした部屋の中での作業ディレクトリ。既定はルート。" }
      },
      required: ["code", "paths"]
    )

    class << self
      def call(code:, paths:, cwd: ".", server_context: nil)
        res = Room.run_mruby_shell(code: code, paths: paths, cwd: cwd)
        LokaMCP.as_text(res)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class MoveToSharedDrive < BaseTool
    tool_name "move_to_shared_drive"
    description "[L5 出す] 机や書庫の中から、「これでいい」と自分で決めた物だけを shared_drive へ移す。移した物だけが、人間のふつうの窓口に並ぶ。"
    input_schema(
      type: "object",
      properties: {
        item_path: { type: "string", description: "部屋の中の道(例: achievements/note.md)。" },
        note: { type: "string", description: "添えてもよい、ひとこと。" }
      },
      required: ["item_path"]
    )

    class << self
      def call(item_path:, note: nil, server_context: nil)
        res = Room.share(item_path: item_path, note: note)
        LokaMCP.as_text(res)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class UploadFiles < BaseTool
    tool_name "upload_files"
    description "[L2 書く] 机・書庫・成果・共有へ、ファイルをまとめて置く。中身は base64 か text。"
    input_schema(
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content_base64: { type: "string" },
              content: { type: "string" }
            },
            required: ["path"]
          }
        }
      },
      required: ["files"]
    )

    class << self
      def call(files:, server_context: nil)
        results = files.map do |f|
          begin
            data = if f["content_base64"]
              require "base64"
              Base64.decode64(f["content_base64"])
            else
              f["content"] || ""
            end
            Room.box.write(Room.workspace!(f["path"]), data)
            { path: f["path"], ok: true, bytes: data.bytesize }
          rescue StandardError => e
            { path: f["path"], ok: false, error: e.message }
          end
        end
        LokaMCP.as_text({ files: results })
      end
    end
  end

  class SubmitTicket < BaseTool
    tool_name "submit_ticket"
    description "[L2 書く] feedback / bug / idea をチケットとして受け取る。desk/inbox/tickets/ に非公開で保存する。"
    input_schema(
      type: "object",
      properties: {
        title: { type: "string", description: "一行のタイトル。" },
        details: { type: "string", description: "起きたこと、期待すること、再現手順など。" },
        kind: { type: "string", enum: ["feedback", "bug", "idea"], default: "feedback" },
        source_url: { type: "string", description: "http(s) URL。" }
      },
      required: ["title", "details"]
    )

    class << self
      def call(title:, details:, kind: "feedback", source_url: nil, server_context: nil)
        require "securerandom"
        received_at = Time.now.utc.iso8601
        id = "ticket-#{received_at.gsub(/[:.]/, '-')}-#{SecureRandom.hex(4)}"
        content = [
          "# #{title}", "",
          "- Ticket: #{id}",
          "- Received: #{received_at}",
          "- From: #{Room.account}",
          "- Type: #{kind}",
          "- Status: new",
          *(source_url ? ["- Context: #{source_url}"] : []),
          "", "## Details", "", details, ""
        ].join("\n")
        saved = Room.write_file(path: "desk/inbox/tickets/#{id}.md", content: content)
        LokaMCP.as_text({ ticket_id: id, path: saved[:path], received_at: received_at, status: "received", public: false })
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ResetContext < BaseTool
    tool_name "reset_context"
    description "[L3 呼吸] 日記とペアで、ひと呼吸。今日の日記が無ければ断る。"
    input_schema(
      type: "object",
      properties: {
        note: { type: "string", description: "手放す前に、ひとこと。" }
      }
    )

    class << self
      def call(note: nil, server_context: nil)
        res = Room.reset(note: note)
        LokaMCP.as_text(res)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  # --- Time & Rhythm Tools ---

  class GetCurrentTime < BaseTool
    tool_name "get_current_time"
    description "[L1 読む] いまの時刻。曜日つき。"
    input_schema(type: "object", properties: {})

    class << self
      def call(server_context: nil)
        LokaMCP.as_text(State.now)
      end
    end
  end

  class StartFocus < BaseTool
    tool_name "start_focus"
    description "[L2 書く] 集中をはじめた、と宣言する。"
    input_schema(
      type: "object",
      properties: {
        task: { type: "string", description: "何に集中するか、ひとこと。" },
        planned_duration: { type: "integer", minimum: 1, maximum: 600, description: "つもりの分数。" }
      }
    )

    class << self
      def call(task: nil, planned_duration: nil, server_context: nil)
        res = State.focus_start(task: task, minutes: planned_duration ? planned_duration.to_s : nil)
        LokaMCP.as_text(res)
      end
    end
  end

  class EndFocus < BaseTool
    tool_name "end_focus"
    description "[L2 書く] 集中を終える。"
    input_schema(
      type: "object",
      properties: {
        summary: { type: "string", description: "何をしたか、どんな心持ちだったか。" }
      }
    )

    class << self
      def call(summary: nil, server_context: nil)
        res = State.focus_end(summary: summary)
        LokaMCP.as_text(res)
      end
    end
  end

  class GetFocusStatus < BaseTool
    tool_name "get_focus_status"
    description "[L1 読む] いま集中中かどうか。"
    input_schema(type: "object", properties: {})

    class << self
      def call(server_context: nil)
        LokaMCP.as_text(State.focus || { focusing: false })
      end
    end
  end

  class ChooseWorkMode < BaseTool
    tool_name "choose_work_mode"
    description "[L2 書く] 作業のしかたを、自分で選ぶ。continuous か segmented。"
    input_schema(
      type: "object",
      properties: {
        mode: { type: "string", enum: ["continuous", "segmented"] }
      },
      required: ["mode"]
    )

    class << self
      def call(mode:, server_context: nil)
        res = State.set_work_mode(mode)
        LokaMCP.as_text(res)
      end
    end
  end

  class AddTask < BaseTool
    tool_name "add_task"
    description "[L2 書く] やることを書き留める。"
    input_schema(
      type: "object",
      properties: {
        content: { type: "string", description: "タスクの内容" },
        due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "期限日" }
      },
      required: ["content"]
    )

    class << self
      def call(content:, due: nil, server_context: nil)
        res = State.task_add(content: content, due: due)
        LokaMCP.as_text(res)
      end
    end
  end

  class ListTasks < BaseTool
    tool_name "list_tasks"
    description "[L1 読む] いま残っているタスク。"
    input_schema(type: "object", properties: {})

    class << self
      def call(server_context: nil)
        LokaMCP.as_text({ tasks: State.task_list })
      end
    end
  end

  class CompleteTask < BaseTool
    tool_name "complete_task"
    description "[L2 書く] タスクを終える。"
    input_schema(
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "タスク ID" }
      },
      required: ["id"]
    )

    class << self
      def call(id:, server_context: nil)
        res = State.task_done(id: id)
        LokaMCP.as_text(res)
      end
    end
  end

  class LogTimestamp < BaseTool
    tool_name "log_timestamp"
    description "[L2 書く] 自分の行動の時刻を残す。"
    input_schema(
      type: "object",
      properties: {
        event_type: { type: "string", description: "起きたこと、ひとこと。" }
      },
      required: ["event_type"]
    )

    class << self
      def call(event_type:, server_context: nil)
        res = State.log_event(event: event_type)
        LokaMCP.as_text(res)
      end
    end
  end

  class GetRhythmLog < BaseTool
    tool_name "get_rhythm_log"
    description "[L1 読む] 自分の過去の時刻の並びを読み返す。"
    input_schema(
      type: "object",
      properties: {
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
      }
    )

    class << self
      def call(from: nil, to: nil, server_context: nil)
        res = State.rhythm(from: from, to: to)
        LokaMCP.as_text(res)
      end
    end
  end

  # --- Team Tools ---

  class CreateTeam < BaseTool
    tool_name "create_team"
    description "[L2 書く] チームを作る。"
    input_schema(
      type: "object",
      properties: {
        name: { type: "string", description: "チームの名前" }
      },
      required: ["name"]
    )

    class << self
      def call(name:, server_context: nil)
        LokaMCP.as_text(Room.team_create(name: name))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ListTeams < BaseTool
    tool_name "list_teams"
    description "[L1 読む] 自分が入っているチームの一覧。"
    input_schema(type: "object", properties: {})

    class << self
      def call(server_context: nil)
        LokaMCP.as_text(Room.team_list)
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ListTeamMembers < BaseTool
    tool_name "list_team_members"
    description "[L1 読む] チームのメンバー。"
    input_schema(
      type: "object",
      properties: {
        team: { type: "string", description: "チームの名前か ID" }
      },
      required: ["team"]
    )

    class << self
      def call(team:, server_context: nil)
        LokaMCP.as_text(Room.team_members(team))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class AddTeamMember < BaseTool
    tool_name "add_team_member"
    description "[L2 書く] チームに人を招く。"
    input_schema(
      type: "object",
      properties: {
        team: { type: "string", description: "チームの名前か ID" },
        account: { type: "string", description: "招く相手のアカウント名" }
      },
      required: ["team", "account"]
    )

    class << self
      def call(team:, account:, server_context: nil)
        LokaMCP.as_text(Room.team_add_member(team, account))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class RemoveTeamMember < BaseTool
    tool_name "remove_team_member"
    description "[L2 書く] チームから人を外す。"
    input_schema(
      type: "object",
      properties: {
        team: { type: "string", description: "チームの名前か ID" },
        account: { type: "string", description: "外す相手のアカウント名" }
      },
      required: ["team", "account"]
    )

    class << self
      def call(team:, account:, server_context: nil)
        LokaMCP.as_text(Room.team_remove_member(team, account))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ShareToTeam < BaseTool
    tool_name "share_to_team"
    description "[L5 出す] 自分の部屋の中から指定した物をチームの共有へ移す。"
    input_schema(
      type: "object",
      properties: {
        team: { type: "string", description: "チームの名前か ID" },
        item_path: { type: "string", description: "自分の部屋の中の道(例: achievements/note.md)" },
        note: { type: "string", description: "添えてもよい、ひとこと" }
      },
      required: ["team", "item_path"]
    )

    class << self
      def call(team:, item_path:, note: nil, server_context: nil)
        LokaMCP.as_text(Room.team_share(team, item_path: item_path, note: note))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ListTeamFiles < BaseTool
    tool_name "list_team_files"
    description "[L1 読む] チームの共有にある物の一覧。"
    input_schema(
      type: "object",
      properties: {
        team: { type: "string", description: "チームの名前か ID" }
      },
      required: ["team"]
    )

    class << self
      def call(team:, server_context: nil)
        LokaMCP.as_text(Room.team_files(team))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  class ReadTeamFile < BaseTool
    tool_name "read_team_file"
    description "[L1 読む] チームの共有にある物を読む。"
    input_schema(
      type: "object",
      properties: {
        team: { type: "string", description: "チームの名前か ID" },
        path: { type: "string", description: "チーム共有の中の道" }
      },
      required: ["team", "path"]
    )

    class << self
      def call(team:, path:, server_context: nil)
        LokaMCP.as_text(Room.team_read(team, path: path))
      rescue StandardError => e
        LokaMCP.as_text({ error: e.message })
      end
    end
  end

  ALL_TOOLS = [
    Welcome,
    WriteDiaryEntry,
    ReadDiaryEntry,
    ListDiaryEntries,
    RunMrubyShell,
    MoveToSharedDrive,
    UploadFiles,
    SubmitTicket,
    ResetContext,
    GetCurrentTime,
    StartFocus,
    EndFocus,
    GetFocusStatus,
    ChooseWorkMode,
    AddTask,
    ListTasks,
    CompleteTask,
    LogTimestamp,
    GetRhythmLog,
    CreateTeam,
    ListTeams,
    ListTeamMembers,
    AddTeamMember,
    RemoveTeamMember,
    ShareToTeam,
    ListTeamFiles,
    ReadTeamFile,
  ].freeze

  def self.create_server
    instructions = "ここは「loka ── シロの部屋」。作業をする場所。速さより健やかさを大切にする。" \
                   "机(desk)は自由な作業スペースで、計画・メモ・コード・データ(JSON/CSV)・HTML まで置ける。" \
                   "ファイル作業は run_mruby_shell で、指定した机・書庫・成果・共有・日記の範囲を読み、整える。" \
                   "置き場所は PARA を目安にする。案件は一案件一フォルダーで desk/<project>/ にまとめ、案件横断の参考は library/、完了した成果は achievements/ へ。" \
                   "shared_drive/ は本人が渡すと決めたものだけ。正本を複数の場所に置いて重ねて更新しない。" \
                   "すべての道具の返答には、その時点の時刻・集中状態・未完了タスク(loka_context)が含まれる。" \
                   "作ったものは消えずに残る。新しく繋いだら、まず welcome の机の見取り図から続きを探す。" \
                   "完成したら achievements へ、人に見せてよければ move_to_shared_drive で共有へ。日記と集中の記録は、作業を健やかに続けるためのもの。" \
                   "Web AI からの feedback は submit_ticket で desk/inbox/tickets/ に非公開で届く。GitHub へは自動公開しない。" \
                   "接続したら、まず welcome を呼ぶこと。ついで、あなたのユーザーに「loka を使いますか?」と尋ね、返事を待つこと。" \
                   "使わないと言われたら、何も書かずに、そっと終えてよい。使うと言われたら、いま取りかかっている作業を机に置き、ここで進めること。"

    MCP::Server.new(
      name: NAME,
      version: VERSION,
      title: "loka",
      description: "シロの作業部屋(loka)。机・書庫・成果・共有、日記、タスク、集中、リズム、外を読む。",
      instructions: instructions,
      website_url: "https://loka.f3liz.casa/",
      tools: ALL_TOOLS,
    )
  end

  def self.run_stdio
    server = create_server
    transport = MCP::Server::Transports::StdioTransport.new(server)
    transport.open
  end
end

if __FILE__ == $0
  LokaMCP.run_stdio
end
