#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DELETE_RELEASE="$SCRIPT_DIR/delete-writable-release.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

BIN="$TMP_ROOT/bin"
STATE="$TMP_ROOT/state"
API_LOG="$TMP_ROOT/api.log"
LOCK_LOG="$TMP_ROOT/lock.log"
mkdir -p "$BIN" "$STATE"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[ "${1:-}" = api ] || exit 99
shift
method=GET
include=false
endpoint=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --include) include=true; shift ;;
    -H) shift 2 ;;
    /repos/*) endpoint="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s %s\n' "$method" "$endpoint" >> "$GH_STUB_API_LOG"

reply() {
  local status="$1" text="$2" body="${3:-}"
  [ "$include" = false ] || printf 'HTTP/2.0 %s %s\n\n' "$status" "$text"
  [ -z "$body" ] || printf '%s\n' "$body"
}

case "$method:$endpoint" in
  GET:/repos/example/repo/releases/701)
    if [ -f "$GH_STUB_STATE/release.json" ]; then
      reply 200 OK "$(cat "$GH_STUB_STATE/release.json")"
      exit 0
    fi
    reply 404 'Not Found' '{}'
    exit 1
    ;;
  GET:/repos/example/repo/releases/tags/test-staging)
    # GitHub omits drafts here. Only an explicit public replacement appears.
    if [ -f "$GH_STUB_STATE/replacement.json" ]; then
      reply 200 OK "$(cat "$GH_STUB_STATE/replacement.json")"
      exit 0
    fi
    reply 404 'Not Found' '{}'
    exit 1
    ;;
  DELETE:/repos/example/repo/releases/701)
    case "${GH_STUB_MODE:-normal}" in
      release-fails)
        reply 500 'Server Error' '{}'
        exit 1
        ;;
      release-committed-error)
        rm -f "$GH_STUB_STATE/release.json"
        reply 500 'Server Error' '{}'
        exit 1
        ;;
      release-seals)
        jq '.draft = false | .immutable = true' \
          "$GH_STUB_STATE/release.json" > "$GH_STUB_STATE/sealed.json"
        mv "$GH_STUB_STATE/sealed.json" "$GH_STUB_STATE/release.json"
        reply 422 'Unprocessable Entity' '{}'
        exit 1
        ;;
      *)
        rm -f "$GH_STUB_STATE/release.json"
        reply 204 'No Content'
        exit 0
        ;;
    esac
    ;;
  GET:/repos/example/repo/git/ref/tags/test-staging)
    count=0
    [ ! -f "$GH_STUB_STATE/ref-count" ] ||
      count=$(cat "$GH_STUB_STATE/ref-count")
    count=$((count + 1))
    printf '%s\n' "$count" > "$GH_STUB_STATE/ref-count"
    if [ ! -f "$GH_STUB_STATE/release.json" ]; then
      case "${GH_STUB_MODE:-normal}" in
        tag-appears)
          printf '%040d\n' 2 > "$GH_STUB_STATE/tag"
          ;;
        tag-changes)
          printf '%040d\n' 2 > "$GH_STUB_STATE/tag"
          ;;
      esac
    fi
    if [ -f "$GH_STUB_STATE/tag" ]; then
      sha=$(cat "$GH_STUB_STATE/tag")
      reply 200 OK \
        "{\"ref\":\"refs/tags/test-staging\",\"object\":{\"type\":\"commit\",\"sha\":\"$sha\"}}"
      exit 0
    fi
    reply 404 'Not Found' '{}'
    exit 1
    ;;
  *)
    exit 99
    ;;
esac
EOF
chmod +x "$BIN/gh"

cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "$GH_STUB_API_LOG"
case "${GH_STUB_MODE:-normal}" in
  tag-fails)
    exit 1
    ;;
  tag-concurrent-delete)
    rm -f "$GH_STUB_STATE/tag"
    exit 1
    ;;
esac
expected=""
for arg in "$@"; do
  case "$arg" in
    --force-with-lease=refs/tags/test-staging:*)
      expected="${arg##*:}"
      ;;
  esac
done
[ -n "$expected" ] || exit 99
[ -f "$GH_STUB_STATE/tag" ] || exit 1
[ "$(cat "$GH_STUB_STATE/tag")" = "$expected" ] || exit 1
rm -f "$GH_STUB_STATE/tag"
EOF
chmod +x "$BIN/git"

LOCK_STUB="$TMP_ROOT/state-lock.sh"
cat > "$LOCK_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$1" "${2:-}" >> "$GH_STUB_LOCK_LOG"
if [ "${GH_STUB_MODE:-normal}" = lock-fails ] && [ "$1" = acquire ]; then
  exit 1
fi
EOF
chmod +x "$LOCK_STUB"

reset_state() {
  rm -f "$STATE"/*
  : > "$API_LOG"
  : > "$LOCK_LOG"
}

write_release() {
  local draft="${1:-true}"
  local immutable="${2:-false}"
  jq -n --argjson draft "$draft" --argjson immutable "$immutable" '
    {id: 701, tag_name: "test-staging", prerelease: true,
     draft: $draft, immutable: $immutable}
  ' > "$STATE/release.json"
}

write_tag() {
  printf '%040d\n' "${1:-1}" > "$STATE/tag"
}

run_delete() {
  GH_STUB_STATE="$STATE" \
  GH_STUB_API_LOG="$API_LOG" \
  GH_STUB_LOCK_LOG="$LOCK_LOG" \
  GH_STUB_MODE="${GH_STUB_MODE:-normal}" \
  GITHUB_REPOSITORY=example/repo \
  GITHUB_RUN_ID=123 \
  GH_TOKEN=test-token \
  STATE_LOCK_SCRIPT="$LOCK_STUB" \
  GITHUB_API_RETRY_DELAY_SECONDS=0 \
  RELEASE_DELETE_RETRY_DELAY_SECONDS=0 \
  PATH="$BIN:$PATH" \
    "$DELETE_RELEASE" --release-id 701 --tag test-staging
}

# Exact production regression: bounded discovery found a draft by ID, while
# get-by-tag and the Git-ref endpoint cannot see it. Cleanup still deletes the
# release and treats the absent tag as the completed state.
reset_state
write_release true false
run_delete > "$TMP_ROOT/draft-without-tag.out"
[ ! -e "$STATE/release.json" ]
grep -q 'deleted release test-staging' "$TMP_ROOT/draft-without-tag.out"
grep -q 'tag test-staging is already absent' \
  "$TMP_ROOT/draft-without-tag.out"
grep -Fq 'GET /repos/example/repo/releases/701' "$API_LOG"
if grep -Fq 'GET /repos/example/repo/releases/tags/test-staging' \
    "$API_LOG" && grep -Fq 'GET /repos/example/repo/releases/701' \
      "$API_LOG"; then
  : # The post-delete replacement check may use get-by-tag; discovery may not.
fi
grep -Fxq 'acquire test-staging' "$LOCK_LOG"
grep -Fxq 'release ' "$LOCK_LOG"

# Both draft and grandfathered public mutable releases delete an unchanged
# observed tag through a force-with-lease.
for draft in true false; do
  reset_state
  write_release "$draft" false
  write_tag 1
  run_delete > "$TMP_ROOT/mutable-$draft.out"
  [ ! -e "$STATE/release.json" ] && [ ! -e "$STATE/tag" ]
  grep -q 'deleted tag test-staging' "$TMP_ROOT/mutable-$draft.out"
  grep -Fq -- '--force-with-lease=refs/tags/test-staging:' "$API_LOG"
done

# A lost response after a committed release deletion is idempotent.
reset_state
write_release true false
write_tag 1
GH_STUB_MODE=release-committed-error \
  run_delete > "$TMP_ROOT/committed-error.out"
[ ! -e "$STATE/release.json" ] && [ ! -e "$STATE/tag" ]
grep -q 'release test-staging is already absent' \
  "$TMP_ROOT/committed-error.out"

# Immutable releases, including one sealed during an ambiguous DELETE, are
# retained as evidence and never permit tag deletion.
reset_state
write_release false true
write_tag 1
run_delete > "$TMP_ROOT/immutable.out"
[ -e "$STATE/release.json" ] && [ -e "$STATE/tag" ]
grep -q 'retaining immutable release test-staging' "$TMP_ROOT/immutable.out"
if grep -Fq 'DELETE /repos/example/repo/releases/701' "$API_LOG"; then
  echo 'immutable release reached deletion' >&2
  exit 1
fi

reset_state
write_release true false
write_tag 1
GH_STUB_MODE=release-seals run_delete > "$TMP_ROOT/sealed.out"
[ -e "$STATE/release.json" ] && [ -e "$STATE/tag" ]
grep -q 'retaining newly immutable test-staging' "$TMP_ROOT/sealed.out"
if grep -Fq -- '--force-with-lease=' "$API_LOG"; then
  echo 'newly immutable release permitted tag deletion' >&2
  exit 1
fi

# Missing or contradictory state is not guessed to be writable.
for malformed in \
  '{"id":701,"tag_name":"test-staging","draft":true,"prerelease":true}' \
  '{"id":702,"tag_name":"test-staging","draft":true,"immutable":false,"prerelease":true}' \
  '{"id":701,"tag_name":"wrong","draft":true,"immutable":false,"prerelease":true}' \
  '{"id":701,"tag_name":"test-staging","draft":true,"immutable":true,"prerelease":true}'; do
  reset_state
  printf '%s\n' "$malformed" > "$STATE/release.json"
  if run_delete > "$TMP_ROOT/malformed.out" \
      2> "$TMP_ROOT/malformed.err"; then
    echo 'malformed release state was accepted' >&2
    exit 1
  fi
  grep -q 'response is malformed or mismatched' "$TMP_ROOT/malformed.err"
  if grep -Fq 'DELETE /repos/example/repo/releases/701' "$API_LOG"; then
    echo 'malformed release reached deletion' >&2
    exit 1
  fi
done

# Observable release failures exhaust bounded retries and leave the tag.
reset_state
write_release true false
write_tag 1
if GH_STUB_MODE=release-fails \
    run_delete > "$TMP_ROOT/release-fails.out" \
      2> "$TMP_ROOT/release-fails.err"; then
  echo 'observable release deletion failure was hidden' >&2
  exit 1
fi
[ -e "$STATE/release.json" ] && [ -e "$STATE/tag" ]
[ "$(grep -Fc 'DELETE /repos/example/repo/releases/701' "$API_LOG")" -eq 4 ]

# A newly appearing or changed tag is not owned by this cleanup invocation.
reset_state
write_release true false
if GH_STUB_MODE=tag-appears \
    run_delete > "$TMP_ROOT/tag-appears.out" \
      2> "$TMP_ROOT/tag-appears.err"; then
  echo 'newly appearing tag was deleted' >&2
  exit 1
fi
[ -e "$STATE/tag" ]
grep -q 'refusing replaced tag test-staging' "$TMP_ROOT/tag-appears.err"

reset_state
write_release true false
write_tag 1
if GH_STUB_MODE=tag-changes \
    run_delete > "$TMP_ROOT/tag-changes.out" \
      2> "$TMP_ROOT/tag-changes.err"; then
  echo 'changed tag was deleted' >&2
  exit 1
fi
[ "$(cat "$STATE/tag")" = "$(printf '%040d' 2)" ]
grep -q 'refusing replaced tag test-staging' "$TMP_ROOT/tag-changes.err"

# A lease error is success only if a fresh read proves another cleaner removed
# the exact tag. A still-observable tag remains a visible failure.
reset_state
write_release true false
write_tag 1
GH_STUB_MODE=tag-concurrent-delete \
  run_delete > "$TMP_ROOT/tag-concurrent.out"
[ ! -e "$STATE/tag" ]
grep -q 'tag test-staging is already absent' "$TMP_ROOT/tag-concurrent.out"

reset_state
write_release true false
write_tag 1
if GH_STUB_MODE=tag-fails \
    run_delete > "$TMP_ROOT/tag-fails.out" \
      2> "$TMP_ROOT/tag-fails.err"; then
  echo 'observable tag deletion failure was hidden' >&2
  exit 1
fi
[ -e "$STATE/tag" ]
[ "$(grep -Fc 'git ' "$API_LOG")" -eq 4 ]
grep -q 'failed to delete tag test-staging' "$TMP_ROOT/tag-fails.err"

# A different public release claiming the tag prevents tag deletion.
reset_state
write_release true false
write_tag 1
jq -n '{id: 702, tag_name: "test-staging", prerelease: true,
  draft: false, immutable: false}' > "$STATE/replacement.json"
if run_delete > "$TMP_ROOT/replacement.out" \
    2> "$TMP_ROOT/replacement.err"; then
  echo 'replacement release tag was deleted' >&2
  exit 1
fi
[ -e "$STATE/tag" ]
grep -q 'retaining tag for a replacement release' \
  "$TMP_ROOT/replacement.err"

# If discovery became stale before lock acquisition, retain any unowned tag.
reset_state
write_tag 1
run_delete > "$TMP_ROOT/already-absent.out"
[ -e "$STATE/tag" ]
grep -q 'release test-staging is already absent' \
  "$TMP_ROOT/already-absent.out"
grep -q 'retaining unowned tag test-staging' \
  "$TMP_ROOT/already-absent.out"

# Failure to obtain the publisher's tag lock prevents every API mutation.
reset_state
write_release true false
write_tag 1
if GH_STUB_MODE=lock-fails \
    run_delete > "$TMP_ROOT/lock-fails.out" \
      2> "$TMP_ROOT/lock-fails.err"; then
  echo 'cleanup continued without its state lock' >&2
  exit 1
fi
if grep -Eq '^(DELETE|git )' "$API_LOG"; then
  echo 'lock failure permitted a write' >&2
  exit 1
fi

# Unsafe input fails before locking or querying GitHub.
if GITHUB_REPOSITORY=example/repo "$DELETE_RELEASE" \
    --release-id 0 --tag test-staging >/dev/null 2>&1; then
  echo 'zero release ID was accepted' >&2
  exit 1
fi
long_tag=$(printf 'x%.0s' {1..300})
if GITHUB_REPOSITORY=example/repo "$DELETE_RELEASE" \
    --release-id 701 --tag "$long_tag" >/dev/null 2>&1; then
  echo 'oversized release tag was accepted' >&2
  exit 1
fi

echo 'writable release deletion tests passed'
