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
  "64bd13ea5a8d00953acfec3e02607f7ae70837706c868827bed5259c6043aeb2"
WORKFLOW_DIGEST =
  "2f81cbd8d4c48713cf242eecde5eb362cc3e8b61472762d3a82eaac45190f846"
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
        canary-ref kandelo-ref mirror-authority-ref tap-catalog-ref
      ],
      "workflow input identity set differs")
inputs.each do |name, spec|
  check(spec["required"] == true && spec["type"] == "string",
        "#{name} must be a required string")
end

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
prepare_source = YAML.dump(jobs.fetch("prepare"))
publish_source = YAML.dump(jobs.fetch("publish"))
node_proof_source = YAML.dump(node_proof_job)
chromium_proof_source = YAML.dump(chromium_proof_job)
proof_source = node_proof_source + chromium_proof_source
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
    "with" => step["with"],
  }
end
check(actual_prepare_handoff_uploads == [
  {
    "id" => "handoff",
    "with" => {
      "name" => MIRROR_HANDOFF,
      "path" => "${{ steps.bounded.outputs.root }}",
      "retention-days" => 1,
      "if-no-files-found" => "error",
    },
  },
  {
    "id" => "lifecycle-handoff",
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
}, "handoff digest output differs")
check(publish_source.scan("${{ github.token }}").length == 2,
      "tap token must have exactly the authority check and release operation uses")
check(!prepare_source.include?("${{ github.token }}") &&
      !proof_source.include?("${{ github.token }}"),
      "tap token escaped the publication job")
check(publish_source.include?(
  "--exact-target-main-sha \"$TAP_CALLER_AUTHORITY_REF\""
), "lifecycle-input publisher is not bound to exact live tap main")
check(
  prepare_source.scan(
    "git -C tap-authority merge-base --is-ancestor"
  ).length == 2 &&
    prepare_source.include?(
      '"$TAP_CATALOG_REF" "$TAP_MIRROR_AUTHORITY_REF"'
    ) &&
    prepare_source.include?(
      '"$TAP_MIRROR_AUTHORITY_REF" "$TAP_CALLER_AUTHORITY_REF"'
    ),
  "TF -> mirror authority -> caller authority ancestry is not enforced",
)
check(prepare_source.include?(
  ".github/scripts/check-homebrew-main-shell-release-locks.py"
), "structured shell release-lock validation is missing")
check(prepare_source.include?(
  '--target-commitish "$TAP_MIRROR_AUTHORITY_REF"'
), "mirror manifest does not retain its original tap authority")
check(publish_source.include?("publish-immutable-github-release.sh"),
      "immutable publisher is missing")
publication_step = named_step(
  publish_job,
  "Verify the existing mirror and publish only lifecycle inputs",
)
publication_run = publication_step.fetch("run")
check(publication_step["id"] == "release",
      "immutable publication output identity differs")
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
receipt_paths = receipt_upload.fetch("with").fetch("path").
  lines.map(&:strip).reject(&:empty?)
check(receipt_paths == [
  "${{ steps.release.outputs.mirror-receipt }}",
  "${{ steps.release.outputs.lifecycle-receipt }}",
], "mirror verification and lifecycle publication receipt set differs")
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
check(node_proof_source.scan("--transport-mode public").length == 1 &&
      chromium_proof_source.scan("--transport-mode public").length == 1 &&
      !proof_source.include?("--transport-mode closed"),
      "Node and Chromium public transport coverage differs")
check(node_proof_source.include?('--core-revision "$TAP_CATALOG_REF"') &&
      chromium_proof_source.include?(
        '--core-revision "$TAP_CATALOG_REF"'
      ),
      "guest lifecycles are not pinned to the sealed tap catalog")
node_lifecycle = named_step(
  node_proof_job,
  "Prove bounded public bottle installs in fresh Node processes",
).fetch("run")
node_lifecycle_lines =
  node_lifecycle.lines.map(&:strip).reject(&:empty?)
core_scope_index =
  node_lifecycle_lines.index("run_shipping_scope shipping-core")
canary_scope_index =
  node_lifecycle_lines.index("run_shipping_scope shipping-canary")
check(
  node_lifecycle.include?(
    "homebrew/test/homebrew_guest_lifecycle_node.ts"
  ) &&
    node_lifecycle.scan('--proof-mode "$scope"').length == 1 &&
    node_lifecycle.scan(/^\s*run_shipping_scope shipping-core\s*$/).
      length == 1 &&
    node_lifecycle.scan(/^\s*run_shipping_scope shipping-canary\s*$/).
      length == 1 &&
    core_scope_index &&
    canary_scope_index &&
    node_lifecycle_lines[core_scope_index + 1] == "sample_resources" &&
    node_lifecycle_lines[canary_scope_index + 1] == "sample_resources" &&
    core_scope_index < canary_scope_index &&
    node_lifecycle.scan('--image "$IMAGE"').length == 1 &&
    !node_lifecycle.include?("--proof-mode comprehensive") &&
    node_lifecycle.include?("--timeout-ms 900000") &&
    node_lifecycle.include?('--canary-revision "$CANARY_REF"'),
  "fresh-process Node bottle-installation scopes differ",
)
check(node_lifecycle.include?("memory.current") &&
      node_lifecycle.include?("memory.peak") &&
      node_lifecycle.include?("memory.events") &&
      node_lifecycle.include?("aggregate_rss_kib") &&
      node_lifecycle.include?("sample < 64") &&
      node_lifecycle.include?("sleep 15"),
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
  'TAP_MIRROR_AUTHORITY_REF: ${{ inputs.mirror-authority-ref }}'
).length >= 4,
      "jobs do not bind the admitted immutable mirror authority")
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
