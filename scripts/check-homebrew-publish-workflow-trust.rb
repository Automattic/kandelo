#!/usr/bin/env ruby
# frozen_string_literal: true

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
end

def check_publisher(workflow)
  jobs = workflow_jobs(workflow)
  check(!workflow.key?("permissions"), "reusable publisher requests workflow permissions")
  check(jobs.values.none? { |job| job.is_a?(Hash) && job.key?("permissions") },
        "reusable publisher requests job permissions")
  check_common(workflow, "reusable publisher")

  plan_steps = job_steps(jobs.fetch("plan"), "publisher plan")
  validation_index = plan_steps.index { |step| step["name"] == "Validate caller trust boundary" }
  checkout_indices = plan_steps.each_index.select do |index|
    plan_steps[index]["uses"].to_s.downcase.start_with?("actions/checkout@")
  end
  check(!validation_index.nil?, "publisher lacks caller trust validation")
  check(!checkout_indices.empty? && validation_index < checkout_indices.min,
        "publisher does not validate caller trust before checkout")

  validation = plan_steps.fetch(validation_index)
  validation_env = validation["env"]
  check(validation_env.is_a?(Hash), "publisher trust validation lacks an env mapping")
  {
    "DRY_RUN" => "${{ inputs.dry-run }}",
    "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
    "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
    "TAP_REF" => "${{ inputs.tap-ref }}",
    "BOTTLE_ROOT_URL" => "${{ inputs.bottle-root-url }}",
    "SIDECAR_COMMAND" => "${{ inputs.sidecar-command }}",
  }.each do |key, value|
    check(validation_env[key] == value, "publisher trust validation has an unexpected #{key}")
  end
  validation_run = validation["run"].to_s
  check(validation_run.include?('[ "$KANDELO_REF" = "main" ]'),
        "publisher does not constrain write publication to Kandelo main")
  check(validation_run.include?('[ "$TAP_REF" = "main" ]'),
        "publisher does not constrain write publication to tap main")
  check(validation_run.include?('[ "$DRY_RUN" = "true" ]'),
        "publisher does not isolate the selected-ref dry-run path")

  setup_steps = values_for_key(workflow, "uses").grep(
    "Homebrew/actions/setup-homebrew@1f8e202ffddf94def7f42f6fa3a482e821489f9c"
  )
  check(setup_steps.length == 1, "Homebrew setup action is not pinned exactly once")

  magic_step = workflow_jobs(workflow).values.flat_map do |job|
    job.is_a?(Hash) && job["steps"].is_a?(Array) ? job["steps"] : []
  end.find { |step| step["uses"].to_s.start_with?("DeterminateSystems/magic-nix-cache-action@") }
  check(!magic_step.nil?, "publisher lacks the reviewed Magic Nix setup step")
  check(magic_step.dig("with", "use-gha-cache") == false,
        "publisher enables Magic Nix GitHub Actions caching")
  check(magic_step.dig("with", "use-flakehub") == false,
        "publisher enables Magic Nix FlakeHub caching")
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
  rebuild = jobs.fetch("rebuild-or-repair")
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
end

def self_test
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
end

begin
  self_test
  check_publisher(load_workflow(PUBLISHER_PATH))
  check_maintenance(load_workflow(MAINTENANCE_PATH))
  puts "check-homebrew-publish-workflow-trust.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-publish-workflow-trust.rb: #{e.message}"
  exit 1
end
