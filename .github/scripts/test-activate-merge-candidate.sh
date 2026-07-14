#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTIVATE="$SCRIPT_DIR/activate-merge-candidate.sh"
MARK_READY="$SCRIPT_DIR/mark-merge-candidate-ready.sh"
VERIFY="$SCRIPT_DIR/verify-merge-candidate.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

REMOTE="$TMP_ROOT/remote.git"
SOURCE="$TMP_ROOT/source"
CHECKOUT="$TMP_ROOT/checkout"
git init --quiet --bare "$REMOTE"
git init --quiet "$SOURCE"
git -C "$SOURCE" config user.name test
git -C "$SOURCE" config user.email test@example.invalid

printf 'base\n' > "$SOURCE/base.txt"
git -C "$SOURCE" add base.txt
git -C "$SOURCE" commit --quiet -m base
BASE_SHA=$(git -C "$SOURCE" rev-parse HEAD)
git -C "$SOURCE" switch --quiet -c feature
printf 'candidate\n' > "$SOURCE/candidate.txt"
git -C "$SOURCE" add candidate.txt
git -C "$SOURCE" commit --quiet -m candidate
HEAD_SHA=$(git -C "$SOURCE" rev-parse HEAD)
TREE_SHA=$(git -C "$SOURCE" rev-parse "$HEAD_SHA^{tree}")
SYNTHETIC_SHA=$(printf 'synthetic\n' | git -C "$SOURCE" commit-tree "$TREE_SHA" -p "$BASE_SHA" -p "$HEAD_SHA")
MERGE_SHA=$(printf 'squash\n' | git -C "$SOURCE" commit-tree "$TREE_SHA" -p "$BASE_SHA")
git -C "$SOURCE" push --quiet "$REMOTE" "$MERGE_SHA:refs/heads/main"
git -C "$SOURCE" push --quiet "$REMOTE" "$HEAD_SHA:refs/pull/1/head"
git clone --quiet --branch main "$REMOTE" "$CHECKOUT"

CANDIDATE_TAG="merge-candidate-abi-v39-pr-1-run-2-attempt-1"
CANONICAL_TAG="binaries-abi-v39"
RELEASES="$TMP_ROOT/releases"
mkdir -p "$RELEASES/$CANDIDATE_TAG" "$RELEASES/$CANONICAL_TAG"

BASE_INDEX="$RELEASES/$CANDIDATE_TAG/base-index.toml"
CANDIDATE_INDEX="$RELEASES/$CANDIDATE_TAG/index.toml"
CURRENT_INDEX="$RELEASES/$CANONICAL_TAG/index.toml"
NEXT_INDEX="$TMP_ROOT/next-index.toml"
ADVANCED_INDEX="$TMP_ROOT/advanced-index.toml"
printf 'base index\n' > "$BASE_INDEX"
printf 'candidate index\n' > "$CANDIDATE_INDEX"
printf 'current index\n' > "$CURRENT_INDEX"
cp "$CURRENT_INDEX" "$TMP_ROOT/current-index.good"
printf 'next complete index\n' > "$NEXT_INDEX"
printf 'next complete index\nunrelated package\n' > "$ADVANCED_INDEX"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

BASE_INDEX_SHA=$(sha256_file "$BASE_INDEX")
CANDIDATE_INDEX_SHA=$(sha256_file "$CANDIDATE_INDEX")
CANDIDATE_ASSET="$RELEASES/$CANDIDATE_TAG/foo.tar.zst"
printf 'candidate archive\n' > "$CANDIDATE_ASSET"
CANDIDATE_ASSET_SHA=$(sha256_file "$CANDIDATE_ASSET")
cp "$CANDIDATE_ASSET" "$TMP_ROOT/foo.tar.zst.good"
CANONICAL_RETAINED="$RELEASES/$CANONICAL_TAG/retained.tar.zst"
printf 'retained canonical archive\n' > "$CANONICAL_RETAINED"
CANONICAL_RETAINED_SHA=$(sha256_file "$CANONICAL_RETAINED")
cp "$CANONICAL_RETAINED" "$TMP_ROOT/retained.tar.zst.good"

jq -n \
  --arg base_sha "$BASE_SHA" \
  --arg head_sha "$HEAD_SHA" \
  --arg synthetic_sha "$SYNTHETIC_SHA" \
  --arg tree_sha "$TREE_SHA" \
  --arg base_index_sha "$BASE_INDEX_SHA" \
  --arg candidate_tag "$CANDIDATE_TAG" \
  '{
    schema_version: 1,
    repository: "example/repo",
    pr_number: 1,
    base_ref: "main",
    base_sha: $base_sha,
    head_sha: $head_sha,
    synthetic_merge_sha: $synthetic_sha,
    synthetic_tree_sha: $tree_sha,
    merge_method: "squash",
    pr_commit_count: 1,
    abi_version: 39,
    candidate_tag: $candidate_tag,
    canonical_tag: "binaries-abi-v39",
    canonical_base_state: "present",
    base_index_sha256: $base_index_sha,
    run_id: "2",
    run_attempt: "1"
  }' > "$RELEASES/$CANDIDATE_TAG/candidate.json"
PR_JSON="$TMP_ROOT/pr.json"
jq -n \
  --arg head "$HEAD_SHA" \
  --arg merge "$MERGE_SHA" \
  '{state: "MERGED", headRefOid: $head, baseRefName: "main", mergeCommit: {oid: $merge}, mergedAt: "2026-07-14T00:00:00Z"}' \
  > "$PR_JSON"

ASSET_PLAN="$TMP_ROOT/asset-plan.json"
jq -n \
  --arg candidate_sha "$CANDIDATE_ASSET_SHA" \
  --arg canonical_sha "$CANONICAL_RETAINED_SHA" \
  '[
    {name: "foo.tar.zst", sha256: $candidate_sha, source: "candidate"},
    {name: "retained.tar.zst", sha256: $canonical_sha, source: "canonical"}
  ]' > "$ASSET_PLAN"

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"

cat > "$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

command_name="${1:-}"
shift || true
case "$command_name" in
  api)
    method=GET
    include=false
    endpoint=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --include) include=true; shift ;;
        --method|-X) method="$2"; shift 2 ;;
        -f|-H) shift 2 ;;
        /repos/*) endpoint="$1"; shift ;;
        *) shift ;;
      esac
    done
    [ -n "$endpoint" ] || exit 99
    if [[ "$endpoint" == */statuses/* ]] && [ "$method" = POST ]; then
      printf '%s\n' "$endpoint" >> "$GH_STUB_STATUS_LOG"
      printf '{}\n'
      exit 0
    fi
    if [[ "$endpoint" == */releases/assets/* ]]; then
      asset_id="${endpoint##*/}"
      tag="${asset_id%%__*}"
      name="${asset_id#*__}"
      cat "$GH_STUB_RELEASES/$tag/$name"
      exit 0
    fi
    tag="${endpoint##*/}"
    release_dir="$GH_STUB_RELEASES/$tag"
    if [ ! -d "$release_dir" ]; then
      [ "$include" = false ] || printf 'HTTP/2.0 404 Not Found\n\n{}\n'
      exit 1
    fi
    [ "$include" = false ] || printf 'HTTP/2.0 200 OK\n\n'
    printf '{"id":7,"tag_name":"%s","body":"managed","assets":[' "$tag"
    separator=""
    for path in "$release_dir"/*; do
      [ -f "$path" ] || continue
      name=$(basename "$path")
      size=$(wc -c < "$path" | tr -d '[:space:]')
      sha=$(sha256_file "$path")
      printf '%s' "$separator"
      jq -cn \
        --arg name "$name" \
        --arg id "${tag}__${name}" \
        --argjson size "$size" \
        --arg digest "sha256:$sha" \
        '{name: $name, id: $id, size: $size, digest: $digest}'
      separator=,
    done
    printf ']}\n'
    ;;
  pr)
    [ "${1:-}" = view ] || exit 99
    cat "$GH_STUB_PR_JSON"
    ;;
  release)
    sub="${1:-}"
    shift || true
    case "$sub" in
      view)
        tag="${1:?tag required}"
        [ -d "$GH_STUB_RELEASES/$tag" ] || exit 1
        if [[ " $* " == *" --json "* ]]; then
          for path in "$GH_STUB_RELEASES/$tag"/*; do
            [ -f "$path" ] || continue
            basename "$path"
          done
        fi
        ;;
      create)
        tag="${1:?tag required}"
        mkdir -p "$GH_STUB_RELEASES/$tag"
        ;;
      download)
        tag="${1:?tag required}"
        shift
        patterns=()
        dir=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --pattern) patterns+=("$2"); shift 2 ;;
            --dir) dir="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        for pattern in "${patterns[@]}"; do
          cp "$GH_STUB_RELEASES/$tag/$pattern" "$dir/$pattern"
        done
        ;;
      upload)
        tag="${1:?tag required}"
        shift
        mkdir -p "$GH_STUB_RELEASES/$tag"
        for arg in "$@"; do
          if [ -f "$arg" ]; then
            name=$(basename "$arg")
            printf '%s/%s\n' "$tag" "$name" >> "$GH_STUB_UPLOAD_LOG"
            cp "$arg" "$GH_STUB_RELEASES/$tag/$name"
          fi
        done
        ;;
      *) exit 99 ;;
    esac
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$STUB_BIN/gh"

cat > "$STUB_BIN/rustc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -vV ]; then
  printf 'host: test-host\n'
else
  exit 99
fi
EOF
chmod +x "$STUB_BIN/rustc"

cat > "$STUB_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
current=""
output=""
plan=""
rejection_reason_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --current-index) current="$2"; shift 2 ;;
    --output-index) output="$2"; shift 2 ;;
    --asset-plan) plan="$2"; shift 2 ;;
    --rejection-reason-file) rejection_reason_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "${CARGO_STUB_REJECT_REASON:-}" ]; then
  printf '%s\n' "$CARGO_STUB_REJECT_REASON" > "$rejection_reason_file"
  exit 1
fi
if [ "${CARGO_STUB_NOOP:-0}" = 1 ]; then
  cp "$current" "$output"
  printf '[]\n' > "$plan"
else
  cp "$CARGO_STUB_NEXT_INDEX" "$output"
  cp "$CARGO_STUB_ASSET_PLAN" "$plan"
fi
EOF
chmod +x "$STUB_BIN/cargo"

LOCK_LOG="$TMP_ROOT/locks.log"
STATE_LOCK_STUB="$TMP_ROOT/state-lock.sh"
cat > "$STATE_LOCK_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "${1:-}" "${2:-}" >> "$STATE_LOCK_STUB_LOG"
EOF
chmod +x "$STATE_LOCK_STUB"

STATUS_STUB="$TMP_ROOT/latest-status.sh"
cat > "$STATUS_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s/%s/releases/tag/%s\n' \
  "${GITHUB_SERVER_URL:-https://github.com}" "$GITHUB_REPOSITORY" "$STATUS_STUB_CANDIDATE_TAG"
EOF
chmod +x "$STATUS_STUB"

INDEX_STATE_STUB="$TMP_ROOT/release-index-state.sh"
cat > "$INDEX_STATE_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_name="${1:-}"
shift || true
case "$command_name" in
  sentinel) printf '<!-- kandelo-index-state-v1:empty -->\n' ;;
  read)
    output=""; head=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --output) output="$2"; shift 2 ;; --head-file) head="$2"; shift 2 ;; *) shift ;; esac
    done
    cp "$INDEX_STATE_CURRENT" "$output"
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$output" | awk '{print $1}' > "$head"
    else shasum -a 256 "$output" | awk '{print $1}' > "$head"; fi
    ;;
  publish)
    index=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --index-path) index="$2"; shift 2 ;; *) shift ;; esac
    done
    cp "$index" "$INDEX_STATE_CURRENT"
    printf '%s/index.toml\n' "$INDEX_STATE_TAG" >> "$INDEX_STATE_LOG"
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$INDEX_STATE_STUB"

UPLOAD_LOG="$TMP_ROOT/uploads.log"
STATUS_LOG="$TMP_ROOT/status.log"
touch "$UPLOAD_LOG" "$LOCK_LOG" "$STATUS_LOG"

seal_candidate() {
  GH_STUB_RELEASES="$RELEASES" \
  GH_STUB_UPLOAD_LOG="$UPLOAD_LOG" \
  GH_STUB_STATUS_LOG="$STATUS_LOG" \
  STATE_LOCK_STUB_LOG="$LOCK_LOG" \
  GITHUB_REPOSITORY=example/repo \
  GITHUB_RUN_ID=2 \
  STATE_LOCK_SCRIPT="$STATE_LOCK_STUB" \
  PATH="$STUB_BIN:$PATH" \
  "$MARK_READY" \
    --candidate-tag "$CANDIDATE_TAG" \
    --base-sha "$BASE_SHA" \
    --head-sha "$HEAD_SHA" \
    --synthetic-tree-sha "$TREE_SHA" \
    --run-id 2 \
    --run-attempt 1
}

seal_candidate >/dev/null
[ -f "$RELEASES/$CANDIDATE_TAG/ready.json" ]
[ "$(jq -r .candidate_index_sha256 "$RELEASES/$CANDIDATE_TAG/ready.json")" = "$CANDIDATE_INDEX_SHA" ]
ready_sha=$(sha256_file "$RELEASES/$CANDIDATE_TAG/ready.json")
uploads_after_seal=$(wc -l < "$UPLOAD_LOG" | tr -d '[:space:]')
seal_candidate >/dev/null
[ "$ready_sha" = "$(sha256_file "$RELEASES/$CANDIDATE_TAG/ready.json")" ]
[ "$uploads_after_seal" = "$(wc -l < "$UPLOAD_LOG" | tr -d '[:space:]')" ]

run_activation() {
  (cd "$CHECKOUT" && \
    GH_STUB_RELEASES="$RELEASES" \
    GH_STUB_PR_JSON="$PR_JSON" \
    GH_STUB_UPLOAD_LOG="$UPLOAD_LOG" \
    GH_STUB_STATUS_LOG="$STATUS_LOG" \
    STATE_LOCK_STUB_LOG="$LOCK_LOG" \
    CARGO_STUB_NEXT_INDEX="$NEXT_INDEX" \
    CARGO_STUB_ASSET_PLAN="$ASSET_PLAN" \
    CARGO_STUB_NOOP="${CARGO_STUB_NOOP:-0}" \
    CARGO_STUB_REJECT_REASON="${CARGO_STUB_REJECT_REASON:-}" \
    STATUS_STUB_CANDIDATE_TAG="${STATUS_STUB_CANDIDATE_TAG:-$CANDIDATE_TAG}" \
    INDEX_STATE_CURRENT="$CURRENT_INDEX" \
    INDEX_STATE_LOG="$UPLOAD_LOG" \
    INDEX_STATE_TAG="$CANONICAL_TAG" \
    GITHUB_REPOSITORY=example/repo \
    GITHUB_RUN_ID=3 \
    STATE_LOCK_SCRIPT="$STATE_LOCK_STUB" \
    STATUS_SCRIPT="$STATUS_STUB" \
    RELEASE_INDEX_STATE_SCRIPT="$INDEX_STATE_STUB" \
    VERIFY_SCRIPT="$VERIFY" \
    PATH="$STUB_BIN:$PATH" \
    "$ACTIVATE" --candidate-tag "$CANDIDATE_TAG" --pr-number 1)
}

# Candidate identity is validated before any metadata-derived ref is fetched.
# A repository mismatch records a terminal disposition instead of retrying.
cp "$RELEASES/$CANDIDATE_TAG/candidate.json" "$TMP_ROOT/candidate.json.good"
cp "$RELEASES/$CANDIDATE_TAG/ready.json" "$TMP_ROOT/ready.json.good"
jq '.repository = "other/repo"' "$TMP_ROOT/candidate.json.good" \
  > "$RELEASES/$CANDIDATE_TAG/candidate.json"
jq '.repository = "other/repo"' "$TMP_ROOT/ready.json.good" \
  > "$RELEASES/$CANDIDATE_TAG/ready.json"
if run_activation >"$TMP_ROOT/identity-rejected.out" 2>"$TMP_ROOT/identity-rejected.err"; then
  echo "candidate repository mismatch unexpectedly activated" >&2
  exit 1
fi
[ "$(jq -r .rejection_reason "$RELEASES/$CANDIDATE_TAG/rejected.json")" = repository-mismatch ]
mv "$TMP_ROOT/candidate.json.good" "$RELEASES/$CANDIDATE_TAG/candidate.json"
mv "$TMP_ROOT/ready.json.good" "$RELEASES/$CANDIDATE_TAG/ready.json"
rm "$RELEASES/$CANDIDATE_TAG/rejected.json"

# Candidate-intrinsic ledger validation and same-package drift are stable
# failures. Each records one terminal disposition and a retry stops before
# rebuilding or rewriting the evidence.
if CARGO_STUB_REJECT_REASON=candidate-index-invalid \
    run_activation >"$TMP_ROOT/candidate-invalid.out" 2>"$TMP_ROOT/candidate-invalid.err"
then
  echo "candidate-intrinsic ledger failure unexpectedly activated" >&2
  exit 1
fi
[ "$(jq -r .disposition "$RELEASES/$CANDIDATE_TAG/rejected.json")" = rejected ]
[ "$(jq -r .rejection_reason "$RELEASES/$CANDIDATE_TAG/rejected.json")" = candidate-index-invalid ]
rejected_sha=$(sha256_file "$RELEASES/$CANDIDATE_TAG/rejected.json")
if run_activation >"$TMP_ROOT/rejected-retry.out" 2>"$TMP_ROOT/rejected-retry.err"; then
  echo "terminally rejected candidate was retried" >&2
  exit 1
fi
grep -q 'already has a terminal rejection receipt' "$TMP_ROOT/rejected-retry.err"
[ "$rejected_sha" = "$(sha256_file "$RELEASES/$CANDIDATE_TAG/rejected.json")" ]
rm "$RELEASES/$CANDIDATE_TAG/rejected.json"

if CARGO_STUB_REJECT_REASON=same-package-drift \
    run_activation >"$TMP_ROOT/drift-rejected.out" 2>"$TMP_ROOT/drift-rejected.err"
then
  echo "deterministic package drift unexpectedly activated" >&2
  exit 1
fi
[ "$(jq -r .rejection_reason "$RELEASES/$CANDIDATE_TAG/rejected.json")" = same-package-drift ]

# Continue with the independent successful-activation contract after removing
# the fixture rejection receipt.
rm "$RELEASES/$CANDIDATE_TAG/rejected.json"

# Discovery can race a duplicate Prepare run. Activation rechecks authority
# while holding the PR lock and stops before canonical planning or mutation.
if STATUS_STUB_CANDIDATE_TAG=merge-candidate-abi-v39-pr-1-run-99-attempt-1 \
    run_activation >"$TMP_ROOT/authority-race.out" 2>"$TMP_ROOT/authority-race.err"
then
  echo "activation accepted a superseded candidate" >&2
  exit 1
fi
grep -q 'no longer the latest merge-gate authority' "$TMP_ROOT/authority-race.err"
cmp "$TMP_ROOT/current-index.good" "$CURRENT_INDEX"
[ ! -f "$RELEASES/$CANONICAL_TAG/foo.tar.zst" ]

# Sealed candidate bytes that disagree with the tested ledger are terminal,
# not a transient API or current-canonical failure.
printf 'tampered candidate archive\n' > "$CANDIDATE_ASSET"
if run_activation >"$TMP_ROOT/candidate-asset.out" 2>"$TMP_ROOT/candidate-asset.err"; then
  echo "activation accepted altered candidate archive bytes" >&2
  exit 1
fi
[ "$(jq -r .rejection_reason "$RELEASES/$CANDIDATE_TAG/rejected.json")" = candidate-asset-invalid ]
cp "$TMP_ROOT/foo.tar.zst.good" "$CANDIDATE_ASSET"
rm "$RELEASES/$CANDIDATE_TAG/rejected.json"

# A changed entry that retains a canonical-owned archive is not visible until
# that archive's bytes match the ledger digest.
printf 'tampered canonical archive\n' > "$CANONICAL_RETAINED"
if run_activation >"$TMP_ROOT/canonical-mismatch.out" 2>"$TMP_ROOT/canonical-mismatch.err"; then
  echo "activation accepted an altered retained canonical archive" >&2
  exit 1
fi
grep -q 'does not match expected sha256' "$TMP_ROOT/canonical-mismatch.err"
cmp "$TMP_ROOT/current-index.good" "$CURRENT_INDEX"
[ ! -f "$RELEASES/$CANDIDATE_TAG/activated.json" ]
cp "$TMP_ROOT/retained.tar.zst.good" "$CANONICAL_RETAINED"

run_activation >/dev/null
cmp "$CANDIDATE_ASSET" "$RELEASES/$CANONICAL_TAG/foo.tar.zst"
cmp "$NEXT_INDEX" "$RELEASES/$CANONICAL_TAG/index.toml"
[ -f "$RELEASES/$CANDIDATE_TAG/activated.json" ]
grep -qx "acquire $CANDIDATE_TAG" "$LOCK_LOG"
grep -qx "acquire $CANONICAL_TAG" "$LOCK_LOG"
if grep -q "$CANONICAL_TAG/retained.tar.zst" "$UPLOAD_LOG"; then
  echo "retained canonical archive was uploaded instead of verified in place" >&2
  exit 1
fi
asset_upload_line=$(grep -n "$CANONICAL_TAG/foo.tar.zst" "$UPLOAD_LOG" | cut -d: -f1)
index_upload_line=$(grep -n "$CANONICAL_TAG/index.toml" "$UPLOAD_LOG" | cut -d: -f1)
if [ "$asset_upload_line" -ge "$index_upload_line" ]; then
  echo "candidate archive was not uploaded before the canonical index" >&2
  exit 1
fi

# A receipt with the same PR and merge but a different sealed candidate is not
# an idempotent retry. Reject it before treating the candidate as activated.
cp "$RELEASES/$CANDIDATE_TAG/activated.json" "$TMP_ROOT/activated.json.good"
jq '.candidate_index_sha256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
  "$TMP_ROOT/activated.json.good" > "$RELEASES/$CANDIDATE_TAG/activated.json"
if CARGO_STUB_NOOP=1 run_activation >"$TMP_ROOT/tampered-receipt.out" 2>"$TMP_ROOT/tampered-receipt.err"; then
  echo "activation accepted a receipt for a different sealed candidate" >&2
  exit 1
fi
grep -q 'existing activation marker conflicts' "$TMP_ROOT/tampered-receipt.err"
mv "$TMP_ROOT/activated.json.good" "$RELEASES/$CANDIDATE_TAG/activated.json"

# A retry after an unrelated canonical update must preserve both that update
# and the original activation receipt instead of rewriting or conflicting.
cp "$ADVANCED_INDEX" "$RELEASES/$CANONICAL_TAG/index.toml"
receipt_sha=$(sha256_file "$RELEASES/$CANDIDATE_TAG/activated.json")
uploads_before=$(wc -l < "$UPLOAD_LOG" | tr -d '[:space:]')
CARGO_STUB_NOOP=1 run_activation >/dev/null
cmp "$ADVANCED_INDEX" "$RELEASES/$CANONICAL_TAG/index.toml"
[ "$receipt_sha" = "$(sha256_file "$RELEASES/$CANDIDATE_TAG/activated.json")" ]
[ "$uploads_before" = "$(wc -l < "$UPLOAD_LOG" | tr -d '[:space:]')" ]

grep -Fq "/statuses/$HEAD_SHA" "$STATUS_LOG"
authority_line=$(grep -n 'acquire merge-authority-pr-1' "$LOCK_LOG" | tail -1 | cut -d: -f1)
candidate_line=$(grep -n "acquire $CANDIDATE_TAG" "$LOCK_LOG" | tail -1 | cut -d: -f1)
canonical_line=$(grep -n "acquire $CANONICAL_TAG" "$LOCK_LOG" | tail -1 | cut -d: -f1)
[ "$authority_line" -lt "$candidate_line" ] && [ "$candidate_line" -lt "$canonical_line" ]

echo "merge candidate activation tests passed"
