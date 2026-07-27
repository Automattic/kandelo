#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/reusable-homebrew-main-shell-mirror-publish.yml") :
  File.expand_path(ARGV.fetch(0))
PUBLISH_JOB_DIGEST =
  "81d6ac11e753e8ff24b124dfb00e9e390f898b28a30953538fafa90a7cc8be64"
WORKFLOW_DIGEST =
  "f30d64bf371a45b02c11290a10744a2ab31ef616dabf52a101480b928a0f05be"

def check(condition, message)
  raise message unless condition
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

def contract_digest(value)
  Digest::SHA256.hexdigest(JSON.generate(canonical_contract(value)))
end

begin
workflow = YAML.safe_load(File.read(WORKFLOW), permitted_classes: [], aliases: false)
check(workflow.is_a?(Hash), "workflow is not a mapping")
top_level_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }
check(top_level_keys.sort == %w[concurrency jobs name on],
      "workflow top-level contract differs")
check(workflow["name"] == "Reusable Homebrew main-shell mirror publish",
      "workflow name differs")
check(workflow["concurrency"] == {
  "group" => "homebrew-main-shell-mirror-${{ github.repository }}",
  "cancel-in-progress" => false,
}, "workflow concurrency differs")
events = workflow.key?("on") ? workflow["on"] : workflow[true]
check(events.is_a?(Hash) && events.keys == ["workflow_call"],
      "workflow must expose only workflow_call")
call = events.fetch("workflow_call")
check(call.keys.sort == ["inputs"], "workflow_call may expose only inputs")
inputs = call.fetch("inputs")
check(inputs.keys.sort == %w[canary-ref kandelo-ref tap-catalog-ref],
      "workflow input identity set differs")
inputs.each do |name, spec|
  check(spec["required"] == true && spec["type"] == "string",
        "#{name} must be a required string")
end

jobs = workflow.fetch("jobs")
check(jobs.keys.sort == %w[prepare public-proof publish], "job set differs")
expected_permissions = {
  "prepare" => { "contents" => "read" },
  "publish" => { "actions" => "read", "contents" => "write" },
  "public-proof" => { "actions" => "read", "contents" => "read" },
}
expected_permissions.each do |name, permissions|
  check(jobs.fetch(name).fetch("permissions") == permissions,
        "#{name} permissions differ")
end
check(!jobs.fetch("prepare").key?("needs"), "prepare must be the source job")
check(jobs.fetch("publish")["needs"] == "prepare", "publish dependency differs")
check(jobs.fetch("public-proof")["needs"] == %w[prepare publish],
      "public proof dependency differs")
# WHY: this is the only job with the tap's write token. Freezing its complete
# declarative contract prevents an apparently harmless extra step, job-level
# environment, action, or checkout option from gaining publication authority.
check(contract_digest(jobs.fetch("publish")) == PUBLISH_JOB_DIGEST,
      "write-capable publish job contract differs")

allowed_actions = [
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
  "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d",
].freeze

jobs.each do |job_name, job|
  steps = job.fetch("steps")
  check(steps.is_a?(Array) && steps.all?(Hash), "#{job_name} steps differ")
  steps.map { |step| step["uses"] }.compact.each do |action|
    check(allowed_actions.include?(action), "untrusted or unpinned action: #{action}")
  end
  steps.select { |step| step["uses"]&.start_with?("actions/download-artifact@") }.
    each do |step|
      with = step.fetch("with")
      check(with.keys.sort == %w[name path],
            "#{job_name} artifact download may only select a same-run name and path")
      check(with["name"] == "homebrew-main-shell-mirror-handoff",
            "#{job_name} artifact name differs")
    end
end

prepare_source = YAML.dump(jobs.fetch("prepare"))
publish_source = YAML.dump(jobs.fetch("publish"))
proof_source = YAML.dump(jobs.fetch("public-proof"))
whole_source = File.read(WORKFLOW)

check(prepare_source.include?("persist-credentials: false"),
      "preparation checkouts must not retain credentials")
check(publish_source.include?("persist-credentials: false") &&
      !publish_source.include?("persist-credentials: true"),
      "publication checkouts must not retain Git credentials")
check(prepare_source.include?("env -u GH_TOKEN -u GITHUB_TOKEN"),
      "mirror recovery must explicitly remove GitHub credentials")
check(prepare_source.include?("retention-days: 1"),
      "bounded handoff retention differs")
check(jobs.fetch("prepare").fetch("outputs") == {
  "artifact-digest" => "${{ steps.handoff.outputs.artifact-digest }}",
}, "handoff digest output differs")
check(publish_source.scan("${{ github.token }}").length == 2,
      "tap token must have exactly the authority checks and publisher uses")
check(!prepare_source.include?("${{ github.token }}") &&
      !proof_source.include?("${{ github.token }}"),
      "tap token escaped the publication job")
check(publish_source.include?("--exact-target-main-sha \"$TAP_AUTHORITY_REF\""),
      "publisher is not bound to exact live tap main")
check(
  prepare_source.include?("git -C tap-authority merge-base --is-ancestor") &&
    prepare_source.include?('"$TAP_CATALOG_REF" "$TAP_AUTHORITY_REF"'),
  "tap catalog is not proven to precede publication authority",
)
check(prepare_source.include?(
  ".github/scripts/check-homebrew-main-shell-release-locks.py"
), "structured shell release-lock validation is missing")
check(prepare_source.include?(
  '--target-commitish "$TAP_AUTHORITY_REF"'
), "release target is not the protected tap caller")
check(publish_source.include?("publish-immutable-github-release.sh"),
      "immutable publisher is missing")
check(proof_source.include?("--transport-mode public"),
      "Node public transport proof is missing")
check(proof_source.include?('--core-revision "$TAP_CATALOG_REF"'),
      "guest lifecycle is not pinned to the sealed tap catalog")
check(proof_source.include?("--project=chromium"),
      "Chromium public transport proof is missing")
check(proof_source.include?("VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT"),
      "Chromium proof does not exclude the closed acceptance root")

forbidden = [
  "secrets: inherit",
  "pull_request_target",
  "workflow_run",
  "actions/create-github-app-token",
  "run-id:",
  "github.event.workflow_run",
  "github.event.client_payload",
  "HOMEBREW_GITHUB_API_TOKEN:",
]
forbidden.each do |text|
  check(!whole_source.include?(text), "forbidden workflow capability: #{text}")
end
check(whole_source.include?(
  '"$CALLER_REPOSITORY/.github/workflows/publish-main-shell-mirror.yml@refs/heads/main"'
) && whole_source.include?(
  '${CALLER_REPOSITORY,,}" = kandelo-dev/homebrew-tap-core'
), "protected tap caller identity is missing")
check(whole_source.scan('TAP_AUTHORITY_REF: ${{ github.sha }}').length >= 4,
      "jobs do not derive tap authority from the protected caller SHA")
check(!whole_source.include?("inputs.tap-authority-ref"),
      "event data may not select tap publication authority")
# WHY: preparation supplies the exact bytes later accepted by the token-bearing
# job, and public-proof supplies the release claim. Freezing only the write job
# would still permit either side of that authority/evidence chain to change.
check(contract_digest(workflow) == WORKFLOW_DIGEST,
      "complete mirror workflow contract differs")

puts "check-homebrew-main-shell-mirror-workflow.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-main-shell-mirror-workflow.rb: #{e.message}"
  exit 1
end
