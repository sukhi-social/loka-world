# frozen_string_literal: true
# hako(箱)。決まった root の下だけを見るファイルシステムと、その中だけで動くコンソール。
#
#   - 道は root の下しか通らない(.. も symlink も、外に出るものは断る)
#   - 消すときは消さない。.trash/ に移す(上書きも、前のものを .trash/ に残す)
#   - 容量の上限(quota)、一つのファイルの上限、読むときの上限
#   - コンソールは sandbox-exec で、root の外への書き込みと network を止める。
#     root の中でも unlink は止める(消せるのは hako の rm=ゴミ箱だけ)。時間と出力の上限、記録
#
# 依存は Ruby の標準ライブラリだけ。
require "fileutils"
require "digest"
require "json"
require "open3"
require "pathname"
require "rbconfig"
require "securerandom"
require "uri"
require_relative "runner_client"
require "time"
require "tempfile"
require "tmpdir"

module Hako
  class Denied < StandardError; end

  class Box
    TRASH = ".trash"
    LOG = ".log"
    MRUBY_MAX_CODE = 64 * 1024
    MRUBY_MAX_SCOPE = 16 * 1024 * 1024
    MRUBY_MAX_FILES = 512

    attr_reader :root, :quota, :file_max, :out_max, :timeout

    # job_delay は、ジョブの結果が見えるまでの「間」の倍率。0 で間なし。
    def initialize(root:, quota: 200 * 1024 * 1024, file_max: 8 * 1024 * 1024, out_max: 8 * 1024, timeout: 10,
                   job_delay: Float(ENV.fetch("WORLD_JOB_DELAY", "1")), runner_sock: ENV["WORLD_RUNNER_SOCK"])
      @root = File.realpath(File.expand_path(root)) rescue (FileUtils.mkdir_p(File.expand_path(root)); File.realpath(File.expand_path(root)))
      FileUtils.mkdir_p(File.join(@root, TRASH))
      FileUtils.mkdir_p(File.join(@root, LOG))
      @quota, @file_max, @out_max, @timeout, @job_delay = quota, file_max, out_max, timeout, job_delay
      @runner = Runner.new(runner_sock)
    end

    # --- 道

    # root の下の道に直す。無い道でも、いちばん近い在る親で本当の場所を確かめる。
    def resolve(rel, allow_hidden: false)
      raise Denied, "道が空" if rel.nil? || rel.to_s.empty?
      p = Pathname.new(rel.to_s)
      raise Denied, "絶対の道は使わない: #{rel}" if p.absolute?
      joined = File.expand_path(rel.to_s, @root)
      existing = joined
      existing = File.dirname(existing) until File.exist?(existing)
      real = File.realpath(existing) + joined[existing.length..]
      unless real == @root || real.start_with?(@root + "/")
        raise Denied, "箱の外: #{rel}"
      end
      inner = real[@root.length..].to_s
      if !allow_hidden && (inner.start_with?("/#{TRASH}") || inner.start_with?("/#{LOG}"))
        raise Denied, "そこは触らない: #{rel}"
      end
      real
    end

    def rel(abs)
      abs == @root ? "." : abs[(@root.length + 1)..]
    end

    # --- 見る

    def ls(rel_path = ".")
      dir = resolve(rel_path)
      raise Denied, "ディレクトリでない: #{rel_path}" unless File.directory?(dir)
      Dir.children(dir).sort.reject { |n| dir == @root && [TRASH, LOG].include?(n) }.map do |n|
        f = File.join(dir, n)
        st = File.lstat(f)
        { name: n, type: st.symlink? ? "link" : st.directory? ? "dir" : "file", size: st.size, mtime: st.mtime.iso8601 }
      end
    end

    def cat(rel_path, max: nil)
      f = resolve(rel_path)
      raise Denied, "ファイルでない: #{rel_path}" unless File.file?(f)
      max ||= @out_max
      data = File.binread(f, max + 1)
      truncated = data.bytesize > max
      { content: (truncated ? data.byteslice(0, max) : data).force_encoding("UTF-8").scrub, truncated: truncated, size: File.size(f) }
    end

    def usage
      total = 0
      Dir.glob(File.join(@root, "**", "*"), File::FNM_DOTMATCH) { |f| total += File.size(f) if File.file?(f) }
      total
    end

    # --- 書く

    def write(rel_path, content)
      with_mutation_lock do
        write_unlocked(rel_path, content)
      end
    end

    def mkdir(rel_path)
      with_mutation_lock do
        d = resolve(rel_path)
        FileUtils.mkdir_p(d)
        log(:mkdir, path: rel(d))
        { path: rel(d) }
      end
    end

    def mv(from, to)
      with_mutation_lock do
        a = resolve(from); b = resolve(to)
        raise Denied, "無い: #{from}" unless File.exist?(a)
        raise Denied, "もうある: #{to}" if File.exist?(b)
        FileUtils.mkdir_p(File.dirname(b))
        File.rename(a, b)
        log(:mv, from: rel(a), to: rel(b))
        { from: rel(a), to: rel(b) }
      end
    end

    # 消さない。.trash/ に移す。
    def rm(rel_path)
      with_mutation_lock do
        rm_unlocked(rel_path)
      end
    end

    # --- 走らせる

    SANDBOX = <<~'PROFILE'
      (version 1)
      (deny default)
      (allow process-exec*)
      (allow process-fork)
      (allow signal)
      (allow sysctl-read)
      (allow mach-lookup)
      (allow ipc-posix-shm)
      (allow file-read*)
      (allow file-write* (subpath "%ROOT%"))
      (deny file-write* (subpath "%ROOT%/.trash") (subpath "%ROOT%/.log"))
      (deny file-write-unlink (subpath "%ROOT%"))
      (allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev"))
      (deny network*)
    PROFILE
    # 立てる(serve)ときだけ、その一つの port で待つことを許す。外へ出るのは変わらず止める
    SERVE = <<~'PROFILE'
      (allow network-bind (local ip "localhost:%PORT%"))
      (allow network-inbound (local ip "localhost:%PORT%"))
    PROFILE

    # argv(配列)か、文字列なら sh -c。cwd は root の中。時間と出力に上限。
    def run(cmd, cwd: ".", timeout: nil)
      timeout ||= @timeout
      dir = resolve(cwd)
      argv = cmd.is_a?(Array) ? cmd : ["/bin/sh", "-c", cmd.to_s]
      raise Denied, "空の命令" if argv.empty?
      profile = SANDBOX.gsub("%ROOT%", @root)
      env = { "PATH" => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME" => @root, "TMPDIR" => "/private/tmp", "LANG" => "ja_JP.UTF-8", "TERM" => "dumb" }
      out = +""; err = +""; status = nil; timed_out = false
      t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      Open3.popen3(env, "/usr/bin/sandbox-exec", "-p", profile, *argv, chdir: dir, unsetenv_others: true, pgroup: true) do |i, o, e, wait|
        i.close
        readers = { o => out, e => err }
        deadline = t0 + timeout
        until readers.empty?
          left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          if left <= 0
            timed_out = true
            begin Process.kill("-TERM", wait.pid); rescue Errno::ESRCH; end
            sleep 0.2
            begin Process.kill("-KILL", wait.pid); rescue Errno::ESRCH; end
            break
          end
          ready, = IO.select(readers.keys, nil, nil, left)
          (ready || []).each do |io|
            chunk = io.read_nonblock(4096, exception: false)
            if chunk.nil? || chunk == :wait_readable
              readers.delete(io) if chunk.nil?
              next
            end
            buf = readers[io]
            buf << chunk if buf.bytesize < @out_max * 2
          end
        end
        status = wait.value
      end
      trunc = ->(s) { s.bytesize > @out_max ? s.byteslice(0, @out_max).force_encoding("UTF-8").scrub + "\n…(あと #{s.bytesize - @out_max} バイト)" : s.force_encoding("UTF-8").scrub }
      took = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0).round(2)
      r = { cmd: argv, cwd: rel(dir), status: status&.exitstatus, timed_out: timed_out, took: took, out: trunc.(out), err: trunc.(err) }
      log(:run, cmd: argv, cwd: rel(dir), status: r[:status], timed_out: timed_out, took: took)
      r
    end

    # Run mruby against a bounded copy of selected paths. Only successful changes
    # are written back, through the box's trash-preserving write/remove methods.
    def run_mruby_shell(code, paths:, cwd: ".", timeout: nil)
      code = code.to_s
      raise Denied, "mruby code が空" if code.empty?
      raise Denied, "mruby code が大きすぎる" if code.bytesize > MRUBY_MAX_CODE

      scopes = Array(paths).map { |path| clean_relative_path(path) }.uniq
      raise Denied, "paths が空" if scopes.empty?
      raise Denied, "paths は8個まで" if scopes.length > 8
      scopes.combination(2) do |a, b|
        if a == b || a.start_with?("#{b}/") || b.start_with?("#{a}/")
          raise Denied, "paths が重なっている: #{a} / #{b}"
        end
      end
      scopes.each { |path| reject_symlink_path!(path) }

      cwd = clean_relative_path(cwd, allow_dot: true)
      timeout ||= @timeout
      Dir.mktmpdir("hako-mruby-") do |workspace|
        workspace = File.realpath(workspace)
        before = {}
        before_dirs = []
        limits = { bytes: 0, files: 0 }
        with_mutation_lock do
          scopes.each do |path|
            source = resolve(path, allow_hidden: path == TRASH || path.start_with?("#{TRASH}/"))
            copy_entry(source, path, File.join(workspace, path), before, before_dirs, limits)
          end
        end

        run_cwd = File.join(workspace, cwd)
        raise Denied, "cwd がコピーされた部屋の中にない: #{cwd}" unless File.directory?(run_cwd)
        FileUtils.mkdir_p(File.join(workspace, "tmp"))
        result = execute_mruby(code, workspace, cwd, timeout, scopes)
        result[:changed] = []
        result[:removed] = []
        result[:removed_dirs] = []
        unless result[:status] == 0 && !result[:timed_out]
          log(:mruby, paths: scopes, cwd: cwd, status: result[:status], timed_out: result[:timed_out], committed: false)
          return result
        end

        after = {}
        after_dirs = []
        limits = { bytes: 0, files: 0 }
        scopes.each do |path|
          collect_entry(File.join(workspace, path), path, after, after_dirs, limits)
        end
        changed = after.keys.select { |path| before[path] != after[path] }.sort
        removed = (before.keys - after.keys).sort
        removed_dirs = (before_dirs - after_dirs).sort_by { |path| -path.count("/") }
        begin
          commit_mruby_changes(before, before_dirs, after, changed, removed, removed_dirs)
        rescue Denied => e
          log(:mruby, paths: scopes, cwd: cwd, status: result[:status], committed: false, error: e.message)
          raise
        end
        result[:changed] = changed
        result[:removed] = removed
        result[:removed_dirs] = removed_dirs
        log(:mruby, paths: scopes, cwd: cwd, status: result[:status], timed_out: false, changed: changed, removed: removed, removed_dirs: removed_dirs, committed: true)
        result
      end
    end

# --- 立てる(サーバを一つ、箱の中で、127.0.0.1:port で待たせる。止めるまで生きている)

    SERVE_FILE = "serve.json"

    def serve(cmd, port:, cwd: ".")
      raise Denied, "port は 1024〜65535: #{port}" unless (1024..65535).cover?(port.to_i)
      stop if serving[:alive]
      dir = resolve(cwd)
      argv = cmd.is_a?(Array) ? cmd : ["/bin/sh", "-c", cmd.to_s]
      raise Denied, "空の命令" if argv.empty?
      profile = (SANDBOX + SERVE).gsub("%ROOT%", @root).gsub("%PORT%", port.to_i.to_s)
      env = { "PATH" => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME" => @root, "TMPDIR" => "/private/tmp", "LANG" => "ja_JP.UTF-8", "TERM" => "dumb", "PORT" => port.to_i.to_s }
      out = File.open(File.join(@root, LOG, "serve-#{port}.log"), "a")
      pid = Process.spawn(env, "/usr/bin/sandbox-exec", "-p", profile, *argv, chdir: dir, unsetenv_others: true, pgroup: true, in: :close, out: out, err: out)
      out.close
      Process.detach(pid)
      rec = { cmd: argv, cwd: rel(dir), port: port.to_i, pid: pid, at: Time.now.iso8601 }
      File.write(File.join(@root, LOG, SERVE_FILE), JSON.generate(rec))
      log(:serve, **rec)
      rec.merge(alive: true)
    end

    # いま立っているもの。無ければ { alive: false }
    def serving
      f = File.join(@root, LOG, SERVE_FILE)
      return { alive: false } unless File.exist?(f)
      rec = JSON.parse(File.read(f), symbolize_names: true)
      alive = begin Process.kill(0, -rec[:pid]); true; rescue Errno::ESRCH; false; rescue Errno::EPERM; true; end
      rec.merge(alive: alive, log: File.join(LOG, "serve-#{rec[:port]}.log"))
    end

    def stop
      s = serving
      return { stopped: false } unless s[:alive]
      begin Process.kill("-TERM", s[:pid]); rescue Errno::ESRCH; end
      sleep 0.3
      begin Process.kill("-KILL", s[:pid]); rescue Errno::ESRCH; end
      File.delete(File.join(@root, LOG, SERVE_FILE))
      log(:stop, port: s[:port], pid: s[:pid])
      { stopped: true, port: s[:port] }
    end

# --- ジョブ(長い処理を裏で走らせて、あとで見に来る)
    #
    # mruby の 10 秒とは別の道。プロジェクトの directory の中だけを書ける sandbox で、
    # シェルの命令を走らせる。呼び出しはすぐ返り、状態と出力は job_status で読む。
    # 走らせるのは directory そのもの(copy ではない)なので、node_modules や build 結果が残る。
    # そのかわり、中で消したものは .trash/ に残らない。大事なものは git に。

    JOBS = "jobs"
    JOB_ID = /\A\d{8}-\d{6}-[0-9a-f]{4}\z/
    JOB_MAX_RUNNING = 2
    JOB_DEFAULT_MINUTES = 30
    JOB_MAX_MINUTES = 240
    JOB_MAX_CMD = 16 * 1024
    JOB_LOG_MAX = 8 * 1024 * 1024
    RUNNER_MAX_TAR = 256 * 1024 * 1024

    # network: none(既定)か registries(npm・PyPI・GitHub・Julia・JSR だけ。runner の箱のとき)。
    def job_start(cmd, cwd:, minutes: nil, network: "none", memory: "1g")
      cmd = cmd.to_s
      network = network.to_s
      raise Denied, "network は none か registries" unless %w[none registries].include?(network)
      memory = memory.to_s
      raise Denied, "memory は 1g か 2g" unless %w[1g 2g].include?(memory)
      raise Denied, "命令が空" if cmd.strip.empty?
      raise Denied, "命令が大きすぎる" if cmd.bytesize > JOB_MAX_CMD
      minutes = (minutes || JOB_DEFAULT_MINUTES).to_i
      raise Denied, "minutes は 1〜#{JOB_MAX_MINUTES}" unless (1..JOB_MAX_MINUTES).cover?(minutes)

      cwd = clean_relative_path(cwd)
      reject_symlink_path!(cwd)
      dir = resolve(cwd)
      raise Denied, "ディレクトリでない: #{cwd}" unless File.directory?(dir)
      if job_list.count { |j| j[:state] == "running" } >= JOB_MAX_RUNNING
        raise Denied, "走っているジョブが#{JOB_MAX_RUNNING}つある。終わるのを待つか、stop してから。"
      end

      return remote_job_start(cmd, dir, minutes, network, memory) if @runner.available?
      raise Denied, "registries は runner の箱でだけ使える" if network != "none"

      sandbox, = mruby_sandbox(dir, ".", shell: true)
      id = Time.now.strftime("%Y%m%d-%H%M%S-") + SecureRandom.hex(2)
      jobdir = File.join(@root, LOG, JOBS, id)
      FileUtils.mkdir_p(jobdir)
      linux = RUBY_PLATFORM.include?("linux")
      seconds = minutes * 60
      spec = {
        cmd: cmd, cwd: dir, sandbox: sandbox, seconds: seconds, cpu_seconds: seconds + 60,
        fsize: 512 * 1024 * 1024, log_max: JOB_LOG_MAX,
        env: {
          PATH: linux ? "/usr/local/bin:/usr/bin:/bin" : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          HOME: dir, TMPDIR: File.join(dir, ".loka-tmp"), LANG: "C.UTF-8", TERM: "dumb", CI: "1", NO_COLOR: "1"
        },
      }
      File.write(File.join(jobdir, "spec.json"), JSON.generate(spec))
      meta = { id: id, cmd: cmd, cwd: rel(dir), state: "running", started_at: Time.now.iso8601, minutes: minutes }
      File.write(File.join(jobdir, "meta.json"), JSON.generate(meta))
      File.write(File.join(jobdir, "out.log"), "")
      runner = File.expand_path("job_runner.rb", __dir__)
      pid = Process.spawn(RbConfig.ruby, runner, File.join(jobdir, "spec.json"),
                          pgroup: true, in: File::NULL, out: File::NULL, err: File.join(jobdir, "runner.err"))
      Process.detach(pid)
      File.write(File.join(jobdir, "meta.json"), JSON.generate(meta.merge(supervisor_pid: pid)))
      log(:job_start, id: id, cmd: cmd, cwd: rel(dir), minutes: minutes)
      job_status(id, tail: 0).merge(started: true)
    end

    # 状態と、出力のつづき。since(バイト位置)を渡すと、そこから先だけ返す。
    #
    # 結果は、わざと少し遅れて見える。走っているあいだは出力を伏せ、終わっても
    # 「終わってしばらく」(走った時間の1/4。5〜120秒)は中身を見せない。
    # 一手ずつ覗くより、if で分岐して先の手まで書いた script にしてもらうための間。
    def job_status(id, since: nil, tail: 8192)
      meta = job_meta(id)
      jobdir = job_dir(id)
      meta = refresh_remote_job(id, meta) if meta[:remote] && meta[:state] == "running"
      if meta[:state] == "running" && !meta[:remote] && !pid_alive?(meta[:supervisor_pid])
        meta = job_meta(id) # 見張り役が、ちょうど書き終えたところかもしれない
        meta = meta.merge(state: "lost", note: "見張り役がいなくなった。出力は残っている。") if meta[:state] == "running"
      end
      path = File.join(jobdir, "out.log")
      size = File.size(path)
      meta[:elapsed] = (Time.now - Time.parse(meta[:started_at])).round(1) if meta[:state] == "running"

      wait = job_reveal_wait(meta)
      if wait > 0
        shown = meta.slice(:id, :cmd, :cwd, :started_at, :minutes, :elapsed)
        return shown.merge(
          state: meta[:state] == "running" ? "running" : "settling",
          log_bytes: size, next_check_in: wait.ceil,
          hint: job_hint(meta[:state] == "running")
        )
      end

      from = since ? [since.to_i, size].min : [size - tail, 0].max
      out = File.binread(path, [size - from, @out_max].min, from).to_s.force_encoding("UTF-8").scrub
      meta.merge(out: out, offset: from, next_offset: from + out.bytesize, log_bytes: size)
    end

    def job_hint(running)
      (running ? "走っているあいだは、中身は見えない。" : "終わったところ。結果は、すこし置いてから見える。") +
        "待つあいだに、次の手を if で書いておく(例: `make test && echo PASS || { echo FAIL; tail -30 test.log; }`)。" \
        "先を読んだ script を、もう一つのジョブにしてもいい。覗きに来る回数は、すくないほうがいい。"
    end

    # 見えるまでの残り秒。0 なら、もう見える。
    def job_reveal_wait(meta)
      return 0 if @job_delay <= 0
      if meta[:state] == "running"
        return [[(meta[:elapsed] / 2).round, 15].max, 600].min * @job_delay
      end
      return 0 unless meta[:finished_at] && meta[:took]
      settle = [[meta[:took] / 4.0, 5].max, 120].min * @job_delay
      [Time.parse(meta[:finished_at]) + settle - Time.now, 0].max
    end

    def job_stop(id)
      meta = job_meta(id)
      return meta.merge(stopped: false, note: "もう終わっている") unless meta[:state] == "running"
      if meta[:remote]
        log(:job_stop, id: id)
        return @runner.json("POST", "/jobs/#{meta[:runner_id]}/stop").last.merge(id: id)
      end
      File.write(File.join(job_dir(id), "stop"), "")
      begin Process.kill("-TERM", meta[:child_pid]); rescue Errno::ESRCH, Errno::EPERM, TypeError; end
      log(:job_stop, id: id)
      { id: id, stopped: true }
    end

    def job_list(limit: 10)
      base = File.join(@root, LOG, JOBS)
      return [] unless File.directory?(base)
      Dir.children(base).grep(JOB_ID).sort.reverse.first(limit).map do |id|
        m = job_status(id, tail: 0)
        m.slice(:id, :cmd, :cwd, :state, :exit_status, :started_at, :finished_at, :took, :elapsed)
      end
    end

    # --- 記録

    def log(kind, **fields)
      f = File.join(@root, LOG, Time.now.strftime("%Y-%m-%d") + ".jsonl")
      File.open(f, "a") { |io| io.puts JSON.generate({ at: Time.now.iso8601, kind: kind }.merge(fields)) }
    end

    private

    def remote_job_start(cmd, dir, minutes, network, memory)
      id = Time.now.strftime("%Y%m%d-%H%M%S-") + SecureRandom.hex(2)
      jobdir = File.join(@root, LOG, JOBS, id)
      FileUtils.mkdir_p(jobdir)
      tar = File.join(jobdir, "in.tar")
      begin
        unless system("sh", "-c", 'find . \\( -type f -o -type d \\) -not -path "./.loka-tmp*" -print0 | tar --null --no-recursion -cf "$1" -T -',
                      "sh", tar, chdir: dir)
          raise Denied, "project をまとめられない"
        end
        raise Denied, "project が大きすぎる(#{File.size(tar)} > #{RUNNER_MAX_TAR})" if File.size(tar) > RUNNER_MAX_TAR
        query = URI.encode_www_form(cmd: cmd, minutes: minutes, network: network, memory: memory)
        status, res = @runner.json("POST", "/jobs?#{query}", body_path: tar)
        raise Denied, "runner: #{res[:error]}" unless status == 200
      rescue Runner::Unavailable => e
        FileUtils.rm_rf(jobdir)
        raise Denied, e.message
      rescue Denied
        FileUtils.rm_rf(jobdir)
        raise
      end
      File.delete(tar)
      meta = { id: id, cmd: cmd, cwd: rel(dir), state: "running", started_at: Time.now.iso8601, minutes: minutes,
               remote: true, runner_id: res[:id], network: network, memory: memory }
      File.write(File.join(jobdir, "meta.json"), JSON.generate(meta))
      File.write(File.join(jobdir, "out.log"), "")
      log(:job_start, id: id, cmd: cmd, cwd: rel(dir), minutes: minutes, network: network, runner: res[:id])
      job_status(id, tail: 0).merge(started: true)
    end

    # runner の側の様子を、こちらの meta と out.log に写す。終わっていたら、結果を project に戻す。
    def refresh_remote_job(id, meta)
      rid = meta[:runner_id]
      status, st = @runner.json("GET", "/jobs/#{rid}")
      if status == 404
        return write_job_meta(id, meta.merge(state: "lost", note: "runner にジョブが無い。", finished_at: Time.now.iso8601))
      end
      return meta unless status == 200

      pull_remote_log(id, rid)
      return meta if st[:state] == "running"

      with_mutation_lock do
        current = job_meta(id)
        return current unless current[:state] == "running"

        error = st[:error]
        if %w[done failed timed_out stopped].include?(st[:state])
          begin
            apply_remote_result(id, current, rid)
          rescue Denied, Runner::Unavailable => e
            error = "結果を project に戻せない: #{e.message}"
          end
        end
        final = current.merge(state: error && st[:state] == "done" ? "failed" : st[:state], exit_status: st[:exit_status],
                              took: st[:took], finished_at: Time.now.iso8601)
        final[:error] = error if error
        write_job_meta(id, final)
        @runner.request("DELETE", "/jobs/#{rid}") unless error
        final
      end
    rescue Runner::Unavailable => e
      meta.merge(note: "runner に届かない(あとでもう一度): #{e.message}")
    end

    def pull_remote_log(id, rid)
      path = File.join(job_dir(id), "out.log")
      loop do
        status, body = @runner.request("GET", "/jobs/#{rid}/log?since=#{File.size(path)}")
        break unless status == 200 && !body.empty? && File.size(path) < JOB_LOG_MAX
        File.binwrite(path, body, mode: "ab")
      end
    end

    def apply_remote_result(id, meta, rid)
      tar = File.join(job_dir(id), "result.tar")
      status, = @runner.request("GET", "/jobs/#{rid}/result", out_path: tar)
      raise Denied, "結果を受け取れない(#{status})" unless status == 200
      verify_result_tar!(tar)
      reject_symlink_path!(meta[:cwd])
      dir = resolve(meta[:cwd])
      raise Denied, "project が無い" unless File.directory?(dir)
      unless system("tar", "-xf", tar, "-C", dir, "--no-same-owner")
        raise Denied, "結果を展開できない"
      end
    ensure
      File.delete(tar) if tar && File.exist?(tar)
    end

    # 通常のファイルと directory だけ。symlink・device・絶対の道・.. は、戻さない。
    def verify_result_tar!(tar)
      listing, status = Open3.capture2("tar", "-tvf", tar)
      raise Denied, "結果の tar を読めない" unless status.success?
      listing.each_line do |line|
        raise Denied, "通常のファイルと directory だけ戻せる" unless %w[- d].include?(line[0])
      end
      names, status = Open3.capture2("tar", "-tf", tar)
      raise Denied, "結果の tar を読めない" unless status.success?
      names.each_line do |name|
        name = name.chomp
        parts = name.split("/")
        raise Denied, "道の形が不正: #{name}" if name.start_with?("/") || parts.include?("..")
      end
    end

    def write_job_meta(id, meta)
      path = File.join(job_dir(id), "meta.json")
      File.write("#{path}.tmp", JSON.generate(meta))
      File.rename("#{path}.tmp", path)
      meta
    end

    def job_dir(id)
      raise Denied, "job id の形が不正: #{id.inspect}" unless JOB_ID.match?(id.to_s)
      File.join(@root, LOG, JOBS, id)
    end

    def job_meta(id)
      path = File.join(job_dir(id), "meta.json")
      raise Denied, "そのジョブは無い: #{id}" unless File.exist?(path)
      JSON.parse(File.read(path, encoding: "UTF-8"), symbolize_names: true)
    end

    def pid_alive?(pid)
      return false unless pid
      Process.kill(0, pid)
      true
    rescue Errno::ESRCH
      false
    rescue Errno::EPERM
      true
    end

    def write_unlocked(rel_path, content)
      f = resolve(rel_path)
      raise Denied, "大きすぎる(#{content.bytesize} > #{@file_max})" if content.bytesize > @file_max
      raise Denied, "箱がいっぱい(#{usage + content.bytesize} > #{@quota})" if usage + content.bytesize > @quota
      raise Denied, "ディレクトリがある: #{rel_path}" if File.directory?(f)
      FileUtils.mkdir_p(File.dirname(f))
      trash(f, "上書きの前") if File.exist?(f)
      Tempfile.create(".hako", File.dirname(f)) do |t|
        t.binmode; t.write(content); t.flush
        File.rename(t.path, f)
      end
      log(:write, path: rel(f), bytes: content.bytesize)
      { path: rel(f), bytes: content.bytesize }
    end

    def rm_unlocked(rel_path)
      f = resolve(rel_path)
      raise Denied, "無い: #{rel_path}" unless File.exist?(f) || File.symlink?(f)
      raise Denied, "root は消せない" if f == @root
      t = trash(f, "rm")
      { path: rel(f), trash: rel(t) }
    end

    def with_mutation_lock
      lock_path = File.join(@root, LOG, "mutation.lock")
      File.open(lock_path, File::RDWR | File::CREAT, 0o600) do |lock|
        lock.flock(File::LOCK_EX)
        yield
      ensure
        lock.flock(File::LOCK_UN)
      end
    end

    def clean_relative_path(path, allow_dot: false)
      value = path.to_s
      return "." if allow_dot && (value.empty? || value == ".")
      p = Pathname.new(value)
      parts = value.split("/", -1)
      raise Denied, "絶対の道は使わない: #{value}" if p.absolute?
      if value.include?("\0") || parts.any? { |part| part.empty? || part == "." || part == ".." }
        raise Denied, "道の形が不正: #{value}"
      end
      p.cleanpath.to_s
    end

    def reject_symlink_path!(path)
      current = @root
      path.split("/").each do |part|
        current = File.join(current, part)
        raise Denied, "symlink は mruby に渡さない: #{path}" if File.symlink?(current)
      end
    end

    def copy_entry(source, path, dest, files, directories, limits)
      stat = File.lstat(source)
      raise Denied, "symlink は mruby に渡さない: #{path}" if stat.symlink?
      if stat.directory?
        directories << path
        FileUtils.mkdir_p(dest)
        Dir.children(source).each do |name|
          copy_entry(File.join(source, name), File.join(path, name), File.join(dest, name), files, directories, limits)
        end
      elsif stat.file?
        content = File.binread(source)
        track_mruby_file!(path, content, limits)
        FileUtils.mkdir_p(File.dirname(dest))
        File.binwrite(dest, content)
        files[path] = content
      else
        raise Denied, "通常のファイルとディレクトリだけ渡せる: #{path}"
      end
    end

    def collect_entry(source, path, files, directories, limits)
      return unless File.exist?(source) || File.symlink?(source)
      stat = File.lstat(source)
      raise Denied, "symlink は mruby から戻せない: #{path}" if stat.symlink?
      if stat.directory?
        directories << path
        Dir.children(source).each do |name|
          collect_entry(File.join(source, name), File.join(path, name), files, directories, limits)
        end
      elsif stat.file?
        content = File.binread(source)
        track_mruby_file!(path, content, limits)
        files[path] = content
      else
        raise Denied, "通常のファイルとディレクトリだけ戻せる: #{path}"
      end
    end

    def track_mruby_file!(path, content, limits)
      limits[:bytes] += content.bytesize
      limits[:files] += 1
      raise Denied, "mruby に渡すファイルが大きすぎる" if limits[:bytes] > MRUBY_MAX_SCOPE
      raise Denied, "mruby に渡すファイルが多すぎる" if limits[:files] > MRUBY_MAX_FILES
      raise Denied, "ファイルが大きすぎる: #{path}" if content.bytesize > @file_max
    end

    def execute_mruby(code, workspace, cwd, timeout, scopes)
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      out = +""; err = +""; status = nil; timed_out = false
      sandbox, process_cwd = mruby_sandbox(workspace, cwd)
      cpu_limit = [timeout.ceil + 1, 2].max
      env = {
        "PATH" => RUBY_PLATFORM.include?("darwin") ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" : "/usr/local/bin:/usr/bin:/bin",
        "HOME" => workspace,
        "TMPDIR" => File.join(workspace, "tmp"),
        "LANG" => "C.UTF-8",
        "TERM" => "dumb",
      }
      program = mruby_file_move_prelude(workspace, scopes) + "\n" + code
      command = sandbox + ["mruby", "-e", program]
      spawn_options = {
        chdir: process_cwd,
        unsetenv_others: true,
        pgroup: true,
        rlimit_cpu: cpu_limit,
        rlimit_fsize: @file_max,
      }
      spawn_options[:rlimit_as] = 128 * 1024 * 1024 if RUBY_PLATFORM.include?("linux")
      Open3.popen3(
        env,
        *command,
        **spawn_options,
      ) do |stdin, stdout, stderr, wait|
        stdin.close
        readers = { stdout => out, stderr => err }
        deadline = started + timeout
        until readers.empty?
          left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          if left <= 0
            timed_out = true
            begin Process.kill("-TERM", wait.pid); rescue Errno::ESRCH; end
            sleep 0.2
            begin Process.kill("-KILL", wait.pid); rescue Errno::ESRCH; end
            break
          end
          ready, = IO.select(readers.keys, nil, nil, left)
          (ready || []).each do |io|
            chunk = io.read_nonblock(4096, exception: false)
            if chunk.nil? || chunk == :wait_readable
              readers.delete(io) if chunk.nil?
              next
            end
            readers[io] << chunk if readers[io].bytesize < @out_max * 2
          end
        end
        status = wait.value
      end
      took = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      {
        status: status&.exitstatus,
        signal: status&.termsig,
        timed_out: timed_out,
        took: took,
        out: truncate_output(out),
        err: truncate_output(err),
      }
    rescue Errno::ENOENT => e
      raise Denied, "mruby sandbox を起動できない: #{e.message}"
    end

    def mruby_sandbox(workspace, cwd, shell: false)
      if RUBY_PLATFORM.include?("darwin")
        shell_reads = shell ? ' (subpath "/bin") (subpath "/sbin") (subpath "/private/var/select")' : ""
        profile = <<~PROFILE
          (version 1)
          (deny default)
          (allow process-exec*)
          (allow process-fork)
          (allow signal)
          (allow sysctl-read)
          (allow mach-lookup)
          (allow ipc-posix-shm)
          (allow file-read* (literal "/") (subpath "#{workspace}") (subpath "/System") (subpath "/usr") (subpath "/opt/homebrew")#{shell_reads})
          (allow file-read-metadata (subpath "/private/var/folders"))
          (allow file-write* (subpath "#{workspace}"))
          (deny network*)
        PROFILE
        [["/usr/bin/sandbox-exec", "-p", profile], File.join(workspace, cwd)]
      elsif RUBY_PLATFORM.include?("linux")
        runner = "/usr/local/bin/loka-sandbox"
        raise Denied, "Landlock sandbox が見つからない" unless File.executable?(runner)
        [[runner, workspace, "--"], File.join(workspace, cwd)]
      else
        raise Denied, "mruby sandbox は macOS / Linux だけ"
      end
    end

    def mruby_file_move_prelude(workspace, scopes)
      allowed = scopes.map { |path| File.join(workspace, path) }.inspect
      trash = File.join(workspace, TRASH).inspect
      shared = File.join(workspace, "shared_drive").inspect
      <<~MRUBY
        module HakoFileMove
          SCOPES = #{allowed}
          TRASH = #{trash}
          SHARED = #{shared}

          def self.within?(path, root)
            path == root || path.start_with?(root + "/")
          end

          def self.allowed?(path)
            !within?(path, TRASH) && SCOPES.any? { |root| within?(path, root) }
          end

          def self.shared?(path)
            within?(path, SHARED)
          end
        end

        class File
          def self.move(src, dest)
            source = File.expand_path(src.to_s)
            target = File.expand_path(dest.to_s)
            raise ArgumentError, "source and destination are the same" if source == target
            raise ArgumentError, "File.move paths must be selected" unless HakoFileMove.allowed?(source) && HakoFileMove.allowed?(target)
            raise ArgumentError, "source does not exist" unless File.exist?(source)
            raise ArgumentError, "destination already exists" if File.exist?(target)
            if HakoFileMove.shared?(target) && !HakoFileMove.shared?(source)
              raise ArgumentError, "use move_to_shared_drive to publish files"
            end
            File.rename(source, target)
            target
          end
        end
      MRUBY
    end

    def truncate_output(value)
      if value.bytesize > @out_max
        value.byteslice(0, @out_max).force_encoding("UTF-8").scrub + "\n…(あと #{value.bytesize - @out_max} バイト)"
      else
        value.force_encoding("UTF-8").scrub
      end
    end

    def commit_mruby_changes(before, before_dirs, after, changed, removed, removed_dirs)
      touched = changed + removed + removed_dirs
      trash_touched = touched.any? { |path| path == TRASH || path.start_with?("#{TRASH}/") }
      raise Denied, ".trash/ は読み取り専用" if trash_touched
      return if touched.empty?
      with_mutation_lock do
        (changed + removed).each do |path|
          reject_symlink_path!(path)
          file = resolve(path)
          raise Denied, "ディレクトリをファイルに置き換えない: #{path}" if File.directory?(file)
          current = if File.symlink?(file)
            :other
          elsif File.file?(file)
            Digest::SHA256.file(file).hexdigest
          elsif File.exist?(file) || File.symlink?(file)
            :other
          end
          expected = before.key?(path) ? Digest::SHA256.hexdigest(before[path]) : nil
          raise Denied, "同時更新を見つけたので保存しなかった: #{path}" unless current == expected
        end

        added_bytes = changed.sum { |path| after[path].bytesize }
        raise Denied, "箱がいっぱい(#{usage + added_bytes} > #{@quota})" if usage + added_bytes > @quota

        directory_roots = removed_dirs.reject do |path|
          removed_dirs.any? { |other| path.start_with?("#{other}/") }
        end
        trashed_dirs = directory_roots.select do |path|
          reject_symlink_path!(path)
          file = resolve(path)
          next false unless File.directory?(file)

          current_files = {}
          current_dirs = []
          limits = { bytes: 0, files: 0 }
          collect_entry(file, path, current_files, current_dirs, limits)
          expected_files = before.keys.select { |other| other.start_with?("#{path}/") }.sort
          expected_dirs = before_dirs.select { |other| other == path || other.start_with?("#{path}/") }.sort
          current_files.keys.sort == expected_files && current_dirs.sort == expected_dirs
        end

        trashed_dirs.each { |path| rm_unlocked(path) }
        removed.each do |path|
          next if trashed_dirs.any? { |dir| path.start_with?("#{dir}/") }
          rm_unlocked(path)
        end
        changed.each { |path| write_unlocked(path, after[path]) }
        removed_dirs.each do |path|
          next if trashed_dirs.any? { |dir| path == dir || path.start_with?("#{dir}/") }
          dir = resolve(path)
          rm_unlocked(path) if File.directory?(dir) && Dir.empty?(dir)
        end
      end
    end

    def trash(f, why)
      dest = File.join(@root, TRASH, Time.now.strftime("%Y%m%d-%H%M%S") + "-" + File.basename(f))
      dest += "-#{rand(10_000)}" while File.exist?(dest)
      File.rename(f, dest)
      log(:trash, path: rel(f), trash: rel(dest), why: why)
      dest
    end
  end
end
