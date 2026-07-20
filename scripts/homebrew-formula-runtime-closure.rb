#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "pathname"
require "ripper"
require "set"

unless ARGV.length.between?(3, 4)
  abort "usage: homebrew-formula-runtime-closure.rb <tap-root> <owner/tap> <formula> " \
        "[wasm32|wasm64|--direct|--declarations-json|--host-dependencies-json|--bottle-identity-json]"
end

MAX_FORMULA_BYTES = 1_048_576
MAX_DEPENDENCIES = 128
FORMULA_NAME = /\A[a-z0-9][a-z0-9._-]*\z/
HOST_FORMULA_NAME = /\A[a-z0-9][a-z0-9@+_.-]*\z/
TAP_NAME = /\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/
DEPENDENCY_LINE = /\A  depends_on "([^"]+)"(?: => (:[a-z]+|\[(?::[a-z]+)(?:, :[a-z]+)*\]))?\n\z/
ALLOWED_TAGS = Set[:build, :test, :optional, :recommended].freeze
ALLOWED_CLASS_COMMANDS = Set[
  "depends_on", "desc", "homepage", "include", "keg_only", "license",
  "link_overwrite", "mirror", "patch", "revision", "sha256", "skip_clean",
  "url", "version",
].freeze
ALLOWED_CLASS_BLOCKS = Set["bottle", "on_macos", "patch", "resource", "test"].freeze
ALLOWED_PUBLIC_INSTANCE_METHODS = Set[
  "caveats", "install", "verify_archive_paths!",
].freeze
FORBIDDEN_PRIVATE_INSTANCE_METHODS = Set[
  "dependencies", "initialize", "initialize_clone", "initialize_copy", "initialize_dup",
  "recursive_dependencies", "requirements",
].freeze
FORBIDDEN_DEPENDENCY_IDENTIFIERS = Set[
  "Dependency", "Requirement", "__send__", "class_eval", "const_get", "define_method",
  "define_singleton_method", "eval", "instance_eval",
  "instance_variable_get", "instance_variable_set", "method", "method_missing",
  "module_eval", "public_method", "public_send", "require_relative", "send", "singleton_method",
  "uses_from_macos",
].freeze
FORBIDDEN_SUPPORT_IDENTIFIERS = (
  FORBIDDEN_DEPENDENCY_IDENTIFIERS +
    Set[
      "Tap", "__FILE__", "__dir__", "autoload", "binding", "load",
      "local_variable_get", "local_variable_set", "require", "tap",
    ]
).freeze
EXCLUDED_TAG_SETS = Set[
  Set[:build],
  Set[:test],
  Set[:optional],
  Set[:build, :test],
].freeze

tap_input, requested_tap_name, target, output_mode = ARGV
abort "invalid tap name: #{requested_tap_name}" unless TAP_NAME.match?(requested_tap_name)
abort "invalid target Formula: #{target}" unless FORMULA_NAME.match?(target)
abort "invalid output mode: #{output_mode}" unless output_mode.nil? || %w[wasm32 wasm64 --direct --declarations-json --host-dependencies-json --bottle-identity-json].include?(output_mode)
direct_only = output_mode == "--direct"
declarations_only = output_mode == "--declarations-json"
host_dependencies_only = output_mode == "--host-dependencies-json"
bottle_identity_only = output_mode == "--bottle-identity-json"
output_arch = direct_only || declarations_only || host_dependencies_only || bottle_identity_only ? nil : output_mode
tap_name = requested_tap_name.downcase
tap_owner, tap_repository = tap_name.split("/", 2)

tap_path = Pathname.new(tap_input)
abort "tap root must be a real directory: #{tap_input}" if tap_path.symlink? || !tap_path.directory?
tap_root = tap_path.realpath
primary_formula_dir = tap_root/"Formula"
abort "Formula directory must be a real directory: #{primary_formula_dir}" if primary_formula_dir.symlink? || !primary_formula_dir.directory?

repository_for_tap = lambda do |name|
  owner, short_name = name.split("/", 2)
  "#{owner}/homebrew-#{short_name}"
end

tap_contexts = {
  tap_name => {
    "tap_name" => tap_name,
    "tap_repository" => repository_for_tap.call(tap_name),
    "tap_commit" => nil,
    "root" => tap_root,
  },
}
resolved_taps_path = ENV["KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"]
unless resolved_taps_path.nil? || resolved_taps_path.empty?
  resolved_path = Pathname.new(resolved_taps_path)
  if resolved_path.symlink? || !resolved_path.file? || resolved_path.size > 65_536
    abort "resolved tap map must be a bounded regular non-symlink file: #{resolved_path}"
  end
  if (resolved_path.stat.mode & 0o022) != 0
    abort "resolved tap map must not be group- or world-writable: #{resolved_path}"
  end
  begin
    resolved_document = JSON.parse(resolved_path.binread)
  rescue JSON::ParserError => e
    abort "resolved tap map is not valid JSON: #{e.message}"
  end
  unless resolved_document.is_a?(Hash) && resolved_document.keys.sort == %w[dependencies primary schema] &&
         resolved_document["schema"] == 1 && resolved_document["dependencies"].is_a?(Array) &&
         resolved_document["dependencies"].length <= 8
    abort "resolved tap map has an unexpected schema"
  end
  contexts = [resolved_document["primary"], *resolved_document["dependencies"]]
  contexts.each_with_index do |context, index|
    unless context.is_a?(Hash) && context.keys.sort == %w[root tap_commit tap_name tap_repository]
      abort "resolved tap map context #{index} has an unexpected schema"
    end
    context_name = context["tap_name"]
    context_repository = context["tap_repository"]
    context_commit = context["tap_commit"]
    unless context_name.is_a?(String) && context_name == context_name.downcase &&
           TAP_NAME.match?(context_name) &&
           context_repository == repository_for_tap.call(context_name) &&
           context_commit.is_a?(String) && context_commit.match?(/\A[0-9a-f]{40}\z/)
      abort "resolved tap map context #{index} has an invalid immutable identity"
    end
    unless context["root"].is_a?(String) && Pathname.new(context["root"]).absolute?
      abort "resolved tap map context #{index} root must be absolute"
    end
    context_path = Pathname.new(context["root"])
    if context_path.symlink? || !context_path.directory?
      abort "resolved tap map context #{index} root must be a real directory"
    end
    context_root = context_path.realpath
    formula_dir = context_root/"Formula"
    if formula_dir.symlink? || !formula_dir.directory?
      abort "resolved tap map context #{index} Formula directory must be real"
    end
    if tap_contexts.key?(context_name) && index != 0
      abort "resolved tap map repeats tap #{context_name}"
    end
    tap_contexts[context_name] = {
      "tap_name" => context_name,
      "tap_repository" => context_repository,
      "tap_commit" => context_commit,
      "root" => context_root,
    }
  end
  primary = tap_contexts.fetch(tap_name)
  unless resolved_document["primary"]["tap_name"] == tap_name &&
         resolved_document["primary"]["tap_repository"] == repository_for_tap.call(tap_name)
    abort "resolved tap map primary identity differs from the selected tap"
  end
  # The publication verifier reconstructs the selected Formula in a separate
  # bounded tap tree at the same base commit. Keep the caller-provided primary
  # root authoritative while retaining exact external roots from the map.
  primary["root"] = tap_root
end

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
       :hash, :string_content, :string_embexpr, :string_literal, :symbol,
       :symbol_literal, :var_ref
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

no_argument_block = lambda do |statement|
  call = statement[1]
  call.is_a?(Array) && call.first == :method_add_arg && call[2] == []
end

validate_resource = lambda do |statement, lines, path|
  position = call_position.call(statement)
  line_number = position[0] if position.is_a?(Array)
  line = lines.fetch(line_number - 1) if line_number.is_a?(Integer)
  unless line&.match?(/\A  resource "[A-Za-z0-9][A-Za-z0-9._+-]*" do\n\z/)
    abort "Formula resource block must use a canonical literal name: #{path}"
  end
  command = statement[1]
  arguments = command[2] if command.is_a?(Array) && command.first == :command
  unless static_expression.call(arguments)
    abort "Formula resource block name must be static: #{path}"
  end
  validate_static_block.call(statement, path, "resource", Set["mirror", "sha256", "url", "version"])
end

canonical_support_child = lambda do |node|
  next nil unless node.is_a?(Array) && node.first == :binary && node[2] == :/

  pathname_call = node[1]
  next nil unless pathname_call.is_a?(Array) && pathname_call.first == :method_add_arg
  function = pathname_call[1]
  arguments = pathname_call[2]
  pathname_token = function[1] if function.is_a?(Array) && function.first == :fcall
  next nil unless pathname_token.is_a?(Array) &&
                  pathname_token.first == :@const && pathname_token[1] == "Pathname"
  next nil unless arguments.is_a?(Array) && arguments.first == :arg_paren
  argument_list = arguments[1]
  next nil unless argument_list.is_a?(Array) && argument_list.first == :args_add_block &&
                  argument_list[1].is_a?(Array) && argument_list[1].length == 1 &&
                  argument_list[2] == false
  dir_call = argument_list[1].first
  dir_token = dir_call[1] if dir_call.is_a?(Array) && dir_call.first == :vcall
  next nil unless dir_token.is_a?(Array) &&
                  dir_token.first == :@ident && dir_token[1] == "__dir__"

  string = node[3]
  content = string[1] if string.is_a?(Array) && string.first == :string_literal
  literal_token = content[1] if content.is_a?(Array) &&
                                content.first == :string_content && content.length == 2
  next nil unless literal_token.is_a?(Array) && literal_token.first == :@tstring_content
  basename = literal_token[1]
  next nil unless basename.match?(/\A[A-Za-z0-9][A-Za-z0-9._-]*\z/)

  [basename, dir_token[2], literal_token[2]]
end

local_reference = lambda do |node, name|
  next false unless node.is_a?(Array) && [:var_ref, :vcall].include?(node.first)

  token = node[1]
  token.is_a?(Array) && token.first == :@ident && token[1] == name
end

to_s_call = lambda do |node, name|
  node.is_a?(Array) && node.first == :call &&
    local_reference.call(node[1], name) && node.dig(3, 1) == "to_s"
end

shellwords_escape = lambda do |node, name|
  next false unless node.is_a?(Array) && node.first == :method_add_arg

  call = node[1]
  arguments = node[2]
  shellwords = call[1] if call.is_a?(Array) && call.first == :call
  constant = shellwords[1] if shellwords.is_a?(Array) && shellwords.first == :var_ref
  next false unless constant.is_a?(Array) && constant.first == :@const &&
                    constant[1] == "Shellwords" && call.dig(3, 1) == "escape"
  next false unless arguments.is_a?(Array) && arguments.first == :arg_paren

  argument_list = arguments[1]
  argument_list.is_a?(Array) && argument_list.first == :args_add_block &&
    argument_list[1].is_a?(Array) && argument_list[1].length == 1 &&
    to_s_call.call(argument_list[1].first, name) && argument_list[2] == false
end

canonical_escape_map_block = lambda do |node|
  next false unless node.is_a?(Array) && node.first == :brace_block

  block_var = node[1]
  params = block_var[1] if block_var.is_a?(Array) && block_var.first == :block_var &&
                           block_var[2] == false
  required = params[1] if params.is_a?(Array) && params.first == :params &&
                          params.drop(2).all?(&:nil?)
  body = node[2]
  required.is_a?(Array) && required.length == 1 &&
    required.first.is_a?(Array) && required.first.first == :@ident &&
    required.first[1] == "arg" && body.is_a?(Array) && body.length == 1 &&
    shellwords_escape.call(body.first, "arg")
end

literal_string = lambda do |node, expected|
  content = node[1] if node.is_a?(Array) && node.first == :string_literal
  token = content[1] if content.is_a?(Array) && content.first == :string_content &&
                        content.length == 2
  token.is_a?(Array) && token.first == :@tstring_content && token[1] == expected
end

direct_statement = nil
direct_statement = lambda do |node, ancestors|
  parent = ancestors[-1]
  container = ancestors[-2]
  next false unless parent.is_a?(Array) && !parent.first.is_a?(Symbol) &&
                    parent.any? { |child| child.equal?(node) }

  case container&.first
  when :bodystmt
    owner = ancestors[-3]
    container[1].equal?(parent) && owner&.first == :def && owner[3].equal?(container)
  when :if, :unless, :elsif, :else
    body_matches = if container.first == :else
      container[1].equal?(parent)
    else
      container[2].equal?(parent)
    end
    next false unless body_matches

    control = container
    control_index = ancestors.length - 2
    while [:elsif, :else].include?(control.first)
      owner_index = control_index - 1
      owner = ancestors[owner_index]
      next false unless owner.is_a?(Array) && [:if, :unless, :elsif].include?(owner.first) &&
                        owner[3].equal?(control)

      control = owner
      control_index = owner_index
    end
    next false unless [:if, :unless].include?(control.first)

    direct_statement.call(control, ancestors.take(control_index))
  else
    false
  end
end

find_forbidden_support_token = nil
find_forbidden_support_token = lambda do |node, allowed_nodes = Set.new|
  next nil unless node.is_a?(Array)
  next nil if allowed_nodes.include?(node.object_id)

  if [:@ident, :@const, :@kw].include?(node.first) &&
     FORBIDDEN_SUPPORT_IDENTIFIERS.include?(node[1])
    next [node[1], node[2]]
  end
  found = nil
  node.each do |child|
    found = find_forbidden_support_token.call(child, allowed_nodes)
    break unless found.nil?
  end
  found
end

support_validated = Set.new
validate_support = lambda do |context|
  context_tap_name = context.fetch("tap_name")
  next if support_validated.include?(context_tap_name)

  context_root = context.fetch("root")
  kandelo_dir = context_root/"Kandelo"
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

    case statement.first
    when :def
      method_token = statement[1]
      method = method_token[1] if method_token.is_a?(Array) && method_token.first == :@ident
      unless method&.match?(/\A(?:formula_opt|kandelo)_[a-z0-9_]*[!?]?\z/) && methods.add?(method)
        abort "Kandelo Formula support may contain only unique approved instance methods: #{support_path}"
      end
      allowed_nodes = Set.new
      support_child_binding = nil
      find_support_children = nil
      find_support_children = lambda do |node, ancestors|
        next unless node.is_a?(Array)

        if node.first == :assign
          left = node[1]
          variable = left[1] if left.is_a?(Array) && left.first == :var_field
          child = canonical_support_child.call(node[2])
          if variable.is_a?(Array) && variable.first == :@ident &&
             variable[1] == "runner" && !child.nil?
            basename, dir_position, literal_position = child
            line_number, column = variable[2]
            expected_line = "#{" " * column}#{variable[1]} = Pathname(__dir__)/\"#{basename}\"\n"
            candidate = support_dir/basename
            if dir_position[0] == line_number && literal_position[0] == line_number &&
               support_lines.fetch(line_number - 1) == expected_line &&
               direct_statement.call(node, ancestors) &&
               candidate.parent == support_dir &&
               !candidate.symlink? && candidate.file?
              unless support_child_binding.nil?
                abort "Kandelo Formula support method binds more than one local support child: " \
                      "#{support_path}:#{line_number}"
              end
              support_child_binding = {
                variable: variable,
              }
              allowed_nodes << node[2].object_id
              next
            end
          end
        end
        node.each { |child_node| find_support_children.call(child_node, ancestors + [node]) }
      end
      find_support_children.call(statement, [])
      forbidden = find_forbidden_support_token.call(statement, allowed_nodes)
      unless forbidden.nil?
        token, position = forbidden
        abort "Kandelo Formula support method uses forbidden local source operation " \
              "#{token.inspect} at #{support_path}:#{position.first}"
      end
      unless support_child_binding.nil?
        support_child_references = 0
        validate_support_child_uses = nil
        validate_support_child_uses = lambda do |node, ancestors|
          next unless node.is_a?(Array)

          if node.first == :@ident && node[1] == "runner"
            unless node.equal?(support_child_binding.fetch(:variable))
              support_child_references += 1
              semantic_ancestors = ancestors.reverse.select do |ancestor|
                ancestor.is_a?(Array) && ancestor.first.is_a?(Symbol)
              end
              reference = semantic_ancestors[0]
              string_call = semantic_ancestors[1]
              escape_call = semantic_ancestors[4]
              interpolation = semantic_ancestors[5]
              string_literal = semantic_ancestors[7]
              append = semantic_ancestors[8]
              append_index = ancestors.rindex { |ancestor| ancestor.equal?(append) }
              line_number = node[2].first
              safe_command_append = local_reference.call(reference, "runner") &&
                                    to_s_call.call(string_call, "runner") &&
                                    shellwords_escape.call(escape_call, "runner") &&
                                    interpolation&.first == :string_embexpr &&
                                    string_literal&.first == :string_literal &&
                                    append&.first == :binary && append[2] == :<< &&
                                    local_reference.call(append[1], "command") &&
                                    append[3].equal?(string_literal) &&
                                    !append_index.nil? &&
                                    direct_statement.call(append, ancestors.take(append_index)) &&
                                    support_lines.fetch(line_number - 1).match?(
                                      /\A +command << "#\{Shellwords\.escape\(runner\.to_s\)\} #\{Shellwords\.escape\(root\)\} "\n\z/
                                    )

              array = semantic_ancestors[1]
              map_call = semantic_ancestors[2]
              map_block = semantic_ancestors[3]
              join_call = semantic_ancestors[4]
              joined = semantic_ancestors[5]
              assignment = semantic_ancestors[6]
              assignment_index = ancestors.rindex { |ancestor| ancestor.equal?(assignment) }
              join_arguments = joined[2] if joined.is_a?(Array) && joined.first == :method_add_arg
              join_argument_list = join_arguments[1] if join_arguments.is_a?(Array) &&
                                                        join_arguments.first == :arg_paren
              assignment_variable = assignment.dig(1, 1) if assignment.is_a?(Array) &&
                                                            assignment.first == :assign
              safe_command_array = local_reference.call(reference, "runner") &&
                                   array&.first == :array && array[1].is_a?(Array) &&
                                   array[1].any? { |element| element.equal?(reference) } &&
                                   map_call&.first == :call && map_call[1].equal?(array) &&
                                   map_call.dig(3, 1) == "map" &&
                                   map_block&.first == :method_add_block &&
                                   map_block[1].equal?(map_call) &&
                                   canonical_escape_map_block.call(map_block[2]) &&
                                   join_call&.first == :call &&
                                   join_call[1].equal?(map_block) && join_call.dig(3, 1) == "join" &&
                                   joined&.first == :method_add_arg && joined[1].equal?(join_call) &&
                                   join_argument_list.is_a?(Array) &&
                                   join_argument_list.first == :args_add_block &&
                                   join_argument_list[1].is_a?(Array) &&
                                   join_argument_list[1].length == 1 &&
                                   literal_string.call(join_argument_list[1].first, " ") &&
                                   join_argument_list[2] == false &&
                                   assignment_variable.is_a?(Array) &&
                                   assignment_variable.first == :@ident &&
                                   assignment_variable[1] == "command" &&
                                   assignment[2].equal?(joined) &&
                                   !assignment_index.nil? &&
                                   direct_statement.call(
                                     assignment,
                                     ancestors.take(assignment_index),
                                   )
              unless safe_command_append || safe_command_array
                abort "Kandelo Formula support method derives or reassigns bound support child " \
                      "at #{support_path}:#{node[2].first}"
              end
            end
          end
          node.each { |child_node| validate_support_child_uses.call(child_node, ancestors + [node]) }
        end
        validate_support_child_uses.call(statement, [])
        unless support_child_references == 1
          abort "Kandelo Formula support method must use its bound support child exactly once: " \
                "#{support_path}"
        end
      end
    when :assign
      left = statement[1]
      constant = left.dig(1) if left.is_a?(Array) && left.first == :var_field
      unless constant.is_a?(Array) && constant.first == :@const &&
             constant[1].match?(/\AKANDELO_[A-Z0-9_]+\z/) && static_expression.call(statement[2])
        abort "Kandelo Formula support assignment must be a static KANDELO_ constant: #{support_path}"
      end
    else
      abort "Kandelo Formula support contains executable module structure: #{support_path}"
    end
  end
  support_validated.add(context_tap_name)
end

formula_bottles = {}
formula_runtime_declarations = {}
formula_dependency_declarations = {}
parse_formula = lambda do |full_name|
  formula_tap_name, separator, name = full_name.rpartition("/")
  abort "invalid dependency Formula identity: #{full_name}" if separator.empty?
  context = tap_contexts[formula_tap_name]
  abort "dependency Formula uses an undeclared tap: #{full_name}" if context.nil?
  abort "invalid dependency Formula: #{name}" unless FORMULA_NAME.match?(name)
  context_root = context.fetch("root")
  path = context_root/"Formula"/"#{name}.rb"
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
  local_source_operation = find_forbidden_support_token.call(selected_class)
  unless local_source_operation.nil?
    token, position = local_source_operation
    abort "Formula class uses forbidden tap-local source operation " \
          "#{token.inspect} at #{path}:#{position.first}"
  end
  top_level = syntax_tree[1]
  abort "Formula source has no canonical top-level body: #{path}" unless top_level.is_a?(Array)
  seen_class = false
  seen_requires = Set.new
  context_owner, context_tap = formula_tap_name.split("/", 2)
  support_require_line = %(require (Tap.fetch("#{context_owner}", "#{context_tap}").path/"Kandelo/formula_support/kandelo_formula_support").to_s\n)
  allowed_top_level_requires = Set[
    "require \"digest\"\n",
    "require \"shellwords\"\n",
    support_require_line,
  ]
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
  validate_support.call(context) if seen_requires.include?(support_require_line)

  class_bodystmt = selected_class[3]
  unless class_bodystmt.is_a?(Array) && class_bodystmt.first == :bodystmt &&
         class_bodystmt.drop(2).all?(&:nil?)
    abort "Formula class has no canonical body: #{path}"
  end
  class_body = class_bodystmt[1]
  abort "Formula class has no canonical statements: #{path}" unless class_body.is_a?(Array)
  seen_instance_methods = Set.new
  private_visibility = false
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
        validate_support.call(context)
      end
    when :method_add_block
      method = call_name.call(statement)
      abort "Formula class uses unsupported DSL block #{method.inspect}: #{path}" unless ALLOWED_CLASS_BLOCKS.include?(method)
      unless method == "resource" || no_argument_block.call(statement)
        abort "Formula #{method} block may not have arguments: #{path}"
      end
      if method == "bottle"
        abort "Formula class has multiple bottle blocks: #{path}" unless bottle.nil?
        bottle = parse_bottle.call(statement, lines, path)
      elsif method == "patch"
        validate_static_block.call(statement, path, "patch", Set["apply", "sha256", "type", "url"])
      elsif method == "on_macos"
        validate_static_block.call(statement, path, "on_macos", Set["keg_only"])
      elsif method == "resource"
        validate_resource.call(statement, lines, path)
      end
    when :def
      method_token = statement[1]
      method = method_token[1] if method_token.is_a?(Array) && method_token.first == :@ident
      valid_method = if private_visibility
        method&.match?(/\A[a-z][a-z0-9_]*[!?]?\z/) &&
          !FORBIDDEN_PRIVATE_INSTANCE_METHODS.include?(method)
      else
        ALLOWED_PUBLIC_INSTANCE_METHODS.include?(method)
      end
      unless valid_method && seen_instance_methods.add?(method)
        abort "Formula class defines an unsupported or duplicate instance method #{method.inspect}: #{path}"
      end
    when :assign
      left = statement[1]
      constant = left.dig(1) if left.is_a?(Array) && left.first == :var_field
      unless constant.is_a?(Array) && constant.first == :@const &&
             constant[1].match?(/\A[A-Z][A-Z0-9_]*\z/) && static_expression.call(statement[2])
        abort "Formula class assignment must be a static constant: #{path}"
      end
    when :vcall
      abort "Formula class uses an unsupported bare call: #{path}" unless call_name.call(statement) == "private"
      abort "Formula class repeats private visibility: #{path}" if private_visibility
      private_visibility = true
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
  runtime_declarations = []
  dependencies = declarations.each_with_object([]) do |(line_number, dependency, tags), selected|
    abort "duplicate dependency #{dependency.inspect} at #{path}:#{line_number}" unless seen.add?(dependency)
    next if [Set[:build], Set[:test], Set[:build, :test]].include?(tags)

    prefix = "#{formula_tap_name}/"
    if dependency.downcase.start_with?(prefix) && dependency != dependency.downcase
      abort "same-tap dependency must be normalized lowercase at #{path}:#{line_number}"
    end
    same_tap = dependency.start_with?(prefix)
    child = dependency.delete_prefix(prefix) if same_tap
    if same_tap && !FORMULA_NAME.match?(child)
      abort "invalid same-tap dependency at #{path}:#{line_number}"
    end

    kind = if tags.empty?
      "required"
    elsif tags == Set[:recommended]
      "recommended"
    elsif tags == Set[:optional]
      "optional"
    else
      abort "internal error: unclassified dependency tags at #{path}:#{line_number}"
    end
    runtime_declarations << {
      "kind" => kind,
      "name" => dependency,
      "same_tap" => same_tap,
    }
    abort "Formula runtime declarations exceed #{MAX_DEPENDENCIES} entries: #{path}" if runtime_declarations.length > MAX_DEPENDENCIES

    next if kind == "optional"

    selected_full_name = nil
    if same_tap
      selected_full_name = "#{formula_tap_name}/#{child}"
    elsif dependency.include?("/")
      dependency_tap, dependency_separator, dependency_name = dependency.rpartition("/")
      unless !dependency_separator.empty? && dependency == dependency.downcase &&
             TAP_NAME.match?(dependency_tap) && FORMULA_NAME.match?(dependency_name)
        abort "invalid external tap-qualified dependency at #{path}:#{line_number}"
      end
      unless tap_contexts.key?(dependency_tap)
        if declarations_only || bottle_identity_only
          next
        end
        abort "required dependency uses an undeclared tap at #{path}:#{line_number}: #{dependency}"
      end
      selected_full_name = dependency
    end
    selected << selected_full_name unless selected_full_name.nil?
  end
  formula_bottles[full_name] = bottle
  formula_runtime_declarations[full_name] = runtime_declarations
  formula_dependency_declarations[full_name] = declarations.map do |_line_number, dependency, tags|
    {"name" => dependency, "tags" => tags}
  end
  dependencies
end

closure = Set.new
states = {}
stack = []
target_direct_dependencies = nil
visit_formula = nil
visit_formula = lambda do |full_name|
  case states[full_name]
  when :done
    next
  when :visiting
    cycle_start = stack.index(full_name) || 0
    abort "tap dependency cycle: #{(stack[cycle_start..] + [full_name]).join(" -> ")}"
  end

  states[full_name] = :visiting
  stack << full_name
  dependencies = parse_formula.call(full_name)
  target_direct_dependencies = dependencies.dup if full_name == "#{tap_name}/#{target}"
  dependencies.each do |dependency|
    closure.add(dependency)
    abort "tap dependency closure exceeds #{MAX_DEPENDENCIES} entries" if closure.length > MAX_DEPENDENCIES
    visit_formula.call(dependency)
  end
  stack.pop
  states[full_name] = :done
end

target_full_name = "#{tap_name}/#{target}"
visit_formula.call(target_full_name)
short_names = [target_full_name, *closure.to_a].group_by do |full_name|
  full_name.rpartition("/").last
end
duplicate_short_names = short_names.each_with_object([]) do |(name, full_names), duplicates|
  duplicates << "#{name}:#{full_names.sort.join(",")}" if full_names.length > 1
end
unless duplicate_short_names.empty?
  abort "tap dependency closure contains duplicate Cellar names: #{duplicate_short_names.sort.inspect}"
end
unless declarations_only || host_dependencies_only || bottle_identity_only
  unsupported_external = formula_runtime_declarations.flat_map do |formula, declarations|
    declarations.each_with_object([]) do |declaration, unsupported|
      next if declaration.fetch("same_tap") || declaration.fetch("kind") == "optional" ||
              declaration.fetch("name").include?("/")

      unsupported << "#{formula}:#{declaration.fetch("name")}"
    end
  end.sort
  unless unsupported_external.empty?
    abort "required external Formula dependencies are unsupported in the runtime closure: #{unsupported_external.inspect}"
  end
end
if declarations_only
  records = formula_runtime_declarations.fetch(target_full_name).sort_by do |record|
    [record.fetch("name").downcase, record.fetch("name"), record.fetch("kind")]
  end
  puts JSON.generate({
    "schema" => 1,
    "tap" => tap_name,
    "formula" => target,
    "full_name" => "#{tap_name}/#{target}",
    "dependencies" => records,
  })
elsif bottle_identity_only
  bottle = formula_bottles.fetch(target_full_name)
  puts JSON.generate({
    "schema" => 1,
    "tap" => tap_name,
    "formula" => target,
    "full_name" => "#{tap_name}/#{target}",
    "bottle" => {
      "root_url" => bottle&.fetch("root_url", nil),
      "rebuild" => bottle.nil? ? 0 : bottle.fetch("rebuild"),
    },
  })
elsif host_dependencies_only
  build = Set.new
  build_and_test = Set.new
  runtime_and_test = Set.new
  prefix = "#{tap_name}/"
  formula_dependency_declarations.fetch(target_full_name).each do |declaration|
    dependency = declaration.fetch("name")
    tags = declaration.fetch("tags")
    next if tags == Set[:optional]

    if dependency.downcase.start_with?(prefix) && dependency != dependency.downcase
      abort "same-tap dependency must be normalized lowercase: #{dependency.inspect}"
    end
    if dependency.start_with?(prefix)
      child = dependency.delete_prefix(prefix)
      abort "invalid same-tap dependency: #{dependency.inspect}" unless FORMULA_NAME.match?(child)
      next
    end
    if dependency.include?("/")
      dependency_tap, dependency_separator, dependency_name = dependency.rpartition("/")
      unless !dependency_separator.empty? && dependency == dependency.downcase &&
             TAP_NAME.match?(dependency_tap) && FORMULA_NAME.match?(dependency_name)
        abort "invalid external tap-qualified dependency: #{dependency.inspect}"
      end
      unless tap_contexts.key?(dependency_tap)
        abort "external tap-qualified dependency is not locked: #{dependency.inspect}"
      end
      next
    end
    unless HOST_FORMULA_NAME.match?(dependency)
      abort "invalid host Formula dependency: #{dependency.inspect}"
    end
    if tags.empty? || tags == Set[:recommended]
      abort "external runtime dependency must be same-tap, not a host Formula: #{dependency.inspect}"
    end

    build.add(dependency) if tags.include?(:build)
    build_and_test.add(dependency)
    runtime_and_test.add(dependency) unless tags == Set[:build]
    if build_and_test.length > MAX_DEPENDENCIES
      abort "host Formula dependency plan exceeds #{MAX_DEPENDENCIES} entries"
    end
  end
  immutable_target_taps = tap_contexts.values.sort_by { |context| context.fetch("tap_name") }.map do |context|
    commit = context.fetch("tap_commit")
    unless commit.is_a?(String) && commit.match?(/\A[0-9a-f]{40}\z/)
      abort "host dependency plan requires an immutable resolved tap map"
    end
    {
      "tap_name" => context.fetch("tap_name"),
      "tap_repository" => context.fetch("tap_repository"),
      "tap_commit" => commit,
    }
  end
  puts JSON.generate({
    "schema" => 3,
    "tap" => tap_name,
    "formula" => target,
    "full_name" => "#{tap_name}/#{target}",
    "target_taps" => immutable_target_taps,
    "build" => build.sort,
    "build_and_test" => build_and_test.sort,
    "runtime_and_test" => runtime_and_test.sort,
  })
elsif direct_only
  puts target_direct_dependencies.sort
elsif output_arch.nil?
  puts closure.sort
else
  output_tag = "#{output_arch}_kandelo"
  records = closure.sort.to_h do |full_name|
    _dependency_tap, _separator, name = full_name.rpartition("/")
    bottle = formula_bottles[full_name]
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
