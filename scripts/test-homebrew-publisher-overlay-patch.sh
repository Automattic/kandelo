#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATCH_FILE="$ROOT/homebrew/patches/0002-support-isolated-publisher.patch"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/Library/Homebrew/dev-cmd" \
  "$TMPDIR/Library/Homebrew/extend/os/linux" \
  "$TMPDIR/Library/Homebrew/utils/github"
for fixture in abstract_command.rb global.rb build_options.rb keg.rb extend/ENV.rb \
  exceptions.rb system_command.rb utils/bottles.rb utils/popen.rb utils/github/actions.rb; do
  : >"$TMPDIR/Library/Homebrew/$fixture"
done
cat >"$TMPDIR/Library/Homebrew/abstract_command.rb" <<'RUBY'
class AbstractCommand
end
RUBY
cat >"$TMPDIR/Library/Homebrew/env_config.rb" <<'RUBY'
module Homebrew
  module EnvConfig
    def self.sandbox_linux? = true
  end
end
RUBY
cat >"$TMPDIR/Library/Homebrew/formula.rb" <<'RUBY'
class Formula
  class << self
    attr_accessor :installations

    def [](_name) = self

    def ensure_installed!(reason:)
      raise "missing sandbox installation reason" if reason.empty?

      self.installations = installations.to_i + 1
    end
  end
end
RUBY
cat >"$TMPDIR/Library/Homebrew/dev-cmd/bottle.rb" <<'RUBY'
# typed: strict
# frozen_string_literal: true

require "abstract_command"
require "fileutils"
require "formula"
require "utils/bottles"

module T
  Boolean = Object

  class Array
    def self.[](*) = Object
  end
end

def sig(*) = nil

module Utils
  module Gzip
    class << self
      attr_accessor :captured_receipt, :fail_after_capture, :receipt_path
    end

    def self.compress_with_options(_input, mtime:, orig_name:, output:)
      raise "missing stable gzip inputs" if mtime.nil? || orig_name.empty?

      self.captured_receipt = File.binread(receipt_path)
      raise "forced bottle compression failure" if fail_after_capture

      File.binwrite(output, "stable gzip fixture\n")
    end
  end
end

module Homebrew
  module DevCmd
    class Bottle < AbstractCommand
      include FileUtils

      def initialize(args)
        @args = args
      end

      attr_reader :args

      def tar_args = ["default-tar-args"]

      def reproducible_gnutar_args(mtime)
        [
          # Set the mtime of all files to the latest mtime in the formula
          "--mtime=#{mtime}",
          # File ordering
          "--sort=name",
          # Users, groups and numeric ids
          "--owner=0", "--group=0", "--numeric-owner",
          # PAX headers
          "--format=pax",
          # Set exthdr names to exclude PID (for GNU tar <1.33). Also don't store atime and ctime.
          "--pax-option=globexthdr.name=/GlobalHead.%n,exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime"
        ].freeze
      end

      def gnu_tar_formula_ensure_installed_if_needed! = nil
      def gnu_tar(_formula) = "unused-gnu-tar"
      def sudo_purge = nil

      sig { params(mtime: String, default_tar: T::Boolean).returns([String, T::Array[String]]) }
      def setup_tar_and_args!(mtime, default_tar: false)
        # Without --only-json-tab bottles are never reproducible
        default_tar_args = ["tar", tar_args].freeze
        return default_tar_args if !args.only_json_tab? || default_tar

        # Use gnu-tar as it can be set up for reproducibility better than libarchive
        # and to be consistent between macOS and Linux.
        gnu_tar_formula = gnu_tar_formula_ensure_installed_if_needed!
        return default_tar_args if gnu_tar_formula.blank?

        [gnu_tar(gnu_tar_formula), reproducible_gnutar_args(mtime)].freeze
      end

      def create_fixture_bottle(tab, bottle_path, expected_tap:, expected_tap_git_head:,
                                fail_before_compress: false)
        original_tab = nil
        changed_files = []
        tap = Struct.new(:name).new(expected_tap)
        tap_git_revision = expected_tap_git_head

        begin
            original_tab = tab.dup
            tab.poured_from_bottle = false
            tab.time = nil
            tab.changed_files = changed_files.dup
            if args.only_json_tab?
              tab.changed_files&.delete(Pathname.new(AbstractTab::FILENAME))
              tab.tabfile&.unlink
            else
              tab.write
            end

            raise "forced tar failure" if fail_before_compress

            time_at_epoch = Time.at(1)
            tab_source_modified_time = [time_at_epoch, tab.source_modified_time].max
            relocatable_tar_path = "fixture-bottle.tar"
            begin
              Utils::Gzip.compress_with_options(relocatable_tar_path,
                                                mtime:     tab.source_modified_time,
                                                orig_name: relocatable_tar_path,
                                                output:    bottle_path)
              sudo_purge
            end

          nil
        ensure
          original_tab&.write
        end
      end
    end
  end
end
RUBY
cat >"$TMPDIR/Library/Homebrew/build.rb" <<'RUBY'
old_trap = trap("INT") { exit! 130 }

require_relative "global"
require "build_options"
require "keg"
require "extend/ENV"
require "fcntl"

class BuildOptions
  def initialize(*) = nil
end

class Requirements
end

class Dependency
  attr_reader :name, :tags

  def initialize(name, tags = [])
    @name = name
    @tags = Array(tags)
  end

  def build? = tags.include?(:build)
  def implicit? = tags.include?(:implicit)
end

module T
  class Array
    def self.[](*) = Object
  end

  def self.let(value, _type) = value
end

def sig(*) = nil

class Build
  attr_reader :deps, :formula, :reqs

  def initialize(formula, options, args:)
    @formula = formula
    @formula.build = BuildOptions.new(options, formula.options)
    @args = args
    @deps = T.let([], T::Array[Dependency])
    @reqs = T.let(Requirements.new, Requirements)

    return if args.ignore_dependencies?

    @deps = expand_deps
    @reqs = expand_reqs
  end

  sig { params(dependent: Formula).returns(BuildOptions) }
  def effective_build_options_for(dependent)
    args  = dependent.build.used_options
  end
end
RUBY

cat >"$TMPDIR/Library/Homebrew/test.rb" <<'RUBY'
# typed: strict
# frozen_string_literal: true

raise "#{__FILE__} must not be loaded via `require`." if $PROGRAM_NAME != __FILE__

old_trap = trap("INT") { exit! 130 }

require_relative "global"
require "extend/ENV"
require "timeout"
require "formula_assertions"
require "formula_free_port"
require "fcntl"
require "utils/socket"
require "cli/parser"
require "dev-cmd/test"
require "json/add/exception"
require "extend/pathname/write_mkpath_extension"

DEFAULT_TEST_TIMEOUT_SECONDS = T.let(5 * 60, Integer)

begin
  # Undocumented opt-out for internal use.
  # We need to allow formulae from paths here due to how we pass them through.
  ENV["HOMEBREW_INTERNAL_ALLOW_PACKAGES_FROM_PATHS"] = "1"

  args = Homebrew::DevCmd::Test.new.args
  Context.current = args.context

  error_pipe = Utils::UNIXSocketExt.open(ENV.fetch("HOMEBREW_ERROR_PIPE"), &:recv_io)
  error_pipe.fcntl(Fcntl::F_SETFD, Fcntl::FD_CLOEXEC)

  trap("INT", old_trap)

  if Homebrew::EnvConfig.developer? || ENV["CI"].present?
    raise "Cannot find child processes without `pgrep`, please install!" unless which("pgrep")
    raise "Cannot kill child processes without `pkill`, please install!" unless which("pkill")
  end

  formula = args.named.to_resolved_formulae.fetch(0)
  formula.extend(Homebrew::Assertions)
  formula.extend(Homebrew::FreePort)
  if args.debug? && !Homebrew::EnvConfig.disable_debrew?
    require "debrew"
    formula.extend(Debrew::Formula)
  end

  ENV.extend(Stdenv)
  ENV.setup_build_environment(formula:, testing_formula: true)
  Pathname.activate_extensions!

  run_test = proc do |_|
end
RUBY

cat >"$TMPDIR/Library/Homebrew/extend/os/linux/formula.rb" <<'RUBY'
# typed: strict
# frozen_string_literal: true

module OS
  module Linux
    module Formula
      extend T::Helpers

      requires_ancestor { ::Formula }

      sig { params(name: String, version: T.nilable(T.any(String, Integer))).returns(String) }
      def shared_library(name, version = nil)
        suffix = if version == "*" || (name == "*" && version.blank?)
          "{,.*}"
        elsif version.present?
          ".#{version}"
        end
        "#{name}.so#{suffix}"
      end

      sig { returns(String) }
      def loader_path
        "$ORIGIN"
      end

      sig { params(targets: T.nilable(T.any(::Pathname, String))).void }
      def deuniversalize_machos(*targets); end

      sig { params(spec: SoftwareSpec).void }
      def add_global_deps_to_spec(spec)
        @global_deps ||= T.let(nil, T.nilable(T::Array[Dependency]))
        @global_deps ||= begin
          dependency_collector = spec.dependency_collector
          related_formula_names = Set[name]
          if ::DevelopmentTools.needs_build_formulae? || ::DevelopmentTools.needs_libc_formula?
            related_formula_names.merge(aliases)
            related_formula_names.merge(versioned_formulae_names)
          end
          [
            dependency_collector.bubblewrap_dep_if_needed(related_formula_names),
            dependency_collector.gcc_dep_if_needed(related_formula_names),
            dependency_collector.glibc_dep_if_needed(related_formula_names),
          ].compact.freeze
        end
        @global_deps.each { |dep| spec.dependency_collector.add(dep) }
      end

      sig { returns(T::Boolean) }
      def valid_platform?
        supports_linux?
      end
    end
  end
end

Formula.prepend(OS::Linux::Formula)
RUBY

cat >"$TMPDIR/Library/Homebrew/extend/os/linux/sandbox.rb" <<'RUBY'
# typed: strict
# frozen_string_literal: true

require "fileutils"
require "env_config"
require "system_command"
require "utils/popen"
require "utils/github/actions"

module OS
  module Linux
    module Sandbox
      module ClassMethods
        def ensure_sandbox_installed!(install_from_tests: false)
          return unless Homebrew::EnvConfig.sandbox_linux?
          return if ENV["HOMEBREW_TESTS"] && !install_from_tests
          return if ENV["HOMEBREW_INSTALLING_BUBBLEWRAP"]
          return if bubblewrap_executable

          begin
            require "exceptions"
            require "formula"
            with_env(HOMEBREW_INSTALLING_BUBBLEWRAP: "1") do
              ::Formula["bubblewrap"].ensure_installed!(reason: "Linux sandboxing")
            end
          end
        end
      end
    end
  end
end
RUBY

cat >"$TMPDIR/Library/Homebrew/diagnostic.rb" <<'RUBY'
class FixtureDirectory
  attr_reader :path

  def initialize(path, exists:, writable:)
    @path = path
    @exists = exists
    @writable = writable
  end

  def exist?
    @exists
  end

  def writable?
    @writable
  end

  def to_s
    path
  end
end

HOMEBREW_REPOSITORY = FixtureDirectory.new(
  "/publisher/homebrew-overlay", exists: true, writable: false
)

class Keg
  class << self
    attr_accessor :directories

    def must_be_writable_directories
      directories
    end
  end
end

module Homebrew
  module Diagnostic
    class Checks
      def check_access_directories
        not_writable_dirs =
          Keg.must_be_writable_directories.select(&:exist?)
             .reject(&:writable?)
        return if not_writable_dirs.empty?

        <<~EOS
          The following directories are not writable by your user:
          #{not_writable_dirs.join("\n")}

          You should change the ownership of these directories to your user.
            sudo chown -R #{current_user} #{not_writable_dirs.join(" ")}

          And make sure that your user has write permission.
            chmod u+w #{not_writable_dirs.join(" ")}
        EOS
      end

      def current_user
        "publisher-build-user"
      end
    end
  end
end
RUBY

cat >"$TMPDIR/Library/Homebrew/trust.rb" <<'RUBY'
module Utils
  def self.full_name?(name)
    name.count("/") >= 2
  end

  def self.name_from_full_name(name)
    name.split("/").last
  end
end

class Tap
  class InvalidNameError < RuntimeError; end

  attr_accessor :trusted
  attr_reader :name

  def self.fetch(_name)
    @fixture ||= new("owner/repo")
  end

  def initialize(name)
    @name = name
    @trusted = false
  end

  def official?
    false
  end

  def formula_files_by_name
    { "item" => "/formula/item.rb" }
  end

  def cask_files_by_name
    {}
  end
end

module Homebrew
  module Trust
    @calls = []

    def self.trusted_tap?(tap)
      tap.trusted
    end

    def self.item_trust_name(_type, tap, item_name)
      "#{tap.name}/#{item_name}"
    end

    def self.trust!(type, name)
      @calls << [type, name]
      true
    end

    def self.calls
      @calls
    end

    def self.reset!
      @calls.clear
    end

    def self.trust_fully_qualified_items!(names, type: nil)
      names.each do |name|
        next unless ::Utils.full_name?(name)

        tap_name = name.split("/").first(2).join("/")
        item_name = ::Utils.name_from_full_name(name)
        tap = Tap.fetch(tap_name)
        next if tap.official?

        types = if type == :formula
          tap.formula_files_by_name.key?(item_name) ? [:formula] : []
        elsif type == :cask
          tap.cask_files_by_name.key?(item_name) ? [:cask] : []
        elsif tap.formula_files_by_name.key?(item_name)
          [:formula]
        elsif tap.cask_files_by_name.key?(item_name)
          [:cask]
        else
          []
        end
        types.each do |item_type|
          full_name = "#{tap.name}/#{item_name}"
          if trust!(item_type, item_trust_name(item_type, tap, item_name))
            warn "Trusted #{item_type} #{full_name}"
          end
        end
      rescue Tap::InvalidNameError
        nil
      end
    end
  end
end
RUBY

git -C "$TMPDIR" apply --check "$PATCH_FILE"
git -C "$TMPDIR" apply --whitespace=nowarn "$PATCH_FILE"

GNU_TAR_BIN="$(command -v tar || true)"
if ! [[ "$GNU_TAR_BIN" =~ ^/nix/store/[0-9a-z]{32}-gnutar-[^/]+/bin/tar$ ]]; then
  echo "test-homebrew-publisher-overlay-patch.sh: run through scripts/dev-shell.sh to provide Nix GNU tar" >&2
  exit 1
fi

patched_line_count="$(grep -c 'next if trusted_tap?(tap)' \
  "$TMPDIR/Library/Homebrew/trust.rb")"
[ "$patched_line_count" = "1" ] || {
  echo "test-homebrew-publisher-overlay-patch.sh: patch did not add one trusted-tap guard" >&2
  exit 1
}

repository_guard_count="$(grep -c \
  'reject { |dir| dir == HOMEBREW_REPOSITORY }' \
  "$TMPDIR/Library/Homebrew/diagnostic.rb")"
[ "$repository_guard_count" = "1" ] || {
  echo "test-homebrew-publisher-overlay-patch.sh: patch did not add one repository exclusion" >&2
  exit 1
}

sandbox_guard_count="$(grep -c \
  'return if KandeloPublisher.active?' \
  "$TMPDIR/Library/Homebrew/extend/os/linux/sandbox.rb")"
[ "$sandbox_guard_count" = "1" ] || {
  echo "test-homebrew-publisher-overlay-patch.sh: patch did not add one publisher sandbox-install guard" >&2
  exit 1
}

HOMEBREW_KANDELO_GNU_TAR="$GNU_TAR_BIN" \
ruby -I"$TMPDIR/Library/Homebrew" - "$TMPDIR" "$GNU_TAR_BIN" <<'RUBY'
require "json"
require "pathname"
require "time"

HOMEBREW_PREFIX = Pathname(ARGV.fetch(0))/"bottle-prefix"
HOMEBREW_PREFIX.mkpath
expected_gnu_tar = ARGV.fetch(1)

class FixtureBottleArgs
  def only_json_tab? = false
end

class FixtureBottleTab
  attr_accessor :changed_files, :poured_from_bottle, :source, :time
  attr_reader :source_modified_time

  def initialize(receipt_path, source, source_modified_time)
    @receipt_path = receipt_path
    @source = source
    @source_modified_time = source_modified_time
  end

  def write
    @receipt_path.write(JSON.generate({ "source" => source, "stable" => "receipt field" }))
  end
end

plan_path = HOMEBREW_PREFIX/".kandelo-publisher-build-dependencies.json"
plan = {
  "schema" => 4,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "target_taps" => [{
    "tap_name" => "kandelo-dev/tap-core",
    "tap_repository" => "kandelo-dev/homebrew-tap-core",
    "tap_commit" => "1111111111111111111111111111111111111111",
  }],
  "build" => [],
  "build_and_test" => [],
  "native_requirements" => [],
  "runtime_and_test" => [],
}
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)

require "dev-cmd/bottle"

# KandeloPublisher captures this launcher-validated path before Formula source
# can run. A Formula-side ENV mutation must not redirect archive creation.
ENV["HOMEBREW_KANDELO_GNU_TAR"] = "/tmp/formula-controlled-tar"
bottle = Homebrew::DevCmd::Bottle.new(FixtureBottleArgs.new)
mtime = "2024-01-22 17:12:37"
expected_args = [
  "--mtime=#{mtime}",
  "--sort=name",
  "--owner=0", "--group=0", "--numeric-owner",
  "--format=pax",
  "--pax-option=globexthdr.name=/GlobalHead.%n,exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
]
tar, tar_args = bottle.setup_tar_and_args!(mtime)
raise "publisher did not retain the module-load GNU tar" unless tar == expected_gnu_tar
raise "publisher did not use exact upstream reproducible GNU tar arguments" unless tar_args == expected_args

expected_tap = "kandelo-dev/tap-core"
expected_head = "0123456789abcdef0123456789abcdef01234567"
source_time = Time.at(1_705_948_357)
original_source = {
  "path" => "Formula/hello.rb",
  "tap" => expected_tap,
  "tap_git_head" => expected_head,
  "versions" => { "stable" => "1.0" },
}
receipt_path = HOMEBREW_PREFIX/"INSTALL_RECEIPT.json"
bottle_path = HOMEBREW_PREFIX/"hello.bottle.tar.gz"
tab = FixtureBottleTab.new(receipt_path, original_source, source_time)
Utils::Gzip.receipt_path = receipt_path
bottle.create_fixture_bottle(
  tab,
  bottle_path,
  expected_tap: expected_tap,
  expected_tap_git_head: expected_head,
)
archived_source = JSON.parse(Utils::Gzip.captured_receipt).fetch("source")
expected_archived_source = original_source.reject { |key, _| key == "tap_git_head" }
unless archived_source == expected_archived_source
  raise "archived receipt changed more than the volatile tap Git head"
end
if tab.source.equal?(original_source)
  raise "archived receipt reused the shallow-copied installed source Hash"
end
restored_source = JSON.parse(receipt_path.read).fetch("source")
raise "successful bottle did not restore installed tap provenance" unless restored_source == original_source
expected_installed_receipt = JSON.generate({ "source" => original_source, "stable" => "receipt field" })
unless receipt_path.binread == expected_installed_receipt
  raise "successful bottle did not restore the exact installed receipt bytes"
end
unless bottle_path.mtime.to_i == source_time.to_i
  raise "publisher bottle file mtime was not normalized to source time"
end
unless bottle_path.mtime.utc.iso8601 == source_time.utc.iso8601
  raise "publisher bottle JSON date source was not normalized"
end

def assert_failure_restores_receipt(bottle, receipt_path, bottle_path, source, source_time,
                                    expected_tap, expected_head, compression_failure: false)
  receipt_path.delete if receipt_path.exist?
  bottle_path.delete if bottle_path.exist?
  tab = FixtureBottleTab.new(receipt_path, source, source_time)
  Utils::Gzip.receipt_path = receipt_path
  Utils::Gzip.fail_after_capture = compression_failure
  begin
    bottle.create_fixture_bottle(
      tab,
      bottle_path,
      expected_tap: expected_tap,
      expected_tap_git_head: expected_head,
      fail_before_compress: !compression_failure,
    )
    raise "forced bottle failure unexpectedly succeeded"
  rescue RuntimeError => e
    expected_message = compression_failure ? "forced bottle compression failure" : "forced tar failure"
    raise unless e.message == expected_message
  ensure
    Utils::Gzip.fail_after_capture = false
  end
  restored_source = JSON.parse(receipt_path.read).fetch("source")
  raise "failed bottle did not restore installed tap provenance" unless restored_source == source
  expected_receipt = JSON.generate({ "source" => source, "stable" => "receipt field" })
  unless receipt_path.binread == expected_receipt
    raise "failed bottle did not restore the exact installed receipt bytes"
  end
end

assert_failure_restores_receipt(
  bottle, receipt_path, bottle_path, original_source, source_time, expected_tap, expected_head,
)
assert_failure_restores_receipt(
  bottle, receipt_path, bottle_path, original_source, source_time, expected_tap, expected_head,
  compression_failure: true,
)

invalid_sources = [
  { "tap" => expected_tap },
  { "tap" => expected_tap, "tap_git_head" => "ABC" },
  { "tap" => "other/tap", "tap_git_head" => expected_head },
  { "tap" => expected_tap, "tap_git_head" => "f" * 40 },
]
invalid_sources.each do |source|
  tab = FixtureBottleTab.new(receipt_path, source, source_time)
  original_source_object = tab.source
  begin
    KandeloPublisher.prepare_archived_tab!(
      tab,
      expected_tap: expected_tap,
      expected_tap_git_head: expected_head,
    )
    raise "publisher accepted mismatched archived receipt provenance"
  rescue RuntimeError => e
    unless e.message.include?("does not match the selected tap revision")
      raise
    end
  end
  unless tab.source.equal?(original_source_object)
    raise "rejected archived receipt still replaced its source Hash"
  end
end

plan_path.delete
inactive_source = { "tap" => "unrelated/tap" }
inactive_tab = FixtureBottleTab.new(receipt_path, inactive_source, source_time)
KandeloPublisher.prepare_archived_tab!(
  inactive_tab,
  expected_tap: expected_tap,
  expected_tap_git_head: expected_head,
)
unless inactive_tab.source.equal?(inactive_source)
  raise "ordinary Homebrew receipt behavior changed without a protected publisher plan"
end
unless bottle.setup_tar_and_args!(mtime) == ["tar", ["default-tar-args"]]
  raise "ordinary Homebrew tar selection changed without a protected publisher plan"
end
RUBY

ruby -I"$TMPDIR/Library/Homebrew" - "$TMPDIR" <<'RUBY'
require "json"
require "open3"
require "pathname"

HOMEBREW_PREFIX = Pathname(ARGV.fetch(0))/"prefix"
HOMEBREW_PREFIX.mkpath
require "build"

class FixtureDependency
  attr_reader :name

  def initialize(name, build: false, implicit: false)
    @name = name
    @build = build
    @implicit = implicit
  end

  def build? = @build
  def implicit? = @implicit
end

module KandeloFormulaSupport
  class BinaryenRequirement
    KANDELO_NATIVE_FORMULA = "binaryen"
    KANDELO_NATIVE_SENTINEL = "wasm-opt"

    attr_reader :tags

    def initialize(tags) = @tags = tags
  end

  class PkgconfRequirement
    KANDELO_NATIVE_FORMULA = "pkgconf"
    KANDELO_NATIVE_SENTINEL = "pkg-config"

    attr_reader :tags

    def initialize(tags) = @tags = tags
  end

  class ForgedBinaryenRequirement
    KANDELO_NATIVE_FORMULA = "binaryen"
    KANDELO_NATIVE_SENTINEL = "wasm-opt"

    attr_reader :tags

    def initialize(tags) = @tags = tags
  end

  class AlteredSentinelRequirement
    KANDELO_NATIVE_FORMULA = "binaryen"
    KANDELO_NATIVE_SENTINEL = "forged-wasm-opt"

    attr_reader :tags

    def initialize(tags) = @tags = tags
  end

  class AlteredFormulaRequirement
    KANDELO_NATIVE_FORMULA = "wabt"
    KANDELO_NATIVE_SENTINEL = "wasm-opt"

    attr_reader :tags

    def initialize(tags) = @tags = tags
  end
end

class FixtureFormula
  attr_accessor :build
  attr_reader :deps, :full_name, :name, :options, :requirements

  def initialize(deps, requirements: [])
    @deps = deps
    @requirements = requirements
    @name = "hello"
    @full_name = "kandelo-dev/tap-core/hello"
    @options = []
  end
end

class FixtureArgs
  def initialize(build_bottle: true)
    @build_bottle = build_bottle
  end

  def ignore_dependencies? = true
  def build_bottle? = @build_bottle
end

plan_path = HOMEBREW_PREFIX/".kandelo-publisher-build-dependencies.json"
plan = {
  "schema" => 4,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "target_taps" => [
    {
      "tap_name" => "acme/tools",
      "tap_repository" => "acme/homebrew-tools",
      "tap_commit" => "1111111111111111111111111111111111111111",
    },
    {
      "tap_name" => "kandelo-dev/tap-core",
      "tap_repository" => "kandelo-dev/homebrew-tap-core",
      "tap_commit" => "2222222222222222222222222222222222222222",
    },
  ],
  "build" => ["binaryen", "wabt"],
  "build_and_test" => ["binaryen", "pkgconf", "wabt"],
  "native_requirements" => [],
  "runtime_and_test" => ["pkgconf"],
}
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)
raise "protected publisher plan is not active" unless KandeloPublisher.active?

deps = [
  FixtureDependency.new("wabt", build: true),
  FixtureDependency.new("pkgconf"),
  FixtureDependency.new("binaryen", build: true),
  FixtureDependency.new("bubblewrap", build: true, implicit: true),
  FixtureDependency.new("acme/tools/dash", build: true),
  FixtureDependency.new("kandelo-dev/tap-core/zlib", build: true),
]
build = Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new)
unless build.deps.map(&:name) == ["binaryen", "wabt"]
  raise "publisher build did not activate exactly the authorized direct native build dependencies"
end

# Requirement-backed tools are reconstructed as build-only Dependency objects
# so Homebrew's normal Build/Superenv path receives the same inputs as literal
# string dependencies, while the evaluated class, metadata, and tags must all
# match the protected static plan.
native_plan = plan.merge(
  "build" => ["binaryen", "pkgconf", "wabt"],
  "build_and_test" => ["binaryen", "pkgconf", "wabt"],
  "native_requirements" => [
    {
      "class" => "KandeloFormulaSupport::BinaryenRequirement",
      "formula" => "binaryen",
      "sentinel" => "wasm-opt",
      "tags" => ["build"],
    },
    {
      "class" => "KandeloFormulaSupport::PkgconfRequirement",
      "formula" => "pkgconf",
      "sentinel" => "pkg-config",
      "tags" => ["build", "test"],
    },
  ],
  "runtime_and_test" => ["pkgconf"],
)
plan_path.chmod(0o644)
plan_path.write(JSON.generate(native_plan))
plan_path.chmod(0o444)
native_formula = FixtureFormula.new(
  [FixtureDependency.new("wabt", build: true)],
  requirements: [
    KandeloFormulaSupport::PkgconfRequirement.new([:build, :test]),
    KandeloFormulaSupport::BinaryenRequirement.new([:build]),
  ],
)
native_build = Build.new(native_formula, [], args: FixtureArgs.new)
unless native_build.deps.map(&:name) == ["binaryen", "pkgconf", "wabt"]
  raise "publisher build did not reconstruct native Requirement Formula inputs"
end
reconstructed = native_build.deps.reject { |dependency| dependency.is_a?(FixtureDependency) }
unless reconstructed.map(&:tags) == [[:build], [:build]]
  raise "publisher native Requirement inputs did not populate the build-only Superenv dependency path"
end

class FixtureTestEnvironment
  attr_reader :paths, :values

  def initialize
    @paths = Hash.new { |hash, key| hash[key] = [] }
    @values = Hash.new { |hash, key| hash[key] = [] }
  end

  def prepend_path(key, path) = paths[key].unshift(path)
  def prepend(key, value) = values[key].unshift(value)
end

pkgconf_opt = HOMEBREW_PREFIX/"opt/pkgconf"
[pkgconf_opt/"bin", pkgconf_opt/"lib/pkgconfig", pkgconf_opt/"share/aclocal",
 pkgconf_opt/"include"].each(&:mkpath)
pkgconf_sentinel = pkgconf_opt/"bin/pkg-config"
pkgconf_sentinel.write("#!/bin/sh\nprintf 'sealed-native-test-sentinel\\n'\n")
pkgconf_sentinel.chmod(0o555)
test_env = FixtureTestEnvironment.new
KandeloPublisher.activate_native_test_requirements!(native_formula, test_env)
unless test_env.paths.fetch("PATH") == [(pkgconf_opt/"bin").to_s] &&
       test_env.paths.fetch("PKG_CONFIG_PATH") == [(pkgconf_opt/"lib/pkgconfig").to_s] &&
       test_env.paths.fetch("ACLOCAL_PATH") == [(pkgconf_opt/"share/aclocal").to_s] &&
       test_env.paths.fetch("CMAKE_PREFIX_PATH") == [pkgconf_opt.to_s] &&
       test_env.values.fetch("LDFLAGS") == ["-L#{pkgconf_opt}/lib"] &&
       test_env.values.fetch("CPPFLAGS") == ["-I#{pkgconf_opt}/include"]
  raise "publisher test environment did not expose exactly the sealed test Requirement paths"
end
sentinel_output, sentinel_error, sentinel_status = Open3.capture3(
  { "PATH" => test_env.paths.fetch("PATH").join(":") },
  "/usr/bin/env",
  "pkg-config",
)
unless sentinel_status.success? && sentinel_output == "sealed-native-test-sentinel\n" && sentinel_error.empty?
  raise "publisher test environment did not execute the sealed Requirement sentinel by name"
end
pkgconf_sentinel.delete
begin
  KandeloPublisher.activate_native_test_requirements!(native_formula, FixtureTestEnvironment.new)
  raise "publisher test environment accepted a missing native Requirement sentinel"
rescue RuntimeError => e
  raise unless e.message.include?("sentinel is unavailable")
end

begin
  Build.new(
    FixtureFormula.new(
      [FixtureDependency.new("wabt", build: true)],
      requirements: [KandeloFormulaSupport::BinaryenRequirement.new([:build])],
    ),
    [],
    args: FixtureArgs.new,
  )
  raise "publisher accepted a missing evaluated native Requirement"
rescue RuntimeError => e
  raise unless e.message.include?("differ from the sealed dependency plan")
end

begin
  Build.new(
    FixtureFormula.new(
      [FixtureDependency.new("wabt", build: true)],
      requirements: [
        KandeloFormulaSupport::BinaryenRequirement.new([:build]),
        KandeloFormulaSupport::PkgconfRequirement.new([:build]),
      ],
    ),
    [],
    args: FixtureArgs.new,
  )
  raise "publisher accepted evaluated native Requirement tags that differ from the sealed plan"
rescue RuntimeError => e
  raise unless e.message.include?("differ from the sealed dependency plan")
end

begin
  Build.new(
    FixtureFormula.new(
      [FixtureDependency.new("wabt", build: true)],
      requirements: [
        KandeloFormulaSupport::ForgedBinaryenRequirement.new([:build]),
        KandeloFormulaSupport::PkgconfRequirement.new([:build, :test]),
      ],
    ),
    [],
    args: FixtureArgs.new,
  )
  raise "publisher accepted a forged evaluated native Requirement class"
rescue RuntimeError => e
  raise unless e.message.include?("differ from the sealed dependency plan")
end

altered_sentinel_plan = native_plan.merge(
  "native_requirements" => [
    {
      "class" => "KandeloFormulaSupport::AlteredSentinelRequirement",
      "formula" => "binaryen",
      "sentinel" => "wasm-opt",
      "tags" => ["build"],
    },
  ],
  "build" => ["binaryen", "wabt"],
  "build_and_test" => ["binaryen", "wabt"],
  "runtime_and_test" => [],
)
plan_path.chmod(0o644)
plan_path.write(JSON.generate(altered_sentinel_plan))
plan_path.chmod(0o444)
begin
  Build.new(
    FixtureFormula.new(
      [FixtureDependency.new("wabt", build: true)],
      requirements: [KandeloFormulaSupport::AlteredSentinelRequirement.new([:build])],
    ),
    [],
    args: FixtureArgs.new,
  )
  raise "publisher accepted altered evaluated native Requirement metadata"
rescue RuntimeError => e
  raise unless e.message.include?("differ from the sealed dependency plan")
end


altered_formula_plan = altered_sentinel_plan.merge(
  "native_requirements" => [
    {
      "class" => "KandeloFormulaSupport::AlteredFormulaRequirement",
      "formula" => "binaryen",
      "sentinel" => "wasm-opt",
      "tags" => ["build"],
    },
  ],
)
plan_path.chmod(0o644)
plan_path.write(JSON.generate(altered_formula_plan))
plan_path.chmod(0o444)
begin
  Build.new(
    FixtureFormula.new(
      [FixtureDependency.new("wabt", build: true)],
      requirements: [KandeloFormulaSupport::AlteredFormulaRequirement.new([:build])],
    ),
    [],
    args: FixtureArgs.new,
  )
  raise "publisher accepted altered evaluated native Requirement Formula metadata"
rescue RuntimeError => e
  raise unless e.message.include?("differ from the sealed dependency plan")
end

invalid_tags_plan = native_plan.merge(
  "native_requirements" => [native_plan.fetch("native_requirements").first.merge("tags" => ["test"])],
  "build" => ["binaryen", "wabt"],
  "build_and_test" => ["binaryen", "wabt"],
  "runtime_and_test" => ["binaryen"],
)
plan_path.chmod(0o644)
plan_path.write(JSON.generate(invalid_tags_plan))
plan_path.chmod(0o444)
begin
  KandeloPublisher.dependency_plan(native_formula)
  raise "publisher accepted a native Requirement without a build tag"
rescue RuntimeError => e
  raise unless e.message.include?("invalid native Requirements")
end

legacy_plan = plan.merge("schema" => 3)
plan_path.chmod(0o644)
plan_path.write(JSON.generate(legacy_plan))
plan_path.chmod(0o444)
begin
  KandeloPublisher.dependency_plan(native_formula)
  raise "publisher accepted ambiguous schema-3 native dependency data"
rescue RuntimeError => e
  raise unless e.message.include?("invalid identity")
end

plan_path.chmod(0o644)
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)

pour = Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new(build_bottle: false))
raise "staged publisher plan changed an ignored-dependency bottle pour" unless pour.deps.empty?

plan_path.delete
raise "missing publisher plan remained active" if KandeloPublisher.active?
empty = Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new)
raise "ordinary ignored-dependency build changed" unless empty.deps.empty?
inactive_test_env = FixtureTestEnvironment.new
KandeloPublisher.activate_native_test_requirements!(native_formula, inactive_test_env)
unless inactive_test_env.paths.empty? && inactive_test_env.values.empty?
  raise "ordinary Homebrew test environment changed without a protected publisher plan"
end

plan["build"] = ["binaryen", "missing", "wabt"]
plan["build_and_test"] = ["binaryen", "missing", "pkgconf", "wabt"]
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)
begin
  Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new)
  raise "publisher build accepted a dependency absent from Formula declarations"
rescue RuntimeError => e
  raise unless e.message.include?("differs from direct native build dependencies")
end
RUBY

ruby -I"$TMPDIR/Library/Homebrew" - "$TMPDIR" <<'RUBY'
require "json"
require "pathname"
require "set"

HOMEBREW_PREFIX = Pathname(ARGV.fetch(0))/"linux-prefix"
HOMEBREW_PREFIX.mkpath

module T
  module Helpers
    def requires_ancestor(*) = nil
  end

  class Array
    def self.[](*) = Object
  end

  def self.any(*) = Object
  def self.let(value, _type) = value
  def self.nilable(*) = Object
end

def sig(*) = nil

class Dependency
end

class SoftwareSpec
  attr_reader :dependency_collector

  def initialize(dependency_collector)
    @dependency_collector = dependency_collector
  end
end

module DevelopmentTools
  def self.needs_build_formulae? = false
  def self.needs_libc_formula? = false
end

class Formula
  attr_reader :aliases, :full_name, :name, :versioned_formulae_names

  def initialize(name:, full_name:)
    @aliases = []
    @full_name = full_name
    @name = name
    @versioned_formulae_names = []
  end
end

class FixtureDependencyCollector
  attr_reader :added

  def initialize
    @added = []
  end

  def bubblewrap_dep_if_needed(_related_formula_names) = :bubblewrap
  def gcc_dep_if_needed(_related_formula_names) = nil
  def glibc_dep_if_needed(_related_formula_names) = nil
  def add(dependency) = @added << dependency
end

require "extend/os/linux/formula"

def global_dependencies(formula)
  collector = FixtureDependencyCollector.new
  formula.add_global_deps_to_spec(SoftwareSpec.new(collector))
  collector.added
end

plan_path = HOMEBREW_PREFIX/".kandelo-publisher-build-dependencies.json"
plan = {
  "schema" => 4,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "target_taps" => [
    {
      "tap_name" => "acme/tools",
      "tap_repository" => "acme/homebrew-tools",
      "tap_commit" => "1111111111111111111111111111111111111111",
    },
    {
      "tap_name" => "kandelo-dev/tap-core",
      "tap_repository" => "kandelo-dev/homebrew-tap-core",
      "tap_commit" => "2222222222222222222222222222222222222222",
    },
  ],
  "build" => ["wabt"],
  "build_and_test" => ["wabt"],
  "native_requirements" => [],
  "runtime_and_test" => [],
}
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)

target = Formula.new(
  name: "hello",
  full_name: "kandelo-dev/tap-core/hello",
)
unless global_dependencies(target).empty?
  raise "selected Kandelo target Formula retained native Linux global dependencies"
end

same_tap_dependency = Formula.new(
  name: "zlib",
  full_name: "kandelo-dev/tap-core/zlib",
)
unless global_dependencies(same_tap_dependency).empty?
  raise "recursive same-tap Formula retained native Linux global dependencies"
end

locked_tap_dependency = Formula.new(
  name: "dash",
  full_name: "acme/tools/dash",
)
unless global_dependencies(locked_tap_dependency).empty?
  raise "recursive locked-tap Formula retained native Linux global dependencies"
end

other_tap = Formula.new(
  name: "zlib",
  full_name: "example/other/zlib",
)
unless global_dependencies(other_tap) == [:bubblewrap]
  raise "protected publisher plan changed Linux global dependencies for another tap"
end

native = Formula.new(name: "cmake", full_name: "homebrew/core/cmake")
unless global_dependencies(native) == [:bubblewrap]
  raise "protected publisher plan changed native Homebrew global dependencies"
end

mutable_plan = JSON.parse(JSON.generate(plan))
mutable_plan.fetch("target_taps").first["tap_commit"] = "main"
plan_path.chmod(0o644)
plan_path.write(JSON.generate(mutable_plan))
plan_path.chmod(0o444)
begin
  global_dependencies(target)
  raise "mutable target tap revision suppressed Linux global dependencies"
rescue RuntimeError => e
  raise unless e.message.include?("invalid target taps")
end

mismatched_repository_plan = JSON.parse(JSON.generate(plan))
mismatched_repository_plan.fetch("target_taps").first["tap_repository"] =
  "example/homebrew-other"
plan_path.chmod(0o644)
plan_path.write(JSON.generate(mismatched_repository_plan))
plan_path.chmod(0o444)
begin
  global_dependencies(target)
  raise "mismatched target tap repository suppressed Linux global dependencies"
rescue RuntimeError => e
  raise unless e.message.include?("invalid target taps")
end

plan_path.chmod(0o644)
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)

plan_path.delete
inactive_target = Formula.new(
  name: "hello",
  full_name: "kandelo-dev/tap-core/hello",
)
unless global_dependencies(inactive_target) == [:bubblewrap]
  raise "Kandelo Formula without a publisher plan lost Linux global dependencies"
end

plan_path.write(JSON.generate(plan))
plan_path.chmod(0o644)
begin
  global_dependencies(target)
  raise "unprotected publisher plan suppressed Linux global dependencies"
rescue RuntimeError => e
  raise unless e.message.include?("not a protected regular file")
end

plan_path.chmod(0o644)
plan_path.write("{")
plan_path.chmod(0o444)
begin
  global_dependencies(target)
  raise "invalid publisher plan suppressed Linux global dependencies"
rescue RuntimeError => e
  raise unless e.message.include?("invalid JSON")
end
RUBY

ruby -I"$TMPDIR/Library/Homebrew" - "$TMPDIR" <<'RUBY'
require "json"
require "pathname"

HOMEBREW_PREFIX = Pathname(ARGV.fetch(0))/"sandbox-prefix"
HOMEBREW_PREFIX.mkpath
plan_path = HOMEBREW_PREFIX/".kandelo-publisher-build-dependencies.json"
plan = {
  "schema" => 4,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "target_taps" => [{
    "tap_name" => "kandelo-dev/tap-core",
    "tap_repository" => "kandelo-dev/homebrew-tap-core",
    "tap_commit" => "1111111111111111111111111111111111111111",
  }],
  "build" => [],
  "build_and_test" => [],
  "native_requirements" => [],
  "runtime_and_test" => [],
}
plan_path.write(JSON.generate(plan))
plan_path.chmod(0o444)

require "extend/os/linux/sandbox"

class FixturePublisherSandbox
  extend OS::Linux::Sandbox::ClassMethods

  def self.bubblewrap_executable = nil

  def self.with_env(**)
    yield
  end
end

FixturePublisherSandbox.ensure_sandbox_installed!
raise "protected publisher test loaded native Bubblewrap Formula code" if defined?(::Formula)

plan_path.delete
FixturePublisherSandbox.ensure_sandbox_installed!
unless Formula.installations == 1
  raise "native Homebrew no longer follows the normal Bubblewrap installation path"
end
RUBY

ruby -I"$TMPDIR/Library/Homebrew" <<'RUBY'
require "diagnostic"

checks = Homebrew::Diagnostic::Checks.new
Keg.directories = [HOMEBREW_REPOSITORY]
unless checks.check_access_directories.nil?
  raise "immutable publisher repository still failed the writability diagnostic"
end

other = FixtureDirectory.new("/publisher/cache", exists: true, writable: false)
Keg.directories = [HOMEBREW_REPOSITORY, other]
message = checks.check_access_directories
raise "other unwritable path was skipped" unless message&.include?(other.path)
if message.include?(HOMEBREW_REPOSITORY.path)
  raise "publisher repository leaked into the unwritable path report"
end

writable = FixtureDirectory.new("/publisher/prefix", exists: true, writable: true)
Keg.directories = [HOMEBREW_REPOSITORY, writable]
unless checks.check_access_directories.nil?
  raise "writable non-repository path failed the diagnostic"
end
RUBY

ruby -I"$TMPDIR/Library/Homebrew" <<'RUBY'
require "trust"

tap = Tap.fetch("owner/repo")
tap.trusted = true
Homebrew::Trust.reset!
Homebrew::Trust.trust_fully_qualified_items!(["owner/repo/item"], type: :formula)
raise "trusted tap still persisted item trust" unless Homebrew::Trust.calls.empty?

Homebrew::Trust.trust!(:formula, "owner/repo/item")
unless Homebrew::Trust.calls == [[:formula, "owner/repo/item"]]
  raise "explicit trust no longer uses the normal mutation path"
end

tap.trusted = false
Homebrew::Trust.reset!
Homebrew::Trust.trust_fully_qualified_items!(["owner/repo/item"], type: :formula)
unless Homebrew::Trust.calls == [[:formula, "owner/repo/item"]]
  raise "untrusted tap skipped required item trust persistence"
end
RUBY

echo "test-homebrew-publisher-overlay-patch.sh: ok"
