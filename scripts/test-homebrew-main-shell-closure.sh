#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh"
CHECKER="$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs"
BREWFILE="$REPO_ROOT/homebrew/main-shell.Brewfile"
SOURCE_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
WORKFLOW="$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "test-homebrew-main-shell-closure: $*" >&2
  exit 1
}

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "command unexpectedly succeeded: $*"
  fi
  grep -Fq -- "$expected" <<<"$output" || {
    printf '%s\n' "$output" >&2
    fail "failure did not contain: $expected"
  }
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v node >/dev/null 2>&1 || fail "node is required"

pull_paths="$(awk '
  /^  pull_request:$/ { active = 1; next }
  /^  push:$/ { active = 0 }
  active && /^      - "/ { line = $0; sub(/^      - "/, "", line); sub(/"$/, "", line); print line }
' "$WORKFLOW")"
push_paths="$(awk '
  /^  push:$/ { active = 1; next }
  /^  workflow_dispatch:$/ { active = 0 }
  active && /^      - "/ { line = $0; sub(/^      - "/, "", line); sub(/"$/, "", line); print line }
' "$WORKFLOW")"
[ "$pull_paths" = "$push_paths" ] ||
  fail "Homebrew main-shell pull_request and push path filters must stay aligned"

for required_path in \
  ".github/actions/setup-nix/**" \
  "MANIFEST" \
  "apps/browser-demos/pages/kandelo/**" \
  "apps/browser-demos/vite.config.ts" \
  "crates/shared/**" \
  "homebrew/main-shell*" \
  "host/src/generated/abi.ts" \
  "host/src/homebrew-vfs-*.ts" \
  "host/src/vfs/**" \
  "images/rootfs/**" \
  "images/vfs/scripts/vfs-image-helpers.ts" \
  "packages/registry/rootfs/package.toml" \
  "packages/registry/shell/**" \
  "scripts/dev-shell.sh" \
  "scripts/fetch-binaries.sh" \
  "scripts/homebrew-brewfile-selection.rb" \
  "scripts/homebrew-checkout-public-tap.sh" \
  "scripts/install-local-binary.sh" \
  "scripts/resolve-binary.sh" \
  "tools/mkrootfs/**" \
  "web-libs/kandelo-session/src/kernel-host.ts" \
  "web-libs/kandelo-session/src/shell-config.ts"
do
  grep -Fxq "$required_path" <<<"$pull_paths" ||
    fail "Homebrew main-shell workflow does not watch authoritative input $required_path"
done

setup_node_line="$(grep -n 'uses: actions/setup-node@' "$WORKFLOW" | cut -d: -f1)"
checker_line="$(grep -n 'node scripts/check-homebrew-main-shell-brewfile.mjs' "$WORKFLOW" | cut -d: -f1)"
[ -n "$setup_node_line" ] && [ -n "$checker_line" ] &&
  [ "$setup_node_line" -lt "$checker_line" ] ||
  fail "pinned Node setup must precede the main-shell contract checker"

for evidence_file in "$BUILDER" "$WORKFLOW"; do
  grep -Fq '(.packages | length) == 38' "$evidence_file" ||
    fail "$evidence_file does not require the exact 38-Formula closure"
  grep -Fq '[.packages[].full_name] | sort' "$evidence_file" ||
    fail "$evidence_file does not compare exact Formula closure identities"
  grep -Fq 'formula_closure | sort' "$evidence_file" ||
    fail "$evidence_file does not bind report identities to the migration lock"
done

for variable in \
  KANDELO_HOMEBREW_MAIN_SHELL_TAP_ROOT \
  KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA \
  KANDELO_HOMEBREW_MAIN_SHELL_STRICT \
  KANDELO_HOMEBREW_MAIN_SHELL_SHA256
do
  grep -Fq -- "$variable=\"\$" "$WORKFLOW" ||
    fail "main-shell workflow must pass $variable explicitly to its isolated consumer"
  grep -Fq -- "--keep $variable " "$REPO_ROOT/scripts/dev-shell.sh" &&
    fail "dev shell must not globally preserve main-shell-only input $variable"
done

grep -Fq 'bash scripts/dev-shell.sh env \' "$WORKFLOW" ||
  fail "main-shell workflow must forward bottle-composer inputs inside the isolated dev shell"
grep -Fq 'bash ../../scripts/dev-shell.sh env \' "$WORKFLOW" ||
  fail "main-shell workflow must forward browser acceptance inputs inside the isolated dev shell"
grep -Fq 'PLAYWRIGHT_JSON_OUTPUT_FILE="$report" \' "$WORKFLOW" ||
  fail "browser acceptance must have Playwright write JSON directly to its report file"
grep -Fq -- '--project=chromium --reporter=json >"$report"' "$WORKFLOW" &&
  fail "browser acceptance must not mix dev-shell stdout into the Playwright JSON report"
grep -Fq "jq -r '.packages[].registry.name' homebrew/main-shell-migration-lock.json" "$WORKFLOW" ||
  fail "binary fetch must select the reviewed main-shell registry roots"
grep -Fq 'fetch_args+=(--package "$package")' "$WORKFLOW" ||
  fail "binary fetch must pass exact positive package selections"
grep -Fq 'scripts/fetch-binaries.sh "${fetch_args[@]}"' "$WORKFLOW" ||
  fail "binary fetch must materialize only its declared browser inputs"
grep -Fq 'WASM_POSIX_FETCH_SKIP_PKGS:' "$WORKFLOW" &&
  fail "main-shell proof must not use a negative package skip list"
for browser_input in dinit node rootfs; do
  grep -Fxq "            $browser_input" "$WORKFLOW" ||
    fail "main-shell workflow omits direct browser input $browser_input"
done
for locked_browser_input in nethack-browser-bundle vim-browser-bundle; do
  grep -Fxq "            $locked_browser_input" "$WORKFLOW" &&
    fail "main-shell workflow repeats locked browser input $locked_browser_input"
done
grep -Fq '[ "${#browser_input_packages[@]}" -eq 35 ]' "$WORKFLOW" ||
  fail "main-shell workflow does not require exactly 35 browser input roots"
grep -Fq 'sort -u | wc -l)" -eq 35 ]' "$WORKFLOW" ||
  fail "main-shell workflow does not require 35 unique browser input roots"

mapfile -t locked_browser_inputs < <(jq -r '.packages[].registry.name' "$SOURCE_LOCK")
browser_inputs=("${locked_browser_inputs[@]}" dinit node rootfs)
[ "${#browser_inputs[@]}" -eq 35 ] ||
  fail "main-shell browser proof must select 32 locked roots plus 3 direct inputs"
[ "$(printf '%s\n' "${browser_inputs[@]}" | sort -u | wc -l)" -eq 35 ] ||
  fail "main-shell browser proof inputs must be a unique 35-package set"

# The dev-shell wrapper intentionally reports Nix lookup and shell-hook details
# on stdout. Playwright must own the JSON file directly so those diagnostics can
# remain visible without corrupting machine-readable acceptance evidence.
playwright_report="$TMP_ROOT/playwright-report.json"
wrapper_log="$TMP_ROOT/dev-shell-stdout.log"
(
  echo "path does not contain a flake.nix, searching up"
  echo "kandelo dev shell — declared tools are ready"
  PLAYWRIGHT_JSON_OUTPUT_FILE="$playwright_report" node -e '
    const fs = require("node:fs");
    process.stdout.write("playwright command stdout remains diagnostic-only\n");
    fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({
      stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    }));
  '
) >"$wrapper_log"
grep -Fq "path does not contain a flake.nix" "$wrapper_log" ||
  fail "noisy-wrapper fixture did not preserve dev-shell diagnostics"
grep -Fq "playwright command stdout remains diagnostic-only" "$wrapper_log" ||
  fail "noisy-wrapper fixture did not preserve command diagnostics"
jq -e '
  .stats.expected == 1 and .stats.unexpected == 0 and
  .stats.flaky == 0 and .stats.skipped == 0
' "$playwright_report" >/dev/null ||
  fail "direct Playwright JSON report was corrupted by noisy wrapper stdout"
grep -Fq "flake.nix" "$playwright_report" &&
  fail "dev-shell diagnostics leaked into the direct Playwright JSON report"

expect_failure "KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA requires" \
  env KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA=0000000000000000000000000000000000000000 \
  bash "$REPO_ROOT/packages/registry/shell/build-shell.sh"

tap="$TMP_ROOT/tap"
mkdir -p "$tap/Kandelo"
git -C "$tap" init -q
git -C "$tap" config user.email "homebrew-contract-test@example.invalid"
git -C "$tap" config user.name "Homebrew contract test"
printf '%s\n' \
  '{"tap_repository":"kandelo-dev/homebrew-tap-core","tap_name":"kandelo-dev/tap-core"}' \
  >"$tap/Kandelo/metadata.json"
git -C "$tap" add Kandelo/metadata.json
git -C "$tap" commit -qm "Homebrew: Add canonical test metadata"
tap_sha="$(git -C "$tap" rev-parse HEAD)"
lock="$TMP_ROOT/main-shell-migration-lock.json"
jq --arg sha "$tap_sha" '.catalog.tap_commit = $sha' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"

expect_failure "must match locked catalog" \
  "$BUILDER" --tap-root "$tap" \
  --migration-lock "$lock" \
  --expected-tap-sha 0000000000000000000000000000000000000000

printf '%s\n' "untracked" >"$tap/untracked-file"
expect_failure "exact tap checkout is dirty" \
  "$BUILDER" --tap-root "$tap" --migration-lock "$lock"
rm "$tap/untracked-file"

tap_worktree="$TMP_ROOT/tap-worktree"
git -C "$tap" worktree add --detach "$tap_worktree" "$tap_sha" >/dev/null
[ -f "$tap_worktree/.git" ] ||
  fail "linked tap fixture does not exercise a .git worktree file"
expect_failure "--max-bytes must match the locked consumer capacity" \
  "$BUILDER" --tap-root "$tap_worktree" --migration-lock "$lock" --max-bytes 4096

printf '%s\n' \
  '{"tap_repository":"example/wrong-tap","tap_name":"example/wrong"}' \
  >"$tap/Kandelo/metadata.json"
git -C "$tap" add Kandelo/metadata.json
git -C "$tap" commit -qm "Homebrew: Make test identity invalid"
tap_sha="$(git -C "$tap" rev-parse HEAD)"
jq --arg sha "$tap_sha" '.catalog.tap_commit = $sha' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json" >"$lock"
expect_failure "tap metadata has the wrong repository identity" \
  "$BUILDER" --tap-root "$tap" --migration-lock "$lock"

baseline_output="$(node "$CHECKER")"
grep -Fq "32 registry roots and 38 Formulae" <<<"$baseline_output" ||
  fail "main-shell checker does not report both exact closure counts"

metadata="$TMP_ROOT/main-shell-metadata.json"
jq '
  def dependencies:
    if . == "bash" then ["ncurses"]
    elif . == "ncurses" then ["libcxx"]
    elif . == "file-formula" then ["bzip2", "libmagic", "xz", "zlib"]
    elif . == "m4" or . == "make" then ["dash"]
    elif . == "diffutils" then ["coreutils", "ed"]
    elif . == "tar" then ["dash", "gzip"]
    elif . == "curl" then ["libcurl", "openssl", "zlib"]
    elif . == "wget" then ["openssl", "zlib"]
    elif . == "git" then
      ["coreutils", "dash", "diffutils", "grep", "less", "libcurl", "openssl", "sed", "vim", "zlib"]
    elif . == "zip" then ["unzip"]
    elif . == "libmagic" then ["bzip2", "xz", "zlib"]
    elif . == "libcurl" then ["openssl", "zlib"]
    else []
    end;
  (
    [.packages[].formula | {
      name,
      version: (if .revision == 0 then .version else "\(.version)_\(.revision)" end),
      formula_revision: .revision,
      bottle_rebuild
    }] + [
      {"name":"libcxx","version":"21.1.7_1","formula_revision":1,"bottle_rebuild":0},
      {"name":"zlib","version":"1.3.1_4","formula_revision":4,"bottle_rebuild":1},
      {"name":"libmagic","version":"5.45","formula_revision":0,"bottle_rebuild":0},
      {"name":"ed","version":"1.22.5_1","formula_revision":1,"bottle_rebuild":0},
      {"name":"openssl","version":"3.3.2_2","formula_revision":2,"bottle_rebuild":1},
      {"name":"libcurl","version":"8.11.1_1","formula_revision":1,"bottle_rebuild":2}
    ]
  ) as $formulae |
  {
    schema: 1,
    tap_repository,
    tap_name,
    packages: [$formulae[] | . as $formula | {
      name: $formula.name,
      full_name: ("kandelo-dev/tap-core/" + $formula.name),
      version: $formula.version,
      formula_revision: $formula.formula_revision,
      bottle_rebuild: $formula.bottle_rebuild,
      dependencies: [($formula.name | dependencies)[] | . as $dependency | {
        name: $dependency,
        full_name: ("kandelo-dev/tap-core/" + $dependency)
      }]
    }]
  }
' "$SOURCE_LOCK" >"$metadata"

metadata_output="$(node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$metadata")"
grep -Fq "32 registry roots and 38 Formulae" <<<"$metadata_output" ||
  fail "main-shell checker did not validate the exact synthetic tap closure"

jq 'del(.formula_closure)' "$SOURCE_LOCK" >"$lock"
expect_failure "packages/formula_closure/substitutions must be arrays" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.formula_closure |= .[:-1]' "$SOURCE_LOCK" >"$lock"
expect_failure "must contain exactly 38 closure Formulae" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.formula_closure[37] = .formula_closure[36]' "$SOURCE_LOCK" >"$lock"
expect_failure "migration lock formula_closure contains duplicate" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.formula_closure[] | select(. == "kandelo-dev/tap-core/dash")) =
  "kandelo-dev/tap-core/replacement-root"' "$SOURCE_LOCK" >"$lock"
expect_failure "formula_closure omits registry-root Formulae" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.formula_closure[0] = "other/tap/dash"' "$SOURCE_LOCK" >"$lock"
expect_failure "must be a canonical kandelo-dev/tap-core/<formula> identity" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.formula_closure[] | select(. == "kandelo-dev/tap-core/libmagic")) =
  "kandelo-dev/tap-core/unexpected"' "$SOURCE_LOCK" >"$lock"
expect_failure "tap metadata dependency closure does not match reviewed formula_closure" \
  node "$CHECKER" "$BREWFILE" "$lock" "$metadata"

jq '.packages |= map(select(.name != "libmagic"))' "$metadata" >"$TMP_ROOT/missing-dependency.json"
expect_failure "missing dependency of file-formula Formula libmagic" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/missing-dependency.json"

jq '(.packages[] | select(.name == "file-formula") | .dependencies) |=
  map(select(.name != "libmagic"))' "$metadata" >"$TMP_ROOT/short-closure.json"
expect_failure "resolves 37 main-shell Formulae" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/short-closure.json"

jq '
  (.packages[] | select(.name == "dash") | .dependencies) +=
    [{"name":"unexpected","full_name":"kandelo-dev/tap-core/unexpected"}] |
  .packages += [{
    "name":"unexpected",
    "full_name":"kandelo-dev/tap-core/unexpected",
    "version":"1.0",
    "formula_revision":0,
    "bottle_rebuild":0,
    "dependencies":[]
  }]
' "$metadata" >"$TMP_ROOT/long-closure.json"
expect_failure "resolves 39 main-shell Formulae" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/long-closure.json"

jq '
  (.packages[] | select(.name == "file-formula") | .dependencies[] |
    select(.name == "libmagic")) =
      {"name":"unexpected","full_name":"kandelo-dev/tap-core/unexpected"} |
  .packages += [{
    "name":"unexpected",
    "full_name":"kandelo-dev/tap-core/unexpected",
    "version":"1.0",
    "formula_revision":0,
    "bottle_rebuild":0,
    "dependencies":[]
  }]
' "$metadata" >"$TMP_ROOT/wrong-closure.json"
expect_failure "tap metadata dependency closure does not match reviewed formula_closure" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/wrong-closure.json"

jq '(.packages[] | select(.name == "libcxx") | .dependencies) =
  [{"name":"ncurses","full_name":"kandelo-dev/tap-core/ncurses"}]' \
  "$metadata" >"$TMP_ROOT/cyclic-closure.json"
expect_failure "tap metadata dependency cycle: ncurses -> libcxx -> ncurses" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/cyclic-closure.json"

jq '.packages += [.packages[0]]' "$metadata" >"$TMP_ROOT/duplicate-formula.json"
expect_failure "tap metadata contains duplicate Formula" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/duplicate-formula.json"

jq '(.packages[] | select(.name == "bash") | .dependencies[0].full_name) =
  "other/tap/ncurses"' "$metadata" >"$TMP_ROOT/cross-tap-dependency.json"
expect_failure "is not a canonical same-tap dependency" \
  node "$CHECKER" "$BREWFILE" "$SOURCE_LOCK" "$TMP_ROOT/cross-tap-dependency.json"

jq 'del(.catalog)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.catalog.tap_commit = "main"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must pin one exact catalog commit" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.reviewed_substitutions[] | select(.kind == "formula_identity" and
  .registry == "file@5.45")) |= del(.reason)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "reviewed_substitutions[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.reviewed_substitutions += [{
  "kind":"formula_identity",
  "registry":"undeclared@1.0",
  "formula":"kandelo-dev/tap-core/undeclared-formula@1.0",
  "reason":"Synthetic undeclared substitution."
}]' "$SOURCE_LOCK" >"$lock"
expect_failure "extra: formula_identity:undeclared@1.0->kandelo-dev/tap-core/undeclared-formula@1.0" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.reviewed_substitutions += [.reviewed_substitutions[0]]' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "reviewed migration substitutions contains duplicate" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.reviewed_substitutions |= map(select(.registry != "file@5.45"))' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "missing: formula_identity:file@5.45->kandelo-dev/tap-core/file-formula@5.45" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.reviewed_substitutions[] | select(.kind == "version" and
  .registry == "m4@1.4.19") | .formula) = "kandelo-dev/tap-core/m4@1.4.22"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "extra: version:m4@1.4.19->kandelo-dev/tap-core/m4@1.4.22" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '(.packages[] | select(.registry.name == "m4") | .formula.version) = "1.4.19"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "extra: version:m4@1.4.19->kandelo-dev/tap-core/m4@1.4.21" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.consumer.max_vfs_byte_length = 268435456' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "must declare the 512 MiB consumer profile" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.link_conflict_owners[0].package = "kandelo-dev/tap-core/not-locked"' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.link_conflict_owners[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq 'del(.compatibility.aliases[0].source_kind)' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility.aliases[0] is invalid" \
  node "$CHECKER" "$BREWFILE" "$lock"

jq '.compatibility.aliases[1].targets[0] = .compatibility.aliases[0].targets[0]' \
  "$SOURCE_LOCK" >"$lock"
expect_failure "compatibility alias target is duplicated" \
  node "$CHECKER" "$BREWFILE" "$lock"

echo "test-homebrew-main-shell-closure: ok"
