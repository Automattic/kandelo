#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$REPO_ROOT/scripts/check-homebrew-experimental-vfs-workflow.rb"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-experimental-vfs-publish.yml"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-experimental-vfs-workflow.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  echo "test-homebrew-experimental-vfs-workflow: $*" >&2
  exit 1
}

expect_rejection() {
  local name="$1"
  local mutation="$2"
  local fixture="$TEST_ROOT/$name.yml"

  ruby - "$WORKFLOW" "$fixture" "$mutation" <<'RUBY'
require "yaml"

source, destination, mutation = ARGV
workflow = YAML.safe_load(File.read(source), permitted_classes: [], aliases: false)
jobs = workflow.fetch("jobs")

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
expect_rejection writer-api-post writer-api-post
expect_rejection campaign-generation-step campaign-generation-step

echo "test-homebrew-experimental-vfs-workflow: ok"
