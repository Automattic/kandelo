#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "shellwords"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/homebrew-experimental-vfs-publish.yml") :
  File.expand_path(ARGV.fetch(0))

CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
FIXED_ASSETS = %w[
  homebrew-selection.json
  homebrew-vfs-build-report.json
  homebrew-node-evidence.json
].freeze
IDENTITIES = %w[
  vfs selection report node_evidence
].freeze
READBACK_SAFE_GITHUB_EXPRESSIONS = [
  "github.ref_type=='branch'&&" \
    "github.ref_name==github.event.repository.default_branch",
  "github.ref_name==github.event.repository.default_branch&&" \
    "github.ref_type=='branch'",
  "github.run_id",
  "github.run_attempt",
].freeze
WRITER_RUN_SHA256 =
  "1feaad1c77c67018fd16bb5c22b4b9180d69f13999f235b27cefd8f6bde4cc68"
READBACK_RUN_SHA256 =
  "cf4f8978c69e738aa710f228ecdf6df845ec231ba781e211827ada0743d66808"

def check(condition, message)
  raise message unless condition
end

def continued_command_tokens(source, prefix, label)
  lines = source.lines
  commands = []
  lines.each_index do |index|
    stripped = lines.fetch(index).lstrip
    next unless stripped == prefix || stripped.start_with?("#{prefix} ")

    command_lines = [lines.fetch(index)]
    while command_lines.last.end_with?("\\\n")
      index += 1
      check(index < lines.length, "#{label} has an unfinished continuation")
      command_lines << lines.fetch(index)
    end
    logical_command = command_lines.join.gsub("\\\n", " ")
    commands << Shellwords.shellsplit(logical_command)
  rescue ArgumentError => e
    raise "#{label} cannot be parsed: #{e.message}"
  end

  check(commands.length == 1,
        "expected one direct #{label}, found #{commands.length}")
  commands.fetch(0)
end

def workflow_events(workflow)
  workflow.key?("on") ? workflow["on"] : workflow[true]
end

def values_for_key(node, wanted, values = [])
  case node
  when Hash
    node.each do |key, value|
      values << value if key.to_s == wanted
      values_for_key(value, wanted, values)
    end
  when Array
    node.each { |value| values_for_key(value, wanted, values) }
  end
  values
end

def expression_strings(node, strings = [])
  case node
  when Hash
    node.each do |key, value|
      expression_strings(key, strings)
      expression_strings(value, strings)
    end
  when Array
    node.each { |value| expression_strings(value, strings) }
  when String
    strings << node if node.include?("${{")
  end
  strings
end

def readback_credential_expression?(readback)
  expression_strings(readback).any? do |source|
    compact = source.gsub(/\s+/, "").downcase
    next true if compact.match?(/\bsecrets\b/i)

    # WHY: remove only complete known-safe expressions. Parsing up to the
    # first `}}` would let a quoted delimiter hide a later token reference.
    READBACK_SAFE_GITHUB_EXPRESSIONS.each do |expression|
      compact = compact.gsub("${{#{expression}}}", "")
    end
    compact.match?(/\bgithub\b/i)
  end
end

def action_steps(job, action)
  job.fetch("steps").select { |step| step["uses"] == action }
end

def find_one(collection, label)
  matches = collection.select { |item| yield item }
  check(matches.length == 1, "expected one #{label}, found #{matches.length}")
  matches.fetch(0)
end

def guarded_to_default_branch?(guard)
  compact = guard.to_s.gsub(/\s+/, "")
  forward =
    "${{github.ref_type=='branch'&&" \
    "github.ref_name==github.event.repository.default_branch}}"
  reverse =
    "${{github.ref_name==github.event.repository.default_branch&&" \
    "github.ref_type=='branch'}}"
  [forward, reverse].include?(compact)
end

def permissions_for(job)
  job.fetch("permissions")
end

def needs(job)
  Array(job["needs"])
end

def run_source(job)
  job.fetch("steps").map { |step| step["run"] }.compact.join("\n")
end

def check_workflow(workflow)
  events = workflow_events(workflow)
  check(
    events.is_a?(Hash) && events.keys == ["workflow_dispatch"],
    "workflow_dispatch must be the only trigger"
  )
  check(!workflow.key?("env"),
        "workflow-level env can inject credentials into public readback")
  inputs = events.dig("workflow_dispatch", "inputs")
  check(inputs.is_a?(Hash), "workflow_dispatch inputs are missing")
  required_inputs = %w[selection-path selection-sha256 tap-revision]
  check(inputs.keys.sort == required_inputs.sort,
        "dispatch must expose only the exact tap and selection inputs")
  inputs.each do |name, specification|
    check(specification.is_a?(Hash) &&
          specification["required"] == true &&
          specification["type"] == "string",
          "#{name} must be a required string")
  end

  jobs = workflow.fetch("jobs")
  check(
    jobs.is_a?(Hash) && jobs.keys.sort == %w[build-test public-readback publish],
    "workflow jobs must be exactly build-test, publish, and public-readback"
  )
  build_name = "build-test"
  writer_name = "publish"
  readback_name = "public-readback"
  build = jobs.fetch(build_name)
  writer = jobs.fetch(writer_name)
  readback = jobs.fetch(readback_name)
  expected_readback_keys = %w[
    if needs permissions runs-on steps timeout-minutes
  ]
  expected_writer_keys = %w[
    if needs permissions runs-on steps timeout-minutes
  ]
  check(writer.keys.map(&:to_s).sort == expected_writer_keys.sort,
        "writer job contains an unsupported execution setting")
  check(readback.keys.map(&:to_s).sort == expected_readback_keys.sort,
        "readback job contains an unsupported execution setting")
  jobs.each do |name, job|
    unsupported_context = %w[container defaults env services] &
      job.keys.map(&:to_s)
    check(unsupported_context.empty?,
          "#{name} contains unsupported job-level execution context")
    check(guarded_to_default_branch?(job["if"]),
          "#{name} can run outside the default branch")
    check(job["timeout-minutes"].is_a?(Integer),
          "#{name} has no bounded timeout")
    check(job["steps"].is_a?(Array) && job["steps"].all?(Hash),
          "#{name} steps are malformed")
    check(job["runs-on"] == "ubuntu-latest",
          "#{name} must run on the GitHub-hosted Ubuntu runner")
    permission_keys = permissions_for(job).keys.map(&:to_s)
    check(permission_keys == ["contents"],
          "#{name} requests authority beyond repository contents")
    check(%w[read write].include?(permissions_for(job)["contents"]),
          "#{name} has an invalid contents permission")
  end

  check(permissions_for(build) == { "contents" => "read" },
        "builder must be read-only")
  check(permissions_for(writer) == { "contents" => "write" },
        "writer must have only contents write permission")
  check(permissions_for(readback) == { "contents" => "read" },
        "readback must be read-only")
  check(needs(writer).include?(build_name),
        "writer does not depend on the tested four-file artifact")
  check(needs(readback).include?(build_name) &&
        needs(readback).include?(writer_name),
        "readback does not wait for both build and publication")

  uses = values_for_key(workflow, "uses")
  check(uses.all? do |value|
    value.start_with?("./") || value.match?(/\A[^@\s]+@[0-9a-f]{40}\z/)
  end, "workflow contains an unpinned third-party action")
  check(values_for_key(workflow, "secrets").empty?,
        "workflow accepts or forwards a secret")

  kandelo_checkout = find_one(action_steps(build, CHECKOUT_ACTION),
                              "exact Kandelo checkout") do |step|
    step.dig("with", "ref") == "${{ github.sha }}" &&
      !step.dig("with")&.key?("repository")
  end
  check(kandelo_checkout.dig("with", "persist-credentials") == false &&
        kandelo_checkout.dig("with", "submodules") == "libc/musl",
        "Kandelo checkout retains credentials or omits musl")
  tap_checkout = find_one(action_steps(build, CHECKOUT_ACTION),
                          "exact tap checkout") do |step|
    step.dig("with", "repository") == "kandelo-dev/homebrew-tap-core"
  end
  check(tap_checkout.dig("with", "ref") == "${{ inputs.tap-revision }}" &&
        tap_checkout.dig("with", "path") == "tap" &&
        tap_checkout.dig("with", "persist-credentials") == false,
        "tap checkout is not the exact credential-free input revision")

  build_steps = build.fetch("steps")
  nix_index = build_steps.index do |step|
    step["uses"] == "./.github/actions/setup-nix"
  end
  sysroot_index = build_steps.index do |step|
    step["name"] == "Build worktree-local wasm32 sysroot"
  end
  npm_index = build_steps.index do |step|
    step["run"].to_s.match?(/(?:^|\n)\s*npm ci(?:\s|$)/)
  end
  browser_npm_index = build_steps.index do |step|
    step["run"].to_s.include?(
      "npm --prefix apps/browser-demos ci --no-audit --no-fund"
    )
  end
  validator_index = build_steps.index do |step|
    step["run"].to_s.include?("homebrew-validate-flat-selection.ts")
  end
  check(npm_index && validator_index && npm_index < validator_index,
        "locked JavaScript dependencies must precede selection validation")
  validator_source = build_steps.fetch(validator_index).fetch("run")
  admission_position = validator_source.index(
    "scripts/validate-homebrew-experimental-vfs-selection.sh"
  )
  tsx_position = validator_source.index("./node_modules/.bin/tsx")
  check(admission_position && tsx_position && admission_position < tsx_position,
        "selection admission must precede the declared tsx validator")
  check(!validator_source.match?(/\bnpx\b/),
        "selection validation may not fetch an undeclared npx tool")

  proof_index = build_steps.index do |step|
    step["name"] == "Build and prove the exact flat VFS"
  end
  check(nix_index && sysroot_index && proof_index &&
        nix_index < sysroot_index && sysroot_index < proof_index,
        "builder must prepare the worktree-local libc sysroot before building")
  expected_sysroot_build = <<~'SHELL'
    set -euo pipefail
    bash scripts/dev-shell.sh bash scripts/build-musl.sh
    test -f sysroot/lib/libc.a
  SHELL
  check(build_steps.fetch(sysroot_index)["run"] == expected_sysroot_build,
        "builder libc sysroot step is not the declared musl build")
  playwright_index = build_steps.index do |step|
    step["run"].to_s.include?(
      "./node_modules/.bin/playwright install chromium --with-deps"
    )
  end
  check(playwright_index && proof_index && playwright_index < proof_index,
        "locked Chromium installation must precede the browser smoke")
  check(browser_npm_index && playwright_index &&
        browser_npm_index < playwright_index,
        "locked browser-demo dependencies must precede Chromium installation")

  build_source = run_source(build)
  %w[
    images/vfs/scripts/build-homebrew-flat-vfs-image.ts
    scripts/homebrew-flat-vfs-node-smoke.ts
    homebrew-flat-vfs-shipping.spec.ts
    homebrew-vfs-build-report.json
    homebrew-node-evidence.json
  ].each do |fragment|
    check(build_source.include?(fragment),
          "build/test seam omits #{fragment}")
  end
  check(build_source.include?("--base-image host/wasm/rootfs.vfs"),
        "flat VFS does not consume build.sh's actual rootfs output")
  check(build_source.include?("scripts/build-rootfs.sh --default-install eager") &&
        build_source.include?("ROOTFS_SKIP_PACKAGE_RESOLVE=1") &&
        build_source.include?("ROOTFS_SEALED_BUILD=1"),
        "flat VFS base is not rebuilt as an explicit self-contained rootfs")
  check(build_source.include?(
          "--shell-config homebrew/main-shell-default.json"
        ) && !build_source.include?("homebrew/source-rootfs-shell-default.json"),
        "flat VFS does not select the tested Homebrew default shell")
  check(build_source.include?("--kernel local-binaries/kernel.wasm") &&
        !build_source.include?("local-binaries/kandelo-kernel.wasm"),
        "runtime proof does not bind build.sh's exact kernel artifact")
  browser_proof_environment = <<~'SHELL'.strip
    scripts/dev-shell.sh env \
      ASSET_ROOT="$ASSET_ROOT" \
      TAP_REVISION="$TAP_REVISION" \
      SELECTION_PATH="$SELECTION_PATH" \
      bash -c \
  SHELL
  check(build_source.include?(browser_proof_environment),
        "browser smoke inputs do not cross the clean dev-shell boundary")
  check(build_source.include?("--grep 'starts.*Ruby'") &&
        !build_source.include?("homebrew-chromium-evidence.json"),
        "browser gate must remain the bounded selected-runtime startup smoke")
  check(build_source !~ /\|\|\s*true|\btouch\b|\btruncate\b|status.{0,8}passed/i,
        "build/test seam fabricates or ignores runtime evidence")

  upload = action_steps(build, UPLOAD_ACTION).fetch(0)
  upload_paths = upload.dig("with", "path").to_s.lines.map(&:strip)
    .reject(&:empty?)
  expected_paths = [
    "${{ runner.temp }}/homebrew-experimental-vfs-assets/" \
      "${{ steps.identify.outputs.vfs_filename }}",
    *FIXED_ASSETS.map do |name|
      "${{ runner.temp }}/homebrew-experimental-vfs-assets/#{name}"
    end,
  ]
  check(upload_paths.sort == expected_paths.sort,
        "builder artifact is not exactly the VFS and three metadata/evidence files")
  check(upload.dig("with", "if-no-files-found") == "error",
        "builder can silently omit a release asset")

  identity_outputs = [
    "vfs_filename",
    *IDENTITIES.flat_map { |name| ["#{name}_sha256", "#{name}_bytes"] },
  ]
  identity_outputs.each do |name|
    check(build.dig("outputs", name) ==
          "${{ steps.identify.outputs.#{name} }}",
          "builder does not export tested #{name}")
  end

  download = find_one(action_steps(writer, DOWNLOAD_ACTION),
                      "same-run artifact download") { true }
  writer_steps = writer.fetch("steps")
  check(
    writer_steps.map { |step| step["name"] } == [
      "Download the fixed same-run artifact",
      "Publish the exact inert assets once",
    ],
    "writer must contain only the intended download and release steps"
  )
  check(writer_steps.count { |step| step.key?("run") } == 1 &&
        writer_steps.count { |step| step.key?("uses") } == 1,
        "writer must contain one action step and one release run step")
  check(download.dig("with", "name") == upload.dig("with", "name"),
        "writer does not consume the builder's artifact")
  check(values_for_key(writer, "uses") == [DOWNLOAD_ACTION],
        "credentialed writer executes an action besides artifact download")

  writer_source = run_source(writer)
  all_run_source = values_for_key(workflow, "run").join("\n")
  writer_step = find_one(writer.fetch("steps"), "release creation step") do |step|
    step["run"].to_s.match?(/\bgh\s+release\s+create\b/)
  end
  readback_step = find_one(readback.fetch("steps"), "public fetch step") do |step|
    step["run"].to_s.include?("/releases/download/")
  end
  expected_run_step_keys = %w[env name run shell]
  check(writer_step.keys.map(&:to_s).sort == expected_run_step_keys.sort &&
        writer_step["shell"] == "bash",
        "writer must use only the intended non-login Bash step")
  check(readback_step["shell"] == "bash",
        "readback must use non-login Bash")
  identity_outputs.each do |name|
    env_name = name.upcase
    expected = "${{ needs.#{build_name}.outputs.#{name} }}"
    check(writer_step.dig("env", env_name) == expected,
          "writer does not receive tested #{name}")
    check(readback_step.dig("env", env_name) == expected,
          "readback does not receive tested #{name}")
  end
  check(writer_step.dig("env", "GH_TOKEN") == "${{ github.token }}",
        "writer lacks the repository release token")
  expected_writer_env_keys = [
    "ASSET_ROOT",
    "GH_TOKEN",
    "RELEASE_TAG",
    *identity_outputs.map(&:upcase),
  ]
  check(writer_step.fetch("env").keys.map(&:to_s).sort ==
        expected_writer_env_keys.sort,
        "writer step env must contain only the release token and tested identities")
  # WHY: tokenizing the visible gh command cannot detect shell functions or
  # path reassignment around it. Freeze the complete authority-bearing body.
  check(Digest::SHA256.hexdigest(writer_step.fetch("run")) ==
        WRITER_RUN_SHA256,
        "writer run body differs from the reviewed release program")
  check(all_run_source.scan(/\bgh\s+release\s+create\b/).length == 1,
        "workflow must create one release exactly once")
  check(writer_source.scan(/\bgh\s+release\s+create\b/).length == 1,
        "the sole release creation must occur in the writer")
  release_assets = ["$ASSET_ROOT/$VFS_FILENAME", *FIXED_ASSETS.map do |name|
    "$ASSET_ROOT/#{name}"
  end]
  # WHY: the ASSET_ROOT inventory does not constrain an additional path
  # passed directly to gh, so validate the command's semantic arguments.
  release_tokens = continued_command_tokens(
    writer_source,
    "gh release create",
    "release creation command"
  )
  check(release_tokens.shift(3) == %w[gh release create] &&
        release_tokens.shift == "$RELEASE_TAG",
        "release creation must directly target the unique run tag")
  expected_release_options = {
    "--repo" => "$GITHUB_REPOSITORY",
    "--target" => "$GITHUB_SHA",
    "--title" => "Experimental ABI-42 Homebrew VFS",
    "--notes" =>
      "Experimental ABI-42 flat Homebrew VFS; full Node lifecycle verified; " \
      "Chromium selected-runtime startup smoke only.",
  }
  expected_release_flags = %w[--prerelease --latest=false]
  observed_release_options = {}
  observed_release_flags = []
  observed_release_assets = []
  until release_tokens.empty?
    token = release_tokens.shift
    if expected_release_options.key?(token)
      check(!observed_release_options.key?(token) && !release_tokens.empty?,
            "release creation repeats #{token} or omits its value")
      observed_release_options[token] = release_tokens.shift
    elsif expected_release_flags.include?(token)
      observed_release_flags << token
    elsif token.start_with?("-")
      raise "release creation uses unsupported option #{token}"
    else
      observed_release_assets << token
    end
  end
  check(observed_release_options == expected_release_options &&
        observed_release_flags.sort == expected_release_flags.sort &&
        observed_release_flags.length == expected_release_flags.length,
        "release creation must use only the fixed prerelease options")
  check(observed_release_assets.length == release_assets.length &&
        observed_release_assets.sort == release_assets.sort,
        "release creation must upload exactly the tested four assets")
  check(writer_source.include?("sha256sum") &&
        writer_source.include?("stat -c '%s'"),
        "writer does not verify the tested bytes")
  check(writer_source !~ /\b(?:source|eval|chmod)\b|\b(?:bash|sh|ruby|python\d*|node|npx)\s+["'$]/,
        "writer can execute downloaded artifact content")
  check(all_run_source !~ /\bgh\s+(?:api|release\s+(?:upload|edit|delete))\b|--clobber/i,
        "workflow can mutate or replace a release attempt")
  check(all_run_source !~ /scripts\/[^\s]*publish[^\s]*\.(?:sh|rb|py|ts)/i,
        "workflow invokes a custom release publisher")

  check(values_for_key(readback, "uses").empty?,
        "anonymous readback executes an action or checkout")
  readback_steps = readback.fetch("steps")
  expected_readback_step_keys = %w[env name run shell]
  check(
    readback_steps.map { |step| step["name"] } == [
      "Read back every public asset without credentials",
    ] && readback_steps.length == 1 &&
      readback_steps.fetch(0).keys.map(&:to_s).sort ==
        expected_readback_step_keys.sort,
    "readback must contain only the intended anonymous fetch step"
  )
  readback_env = readback_step.fetch("env")
  expected_readback_env_keys = [
    "ASSET_ROOT",
    "RELEASE_TAG",
    *identity_outputs.map(&:upcase),
  ]
  check(readback_env.is_a?(Hash) &&
        readback_env.keys.map(&:to_s).sort == expected_readback_env_keys.sort,
        "readback step env must contain only public asset identities")
  # WHY: an approved curl command can still be preceded by credentialed curl,
  # curlrc setup, or a parent-shell credential expansion. Freeze the whole body.
  check(Digest::SHA256.hexdigest(readback_step.fetch("run")) ==
        READBACK_RUN_SHA256,
        "readback run body differs from the reviewed anonymous fetch program")
  readback_source = run_source(readback)
  # WHY: unsetting named token variables still permits a differently named
  # inherited credential to be expanded into an Authorization argument.
  anonymous_curl_tokens = continued_command_tokens(
    readback_source,
    "env -i /usr/bin/curl",
    "anonymous readback curl command"
  )
  expected_curl_tokens = %w[
    env -i /usr/bin/curl --disable
    --fail --location --silent --show-error
    --proto =https --tlsv1.2
    --output $output $url
  ]
  check(readback_source.include?("unset GH_TOKEN GITHUB_TOKEN") &&
        anonymous_curl_tokens == expected_curl_tokens,
        "public readback curl must have an empty environment and exact anonymous arguments")
  check(!readback_credential_expression?(readback),
        "public readback can observe a credential expression")
  ["$VFS_FILENAME", *FIXED_ASSETS].each do |asset|
    check(readback_source.include?(%Q{fetch_and_verify "#{asset}"}),
          "public readback omits #{asset}")
  end
  check(readback_source.include?("sha256sum") &&
        readback_source.include?("stat -c '%s'"),
        "public readback does not verify exact public bytes")

  contract_text = [*inputs.keys, *values_for_key(workflow, "run")].join("\n")
  check(contract_text !~ /mirror|pages|shell[-_ ]activation/i,
        "workflow reintroduces a mirror, Pages, or shell gate")
  check(all_run_source !~ /\bgit\s+(?:push|commit)\b|\bdocker\s+push\b|\boras\s+push\b|\bbrew\s+bottle\b|homebrew-merge-bottle|publish-bottles/i,
        "workflow can publish bottles or mutate another registry")
end

begin
  workflow = YAML.safe_load(
    File.read(WORKFLOW),
    permitted_classes: [],
    aliases: false
  )
  check(workflow.is_a?(Hash), "workflow is not a mapping")
  check_workflow(workflow)
  puts "check-homebrew-experimental-vfs-workflow.rb: ok"
rescue Errno::ENOENT, KeyError, NoMethodError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-experimental-vfs-workflow.rb: #{e.message}"
  exit 1
end
