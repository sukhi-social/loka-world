require "minitest/autorun"
require "tmpdir"
require_relative "lib/hako"

class HakoJobsTest < Minitest::Test
  def setup
    skip "対応 sandbox が必要" unless RUBY_PLATFORM.include?("darwin") || File.executable?("/usr/local/bin/loka-sandbox")

    @root = Dir.mktmpdir("hako-job-test-")
    @box = Hako::Box.new(root: @root, out_max: 8192, job_delay: 0)
    @box.mkdir("desk/project")
  end

  def teardown
    FileUtils.remove_entry(@root) if @root && File.exist?(@root)
  end

  def wait_for(id, timeout: 15)
    deadline = Time.now + timeout
    loop do
      st = @box.job_status(id)
      return st unless st[:state] == "running"
      flunk "ジョブが終わらない: #{st}" if Time.now > deadline
      sleep 0.2
    end
  end

  def test_job_returns_at_once_and_reports_output_and_files
    job = @box.job_start("echo hello; echo built > out.txt", cwd: "desk/project")
    assert_equal "running", job[:state]

    st = wait_for(job[:id])
    assert_equal "done", st[:state]
    assert_equal 0, st[:exit_status]
    assert_equal "hello\n", st[:out]
    assert_equal "built\n", File.read(File.join(@root, "desk/project/out.txt"))
    refute File.exist?(File.join(@root, "desk/project/.loka-tmp")), "tmp は片づける"
  end

  def test_non_ascii_project_path_works_without_a_locale
    @box.mkdir("desk/ぷろじぇくと")
    st = wait_for(@box.job_start("echo こんにちは", cwd: "desk/ぷろじぇくと")[:id])
    assert_equal "done", st[:state]
    assert_equal "こんにちは\n", st[:out]
  end

  def test_failed_job_keeps_its_exit_status
    st = wait_for(@box.job_start("echo oops >&2; exit 3", cwd: "desk/project")[:id])
    assert_equal "failed", st[:state]
    assert_equal 3, st[:exit_status]
    assert_includes st[:out], "oops"
  end

  def test_job_cannot_write_outside_its_project
    @box.write("desk/other.txt", "keep")
    st = wait_for(@box.job_start("echo x > ../other.txt; echo y > ../../escaped.txt; echo done", cwd: "desk/project")[:id])
    assert_equal "keep", File.read(File.join(@root, "desk/other.txt"))
    refute File.exist?(File.join(@root, "escaped.txt"))
  end

  def test_job_has_no_network
    st = wait_for(@box.job_start("curl -sS -m 3 https://example.com >/dev/null; echo status=$?", cwd: "desk/project")[:id])
    refute_includes st[:out], "status=0"
  end

  def test_stop_ends_a_running_job
    job = @box.job_start("sleep 60", cwd: "desk/project")
    sleep 0.5
    assert_equal true, @box.job_stop(job[:id])[:stopped]
    assert_equal "stopped", wait_for(job[:id])[:state]
  end

  def test_results_are_withheld_while_running_and_for_a_while_after
    box = Hako::Box.new(root: @root, out_max: 8192, job_delay: 1)
    job = box.job_start("echo secret; sleep 1", cwd: "desk/project")
    assert_equal "running", job[:state]
    assert_nil job[:out]
    assert_operator job[:next_check_in], :>=, 15
    assert_match(/if/, job[:hint])

    sleep 2.5
    st = box.job_status(job[:id])
    assert_equal "settling", st[:state]
    assert_nil st[:out]
    assert_nil st[:exit_status]
    assert_operator st[:next_check_in], :>, 0
  end

  def test_since_returns_only_the_new_part
    job = @box.job_start("echo one; sleep 1; echo two", cwd: "desk/project")
    st = wait_for(job[:id])
    first = @box.job_status(job[:id], since: 0)
    assert_equal "one\ntwo\n", first[:out]
    rest = @box.job_status(job[:id], since: 4)
    assert_equal "two\n", rest[:out]
    assert_equal st[:log_bytes], rest[:next_offset]
  end

  def test_rejects_bad_requests
    assert_raises(Hako::Denied) { @box.job_start("", cwd: "desk/project") }
    assert_raises(Hako::Denied) { @box.job_start("true", cwd: "desk/nope") }
    assert_raises(Hako::Denied) { @box.job_start("true", cwd: "desk/project", minutes: 999) }
    assert_raises(Hako::Denied) { @box.job_status("../etc") }
  end

  def test_running_jobs_are_limited
    Hako::Box::JOB_MAX_RUNNING.times { @box.job_start("sleep 30", cwd: "desk/project") }
    assert_raises(Hako::Denied) { @box.job_start("true", cwd: "desk/project") }
    @box.job_list.each { |j| @box.job_stop(j[:id]) }
  end
end
