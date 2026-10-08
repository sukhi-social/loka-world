require "minitest/autorun"
require "tmpdir"
require "rbconfig"
require_relative "lib/hako"

# runner(Python)を本物のまま起こし、podman だけをテスト用の偽物にして、world 側の道を通す。
class HakoRemoteJobsTest < Minitest::Test
  RUNNER_DIR = File.expand_path("../runner", __dir__)

  def setup
    skip "python3 が必要" unless system("python3", "--version", out: File::NULL, err: File::NULL)
    @tmp = Dir.mktmpdir("lr-", "/tmp")
    @run = File.join(@tmp, "run")
    env = { "LOKA_RUNNER_RUN" => @run, "LOKA_RUNNER_DATA" => File.join(@tmp, "jobs"),
            "LOKA_PODMAN" => File.join(RUNNER_DIR, "fake_podman.py"), "FAKE_PODMAN_DIR" => @tmp }
    @runner_pid = Process.spawn(env, "python3", File.join(RUNNER_DIR, "loka_runner.py"), out: File::NULL, err: File::NULL)
    50.times { break if File.socket?(File.join(@run, "api.sock")); sleep 0.1 }
    @root = File.join(@tmp, "room")
    @box = Hako::Box.new(root: @root, out_max: 8192, job_delay: 0, runner_sock: File.join(@run, "api.sock"))
    @box.mkdir("desk/project")
    @box.write("desk/project/in.txt", "before")
  end

  def teardown
    Process.kill("TERM", @runner_pid) rescue nil
    Process.wait(@runner_pid) rescue nil
    FileUtils.remove_entry(@tmp) if @tmp && File.exist?(@tmp)
  end

  def wait_for(id)
    60.times do
      st = @box.job_status(id)
      return st unless st[:state] == "running"
      sleep 0.2
    end
    flunk "終わらない"
  end

  def test_job_runs_in_the_runner_and_results_come_back
    job = @box.job_start("cat in.txt; echo after > out.txt; mkdir -p sub; echo deep > sub/d.txt", cwd: "desk/project")
    assert_equal "running", job[:state]
    st = wait_for(job[:id])
    assert_equal "done", st[:state]
    assert_equal "before", st[:out]
    assert_equal "after\n", File.read(File.join(@root, "desk/project/out.txt"))
    assert_equal "deep\n", File.read(File.join(@root, "desk/project/sub/d.txt"))
    assert_equal "before", File.read(File.join(@root, "desk/project/in.txt"))
  end

  def test_failure_and_stop
    st = wait_for(@box.job_start("echo oops; exit 4", cwd: "desk/project")[:id])
    assert_equal ["failed", 4], [st[:state], st[:exit_status]]
    job = @box.job_start("sleep 60", cwd: "desk/project")
    sleep 0.5
    assert @box.job_stop(job[:id])[:stopped]
    assert_equal "stopped", wait_for(job[:id])[:state]
  end

  def test_symlinks_in_the_project_are_not_sent_and_results_cannot_plant_links
    File.symlink("/etc/passwd", File.join(@root, "desk/project/link"))
    st = wait_for(@box.job_start("ls; ln -s /etc/shadow evil; echo ok > fine.txt", cwd: "desk/project")[:id])
    assert_equal "done", st[:state]
    refute_includes st[:out], "link"
    refute File.symlink?(File.join(@root, "desk/project/evil"))
    assert_equal "ok\n", File.read(File.join(@root, "desk/project/fine.txt"))
  end

  def test_registries_needs_a_valid_network_name
    assert_raises(Hako::Denied) { @box.job_start("true", cwd: "desk/project", network: "open") }
    assert_equal "running", @box.job_start("true", cwd: "desk/project", network: "registries")[:state]
  end

  def test_memory_must_be_one_of_the_known_sizes
    assert_raises(Hako::Denied) { @box.job_start("true", cwd: "desk/project", memory: "64g") }
    assert_equal "running", @box.job_start("true", cwd: "desk/project", memory: "2g")[:state]
  end

  def test_without_a_runner_registries_is_refused
    box = Hako::Box.new(root: File.join(@tmp, "room2"), job_delay: 0, runner_sock: nil)
    box.mkdir("desk/p")
    assert_raises(Hako::Denied) { box.job_start("true", cwd: "desk/p", network: "registries") }
  end

  def test_runner_down_is_reported_not_crashed
    Process.kill("TERM", @runner_pid); Process.wait(@runner_pid); File.delete(File.join(@run, "api.sock")) rescue nil
    # runner が無ければ、手元の道(この Mac では sandbox-exec)に戻る
    st = wait_for(@box.job_start("echo local", cwd: "desk/project")[:id])
    assert_equal "done", st[:state]
  end
end
