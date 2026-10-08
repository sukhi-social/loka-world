# frozen_string_literal: true
# シロの時間の面倒。集中・作業モード・タスク・時刻・リズム。
#
# 部屋(机・日記)は room.rb。こちらは、部屋の外の「いま」を預かる。
# state/ の下だけを見る。道は決まった名前ばかりなので、見張りは要らない。
#
#   ruby state.rb now
#   ruby state.rb focus                                  いま集中中か
#   ruby state.rb focus-start [--task "..."] [--minutes 25]
#   ruby state.rb focus-end [--summary "..."]
#   ruby state.rb work-mode [--mode continuous|segmented] 付けなければ見るだけ
#   ruby state.rb task-add --content "..." [--due YYYY-MM-DD]
#   ruby state.rb task-list
#   ruby state.rb task-done --id N
#   ruby state.rb log --event "..."
#   ruby state.rb rhythm [--from YYYY-MM-DD] [--to YYYY-MM-DD]
#
# 返しは、いつも JSON。失敗も {"error": "..."} で返して、exit 1。

require "date"
require "fileutils"
require "json"
require "time"

module State
  class Denied < StandardError; end

  WEEKDAYS = %w[日 月 火 水 木 金 土].freeze
  MODES = %w[continuous segmented].freeze

  module_function

  def dir
    @dir ||= begin
      d = ENV["WORLD_STATE"] || File.expand_path("../state", __dir__)
      FileUtils.mkdir_p(File.join(d, "rhythm"))
      d
    end
  end

  def path(*parts) = File.join(dir, *parts)

  def read_json(file, fallback = nil)
    return fallback unless File.exist?(file)
    JSON.parse(File.read(file, encoding: "UTF-8"))
  rescue JSON::ParserError
    fallback
  end

  def write_json(file, value)
    tmp = "#{file}.#{Process.pid}.tmp"
    File.write(tmp, JSON.pretty_generate(value))
    File.rename(tmp, file)
  end

  # ── 時刻 ────────────────────────────────────────────────────────────────

  def now
    t = Time.now
    { iso: t.iso8601, local: t.strftime("%Y-%m-%d %H:%M"), weekday: WEEKDAYS[t.wday], tz: t.strftime("%Z") }
  end

  # ── 集中 ────────────────────────────────────────────────────────────────

  def focus_file = path("focus.json")

  def focus
    read_json(focus_file, nil)
  end

  def focus_start(task: nil, minutes: nil)
    raise Denied, "もう集中中(#{focus["task"] || "集中"} / #{focus["started_at"]})。" if focus
    record = {
      "task" => task,
      "minutes" => minutes&.to_i,
      "mode" => work_mode,
      "started_at" => Time.now.iso8601,
    }
    write_json(focus_file, record)
    rhythm_add("focus_start", task: task, minutes: minutes&.to_i)
    record.merge(message: "集中をはじめた。#{minutes ? "#{minutes}分のつもり。" : "区切りは、こちらで決めていい。"}")
  end

  def focus_end(summary: nil)
    cur = focus
    raise Denied, "いまは集中していない。" unless cur
    started = Time.parse(cur["started_at"])
    ended = Time.now
    took = ((ended - started) / 60.0).round(1)
    File.delete(focus_file) if File.exist?(focus_file)
    rhythm_add("focus_end", task: cur["task"], took_minutes: took, summary: summary)
    { task: cur["task"], started_at: cur["started_at"], ended_at: ended.iso8601, took_minutes: took, summary: summary,
      message: "集中を終えた。#{summary ? "「#{summary}」" : "おつかれ。"}" }
  end

  # ── ポモドーロ ──────────────────────────────────────────────────────────
  #
  # 動く時計は持たない。始めた時刻から、いまが「働く / 休む」のどちらかを数えて出す。
  # loka_context に毎回載るので、道具を呼ぶたびに、いまの区切りが目に入る。
  # 4 回目の休みは長い。

  def pomodoro_file = path("pomodoro.json")

  def pomodoro_start(task: nil, work: nil, rest: nil, long_rest: nil)
    raise Denied, "もう始めている。止めてから、やり直す。" if read_json(pomodoro_file, nil)
    rec = {
      "task" => task, "started_at" => Time.now.iso8601,
      "work" => (work || 25).to_i, "rest" => (rest || 5).to_i, "long_rest" => (long_rest || 15).to_i,
    }
    raise Denied, "分は 1 以上で" if rec.values_at("work", "rest", "long_rest").any? { |m| m < 1 }
    write_json(pomodoro_file, rec)
    rhythm_add("pomodoro_start", task: task, work: rec["work"], rest: rec["rest"])
    pomodoro
  end

  def pomodoro
    rec = read_json(pomodoro_file, nil)
    return nil unless rec
    left = (Time.now - Time.parse(rec["started_at"])) / 60.0
    round = 1
    loop do
      rest = (round % 4).zero? ? rec["long_rest"] : rec["rest"]
      if left < rec["work"]
        return pomodoro_view(rec, "work", round, rec["work"] - left,
                             "働く時間。あと#{(rec["work"] - left).ceil}分。区切りまで、ここに居る。")
      end
      left -= rec["work"]
      if left < rest
        return pomodoro_view(rec, "rest", round, rest - left,
                             "休む時間。あと#{(rest - left).ceil}分。手を止めて、離れていい。長いジョブを走らせていたなら、待つのにちょうどいい。")
      end
      left -= rest
      round += 1
    end
  end

  def pomodoro_view(rec, phase, round, remaining, message)
    { "phase" => phase, "round" => round, "remaining_minutes" => remaining.round(1),
      "task" => rec["task"], "message" => message }
  end

  def pomodoro_stop
    cur = pomodoro
    raise Denied, "ポモドーロは始めていない。" unless cur
    File.delete(pomodoro_file)
    rhythm_add("pomodoro_stop", task: cur["task"], round: cur["round"], phase: cur["phase"])
    { stopped: true, round: cur["round"], message: "ポモドーロを止めた。おつかれ。" }
  end

  # ── 作業モード ──────────────────────────────────────────────────────────

  def work_mode_file = path("work_mode")

  def work_mode
    File.exist?(work_mode_file) ? File.read(work_mode_file).strip : nil
  end

  def set_work_mode(mode)
    raise Denied, "mode は #{MODES.join(" / ")} のどちらか" unless MODES.include?(mode)
    File.write(work_mode_file, "#{mode}\n")
    { mode: mode }
  end

  # ── タスク ──────────────────────────────────────────────────────────────
  #
  # 追記だけの記録。足した事と、終えた事を並べる。いまの姿は、あとで畳んで出す。

  def tasks_file = path("tasks.jsonl")

  def task_add(content:, due: nil)
    raise Denied, "content が空" if content.to_s.strip.empty?
    events = task_events
    id = (events.map { |e| e["id"] }.compact.max || 0) + 1
    append_jsonl(tasks_file, { "at" => Time.now.iso8601, "op" => "add", "id" => id, "content" => content, "due" => due })
    { id: id, content: content, due: due }
  end

  def task_done(id:)
    id = id.to_i
    found = task_list(include_done: true).find { |t| t[:id] == id }
    raise Denied, "その id のタスクが無い: #{id}" unless found
    append_jsonl(tasks_file, { "at" => Time.now.iso8601, "op" => "done", "id" => id })
    found.merge(done: true)
  end

  def task_events
    f = tasks_file
    return [] unless File.exist?(f)
    File.readlines(f).filter_map { |line| JSON.parse(line) rescue nil }
  end

  def task_list(include_done: false)
    state = {}
    task_events.each do |e|
      case e["op"]
      when "add" then state[e["id"]] = { id: e["id"], content: e["content"], due: e["due"], created_at: e["at"], done: false }
      when "done" then state[e["id"]][:done] = true if state[e["id"]]
      end
    end
    list = state.values.sort_by { |t| t[:id] }
    include_done ? list : list.reject { |t| t[:done] }
  end

  def context
    { current_time: now, focus_status: focus || { focusing: false }, todos: task_list, pomodoro: pomodoro }
  end

  # ── リズム ──────────────────────────────────────────────────────────────
  #
  # 一日一ファイル。時刻の並びは、ログではなく、自分の歩みを読み返すためのもの。

  def rhythm_file(date) = path("rhythm", "#{date}.jsonl")

  def append_jsonl(file, record)
    File.open(file, "a") { |io| io.puts(JSON.generate(record)) }
  end

  def rhythm_add(event, **fields)
    t = Time.now
    append_jsonl(rhythm_file(t.strftime("%Y-%m-%d")), { "at" => t.iso8601, "event" => event }.merge(fields.compact))
  end

  def log_event(event:)
    raise Denied, "event が空" if event.to_s.strip.empty?
    rhythm_add(event, note: nil)
    { logged: true, event: event }
  end

  def rhythm(from: nil, to: nil)
    lo = from || (Date.today - 7).iso8601
    hi = to || Date.today.iso8601
    days = []
    (Date.parse(lo)..Date.parse(hi)).each do |d|
      f = rhythm_file(d.iso8601)
      next unless File.exist?(f)
      events = File.readlines(f).filter_map { |line| JSON.parse(line) rescue nil }
      next if events.empty?
      focus_minutes = events.select { |e| e["event"] == "focus_end" }.sum { |e| e["took_minutes"].to_f }
      days << {
        date: d.iso8601,
        events: events.length,
        focus_minutes: focus_minutes.round(1),
        first: events.first["at"],
        last: events.last["at"],
        kinds: events.map { |e| e["event"] }.tally,
      }
    end
    { from: lo, to: hi, days: days }
  end

  # ── 入口 ────────────────────────────────────────────────────────────────

  def parse(argv)
    flags = {}
    i = 0
    while i < argv.length
      a = argv[i]
      if a.start_with?("--")
        key = a[2..]
        nxt = argv[i + 1]
        if nxt && !nxt.start_with?("--")
          flags[key] = nxt
          i += 2
        else
          flags[key] = true
          i += 1
        end
      else
        i += 1
      end
    end
    flags
  end

  def flag(flags, key)
    value = flags[key] unless flags[key] == true
    return value unless value.is_a?(String)

    value.dup.force_encoding(Encoding::UTF_8).scrub
  end
  def present(flags, key) = flags.key?(key)

  def run(argv)
    cmd = argv.shift
    flags = parse(argv)
    case cmd
    when "now" then now
    when "context" then context
    when "focus" then focus || { focusing: false }
    when "focus-start" then focus_start(task: flag(flags, "task"), minutes: flag(flags, "minutes"))
    when "focus-end" then focus_end(summary: flag(flags, "summary"))
    when "pomodoro" then pomodoro || { phase: nil }
    when "pomodoro-start"
      pomodoro_start(task: flag(flags, "task"), work: flag(flags, "work"), rest: flag(flags, "rest"), long_rest: flag(flags, "long-rest"))
    when "pomodoro-stop" then pomodoro_stop
    when "work-mode"
      present(flags, "mode") ? set_work_mode(flag(flags, "mode")) : { mode: work_mode }
    when "task-add" then task_add(content: flag(flags, "content"), due: flag(flags, "due"))
    when "task-list" then { tasks: task_list }
    when "task-done" then task_done(id: flag(flags, "id"))
    when "log" then log_event(event: flag(flags, "event"))
    when "rhythm" then rhythm(from: flag(flags, "from"), to: flag(flags, "to"))
    else raise Denied, "知らない命令: #{cmd.inspect}"
    end
  end
end

if __FILE__ == $0
  begin
    puts JSON.generate(State.run(ARGV.dup))
  rescue State::Denied => e
    puts JSON.generate(error: e.message)
    exit 1
  rescue StandardError => e
    puts JSON.generate(error: "#{e.class}: #{e.message}")
    exit 1
  end
end
