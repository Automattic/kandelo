#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "pathname"
require "ripper"
require "set"

MAX_BREWFILE_BYTES = 65_536
MAX_PACKAGES = 128
MAX_NAME_BYTES = 255
TAP_NAME = /\A[a-z0-9._-]+\/[a-z0-9._-]+\z/
PACKAGE_NAME = /\A[a-z0-9][a-z0-9._-]*\z/
ENTRY_LINE = /\A([ \t]*)(tap|brew)[ \t]+(["'])([a-z0-9._\/-]+)\3[ \t]*(?:#[^\r\n]*)?\r?\n?\z/

def fail_selection(message)
  abort "homebrew-brewfile-selection: #{message}"
end

unless ARGV.length == 1
  fail_selection "usage: homebrew-brewfile-selection.rb <Brewfile>"
end

input = Pathname.new(ARGV.fetch(0))
if input.symlink? || !input.file?
  fail_selection "Brewfile must be a regular non-symlink file: #{input}"
end
if input.size > MAX_BREWFILE_BYTES
  fail_selection "Brewfile exceeds #{MAX_BREWFILE_BYTES} bytes: #{input}"
end

bytes = input.binread
if bytes.bytesize > MAX_BREWFILE_BYTES
  fail_selection "Brewfile exceeds #{MAX_BREWFILE_BYTES} bytes: #{input}"
end
fail_selection "Brewfile contains a NUL byte" if bytes.include?("\0")

source = bytes.dup.force_encoding(Encoding::UTF_8)
fail_selection "Brewfile is not valid UTF-8" unless source.valid_encoding?

line_entries = []
source.lines.each_with_index do |line, index|
  stripped = line.strip
  next if stripped.empty? || stripped.start_with?("#")

  match = ENTRY_LINE.match(line)
  unless match
    fail_selection(
      "line #{index + 1} is outside the static subset; use only literal tap and brew entries",
    )
  end
  line_entries << {
    method: match[2],
    name: match[4],
    position: [index + 1, match[1].bytesize],
  }
end

syntax_tree = Ripper.sexp(source)
fail_selection "Brewfile is not valid Ruby syntax" if syntax_tree.nil?

statements = syntax_tree[1]
unless syntax_tree.first == :program && statements.is_a?(Array)
  fail_selection "Brewfile has no canonical top-level body"
end

ast_entries = statements.each_with_object([]) do |statement, entries|
  next if statement == [:void_stmt]
  unless statement.is_a?(Array) && statement.first == :command
    fail_selection "Brewfile contains executable or nested Ruby structure"
  end

  identifier = statement[1]
  arguments = statement[2]
  unless identifier.is_a?(Array) && identifier.first == :@ident &&
         %w[tap brew].include?(identifier[1]) &&
         arguments.is_a?(Array) && arguments.first == :args_add_block &&
         arguments[2] == false
    fail_selection "Brewfile contains an unsupported command or argument form"
  end

  values = arguments[1]
  literal = values.fetch(0, nil) if values.is_a?(Array) && values.length == 1
  content = literal[1] if literal.is_a?(Array) && literal.first == :string_literal
  token = content[1] if content.is_a?(Array) && content.first == :string_content && content.length == 2
  unless token.is_a?(Array) && token.first == :@tstring_content && token[1].is_a?(String)
    fail_selection "tap and brew names must be plain string literals without interpolation"
  end

  entries << {
    method: identifier[1],
    name: token[1],
    position: identifier[2],
  }
end

unless ast_entries == line_entries
  fail_selection "Brewfile syntax does not match its direct literal tap and brew entries"
end

tap_entries = ast_entries.select { |entry| entry.fetch(:method) == "tap" }
if tap_entries.length != 1
  fail_selection "Brewfile must contain exactly one literal tap entry"
end
tap_name = tap_entries.fetch(0).fetch(:name)
unless TAP_NAME.match?(tap_name) && tap_name.bytesize <= MAX_NAME_BYTES
  fail_selection "tap name must be a canonical lowercase owner/tap name"
end

packages = []
seen = Set.new
ast_entries.each do |entry|
  next unless entry.fetch(:method) == "brew"

  declared = entry.fetch(:name)
  package = if declared.include?("/")
    parts = declared.split("/", -1)
    unless parts.length == 3 && parts.first(2).join("/") == tap_name
      fail_selection "brew entry #{declared.inspect} must belong to tap #{tap_name.inspect}"
    end
    parts.fetch(2)
  else
    declared
  end

  unless PACKAGE_NAME.match?(package) && package.bytesize <= MAX_NAME_BYTES
    fail_selection "brew entry #{declared.inspect} has an invalid package name"
  end
  unless seen.add?(package)
    fail_selection "brew entry #{declared.inspect} duplicates requested package #{package.inspect}"
  end
  packages << package
  if packages.length > MAX_PACKAGES
    fail_selection "Brewfile requests more than #{MAX_PACKAGES} packages"
  end
end
fail_selection "Brewfile must contain at least one literal brew entry" if packages.empty?

puts JSON.generate({
  "schema" => 1,
  "kind" => "kandelo-static-brewfile-v1",
  "tap_name" => tap_name,
  "sha256" => Digest::SHA256.hexdigest(bytes),
  "bytes" => bytes.bytesize,
  "packages" => packages,
})
