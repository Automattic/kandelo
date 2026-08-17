#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
WORKFLOW_PATH = File.join(
  REPO_ROOT, ".github/workflows/staging-build.yml"
)
LIFECYCLE_PATH = File.join(
  REPO_ROOT, "scripts/test-homebrew-publisher-real-lifecycle.sh"
)
ROOTS_PATH = File.join(
  REPO_ROOT, "homebrew/homebrew-native-compatibility-roots.json"
)
DEV_SHELL_PATH = File.join(REPO_ROOT, "scripts/dev-shell.sh")
CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
SOURCE_STEP = "Checkout exact Homebrew lifecycle source"
VALIDATION_STEP = "Validate Homebrew publisher trust contract"

def check(condition, message)
  raise message unless condition
end

def named_step(steps, name)
  matches = steps.select { |step| step["name"] == name }
  check(matches.length == 1, "expected exactly one #{name.inspect} step")
  matches.first
end

def lifecycle_commit(source)
  match = source.match(
    /^BREW_COMMIT="([0-9a-f]{40})"$/
  )
  check(match, "real lifecycle lacks one exact Homebrew commit")
  match[1]
end

def check_contract(workflow, lifecycle, roots, dev_shell)
  jobs = workflow.fetch("jobs")
  preflight = jobs.fetch("preflight")
  check(preflight.fetch("permissions") == {
    "contents" => "read",
    "statuses" => "write",
  }, "staging preflight authority changed")
  steps = preflight.fetch("steps")
  source = named_step(steps, SOURCE_STEP)
  validation = named_step(steps, VALIDATION_STEP)
  commit = lifecycle_commit(lifecycle)

  check(source == {
    "name" => SOURCE_STEP,
    "uses" => CHECKOUT_ACTION,
    "with" => {
      "persist-credentials" => false,
      "repository" => "Homebrew/brew",
      "ref" => commit,
      "path" => "homebrew-lifecycle-source",
    },
  }, "staging lifecycle source is not the exact read-only checkout")
  check(steps.index(source) < steps.index(validation),
        "staging validates the publisher before provisioning its source")
  check(validation.keys.sort == %w[name run],
        "staging lifecycle validation gained ambient configuration")

  expected_run = <<~SHELL
    bash scripts/dev-shell.sh env \\
      KANDELO_HOMEBREW_SOURCE_REPOSITORY="$GITHUB_WORKSPACE/homebrew-lifecycle-source" \\
      bash scripts/test-homebrew-publish-workflow.sh
  SHELL
  check(validation.fetch("run") == expected_run,
        "staging does not scope the exact source to the publisher suite")
  check(roots.fetch("homebrew_commit") == commit,
        "lifecycle and native roots select different Homebrew commits")
  check(!dev_shell.include?(
          "--keep KANDELO_HOMEBREW_SOURCE_REPOSITORY"
        ), "dev shell globally preserves lifecycle source authority")
  check(lifecycle.include?(
          'elif [ -n "${CI:-}" ]; then'
        ) && lifecycle.include?(
          "CI must declare KANDELO_HOMEBREW_SOURCE_REPOSITORY"
        ), "real lifecycle permits CI to select ambient Homebrew")
  check(lifecycle.include?(
          "the declared Homebrew source does not contain the pinned lifecycle commit"
        ), "real lifecycle falls back after an invalid declared source")
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
  check(rejected, "contract accepted #{label}")
end

workflow = YAML.safe_load(File.read(WORKFLOW_PATH), aliases: false)
lifecycle = File.read(LIFECYCLE_PATH)
roots = JSON.parse(File.read(ROOTS_PATH))
dev_shell = File.read(DEV_SHELL_PATH)

check_contract(workflow, lifecycle, roots, dev_shell)

{
  "mutable Homebrew source" => lambda { |candidate|
    named_step(
      candidate.fetch("jobs").fetch("preflight").fetch("steps"),
      SOURCE_STEP
    ).fetch("with")["ref"] = "main"
  },
  "credential-persisting source" => lambda { |candidate|
    named_step(
      candidate.fetch("jobs").fetch("preflight").fetch("steps"),
      SOURCE_STEP
    ).fetch("with")["persist-credentials"] = true
  },
  "unscoped lifecycle source" => lambda { |candidate|
    named_step(
      candidate.fetch("jobs").fetch("preflight").fetch("steps"),
      VALIDATION_STEP
    )["env"] = {
      "KANDELO_HOMEBREW_SOURCE_REPOSITORY" =>
        "${{ github.workspace }}/homebrew-lifecycle-source",
    }
  },
  "validation before source checkout" => lambda { |candidate|
    steps = candidate.fetch("jobs").fetch("preflight").fetch("steps")
    source_index = steps.index(named_step(steps, SOURCE_STEP))
    validation_index = steps.index(named_step(steps, VALIDATION_STEP))
    steps[source_index], steps[validation_index] =
      steps[validation_index], steps[source_index]
  },
}.each do |label, mutation|
  expect_rejection(label) do
    candidate = deep_copy(workflow)
    mutation.call(candidate)
    check_contract(candidate, lifecycle, roots, dev_shell)
  end
end

expect_rejection("mismatched lifecycle commit") do
  changed = lifecycle.sub(
    lifecycle_commit(lifecycle), "a" * 40
  )
  check_contract(workflow, changed, roots, dev_shell)
end

expect_rejection("globally inherited lifecycle source") do
  changed = "#{dev_shell}\n--keep KANDELO_HOMEBREW_SOURCE_REPOSITORY\n"
  check_contract(workflow, lifecycle, roots, changed)
end

puts "test-homebrew-publisher-lifecycle-source.rb: ok"
