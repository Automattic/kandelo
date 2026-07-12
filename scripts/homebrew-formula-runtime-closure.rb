#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "pathname"
require "ripper"
require "set"

unless ARGV.length.between?(3, 4)
  abort "usage: homebrew-formula-runtime-closure.rb <tap-root> <owner/repo> <formula> [wasm32|wasm64]"
end

MAX_FORMULA_BYTES = 1_048_576
MAX_DEPENDENCIES = 128
FORMULA_NAME = /\A[a-z0-9][a-z0-9._-]*\z/
TAP_REPOSITORY = /\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/
DEPENDENCY_LINE = /\A  depends_on "([^"]+)"(?: => (:[a-z]+|\[(?::[a-z]+)(?:, :[a-z]+)*\]))?\n\z/
ALLOWED_TAGS = Set[:build, :test, :optional, :recommended].freeze
ALLOWED_CLASS_COMMANDS = Set[
  "depends_on", "desc", "homepage", "include", "license", "link_overwrite",
  "mirror", "patch", "revision", "sha256", "skip_clean", "url", "version",
].freeze
ALLOWED_CLASS_BLOCKS = Set["bottle", "patch", "test"].freeze
ALLOWED_CLASS_CONSTANTS = Set["CLEANUP_WRAPPERS", "GUEST_OPT_PREFIX"].freeze
ALLOWED_INSTANCE_METHODS = Set[
  "install", "normalize_wasm_cleanup_callbacks", "verify_archive_paths!",
  "write_wasm_wrapper_sources",
].freeze
FORBIDDEN_DEPENDENCY_IDENTIFIERS = Set[
  "Dependency", "Requirement", "__send__", "class_eval", "const_get", "define_method",
  "define_singleton_method", "dependencies", "deps", "eval", "instance_eval",
  "instance_variable_get", "instance_variable_set", "method", "method_missing",
  "module_eval", "public_method", "public_send", "requirements", "runtime_dependencies",
  "send", "singleton_method", "uses_from_macos",
].freeze
EXCLUDED_TAG_SETS = Set[
  Set[:build],
  Set[:test],
  Set[:optional],
  Set[:build, :test],
].freeze

tap_input, repository, target, output_arch = ARGV
abort "invalid tap repository: #{repository}" unless TAP_REPOSITORY.match?(repository)
abort "invalid target Formula: #{target}" unless FORMULA_NAME.match?(target)
abort "invalid output architecture: #{output_arch}" unless output_arch.nil? || %w[wasm32 wasm64].include?(output_arch)
tap_name = repository.downcase
tap_owner, tap_repository = tap_name.split("/", 2)
support_require_line = %(require (Tap.fetch("#{tap_owner}", "#{tap_repository}").path/"Kandelo/formula_support/kandelo_formula_support").to_s\n)
allowed_top_level_requires = Set[
  "require \"shellwords\"\n",
  support_require_line,
].freeze

tap_path = Pathname.new(tap_input)
abort "tap root must be a real directory: #{tap_input}" if tap_path.symlink? || !tap_path.directory?
tap_root = tap_path.realpath
formula_dir = tap_root/"Formula"
abort "Formula directory must be a real directory: #{formula_dir}" if formula_dir.symlink? || !formula_dir.directory?

call_name = nil
call_name = lambda do |node|
  next nil unless node.is_a?(Array)

  case node.first
  when :command
    node.dig(1, 1)
  when :method_add_arg, :method_add_block
    call_name.call(node[1])
  when :fcall, :vcall
    node.dig(1, 1)
  end
end

call_position = nil
call_position = lambda do |node|
  next nil unless node.is_a?(Array)

  case node.first
  when :command, :fcall, :vcall
    token = node[1]
    token[2] if token.is_a?(Array) && token.first == :@ident
  when :method_add_arg, :method_add_block
    call_position.call(node[1])
  end
end

static_expression = nil
static_expression = lambda do |node|
  next true if node.nil? || node == false
  next false unless node.is_a?(Array)

  kind = node.first
  next node.all? { |child| static_expression.call(child) } unless kind.is_a?(Symbol)
  if kind.is_a?(Symbol) && kind.to_s.start_with?("@")
    next [:@const, :@ident, :@int, :@kw, :@label, :@tstring_content].include?(kind)
  end
  case kind
  when :args_add_block, :array, :assoc_new, :assoclist_from_args, :bare_assoc_hash,
       :hash, :string_content, :string_literal, :symbol, :symbol_literal, :var_ref
    node.drop(1).all? { |child| static_expression.call(child) }
  when :call
    method = node[3]
    method.is_a?(Array) && method.first == :@ident && method[1] == "freeze" &&
      static_expression.call(node[1])
  else
    false
  end
end

identifier_positions = lambda do |source|
  Ripper.lex(source).each_with_object([]) do |(position, type, token, _state), positions|
    positions << position if type == :on_ident && token == "depends_on"
  end
end

formula_class = lambda do |syntax_tree, path, expected_name|
  classes = []
  visit = nil
  visit = lambda do |node|
    next unless node.is_a?(Array)

    if node.first == :class
      superclass = node[2]
      superclass_token = superclass[1] if superclass.is_a?(Array) && superclass.first == :var_ref
      if superclass_token.is_a?(Array) &&
         superclass_token.first == :@const && superclass_token[1] == "Formula"
        classes << node
      end
    end
    node.each { |child| visit.call(child) }
  end
  visit.call(syntax_tree)
  abort "Formula source must contain exactly one direct Formula subclass: #{path}" unless classes.length == 1
  selected = classes.fetch(0)
  class_token = selected.dig(1, 1)
  unless class_token.is_a?(Array) && class_token.first == :@const && class_token[1] == expected_name
    abort "Formula class must be #{expected_name}: #{path}"
  end
  selected
end

direct_dependency_positions = lambda do |class_node|
  body = class_node[3]
  statements = if body.is_a?(Array) && body.first == :bodystmt && body.drop(2).all?(&:nil?)
    body[1]
  end
  abort "Formula class has no canonical body" unless statements.is_a?(Array)

  statements.each_with_object([]) do |statement, positions|
    next unless statement.is_a?(Array) && statement.first == :command

    identifier = statement[1]
    next unless identifier.is_a?(Array) && identifier.first == :@ident && identifier[1] == "depends_on"

    positions << identifier[2]
  end
end

parse_tags = lambda do |literal, path, line_number|
  next Set.new if literal.nil?

  tags = literal.scan(/:([a-z]+)/).flatten.map(&:to_sym).to_set
  unless tags.any? && tags.subset?(ALLOWED_TAGS)
    abort "unsupported dependency tags at #{path}:#{line_number}"
  end
  unless tags == Set[:recommended] || EXCLUDED_TAG_SETS.include?(tags)
    abort "unsupported dependency tag combination at #{path}:#{line_number}"
  end
  tags
end

parse_bottle = lambda do |statement, lines, path|
  position = call_position.call(statement)
  line_number = position[0] if position.is_a?(Array)
  unless line_number.is_a?(Integer) && lines.fetch(line_number - 1) == "  bottle do\n"
    abort "Formula bottle block must use canonical syntax: #{path}"
  end
  end_index = (line_number...lines.length).find { |index| lines[index] == "  end\n" }
  abort "Formula bottle block is unterminated: #{path}" if end_index.nil?

  root_url = nil
  rebuild = 0
  seen_rebuild = false
  tags = {}
  lines[line_number...end_index].each do |line|
    case line
    when /\A    root_url "(https:\/\/ghcr\.io\/v2\/[a-z0-9._\/-]+)"\n\z/
      abort "Formula bottle block repeats root_url: #{path}" unless root_url.nil?
      root_url = Regexp.last_match(1)
      abort "Formula bottle root_url may not end with a slash: #{path}" if root_url.end_with?("/")
    when /\A    rebuild ([1-9][0-9]*)\n\z/
      abort "Formula bottle block repeats rebuild: #{path}" if seen_rebuild
      rebuild = Integer(Regexp.last_match(1), 10)
      seen_rebuild = true
    when /\A    sha256 cellar: (:[a-z_]+|"[^"]+"), ((?:wasm32|wasm64)_kandelo): "([0-9a-f]{64})"\n\z/
      cellar_literal = Regexp.last_match(1)
      tag = Regexp.last_match(2)
      sha256 = Regexp.last_match(3)
      cellar = cellar_literal.start_with?(":") ? cellar_literal.delete_prefix(":") : cellar_literal[1...-1]
      unless ["any", "any_skip_relocation", "/home/linuxbrew/.linuxbrew/Cellar"].include?(cellar)
        abort "Formula bottle block uses an unsupported cellar: #{path}"
      end
      abort "Formula bottle block repeats tag #{tag}: #{path}" if tags.key?(tag)
      tags[tag] = {"cellar" => cellar, "sha256" => sha256}
    else
      abort "Formula bottle block contains unsupported content: #{path}"
    end
  end
  unless !root_url.nil? && tags.length.between?(1, 2)
    abort "Formula bottle block is not canonical static bottle data: #{path}"
  end
  {"rebuild" => rebuild, "root_url" => root_url, "tags" => tags}
end

validate_static_block = lambda do |statement, path, label, allowed_commands|
  block = statement[2]
  body = block[2] if block.is_a?(Array) && block.first == :do_block && block[1].nil?
  unless body.is_a?(Array) && body.first == :bodystmt && body.drop(2).all?(&:nil?)
    abort "Formula #{label} block must have a canonical static body: #{path}"
  end
  statements = body[1]
  abort "Formula #{label} block has no canonical statements: #{path}" unless statements.is_a?(Array)
  statements.each do |child|
    method = call_name.call(child)
    unless child.is_a?(Array) && child.first == :command && allowed_commands.include?(method)
      abort "Formula #{label} block uses unsupported call #{method.inspect}: #{path}"
    end
    unless static_expression.call(child[2])
      abort "Formula #{label} block arguments must be static: #{path}"
    end
  end
end

support_validated = false
validate_support = lambda do
  next if support_validated

  kandelo_dir = tap_root/"Kandelo"
  support_dir = kandelo_dir/"formula_support"
  support_path = support_dir/"kandelo_formula_support.rb"
  [kandelo_dir, support_dir].each do |directory|
    if directory.symlink? || !directory.directory?
      abort "Kandelo Formula support path must be a real directory: #{directory}"
    end
  end
  if support_path.symlink? || !support_path.file?
    abort "Kandelo Formula support must be a regular non-symlink file: #{support_path}"
  end
  if support_path.size > MAX_FORMULA_BYTES
    abort "Kandelo Formula support exceeds #{MAX_FORMULA_BYTES} bytes: #{support_path}"
  end
  support_source = support_path.binread
  unless support_source.end_with?("\n") && !support_source.include?("\r")
    abort "Kandelo Formula support contains CRLF or lacks a final newline: #{support_path}"
  end
  support_tree = Ripper.sexp(support_source)
  abort "could not parse Kandelo Formula support: #{support_path}" if support_tree.nil?
  top_level = support_tree[1]
  unless top_level.is_a?(Array) && top_level.length == 4
    abort "Kandelo Formula support must contain three requires and one module: #{support_path}"
  end
  expected_requires = [
    "require \"fileutils\"\n",
    "require \"json\"\n",
    "require \"shellwords\"\n",
  ]
  support_lines = support_source.lines
  top_level.first(3).each_with_index do |statement, index|
    position = call_position.call(statement)
    line_number = position[0] if position.is_a?(Array)
    line = support_lines.fetch(line_number - 1) if line_number.is_a?(Integer)
    unless call_name.call(statement) == "require" && line == expected_requires[index]
      abort "Kandelo Formula support has a noncanonical require: #{support_path}"
    end
  end
  module_node = top_level.fetch(3)
  module_name = module_node.dig(1, 1) if module_node.is_a?(Array) && module_node.first == :module
  unless module_name.is_a?(Array) && module_name.first == :@const && module_name[1] == "KandeloFormulaSupport"
    abort "Kandelo Formula support must define only KandeloFormulaSupport: #{support_path}"
  end
  module_bodystmt = module_node[2]
  unless module_bodystmt.is_a?(Array) && module_bodystmt.first == :bodystmt &&
         module_bodystmt.drop(2).all?(&:nil?)
    abort "Kandelo Formula support has no canonical module body: #{support_path}"
  end
  module_body = module_bodystmt[1]
  abort "Kandelo Formula support has no canonical statements: #{support_path}" unless module_body.is_a?(Array)
  methods = Set.new
  module_body.each do |statement|
    next if statement.is_a?(Array) && statement.first == :void_stmt

    method_token = statement[1] if statement.is_a?(Array) && statement.first == :def
    method = method_token[1] if method_token.is_a?(Array) && method_token.first == :@ident
    unless method&.match?(/\Akandelo_[a-z0-9_!?]+\z/) && methods.add?(method)
      abort "Kandelo Formula support may contain only unique kandelo_ instance methods: #{support_path}"
    end
  end
  support_validated = true
end

formula_bottles = {}
parse_formula = lambda do |name|
  abort "invalid dependency Formula: #{name}" unless FORMULA_NAME.match?(name)
  path = tap_root/"Formula"/"#{name}.rb"
  abort "dependency Formula must be a regular non-symlink file: #{path}" if path.symlink? || !path.file?
  abort "dependency Formula exceeds #{MAX_FORMULA_BYTES} bytes: #{path}" if path.size > MAX_FORMULA_BYTES

  source = path.binread
  abort "Formula source contains CRLF or lacks a final newline: #{path}" unless source.end_with?("\n") && !source.include?("\r")
  syntax_tree = Ripper.sexp(source)
  abort "could not parse Formula source: #{path}" if syntax_tree.nil?
  lines = source.lines

  forbidden = Ripper.lex(source).find do |_position, type, token, _state|
    ((type == :on_ident || type == :on_const) && FORBIDDEN_DEPENDENCY_IDENTIFIERS.include?(token)) ||
      (type == :on_ivar && token == "@deps")
  end
  unless forbidden.nil?
    position, _type, token, = forbidden
    abort "Formula uses forbidden dependency metaprogramming #{token.inspect} at #{path}:#{position.first}"
  end

  expected_class = name.split(/[^A-Za-z0-9]+/).map(&:capitalize).join
  selected_class = formula_class.call(syntax_tree, path, expected_class)
  top_level = syntax_tree[1]
  abort "Formula source has no canonical top-level body: #{path}" unless top_level.is_a?(Array)
  seen_class = false
  seen_requires = Set.new
  top_level.each do |statement|
    unless statement.is_a?(Array)
      abort "Formula source contains a malformed top-level statement: #{path}"
    end
    if statement.equal?(selected_class)
      abort "Formula class must be the final top-level statement: #{path}" if seen_class
      seen_class = true
      next
    end
    abort "Formula source may not execute statements after its class: #{path}" if seen_class
    identifier = statement[1] if statement.first == :command
    line_number = identifier[2][0] if identifier.is_a?(Array) && identifier.first == :@ident
    line = lines.fetch(line_number - 1) if line_number.is_a?(Integer)
    unless call_name.call(statement) == "require" && allowed_top_level_requires.include?(line)
      abort "Formula source uses an unsupported top-level statement: #{path}"
    end
    abort "Formula source repeats a top-level require: #{path}" unless seen_requires.add?(line)
  end
  abort "Formula class must be a direct top-level statement: #{path}" unless seen_class
  validate_support.call if seen_requires.include?(support_require_line)

  class_bodystmt = selected_class[3]
  unless class_bodystmt.is_a?(Array) && class_bodystmt.first == :bodystmt &&
         class_bodystmt.drop(2).all?(&:nil?)
    abort "Formula class has no canonical body: #{path}"
  end
  class_body = class_bodystmt[1]
  abort "Formula class has no canonical statements: #{path}" unless class_body.is_a?(Array)
  seen_instance_methods = Set.new
  bottle = nil
  class_body.each do |statement|
    abort "Formula class contains a malformed statement: #{path}" unless statement.is_a?(Array)
    case statement.first
    when :command
      method = call_name.call(statement)
      abort "Formula class uses unsupported DSL call #{method.inspect}: #{path}" unless ALLOWED_CLASS_COMMANDS.include?(method)
      abort "Formula class DSL arguments must be static: #{path}" unless static_expression.call(statement[2])
      if method == "include"
        line_number = statement.dig(1, 2, 0)
        unless line_number.is_a?(Integer) && lines.fetch(line_number - 1) == "  include KandeloFormulaSupport\n"
          abort "Formula may include only KandeloFormulaSupport: #{path}"
        end
        validate_support.call
      end
    when :method_add_block
      method = call_name.call(statement)
      abort "Formula class uses unsupported DSL block #{method.inspect}: #{path}" unless ALLOWED_CLASS_BLOCKS.include?(method)
      if method == "bottle"
        abort "Formula class has multiple bottle blocks: #{path}" unless bottle.nil?
        bottle = parse_bottle.call(statement, lines, path)
      elsif method == "patch"
        validate_static_block.call(statement, path, "patch", Set["apply", "sha256", "type", "url"])
      end
    when :def
      method_token = statement[1]
      method = method_token[1] if method_token.is_a?(Array) && method_token.first == :@ident
      unless ALLOWED_INSTANCE_METHODS.include?(method) && seen_instance_methods.add?(method)
        abort "Formula class defines an unsupported or duplicate instance method #{method.inspect}: #{path}"
      end
    when :assign
      left = statement[1]
      constant = left.dig(1) if left.is_a?(Array) && left.first == :var_field
      unless constant.is_a?(Array) && constant.first == :@const &&
             ALLOWED_CLASS_CONSTANTS.include?(constant[1]) && static_expression.call(statement[2])
        abort "Formula class assignment must be a static constant: #{path}"
      end
    when :vcall
      abort "Formula class uses an unsupported bare call: #{path}" unless call_name.call(statement) == "private"
    when :void_stmt
      # Ripper represents an otherwise empty class body with this inert node.
    else
      abort "Formula class uses unsupported executable structure #{statement.first.inspect}: #{path}"
    end
  end

  direct_positions = direct_dependency_positions.call(selected_class).sort
  all_positions = identifier_positions.call(source).sort
  unless all_positions == direct_positions
    abort "every depends_on must be a direct Formula class-body literal call: #{path}"
  end

  declarations = direct_positions.map do |line_number, _column|
    line = lines.fetch(line_number - 1)
    match = DEPENDENCY_LINE.match(line)
    abort "depends_on must use canonical literal syntax at #{path}:#{line_number}" if match.nil?
    [line_number, match[1], parse_tags.call(match[2], path, line_number)]
  end
  line_positions = declarations.map { |line_number, _dependency, _tags| [line_number, 2] }.sort
  unless line_positions == direct_positions
    abort "depends_on syntax does not match the parsed direct calls: #{path}"
  end

  seen = Set.new
  dependencies = declarations.each_with_object([]) do |(line_number, dependency, tags), selected|
    abort "duplicate dependency #{dependency.inspect} at #{path}:#{line_number}" unless seen.add?(dependency)
    next if EXCLUDED_TAG_SETS.include?(tags)
    next unless dependency.include?("/")

    prefix = "#{tap_name}/"
    if dependency.downcase.start_with?(prefix) && dependency != dependency.downcase
      abort "same-tap dependency must be normalized lowercase at #{path}:#{line_number}"
    end
    next unless dependency.start_with?(prefix)
    child = dependency.delete_prefix(prefix)
    abort "invalid same-tap dependency at #{path}:#{line_number}" unless FORMULA_NAME.match?(child)
    selected << child
  end
  formula_bottles[name] = bottle
  dependencies
end

closure = Set.new
states = {}
stack = []
visit_formula = nil
visit_formula = lambda do |name|
  case states[name]
  when :done
    next
  when :visiting
    cycle_start = stack.index(name) || 0
    abort "same-tap dependency cycle: #{(stack[cycle_start..] + [name]).join(" -> ")}"
  end

  states[name] = :visiting
  stack << name
  parse_formula.call(name).each do |dependency|
    closure.add("#{tap_name}/#{dependency}")
    abort "same-tap dependency closure exceeds #{MAX_DEPENDENCIES} entries" if closure.length > MAX_DEPENDENCIES
    visit_formula.call(dependency)
  end
  stack.pop
  states[name] = :done
end

visit_formula.call(target)
if output_arch.nil?
  puts closure.sort
else
  output_tag = "#{output_arch}_kandelo"
  records = closure.sort.to_h do |full_name|
    name = full_name.delete_prefix("#{tap_name}/")
    bottle = formula_bottles[name]
    abort "dependency Formula has no canonical bottle block: #{name}" if bottle.nil?
    selected = bottle.fetch("tags")[output_tag]
    abort "dependency Formula has no #{output_tag} bottle: #{name}" if selected.nil?
    sha256 = selected.fetch("sha256")
    [full_name, {
      "cellar" => selected.fetch("cellar"),
      "rebuild" => bottle.fetch("rebuild"),
      "sha256" => sha256,
      "tag" => output_tag,
      "url" => "#{bottle.fetch("root_url")}/#{name}/blobs/sha256:#{sha256}",
    }]
  end
  puts JSON.generate(records)
end
