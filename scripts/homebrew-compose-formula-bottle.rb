#!/usr/bin/env ruby
# frozen_string_literal: true

require "ripper"

unless ARGV.length == 9
  abort "usage: homebrew-compose-formula-bottle.rb <current.rb> <planned.rb> <root-url> <rebuild> <tag> <cellar> <sha256> <preserve|discard> <out.rb>"
end

current_path, planned_path, root_url, rebuild_text, selected_tag, cellar, sha256,
  sibling_policy, out_path = ARGV

abort "invalid bottle root URL" unless root_url.match?(%r{\Ahttps://ghcr\.io/v2/[a-z0-9._/-]+\z})
abort "invalid bottle rebuild" unless rebuild_text.match?(/\A(?:0|[1-9][0-9]*)\z/)
abort "invalid bottle tag" unless selected_tag.match?(/\A(?:wasm32|wasm64)_kandelo\z/)
abort "invalid bottle sha256" unless sha256.match?(/\A[0-9a-f]{64}\z/)
abort "invalid sibling bottle policy" unless %w[preserve discard].include?(sibling_policy)

cellar_dsl = case cellar
             when "any" then ":any"
             when "any_skip_relocation" then ":any_skip_relocation"
             when "/home/linuxbrew/.linuxbrew/Cellar" then '"/home/linuxbrew/.linuxbrew/Cellar"'
             else abort "invalid bottle relocation cellar"
             end
rebuild = Integer(rebuild_text, 10)

BottleBlock = Struct.new(:range, :root_url, :rebuild, :tags)

parse_formula = lambda do |path|
  source = File.binread(path)
  syntax_tree = Ripper.sexp(source)
  abort "could not parse Formula source: #{path}" if syntax_tree.nil?
  abort "Formula source contains CRLF or a missing final newline: #{path}" unless source.end_with?("\n") && !source.include?("\r")

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
  starts = lines.each_index.select { |index| lines[index] == "  bottle do\n" }
  abort "Formula source has multiple bottle blocks: #{path}" if starts.length > 1
  abort "Formula source contains a noncanonical bottle block: #{path}" unless bottle_nodes == starts.length

  block = nil
  if starts.length == 1
    start_index = starts.fetch(0)
    end_index = ((start_index + 1)...lines.length).find { |index| lines[index] == "  end\n" }
    abort "Formula bottle block is unterminated: #{path}" if end_index.nil?

    parsed_root = nil
    parsed_rebuild = 0
    rebuild_seen = false
    tags = {}
    lines[(start_index + 1)...end_index].each do |line|
      case line
      when /\A    root_url "([^"]+)"\n\z/
        abort "Formula bottle block has duplicate root_url: #{path}" unless parsed_root.nil?
        parsed_root = Regexp.last_match(1)
      when /\A    rebuild (0|[1-9][0-9]*)\n\z/
        abort "Formula bottle block has duplicate rebuild: #{path}" if rebuild_seen
        parsed_rebuild = Integer(Regexp.last_match(1), 10)
        rebuild_seen = true
      when /\A    sha256 cellar: (:[a-z_]+|"[^"]+"), ((?:wasm32|wasm64)_kandelo): "([0-9a-f]{64})"\n\z/
        parsed_cellar = Regexp.last_match(1)
        tag = Regexp.last_match(2)
        digest = Regexp.last_match(3)
        abort "Formula bottle block has duplicate #{tag}: #{path}" if tags.key?(tag)
        tags[tag] = [parsed_cellar, digest]
      else
        abort "Formula bottle block contains unsupported executable or noncanonical content: #{path}: #{line.inspect}"
      end
    end
    abort "Formula bottle block lacks root_url: #{path}" if parsed_root.nil?
    abort "Formula bottle block uses explicit rebuild 0: #{path}" if rebuild_seen && parsed_rebuild.zero?
    block = BottleBlock.new(start_index..end_index, parsed_root, parsed_rebuild, tags)
  end

  [source, lines, block]
end

current_source, current_lines, current = parse_formula.call(current_path)
_planned_source, _planned_lines, planned = parse_formula.call(planned_path)

if sibling_policy == "preserve" && planned && current.nil?
  abort "refreshed Formula removed the planned bottle block"
end
if sibling_policy == "preserve" && current
  abort "refreshed Formula bottle root differs from publication root" unless current.root_url == root_url
  abort "refreshed Formula bottle rebuild differs from publication rebuild" unless current.rebuild == rebuild
end
planned_selected = planned&.tags&.fetch(selected_tag, nil)
current_selected = current&.tags&.fetch(selected_tag, nil)
desired_selected = [cellar_dsl, sha256]
unless current_selected.nil? || current_selected == planned_selected || current_selected == desired_selected
  abort "refreshed Formula selected bottle tag changed after the planned tap commit"
end

tags = sibling_policy == "preserve" && current ? current.tags.dup : {}
tags[selected_tag] = desired_selected

rendered = ["  bottle do\n", "    root_url \"#{root_url}\"\n"]
rendered << "    rebuild #{rebuild}\n" unless rebuild.zero?
tags.keys.sort.each do |tag|
  tag_cellar, tag_sha = tags.fetch(tag)
  rendered << "    sha256 cellar: #{tag_cellar}, #{tag}: \"#{tag_sha}\"\n"
end
rendered << "  end\n"

if current
  current_lines[current.range] = rendered
else
  class_end = current_lines.rindex("end\n")
  abort "Formula source lacks a final class end: #{current_path}" if class_end.nil?
  insertion = rendered.dup
  insertion.unshift("\n") unless class_end.positive? && current_lines[class_end - 1] == "\n"
  insertion << "\n"
  current_lines.insert(class_end, *insertion)
end

output = current_lines.join
abort "composed Formula source is not valid Ruby" if Ripper.sexp(output).nil?
File.binwrite(out_path, output)
