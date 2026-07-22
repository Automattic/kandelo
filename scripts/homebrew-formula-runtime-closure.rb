#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "pathname"
require "ripper"
require "set"

unless ARGV.length.between?(3, 4)
  abort "usage: homebrew-formula-runtime-closure.rb <tap-root> <owner/tap> <formula> " \
        "[wasm32|wasm64|--direct|--declarations-json|--host-dependencies-json|--bottle-identity-json|--tier2-bridge-json]"
end

MAX_FORMULA_BYTES = 1_048_576
MAX_DEPENDENCIES = 128
MAX_TIER2_CONTROL_BYTES = 16_384
MAX_SUPPORT_RUNTIME_FILES = 128
MAX_SUPPORT_RUNTIME_BYTES = 16_777_216
FORMULA_NAME = /\A[a-z0-9][a-z0-9._-]*\z/
HOST_FORMULA_NAME = /\A[a-z0-9][a-z0-9@+_.-]*\z/
TAP_NAME = /\A[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\z/
DEPENDENCY_LINE = /\A  depends_on "([^"]+)"(?: => (:[a-z]+|\[(?::[a-z]+)(?:, :[a-z]+)*\]))?\n\z/
NATIVE_REQUIREMENT_LINE = /\A  depends_on KandeloFormulaSupport::([A-Z][A-Za-z0-9]*Requirement) => (:[a-z]+|\[(?::[a-z]+)(?:, :[a-z]+)*\])\n\z/
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
  "kandelo_build_package", "name", "recursive_dependencies", "requirements", "version",
].freeze
TIER2_BRIDGE_METHOD = "kandelo_build_package"
TIER2_BRIDGE_MARKER = "KANDELO_REGISTRY_BRIDGE"
TIER2_RUNTIME_INITIALIZER_METHOD = "kandelo_load_tier2_runtime!"
TIER2_RUNTIME_CONSTANT = "KANDELO_TIER2_RUNTIME"
FORMULA_SUPPORT_API_VERSION_CONSTANT = "KANDELO_FORMULA_SUPPORT_API_VERSION"
FORMULA_SUPPORT_API_VERSION = 1
TIER2_BRIDGE_PACKAGE = /\A[a-z0-9][a-z0-9._-]{0,254}\z/
TIER2_BRIDGE_VERSION = /\A[A-Za-z0-9][A-Za-z0-9._+,-]{0,254}\z/
TIER2_BRIDGE_SOURCE_SHA256 = /\A[0-9a-f]{64}\z/
TIER2_RESERVED_ENV = Set[
  "WASM_POSIX_DEP_NAME",
  "WASM_POSIX_DEP_OUT_DIR",
  "WASM_POSIX_DEP_SOURCE_DIR",
  "WASM_POSIX_DEP_SOURCE_SHA256",
  "WASM_POSIX_DEP_SOURCE_URL",
  "WASM_POSIX_DEP_TARGET_ARCH",
  "WASM_POSIX_DEP_VERSION",
  "WASM_POSIX_DEP_WORK_DIR",
  "WASM_POSIX_INSTALL_LOCAL_MIRROR",
].freeze
FORBIDDEN_DEPENDENCY_IDENTIFIERS = Set[
  "Dependency", "Requirement", "__send__", "class_eval", "const_get", "define_method",
  "define_singleton_method", "eval", "instance_eval",
  "instance_variable_get", "instance_variable_set", "method", "method_missing",
  "module_eval", "public_method", "public_send", "require_relative", "send", "singleton_method",
  "uses_from_macos",
].freeze
FORBIDDEN_FORMULA_IDENTIFIERS = (
  FORBIDDEN_DEPENDENCY_IDENTIFIERS + Set[TIER2_RUNTIME_CONSTANT]
).freeze
FORBIDDEN_SUPPORT_IDENTIFIERS = (
  FORBIDDEN_DEPENDENCY_IDENTIFIERS +
    Set[
      "Module", "ObjectSpace", "Tap", "__FILE__", "__dir__", "alias", "alias_method",
      "autoload", "bind", "bind_call", "binding", "class_exec", "const_set", "extend",
      "instance_exec", "instance_method", "load", "local_variable_get", "local_variable_set",
      "module_function", "prepend", "private_instance_method", "public_instance_method",
      "refine", "remove_const", "remove_instance_variable", "remove_method", "require",
      "intern", "singleton_class", "tap", "to_proc", "to_sym", "unbind", "undef",
      "undef_method", "using",
    ]
).freeze
EXCLUDED_TAG_SETS = Set[
  Set[:build],
  Set[:test],
  Set[:optional],
  Set[:build, :test],
].freeze
NATIVE_REQUIREMENTS = {
  "BinaryenRequirement" => {
    "executable" => "wasm-opt",
    "formula" => "binaryen",
  },
  "PkgconfRequirement" => {
    "executable" => "pkg-config",
    "formula" => "pkgconf",
  },
  "WabtRequirement" => {
    "executable" => "wasm-validate",
    "formula" => "wabt",
  },
}.freeze
NATIVE_REQUIREMENT_TAG_SETS = Set[
  Set[:build],
  Set[:build, :test],
].freeze

tap_input, requested_tap_name, target, output_mode = ARGV
abort "invalid tap name: #{requested_tap_name}" unless TAP_NAME.match?(requested_tap_name)
abort "invalid target Formula: #{target}" unless FORMULA_NAME.match?(target)
abort "invalid output mode: #{output_mode}" unless output_mode.nil? || %w[wasm32 wasm64 --direct --declarations-json --host-dependencies-json --bottle-identity-json --tier2-bridge-json].include?(output_mode)
direct_only = output_mode == "--direct"
declarations_only = output_mode == "--declarations-json"
host_dependencies_only = output_mode == "--host-dependencies-json"
bottle_identity_only = output_mode == "--bottle-identity-json"
tier2_bridge_only = output_mode == "--tier2-bridge-json"
output_arch = direct_only || declarations_only || host_dependencies_only || bottle_identity_only || tier2_bridge_only ? nil : output_mode
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

literal_string_value = lambda do |node|
  content = node[1] if node.is_a?(Array) && node.first == :string_literal
  token = content[1] if content.is_a?(Array) && content.first == :string_content &&
                        content.length == 2
  token[1] if token.is_a?(Array) && token.first == :@tstring_content
end

literal_string = lambda do |node, expected|
  literal_string_value.call(node) == expected
end

canonical_literal_value = lambda do |node, lines|
  content = node[1] if node.is_a?(Array) && node.first == :string_literal
  token = content[1] if content.is_a?(Array) && content.first == :string_content &&
                        content.length == 2
  next nil unless token.is_a?(Array) && token.first == :@tstring_content

  value = token[1]
  position = token[2]
  next nil unless value.is_a?(String) && position.is_a?(Array)

  line_number, content_column = position
  line = lines.fetch(line_number - 1, nil)
  encoded = JSON.generate(value)
  start_column = content_column - 1
  next nil unless line.is_a?(String) && start_column >= 0 &&
                  line.byteslice(start_column, encoded.bytesize) == encoded

  value
end

canonical_command_arguments = lambda do |node, expected_name|
  next nil unless node.is_a?(Array) && node.first == :command

  identifier = node[1]
  arguments = node[2]
  next nil unless identifier.is_a?(Array) && identifier.first == :@ident &&
                  identifier[1] == expected_name
  next nil unless arguments.is_a?(Array) && arguments.first == :args_add_block &&
                  arguments[1].is_a?(Array) && arguments[2] == false

  arguments[1]
end

tier2_bridge_arguments = lambda do |node, lines|
  next nil unless node.is_a?(Array) && node.first == :bare_assoc_hash &&
                  node[1].is_a?(Array)

  associations = node[1]
  labels = associations.map do |association|
    break nil unless association.is_a?(Array) && association.first == :assoc_new &&
                     association.dig(1, 0) == :@label

    association.dig(1, 1)
  end
  next nil unless labels == ["script_env:"] || labels == ["package:", "script_env:"]

  package = nil
  if labels.first == "package:"
    package = canonical_literal_value.call(associations.first[2], lines)
    next nil unless package&.match?(TIER2_BRIDGE_PACKAGE)
  end

  value = associations.last[2]
  next nil unless value.is_a?(Array) && value.first == :hash
  list = value[1]
  next({ "package" => package, "script_env_keys" => [] }) if list.nil?
  next nil unless list.is_a?(Array) && list.first == :assoclist_from_args && list[1].is_a?(Array)

  keys = list[1].map do |entry|
    break nil unless entry.is_a?(Array) && entry.first == :assoc_new
    key = canonical_literal_value.call(entry[1], lines)
    break nil unless key&.match?(/\A[A-Z][A-Z0-9_]{0,254}\z/)
    key
  end
  next nil if keys.nil?

  {
    "package" => package,
    "script_env_keys" => keys,
  }
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

valid_tier2_support_signature = lambda do |parameters|
  parameters = parameters[1] if parameters.is_a?(Array) && parameters.first == :paren
  next nil unless parameters.is_a?(Array) && parameters.first == :params &&
                    parameters.length == 8

  required = parameters[1]
  keywords = parameters[5]
  next nil unless required.nil? &&
                  parameters[2].nil? && parameters[3].nil? && parameters[4].nil? &&
                  keywords.is_a?(Array) &&
                  parameters[6].nil? && parameters[7].nil?

  canonical_keyword = lambda do |keyword, label, default_kind|
    next false unless keyword.is_a?(Array) && keyword.length == 2 &&
                      keyword.dig(0, 0) == :@label && keyword.dig(0, 1) == label

    default = keyword[1]
    case default_kind
    when :empty_hash
      default.is_a?(Array) && default.first == :hash && default[1].nil?
    when :nil
      default.is_a?(Array) && default.first == :var_ref &&
        default.dig(1, 0) == :@kw && default.dig(1, 1) == "nil"
    else
      false
    end
  end

  if keywords.length == 1 && canonical_keyword.call(keywords.first, "script_env:", :empty_hash)
    :legacy
  elsif keywords.length == 2 &&
        canonical_keyword.call(keywords.first, "package:", :nil) &&
        canonical_keyword.call(keywords.last, "script_env:", :empty_hash)
    :package
  end
end

canonical_tier2_runtime_initializer = lambda do |statement, lines|
  next nil unless statement.is_a?(Array) && statement.first == :defs

  receiver = statement[1]
  separator = statement[2]
  method_token = statement[3]
  parameters = statement[4]
  body = statement[5]
  self_token = receiver[1] if receiver.is_a?(Array) && receiver.first == :var_ref
  next nil unless self_token.is_a?(Array) && self_token.first == :@kw && self_token[1] == "self" &&
                  separator.is_a?(Array) && separator.first == :@period && separator[1] == "." &&
                  method_token.is_a?(Array) && method_token.first == :@ident &&
                  method_token[1] == TIER2_RUNTIME_INITIALIZER_METHOD &&
                  parameters.is_a?(Array) && parameters.first == :params &&
                  parameters.drop(1).all?(&:nil?) &&
                  body.is_a?(Array) && body.first == :bodystmt && body.drop(2).all?(&:nil?) &&
                  body[1].is_a?(Array) && !body[1].empty?

  method_line = method_token.dig(2, 0)
  next nil unless method_line.is_a?(Integer) &&
                  lines.fetch(method_line - 1, nil) == "  def self.#{TIER2_RUNTIME_INITIALIZER_METHOD}\n"

  assignment = body[1].first
  left = assignment[1] if assignment.is_a?(Array) && assignment.first == :assign
  support_token = left[1] if left.is_a?(Array) && left.first == :var_field
  right = assignment[2] if assignment.is_a?(Array)
  pathname_call = right[1] if right.is_a?(Array) && right.first == :call
  realpath_token = right[3] if right.is_a?(Array) && right.first == :call
  pathname_fcall = pathname_call[1] if pathname_call.is_a?(Array) &&
                                          pathname_call.first == :method_add_arg
  arguments = pathname_call[2] if pathname_call.is_a?(Array) && pathname_call.first == :method_add_arg
  pathname_token = pathname_fcall[1] if pathname_fcall.is_a?(Array) &&
                                          pathname_fcall.first == :fcall
  argument_list = arguments[1] if arguments.is_a?(Array) && arguments.first == :arg_paren
  file_reference = argument_list[1].first if argument_list.is_a?(Array) &&
                                                argument_list.first == :args_add_block &&
                                                argument_list[1].is_a?(Array) &&
                                                argument_list[1].length == 1 &&
                                                argument_list[2] == false
  file_token = file_reference[1] if file_reference.is_a?(Array) && file_reference.first == :var_ref
  assignment_line = support_token.dig(2, 0) if support_token.is_a?(Array)
  source_tokens_share_line = [pathname_token, file_token, realpath_token].all? do |token|
    token&.dig(2, 0) == assignment_line
  end
  next nil unless support_token.is_a?(Array) && support_token.first == :@ident &&
                  support_token[1] == "support_path" &&
                  pathname_token.is_a?(Array) && pathname_token.first == :@const &&
                  pathname_token[1] == "Pathname" &&
                  file_token.is_a?(Array) && file_token.first == :@kw && file_token[1] == "__FILE__" &&
                  realpath_token.is_a?(Array) && realpath_token.first == :@ident &&
                  realpath_token[1] == "realpath" && source_tokens_share_line &&
                  lines.fetch(assignment_line - 1, nil) ==
                    "    support_path = Pathname(__FILE__).realpath\n"

  file_reference
end

canonical_tier2_runtime_assignment = lambda do |statement, lines|
  next false unless statement.is_a?(Array) && statement.first == :assign

  left = statement[1]
  constant = left[1] if left.is_a?(Array) && left.first == :var_field
  right = statement[2]
  call = right[1] if right.is_a?(Array) && right.first == :method_add_arg
  arguments = right[2] if right.is_a?(Array) && right.first == :method_add_arg
  method_token = call[1] if call.is_a?(Array) && call.first == :fcall
  line_number = constant.dig(2, 0) if constant.is_a?(Array)
  constant.is_a?(Array) && constant.first == :@const &&
    constant[1] == TIER2_RUNTIME_CONSTANT &&
    method_token.is_a?(Array) && method_token.first == :@ident &&
    method_token[1] == TIER2_RUNTIME_INITIALIZER_METHOD && arguments == [] &&
    method_token.dig(2, 0) == line_number &&
    lines.fetch(line_number - 1, nil) ==
      "  #{TIER2_RUNTIME_CONSTANT} = #{TIER2_RUNTIME_INITIALIZER_METHOD}\n"
end

canonical_native_requirement = lambda do |statement, lines|
  next nil unless statement.is_a?(Array) && statement.first == :class

  class_token = statement.dig(1, 1)
  superclass = statement[2]
  superclass_token = superclass[1] if superclass.is_a?(Array) && superclass.first == :var_ref
  body = statement[3]
  next nil unless class_token.is_a?(Array) && class_token.first == :@const &&
                  superclass_token.is_a?(Array) && superclass_token.first == :@const &&
                  superclass_token[1] == "Requirement" &&
                  body.is_a?(Array) && body.first == :bodystmt &&
                  body.drop(2).all?(&:nil?) && body[1].is_a?(Array) &&
                  body[1].length == 4

  class_name = class_token[1]
  identity = NATIVE_REQUIREMENTS[class_name]
  next nil if identity.nil?

  line_number = class_token.dig(2, 0)
  expected_lines = [
    "  class #{class_name} < Requirement\n",
    %(    KANDELO_NATIVE_FORMULA = "#{identity.fetch("formula")}"\n),
    %(    KANDELO_NATIVE_SENTINEL = "#{identity.fetch("executable")}"\n),
    "    fatal true\n",
    %(    satisfy(build_env: false) { which("#{identity.fetch("executable")}") }\n),
    "  end\n",
  ]
  next nil unless line_number.is_a?(Integer) &&
                  lines.slice(line_number - 1, expected_lines.length) == expected_lines

  formula_statement, sentinel_statement, fatal_statement, satisfy_statement = body[1]
  canonical_metadata_assignment = lambda do |assignment, constant_name, value|
    left = assignment[1] if assignment.is_a?(Array) && assignment.first == :assign
    constant = left[1] if left.is_a?(Array) && left.first == :var_field
    constant.is_a?(Array) && constant.first == :@const && constant[1] == constant_name &&
      literal_string.call(assignment[2], value)
  end
  fatal_arguments = canonical_command_arguments.call(fatal_statement, "fatal")
  fatal_value = fatal_arguments&.first
  satisfy_call = satisfy_statement[1] if satisfy_statement.is_a?(Array) &&
                                            satisfy_statement.first == :method_add_block
  satisfy_arguments = satisfy_call[2] if satisfy_call.is_a?(Array) &&
                                          satisfy_call.first == :method_add_arg &&
                                          satisfy_call.dig(1, 0) == :fcall &&
                                          satisfy_call.dig(1, 1, 0) == :@ident &&
                                          satisfy_call.dig(1, 1, 1) == "satisfy"
  satisfy_argument_list = satisfy_arguments[1] if satisfy_arguments.is_a?(Array) &&
                                                    satisfy_arguments.first == :arg_paren
  satisfy_hash = satisfy_argument_list[1]&.first if satisfy_argument_list.is_a?(Array) &&
                                                     satisfy_argument_list.first == :args_add_block &&
                                                     satisfy_argument_list[1].is_a?(Array) &&
                                                     satisfy_argument_list[1].length == 1 &&
                                                     satisfy_argument_list[2] == false
  satisfy_assoc = satisfy_hash[1]&.first if satisfy_hash.is_a?(Array) &&
                                            satisfy_hash.first == :bare_assoc_hash &&
                                            satisfy_hash[1].is_a?(Array) &&
                                            satisfy_hash[1].length == 1
  satisfy_block = satisfy_statement[2] if satisfy_statement.is_a?(Array)
  which_call = satisfy_block[2]&.first if satisfy_block.is_a?(Array) &&
                                          satisfy_block.first == :brace_block &&
                                          satisfy_block[1].nil? &&
                                          satisfy_block[2].is_a?(Array) &&
                                          satisfy_block[2].length == 1
  which_arguments = which_call[2] if which_call.is_a?(Array) &&
                                      which_call.first == :method_add_arg &&
                                      which_call.dig(1, 0) == :fcall &&
                                      which_call.dig(1, 1, 0) == :@ident &&
                                      which_call.dig(1, 1, 1) == "which"
  which_argument_list = which_arguments[1] if which_arguments.is_a?(Array) &&
                                                which_arguments.first == :arg_paren
  which_literal = which_argument_list[1]&.first if which_argument_list.is_a?(Array) &&
                                                   which_argument_list.first == :args_add_block &&
                                                   which_argument_list[1].is_a?(Array) &&
                                                   which_argument_list[1].length == 1 &&
                                                   which_argument_list[2] == false
  next nil unless canonical_metadata_assignment.call(
                    formula_statement,
                    "KANDELO_NATIVE_FORMULA",
                    identity.fetch("formula"),
                  ) &&
                  canonical_metadata_assignment.call(
                    sentinel_statement,
                    "KANDELO_NATIVE_SENTINEL",
                    identity.fetch("executable"),
                  ) &&
                  fatal_arguments&.length == 1 && fatal_value&.first == :var_ref &&
                  fatal_value.dig(1, 0) == :@kw && fatal_value.dig(1, 1) == "true" &&
                  satisfy_assoc.is_a?(Array) && satisfy_assoc.first == :assoc_new &&
                  satisfy_assoc.dig(1, 0) == :@label &&
                  satisfy_assoc.dig(1, 1) == "build_env:" &&
                  satisfy_assoc.dig(2, 0) == :var_ref &&
                  satisfy_assoc.dig(2, 1, 0) == :@kw &&
                  satisfy_assoc.dig(2, 1, 1) == "false" &&
                  literal_string.call(which_literal, identity.fetch("executable"))

  [class_name, superclass]
end

support_validated = Set.new
support_methods_by_tap = {}
support_sha256_by_tap = {}
support_runtime_sha256_by_tap = {}
support_api_version_by_tap = {}
support_tier2_package_keyword_by_tap = {}
support_native_requirements_by_tap = {}
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

  # The Ruby support module dispatches neighboring shell, Perl, TypeScript,
  # HTML, and configuration files through its lexical __dir__. Whichever tap
  # loads the module first therefore owns this entire runtime tree, not only
  # kandelo_formula_support.rb. Hash every publisher-consumable top-level file
  # so cross-tap compatibility and pre-execution rescans bind the real runtime
  # closure. Tap-local tests are deliberately excluded from bottle identity.
  support_runtime_files = {}
  support_runtime_bytes = 0
  support_dir.each_child do |entry|
    basename = entry.basename.to_s
    if basename == "test"
      if entry.symlink? || !entry.directory?
        abort "Kandelo Formula support test path must be a real directory: #{entry}"
      end
      next
    end
    unless basename.match?(/\A[A-Za-z0-9][A-Za-z0-9._-]*\z/) &&
           entry.parent == support_dir && !entry.symlink? && entry.file?
      abort "Kandelo Formula support runtime entry must be a canonical regular file: #{entry}"
    end
    if support_runtime_files.length >= MAX_SUPPORT_RUNTIME_FILES
      abort "Kandelo Formula support runtime exceeds #{MAX_SUPPORT_RUNTIME_FILES} files: #{support_dir}"
    end
    entry_bytes = entry.size
    if entry_bytes > MAX_FORMULA_BYTES ||
       support_runtime_bytes + entry_bytes > MAX_SUPPORT_RUNTIME_BYTES
      abort "Kandelo Formula support runtime exceeds the byte limit: #{support_dir}"
    end
    support_runtime_bytes += entry_bytes
    support_runtime_files[basename] = Digest::SHA256.file(entry).hexdigest
  end
  unless support_runtime_files.key?(support_path.basename.to_s)
    abort "Kandelo Formula support runtime omits its support module: #{support_dir}"
  end
  support_runtime_files = support_runtime_files.sort.to_h.freeze
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
  runtime_requires = [
    "require \"digest\"\n",
    "require \"fileutils\"\n",
    "require \"json\"\n",
    "require \"pathname\"\n",
    "require \"shellwords\"\n",
    "require \"tempfile\"\n",
  ]
  support_lines = support_source.lines
  canonical_requires =
    top_level.is_a?(Array) && top_level.length == runtime_requires.length + 1 &&
      top_level.first(runtime_requires.length).each_with_index.all? do |statement, index|
        position = call_position.call(statement)
        line_number = position[0] if position.is_a?(Array)
        line = support_lines.fetch(line_number - 1, nil) if line_number.is_a?(Integer)
        call_name.call(statement) == "require" && line == runtime_requires[index]
      end
  unless canonical_requires
    abort "Kandelo Formula support must contain only approved requires, the compatibility guard, and one module: #{support_path}"
  end
  compatibility_guard = top_level.fetch(runtime_requires.length)
  last_require_position = call_position.call(top_level.fetch(runtime_requires.length - 1))
  guard_line = last_require_position.fetch(0) + 2 if last_require_position.is_a?(Array)
  canonical_guard_lines = [
    "if defined?(KandeloFormulaSupport)\n",
    "  unless KandeloFormulaSupport::KANDELO_FORMULA_SUPPORT_API_VERSION == 1 &&\n",
    "         Digest::SHA256.file(Pathname(__FILE__).realpath).hexdigest ==\n",
    "           KandeloFormulaSupport::KANDELO_TIER2_RUNTIME.fetch(\"support_sha256\")\n",
    "    raise \"loaded Kandelo Formula support copies are incompatible\"\n",
    "  end\n",
    "else\n",
  ]
  guard_constant = compatibility_guard.dig(1, 1, 1) if compatibility_guard.is_a?(Array) &&
                                                       compatibility_guard.first == :if &&
                                                       compatibility_guard.dig(1, 0) == :defined &&
                                                       compatibility_guard.dig(1, 1, 0) == :var_ref
  unless guard_constant.is_a?(Array) && guard_constant.first == :@const &&
         guard_constant[1] == "KandeloFormulaSupport" &&
         guard_constant.dig(2, 0) == guard_line &&
         support_lines.slice(guard_line - 1, canonical_guard_lines.length) == canonical_guard_lines
    abort "Kandelo Formula support must use the canonical idempotent compatibility guard: #{support_path}"
  end
  guarded_definition = compatibility_guard[3]
  unless guarded_definition.is_a?(Array) && guarded_definition.first == :else &&
         guarded_definition[1].is_a?(Array) && guarded_definition[1].length == 1
    abort "Kandelo Formula support compatibility guard must own exactly one module definition: #{support_path}"
  end
  module_node = guarded_definition.dig(1, 0)
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
  runtime_initializer_index = nil
  runtime_assignment_index = nil
  support_api_version = nil
  tier2_package_keyword = false
  native_requirements = Set.new
  module_body.each_with_index do |statement, statement_index|
    next if statement.is_a?(Array) && statement.first == :void_stmt

    case statement.first
    when :defs
      file_reference = canonical_tier2_runtime_initializer.call(statement, support_lines)
      if file_reference.nil? || !runtime_initializer_index.nil?
        abort "Kandelo Formula support must use one canonical Tier-2 runtime initializer: #{support_path}"
      end
      forbidden = find_forbidden_support_token.call(statement, Set[file_reference.object_id])
      unless forbidden.nil?
        token, position = forbidden
        abort "Kandelo Formula support runtime initializer uses forbidden local source operation " \
              "#{token.inspect} at #{support_path}:#{position.first}"
      end
      runtime_initializer_index = statement_index
    when :def
      method_token = statement[1]
      method = method_token[1] if method_token.is_a?(Array) && method_token.first == :@ident
      unless method != TIER2_RUNTIME_INITIALIZER_METHOD &&
             method&.match?(/\A(?:formula_opt|kandelo)_[a-z0-9_]*[!?]?\z/) && methods.add?(method)
        abort "Kandelo Formula support may contain only unique approved instance methods: #{support_path}"
      end
      if method == TIER2_BRIDGE_METHOD
        signature = valid_tier2_support_signature.call(statement[2])
        if signature.nil?
          abort "Kandelo Formula support #{TIER2_BRIDGE_METHOD} has a noncanonical signature: #{support_path}"
        end
        tier2_package_keyword = signature == :package
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
    when :class
      native_requirement = canonical_native_requirement.call(statement, support_lines)
      if native_requirement.nil?
        abort "Kandelo Formula support contains an unsupported native Requirement class: #{support_path}"
      end
      class_name, allowed_superclass = native_requirement
      unless native_requirements.add?(class_name)
        abort "Kandelo Formula support repeats native Requirement #{class_name}: #{support_path}"
      end
      forbidden = find_forbidden_support_token.call(
        statement,
        Set[allowed_superclass.object_id],
      )
      unless forbidden.nil?
        token, position = forbidden
        abort "Kandelo Formula support native Requirement uses forbidden operation " \
              "#{token.inspect} at #{support_path}:#{position.first}"
      end
    when :assign
      left = statement[1]
      constant = left.dig(1) if left.is_a?(Array) && left.first == :var_field
      if constant.is_a?(Array) && constant.first == :@const &&
         constant[1] == FORMULA_SUPPORT_API_VERSION_CONSTANT
        line_number = constant.dig(2, 0)
        unless support_api_version.nil? && statement[2].is_a?(Array) &&
               statement[2].first == :@int && statement[2][1] == FORMULA_SUPPORT_API_VERSION.to_s &&
               support_lines.fetch(line_number - 1, nil) ==
                 "  #{FORMULA_SUPPORT_API_VERSION_CONSTANT} = #{FORMULA_SUPPORT_API_VERSION}\n"
          abort "Kandelo Formula support must declare one canonical API version: #{support_path}"
        end
        support_api_version = FORMULA_SUPPORT_API_VERSION
      elsif constant.is_a?(Array) && constant.first == :@const &&
         constant[1] == TIER2_RUNTIME_CONSTANT
        unless runtime_assignment_index.nil? &&
               canonical_tier2_runtime_assignment.call(statement, support_lines)
          abort "Kandelo Formula support must use one canonical Tier-2 runtime assignment: #{support_path}"
        end
        runtime_assignment_index = statement_index
      elsif !(constant.is_a?(Array) && constant.first == :@const &&
              constant[1].match?(/\AKANDELO_[A-Z0-9_]+\z/) && static_expression.call(statement[2]))
        abort "Kandelo Formula support assignment must be a static KANDELO_ constant: #{support_path}"
      end
    else
      abort "Kandelo Formula support contains executable module structure: #{support_path}"
    end
  end
  if runtime_initializer_index.nil? || runtime_assignment_index != runtime_initializer_index + 1
    abort "Kandelo Formula support must initialize Tier-2 runtime authority exactly once: #{support_path}"
  end
  if support_api_version != FORMULA_SUPPORT_API_VERSION
    abort "Kandelo Formula support must declare API version #{FORMULA_SUPPORT_API_VERSION}: #{support_path}"
  end
  support_methods_by_tap[context_tap_name] = methods.freeze
  support_sha256 = Digest::SHA256.hexdigest(support_source)
  unless support_runtime_files.fetch(support_path.basename.to_s) == support_sha256
    abort "Kandelo Formula support changed while its runtime tree was validated: #{support_path}"
  end
  support_sha256_by_tap[context_tap_name] = support_sha256
  support_runtime_sha256_by_tap[context_tap_name] = Digest::SHA256.hexdigest(
    JSON.generate(support_runtime_files),
  )
  support_api_version_by_tap[context_tap_name] = support_api_version
  support_tier2_package_keyword_by_tap[context_tap_name] = tier2_package_keyword
  support_native_requirements_by_tap[context_tap_name] = native_requirements.freeze
  support_validated.add(context_tap_name)
end

formula_bottles = {}
formula_runtime_declarations = {}
formula_dependency_declarations = {}
formula_tier2_bridges = {}
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
    ((type == :on_ident || type == :on_const) && FORBIDDEN_FORMULA_IDENTIFIERS.include?(token)) ||
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
  validate_formula_block_passes = nil
  validate_formula_block_passes = lambda do |node|
    next unless node.is_a?(Array)

    if node.first == :dyna_symbol
      abort "Formula class may not construct dynamic symbols: #{path}"
    end
    if node.first == :args_add_block && node[2] != false
      block_pass = node[2]
      token = block_pass.dig(1, 1) if block_pass.is_a?(Array) &&
                                      block_pass.first == :symbol_literal &&
                                      block_pass.dig(1, 0) == :symbol
      value = token[1] if token.is_a?(Array) && token.first == :@ident
      position = token[2] if token.is_a?(Array)
      line = lines.fetch(position[0] - 1, nil) if position.is_a?(Array)
      source_literal = "&:#{value}"
      start_column = position[1] - 2 if position.is_a?(Array)
      canonical = value&.match?(/\A[a-zA-Z_][a-zA-Z0-9_]*[!?]?\z/) &&
                  !start_column.nil? && start_column >= 0 &&
                  line&.byteslice(start_column, source_literal.bytesize) == source_literal
      abort "Formula class block pass must be one canonical static symbol: #{path}" unless canonical
    end
    node.each { |child| validate_formula_block_passes.call(child) }
  end
  validate_formula_block_passes.call(selected_class)
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
  private_instance_methods = Set.new
  private_visibility = false
  included_support = false
  bottle = nil
  class_body.each do |statement|
    abort "Formula class contains a malformed statement: #{path}" unless statement.is_a?(Array)
    case statement.first
    when :command
      method = call_name.call(statement)
      abort "Formula class uses unsupported DSL call #{method.inspect}: #{path}" unless ALLOWED_CLASS_COMMANDS.include?(method)
      # Every depends_on call is independently matched against one canonical
      # literal Formula or allowlisted Requirement line below. Do not make the
      # generic static-expression walker understand arbitrary constant paths.
      unless method == "depends_on" || static_expression.call(statement[2])
        abort "Formula class DSL arguments must be static: #{path}"
      end
      if method == "include"
        line_number = statement.dig(1, 2, 0)
        unless line_number.is_a?(Integer) && lines.fetch(line_number - 1) == "  include KandeloFormulaSupport\n"
          abort "Formula may include only KandeloFormulaSupport: #{path}"
        end
        abort "Formula repeats KandeloFormulaSupport include: #{path}" if included_support
        validate_support.call(context)
        included_support = true
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
      private_instance_methods.add(method) if private_visibility
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

  unless !included_support || seen_requires.include?(support_require_line)
    abort "Formula must canonically require KandeloFormulaSupport before including it: #{path}"
  end
  if included_support
    collisions = seen_instance_methods & support_methods_by_tap.fetch(formula_tap_name)
    unless collisions.empty?
      abort "Formula methods shadow Kandelo Formula support methods #{collisions.to_a.sort.inspect}: #{path}"
    end
  end

  bridge_identifier_positions = Ripper.lex(source).each_with_object([]) do |(position, type, token, _state), positions|
    positions << position if type == :on_ident && token == TIER2_BRIDGE_METHOD
  end
  bridge_calls = []
  install_method = class_body.find do |statement|
    statement.is_a?(Array) && statement.first == :def && statement.dig(1, 1) == "install"
  end
  unless install_method.nil?
    install_body = install_method[3]
    install_statements = install_body[1] if install_body.is_a?(Array) &&
                                            install_body.first == :bodystmt &&
                                            install_body.drop(2).all?(&:nil?)
    abort "Formula install method has no canonical body: #{path}" unless install_statements.is_a?(Array)

    find_bridge_calls = nil
    find_bridge_calls = lambda do |node, ancestors|
      next unless node.is_a?(Array)

      if node.first == :method_add_arg && node.dig(1, 0) == :fcall &&
         node.dig(1, 1, 0) == :@ident && node.dig(1, 1, 1) == TIER2_BRIDGE_METHOD
        assignment = ancestors.last
        direct_assignment = assignment.is_a?(Array) && assignment.first == :assign &&
                            assignment[2].equal?(node) &&
                            install_statements.any? { |statement| statement.equal?(assignment) }
        abort "#{TIER2_BRIDGE_METHOD} must be the direct right-hand side of an install assignment: #{path}" unless direct_assignment

        left = assignment[1]
        variable = left[1] if left.is_a?(Array) && left.first == :var_field
        unless variable.is_a?(Array) && variable.first == :@ident
          abort "#{TIER2_BRIDGE_METHOD} result must bind one local variable: #{path}"
        end

        arg_paren = node[2]
        argument_list = arg_paren[1] if arg_paren.is_a?(Array) && arg_paren.first == :arg_paren
        arguments = if argument_list.is_a?(Array) &&
                       argument_list.first == :args_add_block &&
                       argument_list[2] == false
          argument_list[1]
        elsif argument_list.is_a?(Array) && argument_list.length == 1 &&
              argument_list.dig(0, 0) == :bare_assoc_hash
          # Ripper represents a trailing comma after a sole keyword hash as a
          # direct argument array rather than :args_add_block.
          argument_list
        end
        unless arguments.is_a?(Array) && arguments.length == 1
          abort "#{TIER2_BRIDGE_METHOD} must use one canonical keyword hash: #{path}"
        end

        bridge_arguments = tier2_bridge_arguments.call(arguments.first, lines)
        keys = bridge_arguments&.fetch("script_env_keys", nil)
        if keys.nil? || keys.uniq.length != keys.length
          abort "#{TIER2_BRIDGE_METHOD} must use an optional literal package followed by one " \
                "literal script_env hash with unique literal keys: #{path}"
        end
        if keys.length > 64 || keys.sum(&:bytesize) > 4096
          abort "#{TIER2_BRIDGE_METHOD} script_env exceeds the static key limit: #{path}"
        end
        reserved = keys.to_set & TIER2_RESERVED_ENV
        unless reserved.empty?
          abort "#{TIER2_BRIDGE_METHOD} script_env overrides reserved variables #{reserved.to_a.sort.inspect}: #{path}"
        end
        package = bridge_arguments.fetch("package") || name
        package_prefix = "#{package.upcase.gsub(/[^A-Z0-9]/, "_")}_"
        invalid_namespace = keys.reject do |key|
          key.start_with?("WASM_POSIX_DEP_") || key.start_with?(package_prefix)
        end
        unless invalid_namespace.empty?
          abort "#{TIER2_BRIDGE_METHOD} script_env uses keys outside the approved namespace #{invalid_namespace.sort.inspect}: #{path}"
        end
        bridge_calls << {
          "package" => bridge_arguments.fetch("package"),
          "script_env_keys" => keys.sort,
          "position" => node.dig(1, 1, 2),
        }
      end
      node.each { |child| find_bridge_calls.call(child, ancestors + [node]) }
    end
    find_bridge_calls.call(install_method, [])
  end

  accepted_bridge_positions = bridge_calls.map { |call| call.fetch("position") }.sort
  unless bridge_identifier_positions.sort == accepted_bridge_positions
    abort "every #{TIER2_BRIDGE_METHOD} reference must be one canonical direct install call: #{path}"
  end
  abort "Formula has multiple #{TIER2_BRIDGE_METHOD} calls: #{path}" if bridge_calls.length > 1

  bridge_markers = class_body.select do |statement|
    left = statement[1] if statement.is_a?(Array) && statement.first == :assign
    constant = left[1] if left.is_a?(Array) && left.first == :var_field
    constant.is_a?(Array) && constant.first == :@const &&
      constant[1] == TIER2_BRIDGE_MARKER
  end
  valid_bridge_marker = bridge_markers.length == 1 &&
                        bridge_markers.first.dig(2, 0) == :var_ref &&
                        bridge_markers.first.dig(2, 1, 0) == :@kw &&
                        bridge_markers.first.dig(2, 1, 1) == "true" &&
                        lines.fetch(bridge_markers.first.dig(1, 1, 2, 0) - 1, nil) ==
                          "  #{TIER2_BRIDGE_MARKER} = true\n"
  if bridge_markers.any? && !valid_bridge_marker
    abort "Formula Tier-2 registry bridge marker must be one canonical true constant: #{path}"
  end
  if bridge_calls.empty? != bridge_markers.empty?
    abort "Formula Tier-2 registry bridge marker and canonical helper call must appear together: #{path}"
  end

  tier2_bridge = nil
  unless bridge_calls.empty?
    unless private_instance_methods.empty?
      abort "Tier-2 Formula may not define private helper methods #{private_instance_methods.to_a.sort.inspect}: #{path}"
    end
    unless included_support && support_methods_by_tap.fetch(formula_tap_name).include?(TIER2_BRIDGE_METHOD)
      abort "Formula bridge requires the canonical Kandelo Formula support helper: #{path}"
    end
    if !bridge_calls.first.fetch("package").nil? &&
       !support_tier2_package_keyword_by_tap.fetch(formula_tap_name)
      abort "Formula bridge package mapping requires canonical package: support: #{path}"
    end
    direct_literal = lambda do |command|
      candidates = class_body.select do |statement|
        statement.is_a?(Array) && statement.first == :command &&
          call_name.call(statement) == command
      end
      next nil unless candidates.length == 1

      arguments = canonical_command_arguments.call(candidates.first, command)
      next nil unless arguments&.length == 1

      canonical_literal_value.call(arguments.first, lines)
    end
    version_value = direct_literal.call("version")
    url_value = direct_literal.call("url")
    sha256_value = direct_literal.call("sha256")
    unless version_value&.match?(TIER2_BRIDGE_VERSION)
      abort "Tier-2 Formula must declare one canonical literal class version: #{path}"
    end
    unless url_value&.match?(%r{\Ahttps://[A-Za-z0-9][A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{0,2039}\z})
      abort "Tier-2 Formula must declare one canonical literal class source URL: #{path}"
    end
    unless sha256_value&.match?(TIER2_BRIDGE_SOURCE_SHA256)
      abort "Tier-2 Formula must declare one canonical literal class source SHA-256: #{path}"
    end

    tier2_bridge = {
      "package" => bridge_calls.first.fetch("package") || name,
      "script_env_keys" => bridge_calls.first.fetch("script_env_keys"),
      "source_sha256" => sha256_value,
      "source_url" => url_value,
      "version" => version_value,
    }
  end

  direct_positions = direct_dependency_positions.call(selected_class).sort
  all_positions = identifier_positions.call(source).sort
  unless all_positions == direct_positions
    abort "every depends_on must be a direct Formula class-body literal call: #{path}"
  end

  declarations = direct_positions.map do |line_number, _column|
    line = lines.fetch(line_number - 1)
    dependency_match = DEPENDENCY_LINE.match(line)
    requirement_match = NATIVE_REQUIREMENT_LINE.match(line)
    if !dependency_match.nil?
      {
        "line" => line_number,
        "name" => dependency_match[1],
        "requirement_class" => nil,
        "tags" => parse_tags.call(dependency_match[2], path, line_number),
      }
    elsif !requirement_match.nil?
      class_name = requirement_match[1]
      identity = NATIVE_REQUIREMENTS[class_name]
      if identity.nil?
        abort "depends_on uses unknown native Requirement #{class_name}:#{path}:#{line_number}"
      end
      tags = parse_tags.call(requirement_match[2], path, line_number)
      unless NATIVE_REQUIREMENT_TAG_SETS.include?(tags)
        abort "native Requirement must include :build and may also include :test at " \
              "#{path}:#{line_number}"
      end
      unless seen_requires.include?(support_require_line)
        abort "native Requirement requires the canonical tap-local Formula support require: " \
              "#{path}:#{line_number}"
      end
      validate_support.call(context)
      unless support_native_requirements_by_tap.fetch(formula_tap_name).include?(class_name)
        abort "native Requirement #{class_name} is not canonically defined by Formula support: " \
              "#{path}:#{line_number}"
      end
      {
        "line" => line_number,
        "name" => identity.fetch("formula"),
        "requirement_class" => "KandeloFormulaSupport::#{class_name}",
        "tags" => tags,
      }
    else
      abort "depends_on must use canonical literal Formula or native Requirement syntax at " \
            "#{path}:#{line_number}"
    end
  end
  line_positions = declarations.map { |declaration| [declaration.fetch("line"), 2] }.sort
  unless line_positions == direct_positions
    abort "depends_on syntax does not match the parsed direct calls: #{path}"
  end

  seen = Set.new
  runtime_declarations = []
  dependencies = declarations.each_with_object([]) do |declaration, selected|
    line_number = declaration.fetch("line")
    dependency = declaration.fetch("name")
    tags = declaration.fetch("tags")
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
  formula_dependency_declarations[full_name] = declarations.map do |declaration|
    {
      "name" => declaration.fetch("name"),
      "requirement_class" => declaration.fetch("requirement_class"),
      "tags" => declaration.fetch("tags"),
    }
  end
  formula_tier2_bridges[full_name] = {
    "formula_sha256" => Digest::SHA256.hexdigest(source),
    "support_sha256" => included_support ? support_sha256_by_tap.fetch(formula_tap_name) : nil,
    "support_runtime_sha256" => included_support ?
      support_runtime_sha256_by_tap.fetch(formula_tap_name) : nil,
    "tier2_bridge" => tier2_bridge,
  }
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
support_copies = formula_tier2_bridges.each_with_object({}) do |(full_name, record), copies|
  support_sha256 = record.fetch("support_sha256")
  next if support_sha256.nil?

  formula_tap_name = full_name.rpartition("/").first
  copies[formula_tap_name] = [
    support_api_version_by_tap.fetch(formula_tap_name),
    support_sha256,
    support_runtime_sha256_by_tap.fetch(formula_tap_name),
  ]
end
if support_copies.values.uniq.length > 1
  details = support_copies.sort.map do |name, (version, sha256, runtime_sha256)|
    "#{name}:v#{version}:support=#{sha256}:runtime=#{runtime_sha256}"
  end
  abort "Kandelo Formula support API or runtime-tree bytes differ across the immutable tap closure: " \
        "#{details.inspect}"
end
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
elsif tier2_bridge_only
  record = formula_tier2_bridges.fetch(target_full_name)
  document = JSON.generate({
    "schema" => 2,
    "tap" => tap_name,
    "formula" => target,
    "full_name" => target_full_name,
    "formula_sha256" => record.fetch("formula_sha256"),
    "support_sha256" => record.fetch("support_sha256"),
    "support_runtime_sha256" => record.fetch("support_runtime_sha256"),
    "tier2_bridge" => record.fetch("tier2_bridge"),
  })
  if document.bytesize > MAX_TIER2_CONTROL_BYTES
    abort "Tier-2 bridge plan exceeds #{MAX_TIER2_CONTROL_BYTES} bytes"
  end
  puts document
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
  native_requirements = []
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
    requirement_class = declaration.fetch("requirement_class")
    unless requirement_class.nil?
      short_class = requirement_class.delete_prefix("KandeloFormulaSupport::")
      identity = NATIVE_REQUIREMENTS.fetch(short_class)
      native_requirements << {
        "class" => requirement_class,
        "formula" => identity.fetch("formula"),
        "sentinel" => identity.fetch("executable"),
        "tags" => tags.to_a.map(&:to_s).sort,
      }
    end
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
    "schema" => 4,
    "tap" => tap_name,
    "formula" => target,
    "full_name" => "#{tap_name}/#{target}",
    "target_taps" => immutable_target_taps,
    "build" => build.sort,
    "build_and_test" => build_and_test.sort,
    "native_requirements" => native_requirements.sort_by { |entry| entry.fetch("class") },
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
