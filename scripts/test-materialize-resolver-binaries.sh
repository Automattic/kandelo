#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'chmod -R u+rwx "$TMPDIR" 2>/dev/null || true; rm -rf "$TMPDIR"' EXIT

fail() {
  echo "test-materialize-resolver-binaries.sh: $*" >&2
  exit 1
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

external="$TMPDIR/workflow-cache"
binaries="$TMPDIR/source/binaries"
mkdir -p "$external" "$binaries/programs/wasm32"
printf 'dash artifact\n' >"$external/dash.wasm"
printf 'sed artifact\n' >"$external/sed.wasm"
chmod 0600 "$external/dash.wasm" "$external/sed.wasm"
ln -s "$external/dash.wasm" "$binaries/programs/wasm32/dash.wasm"
ln -s "$external/sed.wasm" "$binaries/programs/wasm32/sed.wasm"

bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$binaries"
for program in dash sed; do
  artifact="$binaries/programs/wasm32/$program.wasm"
  [ -f "$artifact" ] && [ ! -L "$artifact" ] ||
    fail "$program was not materialized as a regular file"
done
[ "$(file_mode "$binaries")" = "555" ] ||
  fail "materialized binaries root is not traversable by the Formula identity"
[ "$(file_mode "$binaries/programs/wasm32/dash.wasm")" = "444" ] ||
  fail "materialized Dash is not readable by the Formula identity"
chmod 000 "$external"
[ "$(cat "$binaries/programs/wasm32/dash.wasm")" = "dash artifact" ] ||
  fail "materialized Dash still depends on the workflow cache"
chmod 0700 "$external"

dangling="$TMPDIR/dangling"
mkdir -p "$dangling/programs/wasm32"
ln -s "$TMPDIR/missing.wasm" "$dangling/programs/wasm32/dash.wasm"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$dangling" \
  >/dev/null 2>&1; then
  fail "dangling resolver link was accepted"
fi
[ -L "$dangling/programs/wasm32/dash.wasm" ] ||
  fail "failed materialization changed the original dangling tree"

special="$TMPDIR/special"
mkdir -p "$special/programs/wasm32"
mkfifo "$special/programs/wasm32/runtime.fifo"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$special" \
  >/dev/null 2>&1; then
  fail "special resolver entry was accepted"
fi
[ -p "$special/programs/wasm32/runtime.fifo" ] ||
  fail "failed materialization changed the original special-entry tree"

interrupted_parent="$TMPDIR/interrupted"
interrupted="$interrupted_parent/binaries"
interrupted_cache="$TMPDIR/interrupted-cache"
mkdir -p "$interrupted/programs/wasm32" "$interrupted_cache"
printf 'original artifact\n' >"$interrupted_cache/dash.wasm"
ln -s "$interrupted_cache/dash.wasm" "$interrupted/programs/wasm32/dash.wasm"
real_mv="$(command -v mv)"
failing_mv_bin="$TMPDIR/failing-mv-bin"
failure_marker="$TMPDIR/original-rename-failed"
mkdir -p "$failing_mv_bin"
cat >"$failing_mv_bin/mv" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${2##*/}" = original ] && [ ! -e "$failure_marker" ]; then
  "$real_mv" "\$@"
  : >"$failure_marker"
  exit 1
fi
exec "$real_mv" "\$@"
EOF
chmod 0755 "$failing_mv_bin/mv"
if PATH="$failing_mv_bin:$PATH" \
   bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$interrupted" \
   >/dev/null 2>&1; then
  fail "interrupted original-tree rename unexpectedly succeeded"
fi
[ -L "$interrupted/programs/wasm32/dash.wasm" ] && \
  [ "$(cat "$interrupted/programs/wasm32/dash.wasm")" = "original artifact" ] ||
  fail "interrupted original-tree rename did not roll back"
if find "$interrupted_parent" -maxdepth 1 -name '.binaries.materialize.*' \
     -print -quit | grep -q .; then
  fail "successful rollback retained a materialization transaction"
fi

echo "test-materialize-resolver-binaries.sh: ok"
