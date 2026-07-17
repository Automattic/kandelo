#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATCH_FILE="$ROOT/homebrew/patches/0002-publisher-skip-redundant-item-trust.patch"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/Library/Homebrew"
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
  echo "test-homebrew-publisher-trust-patch.sh: patch did not add one trusted-tap guard" >&2
  exit 1
}

repository_guard_count="$(grep -c \
  'reject { |dir| dir == HOMEBREW_REPOSITORY }' \
  "$TMPDIR/Library/Homebrew/diagnostic.rb")"
[ "$repository_guard_count" = "1" ] || {
  echo "test-homebrew-publisher-trust-patch.sh: patch did not add one repository exclusion" >&2
  exit 1
}

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

echo "test-homebrew-publisher-trust-patch.sh: ok"
