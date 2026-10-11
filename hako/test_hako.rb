# frozen_string_literal: true
require "minitest/autorun"
require "tmpdir"
require "socket"
require_relative "lib/hako"

class HakoTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir("hako")
    @box = Hako::Box.new(root: @dir, quota: 10_000, file_max: 5_000, out_max: 200, timeout: 2)
  end

  def teardown = FileUtils.rm_rf(@dir)

  def test_write_ls_cat
    @box.write("memo/a.txt", "こんにちは")
    assert_equal ["memo"], @box.ls.map { _1[:name] }
    assert_equal "こんにちは", @box.cat("memo/a.txt")[:content]
    assert_equal [], @box.ls.select { _1[:name].start_with?(".") }, "隠しの .trash/.log は見せない"
  end

  def test_no_escape
    assert_raises(Hako::Denied) { @box.cat("../etc/passwd") }
    assert_raises(Hako::Denied) { @box.write("/tmp/x", "x") }
    assert_raises(Hako::Denied) { @box.ls("..") }
  end

  def test_symlink_escape
    File.symlink("/etc", File.join(@dir, "out"))
    assert_raises(Hako::Denied) { @box.ls("out") }
    assert_raises(Hako::Denied) { @box.cat("out/hosts") }
  end

  def test_rm_goes_to_trash_and_overwrite_keeps_old
    @box.write("a.txt", "one")
    @box.write("a.txt", "two")
    @box.rm("a.txt")
    assert_equal [], @box.ls
    kept = Dir.children(File.join(@dir, ".trash")).sort
    assert_equal 2, kept.size, "上書き前の一つと、rm の一つ"
    assert_equal %w[one two], kept.map { File.read(File.join(@dir, ".trash", _1)) }.sort
    assert_raises(Hako::Denied) { @box.ls(".trash") }
  end

  def test_limits
    assert_raises(Hako::Denied) { @box.write("big", "x" * 6_000) }
    @box.write("a", "x" * 4_000); @box.write("b", "x" * 4_000)
    assert_raises(Hako::Denied) { @box.write("c", "x" * 4_000) }
    @box.write("long", "y" * 1_000)
    r = @box.cat("long")
    assert r[:truncated] && r[:content].bytesize == 200
  end

  def test_run_inside
    @box.write("hi.txt", "yo")
    r = @box.run(["cat", "hi.txt"])
    assert_equal "yo", r[:out]
    assert_equal 0, r[:status]
    r = @box.run("echo made > new.txt && cat new.txt")
    assert_equal "made\n", r[:out]
  end

  def test_run_cannot_write_outside_or_unlink_or_network
    outside = File.join(Dir.home, ".hako-test-#{$$}")
    r = @box.run("echo x > #{outside}")
    refute File.exist?(outside), "箱の外に書けてしまった"
    refute_equal 0, r[:status]
    @box.write("keep.txt", "k")
    r = @box.run(["rm", "keep.txt"])
    assert File.exist?(File.join(@dir, "keep.txt")), "コンソールから消せてしまった"
    r = @box.run(["ruby", "-rsocket", "-e", "TCPSocket.new('127.0.0.1', 1)"])
    refute_equal 0, r[:status]
    refute_match(/ECONNREFUSED/, r[:err], "network が通っている(拒否ではなく接続に行けた)")
  end

  def test_run_timeout_and_output_cap
    r = @box.run("sleep 5", timeout: 0.5)
    assert r[:timed_out]
    r = @box.run("yes | head -c 5000")
    assert r[:out].bytesize < 400 && r[:out].include?("あと")
  end

  def test_log
    @box.write("a", "1")
    log = Dir.glob(File.join(@dir, ".log", "*.jsonl")).first
    assert_match(/"kind":"write"/, File.read(log))
  end
  def test_serve_listens_on_its_port_only_and_stops
    @box.write("srv.rb", <<~R)
      require "socket"
      s = TCPServer.new("127.0.0.1", ENV["PORT"].to_i)
      loop { c = s.accept; c.gets; c.write("HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhako"); c.close }
    R
    ruby = RbConfig.ruby
    r = @box.serve([ruby, "srv.rb"], port: 7911)
    assert r[:alive]
    got = nil
    20.times do
      begin
        c = TCPSocket.new("127.0.0.1", 7911); c.write("GET / HTTP/1.0\r\n\r\n"); got = c.read; c.close; break
      rescue Errno::ECONNREFUSED
        sleep 0.2
      end
    end
    assert_match(/hako\z/, got.to_s)
    assert @box.serving[:alive]
    assert_equal 7911, @box.serving[:port]
    assert_equal({ stopped: true, port: 7911 }, @box.stop)
    refute @box.serving[:alive]
    assert_raises(Errno::ECONNREFUSED) { TCPSocket.new("127.0.0.1", 7911) }
  end

  def test_serve_refuses_bad_port_and_stop_when_nothing
    assert_raises(Hako::Denied) { @box.serve("true", port: 80) }
    assert_equal({ stopped: false }, @box.stop)
  end
end
