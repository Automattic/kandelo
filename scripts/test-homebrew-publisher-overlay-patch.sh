#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATCH_FILE="$ROOT/homebrew/patches/0002-support-isolated-publisher.patch"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/Library/Homebrew/extend/os/linux" \
  "$TMPDIR/Library/Homebrew/utils/github"
for fixture in global.rb build_options.rb keg.rb extend/ENV.rb \
  exceptions.rb system_command.rb utils/popen.rb utils/github/actions.rb; do
  : >"$TMPDIR/Library/Homebrew/$fixture"
done
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

ruby -I"$TMPDIR/Library/Homebrew" - "$TMPDIR" <<'RUBY'
require "json"
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

class FixtureFormula
  attr_accessor :build
  attr_reader :deps, :full_name, :name, :options

  def initialize(deps)
    @deps = deps
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
  "schema" => 2,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "build" => ["binaryen", "wabt"],
  "build_and_test" => ["binaryen", "pkgconf", "wabt"],
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
  FixtureDependency.new("kandelo-dev/tap-core/zlib", build: true),
]
build = Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new)
unless build.deps.map(&:name) == ["binaryen", "wabt"]
  raise "publisher build did not activate exactly the authorized direct native build dependencies"
end

pour = Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new(build_bottle: false))
raise "staged publisher plan changed an ignored-dependency bottle pour" unless pour.deps.empty?

plan_path.delete
raise "missing publisher plan remained active" if KandeloPublisher.active?
empty = Build.new(FixtureFormula.new(deps), [], args: FixtureArgs.new)
raise "ordinary ignored-dependency build changed" unless empty.deps.empty?

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
  "schema" => 2,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "build" => ["wabt"],
  "build_and_test" => ["wabt"],
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

nonmatching = Formula.new(
  name: "zlib",
  full_name: "kandelo-dev/tap-core/zlib",
)
unless global_dependencies(nonmatching) == [:bubblewrap]
  raise "protected target plan changed Linux global dependencies for another Formula"
end

plan_path.delete
native = Formula.new(name: "cmake", full_name: "homebrew/core/cmake")
unless global_dependencies(native) == [:bubblewrap]
  raise "native Formula without a publisher plan lost Linux global dependencies"
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
  "schema" => 2,
  "tap" => "kandelo-dev/tap-core",
  "formula" => "hello",
  "full_name" => "kandelo-dev/tap-core/hello",
  "build" => [],
  "build_and_test" => [],
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
