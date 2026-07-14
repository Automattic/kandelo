#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/latest-merge-gate-status.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = api ] || exit 99
endpoint="${*: -1}"
page="${endpoint##*page=}"
printf '%s\n' "$endpoint" >> "$GH_STATUS_LOG"
case "$page" in
  1) cat "$GH_STATUS_PAGE_1" ;;
  2) cat "$GH_STATUS_PAGE_2" ;;
  *) printf '[]\n' ;;
esac
EOF
chmod +x "$BIN/gh"

HEAD=1111111111111111111111111111111111111111
LOG="$TMP_ROOT/status.log"
PAGE1="$TMP_ROOT/page1.json"
PAGE2="$TMP_ROOT/page2.json"

# The newest merge-gate may be followed by more than 100 other statuses. The
# scan must still prove that pagination ended rather than trusting page one.
jq -n '[range(0; 100) | {
  id: (1000 - .), context: (if . == 0 then "merge-gate" else "ci-\(.)" end),
  state: "success", target_url: (if . == 0 then "https://example/new" else null end),
  created_at: "2026-07-14T10:00:00Z"
}]' > "$PAGE1"
jq -n '[{
  id: 1, context: "merge-gate", state: "success",
  target_url: "https://example/old", created_at: "2026-07-13T10:00:00Z"
}]' > "$PAGE2"
: > "$LOG"
target=$(GH_STATUS_LOG="$LOG" GH_STATUS_PAGE_1="$PAGE1" GH_STATUS_PAGE_2="$PAGE2" \
  GITHUB_REPOSITORY=example/repo MERGE_GATE_STATUS_RETRY_DELAY_SECONDS=0 \
  PATH="$BIN:$PATH" bash "$SCRIPT" --head-sha "$HEAD")
[ "$target" = https://example/new ]
grep -Fq "/statuses?per_page=100&page=2" "$LOG"

# A full final page reaches the configured bound and is uncertainty, not a
# license to select a potentially stale status.
jq -n '[range(0; 100) | {
  id: (2000 - .), context: "ci-\(.)", state: "success", target_url: null,
  created_at: "2026-07-14T11:00:00Z"
}]' > "$PAGE2"
if GH_STATUS_LOG="$LOG" GH_STATUS_PAGE_1="$PAGE1" GH_STATUS_PAGE_2="$PAGE2" \
    GITHUB_REPOSITORY=example/repo MERGE_GATE_STATUS_RETRY_DELAY_SECONDS=0 \
    PATH="$BIN:$PATH" bash "$SCRIPT" --head-sha "$HEAD" --max-pages 2 \
    >"$TMP_ROOT/bound.out" 2>"$TMP_ROOT/bound.err"
then
  echo "status scan accepted a truncated result" >&2
  exit 1
fi
grep -q 'safety bound' "$TMP_ROOT/bound.err"

echo "latest merge-gate status tests passed"
