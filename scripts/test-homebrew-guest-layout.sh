#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
CONTRACT="$REPO_ROOT/homebrew/kandelo-guest-layout.json"

fail() {
  echo "test-homebrew-guest-layout: $*" >&2
  exit 1
}

for tool in git jq; do
  command -v "$tool" >/dev/null 2>&1 ||
    fail "missing $tool; run through scripts/dev-shell.sh"
done

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
mapfile -t retired_prefixes < <(jq -er '.retired_prefixes[]' "$CONTRACT")
for retired_prefix in "${retired_prefixes[@]}"; do
  retired_identity="$(basename "$(dirname "$retired_prefix")")"
  while IFS=: read -r source_path line_number source_line; do
    [ -n "$source_path" ] || continue
    relative_path="${source_path#"$REPO_ROOT"/}"
    case "$relative_path|$source_line" in
      homebrew/kandelo-guest-layout.json\|*) ;;
      host/test/homebrew-guest-layout.test.ts\|*"retired_prefixes: [\"$retired_prefix\"]"*) ;;
      scripts/test-homebrew-inspect-bottle.sh\|*"$retired_prefix"*) ;;
      docs/homebrew-publishing.md\|*"guest paths, not Linuxbrew paths"*) ;;
      docs/homebrew-publishing.md\|*"must not create a \`linuxbrew\` user"*) ;;
      docs/homebrew-publishing.md\|*"install below \`/home/linuxbrew\`"*) ;;
      docs/homebrew-publishing.md\|*"\`$retired_prefix\` strings stored in official host-tool bottles"*) ;;
      docs/homebrew-publishing.md\|*"These Linuxbrew bottles provide CI executables"*) ;;
      .github/workflows/reusable-homebrew-bottle-publish.yml\|*"# preinstalled Linuxbrew tree"*) ;;
      .github/workflows/reusable-homebrew-bottle-publish.yml\|*"# depending on the runner's unrelated native Linuxbrew installation"*) ;;
      scripts/test-homebrew-publisher-real-lifecycle.sh\|*"for candidate in /opt/homebrew $retired_prefix/Homebrew /usr/local/Homebrew"*) ;;
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
      -- "$retired_identity" -- \
      . \
      ':(exclude)docs/plans/**' \
      ':(exclude)scripts/test-homebrew-guest-layout.sh' || true
  )
done

echo "test-homebrew-guest-layout: ok"
