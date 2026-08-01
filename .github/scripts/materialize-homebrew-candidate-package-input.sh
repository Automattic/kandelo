#!/usr/bin/env bash
# Materialize the complete immutable PR package ledger used by one candidate
# bottle build. This is a read-only operation; it never writes package state.
set -euo pipefail

TAG=""
PR_NUMBER=""
RUN_ID=""
RUN_ATTEMPT=""
PRODUCER_SHA=""
EXPECTED_ABI=""
EXCLUSIONS=""
CONSUMER_ROOT=""
CONSUMER_SHA=""
XTASK=""
OUTPUT_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --pr-number) PR_NUMBER="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --run-attempt) RUN_ATTEMPT="$2"; shift 2 ;;
    --producer-sha) PRODUCER_SHA="$2"; shift 2 ;;
    --expected-abi) EXPECTED_ABI="$2"; shift 2 ;;
    --exclude) EXCLUSIONS="$2"; shift 2 ;;
    --consumer-root) CONSUMER_ROOT="$2"; shift 2 ;;
    --consumer-sha) CONSUMER_SHA="$2"; shift 2 ;;
    --xtask) XTASK="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *)
      echo "materialize-homebrew-candidate-package-input: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

expected_tag="pr-${PR_NUMBER}-staging-run-${RUN_ID}-attempt-${RUN_ATTEMPT}"
if ! [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$PRODUCER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   ! [[ "$EXPECTED_ABI" =~ ^[1-9][0-9]*$ ]] ||
   [ "$TAG" != "$expected_tag" ] ||
   ! [[ "$CONSUMER_SHA" =~ ^[0-9a-f]{40}$ ]] ||
   [ ! -d "$CONSUMER_ROOT" ] || [ -L "$CONSUMER_ROOT" ] ||
   [ ! -x "$XTASK" ] || [ -L "$XTASK" ] ||
   [ -z "$EXCLUSIONS" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ]; then
  echo "materialize-homebrew-candidate-package-input: exact run, source, ABI, tools, exclusions, and output are required" >&2
  exit 2
fi
if [ -e "$OUTPUT_DIR" ] || [ -L "$OUTPUT_DIR" ]; then
  echo "materialize-homebrew-candidate-package-input: output already exists" >&2
  exit 2
fi
if [ "$(git -C "$CONSUMER_ROOT" rev-parse HEAD)" != "$CONSUMER_SHA" ] ||
   [ -n "$(git -C "$CONSUMER_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "materialize-homebrew-candidate-package-input: Kandelo consumer is not the exact clean source" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$PARENT"
TMP_ROOT="$(mktemp -d "$PARENT/.homebrew-candidate-packages.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir "$TMP_ROOT/output"

EXPECTED="$TMP_ROOT/output/expected-ledger.json"
RELEASE="$TMP_ROOT/output/release-evidence.json"
SNAPSHOT="$TMP_ROOT/output/resolver"
BODY="$TMP_ROOT/release-body.txt"

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  "$XTASK" staging-reuse expected \
    --registry "$CONSUMER_ROOT/packages/registry" \
    --expected-abi "$EXPECTED_ABI" \
    --exclude "$EXCLUSIONS" \
    --output "$EXPECTED"

printf 'PR #%s staging build run %s attempt %s' \
  "$PR_NUMBER" "$RUN_ID" "$RUN_ATTEMPT" >"$BODY"

# WHY: package build success is only an ordering signal. Revalidate the
# public release, direct tag, complete ledger, archive manifests, and archive
# bytes before any of them can execute as a bottle-build dependency.
GITHUB_REPOSITORY=Automattic/kandelo \
  bash "$SCRIPT_DIR/package-release-lifecycle.sh" verify-immutable \
    --tag "$TAG" \
    --target-commit "$PRODUCER_SHA" \
    --title "$TAG" \
    --body-file "$BODY" \
    --prerelease true

GITHUB_REPOSITORY=Automattic/kandelo \
  bash "$SCRIPT_DIR/validate-staging-release.sh" \
    --tag "$TAG" \
    --expected-ledger "$EXPECTED" \
    --mode current \
    --materialize \
    --output-dir "$SNAPSHOT" \
    --xtask "$XTASK"

gh api "/repos/Automattic/kandelo/releases/tags/$TAG" |
  jq -eS \
    --arg repository Automattic/kandelo \
    --arg producer "$PRODUCER_SHA" \
    --arg tag "$TAG" \
    --argjson pr "$PR_NUMBER" \
    --argjson run "$RUN_ID" \
    --argjson attempt "$RUN_ATTEMPT" '
      select(
        .tag_name == $tag and
        .target_commitish == $producer and
        .draft == false and .prerelease == true and .immutable == true and
        (.id | type == "number" and . > 0)
      ) |
      {
        schema:1,
        repository:$repository,
        tag:.tag_name,
        release_id:.id,
        target_commit:$producer,
        immutable:true,
        pr_number:$pr,
        run_id:$run,
        attempt:$attempt
      }
    ' >"$RELEASE"

env -u GH_TOKEN -u GITHUB_TOKEN \
  -u HOMEBREW_GITHUB_API_TOKEN \
  -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
  -u HOMEBREW_DOCKER_REGISTRY_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  -u ACTIONS_ID_TOKEN_REQUEST_URL \
  -u ACTIONS_RUNTIME_TOKEN \
  python3 "$AUTHORITY_ROOT/scripts/homebrew-bottle-candidate.py" package-input \
    --expected-ledger "$EXPECTED" \
    --snapshot "$SNAPSHOT/snapshot.json" \
    --release-evidence "$RELEASE" \
    --index "$SNAPSHOT/source-index.toml" \
    --producer-commit "$PRODUCER_SHA" \
    --abi "$EXPECTED_ABI" \
    --out "$TMP_ROOT/output/package-input.json"

# validate-staging-release writes its temporary path into index-url.txt. The
# resolver is moved atomically below, so write the final local URL explicitly.
printf 'file://%s/resolver/archives/index.toml\n' "$OUTPUT_DIR" \
  >"$SNAPSHOT/index-url.txt"
mv "$TMP_ROOT/output" "$OUTPUT_DIR"
rm -rf "$TMP_ROOT"
trap - EXIT
echo "materialize-homebrew-candidate-package-input: froze $TAG at $OUTPUT_DIR"
