require "json"
require "minitest/autorun"
require "open3"
require "rbconfig"
require "tmpdir"

class StateEncodingTest < Minitest::Test
  def test_focus_end_accepts_utf8_summary_in_c_locale
    script = File.expand_path("state.rb", __dir__)

    Dir.mktmpdir("loka-state-") do |dir|
      env = { "WORLD_STATE" => dir, "WORLD_TIMEZONE" => "Asia/Seoul", "LC_ALL" => "C" }
      _, status = Open3.capture2e(env, RbConfig.ruby, script, "focus-start")
      assert status.success?

      output, status = Open3.capture2e(
        env,
        RbConfig.ruby,
        script,
        "focus-end",
        "--summary",
        "休憩のあと、続きを書いた",
      )

      assert status.success?, output
      result = JSON.parse(output)
      assert_equal "休憩のあと、続きを書いた", result["summary"]
      assert_match "集中を終えた。", result["message"]
    end
  end
end
