#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
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
  events = workflow_events(workflow)
  check(events.keys == ["workflow_call"], "publisher must only expose workflow_call")
  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[build-and-publish plan], "publisher has an unexpected job set")
  check(jobs.fetch("plan").keys.sort == %w[outputs runs-on steps],
        "publisher plan execution contract changed")
  check(jobs.fetch("build-and-publish").keys.sort ==
        %w[if needs runs-on steps strategy timeout-minutes],
        "publisher build execution contract changed")
  check(!workflow.key?("permissions"), "reusable publisher requests workflow permissions")
  check(jobs.values.none? { |job| job.is_a?(Hash) && job.key?("permissions") },
        "reusable publisher requests job permissions")
  check_common(workflow, "reusable publisher")

  plan_steps = job_steps(jobs.fetch("plan"), "publisher plan")
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
    *Array.new(4, "actions/checkout@v6.0.2"),
    "Homebrew/actions/setup-homebrew@1f8e202ffddf94def7f42f6fa3a482e821489f9c",
    "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
    "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d",
    "actions/upload-artifact@v7",
  ].sort
  check(values_for_key(workflow, "uses").sort == expected_uses,
        "publisher action set or pin changed")

  magic_steps = workflow_steps(workflow).select do |step|
    step["uses"] == "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d"
  end
  check(magic_steps.length == 1, "publisher lacks exactly one reviewed Magic Nix step")
  magic_step = magic_steps.first
  check(magic_step.dig("with", "use-gha-cache") == false,
        "publisher enables Magic Nix GitHub Actions caching")
  check(magic_step.dig("with", "use-flakehub") == false,
        "publisher enables Magic Nix FlakeHub caching")

  expected_outputs = {
    "matrix" => "${{ steps.matrix.outputs.matrix }}",
    "abi" => "${{ steps.release.outputs.abi }}",
    "release-tag" => "${{ steps.release.outputs.release-tag }}",
    "bottle-root-prefix" => "${{ steps.release.outputs.bottle-root-prefix }}",
  }
  check(jobs.fetch("plan")["outputs"] == expected_outputs, "publisher plan outputs changed")
  build = jobs.fetch("build-and-publish")
  check(build["needs"] == ["plan"], "publisher build does not depend exactly on plan")
  check(build["if"] == "${{ needs.plan.outputs.matrix != '[]' }}",
        "publisher build condition bypasses the validated matrix")
  check(build.dig("strategy", "matrix", "include") ==
        "${{ fromJson(needs.plan.outputs.matrix) }}",
        "publisher build matrix bypasses the validated plan output")

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

  build_checkouts = job_steps(build, "publisher build").select do |step|
    step["uses"].to_s.downcase.start_with?("actions/checkout@")
  end.map { |step| { "name" => step["name"], "with" => step["with"] } }
  expected_build_checkouts = [expected_plan_checkouts[1], expected_plan_checkouts[0]]
  check(build_checkouts == expected_build_checkouts, "publisher build checkout wiring changed")
end

def check_maintenance(workflow)
  events = workflow_events(workflow)
  check(events.keys == ["workflow_call"], "maintenance must only expose workflow_call")
  inputs = events.fetch("workflow_call").fetch("inputs")
  forbidden_inputs = %w[
    kandelo-repository kandelo-ref tap-repository tap-ref bottle-root-url sidecar-command dry-run
  ]
  check((inputs.keys & forbidden_inputs).empty?, "maintenance exposes executable refs or commands")
  check_common(workflow, "maintenance workflow")

  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[rebuild-or-repair rollback],
        "maintenance has an unexpected job set")
  expected_uses = [
    "./.github/workflows/reusable-homebrew-bottle-publish.yml",
    "actions/checkout@v6.0.2",
    "actions/checkout@v6.0.2",
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
  rebuild_with = rebuild.fetch("with")
  check(rebuild_with["kandelo-repository"] == "Automattic/kandelo" &&
        rebuild_with["kandelo-ref"] == "main" &&
        rebuild_with["tap-repository"] == "Automattic/kandelo-homebrew" &&
        rebuild_with["tap-ref"] == "main", "maintenance rebuild does not use first-party main refs")
  check(rebuild_with["dry-run"] == false, "maintenance rebuild exposes a write-scoped dry run")

  rollback = jobs.fetch("rollback")
  check(rollback.keys.sort == %w[if permissions runs-on steps timeout-minutes] &&
        rollback["if"] == "${{ inputs.mode == 'rollback' }}",
        "maintenance rollback execution contract changed")
  expected_rollback_permissions = { "contents" => "write", "packages" => "read", "actions" => "read" }
  check(exact_permissions?(rollback["permissions"], expected_rollback_permissions),
        "maintenance rollback permissions are not exact")
  rollback_steps = job_steps(rollback, "maintenance rollback")
  checkout_refs = rollback_steps.filter_map do |step|
    next unless step["uses"].to_s.downcase.start_with?("actions/checkout@")
    [step.dig("with", "repository"), step.dig("with", "ref")]
  end
  check(checkout_refs == [["Automattic/kandelo-homebrew", "main"], ["Automattic/kandelo", "main"]],
        "maintenance rollback does not check out first-party main refs")

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

  expect_rejection("an extra publisher job") do
    mutated = deep_copy(publisher)
    mutated.fetch("jobs")["backdoor"] = { "uses" => "owner/repo/.github/workflows/write.yml@main" }
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
