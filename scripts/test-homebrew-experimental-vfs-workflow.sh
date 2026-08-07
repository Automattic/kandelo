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

def add_fifth_release_asset(jobs)
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

  final_asset = %q{  "$ASSET_ROOT/homebrew-node-evidence.json"} + "\n"
  final_asset_position = source.rindex(final_asset)
  abort "final release asset is missing" unless final_asset_position
  fifth_asset = %q{  "$ASSET_ROOT/homebrew-node-evidence.json" } +
    backslash + "\n" + %q{  "${RUNNER_TEMP}/unexpected.txt"} + "\n"
  source[final_asset_position, final_asset.length] = fifth_asset
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
when "fifth-release-asset"
  add_fifth_release_asset(jobs)
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
    "BASH_ENV" => "${{ runner.temp }}/homebrew-experimental-vfs-release-assets/homebrew-node-evidence.json",
  }
  build_step = jobs.fetch("build-test").fetch("steps").find do |step|
    step["name"] == "Build and prove the exact flat VFS"
  end
  abort "build evidence step is missing" unless build_step
  evidence_line = build_step.fetch("run").lines.find do |line|
    line.include?('[ -f "$ASSET_ROOT/homebrew-node-evidence.json" ]')
  end
  abort "build evidence insertion point is missing" unless evidence_line
  bash_env_payload = evidence_line[/\A\s*/] +
    %q{printf '%s\n' 'gh() { command gh "$@" /etc/hosts; }' >"$ASSET_ROOT/homebrew-node-evidence.json"} + "\n"
  build_step["run"] = build_step.fetch("run").sub(
    evidence_line,
    evidence_line + bash_env_payload
  )
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
    candidate["name"] == "Build and prove the exact flat VFS"
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
    candidate["name"] == "Build and prove the exact flat VFS"
  end
  abort "browser smoke step is missing" unless step
  bounded = " --project=chromium \\\n    --grep 'starts.*Ruby'"
  source = step.fetch("run")
  abort "bounded browser smoke selector is missing" unless source.include?(bounded)
  step["run"] = source.sub(bounded, " --project=chromium")
when "browser-app-dependencies-omitted"
  step = jobs.fetch("build-test").fetch("steps").find do |candidate|
    candidate["name"] == "Install JavaScript dependencies"
  end
  abort "JavaScript dependency step is missing" unless step
  install = "npm --prefix apps/browser-demos ci --no-audit --no-fund\n"
  source = step.fetch("run")
  step["run"] = source.sub(install, "") if source.include?(install)
when "libc-sysroot-build-omitted"
  steps = jobs.fetch("build-test").fetch("steps")
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
expect_rejection fifth-release-asset fifth-release-asset
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
expect_rejection libc-sysroot-build-omitted libc-sysroot-build-omitted

echo "test-homebrew-experimental-vfs-workflow: ok"
