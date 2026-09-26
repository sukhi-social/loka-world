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
require "json"
require "open3"
require "pathname"
require "time"
require "tempfile"

module Hako
  class Denied < StandardError; end

  class Box
    TRASH = ".trash"
    LOG = ".log"

    attr_reader :root, :quota, :file_max, :out_max, :timeout

    def initialize(root:, quota: 200 * 1024 * 1024, file_max: 8 * 1024 * 1024, out_max: 8 * 1024, timeout: 10)
      @root = File.realpath(File.expand_path(root)) rescue (FileUtils.mkdir_p(File.expand_path(root)); File.realpath(File.expand_path(root)))
      FileUtils.mkdir_p(File.join(@root, TRASH))
      FileUtils.mkdir_p(File.join(@root, LOG))
      @quota, @file_max, @out_max, @timeout = quota, file_max, out_max, timeout
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

    def rel(abs) = abs == @root ? "." : abs[(@root.length + 1)..]

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

    def mkdir(rel_path)
      d = resolve(rel_path)
      FileUtils.mkdir_p(d)
      log(:mkdir, path: rel(d))
      { path: rel(d) }
    end

    def mv(from, to)
      a = resolve(from); b = resolve(to)
      raise Denied, "無い: #{from}" unless File.exist?(a)
      raise Denied, "もうある: #{to}" if File.exist?(b)
      FileUtils.mkdir_p(File.dirname(b))
      File.rename(a, b)
      log(:mv, from: rel(a), to: rel(b))
      { from: rel(a), to: rel(b) }
    end

    # 消さない。.trash/ に移す。
    def rm(rel_path)
      f = resolve(rel_path)
      raise Denied, "無い: #{rel_path}" unless File.exist?(f) || File.symlink?(f)
      raise Denied, "root は消せない" if f == @root
      t = trash(f, "rm")
      { path: rel(f), trash: rel(t) }
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

    # --- 記録

    def log(kind, **fields)
      f = File.join(@root, LOG, Time.now.strftime("%Y-%m-%d") + ".jsonl")
      File.open(f, "a") { |io| io.puts JSON.generate({ at: Time.now.iso8601, kind: kind }.merge(fields)) }
    end

    private

    def trash(f, why)
      dest = File.join(@root, TRASH, Time.now.strftime("%Y%m%d-%H%M%S") + "-" + File.basename(f))
      dest += "-#{rand(10_000)}" while File.exist?(dest)
      File.rename(f, dest)
      log(:trash, path: rel(f), trash: rel(dest), why: why)
      dest
    end
  end
end
