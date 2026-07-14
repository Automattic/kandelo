#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/init-merge-candidate.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
sha_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
assets() {
  printf '['; sep=""
  for path in "$GH_INIT_STORE"/*; do
    [ -f "$path" ] || continue
    name=$(basename "$path")
    [ -f "$GH_INIT_STORE/.id-$name" ] || continue
    id=$(cat "$GH_INIT_STORE/.id-$name")
    size=$(wc -c < "$path" | tr -d '[:space:]'); sha=$(sha_file "$path")
    printf '%s' "$sep"
    jq -cn --argjson id "$id" --arg name "$name" --argjson size "$size" \
      --arg digest "sha256:$sha" '{id:$id,name:$name,size:$size,digest:$digest}'
    sep=,
  done
  printf ']'
}
case "${1:-}" in
  api)
    shift; include=false; endpoint=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --include) include=true; shift ;; -H) shift 2 ;; /repos/*) endpoint="$1"; shift ;; *) shift ;; esac
    done
    if [[ "$endpoint" == */releases/tags/* ]]; then
      [ "$include" = false ] || printf 'HTTP/2.0 200 OK\n\n'
      printf '{"id":7,"tag_name":"%s","created_at":"2026-07-14T10:00:00Z","assets":' "$GH_INIT_TAG"
      assets
      printf '}\n'
    elif [[ "$endpoint" =~ /releases/assets/([0-9]+)$ ]]; then
      id="${BASH_REMATCH[1]}"
      for marker in "$GH_INIT_STORE"/.id-*; do
        [ -f "$marker" ] || continue
        if [ "$(cat "$marker")" = "$id" ]; then cat "$GH_INIT_STORE/${marker##*.id-}"; exit 0; fi
      done
      exit 1
    else exit 99; fi
    ;;
  release)
    [ "${2:-}" = upload ] || exit 99
    shift 3
    for arg in "$@"; do
      [ -f "$arg" ] || continue
      name=$(basename "$arg")
      [ ! -f "$GH_INIT_STORE/$name" ] || exit 1
      cp "$arg" "$GH_INIT_STORE/$name"
      id=$(cat "$GH_INIT_STORE/.next-id")
      printf '%s\n' $((id + 1)) > "$GH_INIT_STORE/.next-id"
      printf '%s\n' "$id" > "$GH_INIT_STORE/.id-$name"
      printf '%s\n' "$name" >> "$GH_INIT_UPLOAD_LOG"
    done
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$BIN/gh"

cat > "$BIN/rustc" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -vV ] && printf 'host: test-host\n'
EOF
chmod +x "$BIN/rustc"

cat > "$BIN/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
canonical=""; output=""; generated=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --canonical-index) canonical="$2"; shift 2 ;;
    --candidate-index) output="$2"; shift 2 ;;
    --generated-at) generated="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat "$canonical" > "$output"
printf 'generated_at = "%s"\n' "$generated" >> "$output"
EOF
chmod +x "$BIN/cargo"

LOCK="$TMP_ROOT/lock.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$LOCK"
chmod +x "$LOCK"

CANONICAL="$TMP_ROOT/canonical.toml"
printf 'abi_version = 39\n' > "$CANONICAL"
TAG=merge-candidate-abi-v39-pr-1-run-2-attempt-1
run_init() {
  local store="$1" fail="${2:-}"
  GH_INIT_STORE="$store" GH_INIT_TAG="$TAG" GH_INIT_UPLOAD_LOG="$store/uploads.log" \
    GITHUB_API_RETRY_DELAY_SECONDS=0 GITHUB_REPOSITORY=example/repo \
    CANDIDATE_INIT_FAIL_AFTER_ASSET="$fail" STATE_LOCK_SCRIPT="$LOCK" \
    PATH="$BIN:$PATH" bash "$SCRIPT" \
      --canonical-index "$CANONICAL" --canonical-state present \
      --candidate-tag "$TAG" --canonical-tag binaries-abi-v39 --abi 39 \
      --pr-number 1 --base-ref main \
      --base-sha 1111111111111111111111111111111111111111 \
      --head-sha 2222222222222222222222222222222222222222 \
      --synthetic-merge-sha 3333333333333333333333333333333333333333 \
      --synthetic-tree-sha 4444444444444444444444444444444444444444 \
      --merge-method squash --pr-commit-count 1 --run-id 2 --run-attempt 1
}

for fail_asset in candidate.json base-index.toml index.toml; do
  store="$TMP_ROOT/store-${fail_asset%.toml}"
  mkdir -p "$store"
  printf '100\n' > "$store/.next-id"
  : > "$store/uploads.log"
  if run_init "$store" "$fail_asset" >"$store/first.out" 2>"$store/first.err"; then
    echo "candidate init did not stop after $fail_asset" >&2
    exit 1
  fi
  run_init "$store" >"$store/retry.out"
  [ -f "$store/candidate.json" ] && [ -f "$store/base-index.toml" ] && [ -f "$store/index.toml" ]
  [ "$(wc -l < "$store/uploads.log" | tr -d '[:space:]')" = 3 ]
  grep -qx 'generated_at = "2026-07-14T10:00:00Z"' "$store/index.toml"
  before=$(sha256_file="$store/index.toml"; if command -v sha256sum >/dev/null 2>&1; then sha256sum "$sha256_file"; else shasum -a 256 "$sha256_file"; fi)
  run_init "$store" >"$store/third.out"
  after=$(sha256_file="$store/index.toml"; if command -v sha256sum >/dev/null 2>&1; then sha256sum "$sha256_file"; else shasum -a 256 "$sha256_file"; fi)
  [ "$before" = "$after" ]
  [ "$(wc -l < "$store/uploads.log" | tr -d '[:space:]')" = 3 ]
done

store="$TMP_ROOT/mismatch"
mkdir -p "$store"
printf '100\n' > "$store/.next-id"
: > "$store/uploads.log"
if run_init "$store" candidate.json >/dev/null 2>&1; then exit 1; fi
printf 'tampered\n' > "$store/candidate.json"
if run_init "$store" >"$store/mismatch.out" 2>"$store/mismatch.err"; then
  echo "candidate init accepted mismatched partial metadata" >&2; exit 1
fi
grep -q 'different bytes' "$store/mismatch.err"

echo "merge candidate initialization tests passed"
