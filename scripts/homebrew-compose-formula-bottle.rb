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

method_name = nil
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

parse_formula = lambda do |path|
  source = File.binread(path)
  syntax_tree = Ripper.sexp(source)
  abort "could not parse Formula source: #{path}" if syntax_tree.nil?
  abort "Formula source contains CRLF or a missing final newline: #{path}" unless source.end_with?("\n") && !source.include?("\r")

  bottle_nodes = []
  formula_classes = []
  inspect_structure = nil
  inspect_structure = lambda do |node|
    next unless node.is_a?(Array)

    bottle_nodes << node if node.first == :method_add_block && method_name.call(node[1]) == "bottle"
    if node.first == :class
      superclass = node[2]
      superclass_token = superclass[1] if superclass.is_a?(Array) && superclass.first == :var_ref
      if superclass_token.is_a?(Array) && superclass_token.first == :@const &&
         superclass_token[1] == "Formula"
        formula_classes << node
      end
    end
    node.each { |child| inspect_structure.call(child) }
  end
  inspect_structure.call(syntax_tree)
  abort "Formula source must define exactly one Formula subclass: #{path}" unless formula_classes.length == 1
  class_body = formula_classes.fetch(0)[3]
  class_statements = if class_body.is_a?(Array) && class_body.first == :bodystmt &&
                        class_body.drop(2).all?(&:nil?)
    class_body[1]
  end
  abort "Formula class has no canonical body: #{path}" unless class_statements.is_a?(Array)
  direct_bottle_nodes = class_statements.select do |statement|
    statement.is_a?(Array) && statement.first == :method_add_block &&
      method_name.call(statement[1]) == "bottle"
  end

  lines = source.lines
  starts = lines.each_index.select { |index| lines[index] == "  bottle do\n" }
  abort "Formula source has multiple bottle blocks: #{path}" if starts.length > 1
  unless bottle_nodes.length == starts.length && direct_bottle_nodes.length == starts.length
    abort "Formula source contains a bottle block outside the direct Formula class body: #{path}"
  end

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
  candidates = current_lines.each_index.select { |index| current_lines[index] == "end\n" }
  valid_candidates = candidates.select do |class_end|
    candidate_lines = current_lines.dup
    insertion = rendered.dup
    insertion.unshift("\n") unless class_end.positive? && candidate_lines[class_end - 1] == "\n"
    insertion << "\n"
    candidate_lines.insert(class_end, *insertion)
    syntax_tree = Ripper.sexp(candidate_lines.join)
    next false if syntax_tree.nil?

    formula_classes = []
    visit = nil
    visit = lambda do |node|
      next unless node.is_a?(Array)

      if node.first == :class
        superclass = node[2]
        superclass_token = superclass[1] if superclass.is_a?(Array) && superclass.first == :var_ref
        if superclass_token.is_a?(Array) && superclass_token.first == :@const &&
           superclass_token[1] == "Formula"
          formula_classes << node
        end
      end
      node.each { |child| visit.call(child) }
    end
    visit.call(syntax_tree)
    next false unless formula_classes.length == 1

    body = formula_classes.fetch(0)[3]
    statements = if body.is_a?(Array) && body.first == :bodystmt && body.drop(2).all?(&:nil?)
      body[1]
    end
    statements.is_a?(Array) && statements.count do |statement|
      statement.is_a?(Array) && statement.first == :method_add_block &&
        method_name.call(statement[1]) == "bottle"
    end == 1
  end
  unless valid_candidates.length == 1
    abort "Formula source lacks one structurally unambiguous Formula class end: #{current_path}"
  end
  class_end = valid_candidates.fetch(0)
  insertion = rendered.dup
  insertion.unshift("\n") unless class_end.positive? && current_lines[class_end - 1] == "\n"
  insertion << "\n"
  current_lines.insert(class_end, *insertion)
end

output = current_lines.join
abort "composed Formula source is not valid Ruby" if Ripper.sexp(output).nil?
File.binwrite(out_path, output)
