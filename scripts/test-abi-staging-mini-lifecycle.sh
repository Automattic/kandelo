#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi

: "${KANDELO_DEV_SHELL_TOOL_PATH:?run through scripts/dev-shell.sh}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
fixture="$repo_root/tools/xtask/tests/fixtures/abi-staging/mini-transition"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-abi-mini-lifecycle.XXXXXX")"
work_one="$test_root/first"
work_two="$test_root/second"
summary_one="$test_root/first-summary.json"
summary_two="$test_root/second-summary.json"

host_target="$(rustc -vV | awk '/^host/ {print $2}')"

run_miniature() {
  local work_dir="$1"
  local summary_path="$2"
  cargo run -p xtask --target "$host_target" --quiet -- \
    abi-staging mini run \
    --fixture "$fixture" \
    --work "$work_dir" >"$summary_path"
}

cd "$repo_root"
run_miniature "$work_one" "$summary_one"
run_miniature "$work_two" "$summary_two"
cmp "$summary_one" "$summary_two"
cmp "$summary_one" "$work_one/summary.json"
cmp "$summary_two" "$work_two/summary.json"

node - "$work_one" <<'NODE'
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const work = process.argv[2];
const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8"));
if (summary.target_abi !== summary.source_abi + 1) {
  throw new Error("miniature did not model generic N to N + 1");
}
if (JSON.stringify(summary.required_subjects) !== JSON.stringify(["tool", "base"])) {
  throw new Error("required Formula order was not derived from product roots and tap dependencies");
}
if (JSON.stringify(summary.background_subjects) !== JSON.stringify(["background"])) {
  throw new Error("unrelated background Formula did not remain separately reconcilable");
}
if (JSON.stringify(summary.candidate_layers) !== JSON.stringify(summary.canonical_layers)) {
  throw new Error("promotion rebuilt or changed bottle-layer identities");
}
if (summary.candidate_vfs_sha256 === summary.canonical_vfs_sha256) {
  throw new Error("canonical lazy references did not recompose the final VFS");
}
if (summary.pages_result !== "deployed-complete") {
  throw new Error("complete local Pages inventory was not atomically selected");
}
if (summary.retry_schedule.length !== 3 ||
    summary.retry_schedule.map((retry) => retry.retry_number).join(",") !== "1,2,3") {
  throw new Error("miniature did not schedule exactly three retries after the initial attempt");
}
const expectedGuards = [
  "build_input_capture_incomplete",
  "request_unauthorized",
  "build_failed",
  "policy_version_unknown",
  "namespace_bootstrap_failed",
  "source_identity_mismatch",
];
if (JSON.stringify(summary.negative_guards) !== JSON.stringify(expectedGuards)) {
  throw new Error("miniature negative paths did not fail with the exact guard registry codes");
}
for (const namespace of ["candidate", "canonical", "source"]) {
  if (!existsSync(join(work, "transport", namespace, "sha256"))) {
    throw new Error(`missing local transport namespace ${namespace}`);
  }
}
const requests = readdirSync(join(work, "requests"));
if (requests.length !== 1 ||
    !/^candidate-request-[0-9a-f]{40}-sha256-[0-9a-f]{64}\.json$/.test(requests[0])) {
  throw new Error("miniature request does not use the exact immutable asset name");
}
const records = readdirSync(join(work, "records"));
for (const required of [
  "attempt-base",
  "candidate-base",
  "candidate-tool",
  "verification-base",
  "verification-tool",
  "product-evidence-mini-shell",
  "product-readiness",
  "admission-base",
  "admission-tool",
  "pages-held",
  "pages-ready",
]) {
  if (!records.some((name) => name.includes(`-${required}-sha256-`))) {
    throw new Error(`missing miniature durable record ${required}`);
  }
}
if (!existsSync(join(work, "pages", "retained-prior-site.json"))) {
  throw new Error("incomplete Pages evidence did not retain the prior complete site");
}
NODE

echo "ABI staging miniature lifecycle: PASS"
