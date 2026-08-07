#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "shellwords"
require "yaml"

ROOT = File.expand_path("..", __dir__)
WORKFLOW = ARGV.empty? ?
  File.join(ROOT, ".github/workflows/homebrew-experimental-vfs-publish.yml") :
  File.expand_path(ARGV.fetch(0))

CHECKOUT_ACTION =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
UPLOAD_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
FIXED_ASSETS = %w[
  homebrew-selection.json
  homebrew-vfs-build-report.json
].freeze
CANDIDATE_FIXED_ASSETS = %w[
  homebrew-selection.json
  homebrew-vfs-build-report.json
  kernel.wasm
].freeze
IDENTITIES = %w[
  vfs selection report
].freeze
CANDIDATE_IDENTITIES = %w[
  vfs selection report kernel
].freeze
READBACK_SAFE_GITHUB_EXPRESSIONS = [
  "github.ref_type=='branch'&&" \
    "github.ref_name==github.event.repository.default_branch",
  "github.ref_name==github.event.repository.default_branch&&" \
    "github.ref_type=='branch'",
  "github.run_id",
  "github.run_attempt",
].freeze
WRITER_RUN_SHA256 =
  "ea210f54dd43a8d065e6c8ae1235556a7928901abe2e88ced7cec1b6fa652ac7"
READBACK_RUN_SHA256 =
  "a8a073cc9cb7ab88f09fe52ec9305b5deee861fe0a0a208446a7e01d01fe1270"
FINAL_IDENTIFY_RUN_SHA256 =
  "bd092002d3852058e825fc14322f888d809d643ab369a543f60dbb0c201bfee4"
STARTUP_RUN_SHA256 =
  "080ce9da541b964a4d4a25626e47a10e1f4ad9649349b4a139123109f43852d3"

def check(condition, message)
  raise message unless condition
end

def continued_command_tokens(source, prefix, label)
  lines = source.lines
  commands = []
  lines.each_index do |index|
    stripped = lines.fetch(index).lstrip
    next unless stripped == prefix || stripped.start_with?("#{prefix} ")

    command_lines = [lines.fetch(index)]
    while command_lines.last.end_with?("\\\n")
      index += 1
      check(index < lines.length, "#{label} has an unfinished continuation")
      command_lines << lines.fetch(index)
    end
    logical_command = command_lines.join.gsub("\\\n", " ")
    commands << Shellwords.shellsplit(logical_command)
  rescue ArgumentError => e
    raise "#{label} cannot be parsed: #{e.message}"
  end

  check(commands.length == 1,
        "expected one direct #{label}, found #{commands.length}")
  commands.fetch(0)
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

def expression_strings(node, strings = [])
  case node
  when Hash
    node.each do |key, value|
      expression_strings(key, strings)
      expression_strings(value, strings)
    end
  when Array
    node.each { |value| expression_strings(value, strings) }
  when String
    strings << node if node.include?("${{")
  end
  strings
end

def readback_credential_expression?(readback)
  expression_strings(readback).any? do |source|
    compact = source.gsub(/\s+/, "").downcase
    next true if compact.match?(/\bsecrets\b/i)

    # WHY: remove only complete known-safe expressions. Parsing up to the
    # first `}}` would let a quoted delimiter hide a later token reference.
    READBACK_SAFE_GITHUB_EXPRESSIONS.each do |expression|
      compact = compact.gsub("${{#{expression}}}", "")
    end
    compact.match?(/\bgithub\b/i)
  end
end

def action_steps(job, action)
  job.fetch("steps").select { |step| step["uses"] == action }
end

def find_one(collection, label)
  matches = collection.select { |item| yield item }
  check(matches.length == 1, "expected one #{label}, found #{matches.length}")
  matches.fetch(0)
end

def guarded_to_default_branch?(guard)
  compact = guard.to_s.gsub(/\s+/, "")
  forward =
    "${{github.ref_type=='branch'&&" \
    "github.ref_name==github.event.repository.default_branch}}"
  reverse =
    "${{github.ref_name==github.event.repository.default_branch&&" \
    "github.ref_type=='branch'}}"
  [forward, reverse].include?(compact)
end

def permissions_for(job)
  job.fetch("permissions")
end

def needs(job)
  Array(job["needs"])
end

def run_source(job)
  job.fetch("steps").map { |step| step["run"] }.compact.join("\n")
end

def check_workflow(workflow)
  events = workflow_events(workflow)
  check(
    events.is_a?(Hash) && events.keys == ["workflow_dispatch"],
    "workflow_dispatch must be the only trigger"
  )
  check(!workflow.key?("env"),
        "workflow-level env can inject credentials into public readback")
  inputs = events.dig("workflow_dispatch", "inputs")
  check(inputs.is_a?(Hash), "workflow_dispatch inputs are missing")
  required_inputs = %w[selection-path selection-sha256 tap-revision]
  check(inputs.keys.sort == required_inputs.sort,
        "dispatch must expose only the exact tap and selection inputs")
  inputs.each do |name, specification|
    check(specification.is_a?(Hash) &&
          specification["required"] == true &&
          specification["type"] == "string",
          "#{name} must be a required string")
  end

  jobs = workflow.fetch("jobs")
  check(
    jobs.is_a?(Hash) &&
      jobs.keys.sort == %w[build-image build-test public-readback publish],
    "workflow jobs must be exactly build-image, build-test, publish, and " \
      "public-readback"
  )
  image_name = "build-image"
  build_name = "build-test"
  writer_name = "publish"
  readback_name = "public-readback"
  image = jobs.fetch(image_name)
  build = jobs.fetch(build_name)
  writer = jobs.fetch(writer_name)
  readback = jobs.fetch(readback_name)
  expected_image_keys = %w[
    if outputs permissions runs-on steps timeout-minutes
  ]
  expected_build_keys = %w[
    if needs outputs permissions runs-on steps timeout-minutes
  ]
  expected_readback_keys = %w[
    if needs permissions runs-on steps timeout-minutes
  ]
  expected_writer_keys = %w[
    if needs permissions runs-on steps timeout-minutes
  ]
  check(image.keys.map(&:to_s).sort == expected_image_keys.sort,
        "image job contains an unsupported execution setting")
  check(build.keys.map(&:to_s).sort == expected_build_keys.sort,
        "test job contains an unsupported execution setting")
  check(writer.keys.map(&:to_s).sort == expected_writer_keys.sort,
        "writer job contains an unsupported execution setting")
  check(readback.keys.map(&:to_s).sort == expected_readback_keys.sort,
        "readback job contains an unsupported execution setting")
  jobs.each do |name, job|
    unsupported_context = %w[container defaults env services] &
      job.keys.map(&:to_s)
    check(unsupported_context.empty?,
          "#{name} contains unsupported job-level execution context")
    check(guarded_to_default_branch?(job["if"]),
          "#{name} can run outside the default branch")
    check(job["timeout-minutes"].is_a?(Integer),
          "#{name} has no bounded timeout")
    check(job["steps"].is_a?(Array) && job["steps"].all?(Hash),
          "#{name} steps are malformed")
    check(job["runs-on"] == "ubuntu-latest",
          "#{name} must run on the GitHub-hosted Ubuntu runner")
    permission_keys = permissions_for(job).keys.map(&:to_s)
    check(permission_keys == ["contents"],
          "#{name} requests authority beyond repository contents")
    check(%w[read write].include?(permissions_for(job)["contents"]),
          "#{name} has an invalid contents permission")
  end

  check(permissions_for(image) == { "contents" => "read" },
        "image builder must be read-only")
  check(permissions_for(build) == { "contents" => "read" },
        "proof runner must be read-only")
  check(permissions_for(writer) == { "contents" => "write" },
        "writer must have only contents write permission")
  check(permissions_for(readback) == { "contents" => "read" },
        "readback must be read-only")
  check(needs(image).empty?,
        "image builder must not consume another job")
  check(needs(build) == [image_name],
        "proof runner must consume only the same-run image candidate")
  check(needs(writer) == [build_name],
        "writer does not depend on the tested three-file artifact")
  check(needs(readback).sort == [build_name, writer_name].sort,
        "readback does not wait for both build and publication")

  uses = values_for_key(workflow, "uses")
  check(uses.all? do |value|
    value.start_with?("./") || value.match?(/\A[^@\s]+@[0-9a-f]{40}\z/)
  end, "workflow contains an unpinned third-party action")
  check(values_for_key(workflow, "secrets").empty?,
        "workflow accepts or forwards a secret")

  image_steps = image.fetch("steps")
  build_steps = build.fetch("steps")
  check(action_steps(image, CHECKOUT_ACTION).length == 2 &&
        action_steps(build, CHECKOUT_ACTION).length == 2,
        "each read-only job must have only the exact Kandelo and tap checkouts")
  image_kandelo_checkout = find_one(action_steps(image, CHECKOUT_ACTION),
                                    "image Kandelo checkout") do |step|
    step.dig("with", "ref") == "${{ github.sha }}" &&
      !step.dig("with")&.key?("repository")
  end
  build_kandelo_checkout = find_one(action_steps(build, CHECKOUT_ACTION),
                                    "proof Kandelo checkout") do |step|
    step.dig("with", "ref") == "${{ github.sha }}" &&
      !step.dig("with")&.key?("repository")
  end
  [image_kandelo_checkout, build_kandelo_checkout].each do |checkout|
    check(checkout.dig("with", "persist-credentials") == false &&
          !checkout.fetch("with").key?("submodules"),
          "Kandelo checkout retains credentials or delegates broad " \
          "submodule initialization")
  end
  image_kandelo_checkout_index = image_steps.index(image_kandelo_checkout)
  musl_init_index = image_steps.index do |step|
    step["name"] == "Initialize exact musl submodule"
  end
  expected_musl_init = <<~'SHELL'
    set -euo pipefail
    git submodule update --init --depth 1 -- libc/musl
    expected_musl_sha="$(git rev-parse HEAD:libc/musl)"
    actual_musl_sha="$(git -C libc/musl rev-parse HEAD)"
    test "$actual_musl_sha" = "$expected_musl_sha"
    test -d libc/musl/src
  SHELL
  check(image_kandelo_checkout_index && musl_init_index &&
        image_kandelo_checkout_index < musl_init_index &&
        image_steps.fetch(musl_init_index)["run"] == expected_musl_init,
        "image builder does not initialize and bind the exact musl gitlink")
  image_tap_checkout = find_one(action_steps(image, CHECKOUT_ACTION),
                                "image tap checkout") do |step|
    step.dig("with", "repository") == "kandelo-dev/homebrew-tap-core"
  end
  build_tap_checkout = find_one(action_steps(build, CHECKOUT_ACTION),
                                "proof tap checkout") do |step|
    step.dig("with", "repository") == "kandelo-dev/homebrew-tap-core"
  end
  [image_tap_checkout, build_tap_checkout].each do |checkout|
    check(checkout.dig("with", "ref") == "${{ inputs.tap-revision }}" &&
          checkout.dig("with", "path") == "tap" &&
          checkout.dig("with", "persist-credentials") == false,
          "tap checkout is not the exact credential-free input revision")
  end

  image_nix_index = image_steps.index do |step|
    step["uses"] == "./.github/actions/setup-nix"
  end
  image_sysroot_index = image_steps.index do |step|
    step["name"] == "Build worktree-local wasm32 sysroot"
  end
  image_npm_index = image_steps.index do |step|
    step["run"].to_s.match?(/(?:^|\n)\s*npm ci(?:\s|$)/)
  end
  image_validator_index = image_steps.index do |step|
    step["run"].to_s.include?("homebrew-validate-flat-selection.ts")
  end
  check(image_npm_index && image_validator_index &&
        image_npm_index < image_validator_index,
        "locked builder dependencies must precede selection validation")
  image_validator_source = image_steps.fetch(image_validator_index).fetch("run")
  image_admission_position = image_validator_source.index(
    "scripts/validate-homebrew-experimental-vfs-selection.sh"
  )
  image_tsx_position = image_validator_source.index("./node_modules/.bin/tsx")
  check(image_admission_position && image_tsx_position &&
        image_admission_position < image_tsx_position &&
        !image_validator_source.match?(/\bnpx\b/),
        "image selection validation can bypass admission or fetch a tool")

  image_build_index = image_steps.index do |step|
    step["name"] == "Build the exact flat VFS candidate"
  end
  check(image_nix_index && image_sysroot_index && image_build_index &&
        musl_init_index < image_sysroot_index &&
        image_nix_index < image_sysroot_index &&
        image_sysroot_index < image_build_index,
        "image builder must prepare the exact worktree-local libc sysroot")
  expected_sysroot_build = <<~'SHELL'
    set -euo pipefail
    bash scripts/dev-shell.sh bash scripts/build-musl.sh
    test -f sysroot/lib/libc.a
  SHELL
  check(image_steps.fetch(image_sysroot_index)["run"] == expected_sysroot_build,
        "image builder libc sysroot step is not the declared musl build")

  image_source = run_source(image)
  %w[
    images/vfs/scripts/build-homebrew-flat-vfs-image.ts
    homebrew-vfs-build-report.json
    scripts/resolve-binary.sh
    .kandelo-local-generations/wasm32/kernel
    publication-claimed
    kandelo-kernel.wasm
  ].each do |fragment|
    check(image_source.include?(fragment),
          "image build seam omits #{fragment}")
  end
  check(image_source.include?("--base-image host/wasm/rootfs.vfs"),
        "flat VFS does not consume build.sh's actual rootfs output")
  check(image_source.include?("scripts/build-rootfs.sh --default-install eager") &&
        image_source.include?("ROOTFS_SKIP_PACKAGE_RESOLVE=1") &&
        image_source.include?("ROOTFS_SEALED_BUILD=1"),
        "flat VFS base is not rebuilt as an explicit self-contained rootfs")
  check(image_source.include?(
          "--shell-config homebrew/main-shell-default.json"
        ) && !image_source.include?("homebrew/source-rootfs-shell-default.json"),
        "flat VFS does not select the tested Homebrew default shell")
  check(image_source.include?(
          '[ "$(realpath local-binaries/kernel.wasm)" = "$kernel" ]'
        ) && image_source.include?(
          'kernel="$(bash scripts/resolve-binary.sh kernel.wasm)"'
        ) && image_source.include?(
          '[ -f "$kernel_identity/.$kernel_session.publication-claimed" ]'
        ) && image_source.include?(
          '[ ! -L "$kernel_identity/.$kernel_session.publication-claimed" ]'
        ) && image_source.include?(
          'cp -- "$kernel" "$CANDIDATE_ROOT/kernel.wasm"'
        ) && !image_source.include?(
          'cp -- local-binaries/kernel.wasm "$CANDIDATE_ROOT/kernel.wasm"'
        ),
        "image candidate is not bound to the claimed package-owned kernel")
  check(!image_source.include?("scripts/homebrew-flat-vfs-node-smoke.ts") &&
        !image_source.include?("scripts/homebrew-flat-vfs-node-startup.ts") &&
        !image_source.include?("homebrew-flat-vfs-shipping.spec.ts") &&
        !image_source.include?("homebrew-node-evidence.json"),
        "image builder performs proof work instead of yielding a fresh runner")

  candidate_identify = find_one(image_steps, "candidate identity step") do |step|
    step["name"] == "Identify the exact build candidate"
  end
  check(candidate_identify["id"] == "identify_candidate",
        "candidate identity step lacks its fixed output identity")
  candidate_identify_source = candidate_identify.fetch("run")
  CANDIDATE_FIXED_ASSETS.each do |asset|
    check(candidate_identify_source.include?(asset),
          "candidate identity step omits #{asset}")
  end
  check(candidate_identify_source.include?(
          'find "$CANDIDATE_ROOT" -mindepth 1 -printf' \
        ) && candidate_identify_source.include?("-eq 4") &&
        candidate_identify_source.include?("sha256sum") &&
        candidate_identify_source.include?("stat -c '%s'") &&
        candidate_identify_source.include?('[ ! -L '),
        "candidate identity step does not bind the exact four regular files")

  check(action_steps(image, DOWNLOAD_ACTION).empty? &&
        action_steps(image, UPLOAD_ACTION).length == 1,
        "image builder has an unexpected artifact transfer")
  candidate_upload = action_steps(image, UPLOAD_ACTION).fetch(0)
  check(candidate_upload.keys.map(&:to_s).sort == %w[id name uses with] &&
        candidate_upload["id"] == "upload_candidate",
        "candidate upload lacks the fixed artifact identity")
  candidate_upload_with = candidate_upload.fetch("with")
  check(candidate_upload_with.keys.map(&:to_s).sort == %w[
    compression-level if-no-files-found name path retention-days
  ] &&
        candidate_upload_with["name"] ==
          "homebrew-experimental-vfs-abi42-candidate-attempt-" \
          "${{ github.run_attempt }}" &&
        candidate_upload_with["if-no-files-found"] == "error" &&
        candidate_upload_with["compression-level"] == 0 &&
        candidate_upload_with["retention-days"] == 1,
        "candidate artifact is not the fixed short-lived same-run relay")
  candidate_upload_paths = candidate_upload_with.fetch("path").lines
    .map(&:strip).reject(&:empty?)
  expected_candidate_paths = [
    "${{ runner.temp }}/homebrew-experimental-vfs-candidate/" \
      "${{ steps.identify_candidate.outputs.vfs_filename }}",
    *CANDIDATE_FIXED_ASSETS.map do |name|
      "${{ runner.temp }}/homebrew-experimental-vfs-candidate/#{name}"
    end,
  ]
  check(candidate_upload_paths.sort == expected_candidate_paths.sort,
        "candidate artifact is not exactly VFS, selection, report, and kernel")

  candidate_identity_outputs = [
    "vfs_filename",
    *CANDIDATE_IDENTITIES.flat_map { |name| ["#{name}_sha256", "#{name}_bytes"] },
  ]
  expected_image_outputs = ["candidate_artifact_id", *candidate_identity_outputs]
  check(image.fetch("outputs").keys.map(&:to_s).sort ==
        expected_image_outputs.sort,
        "image job exports an unsupported candidate output")
  check(image.dig("outputs", "candidate_artifact_id") ==
        "${{ steps.upload_candidate.outputs.artifact-id }}",
        "image job does not export the exact uploaded artifact ID")
  candidate_identity_outputs.each do |name|
    check(image.dig("outputs", name) ==
          "${{ steps.identify_candidate.outputs.#{name} }}",
          "image job does not export candidate #{name}")
  end

  build_nix_index = build_steps.index do |step|
    step["uses"] == "./.github/actions/setup-nix"
  end
  build_npm_index = build_steps.index do |step|
    step["run"].to_s.match?(/(?:^|\n)\s*npm ci(?:\s|$)/)
  end
  browser_npm_index = build_steps.index do |step|
    step["run"].to_s.include?(
      "npm --prefix apps/browser-demos ci --no-audit --no-fund"
    )
  end
  build_validator_index = build_steps.index do |step|
    step["run"].to_s.include?("homebrew-validate-flat-selection.ts")
  end
  check(build_npm_index && build_validator_index &&
        build_npm_index < build_validator_index,
        "locked proof dependencies must precede selection validation")
  build_validator_source = build_steps.fetch(build_validator_index).fetch("run")
  build_admission_position = build_validator_source.index(
    "scripts/validate-homebrew-experimental-vfs-selection.sh"
  )
  build_tsx_position = build_validator_source.index("./node_modules/.bin/tsx")
  check(build_admission_position && build_tsx_position &&
        build_admission_position < build_tsx_position &&
        !build_validator_source.match?(/\bnpx\b/),
        "proof selection validation can bypass admission or fetch a tool")

  playwright_index = build_steps.index do |step|
    step["run"].to_s.include?(
      "./node_modules/.bin/playwright install chromium --with-deps"
    )
  end
  candidate_download = find_one(action_steps(build, DOWNLOAD_ACTION),
                                "candidate artifact-ID download") { true }
  check(action_steps(build, DOWNLOAD_ACTION).length == 1 &&
        candidate_download.fetch("with") == {
          "artifact-ids" =>
            "${{ needs.build-image.outputs.candidate_artifact_id }}",
          "path" =>
            "${{ runner.temp }}/homebrew-experimental-vfs-candidate",
        },
        "proof runner does not download the exact same-run artifact ID")
  candidate_download_index = build_steps.index(candidate_download)
  candidate_verify_index = build_steps.index do |step|
    step["name"] == "Verify and stage the exact build candidate"
  end
  proof_index = build_steps.index do |step|
    step["name"] == "Prove exact composition startup on a fresh runner"
  end
  check(build_nix_index && browser_npm_index && playwright_index &&
        candidate_download_index && candidate_verify_index && proof_index &&
        build_validator_index < playwright_index &&
        browser_npm_index < playwright_index &&
        playwright_index < candidate_download_index &&
        candidate_download_index < candidate_verify_index &&
        candidate_verify_index < proof_index,
        "locked browser-demo dependencies must precede Chromium installation")
  proof_step = build_steps.fetch(proof_index)
  check(Digest::SHA256.hexdigest(proof_step.fetch("run")) ==
        STARTUP_RUN_SHA256,
        "startup proof body differs from the reviewed program")

  candidate_verify = build_steps.fetch(candidate_verify_index)
  expected_candidate_env = {
    "ASSET_ROOT" =>
      "${{ runner.temp }}/homebrew-experimental-vfs-assets",
    "CANDIDATE_ROOT" =>
      "${{ runner.temp }}/homebrew-experimental-vfs-candidate",
    "SELECTION_PATH" => "${{ inputs.selection-path }}",
    "VFS_FILENAME" => "${{ needs.build-image.outputs.vfs_filename }}",
    "VFS_SHA256" => "${{ needs.build-image.outputs.vfs_sha256 }}",
    "VFS_BYTES" => "${{ needs.build-image.outputs.vfs_bytes }}",
    "SELECTION_SHA256" =>
      "${{ needs.build-image.outputs.selection_sha256 }}",
    "SELECTION_BYTES" =>
      "${{ needs.build-image.outputs.selection_bytes }}",
    "REPORT_SHA256" => "${{ needs.build-image.outputs.report_sha256 }}",
    "REPORT_BYTES" => "${{ needs.build-image.outputs.report_bytes }}",
    "KERNEL_SHA256" => "${{ needs.build-image.outputs.kernel_sha256 }}",
    "KERNEL_BYTES" => "${{ needs.build-image.outputs.kernel_bytes }}",
  }
  check(candidate_verify["env"] == expected_candidate_env,
        "candidate verifier is not bound to every producer identity")
  candidate_verify_source = candidate_verify.fetch("run")
  candidate_verify_logical = candidate_verify_source.gsub(/\\\s*\n\s*/, " ")
  CANDIDATE_FIXED_ASSETS.each do |asset|
    check(candidate_verify_source.include?(asset),
          "candidate verifier omits #{asset}")
  end
  check(candidate_verify_source.include?("expected_inventory=") &&
        candidate_verify_source.include?('find "$CANDIDATE_ROOT" -mindepth 1') &&
        candidate_verify_source.include?("sha256sum") &&
        candidate_verify_source.include?("stat -c '%s'") &&
        candidate_verify_source.include?("cmp --") &&
        candidate_verify_source.include?(
          'cp -- "$CANDIDATE_ROOT/kernel.wasm" local-binaries/kernel.wasm'
        ) && candidate_verify_source.include?(
          '[ ! -e local-binaries/kernel.wasm ]'
        ) && candidate_verify_logical.match?(
          /verify_candidate\s+"\$VFS_FILENAME"\s+"\$VFS_SHA256"\s+"\$VFS_BYTES"/
        ) && candidate_verify_logical.match?(
          /verify_candidate\s+homebrew-selection\.json\s+"\$SELECTION_SHA256"\s+"\$SELECTION_BYTES"/
        ) && candidate_verify_logical.match?(
          /verify_candidate\s+homebrew-vfs-build-report\.json\s+"\$REPORT_SHA256"\s+"\$REPORT_BYTES"/
        ) && candidate_verify_logical.match?(
          /verify_candidate\s+kernel\.wasm\s+"\$KERNEL_SHA256"\s+"\$KERNEL_BYTES"/
        ) && candidate_verify_source.match?(
          /sha256sum local-binaries\/kernel\.wasm.*KERNEL_SHA256/m
        ) && candidate_verify_source.match?(
          /stat -c '%s' local-binaries\/kernel\.wasm.*KERNEL_BYTES/m
        ) && !candidate_verify_source.include?("$ASSET_ROOT/kernel.wasm"),
        "candidate verifier weakens inventory, selection, or kernel binding")

  build_source = run_source(build)
  %w[
    scripts/homebrew-flat-vfs-node-startup.ts
    homebrew-flat-vfs-shipping.spec.ts
    homebrew-vfs-build-report.json
  ].each do |fragment|
    check(build_source.include?(fragment),
          "build/test seam omits #{fragment}")
  end
  check(build_source.include?("--kernel local-binaries/kernel.wasm") &&
        !build_source.include?("local-binaries/kandelo-kernel.wasm"),
        "runtime proof does not consume the verified candidate kernel")
  check(!build_source.include?("bash build.sh") &&
        !build_source.include?("scripts/build-rootfs.sh") &&
        !build_source.include?("build-homebrew-flat-vfs-image.ts") &&
        !build_source.include?("scripts/build-musl.sh") &&
        !build_source.include?("scripts/resolve-binary.sh"),
        "proof runner rebuilds or resolves producer-owned image inputs")
  startup_tokens = continued_command_tokens(
    build_source,
    "scripts/dev-shell.sh npx tsx",
    "Node startup command"
  )
  expected_startup_tokens = [
    "scripts/dev-shell.sh", "npx", "tsx",
    "scripts/homebrew-flat-vfs-node-startup.ts",
    "--image", "$ASSET_ROOT/$vfs_filename",
    "--selection", "$ASSET_ROOT/homebrew-selection.json",
    "--report", "$ASSET_ROOT/homebrew-vfs-build-report.json",
    "--kernel", "local-binaries/kernel.wasm",
    "--tap-root", "tap",
    "--tap-revision", "$TAP_REVISION",
  ]
  check(startup_tokens == expected_startup_tokens,
        "Node startup does not consume only the exact candidate inputs")
  check(!build_source.include?("scripts/homebrew-flat-vfs-node-smoke.ts") &&
        !build_source.include?("homebrew-node-evidence.json") &&
        !build_source.include?("runner_heartbeat"),
        "publication workflow reintroduces lifecycle proof or evidence")
  browser_proof_environment = <<~'SHELL'.strip
    scripts/dev-shell.sh env \
      ASSET_ROOT="$ASSET_ROOT" \
      TAP_REVISION="$TAP_REVISION" \
      SELECTION_PATH="$SELECTION_PATH" \
      bash -c \
  SHELL
  check(build_source.include?(browser_proof_environment),
        "browser smoke inputs do not cross the clean dev-shell boundary")
  check(build_source.include?("--grep 'starts.*Ruby'") &&
        !build_source.include?("homebrew-chromium-evidence.json"),
        "browser gate must remain the bounded selected-runtime startup smoke")
  check(build_source !~ /\|\|\s*true|\btouch\b|\btruncate\b|status.{0,8}passed/i,
        "build/test seam fabricates or ignores runtime evidence")

  candidate_bind_index = build_steps.index do |step|
    step["name"] == "Bind startup-tested bytes to the exact build candidate"
  end
  final_identify_index = build_steps.index do |step|
    step["name"] == "Identify the exact three release assets"
  end
  final_upload_index = build_steps.index do |step|
    step["uses"] == UPLOAD_ACTION
  end
  check(candidate_bind_index && final_identify_index &&
        final_upload_index && proof_index < final_identify_index &&
        final_identify_index + 1 == candidate_bind_index &&
        candidate_bind_index + 1 == final_upload_index,
        "final identities are not immediately rebound before upload")
  final_identify = build_steps.fetch(final_identify_index)
  check(final_identify["id"] == "identify" &&
        Digest::SHA256.hexdigest(final_identify.fetch("run")) ==
          FINAL_IDENTIFY_RUN_SHA256,
        "final identity program differs from the reviewed program")
  candidate_bind = build_steps.fetch(candidate_bind_index)
  expected_bind_env = expected_candidate_env.reject do |name, _value|
    %w[CANDIDATE_ROOT SELECTION_PATH].include?(name)
  end
  check(candidate_bind["env"] == expected_bind_env,
        "candidate binding does not receive every producer identity")
  candidate_bind_source = candidate_bind.fetch("run")
  candidate_bind_logical = candidate_bind_source.gsub(/\\\s*\n\s*/, " ")
  check(candidate_bind_source.include?("sha256sum") &&
        candidate_bind_source.include?("stat -c '%s'") &&
        candidate_bind_source.include?("-eq 3") &&
        !candidate_bind_source.include?("homebrew-node-evidence.json") &&
        !candidate_bind_source.include?("jq -e") &&
        candidate_bind_logical.match?(
          /verify_input\s+"\$ASSET_ROOT\/\$VFS_FILENAME"\s+"\$VFS_SHA256"\s+"\$VFS_BYTES"/
        ) && candidate_bind_logical.match?(
          /verify_input\s+"\$ASSET_ROOT\/homebrew-selection\.json"\s+"\$SELECTION_SHA256"\s+"\$SELECTION_BYTES"/
        ) && candidate_bind_logical.match?(
          /verify_input\s+"\$ASSET_ROOT\/homebrew-vfs-build-report\.json"\s+"\$REPORT_SHA256"\s+"\$REPORT_BYTES"/
        ) && candidate_bind_logical.match?(
          /verify_input\s+local-binaries\/kernel\.wasm\s+"\$KERNEL_SHA256"\s+"\$KERNEL_BYTES"/
        ),
        "startup-tested bytes are not rebound to exact producer bytes")

  check(action_steps(build, UPLOAD_ACTION).length == 1,
        "proof runner has an unexpected final artifact upload")
  upload = action_steps(build, UPLOAD_ACTION).fetch(0)
  upload_paths = upload.dig("with", "path").to_s.lines.map(&:strip)
    .reject(&:empty?)
  expected_paths = [
    "${{ runner.temp }}/homebrew-experimental-vfs-assets/" \
      "${{ steps.identify.outputs.vfs_filename }}",
    *FIXED_ASSETS.map do |name|
      "${{ runner.temp }}/homebrew-experimental-vfs-assets/#{name}"
    end,
  ]
  check(upload_paths.sort == expected_paths.sort,
        "proof artifact is not exactly the VFS, selection, and report")
  check(upload.fetch("with").keys.map(&:to_s).sort == %w[
    if-no-files-found name path retention-days
  ] && upload.dig("with", "name") ==
        "homebrew-experimental-vfs-abi42" &&
        upload.dig("with", "if-no-files-found") == "error" &&
        upload.dig("with", "retention-days") == 7,
        "builder can silently omit a release asset")

  identity_outputs = [
    "vfs_filename",
    *IDENTITIES.flat_map { |name| ["#{name}_sha256", "#{name}_bytes"] },
  ]
  check(build.fetch("outputs").keys.map(&:to_s).sort == identity_outputs.sort,
        "proof job exports an unsupported release identity")
  identity_outputs.each do |name|
    check(build.dig("outputs", name) ==
          "${{ steps.identify.outputs.#{name} }}",
          "builder does not export tested #{name}")
  end

  download = find_one(action_steps(writer, DOWNLOAD_ACTION),
                      "same-run artifact download") { true }
  writer_steps = writer.fetch("steps")
  check(
    writer_steps.map { |step| step["name"] } == [
      "Download the fixed same-run artifact",
      "Publish the exact inert assets once",
    ],
    "writer must contain only the intended download and release steps"
  )
  check(writer_steps.count { |step| step.key?("run") } == 1 &&
        writer_steps.count { |step| step.key?("uses") } == 1,
        "writer must contain one action step and one release run step")
  check(download.dig("with", "name") == upload.dig("with", "name"),
        "writer does not consume the builder's artifact")
  check(values_for_key(writer, "uses") == [DOWNLOAD_ACTION],
        "credentialed writer executes an action besides artifact download")

  writer_source = run_source(writer)
  all_run_source = values_for_key(workflow, "run").join("\n")
  writer_step = find_one(writer.fetch("steps"), "release creation step") do |step|
    step["run"].to_s.match?(/\bgh\s+release\s+create\b/)
  end
  readback_step = find_one(readback.fetch("steps"), "public fetch step") do |step|
    step["run"].to_s.include?("/releases/download/")
  end
  expected_run_step_keys = %w[env name run shell]
  check(writer_step.keys.map(&:to_s).sort == expected_run_step_keys.sort &&
        writer_step["shell"] == "bash",
        "writer must use only the intended non-login Bash step")
  check(readback_step["shell"] == "bash",
        "readback must use non-login Bash")
  identity_outputs.each do |name|
    env_name = name.upcase
    expected = "${{ needs.#{build_name}.outputs.#{name} }}"
    check(writer_step.dig("env", env_name) == expected,
          "writer does not receive tested #{name}")
    check(readback_step.dig("env", env_name) == expected,
          "readback does not receive tested #{name}")
  end
  check(writer_step.dig("env", "GH_TOKEN") == "${{ github.token }}",
        "writer lacks the repository release token")
  expected_writer_env_keys = [
    "ASSET_ROOT",
    "GH_TOKEN",
    "RELEASE_TAG",
    *identity_outputs.map(&:upcase),
  ]
  check(writer_step.fetch("env").keys.map(&:to_s).sort ==
        expected_writer_env_keys.sort,
        "writer step env must contain only the release token and tested identities")
  # WHY: tokenizing the visible gh command cannot detect shell functions or
  # path reassignment around it. Freeze the complete authority-bearing body.
  check(Digest::SHA256.hexdigest(writer_step.fetch("run")) ==
        WRITER_RUN_SHA256,
        "writer run body differs from the reviewed release program")
  check(all_run_source.scan(/\bgh\s+release\s+create\b/).length == 1,
        "workflow must create one release exactly once")
  check(writer_source.scan(/\bgh\s+release\s+create\b/).length == 1,
        "the sole release creation must occur in the writer")
  release_assets = ["$ASSET_ROOT/$VFS_FILENAME", *FIXED_ASSETS.map do |name|
    "$ASSET_ROOT/#{name}"
  end]
  # WHY: the ASSET_ROOT inventory does not constrain an additional path
  # passed directly to gh, so validate the command's semantic arguments.
  release_tokens = continued_command_tokens(
    writer_source,
    "gh release create",
    "release creation command"
  )
  check(release_tokens.shift(3) == %w[gh release create] &&
        release_tokens.shift == "$RELEASE_TAG",
        "release creation must directly target the unique run tag")
  expected_release_options = {
    "--repo" => "$GITHUB_REPOSITORY",
    "--target" => "$GITHUB_SHA",
    "--title" => "Experimental ABI-42 Homebrew VFS",
    "--notes" =>
      "Experimental ABI-42 flat Homebrew VFS; exact composition plus bounded " \
      "Node and Chromium selected-runtime startup verified; stock in-guest " \
      "tap/install lifecycle is not a release gate.",
  }
  expected_release_flags = %w[--prerelease --latest=false]
  observed_release_options = {}
  observed_release_flags = []
  observed_release_assets = []
  until release_tokens.empty?
    token = release_tokens.shift
    if expected_release_options.key?(token)
      check(!observed_release_options.key?(token) && !release_tokens.empty?,
            "release creation repeats #{token} or omits its value")
      observed_release_options[token] = release_tokens.shift
    elsif expected_release_flags.include?(token)
      observed_release_flags << token
    elsif token.start_with?("-")
      raise "release creation uses unsupported option #{token}"
    else
      observed_release_assets << token
    end
  end
  check(observed_release_options == expected_release_options &&
        observed_release_flags.sort == expected_release_flags.sort &&
        observed_release_flags.length == expected_release_flags.length,
        "release creation must use only the fixed prerelease options")
  check(observed_release_assets.length == release_assets.length &&
        observed_release_assets.sort == release_assets.sort,
        "release creation must upload exactly the tested three assets")
  check(writer_source.include?("sha256sum") &&
        writer_source.include?("stat -c '%s'"),
        "writer does not verify the tested bytes")
  check(writer_source !~ /\b(?:source|eval|chmod)\b|\b(?:bash|sh|ruby|python\d*|node|npx)\s+["'$]/,
        "writer can execute downloaded artifact content")
  check(all_run_source !~ /\bgh\s+(?:api|release\s+(?:upload|edit|delete))\b|--clobber/i,
        "workflow can mutate or replace a release attempt")
  check(all_run_source !~ /scripts\/[^\s]*publish[^\s]*\.(?:sh|rb|py|ts)/i,
        "workflow invokes a custom release publisher")

  check(values_for_key(readback, "uses").empty?,
        "anonymous readback executes an action or checkout")
  readback_steps = readback.fetch("steps")
  expected_readback_step_keys = %w[env name run shell]
  check(
    readback_steps.map { |step| step["name"] } == [
      "Read back every public asset without credentials",
    ] && readback_steps.length == 1 &&
      readback_steps.fetch(0).keys.map(&:to_s).sort ==
        expected_readback_step_keys.sort,
    "readback must contain only the intended anonymous fetch step"
  )
  readback_env = readback_step.fetch("env")
  expected_readback_env_keys = [
    "ASSET_ROOT",
    "RELEASE_TAG",
    *identity_outputs.map(&:upcase),
  ]
  check(readback_env.is_a?(Hash) &&
        readback_env.keys.map(&:to_s).sort == expected_readback_env_keys.sort,
        "readback step env must contain only public asset identities")
  # WHY: an approved curl command can still be preceded by credentialed curl,
  # curlrc setup, or a parent-shell credential expansion. Freeze the whole body.
  check(Digest::SHA256.hexdigest(readback_step.fetch("run")) ==
        READBACK_RUN_SHA256,
        "readback run body differs from the reviewed anonymous fetch program")
  readback_source = run_source(readback)
  # WHY: unsetting named token variables still permits a differently named
  # inherited credential to be expanded into an Authorization argument.
  anonymous_curl_tokens = continued_command_tokens(
    readback_source,
    "env -i /usr/bin/curl",
    "anonymous readback curl command"
  )
  expected_curl_tokens = %w[
    env -i /usr/bin/curl --disable
    --fail --location --silent --show-error
    --proto =https --tlsv1.2
    --output $output $url
  ]
  check(readback_source.include?("unset GH_TOKEN GITHUB_TOKEN") &&
        anonymous_curl_tokens == expected_curl_tokens,
        "public readback curl must have an empty environment and exact anonymous arguments")
  check(!readback_credential_expression?(readback),
        "public readback can observe a credential expression")
  ["$VFS_FILENAME", *FIXED_ASSETS].each do |asset|
    check(readback_source.include?(%Q{fetch_and_verify "#{asset}"}),
          "public readback omits #{asset}")
  end
  check(readback_source.include?("sha256sum") &&
        readback_source.include?("stat -c '%s'"),
        "public readback does not verify exact public bytes")

  contract_text = [*inputs.keys, *values_for_key(workflow, "run")].join("\n")
  check(contract_text !~ /mirror|pages|shell[-_ ]activation/i,
        "workflow reintroduces a mirror, Pages, or shell gate")
  check(all_run_source !~ /\bgit\s+(?:push|commit)\b|\bdocker\s+push\b|\boras\s+push\b|\bbrew\s+bottle\b|homebrew-merge-bottle|publish-bottles/i,
        "workflow can publish bottles or mutate another registry")
end

begin
  workflow = YAML.safe_load(
    File.read(WORKFLOW),
    permitted_classes: [],
    aliases: false
  )
  check(workflow.is_a?(Hash), "workflow is not a mapping")
  check_workflow(workflow)
  puts "check-homebrew-experimental-vfs-workflow.rb: ok"
rescue Errno::ENOENT, KeyError, NoMethodError, Psych::Exception, RuntimeError => e
  warn "check-homebrew-experimental-vfs-workflow.rb: #{e.message}"
  exit 1
end
