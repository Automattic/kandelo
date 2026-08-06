#!/usr/bin/env ruby
# frozen_string_literal: true

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
  homebrew-chromium-evidence.json
].freeze
IDENTITIES = %w[
  vfs selection report node_evidence chromium_evidence
].freeze
READBACK_SAFE_GITHUB_EXPRESSIONS = [
  "github.ref_type=='branch'&&" \
    "github.ref_name==github.event.repository.default_branch",
  "github.ref_name==github.event.repository.default_branch&&" \
    "github.ref_type=='branch'",
  "github.run_id",
  "github.run_attempt",
].freeze

def check(condition, message)
  raise message unless condition
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
  jobs.each do |name, job|
    check(guarded_to_default_branch?(job["if"]),
          "#{name} can run outside the default branch")
    check(job["timeout-minutes"].is_a?(Integer),
          "#{name} has no bounded timeout")
    check(job["steps"].is_a?(Array) && job["steps"].all?(Hash),
          "#{name} steps are malformed")
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
        "writer does not depend on the tested five-file artifact")
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
  npm_index = build_steps.index do |step|
    step["run"].to_s.match?(/(?:^|\n)\s*npm ci(?:\s|$)/)
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

  build_source = run_source(build)
  %w[
    images/vfs/scripts/build-homebrew-flat-vfs-image.ts
    scripts/homebrew-flat-vfs-node-smoke.ts
    homebrew-flat-vfs-shipping.spec.ts
    homebrew-vfs-build-report.json
    homebrew-node-evidence.json
    homebrew-chromium-evidence.json
  ].each do |fragment|
    check(build_source.include?(fragment),
          "build/test seam omits #{fragment}")
  end
  check(build_source.include?("--base-image host/wasm/rootfs.vfs"),
        "flat VFS does not consume build.sh's actual rootfs output")
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
        "builder artifact is not exactly the VFS and four evidence files")
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
  check(all_run_source.scan(/\bgh\s+release\s+create\b/).length == 1,
        "workflow must create one release exactly once")
  check(writer_source.scan(/\bgh\s+release\s+create\b/).length == 1,
        "the sole release creation must occur in the writer")
  release_assets = ["$ASSET_ROOT/$VFS_FILENAME", *FIXED_ASSETS.map do |name|
    "$ASSET_ROOT/#{name}"
  end]
  release_assets.each do |asset|
    check(writer_source.include?(%Q{"#{asset}"}),
          "release creation omits #{asset}")
  end
  check(writer_source.include?("--prerelease") &&
        writer_source.include?("--latest=false") &&
        writer_source.include?("sha256sum") &&
        writer_source.include?("stat -c '%s'"),
        "writer does not verify and prerelease the tested bytes")
  check(writer_source !~ /\b(?:source|eval|chmod)\b|\b(?:bash|sh|ruby|python\d*|node|npx)\s+["'$]/,
        "writer can execute downloaded artifact content")
  check(all_run_source !~ /\bgh\s+(?:api|release\s+(?:upload|edit|delete))\b|--clobber/i,
        "workflow can mutate or replace a release attempt")
  check(all_run_source !~ /scripts\/[^\s]*publish[^\s]*\.(?:sh|rb|py|ts)/i,
        "workflow invokes a custom release publisher")

  check(values_for_key(readback, "uses").empty?,
        "anonymous readback executes an action or checkout")
  readback_steps = readback.fetch("steps")
  check(
    readback_steps.map { |step| step["name"] } == [
      "Read back every public asset without credentials",
    ] && readback_steps.length == 1 && readback_steps.fetch(0).key?("run"),
    "readback must contain only the intended anonymous fetch step"
  )
  readback_source = run_source(readback)
  check(readback_source.include?("unset GH_TOKEN GITHUB_TOKEN") &&
        readback_source.include?("env -u GH_TOKEN -u GITHUB_TOKEN curl"),
        "public readback does not explicitly remove credentials")
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
  check(contract_text !~ /mirror|pages|default[-_ ]shell|main[-_ ]shell|shell[-_ ]activation/i,
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
