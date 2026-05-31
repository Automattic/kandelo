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
    if [[ "$*" == *index.toml* && "${GH_STUB_HAS_INDEX:-0}" = "1" ]]; then
      printf '1\t123\tsha256:stub\n'
    fi
    ;;
  release)
    sub="${1:-}"
    shift || true
    case "$sub" in
      view)
        exit 0
        ;;
      download)
        dir=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --dir)
              dir="$2"
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

run_index_update() {
  local target_tag="$1"
  local archive_abi="$2"
  local has_index="$3"
  local seed_index="${4:-}"

  local case_dir archive_path upload_dir
  case_dir="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  archive_path="$case_dir/foo-1.0-rev1-abi${archive_abi}-wasm32-deadbeef.tar.zst"
  upload_dir="$case_dir/uploads"
  printf 'archive bytes\n' > "$archive_path"
  mkdir -p "$upload_dir"

  if ! GH_STUB_HAS_INDEX="$has_index" \
       GH_STUB_INDEX_SOURCE="$seed_index" \
       GH_STUB_UPLOAD_DIR="$upload_dir" \
       GITHUB_REPOSITORY="example/repo" \
       GITHUB_SHA="0123456789abcdef0123456789abcdef01234567" \
       GITHUB_RUN_ID="123" \
       STATE_LOCK_SCRIPT="$STATE_LOCK_STUB" \
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

pr_index="$(run_index_update "pr-595-staging" "$CURRENT_ABI" 0)"
assert_index_abi "$pr_index" "$CURRENT_ABI"

stale_index="$TMP_ROOT/stale-index.toml"
cat > "$stale_index" <<'EOF'
abi_version = 1
generated_at = "old"
generator = "test"
EOF
rewritten_index="$(run_index_update "pr-595-staging" "$CURRENT_ABI" 1 "$stale_index")"
assert_index_abi "$rewritten_index" "$CURRENT_ABI"

repair_index="$(run_index_repair "pr-595-staging" 1 "$stale_index")"
assert_index_abi "$repair_index" "$CURRENT_ABI"

durable_index="$(run_index_update "binaries-abi-v42" 42 0)"
assert_index_abi "$durable_index" 42

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
