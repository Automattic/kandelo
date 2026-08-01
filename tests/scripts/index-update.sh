#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CURRENT_ABI="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STUB_BIN="$TMP_ROOT/bin"
mkdir -p "$STUB_BIN"

cat > "$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
shift || true

  case "$cmd" in
  api)
    if [[ "$*" == *"/git/ref/heads/main"* ]]; then
      main_sha="${GH_STUB_MAIN_SHA:?}"
      if [ -n "${GH_STUB_STATE_DIR:-}" ]; then
        count=0
        [ ! -f "$GH_STUB_STATE_DIR/main-check-count" ] ||
          count=$(cat "$GH_STUB_STATE_DIR/main-check-count")
        count=$((count + 1))
        printf '%s\n' "$count" >"$GH_STUB_STATE_DIR/main-check-count"
        if [ -n "${GH_STUB_MAIN_FLIP_AFTER:-}" ] &&
           [ "$count" -gt "$GH_STUB_MAIN_FLIP_AFTER" ]; then
          main_sha="${GH_STUB_NEXT_MAIN_SHA:?}"
        fi
      fi
      printf '%s\n' "$main_sha"
      exit 0
    fi
    if [[ "$*" == *"-X DELETE"* ]]; then
      delete_count=0
      [ ! -f "$GH_STUB_STATE_DIR/delete-attempt-count" ] ||
        delete_count=$(cat "$GH_STUB_STATE_DIR/delete-attempt-count")
      delete_count=$((delete_count + 1))
      printf '%s\n' "$delete_count" >"$GH_STUB_STATE_DIR/delete-attempt-count"
      if [ "${GH_STUB_DELETE_FAIL_ONCE:-0}" = 1 ] &&
         [ "$delete_count" = 1 ]; then
        echo "injected delete failure" >&2
        exit 1
      fi
      rm -f "$GH_STUB_STATE_DIR/existing-archive"
      exit 0
    fi
    asset_name=""
    if [[ "$*" =~ select\(\.name[[:space:]]==[[:space:]]\"([^\"]+)\" ]]; then
      asset_name="${BASH_REMATCH[1]}"
    fi
    if [ -n "$asset_name" ]; then
      asset_path="${GH_STUB_UPLOAD_DIR:-}/$asset_name"
      if [ -f "$asset_path" ]; then
        size="$(wc -c < "$asset_path" | tr -d '[:space:]')"
        if command -v sha256sum >/dev/null 2>&1; then
          sha="$(sha256sum "$asset_path" | awk '{print $1}')"
        else
          sha="$(shasum -a 256 "$asset_path" | awk '{print $1}')"
        fi
        printf '1\t%s\tsha256:%s\n' "$size" "$sha"
      elif [ "$asset_name" = "index.toml" ] && [ "${GH_STUB_HAS_INDEX:-0}" = "1" ]; then
        printf '1\t123\tsha256:stub\n'
      elif [ "$asset_name" = "ready.json" ] && [ "${GH_STUB_HAS_READY:-0}" = "1" ]; then
        printf '2\t123\tsha256:stub\n'
      elif [ -f "${GH_STUB_STATE_DIR:-/nonexistent}/existing-archive" ] &&
           [ "$asset_name" = "${GH_STUB_EXISTING_ARCHIVE_NAME:-}" ]; then
        printf '3\t1\tsha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\n'
      fi
    fi
    ;;
  release)
    sub="${1:-}"
    shift || true
    case "$sub" in
      view)
        if [ "${GH_STUB_RELEASE_MISSING:-0}" = 1 ] &&
           [ ! -f "${GH_STUB_STATE_DIR:?}/release-created" ]; then
          echo "release not found" >&2
          exit 1
        fi
        exit 0
        ;;
      download)
        dir=""
        pattern=""
        tag="${1:-}"
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --dir)
              dir="$2"
              shift 2
              ;;
            --pattern)
              pattern="$2"
              shift 2
              ;;
            *)
              shift
              ;;
          esac
        done
        if [ "${GH_STUB_HAS_INDEX:-0}" = "1" ]; then
          cp "${GH_STUB_INDEX_SOURCE:?}" "$dir/index.toml"
        fi
        if [ "$pattern" = candidate.json ]; then
          pr="$(sed -nE 's/^merge-candidate-abi-v[0-9]+-pr-([0-9]+)-run-.*$/\1/p' <<<"$tag")"
          jq -n --arg tag "$tag" --argjson pr "$pr" \
            --arg head "${GITHUB_SHA:?}" \
            '{candidate_tag:$tag,pr_number:$pr,head_sha:$head}' \
            >"$dir/candidate.json"
        fi
        ;;
      upload)
        mkdir -p "${GH_STUB_UPLOAD_DIR:?}"
        for arg in "$@"; do
          if [ -f "$arg" ]; then
            cp "$arg" "$GH_STUB_UPLOAD_DIR/$(basename "$arg")"
          fi
        done
        ;;
      create)
        if [ -n "${GH_STUB_STATE_DIR:-}" ]; then
          touch "$GH_STUB_STATE_DIR/release-created"
        fi
        exit 0
        ;;
      *)
        echo "unexpected gh release subcommand: $sub" >&2
        exit 99
        ;;
    esac
    ;;
  *)
    echo "unexpected gh command: $cmd" >&2
    exit 99
    ;;
esac
EOF
chmod +x "$STUB_BIN/gh"

cat > "$STUB_BIN/rustc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-vV" ]; then
  printf 'host: test-host\n'
else
  exit 0
fi
EOF
chmod +x "$STUB_BIN/rustc"

cat > "$STUB_BIN/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

index_path=""
expected_abi=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --index-path)
      index_path="$2"
      shift 2
      ;;
    --expected-abi)
      expected_abi="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ -z "$index_path" ] || [ -z "$expected_abi" ]; then
  echo "cargo stub: missing --index-path or --expected-abi" >&2
  exit 98
fi

tmp="$index_path.tmp"
awk -v abi="$expected_abi" '
  $1 == "abi_version" && $2 == "=" {
    print "abi_version = " abi
    seen = 1
    next
  }
  { print }
  END {
    if (!seen) {
      print "abi_version = " abi
    }
  }
' "$index_path" > "$tmp"
mv "$tmp" "$index_path"
EOF
chmod +x "$STUB_BIN/cargo"

STATE_LOCK_STUB="$TMP_ROOT/state-lock.sh"
cat > "$STATE_LOCK_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
chmod +x "$STATE_LOCK_STUB"

INDEX_STATE_STUB="$TMP_ROOT/release-index-state.sh"
cat > "$INDEX_STATE_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_name="${1:-}"
shift || true
case "$command_name" in
  sentinel) printf '<!-- kandelo-index-state-v1:empty -->\n'; exit 0 ;;
  read)
    output=""; head_file=""; abi=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --output) output="$2"; shift 2 ;;
        --head-file) head_file="$2"; shift 2 ;;
        --expected-abi) abi="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "${GH_STUB_HAS_INDEX:-0}" = 1 ]; then cp "$GH_STUB_INDEX_SOURCE" "$output"
    else printf 'abi_version = %s\n' "$abi" > "$output"; fi
    printf 'test-head\n' > "$head_file"
    ;;
  publish)
    index=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --index-path) index="$2"; shift 2 ;; *) shift ;; esac
    done
    cp "$index" "$GH_STUB_UPLOAD_DIR/index.toml"
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$INDEX_STATE_STUB"

RELEASE_LIFECYCLE_STUB="$TMP_ROOT/package-release-lifecycle.sh"
cat >"$RELEASE_LIFECYCLE_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
command_name="${1:-}"
shift || true
tag=""
canonical_source_sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --canonical-source-sha) canonical_source_sha="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$command_name" = ensure-draft ] &&
   [ "${GH_STUB_RELEASE_MISSING:-0}" = 1 ] &&
   [ ! -f "${GH_STUB_STATE_DIR:?}/release-created" ]; then
  if [ -n "$canonical_source_sha" ]; then
    GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
      bash "${REPO_ROOT_FOR_STUB:?}/.github/scripts/require-exact-kandelo-main.sh" \
        --repository Automattic/kandelo \
        --source-sha "$canonical_source_sha" >/dev/null
  fi
  touch "$GH_STUB_STATE_DIR/release-created"
fi
if [ "$tag" = "${GH_STUB_IMMUTABLE_TAG:-}" ]; then
  printf 'immutable\n'
elif [ "$tag" = binaries-abi-v42 ]; then
  printf 'grandfathered-mutable\n'
else
  printf 'draft\n'
fi
EOF
chmod +x "$RELEASE_LIFECYCLE_STUB"

run_index_update() {
  local target_tag="$1"
  local archive_abi="$2"
  local has_index="$3"
  local seed_index="${4:-}"
  local has_ready="${5:-0}"
  local repository="${6:-example/repo}"
  local canonical_source_sha="${7:-}"
  local release_missing="${8:-0}"
  local main_flip_after="${9:-}"
  local existing_archive="${10:-0}"
  local delete_fail_once="${11:-0}"

  local case_dir archive_path upload_dir state_dir
  local -a authority_args=()
  case_dir="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  archive_path="$case_dir/foo-1.0-rev1-abi${archive_abi}-wasm32-deadbeef.tar.zst"
  upload_dir="$case_dir/uploads"
  state_dir="$case_dir/gh-state"
  LAST_INDEX_UPDATE_CASE_DIR="$case_dir"
  printf 'archive bytes\n' > "$archive_path"
  mkdir -p "$upload_dir" "$state_dir"
  if [ "$existing_archive" = 1 ]; then
    touch "$state_dir/existing-archive"
  fi
  if [ -n "$canonical_source_sha" ]; then
    authority_args+=(--canonical-source-sha "$canonical_source_sha")
  fi

  if ! GH_STUB_HAS_INDEX="$has_index" \
       GH_STUB_INDEX_SOURCE="$seed_index" \
       GH_STUB_UPLOAD_DIR="$upload_dir" \
       GH_STUB_HAS_READY="$has_ready" \
       GH_STUB_MAIN_SHA="0123456789abcdef0123456789abcdef01234567" \
       GH_STUB_NEXT_MAIN_SHA="ffffffffffffffffffffffffffffffffffffffff" \
       GH_STUB_MAIN_FLIP_AFTER="$main_flip_after" \
       GH_STUB_IMMUTABLE_TAG="${GH_STUB_IMMUTABLE_TAG_OVERRIDE:-}" \
       GH_STUB_RELEASE_MISSING="$release_missing" \
       GH_STUB_EXISTING_ARCHIVE_NAME="$(basename "$archive_path")" \
       GH_STUB_DELETE_FAIL_ONCE="$delete_fail_once" \
       GH_STUB_STATE_DIR="$state_dir" \
       GH_TOKEN="test-token" \
       GITHUB_REPOSITORY="$repository" \
       GITHUB_SHA="0123456789abcdef0123456789abcdef01234567" \
       GITHUB_RUN_ID="123" \
       STATE_LOCK_SCRIPT="$STATE_LOCK_STUB" \
       RELEASE_INDEX_STATE_SCRIPT="$INDEX_STATE_STUB" \
       RELEASE_LIFECYCLE_SCRIPT="$RELEASE_LIFECYCLE_STUB" \
       REPO_ROOT_FOR_STUB="$REPO_ROOT" \
       PATH="$STUB_BIN:$PATH" \
       bash "$REPO_ROOT/scripts/index-update.sh" \
         --target-tag "$target_tag" \
         --package foo \
         --version 1.0 \
         --revision 1 \
         --arch wasm32 \
         --status success \
         --archive-path "$archive_path" \
         --archive-name "$(basename "$archive_path")" \
         --cache-key-sha deadbeef \
         "${authority_args[@]}" \
         >"$case_dir/stdout" \
         2>"$case_dir/stderr"
  then
    cat "$case_dir/stdout" >&2
    cat "$case_dir/stderr" >&2
    return 1
  fi

  printf '%s\n' "$upload_dir/index.toml"
}

run_index_repair() {
  local target_tag="$1"
  local has_index="$2"
  local seed_index="${3:-}"

  local case_dir upload_dir
  case_dir="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  upload_dir="$case_dir/uploads"
  mkdir -p "$upload_dir"

  if ! GH_STUB_HAS_INDEX="$has_index" \
       GH_STUB_INDEX_SOURCE="$seed_index" \
       GH_STUB_UPLOAD_DIR="$upload_dir" \
       GITHUB_REPOSITORY="example/repo" \
       GITHUB_SHA="0123456789abcdef0123456789abcdef01234567" \
       GITHUB_RUN_ID="123" \
       STATE_LOCK_SCRIPT="$STATE_LOCK_STUB" \
       RELEASE_INDEX_STATE_SCRIPT="$INDEX_STATE_STUB" \
       RELEASE_LIFECYCLE_SCRIPT="$RELEASE_LIFECYCLE_STUB" \
       REPO_ROOT_FOR_STUB="$REPO_ROOT" \
       PATH="$STUB_BIN:$PATH" \
       bash "$REPO_ROOT/scripts/index-update.sh" \
         --target-tag "$target_tag" \
         --repair-only \
         >"$case_dir/stdout" \
         2>"$case_dir/stderr"
  then
    cat "$case_dir/stdout" >&2
    cat "$case_dir/stderr" >&2
    return 1
  fi

  printf '%s\n' "$upload_dir/index.toml"
}

assert_index_abi() {
  local index_path="$1"
  local expected="$2"
  if ! grep -qx "abi_version = $expected" "$index_path"; then
    echo "expected $index_path to contain abi_version = $expected" >&2
    cat "$index_path" >&2
    exit 1
  fi
}

legacy_staging_tag="pr-595-staging"
if GH_STUB_IMMUTABLE_TAG_OVERRIDE="$legacy_staging_tag" \
    run_index_update "$legacy_staging_tag" "$CURRENT_ABI" 0 \
      >/dev/null 2>"$TMP_ROOT/immutable-staging.err"
then
  echo "expected an existing immutable fixed staging tag to reject mutation" \
    >&2
  exit 1
fi
if ! grep -Fq 'publish a new run or generation instead of mutating it' \
    "$TMP_ROOT/immutable-staging.err"
then
  cat "$TMP_ROOT/immutable-staging.err" >&2
  echo "immutable fixed staging failure lacked the recovery guidance" >&2
  exit 1
fi

# WHY: this is the recovery path for PRs such as #1160 whose old fixed tag was
# made immutable before its index was complete. The same exact head gets a new
# attempt-owned draft instead of deleting or rewriting the published release.
staging_tag="pr-595-staging-run-123-attempt-1"
pr_index="$(GH_STUB_IMMUTABLE_TAG_OVERRIDE="$legacy_staging_tag" \
  run_index_update "$staging_tag" "$CURRENT_ABI" 0)"
assert_index_abi "$pr_index" "$CURRENT_ABI"

stale_index="$TMP_ROOT/stale-index.toml"
cat > "$stale_index" <<'EOF'
abi_version = 1
generated_at = "old"
generator = "test"
EOF
rewritten_index="$(run_index_update "$staging_tag" "$CURRENT_ABI" 1 "$stale_index")"
assert_index_abi "$rewritten_index" "$CURRENT_ABI"

repair_index="$(run_index_repair "$staging_tag" 1 "$stale_index")"
assert_index_abi "$repair_index" "$CURRENT_ABI"

durable_index="$(run_index_update "binaries-abi-v42" 42 0)"
assert_index_abi "$durable_index" 42

future_abi=$((CURRENT_ABI + 1))
if run_index_update "binaries-abi-v${future_abi}" "$future_abi" 0 \
    >/dev/null 2>"$TMP_ROOT/future-canonical.err"
then
  echo "expected per-package writes to a future canonical ABI to fail" >&2
  exit 1
fi
grep -Fq 'must be initialized by post-merge candidate activation' \
  "$TMP_ROOT/future-canonical.err"

canonical_sha="0123456789abcdef0123456789abcdef01234567"
canonical_index="$(
  run_index_update \
    "binaries-abi-v42" 42 0 "" 0 "Automattic/kandelo" "$canonical_sha"
)"
assert_index_abi "$canonical_index" 42

for canonical_repository in Automattic/kandelo automattic/kandelo; do
  if run_index_update \
      "binaries-abi-v42" 42 0 "" 0 "$canonical_repository" \
      >/dev/null 2>"$TMP_ROOT/missing-authority.err"
  then
    echo "expected $canonical_repository canonical update without exact-main authority to fail" >&2
    exit 1
  fi
  grep -Fq "canonical publication requires --canonical-source-sha" \
    "$TMP_ROOT/missing-authority.err"
done

if run_index_update \
    "binaries-abi-v42" 42 0 "" 0 "Automattic/kandelo" \
    "ffffffffffffffffffffffffffffffffffffffff" \
    >/dev/null 2>"$TMP_ROOT/stale-authority.err"
then
  echo "expected stale canonical exact-main authority to fail" >&2
  exit 1
fi
grep -Fq "source SHA must equal the current refs/heads/main commit" \
  "$TMP_ROOT/stale-authority.err"

if run_index_update \
    "binaries-abi-v42" 42 0 "" 0 "Automattic/kandelo" \
    "$canonical_sha" 1 1 \
    >/dev/null 2>"$TMP_ROOT/create-race.err"
then
  echo "expected main advance before canonical release creation to fail" >&2
  exit 1
fi
grep -Fq "source SHA must equal the current refs/heads/main commit" \
  "$TMP_ROOT/create-race.err"
[ "$(cat "$LAST_INDEX_UPDATE_CASE_DIR/gh-state/main-check-count")" = 2 ]
if [ -e "$LAST_INDEX_UPDATE_CASE_DIR/gh-state/release-created" ]; then
  echo "canonical release was created after its source stopped being main" >&2
  exit 1
fi

if run_index_update \
    "binaries-abi-v42" 42 0 "" 0 "Automattic/kandelo" \
    "$canonical_sha" 0 2 1 1 \
    >/dev/null 2>"$TMP_ROOT/delete-retry-race.err"
then
  echo "expected main advance before an archive delete retry to fail" >&2
  exit 1
fi
grep -Fq "source SHA must equal the current refs/heads/main commit" \
  "$TMP_ROOT/delete-retry-race.err"
[ "$(cat "$LAST_INDEX_UPDATE_CASE_DIR/gh-state/main-check-count")" = 3 ]
[ "$(cat "$LAST_INDEX_UPDATE_CASE_DIR/gh-state/delete-attempt-count")" = 1 ]
if [ ! -f "$LAST_INDEX_UPDATE_CASE_DIR/gh-state/existing-archive" ]; then
  echo "stale source authority retried the canonical archive delete" >&2
  exit 1
fi

candidate_index="$(run_index_update "merge-candidate-abi-v${CURRENT_ABI}-pr-595-run-123-attempt-1" "$CURRENT_ABI" 0)"
assert_index_abi "$candidate_index" "$CURRENT_ABI"

automattic_candidate_index="$(
  run_index_update \
    "merge-candidate-abi-v${CURRENT_ABI}-pr-595-run-123-attempt-1" \
    "$CURRENT_ABI" 0 "" 0 "Automattic/kandelo"
)"
assert_index_abi "$automattic_candidate_index" "$CURRENT_ABI"

if run_index_update \
    "merge-candidate-abi-v${CURRENT_ABI}-pr-595-run-123-attempt-1" \
    "$CURRENT_ABI" \
    0 \
    "" \
    1 \
    >/dev/null 2>&1
then
  echo "expected a ready merge candidate to reject further index updates" >&2
  exit 1
fi

mismatch_out="$TMP_ROOT/index-update-mismatch.out"
mismatch_err="$TMP_ROOT/index-update-mismatch.err"
if run_index_update "binaries-abi-v42" 41 0 >"$mismatch_out" 2>"$mismatch_err"; then
  echo "expected archive-name ABI mismatch to fail" >&2
  exit 1
fi
if ! grep -q "declares ABI 41" "$mismatch_err"; then
  echo "expected mismatch error to mention archive ABI" >&2
  cat "$mismatch_err" >&2
  exit 1
fi

echo "index-update.sh ABI tests passed"
