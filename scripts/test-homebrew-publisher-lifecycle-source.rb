#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
WORKFLOW_PATH = File.join(
  REPO_ROOT, ".github/workflows/staging-build.yml"
)
FORBIDDEN_STAGING_STEP_NAMES = [
  "Seal conventional host runtime ownership",
  "Checkout exact Homebrew lifecycle source",
  "Install JavaScript dependencies for Homebrew preflight",
  "Validate Homebrew publisher trust contract",
].freeze
FORBIDDEN_STAGING_FRAGMENTS = [
  "scripts/test-homebrew-publish-workflow.sh",
  "scripts/prepare-homebrew-recipe-host-runtime.py",
  "Homebrew/brew",
  "homebrew-lifecycle-source",
].freeze

def check(condition, message)
  raise message unless condition
end

def deep_copy(value)
  Marshal.load(Marshal.dump(value))
end

def check_contract(workflow)
  jobs = workflow.fetch("jobs")
  preflight = jobs.fetch("preflight")
  check(preflight.fetch("permissions") == {
    "contents" => "read",
    "statuses" => "write",
  }, "staging preflight authority changed")

  steps = preflight.fetch("steps")
  step_names = steps.filter_map { |step| step["name"] }
  forbidden_names = FORBIDDEN_STAGING_STEP_NAMES & step_names
  check(
    forbidden_names.empty?,
    "ordinary staging contains publisher-only steps: " \
      "#{forbidden_names.sort.inspect}"
  )

  serialized = JSON.generate(preflight)
  forbidden_fragments = FORBIDDEN_STAGING_FRAGMENTS.select do |fragment|
    serialized.include?(fragment)
  end
  check(
    forbidden_fragments.empty?,
    "ordinary staging contains publisher integration: " \
      "#{forbidden_fragments.sort.inspect}"
  )
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
check_contract(workflow)

FORBIDDEN_STAGING_FRAGMENTS.each do |fragment|
  expect_rejection("publisher integration fragment #{fragment.inspect}") do
    candidate = deep_copy(workflow)
    candidate.fetch("jobs").fetch("preflight").fetch("steps") << {
      "name" => "Unreviewed staging command",
      "run" => "printf '%s\\n' #{fragment.inspect}",
    }
    check_contract(candidate)
  end
end

FORBIDDEN_STAGING_STEP_NAMES.each do |name|
  expect_rejection("publisher-only step #{name.inspect}") do
    candidate = deep_copy(workflow)
    candidate.fetch("jobs").fetch("preflight").fetch("steps") << {
      "name" => name,
      "run" => "true",
    }
    check_contract(candidate)
  end
end

puts "test-homebrew-publisher-lifecycle-source.rb: ok"
