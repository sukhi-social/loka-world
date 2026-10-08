require "minitest/autorun"
require "tmpdir"
require_relative "lib/hako"

class HakoMrubyShellTest < Minitest::Test
  def setup
    skip "mruby が必要" unless system("mruby", "-e", "true", out: File::NULL, err: File::NULL)
    skip "対応 sandbox が必要" unless RUBY_PLATFORM.include?("darwin") || File.executable?("/usr/bin/bwrap")

    @root = Dir.mktmpdir("hako-test-")
    @box = Hako::Box.new(root: @root, quota: 1024 * 1024, out_max: 8192, timeout: 3)
    @box.mkdir("desk/project")
    @box.write("desk/project/issue.md", "before")
  end

  def teardown
    FileUtils.remove_entry(@root) if @root && File.exist?(@root)
  end

  def test_successful_edits_are_committed_and_previous_versions_are_trashed
    result = @box.run_mruby_shell(
      %q{File.open("issue.md", "w") { |file| file.write("after") }; puts File.read("issue.md")},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 0, result[:status]
    assert_equal "after\n", result[:out]
    assert_equal ["desk/project/issue.md"], result[:changed]
    assert_equal "after", @box.cat("desk/project/issue.md")[:content]
    trashed = Dir.glob(File.join(@root, ".trash", "*")).map { |path| File.binread(path) }
    assert_includes trashed, "before"
  end

  def test_file_move_moves_selected_file_to_a_new_destination
    result = @box.run_mruby_shell(
      %q{File.move("issue.md", "moved.md")},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 0, result[:status]
    assert_equal ["desk/project/moved.md"], result[:changed]
    assert_equal ["desk/project/issue.md"], result[:removed]
    assert_equal "before", @box.cat("desk/project/moved.md")[:content]
    trashed = Dir.glob(File.join(@root, ".trash", "*")).map { |path| File.binread(path) }
    assert_includes trashed, "before"
  end

  def test_file_move_refuses_to_overwrite_an_existing_destination
    @box.write("desk/project/existing.md", "keep")

    result = @box.run_mruby_shell(
      %q{File.move("issue.md", "existing.md")},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 1, result[:status]
    assert_empty result[:changed]
    assert_equal "before", @box.cat("desk/project/issue.md")[:content]
    assert_equal "keep", @box.cat("desk/project/existing.md")[:content]
  end

  def test_file_move_does_not_publish_into_shared_drive
    @box.mkdir("shared_drive")

    result = @box.run_mruby_shell(
      %q{File.move("desk/project/issue.md", "shared_drive/issue.md")},
      paths: ["desk/project", "shared_drive"],
    )

    assert_equal 1, result[:status]
    assert_empty result[:changed]
    assert_equal "before", @box.cat("desk/project/issue.md")[:content]
    assert_raises(Hako::Denied) { @box.cat("shared_drive/issue.md") }
  end

  def test_failed_script_discards_its_staged_changes
    result = @box.run_mruby_shell(
      %q{File.open("issue.md", "w") { |file| file.write("discard me") }; raise "stop"},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 1, result[:status]
    assert_empty result[:changed]
    assert_equal "before", @box.cat("desk/project/issue.md")[:content]
  end

  def test_deleted_files_are_moved_to_trash
    result = @box.run_mruby_shell(
      %q{File.delete("issue.md")},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 0, result[:status]
    assert_equal ["desk/project/issue.md"], result[:removed]
    assert_raises(Hako::Denied) { @box.cat("desk/project/issue.md") }
    trashed = Dir.glob(File.join(@root, ".trash", "*")).map { |path| File.binread(path) }
    assert_includes trashed, "before"
  end

  def test_trash_files_can_be_read_and_restored
    @box.write("desk/project/issue.md", "after")

    read_result = @box.run_mruby_shell(
      %q{backup = Dir.children(".").first; puts File.read(backup)},
      paths: [".trash"],
      cwd: ".trash",
    )

    assert_equal 0, read_result[:status]
    assert_equal "before\n", read_result[:out]

    restore_result = @box.run_mruby_shell(
      %q{backup = Dir.children(".trash").first; File.open("desk/project/restored.md", "w") { |file| file.write(File.read(".trash/#{backup}")) }},
      paths: [".trash", "desk/project"],
    )

    assert_equal 0, restore_result[:status]
    assert_equal ["desk/project/restored.md"], restore_result[:changed]
    assert_equal "before", @box.cat("desk/project/restored.md")[:content]
  end

  def test_mruby_cannot_modify_trash_files
    @box.write("desk/project/issue.md", "after")
    backup = Dir.children(File.join(@root, ".trash")).first

    assert_raises(Hako::Denied) do
      @box.run_mruby_shell(
        %Q{File.open(#{backup.inspect}, "w") { |file| file.write("changed") }},
        paths: [".trash"],
        cwd: ".trash",
      )
    end
    assert_equal "before", File.binread(File.join(@root, ".trash", backup))
  end

  def test_removed_directories_are_moved_to_trash
    @box.mkdir("desk/project/archive")
    @box.write("desk/project/archive/note.md", "archived")

    result = @box.run_mruby_shell(
      %q{File.delete("archive/note.md"); Dir.rmdir("archive")},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 0, result[:status]
    assert_equal ["desk/project/archive/note.md"], result[:removed]
    assert_equal ["desk/project/archive"], result[:removed_dirs]
    assert_equal false, File.exist?(File.join(@root, "desk/project/archive"))
    trashed_dirs = Dir.glob(File.join(@root, ".trash", "*")).select { |path| File.directory?(path) }
    assert_equal 1, trashed_dirs.length
    assert_equal "archived", File.binread(File.join(trashed_dirs.first, "note.md"))
  end

  def test_unselected_paths_are_not_visible
    @box.mkdir("library/private")
    @box.write("library/private/secret.md", "secret")

    result = @box.run_mruby_shell(
      %q{puts File.exist?("../../library/private/secret.md")},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 0, result[:status]
    assert_equal "false\n", result[:out]
  end

  def test_user_home_is_not_readable
    private_path = File.join(Dir.home, ".ssh", "config")
    skip "home file needed for sandbox check" unless File.file?(private_path)
    code = %Q{begin; File.read(#{private_path.inspect}); puts 'read'; rescue; puts 'blocked'; end}

    result = @box.run_mruby_shell(code, paths: ["desk/project"], cwd: "desk/project")

    assert_equal 0, result[:status]
    assert_equal "blocked\n", result[:out]
  end

  def test_timed_out_script_does_not_commit_changes
    result = @box.run_mruby_shell(
      %q{File.open("issue.md", "w") { |file| file.write("discard me") }; loop {}},
      paths: ["desk/project"],
      cwd: "desk/project",
      timeout: 0.1,
    )

    assert result[:timed_out]
    assert_empty result[:changed]
    assert_equal "before", @box.cat("desk/project/issue.md")[:content]
  end

  def test_concurrent_update_is_not_overwritten
    racing_box_class = Class.new(Hako::Box) do
      attr_accessor :race_path

      private

      def execute_mruby(*args)
        result = super
        write(race_path, "concurrent")
        result
      end
    end
    box = racing_box_class.new(root: @root, quota: 1024 * 1024, out_max: 8192, timeout: 3)
    box.race_path = "desk/project/issue.md"

    error = assert_raises(Hako::Denied) do
      box.run_mruby_shell(
        %q{File.open("issue.md", "w") { |file| file.write("script")}},
        paths: ["desk/project"],
        cwd: "desk/project",
      )
    end

    assert_match "同時更新", error.message
    assert_equal "concurrent", box.cat("desk/project/issue.md")[:content]
  end

  def test_rejects_paths_that_escape_the_box
    assert_raises(Hako::Denied) do
      @box.run_mruby_shell("puts 1", paths: ["desk/../library"])
    end
  end

  def test_regexp_literals_work_when_the_engine_is_built_with_regexp
    regexp_check = %q{raise unless ("abc42" =~ /[a-z]+\d+/) == 0}
    skip "mruby regexp gem is not installed" unless system("mruby", "-e", regexp_check, out: File::NULL, err: File::NULL)

    result = @box.run_mruby_shell(
      %q{match = /ticket-(\d+)/.match("ticket-42"); puts match[1]},
      paths: ["desk/project"],
      cwd: "desk/project",
    )

    assert_equal 0, result[:status]
    assert_equal "42\n", result[:out]
  end
end
