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
  "73d1c1f053ed0d6037ae6a1a4b0fec276116a4b597ae73b7e0c9d25e5fa51362"
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
        "${{ inputs.expected-caller-sha }}-" \
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
      expected-caller-sha kandelo-ref selection-plan selection-plan-sha256
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
  check(
    prepare.fetch("outputs")["caller-sha"] ==
      "${{ steps.admit.outputs.caller-sha }}",
    "publish job does not inherit the admitted caller SHA"
  )
  check(
    prepare.fetch("outputs")["plan-sha256"] ==
      "${{ steps.admit.outputs.plan-sha256 }}",
    "publish job does not inherit the admitted plan digest"
  )
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
  check(
    admission.fetch("env")["ACTUAL_CALLER_SHA"] ==
      "${{ github.sha }}" &&
      admission.fetch("env")["EXPECTED_CALLER_SHA"] ==
        "${{ inputs.expected-caller-sha }}" &&
      admission_source.include?(
        '[ "$ACTUAL_CALLER_SHA" = "$EXPECTED_CALLER_SHA" ]'
      ),
    "caller admission does not reject a differently resolved main commit"
  )
  main_check = named_step(
    prepare,
    "Require the publisher and tap caller to be current main"
  ).fetch("run")
  check(
    main_check.include?("refs/heads/main") &&
      main_check.include?("require-exact-repository-main.sh") &&
      main_check.include?("$EXPECTED_CALLER_SHA"),
    "preparation is not bound to both current public main commits"
  )

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

  materialization = named_step(
    prepare,
    "Materialize the sealed campaign tap source"
  ).fetch("run")
  %w[
    homebrew-prefix-campaign-executor.py
    materialize-campaign-source
    --campaign
    --source-tap-root
  ].each do |text|
    check(materialization.include?(text),
          "source materialization omits #{text}")
  end
  check(!materialization.include?("prefix-campaign-source.py"),
        "workflow executes materializer code from tap data")

  assembly = named_step(
    prepare,
    "Assemble the exact selection from public handoffs"
  ).fetch("run")
  check(assembly.include?("homebrew-closed-selection-controller.py") &&
          assembly.include?("prepare") &&
          !assembly.include?("install -m"),
        "prepare job does not emit only its deterministic release")
  check(
    plan_admission.fetch("env") == {
      "EXPECTED_CALLER_SHA" => "${{ inputs.expected-caller-sha }}",
      "SELECTION_PLAN" => "${{ inputs.selection-plan }}",
      "PLAN_SHA256" => "${{ inputs.selection-plan-sha256 }}",
    },
    "plan admission does not receive the exact reusable inputs"
  )
  check(
    plan_admission.fetch("run").include?(
      '--expected-caller-sha "$EXPECTED_CALLER_SHA"'
    ),
    "plan admission does not bind the expected caller SHA"
  )

  artifact_admission = named_step(
    publish,
    "Admit the exact same-run preparation artifact"
  )
  tap_checkout = publish.fetch("steps").find do |step|
    step["name"] == "Checkout protected tap lock authority"
  end
  check(
    tap_checkout.fetch("with")["ref"] ==
      "${{ inputs.expected-caller-sha }}",
    "tap lock checkout is not bound to the expected caller SHA"
  )

  verify_step = named_step(
    publish,
    "Verify the downloaded selection against its plan"
  )
  check(
    verify_step.fetch("env") == {
      "EXPECTED_CALLER_SHA" => "${{ inputs.expected-caller-sha }}",
      "ADMITTED_CALLER_SHA" =>
        "${{ needs.prepare.outputs.caller-sha }}",
      "SELECTION_PLAN" => "${{ inputs.selection-plan }}",
      "PLAN_SHA256" => "${{ inputs.selection-plan-sha256 }}",
      "ADMITTED_PLAN_SHA256" =>
        "${{ needs.prepare.outputs.plan-sha256 }}",
    },
    "write job does not bind the artifact to trusted plan inputs"
  )
  verify_source = verify_step.fetch("run")
  %w[
    --selection-plan
    --selection-plan-sha256
    --prepared-release
    --executor
  ].each do |text|
    check(verify_source.include?(text),
          "write-job selection verification omits #{text}")
  end
  check(verify_source.include?(
    '[ "$PLAN_SHA256" = "$ADMITTED_PLAN_SHA256" ]'
  ), "write job does not compare both independently carried plan digests")
  check(verify_source.include?(
    '[ "$EXPECTED_CALLER_SHA" = "$ADMITTED_CALLER_SHA" ]'
  ), "write job does not compare both independently carried caller SHAs")
  artifact_source = artifact_admission.fetch("run")
  check(
    artifact_source.include?("actions/artifacts/$EXPECTED_ID") &&
      artifact_source.include?("sha256:$EXPECTED_DIGEST") &&
      artifact_source.include?(".digest == $digest") &&
      artifact_source.include?(".id == $id") &&
      artifact_source.include?(".workflow_run.id == $run_id") &&
      artifact_source.include?(".workflow_run.head_sha == $head_sha") &&
      artifact_source.include?(
        '[ "$ACTUAL_CALLER_SHA" = "$EXPECTED_CALLER_SHA" ]'
      ) &&
      artifact_source.include?(
        '[ "$ADMITTED_CALLER_SHA" = "$EXPECTED_CALLER_SHA" ]'
      ),
    "write job does not bind the exact same-run artifact identity"
  )

  authority_source = named_step(
    publish,
    "Recheck protected publication authorities"
  ).fetch("run")
  check(
    authority_source.scan("require-exact-repository-main.sh").length == 2 &&
      authority_source.include?(
        '[ "$ACTUAL_CALLER_SHA" = "$EXPECTED_CALLER_SHA" ]'
      ) &&
      authority_source.include?('--source-sha "$EXPECTED_CALLER_SHA"'),
    "write job does not recheck both exact main authorities"
  )
  publish_step = named_step(
    publish,
    "Publish and anonymously read back the exact selection"
  )
  publish_source = publish_step.fetch("run")
  %w[
    publish-homebrew-closed-selection-release.sh
    --prepared-release
    --lock-root
    --receipt
    --selection-plan
    --selection-plan-sha256
    --exact-execution-kandelo-main-sha
    --exact-execution-target-main-sha
    --kandelo-main-contains-sha
    --target-main-contains-sha
  ].each do |text|
    check(publish_source.include?(text),
          "write job omits publisher contract #{text}")
  end
  check(
    publish_step.fetch("env").keys.sort == %w[
      CAMPAIGN_KANDELO_COMMIT GH_TOKEN KANDELO_REF PLAN_SHA256
      SELECTION_PLAN SOURCE_TAP_COMMIT TAP_CALLER_SHA
    ],
    "publication step receives unexpected environment authority"
  )
  check(
    publish_step.fetch("env")["TAP_CALLER_SHA"] ==
      "${{ inputs.expected-caller-sha }}",
    "per-write authority is not the expected caller SHA"
  )
  check(
    values_for_key(workflow, "run").none? do |source|
      source.include?("gh release create") ||
        source.include?("gh release upload")
    end,
    "workflow duplicates immutable release publication logic"
  )
  controller_source = File.read(
    File.join(ROOT, "scripts/homebrew-closed-selection-controller.py")
  )
  %w[
    prepare_selection_release
    load_prepared_selection_release
    expected_plan
  ].each do |text|
    check(controller_source.include?(text),
          "closed-selection controller omits #{text}")
  end
  executor_source = File.read(
    File.join(ROOT, "scripts/homebrew-prefix-campaign-executor.py")
  )
  %w[
    closed-selection.zip
    zip-stored-v1
    zip-stored-v2
    snapshot_selection_release
    materialize_campaign_source
  ].each do |text|
    check(executor_source.include?(text),
          "closed-selection executor omits #{text}")
  end
  wrapper_source = File.read(
    File.join(ROOT, "scripts/publish-homebrew-closed-selection-release.sh")
  )
  check(
    wrapper_source.include?(
      'fetch-selection-release'
    ) && wrapper_source.include?(
      'ln "$READBACK_RECEIPT" "$RECEIPT"'
    ),
    "selection publisher does not install its receipt after readback"
  )
  controller_tests = File.read(
    File.join(ROOT, "scripts/test-homebrew-closed-selection-controller.py")
  )
  check(controller_tests.include?(
    "test_verify_rejects_coherent_artifact_plan_substitution"
  ), "controller tests omit coherent artifact substitution")
  check(
    controller_tests.include?(
      "test_admit_rejects_resolved_caller_mismatch_before_writing"
    ) && controller_tests.include?(
      "test_admit_rejects_missing_or_extra_dispatch_input"
    ),
    "controller tests omit caller mismatch or exact-input rejection"
  )
  executor_tests = File.read(
    File.join(ROOT, "scripts/test-homebrew-prefix-campaign-executor.py")
  )
  check(
    executor_tests.include?(".github/workflows/selection.yml") &&
      executor_tests.include?(
        'self.assertEqual(executable_record["mode"], "100755")'
      ),
    "executor tests omit hidden paths or executable archive modes"
  )
  wrapper_tests = File.read(
    File.join(
      ROOT,
      "scripts/test-publish-homebrew-closed-selection-release.sh"
    )
  )
  check(
    wrapper_tests.include?(
      "failed semantic readback exposed a success receipt"
    ) && wrapper_tests.include?(
      "unchanged retry did not install the verified readback receipt"
    ),
    "selection publisher tests omit receipt-last retry behavior"
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
  expect_rejection("a missing expected caller input") do
    mutated = deep_copy(workflow)
    workflow_events(mutated).dig("workflow_call", "inputs").delete(
      "expected-caller-sha"
    )
    check_workflow(mutated)
  end
  expect_rejection("preparation after caller main moved") do
    mutated = deep_copy(workflow)
    step = mutated.dig("jobs", "prepare", "steps").find do |candidate|
      candidate["name"] ==
        "Require the publisher and tap caller to be current main"
    end
    step["run"] = step.fetch("run").sub(
      '--source-sha "$EXPECTED_CALLER_SHA"',
      '--source-sha "$GITHUB_SHA"'
    )
    check_workflow(mutated)
  end
  expect_rejection("a differently resolved workflow caller") do
    mutated = deep_copy(workflow)
    step = mutated.dig("jobs", "prepare", "steps").find do |candidate|
      candidate["name"] ==
        "Admit the protected tap caller and publisher ref"
    end
    step["run"] = step.fetch("run").sub(
      '[ "$ACTUAL_CALLER_SHA" = "$EXPECTED_CALLER_SHA" ]',
      "true"
    )
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
  expect_rejection("publication without exact execution authority") do
    mutated = deep_copy(workflow)
    step = mutated.dig("jobs", "publish", "steps").find do |candidate|
      candidate["name"] ==
        "Publish and anonymously read back the exact selection"
    end
    step["run"] = step.fetch("run").sub(
      /\s+--exact-execution-target-main-sha "\$TAP_CALLER_SHA"/,
      ""
    )
    check_workflow(mutated)
  end
  expect_rejection("per-write authority from resolved moving main") do
    mutated = deep_copy(workflow)
    step = mutated.dig("jobs", "publish", "steps").find do |candidate|
      candidate["name"] ==
        "Publish and anonymously read back the exact selection"
    end
    step.fetch("env")["TAP_CALLER_SHA"] = "${{ github.sha }}"
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
