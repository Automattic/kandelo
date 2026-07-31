#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/reusable-homebrew-main-shell-mirror-publish.yml") :
  File.expand_path(ARGV.fetch(0))
NODE_SCOPE_RUNNER = ARGV.length < 2 ?
  File.join(ROOT, "homebrew/test/run_homebrew_guest_shipping_scope.sh") :
  File.expand_path(ARGV.fetch(1))
PUBLISH_JOB_DIGEST =
  "5f38b593eeffd4cacf3d728baa64695e88fe2f0723757628dbc936b6b679c54b"
WORKFLOW_DIGEST =
  "bdbc4123b1c445f33355fbe170f154bf1edbf68b0c5f682bef4c431255a39bc7"
NODE_SCOPE_RUNNER_DIGEST =
  "a351c57bba3b4ad05d58a346ccf2ffa22d6de194d1839c24a78d2b9bc07f1bf8"
DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
MIRROR_HANDOFF = "homebrew-main-shell-mirror-handoff"
LIFECYCLE_HANDOFF = "homebrew-guest-lifecycle-inputs-handoff"
LIFECYCLE_ASSETS = %w[
  main-shell.vfs.zst
  main-shell-brew-package-tree.json
  homebrew-bootstrap.zip
  homebrew-brew.env
].freeze
PUBLIC_CHROMIUM_PLAYWRIGHT_ENV = {
  "KANDELO_BROWSER_DEMO_INPUTS" => "main",
  "KANDELO_PLAYWRIGHT_SERVE_DIST" => "1",
  "WASM_POSIX_BINARY_CACHE_ROOT" =>
    "${{ runner.temp }}/main-shell-public-chromium-proof-cache",
  "KANDELO_HOMEBREW_MAIN_SHELL_STRICT" => "1",
  "KANDELO_HOMEBREW_MAIN_SHELL_SHA256" =>
    "${{ steps.public.outputs.image-sha }}",
  "KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256" =>
    "${{ steps.public.outputs.bootstrap-sha }}",
  "KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES" =>
    "${{ steps.public.outputs.bootstrap-bytes }}",
  "KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE" => "public",
  "KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL" =>
    "${{ steps.public.outputs.plan-url }}",
}.freeze

def check(condition, message)
  raise message unless condition
end

def named_step(job, name)
  matches = job.fetch("steps").select { |step| step["name"] == name }
  check(matches.length == 1, "expected exactly one #{name.inspect} step")
  matches.fetch(0)
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
check(inputs.keys.sort == %w[
        canary-ref kandelo-ref mirror-authority-ref publication-mode
        tap-catalog-ref
      ],
      "workflow input identity set differs")
%w[canary-ref kandelo-ref publication-mode tap-catalog-ref].each do |name|
  spec = inputs.fetch(name)
  check(spec["required"] == true && spec["type"] == "string",
        "#{name} must be a required string")
end
check(inputs.fetch("mirror-authority-ref") == {
  "description" =>
    "Exact earlier TA0; empty when this caller creates the mirror",
  "type" => "string",
  "required" => false,
  "default" => "",
}, "mirror authority input must be absent for TA0 and explicit for TA1")

jobs = workflow.fetch("jobs")
check(jobs.keys.sort == %w[
        prepare public-chromium-proof public-node-proof publish
      ],
      "job set differs")
expected_permissions = {
  "prepare" => { "contents" => "read" },
  "publish" => { "actions" => "read", "contents" => "write" },
  "public-node-proof" => { "actions" => "read", "contents" => "read" },
  "public-chromium-proof" => {
    "actions" => "read",
    "contents" => "read",
  },
}
expected_permissions.each do |name, permissions|
  check(jobs.fetch(name).fetch("permissions") == permissions,
        "#{name} permissions differ")
end
check(!jobs.fetch("prepare").key?("needs"), "prepare must be the source job")
check(jobs.fetch("publish")["needs"] == "prepare", "publish dependency differs")
%w[public-node-proof public-chromium-proof].each do |name|
  check(jobs.fetch(name)["needs"] == %w[prepare publish],
        "#{name} dependency differs")
  check(jobs.fetch(name)["if"] ==
          "inputs.publication-mode == 'publish-lifecycle'",
        "#{name} must run only after lifecycle publication")
end
# WHY: this is the only job with the tap's write token. Freezing its complete
# declarative contract prevents an apparently harmless extra step, job-level
# environment, action, or checkout option from gaining publication authority.
check(contract_digest(jobs.fetch("publish")) == PUBLISH_JOB_DIGEST,
      "write-capable publish job contract differs")

allowed_actions = [
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "./.github/actions/fetch-submodules",
  UPLOAD_ACTION,
  DOWNLOAD_ACTION,
  "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
  "DeterminateSystems/magic-nix-cache-action@908b263ff629f4cc17666315b7fd3ec127c6244d",
].freeze

jobs.each do |job_name, job|
  steps = job.fetch("steps")
  check(steps.is_a?(Array) && steps.all?(Hash), "#{job_name} steps differ")
  steps.map { |step| step["uses"] }.compact.each do |action|
    check(allowed_actions.include?(action), "untrusted or unpinned action: #{action}")
  end
  downloads = steps.select { |step| step["uses"] == DOWNLOAD_ACTION }
  downloads.each do |step|
    with = step.fetch("with")
    check(with.keys.sort == %w[name path],
          "#{job_name} artifact download may only select a same-run name and path")
  end
  expected_downloads = {
    "prepare" => [],
    "publish" => [
      {
        "name" => MIRROR_HANDOFF,
        "path" => "${{ runner.temp }}/main-shell-mirror-handoff",
      },
      {
        "name" => LIFECYCLE_HANDOFF,
        "path" => "${{ runner.temp }}/homebrew-guest-lifecycle-inputs-handoff",
      },
    ],
    "public-node-proof" => [
      {
        "name" => MIRROR_HANDOFF,
        "path" => "${{ runner.temp }}/main-shell-mirror-handoff",
      },
      {
        "name" => LIFECYCLE_HANDOFF,
        "path" => "${{ runner.temp }}/homebrew-guest-lifecycle-inputs-handoff",
      },
    ],
    "public-chromium-proof" => [
      {
        "name" => MIRROR_HANDOFF,
        "path" => "${{ runner.temp }}/main-shell-mirror-handoff",
      },
      {
        "name" => LIFECYCLE_HANDOFF,
        "path" => "${{ runner.temp }}/homebrew-guest-lifecycle-inputs-handoff",
      },
    ],
  }
  check(downloads.map { |step| step.fetch("with") } ==
        expected_downloads.fetch(job_name),
        "#{job_name} same-run handoff downloads differ")
end

prepare_job = jobs.fetch("prepare")
publish_job = jobs.fetch("publish")
node_proof_job = jobs.fetch("public-node-proof")
chromium_proof_job = jobs.fetch("public-chromium-proof")
check(named_step(prepare_job,
                 "Prepare separate public lifecycle-input handoff")["if"] ==
        "inputs.publication-mode == 'publish-lifecycle'",
      "TA0 must not prepare lifecycle inputs")
check(named_step(publish_job,
                 "Download only the same-run lifecycle-input handoff")["if"] ==
        "inputs.publication-mode == 'publish-lifecycle'",
      "TA0 must not download lifecycle inputs into the write-capable job")
prepare_source = YAML.dump(jobs.fetch("prepare"))
publish_source = YAML.dump(jobs.fetch("publish"))
node_proof_source = YAML.dump(node_proof_job)
chromium_proof_source = YAML.dump(chromium_proof_job)
node_scope_runner = File.read(NODE_SCOPE_RUNNER)
check(
  Digest::SHA256.hexdigest(node_scope_runner) == NODE_SCOPE_RUNNER_DIGEST,
  "Node shipping-scope runner contract differs",
)
node_execution_source = node_proof_source + node_scope_runner
proof_source = node_execution_source + chromium_proof_source
whole_source = File.read(WORKFLOW)
shell_step = jobs.fetch("prepare").fetch("steps").find do |step|
  step["name"] == "Resolve the public revision-22 shell generation"
end
check(shell_step, "shell generation resolver step is missing")
shell_run = shell_step.fetch("run")
normalized_shell_run = shell_run.gsub(/\\\s+/, " ").gsub(/\s+/, " ")
selected_roots = normalized_shell_run.scan(
  /--package(?:=|\s+)([a-z0-9][a-z0-9._+-]*)/,
).flatten.uniq
check(selected_roots.include?("shell"),
      "shell generation does not fetch the shell root")
direct_product_roots = normalized_shell_run.scan(
  %r{resolve-binary\.sh programs/([a-z0-9][a-z0-9._+-]*)/},
).flatten.uniq
missing_product_roots = direct_product_roots - selected_roots
# WHY: resolving a published root materializes that root's product, not every
# separately published dependency product. A workflow that directly consumes
# another product must select its package root instead of relying on closure
# metadata that intentionally preserves lazy dependencies.
check(missing_product_roots.empty?,
      "direct artifact roots were not fetched: #{missing_product_roots.join(", ")}")

prepare_handoff_uploads = prepare_job.fetch("steps").select do |step|
  step["uses"] == UPLOAD_ACTION
end
actual_prepare_handoff_uploads = prepare_handoff_uploads.map do |step|
  {
    "id" => step["id"],
    "if" => step["if"],
    "with" => step["with"],
  }
end
check(actual_prepare_handoff_uploads == [
  {
    "id" => "handoff",
    "if" => nil,
    "with" => {
      "name" => MIRROR_HANDOFF,
      "path" => "${{ steps.bounded.outputs.root }}",
      "retention-days" => 1,
      "if-no-files-found" => "error",
    },
  },
  {
    "id" => "lifecycle-handoff",
    "if" => "inputs.publication-mode == 'publish-lifecycle'",
    "with" => {
      "name" => LIFECYCLE_HANDOFF,
      "path" => "${{ steps.lifecycle.outputs.root }}",
      "retention-days" => 1,
      "if-no-files-found" => "error",
    },
  },
], "prepared same-run handoff uploads differ")
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
  "lifecycle-artifact-digest" =>
    "${{ steps.lifecycle-handoff.outputs.artifact-digest }}",
  "mirror-authority-ref" =>
    "${{ steps.authority.outputs.mirror-authority-ref }}",
}, "handoff digest output differs")
check(publish_source.scan("${{ github.token }}").length == 3,
      "tap token must have exactly one authority check and two exclusive release uses")
check(!prepare_source.include?("${{ github.token }}") &&
      !proof_source.include?("${{ github.token }}"),
      "tap token escaped the publication job")
check(publish_source.scan(
  "--exact-target-main-sha \"$TAP_CALLER_AUTHORITY_REF\""
).length == 2, "both publishers must bind their release to exact live tap main")
check(
  prepare_source.scan(
    "git -C tap-authority merge-base --is-ancestor"
  ).length == 3 &&
    prepare_source.include?(
      '"$TAP_CATALOG_REF" "$TAP_CALLER_AUTHORITY_REF"'
    ) &&
    prepare_source.include?(
      '"$TAP_CATALOG_REF" "$TAP_MIRROR_AUTHORITY_REF"'
    ) &&
    prepare_source.include?(
      '"$TAP_MIRROR_AUTHORITY_REF" "$TAP_CALLER_AUTHORITY_REF"'
    ),
  "TA0 and TA1 ancestry contracts are not both enforced",
)
check(prepare_source.include?(
  ".github/scripts/check-homebrew-main-shell-release-locks.py"
), "structured shell release-lock validation is missing")
check(prepare_source.include?(
  '--target-commitish "$TAP_MIRROR_AUTHORITY_REF"'
), "mirror manifest does not retain its original tap authority")
mirror_creation_step = named_step(
  publish_job,
  "Create and anonymously re-read the immutable mirror",
)
mirror_creation_run = mirror_creation_step.fetch("run")
check(mirror_creation_step["id"] == "mirror-release" &&
      mirror_creation_step["if"] ==
        "inputs.publication-mode == 'create-mirror'",
      "TA0 mirror publication identity differs")
check(mirror_creation_run.scan(
  "publish-immutable-github-release.sh"
).length == 1 &&
      !mirror_creation_run.include?(
        "verify-existing-immutable-github-release.sh"
      ) &&
      mirror_creation_run.include?(
        '[ "$TAP_MIRROR_AUTHORITY_REF" = "$TAP_CALLER_AUTHORITY_REF" ]'
      ) &&
      mirror_creation_run.include?('--manifest "$handoff/publish.json"') &&
      mirror_creation_run.include?('--asset-root "$handoff/mirror"') &&
      mirror_creation_run.include?(
        '--exact-target-main-sha "$TAP_CALLER_AUTHORITY_REF"'
      ) &&
      mirror_creation_run.include?(
        '.visibility == "public-anonymous-readback"'
      ) &&
      mirror_creation_run.include?('"receipt=$receipt"'),
      "TA0 must publish and anonymously verify only its exact mirror")

publication_step = named_step(
  publish_job,
  "Verify the existing mirror and publish only lifecycle inputs",
)
publication_run = publication_step.fetch("run")
check(publication_step["id"] == "lifecycle-release" &&
      publication_step["if"] ==
        "inputs.publication-mode == 'publish-lifecycle'",
      "TA1 lifecycle publication identity differs")
check(publication_run.scan(
  "verify-existing-immutable-github-release.sh"
).length == 1 &&
      publication_run.scan("publish-immutable-github-release.sh").length == 1,
      "consume-only proof must verify one mirror and publish one lifecycle release")
check(publication_run.scan(
  '--exact-target-commit-sha "$TAP_MIRROR_AUTHORITY_REF"'
).length == 1 &&
      publication_run.scan(
        '--exact-kandelo-main-sha "$KANDELO_REF"'
      ).length == 1 &&
      publication_run.scan(
        '--exact-target-main-sha "$TAP_CALLER_AUTHORITY_REF"'
      ).length == 1,
      "mirror verification and lifecycle publication authorities differ")
check(publication_run.include?('--manifest "$handoff/publish.json"') &&
      publication_run.include?('--asset-root "$handoff/mirror"') &&
      publication_run.include?('--manifest "$lifecycle/publish.json"') &&
      publication_run.include?('--asset-root "$lifecycle"'),
      "mirror verification and lifecycle publication roots differ")
check(
  publication_run.scan(
    '.visibility == "public-anonymous-readback"'
  ).length == 2 &&
    publication_run.include?('.operation == "verified-existing"') &&
    publication_run.include?('(.assets | length) == 4') &&
    publication_run.include?('"mirror-receipt=$mirror_receipt"') &&
    publication_run.include?('"lifecycle-receipt=$lifecycle_receipt"'),
  "mirror verification and lifecycle publication receipts are not exact",
)
receipt_upload = named_step(
  publish_job,
  "Upload mirror verification and lifecycle publication receipts",
)
check(receipt_upload["if"] ==
        "inputs.publication-mode == 'publish-lifecycle'",
      "TA1 receipts must not be uploaded by TA0")
receipt_paths = receipt_upload.fetch("with").fetch("path").
  lines.map(&:strip).reject(&:empty?)
check(receipt_paths == [
  "${{ steps.lifecycle-release.outputs.mirror-receipt }}",
  "${{ steps.lifecycle-release.outputs.lifecycle-receipt }}",
], "mirror verification and lifecycle publication receipt set differs")
mirror_receipt_upload = named_step(
  publish_job,
  "Upload immutable mirror publication receipt",
)
check(mirror_receipt_upload["if"] ==
        "inputs.publication-mode == 'create-mirror'" &&
      mirror_receipt_upload.fetch("with") == {
        "name" => "homebrew-main-shell-mirror-publication",
        "path" => "${{ steps.mirror-release.outputs.receipt }}",
        "retention-days" => 7,
        "if-no-files-found" => "error",
      }, "TA0 mirror publication receipt differs")
check(publish_source.scan(
  "verify-homebrew-guest-lifecycle-publication.sh"
).length == 1 &&
      node_proof_source.scan(
        "verify-homebrew-guest-lifecycle-publication.sh"
      ).length == 1 &&
      chromium_proof_source.scan(
        "verify-homebrew-guest-lifecycle-publication.sh"
      ).length == 1,
      "each consumer must revalidate the lifecycle-input handoff")

public_fixture = named_step(
  chromium_proof_job,
  "Create exact all-public Chromium lifecycle fixture",
)
public_fixture_run = public_fixture.fetch("run")
check(public_fixture["id"] == "public-fixture" &&
      public_fixture.fetch("env").fetch("FIXED_ASSET_ROOT") ==
        "${{ steps.public.outputs.lifecycle-root }}",
      "public Chromium fixture identity differs")
check(public_fixture_run.include?(
  "scripts/create-homebrew-guest-lifecycle-fixture.ts"
) &&
      public_fixture_run.scan("--transport-mode public").length == 1 &&
      !public_fixture_run.include?("--transport-mode closed"),
      "Chromium lifecycle fixture is not all-public")
chromium_proof_steps = chromium_proof_job.fetch("steps")
proof_checkout_index = chromium_proof_steps.index do |step|
  step["name"] == "Check out exact Kandelo consumer"
end
musl_fetch_index = chromium_proof_steps.index do |step|
  step["name"] == "Fetch musl submodule for browser source-build fallback"
end
check(proof_checkout_index && musl_fetch_index == proof_checkout_index + 1,
      "Chromium proof must fetch musl immediately after its exact checkout")
musl_fetch = chromium_proof_steps.fetch(musl_fetch_index)
check(musl_fetch["uses"] == "./.github/actions/fetch-submodules" &&
      musl_fetch["with"] == { "submodules" => "libc/musl" },
      "Chromium proof musl fetch contract differs")
check(!node_proof_source.include?("./.github/actions/fetch-submodules") &&
      !node_proof_source.include?("apps/browser-demos") &&
      !node_proof_source.include?("playwright"),
      "Node proof includes browser-only dependencies")
node_proof_steps = node_proof_job.fetch("steps")
node_install_index = node_proof_steps.index do |step|
  step["name"] == "Install public Node proof dependencies"
end
node_build_index = node_proof_steps.index do |step|
  step["name"] == "Build the production Node process worker"
end
node_revalidate_index = node_proof_steps.index do |step|
  step["name"] == "Revalidate exact Node handoff and live refs"
end
node_build = named_step(
  node_proof_job,
  "Build the production Node process worker",
).fetch("run")
check(
  node_install_index &&
    node_build_index == node_install_index + 1 &&
    node_revalidate_index == node_build_index + 1 &&
    node_build.scan("npm --prefix host run build").length == 1 &&
    node_build.scan("test -s host/dist/worker-entry.js").length == 1,
  "Node proof must build and require its production process worker",
)
check(node_execution_source.scan("--transport-mode public").length == 1 &&
      chromium_proof_source.scan("--transport-mode public").length == 1 &&
      !proof_source.include?("--transport-mode closed"),
      "Node and Chromium public transport coverage differs")
check(node_execution_source.include?('--core-revision "$TAP_CATALOG_REF"') &&
      chromium_proof_source.include?(
        '--core-revision "$TAP_CATALOG_REF"'
      ),
      "guest lifecycles are not pinned to the sealed tap catalog")
node_telemetry_init = named_step(
  node_proof_job,
  "Initialize bounded Node lifecycle telemetry",
)
node_core_scope = named_step(
  node_proof_job,
  "Prove shipping-core public bottle installs in Node",
)
node_canary_scope = named_step(
  node_proof_job,
  "Prove shipping-canary public bottle installs in Node",
)
node_telemetry_upload = named_step(
  node_proof_job,
  "Upload bounded Node lifecycle telemetry",
)
node_telemetry_init_index = node_proof_steps.index(node_telemetry_init)
node_core_scope_index = node_proof_steps.index(node_core_scope)
node_canary_scope_index = node_proof_steps.index(node_canary_scope)
node_telemetry_upload_index = node_proof_steps.index(node_telemetry_upload)
node_scope_env = {
  "IMAGE" => "${{ steps.public.outputs.image }}",
  "BOOTSTRAP" => "${{ steps.public.outputs.bootstrap }}",
  "BOOTSTRAP_ENV" => "${{ steps.public.outputs.bootstrap-env }}",
  "TAP_CATALOG_REF" => "${{ inputs.tap-catalog-ref }}",
  "CANARY_REF" => "${{ inputs.canary-ref }}",
}
check(
  node_telemetry_init.fetch("run").include?(
    ': >"$RUNNER_TEMP/homebrew-node-lifecycle-resources.log"'
  ) &&
    node_telemetry_init_index &&
    node_core_scope_index == node_telemetry_init_index + 1 &&
    node_canary_scope_index == node_core_scope_index + 1 &&
    node_telemetry_upload_index == node_canary_scope_index + 1 &&
    node_core_scope.fetch("env") == node_scope_env &&
    node_canary_scope.fetch("env") == node_scope_env &&
    node_core_scope.fetch("timeout-minutes") == 20 &&
    node_canary_scope.fetch("timeout-minutes") == 20 &&
    node_core_scope.fetch("run").scan(
      "homebrew/test/run_homebrew_guest_shipping_scope.sh"
    ).length == 1 &&
    node_core_scope.fetch("run").scan(/^\s*shipping-core\s*$/).length == 1 &&
    node_canary_scope.fetch("run").scan(
      "homebrew/test/run_homebrew_guest_shipping_scope.sh"
    ).length == 1 &&
    node_canary_scope.fetch("run").scan(
      /^\s*shipping-canary\s*$/
    ).length == 1 &&
    node_scope_runner.include?(
      "homebrew/test/homebrew_guest_lifecycle_node.ts"
    ) &&
    node_scope_runner.scan('--proof-mode "$scope"').length == 1 &&
    node_scope_runner.scan(
      /^\s*shipping-core\|shipping-canary\) ;;\s*$/
    ).length == 1 &&
    node_scope_runner.scan('--image "$IMAGE"').length == 1 &&
    !node_scope_runner.include?("--proof-mode comprehensive") &&
    node_scope_runner.include?("--timeout-ms 900000") &&
    node_scope_runner.include?('--canary-revision "$CANARY_REF"'),
  "fresh-process Node bottle-installation scopes differ",
)
check(node_scope_runner.include?("memory.current") &&
      node_scope_runner.include?("memory.peak") &&
      node_scope_runner.include?("memory.events") &&
      node_scope_runner.include?("aggregate_rss_kib") &&
      node_scope_runner.include?("record_scope_state started") &&
      node_scope_runner.include?("record_scope_state finished") &&
      node_scope_runner.include?("sample < 64") &&
      node_scope_runner.include?("sleep 15"),
      "bounded Node lifecycle resource telemetry differs")
chromium_step = named_step(
  chromium_proof_job,
  "Prove public shell and live tap lifecycle in Chromium",
)
chromium_run = chromium_step.fetch("run")
check(
  chromium_step.fetch("env") == PUBLIC_CHROMIUM_PLAYWRIGHT_ENV,
  "Chromium public Playwright environment differs",
)
PUBLIC_CHROMIUM_PLAYWRIGHT_ENV.each_key do |name|
  forwarding = "\"#{name}=$#{name}\""
  check(
    chromium_run.scan(forwarding).length == 1,
    "Chromium public Playwright does not forward #{name} exactly once",
  )
end
public_playwright_calls = chromium_run.lines.map(&:strip).select do |line|
  line.start_with?("run_public_playwright ")
end
check(
  chromium_run.scan(
    /^\s*run_public_playwright\(\) \{$/
  ).length == 1 &&
    chromium_run.scan(
      "bash ../../scripts/dev-shell.sh env"
    ).length == 1 &&
    public_playwright_calls.length == 2 &&
    public_playwright_calls.include?(
      "run_public_playwright npx playwright test \\"
    ) &&
    public_playwright_calls.include?("run_public_playwright \\") &&
    !chromium_run.include?("run_public_playwright env"),
  "Chromium public Playwright does not use one sealed env helper",
)
check(chromium_run.include?("--project=chromium") &&
      chromium_run.include?("test/homebrew-guest-lifecycle.spec.ts") &&
      chromium_run.include?(
        "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE=1"
      ) &&
      chromium_run.include?(
        "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH=" \
        "${{ steps.public-fixture.outputs.fixture }}"
      ),
      "Chromium public transport proof is missing")
proof_entries = [
  node_proof_job,
  chromium_proof_job,
] + node_proof_job.fetch("steps") + chromium_proof_job.fetch("steps")
proof_env_keys = proof_entries.flat_map do |entry|
  env = entry["env"]
  env.is_a?(Hash) ? env.keys : []
end
check(proof_env_keys.none? { |name| name.include?("CLOSED_ACCEPTANCE_ROOT") },
      "closed acceptance input reached the public proof environment")
check(chromium_run.include?(
  'test -z "${VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT:-}"'
) && chromium_run.include?(
  'test -z "${KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT:-}"'
), "Chromium proof does not reject closed acceptance inputs")

chromium_build = named_step(
  chromium_proof_job,
  "Build exact public browser product",
)
chromium_build_run = chromium_build.fetch("run")
check(
  chromium_build.fetch("env").fetch("KANDELO_BROWSER_DEMO_INPUTS") ==
    "main,homebrew-vfs-test" &&
    chromium_build_run.scan(
      '"KANDELO_BROWSER_DEMO_INPUTS=$KANDELO_BROWSER_DEMO_INPUTS"'
    ).length == 1,
  "Chromium proof does not forward selected Vite inputs " \
    "through dev-shell",
)
browser_shell_verifier =
  "bash ../../scripts/verify-browser-shell-vfs-asset.sh"
check(
  chromium_build_run.scan(browser_shell_verifier).length == 1 &&
    chromium_build_run.include?(
      'dist "${{ steps.public.outputs.image }}"'
    ) &&
    !chromium_build_run.include?("dist/shell.vfs.zst"),
  "Chromium proof does not verify its exact hashed shell asset",
)

node_resolution = named_step(
  node_proof_job,
  "Resolve exact public Node proof inputs",
).fetch("run")
normalized_node_resolution =
  node_resolution.gsub(/\\\s+/, " ").gsub(/\s+/, " ")
node_selected_roots = normalized_node_resolution.scan(
  /--package(?:=|\s+)([a-z0-9][a-z0-9._+-]*)/,
).flatten
check(node_selected_roots == ["kernel"],
      "Node proof must fetch only the kernel package root")
check(node_resolution.include?(
  'bash scripts/resolve-binary.sh kernel.wasm >/dev/null'
) &&
      node_resolution.include?(
        'echo "image=$lifecycle/main-shell.vfs.zst"'
      ) &&
      !node_resolution.include?("prepare-browser") &&
      !node_resolution.include?("--package shell") &&
      !node_resolution.include?("--package homebrew-bootstrap"),
      "Node proof does not consume only handoff products and the kernel")

chromium_resolution = named_step(
  chromium_proof_job,
  "Resolve the exact public browser generation",
).fetch("run")
[
  ["Node", node_resolution, "$RUNNER_TEMP/public-node-$name"],
  ["Chromium", chromium_resolution, "$RUNNER_TEMP/public-$name"],
].each do |label, resolution, output|
  check(resolution.include?(
    'lifecycle_root="$(jq -er \'.release.root\' "$lifecycle/handoff.json")"'
  ) &&
        resolution.include?('env -u GH_TOKEN -u GITHUB_TOKEN \\') &&
        resolution.include?('"${lifecycle_root}${name}"') &&
        resolution.include?(
          'cmp "$lifecycle/$name" "' + output + '"'
        ),
        "#{label} anonymous lifecycle-input release readback differs")
  LIFECYCLE_ASSETS.each do |asset|
    check(resolution.include?(asset),
          "#{label} public lifecycle-input readback omits #{asset}")
  end
end

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
check(whole_source.scan(
  'TAP_CALLER_AUTHORITY_REF: ${{ github.sha }}'
).length >= 4,
      "jobs do not derive caller authority from the protected tap SHA")
check(whole_source.scan(
  'REQUESTED_MIRROR_AUTHORITY_REF: ${{ inputs.mirror-authority-ref }}'
).length == 1 &&
      !whole_source.include?(
        'TAP_MIRROR_AUTHORITY_REF: ${{ inputs.mirror-authority-ref }}'
      ), "raw mirror authority must be admitted only by the mode gate")
check(whole_source.scan(
  'TAP_MIRROR_AUTHORITY_REF: ${{ steps.authority.outputs.mirror-authority-ref }}'
).length >= 3 && whole_source.scan(
  'TAP_MIRROR_AUTHORITY_REF: ${{ needs.prepare.outputs.mirror-authority-ref }}'
).length >= 4,
      "jobs do not bind the admitted effective mirror authority")
check(whole_source.include?(
  '--publication-mode "$PUBLICATION_MODE"'
) && whole_source.scan(
  "--publication-mode publish-lifecycle"
).length == 2,
      "mirror handoff consumers do not preserve the authority mode")
check(!whole_source.include?("inputs.tap-authority-ref"),
      "event data may not select the live tap caller authority")
# WHY: preparation supplies the exact bytes later accepted by the token-bearing
# job, while the two fresh proof jobs independently supply the Node and browser
# release claims. Freezing only the write job would still permit either side of
# that authority/evidence chain to change.
check(contract_digest(workflow) == WORKFLOW_DIGEST,
      "complete mirror workflow contract differs")

puts "check-homebrew-main-shell-mirror-workflow.rb: ok"
rescue KeyError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-main-shell-mirror-workflow.rb: #{e.message}"
  exit 1
end
