require "json"
require "minitest/autorun"
require "open3"
require "rbconfig"
require "tmpdir"

class StateStatusTest < Minitest::Test
  SCRIPT = File.expand_path("state.rb", __dir__)

  def run_state(dir, *args)
    env = { "WORLD_STATE" => dir, "WORLD_TIMEZONE" => "Asia/Seoul", "LC_ALL" => "C" }
    out, status = Open3.capture2e(env, RbConfig.ruby, SCRIPT, *args)
    [JSON.parse(out.force_encoding(Encoding::UTF_8)), status.success?]
  end

  def test_starts_available_and_follows_declaration
    Dir.mktmpdir("loka-status-") do |dir|
      cur, ok = run_state(dir, "status")
      assert ok
      assert_equal "available", cur["status"]
      assert_equal "扉が開いている", cur["door"]

      cur, ok = run_state(dir, "status-set", "--status", "resting", "--note", "お昼ね中")
      assert ok
      assert_equal "resting", cur["status"]
      assert_equal "お昼ね中", cur["note"]
      assert_equal "灯りが消えている", cur["door"]
    end
  end

  def test_focus_is_not_declared_but_wins_while_focusing
    Dir.mktmpdir("loka-status-") do |dir|
      err, ok = run_state(dir, "status-set", "--status", "focus")
      refute ok
      assert_match "start_focus", err["error"]

      run_state(dir, "status-set", "--status", "offline")
      run_state(dir, "focus-start", "--task", "つづきを書く")
      cur, = run_state(dir, "status")
      assert_equal "focus", cur["status"]
      assert_equal "つづきを書く", cur["note"]
      assert_equal "扉が閉まっている", cur["door"]

      run_state(dir, "focus-end")
      cur, = run_state(dir, "status")
      assert_equal "offline", cur["status"]
    end
  end

  def test_rejects_unknown_status
    Dir.mktmpdir("loka-status-") do |dir|
      _, ok = run_state(dir, "status-set", "--status", "sleepy")
      refute ok
    end
  end
end
