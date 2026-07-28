#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFIER="$REPO_ROOT/scripts/verify-existing-immutable-github-release.sh"
GET_HELPER="$REPO_ROOT/.github/scripts/github-api-get.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# WHY: this verifier runs in the one job that also holds the lifecycle
# publisher token. Keep its command vocabulary incapable of turning
# consume-only mirror evidence into an accidental release or tag mutation.
for forbidden in \
  '--method' \
  '--field' \
  '--raw-field' \
  '--input' \
  '-X ' \
  'gh release' \
  'git push' \
  'curl --request' \
  'curl --data' \
  'curl --upload-file' \
  'curl -X' \
  'curl -d' \
  'curl -T' \
  '/git/refs -f'
do
  if grep -Fq -- "$forbidden" "$VERIFIER" "$GET_HELPER"; then
    echo "test-verify-existing-immutable-github-release: read path contains write-capable command $forbidden" >&2
    exit 1
  fi
done

TARGET="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REPOSITORY="kandelo-dev/homebrew-tap-core"
TAG="homebrew-shell-bottles-sha256-$(printf 'b%.0s' {1..64})"
TITLE="Kandelo Homebrew shell bottle mirror"
BODY="Immutable fixture mirror."
ASSET_ROOT="$TMP_ROOT/assets"
MANIFEST="$TMP_ROOT/manifest.json"
FAKE_BIN="$TMP_ROOT/bin"
REMOTE="$TMP_ROOT/remote"
mkdir -p "$ASSET_ROOT" "$FAKE_BIN" "$REMOTE"
printf 'mirror plan\n' >"$ASSET_ROOT/plan.json"
printf 'bottle payload\n' >"$ASSET_ROOT/layer.bin"
cp "$ASSET_ROOT/plan.json" "$REMOTE/plan.json"
cp "$ASSET_ROOT/layer.bin" "$REMOTE/layer.bin"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

jq -n \
  --arg repository "$REPOSITORY" \
  --arg tag "$TAG" \
  --arg target "$TARGET" \
  --arg title "$TITLE" \
  --arg body "$BODY" \
  --arg plan_sha "$(sha256_file "$ASSET_ROOT/plan.json")" \
  --argjson plan_bytes "$(wc -c <"$ASSET_ROOT/plan.json" | tr -d '[:space:]')" \
  --arg layer_sha "$(sha256_file "$ASSET_ROOT/layer.bin")" \
  --argjson layer_bytes "$(wc -c <"$ASSET_ROOT/layer.bin" | tr -d '[:space:]')" '
  {
    schema: 1,
    repository: $repository,
    tag: $tag,
    target_commitish: $target,
    title: $title,
    body: $body,
    assets: [
      {name: "plan.json", sha256: $plan_sha, bytes: $plan_bytes},
      {name: "layer.bin", sha256: $layer_sha, bytes: $layer_bytes}
    ],
    preferred_asset_names: ["plan.json", "layer.bin"],
    accepted_existing_asset_sets: []
  }
' >"$MANIFEST"

cat >"$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GH_LOG:?}"
if [[ " $* " == *" --method "* ]] ||
   [ "${1:-}" != api ]; then
  echo "fake gh: mutating or non-api command rejected: $*" >&2
  exit 97
fi
for argument in "$@"; do
  case "$argument" in
    --method|--method=*|-X|-X*|--field|--field=*|-f|-f*|\
    --raw-field|--raw-field=*|-F|-F*|--input|--input=*)
      echo "fake gh: implicit write flag rejected: $argument" >&2
      exit 97
      ;;
  esac
done
shift
if [ "${1:-}" = --include ]; then
  shift 3
  endpoint="${1:?}"
  printf 'HTTP/1.1 200 OK\r\n\r\n'
  case "$endpoint" in
    */releases/tags/*)
      jq -n \
        --arg tag "$FAKE_TAG" \
        --arg target "$FAKE_TARGET" \
        --arg title "$FAKE_TITLE" \
        --arg body "$FAKE_BODY" \
        --argjson immutable "${FAKE_IMMUTABLE:-true}" \
        --argjson draft "${FAKE_DRAFT:-false}" '
        {
          id: 71,
          tag_name: $tag,
          target_commitish: $target,
          name: $title,
          body: $body,
          draft: $draft,
          prerelease: false,
          immutable: $immutable
        }
      '
      ;;
    */git/ref/tags/*)
      jq -n \
        --arg tag "$FAKE_TAG" \
        --arg target "${FAKE_TAG_TARGET:-$FAKE_TARGET}" '
        {ref: ("refs/tags/" + $tag), object: {type: "commit", sha: $target}}
      '
      ;;
    *)
      echo "fake gh: unexpected include endpoint $endpoint" >&2
      exit 98
      ;;
  esac
elif [ "${1:-}" = --paginate ] && [ "${2:-}" = --slurp ]; then
  endpoint="${3:?}"
  [[ "$endpoint" == */releases/71/assets?per_page=100 ]] || {
    echo "fake gh: unexpected pagination endpoint $endpoint" >&2
    exit 98
  }
  jq -n \
    --arg plan_sha "$FAKE_PLAN_SHA" \
    --argjson plan_bytes "$FAKE_PLAN_BYTES" \
    --arg layer_sha "$FAKE_LAYER_SHA" \
    --argjson layer_bytes "$FAKE_LAYER_BYTES" \
    --argjson extra "${FAKE_EXTRA_ASSET:-false}" '
    [[
      {
        id: 101, name: "plan.json", state: "uploaded",
        size: $plan_bytes, digest: ("sha256:" + $plan_sha)
      },
      {
        id: 102, name: "layer.bin", state: "uploaded",
        size: $layer_bytes, digest: ("sha256:" + $layer_sha)
      }
    ] + (if $extra then [{
      id: 103, name: "extra.bin", state: "uploaded",
      size: 1, digest: ("sha256:" + ("c" * 64))
    }] else [] end)]
  '
else
  echo "fake gh: unexpected command $*" >&2
  exit 98
fi
SH

cat >"$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --disable|--fail|--location|--silent|--show-error) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$output" ] && [ -n "$url" ]
name="${url##*/}"
cp "${FAKE_REMOTE_ROOT:?}/$name" "$output"
SH
chmod +x "$FAKE_BIN/gh" "$FAKE_BIN/curl"

export FAKE_GH_LOG="$TMP_ROOT/gh.log"
export FAKE_TAG="$TAG"
export FAKE_TARGET="$TARGET"
export FAKE_TITLE="$TITLE"
export FAKE_BODY="$BODY"
FAKE_PLAN_SHA="$(sha256_file "$ASSET_ROOT/plan.json")"
FAKE_PLAN_BYTES="$(wc -c <"$ASSET_ROOT/plan.json" | tr -d '[:space:]')"
FAKE_LAYER_SHA="$(sha256_file "$ASSET_ROOT/layer.bin")"
FAKE_LAYER_BYTES="$(wc -c <"$ASSET_ROOT/layer.bin" | tr -d '[:space:]')"
export FAKE_PLAN_SHA FAKE_PLAN_BYTES FAKE_LAYER_SHA FAKE_LAYER_BYTES
export FAKE_REMOTE_ROOT="$REMOTE"
export GITHUB_REPOSITORY="$REPOSITORY"
export GH_TOKEN="read-only-fixture-token"
export IMMUTABLE_RELEASE_RETRY_DELAY_SECONDS=0

run_verifier() {
  local receipt="$1"
  PATH="$FAKE_BIN:$PATH" bash "$VERIFIER" \
    --manifest "$MANIFEST" \
    --asset-root "$ASSET_ROOT" \
    --receipt "$receipt" \
    --exact-target-commit-sha "$TARGET"
}

RECEIPT="$TMP_ROOT/receipt.json"
run_verifier "$RECEIPT"
jq -e \
  --arg target "$TARGET" \
  --arg repository "$REPOSITORY" \
  --arg tag "$TAG" '
  .schema == 1 and .status == "success" and
  .operation == "verified-existing" and
  .visibility == "public-anonymous-readback" and
  .repository == $repository and .tag == $tag and
  .target_commitish == $target and .release_id == 71 and
  .immutable == true and (.assets | length) == 2
' "$RECEIPT" >/dev/null
if grep -Eq -- '--method|release upload| api (POST|PATCH|PUT|DELETE) ' \
  "$FAKE_GH_LOG"
then
  echo "test-verify-existing-immutable-github-release: verifier attempted a write" >&2
  exit 1
fi

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$TMP_ROOT/failure.out" 2>&1; then
    echo "test-verify-existing-immutable-github-release: accepted $label" >&2
    exit 1
  fi
}

expect_failure "a mismatched admitted authority" \
  env PATH="$FAKE_BIN:$PATH" bash "$VERIFIER" \
    --manifest "$MANIFEST" \
    --asset-root "$ASSET_ROOT" \
    --receipt "$TMP_ROOT/wrong-target.json" \
    --exact-target-commit-sha "dddddddddddddddddddddddddddddddddddddddd"

export FAKE_IMMUTABLE=false
expect_failure "a mutable release" run_verifier "$TMP_ROOT/mutable.json"
unset FAKE_IMMUTABLE

export FAKE_TAG_TARGET="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
expect_failure "a tag at another commit" run_verifier "$TMP_ROOT/wrong-tag.json"
unset FAKE_TAG_TARGET

export FAKE_EXTRA_ASSET=true
expect_failure "an unexpected remote asset" run_verifier "$TMP_ROOT/extra.json"
unset FAKE_EXTRA_ASSET

printf 'changed payload\n' >"$REMOTE/layer.bin"
expect_failure "anonymous bytes that differ" run_verifier "$TMP_ROOT/changed.json"

echo "test-verify-existing-immutable-github-release.sh: ok"
