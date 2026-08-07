#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/check-homebrew-experimental-vfs-workflow.rb"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-experimental-vfs-publish.yml"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-experimental-vfs-workflow.XXXXXX")"
ONLY_MUTATION="${1:-}"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  echo "test-homebrew-experimental-vfs-workflow: $*" >&2
  exit 1
}

expect_rejection() {
  local name="$1"
  local mutation="$2"
  local fixture="$TEST_ROOT/$name.yml"

  if [ -n "$ONLY_MUTATION" ] && [ "$mutation" != "$ONLY_MUTATION" ]; then
    return
  fi

  ruby - "$WORKFLOW" "$fixture" "$mutation" <<'RUBY'
require "yaml"

source, destination, mutation = ARGV
workflow = YAML.safe_load(File.read(source), permitted_classes: [], aliases: false)
jobs = workflow.fetch("jobs")

def add_readback_authorization(jobs, variable)
  step = jobs.fetch("public-readback").fetch("steps").fetch(0)
  curl_line = step.fetch("run").lines.find do |line|
    line.include?("/usr/bin/curl") && line.end_with?("\\\n")
  end
  abort "readback curl insertion point is missing" unless curl_line

  header_line = "    --header \"Authorization: Bearer $#{variable}\" \\\n"
  step["run"] = step.fetch("run").sub(curl_line, curl_line + header_line)
end

def add_fourth_release_asset(jobs)
  step = jobs.fetch("publish").fetch("steps").fetch(1)
  source = step.fetch("run")
  backslash = "\\"
  release_line = %q{gh release create "$RELEASE_TAG" } + backslash + "\n"
  abort "release insertion point is missing" unless source.include?(release_line)
  source = source.sub(
    release_line,
    %q{printf 'unexpected\n' >"${RUNNER_TEMP}/unexpected.txt"} + "\n" +
      release_line
  )

  final_asset = %q{  "$ASSET_ROOT/homebrew-vfs-build-report.json"} + "\n"
  final_asset_position = source.rindex(final_asset)
  abort "final release asset is missing" unless final_asset_position
  fourth_asset = %q{  "$ASSET_ROOT/homebrew-vfs-build-report.json" } +
    backslash + "\n" + %q{  "${RUNNER_TEMP}/unexpected.txt"} + "\n"
  source[final_asset_position, final_asset.length] = fourth_asset
  step["run"] = source
end

case mutation
when "extra-read-only-job"
  jobs["extra-read-only"] = {
    "if" => "${{ github.ref_type == 'branch' && github.ref_name == github.event.repository.default_branch }}",
    "runs-on" => "ubuntu-latest",
    "timeout-minutes" => 15,
    "permissions" => { "contents" => "read" },
    "steps" => [{ "name" => "Inert", "run" => "true" }],
  }
when "readback-credential"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ github.token }}"
when "readback-github-token-single-bracket"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ github['token'] }}"
when "readback-github-token-double-bracket"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = '${{ github["token"] }}'
when "readback-github-token-spaced-case"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = '${{ GitHub [ "ToKeN" ] }}'
when "readback-github-token-spaced-dot"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ GitHub . ToKeN }}"
when "readback-github-token-dynamic"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = \
      "${{ github[format('to{0}', 'ken')] }}"
when "readback-github-token-embedded-delimiter"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = \
      "${{ format('}}{0}', github['token']) }}"
when "readback-secret-single-bracket"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ secrets['NAME'] }}"
when "readback-secret-double-bracket"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = '${{ secrets["NAME"] }}'
when "readback-secret-spaced-case"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ SeCrEtS [ 'NAME' ] }}"
when "readback-secret-spaced-dot"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ SeCrEtS . NAME }}"
when "readback-secret-context"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["GH_TOKEN"] = "${{ toJSON(secrets) }}"
when "readback-workflow-env-credential"
  workflow["env"] = { "INHERITED_TOKEN" => "${{ github.token }}" }
  add_readback_authorization(jobs, "INHERITED_TOKEN")
when "readback-job-env-credential"
  jobs.fetch("public-readback")["env"] = {
    "INHERITED_TOKEN" => "opaque-job-credential",
  }
  add_readback_authorization(jobs, "INHERITED_TOKEN")
when "readback-step-env-credential"
  jobs.fetch("public-readback").fetch("steps").fetch(0)
    .fetch("env")["INHERITED_TOKEN"] = "opaque-step-credential"
  add_readback_authorization(jobs, "INHERITED_TOKEN")
when "readback-ambient-env-credential"
  add_readback_authorization(jobs, "ACTIONS_RUNTIME_TOKEN")
when "readback-parent-shell-url-credential"
  step = jobs.fetch("public-readback").fetch("steps").fetch(0)
  original = %q{local url="https://github.com/${GITHUB_REPOSITORY}/releases/download/${RELEASE_TAG}/${asset}"}
  replacement = %q{local url="https://github.com/${GITHUB_REPOSITORY}/releases/download/${RELEASE_TAG}/${asset}?token=${ACTIONS_RUNTIME_TOKEN}"}
  abort "readback URL insertion point is missing" unless step.fetch("run").include?(original)
  step["run"] = step.fetch("run").sub(original, replacement)
when "readback-extra-authenticated-curl"
  step = jobs.fetch("public-readback").fetch("steps").fetch(0)
  curl_line = step.fetch("run").lines.find do |line|
    line.include?("/usr/bin/curl") && line.end_with?("\\\n")
  end
  abort "readback curl insertion point is missing" unless curl_line
  indent = curl_line[/\A\s*/]
  authenticated = indent +
    %q{/usr/bin/curl --header "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" "$url" >/dev/null} + "\n"
  step["run"] = step.fetch("run").sub(curl_line, authenticated + curl_line)
when "readback-curlrc-injection"
  step = jobs.fetch("public-readback").fetch("steps").fetch(0)
  curl_line = step.fetch("run").lines.find do |line|
    line.include?("/usr/bin/curl") && line.end_with?("\\\n")
  end
  abort "readback curl insertion point is missing" unless curl_line
  indent = curl_line[/\A\s*/]
  curlrc = indent +
    %q{printf '%s\n' 'header = "Authorization: Bearer injected"' >~/.curlrc} + "\n"
  step["run"] = step.fetch("run").sub(curl_line, curlrc + curl_line)
when "readback-curl-config-enabled"
  step = jobs.fetch("public-readback").fetch("steps").fetch(0)
  disabled = "/usr/bin/curl --disable \\\n"
  enabled = "/usr/bin/curl \\\n"
  abort "curl config-disable option is missing" unless step.fetch("run").include?(disabled)
  step["run"] = step.fetch("run").sub(disabled, enabled)
when "readback-self-hosted-runner"
  jobs.fetch("public-readback")["runs-on"] = "self-hosted"
when "readback-login-shell"
  jobs.fetch("public-readback").fetch("steps").fetch(0)["shell"] =
    "bash -l {0}"
when "fourth-release-asset"
  add_fourth_release_asset(jobs)
when "writer-gh-shell-wrapper"
  step = jobs.fetch("publish").fetch("steps").fetch(1)
  release_line = "gh release create \"$RELEASE_TAG\" \\\n"
  abort "release insertion point is missing" unless step.fetch("run").include?(release_line)
  wrapper = <<~'SHELL'
    printf 'unexpected\n' >"${RUNNER_TEMP}/unexpected.txt"
    gh() {
      command gh "$@" "${RUNNER_TEMP}/unexpected.txt"
    }

  SHELL
  step["run"] = step.fetch("run").sub(release_line, wrapper + release_line)
when "writer-post-verification-asset-root"
  step = jobs.fetch("publish").fetch("steps").fetch(1)
  release_line = "gh release create \"$RELEASE_TAG\" \\\n"
  abort "release insertion point is missing" unless step.fetch("run").include?(release_line)
  replacement = <<~'SHELL'
    verified_asset_root="$ASSET_ROOT"
    ASSET_ROOT="${RUNNER_TEMP}/unverified-release-assets"
    mkdir -p "$ASSET_ROOT"
    cp -R "$verified_asset_root/." "$ASSET_ROOT/"
    printf 'unverified\n' >>"$ASSET_ROOT/$VFS_FILENAME"

  SHELL
  step["run"] = step.fetch("run").sub(release_line, replacement + release_line)
when "writer-job-bash-env"
  writer = jobs.fetch("publish")
  writer["env"] = {
    "BASH_ENV" => "${{ runner.temp }}/homebrew-experimental-vfs-release-assets/homebrew-selection.json",
  }
when "writer-container"
  jobs.fetch("publish")["container"] = "ubuntu:latest"
when "writer-api-post"
  jobs.fetch("publish").fetch("steps") << {
    "name" => "Credentialed API write",
    "shell" => "bash",
    "run" => "gh api --method POST /repos/${GITHUB_REPOSITORY}/releases",
  }
when "campaign-generation-step"
  jobs.fetch("public-readback").fetch("steps") << {
    "name" => "Campaign generation bookkeeping",
    "shell" => "bash",
    "run" => "true",
  }
when "browser-proof-env-stripped"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Prove exact composition startup on a fresh runner"
  end
  abort "browser smoke step is missing" unless step
  source = step.fetch("run")
  explicit = <<~'SHELL'.strip
    scripts/dev-shell.sh env \
      ASSET_ROOT="$ASSET_ROOT" \
      TAP_REVISION="$TAP_REVISION" \
      SELECTION_PATH="$SELECTION_PATH" \
      bash -c \
  SHELL
  stripped = "scripts/dev-shell.sh bash -c \\\n"
  if source.include?(explicit)
    step["run"] = source.sub(explicit, stripped.strip)
  elsif !source.include?(stripped.strip)
    abort "browser smoke dev-shell invocation is missing"
  end
when "browser-smoke-scope-expanded"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Prove exact composition startup on a fresh runner"
  end
  abort "browser smoke step is missing" unless step
  bounded = " --project=chromium \\\n    --grep 'starts.*Ruby'"
  source = step.fetch("run")
  abort "bounded browser smoke selector is missing" unless source.include?(bounded)
  step["run"] = source.sub(bounded, " --project=chromium")
when "browser-app-dependencies-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Install locked proof dependencies"
  end
  abort "JavaScript dependency step is missing" unless step
  install = "npm --prefix apps/browser-demos ci --no-audit --no-fund\n"
  source = step.fetch("run")
  step["run"] = source.sub(install, "") if source.include?(install)
when "node-startup-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Prove exact composition startup on a fresh runner"
  end
  abort "startup step is missing" unless step
  lines = step.fetch("run").lines
  first = lines.index do |line|
    line.include?("scripts/dev-shell.sh npx tsx")
  end
  abort "Node startup command is missing" unless first
  last = (first...lines.length).find do |index|
    lines.fetch(index).include?('--tap-root tap --tap-revision "$TAP_REVISION"')
  end
  abort "Node startup command terminator is missing" unless last
  lines.slice!(first..last)
  step["run"] = lines.join
when "node-full-lifecycle-reintroduced"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Prove exact composition startup on a fresh runner"
  end
  abort "startup step is missing" unless step
  source = step.fetch("run")
  startup = "scripts/homebrew-flat-vfs-node-startup.ts"
  abort "Node startup CLI is missing" unless source.include?(startup)
  step["run"] = source.sub(startup, "scripts/homebrew-flat-vfs-node-smoke.ts")
when "node-startup-evidence-reintroduced"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Prove exact composition startup on a fresh runner"
  end
  abort "startup step is missing" unless step
  step["run"] +=
    %q{printf '{}\n' >"$ASSET_ROOT/homebrew-node-evidence.json"} + "\n"
when "candidate-download-by-name"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Download the exact same-run build candidate"
  end
  abort "candidate download step is missing" unless step
  step["with"] = {
    "name" => "homebrew-experimental-vfs-abi42-candidate-attempt-${{ github.run_attempt }}",
    "path" => "${{ runner.temp }}/homebrew-experimental-vfs-candidate",
  }
when "candidate-cross-run-download"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Download the exact same-run build candidate"
  end
  abort "candidate download step is missing" unless step
  step.fetch("with")["run-id"] = "123456789"
when "candidate-artifact-id-output-omitted"
  jobs.fetch("build-image").fetch("outputs").delete("candidate_artifact_id")
when "candidate-rootfs-output-omitted"
  jobs.fetch("build-image").fetch("outputs").delete("rootfs_sha256")
when "candidate-selection-comparison-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  lines = step.fetch("run").lines
  index = lines.index do |line|
    line.include?('cmp -- "$CANDIDATE_ROOT/homebrew-selection.json"')
  end
  abort "candidate selection comparison is missing" unless index
  lines.delete_at(index)
  lines.delete_at(index) if lines.fetch(index, "").include?("tap/$SELECTION_PATH")
  step["run"] = lines.join
when "candidate-kernel-claim-omitted"
  step = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Build the exact flat VFS candidate"
  end
  abort "candidate image build is missing" unless step
  source = step.fetch("run")
  abort "kernel claim checks are missing" unless source.include?("publication-claimed")
  step["run"] = source.lines.reject do |line|
    line.include?("publication-claimed")
  end.join
when "candidate-kernel-mirror-binding-omitted"
  step = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Build the exact flat VFS candidate"
  end
  abort "candidate image build is missing" unless step
  binding = '[ "$(realpath local-binaries/kernel.wasm)" = "$kernel" ]'
  source = step.fetch("run")
  abort "kernel mirror binding is missing" unless source.include?(binding)
  step["run"] = source.sub(binding, "true")
when "candidate-sixth-file-uploaded"
  step = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Retain the exact same-run build candidate"
  end
  abort "candidate upload is missing" unless step
  step.fetch("with")["path"] +=
    "\n${{ runner.temp }}/homebrew-experimental-vfs-candidate/unexpected.txt\n"
when "candidate-rootfs-copy-omitted"
  step = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Build the exact flat VFS candidate"
  end
  abort "candidate image build is missing" unless step
  line = 'cp -- host/wasm/rootfs.vfs "$CANDIDATE_ROOT/rootfs.vfs"'
  source = step.fetch("run")
  abort "base rootfs relay is missing" unless source.include?(line)
  step["run"] = source.sub(line, "true")
when "candidate-rootfs-source-guard-omitted"
  step = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Build the exact flat VFS candidate"
  end
  abort "candidate image build is missing" unless step
  line = '[ -f host/wasm/rootfs.vfs ] && [ ! -L host/wasm/rootfs.vfs ]'
  source = step.fetch("run")
  abort "base rootfs source guard is missing" unless source.include?(line)
  step["run"] = source.sub(line, "true")
when "candidate-rootfs-report-binding-omitted"
  step = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Identify the exact build candidate"
  end
  abort "candidate identity step is missing" unless step
  source = step.fetch("run")
  abort "base rootfs report binding is missing" unless source.include?(
    ".base_image.sha256"
  )
  step["run"] = source.lines.reject do |line|
    line.include?(".base_image.")
  end.join
when "candidate-kernel-verification-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  line = 'verify_candidate kernel.wasm "$KERNEL_SHA256" "$KERNEL_BYTES"'
  source = step.fetch("run")
  abort "candidate kernel verification is missing" unless source.include?(line)
  step["run"] = source.sub(line, "true")
when "candidate-rootfs-verification-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  line = 'verify_candidate rootfs.vfs "$ROOTFS_SHA256" "$ROOTFS_BYTES"'
  source = step.fetch("run")
  abort "candidate rootfs verification is missing" unless source.include?(line)
  step["run"] = source.sub(line, "true")
when "candidate-rootfs-proof-report-binding-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  source = step.fetch("run")
  abort "proof rootfs report binding is missing" unless source.include?(
    ".base_image.sha256"
  )
  step["run"] = source.lines.reject do |line|
    line.include?(".base_image.")
  end.join
when "candidate-rootfs-stage-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  line = 'cp -- "$CANDIDATE_ROOT/rootfs.vfs" local-binaries/rootfs.vfs'
  source = step.fetch("run")
  abort "candidate rootfs stage is missing" unless source.include?(line)
  step["run"] = source.sub(line, "true")
when "candidate-rootfs-shadow-allowed"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  lines = step.fetch("run").lines
  index = lines.index { |line| line.strip == "host/wasm/rootfs.vfs" }
  abort "rootfs shadow guard is missing" unless index
  lines.delete_at(index)
  step["run"] = lines.join
when "candidate-rootfs-mirror-rehash-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  lines = step.fetch("run").lines
  index = lines.index do |line|
    line.include?("sha256sum local-binaries/rootfs.vfs")
  end
  abort "candidate rootfs mirror rehash is missing" unless index
  lines.delete_at(index)
  lines.delete_at(index) if lines.fetch(index, "").include?("ROOTFS_SHA256")
  step["run"] = lines.join
when "candidate-kernel-mirror-rehash-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Verify and stage the exact build candidate"
  end
  abort "candidate verifier is missing" unless step
  lines = step.fetch("run").lines
  index = lines.index do |line|
    line.include?("sha256sum local-binaries/kernel.wasm")
  end
  abort "candidate kernel mirror rehash is missing" unless index
  lines.delete_at(index)
  lines.delete_at(index) if lines.fetch(index, "").include?("KERNEL_SHA256")
  step["run"] = lines.join
when "candidate-post-startup-binding-omitted"
  steps = jobs.fetch("build-test").fetch("steps")
  removed = steps.reject! do |candidate|
    candidate["name"] == "Bind startup-tested bytes to the exact build candidate"
  end
  abort "post-startup candidate binding is missing" unless removed
when "candidate-rootfs-post-startup-binding-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Bind startup-tested bytes to the exact build candidate"
  end
  abort "post-startup candidate binding is missing" unless step
  line = 'verify_input local-binaries/rootfs.vfs "$ROOTFS_SHA256" "$ROOTFS_BYTES"'
  source = step.fetch("run")
  abort "post-startup rootfs binding is missing" unless source.include?(line)
  step["run"] = source.sub(line, "true")
when "post-startup-identify-mutates-selection"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Identify the exact three release assets"
  end
  abort "final identity step is missing" unless step
  step["run"] =
    'printf x >>"$ASSET_ROOT/homebrew-selection.json"' + "\n" +
    step.fetch("run")
when "candidate-kernel-added-to-final-artifact"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Retain the fixed three-file artifact"
  end
  abort "final artifact upload is missing" unless step
  step.fetch("with")["path"] += "\nlocal-binaries/kernel.wasm\n"
when "candidate-rootfs-added-to-final-artifact"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Retain the fixed three-file artifact"
  end
  abort "final artifact upload is missing" unless step
  step.fetch("with")["path"] += "\nlocal-binaries/rootfs.vfs\n"
when "image-build-reintroduced-in-proof"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Prove exact composition startup on a fresh runner"
  end
  abort "proof step is missing" unless step
  step["run"] += "\nscripts/dev-shell.sh bash build.sh\n"
when "publisher-consumes-image-output"
  step = jobs.fetch("publish").fetch("steps").find do |candidate|
    candidate["name"] == "Publish the exact inert assets once"
  end
  abort "publisher step is missing" unless step
  step.fetch("env")["VFS_SHA256"] =
    "${{ needs.build-image.outputs.vfs_sha256 }}"
when "musl-submodule-checkout-path"
  checkout = jobs.fetch("build-image").fetch("steps").find do |candidate|
    candidate["name"] == "Checkout exact Kandelo source"
  end
  abort "exact Kandelo checkout is missing" unless checkout
  checkout.fetch("with")["submodules"] = "libc/musl"
when "musl-submodule-init-omitted"
  steps = jobs.fetch("build-image").fetch("steps")
  removed = steps.reject! do |candidate|
    candidate["name"] == "Initialize exact musl submodule"
  end
  abort "exact musl submodule initialization is missing" unless removed
when "libc-sysroot-build-omitted"
  steps = jobs.fetch("build-image").fetch("steps")
  removed = steps.reject! do |candidate|
    candidate["name"] == "Build worktree-local wasm32 sysroot"
  end
  abort "libc sysroot build step is missing" unless removed
else
  abort "unknown mutation: #{mutation}"
end

File.write(destination, YAML.dump(workflow))
RUBY

  if ruby "$CHECKER" "$fixture" >"$TEST_ROOT/$name.log" 2>&1; then
    fail "accepted $name"
  fi
}

ruby "$CHECKER" "$WORKFLOW"
expect_rejection extra-read-only-job extra-read-only-job
expect_rejection readback-credential readback-credential
expect_rejection readback-github-token-single-bracket \
  readback-github-token-single-bracket
expect_rejection readback-github-token-double-bracket \
  readback-github-token-double-bracket
expect_rejection readback-github-token-spaced-case \
  readback-github-token-spaced-case
expect_rejection readback-github-token-spaced-dot \
  readback-github-token-spaced-dot
expect_rejection readback-github-token-dynamic \
  readback-github-token-dynamic
expect_rejection readback-github-token-embedded-delimiter \
  readback-github-token-embedded-delimiter
expect_rejection readback-secret-single-bracket \
  readback-secret-single-bracket
expect_rejection readback-secret-double-bracket \
  readback-secret-double-bracket
expect_rejection readback-secret-spaced-case \
  readback-secret-spaced-case
expect_rejection readback-secret-spaced-dot \
  readback-secret-spaced-dot
expect_rejection readback-secret-context readback-secret-context
expect_rejection readback-workflow-env-credential \
  readback-workflow-env-credential
expect_rejection readback-job-env-credential \
  readback-job-env-credential
expect_rejection readback-step-env-credential \
  readback-step-env-credential
expect_rejection readback-ambient-env-credential \
  readback-ambient-env-credential
expect_rejection readback-parent-shell-url-credential \
  readback-parent-shell-url-credential
expect_rejection readback-extra-authenticated-curl \
  readback-extra-authenticated-curl
expect_rejection readback-curlrc-injection readback-curlrc-injection
expect_rejection readback-curl-config-enabled readback-curl-config-enabled
expect_rejection readback-self-hosted-runner readback-self-hosted-runner
expect_rejection readback-login-shell readback-login-shell
expect_rejection fourth-release-asset fourth-release-asset
expect_rejection writer-gh-shell-wrapper writer-gh-shell-wrapper
expect_rejection writer-post-verification-asset-root \
  writer-post-verification-asset-root
expect_rejection writer-job-bash-env writer-job-bash-env
expect_rejection writer-container writer-container
expect_rejection writer-api-post writer-api-post
expect_rejection campaign-generation-step campaign-generation-step
expect_rejection browser-proof-env-stripped browser-proof-env-stripped
expect_rejection browser-smoke-scope-expanded browser-smoke-scope-expanded
expect_rejection browser-app-dependencies-omitted \
  browser-app-dependencies-omitted
expect_rejection node-startup-omitted node-startup-omitted
expect_rejection node-full-lifecycle-reintroduced \
  node-full-lifecycle-reintroduced
expect_rejection node-startup-evidence-reintroduced \
  node-startup-evidence-reintroduced
expect_rejection candidate-download-by-name candidate-download-by-name
expect_rejection candidate-cross-run-download candidate-cross-run-download
expect_rejection candidate-artifact-id-output-omitted \
  candidate-artifact-id-output-omitted
expect_rejection candidate-rootfs-output-omitted candidate-rootfs-output-omitted
expect_rejection candidate-selection-comparison-omitted \
  candidate-selection-comparison-omitted
expect_rejection candidate-kernel-claim-omitted \
  candidate-kernel-claim-omitted
expect_rejection candidate-kernel-mirror-binding-omitted \
  candidate-kernel-mirror-binding-omitted
expect_rejection candidate-sixth-file-uploaded candidate-sixth-file-uploaded
expect_rejection candidate-rootfs-copy-omitted \
  candidate-rootfs-copy-omitted
expect_rejection candidate-rootfs-source-guard-omitted \
  candidate-rootfs-source-guard-omitted
expect_rejection candidate-rootfs-report-binding-omitted \
  candidate-rootfs-report-binding-omitted
expect_rejection candidate-kernel-verification-omitted \
  candidate-kernel-verification-omitted
expect_rejection candidate-rootfs-verification-omitted \
  candidate-rootfs-verification-omitted
expect_rejection candidate-rootfs-proof-report-binding-omitted \
  candidate-rootfs-proof-report-binding-omitted
expect_rejection candidate-rootfs-stage-omitted candidate-rootfs-stage-omitted
expect_rejection candidate-rootfs-shadow-allowed \
  candidate-rootfs-shadow-allowed
expect_rejection candidate-rootfs-mirror-rehash-omitted \
  candidate-rootfs-mirror-rehash-omitted
expect_rejection candidate-kernel-mirror-rehash-omitted \
  candidate-kernel-mirror-rehash-omitted
expect_rejection candidate-post-startup-binding-omitted \
  candidate-post-startup-binding-omitted
expect_rejection candidate-rootfs-post-startup-binding-omitted \
  candidate-rootfs-post-startup-binding-omitted
expect_rejection post-startup-identify-mutates-selection \
  post-startup-identify-mutates-selection
expect_rejection candidate-kernel-added-to-final-artifact \
  candidate-kernel-added-to-final-artifact
expect_rejection candidate-rootfs-added-to-final-artifact \
  candidate-rootfs-added-to-final-artifact
expect_rejection image-build-reintroduced-in-proof \
  image-build-reintroduced-in-proof
expect_rejection publisher-consumes-image-output \
  publisher-consumes-image-output
expect_rejection musl-submodule-checkout-path musl-submodule-checkout-path
expect_rejection musl-submodule-init-omitted musl-submodule-init-omitted
expect_rejection libc-sysroot-build-omitted libc-sysroot-build-omitted

echo "test-homebrew-experimental-vfs-workflow: ok"
