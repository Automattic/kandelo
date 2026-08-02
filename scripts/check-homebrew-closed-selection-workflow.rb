#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(
    ROOT,
    ".github/workflows/reusable-homebrew-closed-selection-publish.yml"
  ) : File.expand_path(ARGV.fetch(0))
WORKFLOW_DIGEST =
  "e87a43bc0aa8fb7e24c933f12509325e663b0bad3f6207e9b795087cca15e698"
PREPARATION_ARTIFACT = "homebrew-closed-selection-preparation"
CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"

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

def named_step(job, name)
  matches = job.fetch("steps").select { |step| step["name"] == name }
  check(matches.length == 1, "expected exactly one #{name.inspect} step")
  matches.fetch(0)
end

def check_workflow(workflow)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }
  check(
    top_keys.sort == %w[concurrency jobs name on],
    "workflow top-level contract differs"
  )
  check(
    workflow["name"] == "Reusable Homebrew closed-selection publish",
    "workflow name differs"
  )
  check(
    workflow["concurrency"] == {
      "group" =>
        "homebrew-closed-selection-${{ github.repository }}-" \
        "${{ inputs.selection-plan-sha256 }}",
      "cancel-in-progress" => false,
    },
    "workflow concurrency differs"
  )
  events = workflow_events(workflow)
  check(
    events.is_a?(Hash) && events.keys == ["workflow_call"],
    "workflow must expose only workflow_call"
  )
  call = events.fetch("workflow_call")
  check(call.keys == ["inputs"], "workflow_call may expose only inputs")
  inputs = call.fetch("inputs")
  check(
    inputs.keys.sort == %w[
      kandelo-ref selection-plan selection-plan-sha256
    ],
    "workflow input set differs"
  )
  inputs.each do |name, specification|
    check(
      specification["type"] == "string" &&
        specification["required"] == true &&
        specification.keys.sort == %w[description required type],
      "#{name} must be one required documented string"
    )
  end

  jobs = workflow.fetch("jobs")
  check(jobs.keys.sort == %w[prepare publish], "workflow job set differs")
  prepare = jobs.fetch("prepare")
  publish = jobs.fetch("publish")
  check(
    prepare.fetch("permissions") == { "contents" => "read" },
    "prepare permission ceiling differs"
  )
  check(
    publish.fetch("permissions") == {
      "actions" => "read",
      "contents" => "write",
    },
    "publish permission ceiling differs"
  )
  check(!prepare.key?("needs"), "prepare must be the source job")
  check(publish["needs"] == "prepare", "publish dependency differs")
  [prepare, publish].each do |job|
    check(job["runs-on"] == "ubuntu-latest", "job runner differs")
    check(job.fetch("steps").all?(Hash), "job steps are malformed")
  end

  allowed_actions = [CHECKOUT_ACTION, UPLOAD_ACTION, DOWNLOAD_ACTION]
  uses = values_for_key(workflow, "uses")
  check(
    uses.all? { |value| allowed_actions.include?(value) },
    "workflow contains an untrusted or unpinned action"
  )
  check(uses.count(CHECKOUT_ACTION) == 4, "checkout set differs")
  check(uses.count(UPLOAD_ACTION) == 2, "artifact upload set differs")
  check(uses.count(DOWNLOAD_ACTION) == 1, "artifact download set differs")
  check(values_for_key(workflow, "secrets").empty?,
        "workflow accepts or forwards a secret")
  check(values_for_key(workflow, "packages").empty?,
        "workflow requests package authority")

  prepare_upload = prepare.fetch("steps").find do |step|
    step["uses"] == UPLOAD_ACTION
  end
  check(
    prepare_upload.fetch("with") == {
      "name" => PREPARATION_ARTIFACT,
      "path" => "${{ runner.temp }}/closed-selection/prepared",
      "if-no-files-found" => "error",
      "retention-days" => 7,
    },
    "prepare artifact contract differs"
  )
  download = publish.fetch("steps").find do |step|
    step["uses"] == DOWNLOAD_ACTION
  end
  check(
    download.fetch("with") == {
      "artifact-ids" => "${{ needs.prepare.outputs.artifact-id }}",
      "path" => "${{ runner.temp }}/closed-selection-preparation",
    },
    "publish downloads something other than the same-run preparation"
  )

  admission = named_step(
    prepare,
    "Admit the protected tap caller and publisher ref"
  )
  admission_source = admission.fetch("run")
  %w[workflow_dispatch refs/heads/main publish-closed-selection.yml].each do |text|
    check(admission_source.include?(text),
          "caller admission omits #{text}")
  end
  main_check = named_step(
    prepare,
    "Require the checked-out publisher to be current main"
  ).fetch("run")
  check(main_check.include?("refs/heads/main"),
        "publisher checkout is not bound to current public main")

  credential_free_steps = [
    "Admit the exact digest-bound selection plan",
    "Fetch the exact public campaign",
    "Materialize the sealed campaign tap source",
    "Assemble the exact selection from public handoffs",
    "Verify the downloaded selection against its plan",
  ]
  credential_free_steps.each do |name|
    job = name.start_with?("Verify") ? publish : prepare
    source = named_step(job, name).fetch("run")
    check(source.include?("env -u GH_TOKEN -u GITHUB_TOKEN"),
          "#{name} can observe publication credentials")
  end
  plan_admission = named_step(
    prepare,
    "Admit the exact digest-bound selection plan"
  )
  check(
    plan_admission.fetch("env") == {
      "SELECTION_PLAN" => "${{ inputs.selection-plan }}",
      "PLAN_SHA256" => "${{ inputs.selection-plan-sha256 }}",
    },
    "plan admission does not receive the exact reusable inputs"
  )

  artifact_admission = named_step(
    publish,
    "Admit the exact same-run preparation artifact"
  )
  artifact_source = artifact_admission.fetch("run")
  check(
    artifact_source.include?("actions/artifacts/$EXPECTED_ID") &&
      artifact_source.include?("sha256:$EXPECTED_DIGEST") &&
      artifact_source.include?(".digest == $digest") &&
      artifact_source.include?(".id == $id") &&
      artifact_source.include?(".workflow_run.id == $run_id") &&
      artifact_source.include?(".workflow_run.head_sha == $head_sha"),
    "write job does not bind the exact same-run artifact identity"
  )

  authority_source = named_step(
    publish,
    "Recheck protected publication authorities"
  ).fetch("run")
  check(
    authority_source.scan("require-exact-repository-main.sh").length == 2,
    "write job does not recheck both exact main authorities"
  )
  publish_step = named_step(
    publish,
    "Publish and anonymously read back the exact selection"
  )
  publish_source = publish_step.fetch("run")
  %w[
    publish-homebrew-closed-selection-release.sh
    --selection
    --lock-root
    --receipt
    --kandelo-main-contains-sha
    --target-main-contains-sha
  ].each do |text|
    check(publish_source.include?(text),
          "write job omits publisher contract #{text}")
  end
  check(
    publish_step.fetch("env").keys.sort == %w[
      CAMPAIGN_KANDELO_COMMIT GH_TOKEN SOURCE_TAP_COMMIT
    ],
    "publication step receives unexpected environment authority"
  )
  check(
    values_for_key(workflow, "run").none? do |source|
      source.include?("gh release create") ||
        source.include?("gh release upload")
    end,
    "workflow duplicates immutable release publication logic"
  )
  check(
    contract_digest(workflow) == WORKFLOW_DIGEST,
    "complete workflow contract differs: " \
    "#{contract_digest(workflow)}"
  )
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

begin
  workflow = YAML.safe_load(
    File.read(WORKFLOW),
    permitted_classes: [],
    aliases: false
  )
  check(workflow.is_a?(Hash), "workflow is not a mapping")
  check_workflow(workflow)

  expect_rejection("package-write authority") do
    mutated = deep_copy(workflow)
    mutated.dig("jobs", "publish", "permissions")["packages"] = "write"
    check_workflow(mutated)
  end
  expect_rejection("a mutable publisher checkout") do
    mutated = deep_copy(workflow)
    checkout = mutated.dig("jobs", "prepare", "steps").find do |step|
      step["name"] == "Checkout exact Kandelo publisher"
    end
    checkout.fetch("with")["ref"] = "main"
    check_workflow(mutated)
  end
  expect_rejection("publication without source ancestry") do
    mutated = deep_copy(workflow)
    step = mutated.dig("jobs", "publish", "steps").find do |candidate|
      candidate["name"] ==
        "Publish and anonymously read back the exact selection"
    end
    step["run"] = step.fetch("run").sub(
      /\s+--target-main-contains-sha "\$SOURCE_TAP_COMMIT"/,
      ""
    )
    check_workflow(mutated)
  end
  expect_rejection("cancellable publication") do
    mutated = deep_copy(workflow)
    mutated.fetch("concurrency")["cancel-in-progress"] = true
    check_workflow(mutated)
  end
  puts "check-homebrew-closed-selection-workflow.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-closed-selection-workflow.rb: #{e.message}"
  exit 1
end
