# frozen_string_literal: true
# ジョブの見張り役。Box#job_start が、切り離して一つだけ起こす。
#
#   ruby job_runner.rb <jobdir>/spec.json
#
# 箱の中のコマンドを走らせ、出力を out.log に溜め、終わり(または締切・停止)を
# meta.json に書く。呼び出した側(短い CLI)が先に終わっても、ここは最後まで見届ける。
require "json"
require "time"
require "fileutils"

# LANG が空でも、道に日本語や韓国語が入っていても読めるように。
Encoding.default_external = Encoding::UTF_8

spec = JSON.parse(File.read(ARGV.fetch(0)), symbolize_names: true)
jobdir = File.dirname(ARGV.fetch(0))
meta_path = File.join(jobdir, "meta.json")
stop_path = File.join(jobdir, "stop")
now = -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) }

meta = JSON.parse(File.read(meta_path), symbolize_names: true)
save = lambda do
  tmp = "#{meta_path}.tmp"
  File.write(tmp, JSON.generate(meta))
  File.rename(tmp, meta_path)
end
signal_group = lambda do |sig|
  Process.kill("-#{sig}", meta[:child_pid])
rescue Errno::ESRCH, Errno::EPERM
  nil
end

FileUtils.mkdir_p(spec[:env][:TMPDIR])
reader, writer = IO.pipe
begin
  child = Process.spawn(
    spec[:env].transform_keys(&:to_s), *spec[:sandbox], "/bin/sh", "-c", spec[:cmd],
    chdir: spec[:cwd], unsetenv_others: true, pgroup: true,
    in: File::NULL, out: writer, err: writer,
    rlimit_cpu: spec[:cpu_seconds], rlimit_fsize: spec[:fsize], rlimit_nofile: 4096, rlimit_core: 0
  )
rescue SystemCallError => e
  meta.merge!(state: "failed", error: "起動できない: #{e.message}", finished_at: Time.now.iso8601)
  save.call
  exit 0
end
writer.close
meta[:child_pid] = child
save.call

started = now.call
deadline = started + spec[:seconds]
log = File.open(File.join(jobdir, "out.log"), "ab")
log.sync = true
written = 0
timed_out = false
kill_at = nil
stop_seen = false

loop do
  t = now.call
  if !stop_seen && File.exist?(stop_path)
    stop_seen = true
    signal_group.call("TERM")
    kill_at = t + 5
  end
  if !timed_out && !stop_seen && t >= deadline
    timed_out = true
    signal_group.call("TERM")
    kill_at = t + 5
  end
  if kill_at && t >= kill_at
    signal_group.call("KILL")
    break if t >= kill_at + 2
  end
  ready, = IO.select([reader], nil, nil, 1)
  next unless ready
  chunk = reader.read_nonblock(16 * 1024, exception: false)
  break if chunk.nil?
  next if chunk == :wait_readable
  room = spec[:log_max] - written
  if room > 0
    part = chunk.byteslice(0, room)
    log.write(part)
    written += part.bytesize
    log.write("\n…(出力が多いので、ここから先は残さない)\n") if written >= spec[:log_max]
  end
end

_, status = Process.wait2(child)
stop_seen ||= File.exist?(stop_path)
signal_group.call("KILL")
FileUtils.rm_rf(spec[:env][:TMPDIR])
state = if stop_seen then "stopped"
        elsif timed_out then "timed_out"
        elsif status.exitstatus == 0 then "done"
        else "failed"
        end
meta.merge!(state: state, exit_status: status.exitstatus, signal: status.termsig,
            took: (now.call - started).round(1), finished_at: Time.now.iso8601)
save.call
