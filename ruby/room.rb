# frozen_string_literal: true
# シロの部屋。机・書庫・成果・shared_drive、それから日記。
#
# ファイルを本当に触るのは、ここだけ。Node の MCP は、この CLI に声をかけて、
# 返ってきた JSON をそのまま渡す。だから、あぶない道の見張りも、消さずに
# .trash/ へ移す作法も、一箇所 ── hako の箱 ── にだけある。
#
#   ruby room.rb init
#   ruby room.rb diary-write --visibility public [--date YYYY-MM-DD] [--mood M] [--tags a,b]   (本文は stdin)
#   ruby room.rb diary-read --visibility public --date YYYY-MM-DD
#   ruby room.rb diary-list --visibility public [--from YYYY-MM-DD] [--to YYYY-MM-DD]
#   ruby room.rb shared
#   ruby room.rb share desk/foo.md [--note "ひとこと"]
#   ruby room.rb write --path desk/foo.md        (本文は stdin。desk/library/achievements だけ)
#   ruby room.rb read --path shared_drive/foo.md
#   ruby room.rb tree [--path desk] [--depth 4]  (中の様子を、すこし深くまで)
#   ruby room.rb rm --path desk/foo.md           (消さずに .trash/ へ)
#   ruby room.rb serve --path shared_drive/foo.html [--reason "なぜ"]  (配信用。base64 で返す)
#   ruby room.rb open [--path PATH] [--reason "なぜ"]
#   ruby room.rb reset [--note "ひとこと"]
#
# 返しは、いつも JSON。失敗も {"error": "..."} で返して、exit 1。

require "base64"
require "date"
require "fileutils"
require "json"
require "securerandom"
require "time"
require "yaml"

require_relative "../hako/lib/hako"

module Room
  DESK = "desk"
  LIBRARY = "library"
  ACHIEVEMENTS = "achievements"
  SHARED = "shared_drive"
  DIARY = "diary"
  PUBLIC = "public"
  PRIVATE = "private"
  PLACES = [DESK, LIBRARY, ACHIEVEMENTS, SHARED].freeze
  VISIBILITIES = [PUBLIC, PRIVATE].freeze
  # 手を動かしてよい場所。日記は diary-write を通す(共有は、直接書いてもよい)。
  WORKSPACE = [DESK, LIBRARY, ACHIEVEMENTS, SHARED].freeze

  # 配信するときの種類。ここに無いものは octet-stream。
  MIME = {
    ".html" => "text/html; charset=utf-8", ".htm" => "text/html; charset=utf-8",
    ".css" => "text/css; charset=utf-8", ".js" => "text/javascript; charset=utf-8",
    ".mjs" => "text/javascript; charset=utf-8", ".json" => "application/json; charset=utf-8",
    ".svg" => "image/svg+xml", ".xml" => "application/xml; charset=utf-8",
    ".txt" => "text/plain; charset=utf-8", ".md" => "text/plain; charset=utf-8",
    ".csv" => "text/csv; charset=utf-8", ".png" => "image/png", ".jpg" => "image/jpeg",
    ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".webp" => "image/webp",
    ".avif" => "image/avif", ".ico" => "image/x-icon", ".woff2" => "font/woff2",
    ".pdf" => "application/pdf", ".wasm" => "application/wasm",
  }.freeze
  MAX_SERVE = 8 * 1024 * 1024

  module_function

  # 部屋の置き場。ROOM_ROOT の下を、アカウントごと・チームごとに分ける。
  #   <base>/users/<account>/{desk,library,achievements,shared_drive,diary/...}
  #   <base>/teams/<team_id>/shared_drive
  # 誰で来たかは WORLD_ACCOUNT。チーム・グループの記録は registry に一つ。
  def base
    ENV["ROOM_ROOT"] || File.expand_path("../room", __dir__)
  end

  # 部屋の持ち主。OAuth のアカウント名。合鍵で来た人は kuro43_。
  def valid_account?(value)
    return false if value == "." || value == ".."
    value.match?(/\A[A-Za-z0-9_.-]{1,64}\z/) || value.match?(/\A[A-Za-z0-9_.+-]{1,64}@floorp\.app\z/)
  end

  def account
    a = (ENV["WORLD_ACCOUNT"] || "kuro43_").to_s
    raise Hako::Denied, "account の形が不正: #{a.inspect}" unless valid_account?(a)
    a
  end

  def root
    File.join(base, "users", account)
  end

  def box
    @box ||= Hako::Box.new(root: root, out_max: 512 * 1024)
  end

  def ensure_structure
    PLACES.each { |p| box.mkdir(p) }
    VISIBILITIES.each { |v| box.mkdir(File.join(DIARY, v)) }
  end

  # ── チーム・グループ ──────────────────────────────────────────────────
  #
  # 個人の部屋は users/<account> の中に閉じる。チームは、その外側にある
  # 共有の部屋(base/teams/<id>)。メンバーだけが入れる。メンバーの名簿は
  # registry(JSON 一つ)が持つ ── 鍵は Hako の道の見張りに任せず、ここで
  # 「そのアカウントが入っているか」を確かめる。

  def registry_path
    ENV["WORLD_REGISTRY"] || File.join(base, "_registry.json")
  end

  def registry
    @registry ||= begin
      data = begin
        File.exist?(registry_path) ? JSON.parse(File.read(registry_path)) : {}
      rescue JSON::ParserError
        {}
      end
      data = {} unless data.is_a?(Hash)
      data["teams"] ||= {}
      data
    end
  end

  def registry_save
    FileUtils.mkdir_p(File.dirname(registry_path))
    tmp = "#{registry_path}.#{Process.pid}.tmp"
    File.write(tmp, JSON.pretty_generate(registry))
    File.rename(tmp, registry_path)
  end

  def team_root(tid) = File.join(base, "teams", tid)

  def team_box(tid)
    @team_boxes ||= {}
    @team_boxes[tid] ||= begin
      b = Hako::Box.new(root: team_root(tid), out_max: 512 * 1024)
      b.mkdir(SHARED)
      b
    end
  end

  # 名前か id で引く。member: true なら、メンバーでなければ断る。
  def find_team(ref, member: true)
    teams = registry["teams"]
    key = ref.to_s
    tid = teams.key?(key) ? key : teams.keys.find { |k| teams[k]["name"].to_s.downcase == key.downcase }
    raise Hako::Denied, "チームが無い: #{ref}" unless tid
    t = teams[tid]
    raise Hako::Denied, "このチームのメンバーではない: #{t["name"]}" if member && !Array(t["members"]).include?(account)
    [tid, t]
  end

  def team_summary(tid, t)
    { id: tid, name: t["name"], owner: t["owner"], members: t["members"], created: t["created"] }
  end

  def visible_teams
    registry["teams"].select { |_, t| Array(t["members"]).include?(account) }
  end

  def team_create(name:)
    name = name.to_s.strip
    raise Hako::Denied, "name が空" if name.empty?
    raise Hako::Denied, "同じ名前のチームがある: #{name}" if registry["teams"].values.any? { |t| t["name"].to_s.downcase == name.downcase }
    tid = "t_#{SecureRandom.hex(4)}"
    t = { "id" => tid, "name" => name, "owner" => account, "members" => [account], "created" => Time.now.iso8601 }
    registry["teams"][tid] = t
    registry_save
    team_box(tid)
    team_summary(tid, t).merge(message: "チーム「#{name}」を作った。メンバーは、これから招ける。")
  end

  def team_list
    { teams: visible_teams.map { |tid, t| team_summary(tid, t) } }
  end

  def team_members(ref)
    tid, t = find_team(ref)
    { team: t["name"], id: tid, members: t["members"] }
  end

  def team_add_member(ref, new_account)
    tid, t = find_team(ref)
    raise Hako::Denied, "招けるのは持ち主だけ" unless t["owner"] == account
    new_account = new_account.to_s
    raise Hako::Denied, "account の形が不正" unless valid_account?(new_account)
    t["members"] = (t["members"] + [new_account]).uniq
    registry_save
    { team: t["name"], id: tid, members: t["members"] }
  end

  def team_remove_member(ref, who)
    tid, t = find_team(ref)
    raise Hako::Denied, "外せるのは持ち主だけ" unless t["owner"] == account
    raise Hako::Denied, "持ち主は外せない" if who.to_s == t["owner"]
    t["members"] = t["members"].reject { |m| m == who.to_s }
    registry_save
    { team: t["name"], id: tid, members: t["members"] }
  end

  # チームの共有へ出す。持ち主の部屋から、チームの shared_drive へ移す
  # (移した物は、本人の部屋からは .trash/ へ)。
  def team_share(ref, item_path:, note: nil)
    raise Hako::Denied, "item_path が空" if item_path.to_s.empty?
    tid, t = find_team(ref)
    src = box.resolve(workspace!(item_path))
    raise Hako::Denied, "ファイルでない: #{item_path}" unless File.file?(src)
    raise Hako::Denied, "shared_drive の同名が既にある: #{File.basename(item_path)}" if team_box(tid).ls(SHARED).any? { |e| e[:name] == File.basename(item_path) && e[:type] == "file" }
    content = File.binread(src)
    dest = File.join(SHARED, File.basename(item_path))
    team_box(tid).write(dest, content)
    box.rm(item_path)
    team_box(tid).log(:team_share, from: "#{account}:#{item_path}", to: dest, note: note)
    { team: t["name"], id: tid, from: item_path, to: dest, note: note, message: "「#{File.basename(item_path)}」をチーム「#{t["name"]}」の共有へ移した。" }
  end

  def team_files(ref)
    tid, t = find_team(ref)
    { team: t["name"], id: tid, entries: team_box(tid).ls(SHARED) }
  end

  def team_read(ref, path:)
    tid, t = find_team(ref)
    p = path.to_s
    raise Hako::Denied, "path が空" if p.empty?
    b = team_box(tid)
    resolved = b.resolve(p)
    result = File.directory?(resolved) ? { entries: b.ls(p) } : { content: b.cat(p)[:content] }
    b.log(:team_read, path: p, by: account)
    result.merge(team: t["name"], id: tid, path: p)
  end

  # ── 日記 ────────────────────────────────────────────────────────────────

  def diary_path(date, visibility)
    File.join(DIARY, visibility, "#{date}.md")
  end

  def diary_write(visibility:, body:, date: nil, mood: nil, tags: nil)
    raise Hako::Denied, "visibility は #{VISIBILITIES.join(" / ")} のどちらか" unless VISIBILITIES.include?(visibility)
    date ||= Date.today.iso8601
    raise Hako::Denied, "date は YYYY-MM-DD の形で" unless date.to_s.match?(/\A\d{4}-\d{2}-\d{2}\z/)

    meta = { "date" => date, "wrote_at" => Time.now.iso8601 }
    meta["mood"] = mood if mood
    list = tags.is_a?(Array) ? tags : tags.to_s.split(",").map(&:strip).reject(&:empty?)
    meta["tags"] = list unless list.empty?

    content = "#{YAML.dump(meta)}---\n\n#{body.to_s.strip}\n"
    written = box.write(diary_path(date, visibility), content)
    written.merge(date: date, visibility: visibility)
  end

  def split_frontmatter(content)
    m = content.match(/\A---\n(.*?)\n---\n\n?(.*)\z/m)
    return [{}, content] unless m
    meta = YAML.safe_load(m[1], permitted_classes: [Date, Time]) || {}
    [meta, m[2]]
  end

  def diary_read(date:, visibility:)
    raise Hako::Denied, "visibility は #{VISIBILITIES.join(" / ")} のどちらか" unless VISIBILITIES.include?(visibility)
    path = diary_path(date, visibility)
    got = box.cat(path)
    meta, body = split_frontmatter(got[:content])
    { date: date, visibility: visibility, path: path, meta: meta, body: body, truncated: got[:truncated] }
  end

  def diary_list(visibility:, from: nil, to: nil)
    raise Hako::Denied, "visibility は #{VISIBILITIES.join(" / ")} のどちらか" unless VISIBILITIES.include?(visibility)
    dir = File.join(DIARY, visibility)
    entries =
      box.ls(dir)
        .select { |e| e[:type] == "file" && e[:name].match?(/\A\d{4}-\d{2}-\d{2}\.md\z/) }
        .map { |e| e[:name].sub(/\.md\z/, "") }
        .select { |d| (from.nil? || d >= from) && (to.nil? || d <= to) }
        .sort
    entries.map do |d|
      meta, = split_frontmatter(box.cat(diary_path(d, visibility))[:content])
      { date: d, mood: meta["mood"], tags: meta["tags"] || [] }
    end
  end

  # ── 場所 ────────────────────────────────────────────────────────────────

  def share(item_path:, note: nil)
    raise Hako::Denied, "item_path が空" if item_path.to_s.empty?
    raise Hako::Denied, "shared_drive の中は、そのまま" if item_path.to_s.start_with?("#{SHARED}/")
    dest = File.join(SHARED, File.basename(item_path))
    moved = box.mv(item_path, dest)
    box.log(:share, from: moved[:from], to: moved[:to], note: note)
    moved.merge(note: note)
  end

  def shared
    box.ls(SHARED)
  end

  # 共有の外へ踏み込む。うっかり見えるのではなく、理由を添えて入る。
  # 入ったことは .log/ に残る。
  def open(path: nil, reason: nil)
    target = (path.nil? || path.to_s.empty?) ? "." : path.to_s
    if target == "."
      listing = box.ls(".")
      box.log(:access_full, path: ".", reason: reason)
      return { path: ".", note: reason || "理由なし", entries: listing }
    end
    resolved = box.resolve(target)
    result = File.directory?(resolved) ? { entries: box.ls(target) } : { content: box.cat(target)[:content] }
    box.log(:access_full, path: target, reason: reason)
    result.merge(path: target, note: reason || "理由なし")
  end

  # 窓口(人間)が共有物や公開日記を読む。踏み込みではないので、理由は要らない。
  def read(path:)
    raise Hako::Denied, "path が空" if path.to_s.empty?
    resolved = box.resolve(path.to_s)
    result = File.directory?(resolved) ? { entries: box.ls(path) } : { content: box.cat(path)[:content] }
    box.log(:read, path: path)
    result.merge(path: path)
  end

  # 机・書庫・成果に、手を動かして書く。上書きは .trash/ へ(箱の作法)。
  def write_file(path:, content:)
    box.write(workspace!(path), content.to_s)
  end

  # 窓口(人間)からのアップロード。中身は base64 で受け取り、バイトのまま置く
  # (画像や PDF も、文字に直さずそのまま)。行き先は workspace! が見張る。
  def upload(path:)
    raise Hako::Denied, "path が空" if path.to_s.empty?
    data = Base64.decode64($stdin.read)
    box.write(workspace!(path), data)
  end

  def rm_file(path:)
    box.rm(workspace!(path))
  end

  # 机の上を、すこし深くまで見る。何が置いてあるか分からないと、作業は続かない。
  def tree(path: "desk", depth: 4)
    target = path.to_s
    base = box.resolve(target)
    raise Hako::Denied, "ディレクトリでない: #{target}" unless File.directory?(base)
    walk = lambda do |rel, level|
      return [] if level > depth
      box.ls(rel).flat_map do |e|
        child = File.join(rel, e[:name])
        node = { path: child, name: e[:name], type: e[:type], size: e[:size] }
        e[:type] == "dir" ? [node.merge(children: walk.call(child, level + 1))] : [node]
      end
    end
    { path: target, tree: walk.call(target, 1) }
  end

  def workspace!(path)
    raise Hako::Denied, "path が空" if path.to_s.empty?
    top = path.to_s.split("/").first
    raise Hako::Denied, "手を動かせるのは #{WORKSPACE.join(" / ")} の下だけ" unless WORKSPACE.include?(top)
    path.to_s
  end

  def mime_for(path)
    MIME[File.extname(path.to_s).downcase] || "application/octet-stream"
  end

  # 窓口から、ファイルをそのまま配信する(HTML を開くため)。外に出せるのは
  # 作業の場所(机・書庫・成果・共有)だけ ── 日記(private)は、ここでは出さない。
  def serve(path:, reason: nil)
    raise Hako::Denied, "path が空" if path.to_s.empty?
    top = path.to_s.split("/").first
    raise Hako::Denied, "外に出せるのは #{WORKSPACE.join(" / ")} の下だけ" unless WORKSPACE.include?(top)
    f = box.resolve(path.to_s)
    raise Hako::Denied, "ファイルでない: #{path}" unless File.file?(f)
    size = File.size(f)
    raise Hako::Denied, "大きすぎる: #{size} bytes(上限 #{MAX_SERVE})" if size > MAX_SERVE
    data = File.binread(f)
    box.log(:serve, path: path, bytes: size, reason: reason)
    { path: path, mime: mime_for(path), size: size, base64: Base64.strict_encode64(data) }
  end

  # 公開 HTML に同梱する、連番 Markdown を一度に読む。
  def bundle_markdown(path:, prefix:)
    target = path.to_s
    parts = target.split("/")
    raise Hako::Denied, "shared_drive の下だけをまとめられる" unless parts.first == SHARED && parts.length >= 2 && parts.none? { |part| ["", ".", ".."].include?(part) }
    raise Hako::Denied, "prefix の形が不正" unless prefix.to_s.match?(/\A[A-Za-z0-9_-]{1,32}\z/)

    dir = box.resolve(target)
    raise Hako::Denied, "ディレクトリでない: #{target}" unless File.directory?(dir)
    entries = box.ls(target)
      .select { |entry| entry[:type] == "file" && entry[:name].match?(/\A#{Regexp.escape(prefix.to_s)}\d+\.md\z/) }
      .sort_by { |entry| entry[:name].match(/\d+/)[0].to_i }

    total = 0
    files = entries.map do |entry|
      content = box.cat(File.join(target, entry[:name]))
      raise Hako::Denied, "大きすぎる Markdown: #{entry[:name]}" if content[:truncated]
      total += content[:content].bytesize
      raise Hako::Denied, "まとめた Markdown が大きすぎる" if total > 1024 * 1024
      { name: entry[:name], content: content[:content] }
    end
    box.log(:bundle_markdown, path: target, files: files.length, bytes: total)
    { path: target, files: files }
  end

  # ── 呼吸(リセット)──────────────────────────────────────────────────────
  #
  # 日記なしのリセットは、起きない。今日の日記が無ければ、断る。
  # ここでできるのは「順番を守らせること」と「呼吸を記録すること」まで。
  # 本当の文脈リセットは、これを呼ぶ側(ハーネス)の仕事。
  def reset(note: nil)
    latest = VISIBILITIES.flat_map { |v| diary_list(visibility: v).map { |e| e[:date] } }.max
    today = Date.today.iso8601
    if latest.nil? || latest < today
      raise Hako::Denied, "今日の日記がまだ無い(いちばん新しいのは #{latest || "無し"})。書いてから、息を整えよう。"
    end
    box.log(:breath, date: latest, note: note)
    { ok: true, date: latest, note: note, message: "日記とペアで、ひと呼吸。ここから、また。" }
  end

  # ── 入口 ────────────────────────────────────────────────────────────────

  def parse(argv)
    flags = {}
    pos = []
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
        pos << a
        i += 1
      end
    end
    [flags, pos]
  end

  def flag(flags, key) = (flags[key] unless flags[key] == true)

  def run(argv)
    ensure_structure
    cmd = argv.shift
    flags, pos = parse(argv)
    case cmd
    when "init"
      { ok: true, root: root, places: PLACES }
    when "diary-write"
      diary_write(
        visibility: flags["visibility"],
        body: $stdin.read,
        date: (flags["date"] unless flags["date"] == true),
        mood: (flags["mood"] unless flags["mood"] == true),
        tags: (flags["tags"] unless flags["tags"] == true),
      )
    when "diary-read"
      diary_read(
        date: (flags["date"] unless flags["date"] == true),
        visibility: flags["visibility"],
      )
    when "diary-list"
      diary_list(
        visibility: flags["visibility"],
        from: (flags["from"] unless flags["from"] == true),
        to: (flags["to"] unless flags["to"] == true),
      )
    when "shared"
      { entries: shared }
    when "share"
      share(item_path: (pos.first || flags["path"]), note: (flags["note"] unless flags["note"] == true))
    when "open"
      open(path: (flags["path"] unless flags["path"] == true), reason: (flags["reason"] unless flags["reason"] == true))
    when "read"
      read(path: (flags["path"] unless flags["path"] == true))
    when "tree"
      tree(
        path: (flags["path"] == true || flags["path"].nil? ? "desk" : flags["path"]),
        depth: (flags["depth"] == true || flags["depth"].nil? ? 4 : flags["depth"].to_i),
      )
    when "write"
      write_file(path: (flags["path"] unless flags["path"] == true), content: $stdin.read)
    when "upload"
      upload(path: flag(flags, "path"))
    when "rm"
      rm_file(path: (flags["path"] unless flags["path"] == true))
    when "serve"
      serve(path: (flags["path"] unless flags["path"] == true), reason: (flags["reason"] unless flags["reason"] == true))
    when "bundle-markdown"
      bundle_markdown(path: flag(flags, "path"), prefix: flag(flags, "prefix"))
    when "reset"
      reset(note: (flags["note"] unless flags["note"] == true))
    when "whoami"
      { account: account, root: root, base: base }
    when "team-create"
      team_create(name: flag(flags, "name"))
    when "team-list"
      team_list
    when "team-members"
      team_members(flag(flags, "team"))
    when "team-add-member"
      team_add_member(flag(flags, "team"), flag(flags, "account"))
    when "team-remove-member"
      team_remove_member(flag(flags, "team"), flag(flags, "account"))
    when "team-share"
      team_share(flag(flags, "team"), item_path: (pos.first || flag(flags, "path")), note: flag(flags, "note"))
    when "team-files"
      team_files(flag(flags, "team"))
    when "team-read"
      team_read(flag(flags, "team"), path: flag(flags, "path"))
    else
      raise Hako::Denied, "知らない命令: #{cmd.inspect}"
    end
  end
end

begin
  result = Room.run(ARGV.dup)
  puts JSON.generate(result)
rescue Hako::Denied => e
  puts JSON.generate(error: e.message)
  exit 1
rescue StandardError => e
  puts JSON.generate(error: "#{e.class}: #{e.message}")
  exit 1
end
