#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
CONTRACT="$REPO_ROOT/homebrew/kandelo-guest-layout.json"
NATIVE_COMPATIBILITY_LOCK="$REPO_ROOT/homebrew/homebrew-native-compatibility-lock.json"
NATIVE_COMPATIBILITY_ROOTS="$REPO_ROOT/homebrew/homebrew-native-compatibility-roots.json"
NATIVE_HOST_PREFIX="/home/linuxbrew/.linuxbrew"
NATIVE_HOST_CELLAR="$NATIVE_HOST_PREFIX/Cellar"

fail() {
  echo "test-homebrew-guest-layout: $*" >&2
  exit 1
}

append_declared_homebrew_source_exclusion() {
  local declared_source="${KANDELO_HOMEBREW_SOURCE_REPOSITORY:-}"
  local source_root source_top source_relative expected_commit actual_commit
  local source_status

  [ -n "$declared_source" ] || return 0
  [ -d "$declared_source" ] ||
    fail "declared Homebrew source is not a directory"
  [ ! -L "$declared_source" ] ||
    fail "declared Homebrew source must not be a symlink"
  source_root="$(cd "$declared_source" && pwd -P)" ||
    fail "cannot resolve declared Homebrew source"

  # A source outside this tree is already outside the scanner's ownership.
  # When staging places its exact source below REPO_ROOT, exempt only a clean,
  # standalone checkout of the reviewed commit. This must not become a name-
  # based hiding place for ordinary Kandelo-owned source.
  case "$source_root" in
    "$REPO_ROOT"/*) ;;
    *) return 0 ;;
  esac

  [ -d "$source_root/.git" ] && [ ! -L "$source_root/.git" ] ||
    fail "in-tree Homebrew source must own a standalone Git directory"
  source_top="$(git -C "$source_root" rev-parse --show-toplevel 2>/dev/null)" ||
    fail "in-tree Homebrew source is not a Git checkout"
  source_top="$(cd "$source_top" && pwd -P)" ||
    fail "cannot resolve in-tree Homebrew Git root"
  [ "$source_top" = "$source_root" ] ||
    fail "declared Homebrew source is not its Git top level"

  expected_commit="$(
    jq -er '
      .homebrew_commit |
      select(type == "string" and test("^[0-9a-f]{40}$"))
    ' "$NATIVE_COMPATIBILITY_ROOTS"
  )" || fail "native compatibility roots lack an exact Homebrew commit"
  actual_commit="$(
    git -C "$source_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null
  )" || fail "cannot resolve declared Homebrew source commit"
  [ "$actual_commit" = "$expected_commit" ] ||
    fail "in-tree Homebrew source is not at the reviewed commit"

  source_status="$(
    git -C "$source_root" status \
      --porcelain=v1 \
      --untracked-files=all \
      --ignored=matching \
      --ignore-submodules=none
  )" || fail "cannot inspect declared Homebrew source status"
  [ -z "$source_status" ] ||
    fail "in-tree Homebrew source contains unreviewed changes"

  source_relative="${source_root#"$REPO_ROOT"/}"
  guest_source_pathspecs+=(
    ":(top,literal,exclude)$source_relative"
  )
}

for tool in git jq; do
  command -v "$tool" >/dev/null 2>&1 ||
    fail "missing $tool; run through scripts/dev-shell.sh"
done

native_compatibility_lock_has_scoped_host_cellars() {
  local input_path="$1"

  jq -e \
    --arg retired_identity "linuxbrew" \
    --arg native_cellar "$NATIVE_HOST_CELLAR" '
      def is_allowed_cellar_path($path):
        ($path | length) == 4 and
        $path[0] == "formulae" and
        ($path[1] | type) == "string" and
        ($path[1] | test("^[a-z0-9][a-z0-9+@._-]{0,254}$")) and
        ($path[2] == "public" or $path[2] == "internal") and
        $path[3] == "bottle_cellar";

      type == "object" and
      ([.. | objects | keys[] |
        select(ascii_downcase | contains($retired_identity))] | length == 0) and
      ([paths(scalars) as $path | getpath($path) as $value |
        select(($value | type) == "string") |
        select($value | ascii_downcase | contains($retired_identity)) |
        select((is_allowed_cellar_path($path) and
          $value == $native_cellar) | not)] | length == 0)
    ' "$input_path" >/dev/null 2>&1
}

native_compatibility_lock_may_exempt_prefix() {
  local retired_prefix="$1"
  local lock_validated="$2"

  [ "$retired_prefix" = "$NATIVE_HOST_PREFIX" ] &&
    [ "$lock_validated" -eq 1 ]
}

assert_native_compatibility_lock_accepts() {
  local description="$1"
  local fixture="$2"

  printf '%s\n' "$fixture" |
    native_compatibility_lock_has_scoped_host_cellars - ||
    fail "native compatibility lock rejected $description"
}

assert_native_compatibility_lock_rejects() {
  local description="$1"
  local fixture="$2"

  if printf '%s\n' "$fixture" |
    native_compatibility_lock_has_scoped_host_cellars -; then
    fail "native compatibility lock accepted $description"
  fi
}

# WHY: the native compatibility lock describes official Linux host-tool
# bottles, so its Cellar is intentionally not a Kandelo guest path. Exercise
# the structural exception here: a line-based exemption could also hide a
# guest path in another field, especially when generated JSON is reformatted.
assert_native_compatibility_lock_accepts \
  "public and internal host Cellars" \
  '{"formulae":{"acl":{"public":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar"},"internal":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar"}}}}'
assert_native_compatibility_lock_rejects \
  "a host Cellar under an unapproved feed" \
  '{"formulae":{"acl":{"experimental":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar"}}}}'
assert_native_compatibility_lock_rejects \
  "a host Cellar under the wrong key" \
  '{"formulae":{"acl":{"public":{"prefix":"/home/linuxbrew/.linuxbrew/Cellar"}}}}'
assert_native_compatibility_lock_rejects \
  "an embedded host Cellar value" \
  '{"formulae":{"acl":{"public":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar/acl"}}}}'
assert_native_compatibility_lock_rejects \
  "a host Cellar in an array" \
  '{"formulae":{"acl":{"public":{"bottle_cellar":["/home/linuxbrew/.linuxbrew/Cellar"]}}}}'
assert_native_compatibility_lock_rejects \
  "a second retired path beside a valid host Cellar" \
  '{"formulae":{"acl":{"public":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar","note":"/home/linuxbrew/.linuxbrew"}}}}'
assert_native_compatibility_lock_rejects \
  "a retired identity in an object key" \
  '{"formulae":{"acl":{"public":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar","linuxbrew_note":"host"}}}}'
assert_native_compatibility_lock_rejects \
  "an escaped retired path outside the host Cellar field" \
  '{"formulae":{"acl":{"public":{"note":"\u002fhome\u002flinuxbrew\u002f.linuxbrew"}}}}'
assert_native_compatibility_lock_rejects \
  "a host Cellar under an invalid Formula key" \
  '{"formulae":{"Bad/Formula":{"public":{"bottle_cellar":"/home/linuxbrew/.linuxbrew/Cellar"}}}}'
native_compatibility_lock_may_exempt_prefix "$NATIVE_HOST_PREFIX" 1 ||
  fail "native compatibility lock rejected its exact host prefix"
if native_compatibility_lock_may_exempt_prefix \
  "/home/futurebrew/.futurebrew" 1; then
  fail "native compatibility lock accepted a future retired prefix"
fi
if native_compatibility_lock_may_exempt_prefix "$NATIVE_HOST_PREFIX" 0; then
  fail "unvalidated native compatibility lock received an exemption"
fi

native_compatibility_lock_validated=0
if [ -L "$NATIVE_COMPATIBILITY_LOCK" ]; then
  fail "native compatibility lock must not be a symlink"
elif [ -e "$NATIVE_COMPATIBILITY_LOCK" ]; then
  [ -f "$NATIVE_COMPATIBILITY_LOCK" ] ||
    fail "native compatibility lock must be a regular file"
  native_compatibility_lock_has_scoped_host_cellars \
    "$NATIVE_COMPATIBILITY_LOCK" ||
    fail "native compatibility lock contains an unscoped retired host path"
  native_compatibility_lock_validated=1
fi

jq -e '
  type == "object" and
  (keys | sort) == [
    "cellar",
    "kind",
    "prefix",
    "repository",
    "retired_prefixes",
    "schema",
    "stable_entrypoint"
  ] and
  .schema == 1 and
  .kind == "kandelo-homebrew-guest-layout" and
  .prefix == "/opt/kandelo/homebrew" and
  .cellar == (.prefix + "/Cellar") and
  .repository == .prefix and
  .stable_entrypoint == "/usr/bin/brew" and
  (.retired_prefixes | type == "array" and length > 0) and
  ([.retired_prefixes[] |
    type == "string" and
    startswith("/") and
    . != "/" and
    endswith("/") == false
  ] | all) and
  (.retired_prefixes | unique | length) == (.retired_prefixes | length) and
  .prefix as $prefix |
  (.retired_prefixes | index($prefix) == null)
' "$CONTRACT" >/dev/null ||
  fail "guest layout contract is invalid"

# WHY: native Linux CI must retain the host prefix used by official host-tool
# bottles, while Kandelo guest code must never acquire that OS identity again.
# Check tracked and untracked source, then allow only narrowly described native,
# documentation, and rejection-test occurrences. Whole-file exclusions would
# let a mixed native/guest workflow accidentally reintroduce the old layout.
guest_source_pathspecs=(
  .
  ':(exclude)docs/plans/**'
  ':(exclude)scripts/test-homebrew-guest-layout.sh'
)
append_declared_homebrew_source_exclusion
mapfile -t retired_prefixes < <(jq -er '.retired_prefixes[]' "$CONTRACT")
for retired_prefix in "${retired_prefixes[@]}"; do
  retired_identity="$(basename "$(dirname "$retired_prefix")")"
  while IFS=: read -r source_path line_number source_line; do
    [ -n "$source_path" ] || continue
    relative_path="${source_path#"$REPO_ROOT"/}"
    case "$relative_path|$source_line" in
      homebrew/kandelo-guest-layout.json\|*) ;;
      homebrew/homebrew-native-compatibility-lock.json\|*)
        # WHY: this branch is safe only after jq has accounted for every
        # decoded Linuxbrew identity in the complete JSON document above.
        # Future retired prefixes must not inherit this host-only exception.
        native_compatibility_lock_may_exempt_prefix \
          "$retired_prefix" "$native_compatibility_lock_validated" ||
          fail "native compatibility lock cannot exempt $retired_prefix"
        ;;
      host/test/homebrew-guest-layout.test.ts\|*"retired_prefixes: [\"$retired_prefix\"]"*) ;;
      scripts/test-homebrew-inspect-bottle.sh\|*"$retired_prefix"*) ;;
      scripts/test-homebrew-prefix-campaign.py\|*"RETIRED_PREFIX = \"$retired_prefix\""*) ;;
      scripts/test-homebrew-prefix-campaign-executor.py\|*"[\"$retired_prefix\"]"*) ;;
      scripts/test-homebrew-prefix-campaign-publisher.py\|*"\"$retired_prefix/Cellar\""*) ;;
      scripts/test-homebrew-formula-runtime-closure.sh\|*"$retired_prefix/Cellar"*) ;;
      # WHY: this one fixture models LLVM's authenticated native host root;
      # guest source and every adjacent native path remain rejected.
      scripts/test-homebrew-tap-recipe-runner.py\|*"destination = Path(\"$retired_prefix/etc/clang\")") ;;
      scripts/homebrew-guest-layout.sh\|*"index(\"$retired_prefix\")"*) ;;
      scripts/homebrew-formula-runtime-closure.rb\|*"\"retired_prefixes\" => [\"$retired_prefix\"]"*) ;;
      scripts/homebrew-dependency-provenance.py\|*"$retired_prefix"*) ;;
      scripts/homebrew-inspect-bottle.py\|*"$retired_prefix"*) ;;
      tools/xtask/src/homebrew_guest_layout.rs\|*"const RETIRED_PREFIX: &str = \"$retired_prefix\""*) ;;
      docs/homebrew-publishing.md\|*"guest paths, not Linuxbrew paths"*) ;;
      docs/homebrew-publishing.md\|*"must not create a \`linuxbrew\` user"*) ;;
      docs/homebrew-publishing.md\|*"install below \`/home/linuxbrew\`"*) ;;
      docs/homebrew-publishing.md\|*"\`$retired_prefix\` strings stored in official host-tool bottles"*) ;;
      docs/homebrew-publishing.md\|*"These Linuxbrew bottles provide CI executables"*) ;;
      .github/workflows/reusable-homebrew-bottle-publish.yml\|*"# preinstalled Linuxbrew tree"*) ;;
      .github/workflows/reusable-homebrew-bottle-publish.yml\|*"# depending on the runner's unrelated native Linuxbrew installation"*) ;;
      scripts/test-homebrew-publisher-real-lifecycle.sh\|*"for candidate in /opt/homebrew $retired_prefix/Homebrew"*) ;;
      scripts/test-homebrew-native-ca-lifecycle.sh\|*"same byte length as $retired_prefix"*) ;;
      scripts/homebrew-native-bounded-environment.sh\|*"fixed Linuxbrew prefix"*) ;;
      scripts/test-homebrew-patched-launcher.sh\|*"fixed-prefix Linuxbrew bottle path lengths"*) ;;
      scripts/homebrew-patched-launcher.sh\|*"matches Linuxbrew's bottle"*) ;;
      scripts/homebrew-patched-launcher.sh\|*"bottle_prefix=$retired_prefix"*) ;;
      scripts/homebrew-patched-launcher.sh\|*"exact Linuxbrew relocation path"*) ;;
      scripts/homebrew-patched-launcher.sh\|*"printf '%s' $retired_prefix"*) ;;
      scripts/homebrew-patched-launcher.sh\|*"fixed-prefix Linuxbrew bottle path lengths"*) ;;
      scripts/check-homebrew-publish-workflow-trust.rb\|*"exact Linuxbrew relocation path"*) ;;
      scripts/check-homebrew-publish-workflow-trust.rb\|*"'$retired_prefix/Cellar'"*) ;;
      scripts/check-homebrew-publish-workflow-trust.rb\|*"fixed-prefix Linuxbrew bottle path lengths"*) ;;
      scripts/check-homebrew-publish-workflow-trust.rb\|*'line.include?("linuxbrew")'*) ;;
      *)
        printf '%s:%s:%s\n' \
          "$relative_path" "$line_number" "$source_line" >&2
        fail "guest-owned source still names retired identity $retired_identity"
        ;;
    esac
  done < <(
    git -C "$REPO_ROOT" grep \
      --no-index \
      --exclude-standard \
      -niF \
      -- "$retired_identity" -- "${guest_source_pathspecs[@]}" || true
  )
done

echo "test-homebrew-guest-layout: ok"
