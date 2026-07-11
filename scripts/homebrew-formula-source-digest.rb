#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "ripper"

abort "usage: homebrew-formula-source-digest.rb <formula.rb>" unless ARGV.length == 1

source = File.binread(ARGV.fetch(0))
syntax_tree = Ripper.sexp(source)
abort "could not parse Formula source: #{ARGV.fetch(0)}" if syntax_tree.nil?
abort "Formula source contains CRLF or a missing final newline: #{ARGV.fetch(0)}" unless source.end_with?("\n") && !source.include?("\r")

removed = Object.new

method_name = lambda do |node|
  next nil unless node.is_a?(Array)

  case node.first
  when :method_add_arg, :method_add_block
    method_name.call(node[1])
  when :fcall, :vcall
    token = node[1]
    token[1] if token.is_a?(Array) && token.first == :@ident
  when :command
    token = node[1]
    token[1] if token.is_a?(Array) && token.first == :@ident
  end
end

bottle_nodes = 0
count_bottle_nodes = nil
count_bottle_nodes = lambda do |node|
  next unless node.is_a?(Array)

  bottle_nodes += 1 if node.first == :method_add_block && method_name.call(node[1]) == "bottle"
  node.each { |child| count_bottle_nodes.call(child) }
end
count_bottle_nodes.call(syntax_tree)

lines = source.lines
bottle_starts = lines.each_index.select { |index| lines[index] == "  bottle do\n" }
abort "Formula source has multiple bottle blocks: #{ARGV.fetch(0)}" if bottle_starts.length > 1
unless bottle_nodes == bottle_starts.length
  abort "Formula source contains a noncanonical bottle block: #{ARGV.fetch(0)}"
end
if bottle_starts.length == 1
  start_index = bottle_starts.fetch(0)
  end_index = ((start_index + 1)...lines.length).find { |index| lines[index] == "  end\n" }
  abort "Formula bottle block is unterminated: #{ARGV.fetch(0)}" if end_index.nil?

  root_count = 0
  rebuild_count = 0
  tag_count = 0
  lines[(start_index + 1)...end_index].each do |line|
    case line
    when /\A    root_url "https:\/\/ghcr\.io\/v2\/[a-z0-9._\/-]+"\n\z/
      root_count += 1
    when /\A    rebuild [1-9][0-9]*\n\z/
      rebuild_count += 1
    when /\A    sha256 cellar: (:[a-z_]+|"[^"]+"), (?:wasm32|wasm64)_kandelo: "[0-9a-f]{64}"\n\z/
      tag_count += 1
    else
      abort "Formula bottle block contains unsupported content: #{ARGV.fetch(0)}"
    end
  end
  unless root_count == 1 && rebuild_count <= 1 && tag_count.between?(1, 2)
    abort "Formula bottle block is not canonical static bottle data: #{ARGV.fetch(0)}"
  end
end

normalize = nil
normalize = lambda do |node|
  next node unless node.is_a?(Array)

  if node.first == :method_add_block && method_name.call(node[1]) == "bottle"
    next removed
  end

  if node.first.is_a?(Symbol) && node.first.to_s.start_with?("@")
    next [node.first, node[1]]
  end

  node.each_with_object([]) do |child, children|
    normalized = normalize.call(child)
    children << normalized unless normalized.equal?(removed)
  end
end

canonical = JSON.generate(normalize.call(syntax_tree))
puts Digest::SHA256.hexdigest(canonical)
