#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "ripper"

ParsedFormula = Struct.new(:path, :source, :lines, :bottle_range)

def parse_formula(path)
  source = File.binread(path)
  syntax_tree = Ripper.sexp(source)
  abort "could not parse Formula source: #{path}" if syntax_tree.nil?
  unless source.end_with?("\n") && !source.include?("\r")
    abort "Formula source contains CRLF or a missing final newline: #{path}"
  end

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
  bottle_starts = lines.each_index.select { |index| lines[index] == "  bottle do\n" }
  abort "Formula source has multiple bottle blocks: #{path}" if bottle_starts.length > 1
  unless bottle_nodes.length == bottle_starts.length && direct_bottle_nodes.length == bottle_starts.length
    abort "Formula source contains a bottle block outside the direct Formula class body: #{path}"
  end

  bottle_range = nil
  if bottle_starts.length == 1
    start_index = bottle_starts.fetch(0)
    end_index = ((start_index + 1)...lines.length).find { |index| lines[index] == "  end\n" }
    abort "Formula bottle block is unterminated: #{path}" if end_index.nil?

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
        abort "Formula bottle block contains unsupported content: #{path}"
      end
    end
    unless root_count == 1 && rebuild_count <= 1 && tag_count.between?(1, 2)
      abort "Formula bottle block is not canonical static bottle data: #{path}"
    end
    bottle_range = start_index..end_index
  end

  ParsedFormula.new(path, source, lines, bottle_range)
end

def source_without_bottle(parsed)
  return parsed.source if parsed.bottle_range.nil?

  lines = parsed.lines.dup
  lines.slice!(parsed.bottle_range)
  lines.join
end

def source_without_new_bottle_variants(parsed)
  range = parsed.bottle_range
  return [parsed.source] if range.nil?

  stripped = parsed.lines.dup
  stripped.slice!(range)
  insertion_index = range.begin
  variants = [stripped.join]
  removable_before = insertion_index.positive? && stripped[insertion_index - 1] == "\n"
  removable_after = stripped[insertion_index] == "\n"
  [false, true].product([false, true]).each do |remove_before, remove_after|
    next if (!remove_before && !remove_after) || (remove_before && !removable_before) ||
            (remove_after && !removable_after)

    candidate = stripped.dup
    candidate.delete_at(insertion_index) if remove_after
    candidate.delete_at(insertion_index - 1) if remove_before
    variants << candidate.join
  end
  variants.uniq
end

def equivalent_excluding_bottle?(left, right)
  if left.bottle_range.nil? == right.bottle_range.nil?
    source_without_bottle(left) == source_without_bottle(right)
  elsif left.bottle_range
    source_without_new_bottle_variants(left).include?(right.source)
  else
    source_without_new_bottle_variants(right).include?(left.source)
  end
end

if ARGV.length == 3 && ARGV.fetch(0) == "--equivalent-excluding-bottle"
  left = parse_formula(ARGV.fetch(1))
  right = parse_formula(ARGV.fetch(2))
  unless equivalent_excluding_bottle?(left, right)
    warn "Formula sources differ outside canonical bottle metadata"
    exit 1
  end
  puts "equivalent"
elsif ARGV.length == 1
  parsed = parse_formula(ARGV.fetch(0))
  # The digest deliberately retains the validated block's position and line
  # count. Cross-publication comparisons use the pairwise mode above so an
  # exact composer-owned insertion/removal can be recognized without erasing
  # any other source byte.
  canonical_lines = parsed.lines.dup
  unless parsed.bottle_range.nil?
    count = parsed.bottle_range.end - parsed.bottle_range.begin + 1
    canonical_lines[parsed.bottle_range] = Array.new(count, "\n")
  end
  puts Digest::SHA256.hexdigest(canonical_lines.join)
else
  abort "usage: homebrew-formula-source-digest.rb <formula.rb> | --equivalent-excluding-bottle <left.rb> <right.rb>"
end
