#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATCH_FILE="$ROOT/homebrew/patches/0002-publisher-skip-redundant-item-trust.patch"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/Library/Homebrew"
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
