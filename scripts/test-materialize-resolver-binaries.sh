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
cache_key="$(printf 'a%.0s' {1..64})"
dash_generation="$external/programs/dash-0.5.12-rev0-wasm32-$cache_key"
sed_generation="$external/programs/sed-4.9-rev0-wasm32-$cache_key"
mkdir -p \
  "$dash_generation/bin" "$dash_generation/share/dash" \
  "$sed_generation/bin" "$binaries/programs/wasm32"
printf 'dash artifact\n' >"$dash_generation/bin/dash.wasm"
printf 'dash supporting data\n' >"$dash_generation/share/dash/runtime.txt"
printf 'sed artifact\n' >"$sed_generation/bin/sed.wasm"
chmod 0600 \
  "$dash_generation/bin/dash.wasm" \
  "$dash_generation/share/dash/runtime.txt" \
  "$sed_generation/bin/sed.wasm"
ln -s "$dash_generation/bin/dash.wasm" \
  "$binaries/programs/wasm32/dash.wasm"
ln -s "$sed_generation/bin/sed.wasm" \
  "$binaries/programs/wasm32/sed.wasm"

bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" \
  "$binaries" "$external"
portable_cache="$(cd "$TMPDIR/source/.ci-test-binary-cache" && pwd -P)"
for program in dash sed; do
  artifact="$binaries/programs/wasm32/$program.wasm"
  [ -L "$artifact" ] && [ -f "$artifact" ] ||
    fail "$program did not retain a portable generation link"
  case "$(readlink "$artifact")" in
    /*) fail "$program retained an absolute cache link" ;;
  esac
  case "$(realpath "$artifact")" in
    "$portable_cache"/programs/*) ;;
    *) fail "$program does not resolve inside the transported cache" ;;
  esac
done
[ "$(file_mode "$binaries")" = "555" ] ||
  fail "materialized binaries root is not traversable by the Formula identity"
[ "$(file_mode "$(realpath "$binaries/programs/wasm32/dash.wasm")")" = "444" ] ||
  fail "materialized Dash is not readable by the Formula identity"
[ "$(file_mode "$portable_cache")" = "555" ] ||
  fail "portable cache root is not read-only"
[ -f "$portable_cache/programs/$(basename "$dash_generation")/share/dash/runtime.txt" ] ||
  fail "the complete Dash generation was not transported"
chmod 000 "$external"
[ "$(cat "$binaries/programs/wasm32/dash.wasm")" = "dash artifact" ] ||
  fail "materialized Dash still depends on the workflow cache"
[ "$(cat "$portable_cache/programs/$(basename "$dash_generation")/share/dash/runtime.txt")" = \
    "dash supporting data" ] ||
  fail "transported Dash support data still depends on the workflow cache"
chmod 0700 "$external"

dangling="$TMPDIR/dangling"
mkdir -p "$dangling/programs/wasm32"
ln -s "$TMPDIR/missing.wasm" "$dangling/programs/wasm32/dash.wasm"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$dangling" \
  "$external" \
  >/dev/null 2>&1; then
  fail "dangling resolver link was accepted"
fi
[ -L "$dangling/programs/wasm32/dash.wasm" ] ||
  fail "failed materialization changed the original dangling tree"

special="$TMPDIR/special"
mkdir -p "$special/programs/wasm32"
mkfifo "$special/programs/wasm32/runtime.fifo"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$special" \
  "$external" \
  >/dev/null 2>&1; then
  fail "special resolver entry was accepted"
fi
[ -p "$special/programs/wasm32/runtime.fifo" ] ||
  fail "failed materialization changed the original special-entry tree"

flattened="$TMPDIR/flattened"
mkdir -p "$flattened/programs/wasm32"
printf 'identityless dash\n' >"$flattened/programs/wasm32/dash.wasm"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$flattened" \
  "$external" >/dev/null 2>&1; then
  fail "identityless regular program mirror was accepted"
fi

outside_cache="$TMPDIR/outside-cache"
noncanonical="$TMPDIR/noncanonical"
mkdir -p "$outside_cache" "$noncanonical/programs/wasm32"
printf 'outside artifact\n' >"$outside_cache/dash.wasm"
ln -s "$outside_cache/dash.wasm" "$noncanonical/programs/wasm32/dash.wasm"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$noncanonical" \
  "$external" >/dev/null 2>&1; then
  fail "program link outside the exact resolver cache was accepted"
fi

escaping_cache="$TMPDIR/escaping-cache"
escaping_generation="$escaping_cache/programs/dash-0.5.12-rev0-wasm32-$cache_key"
escaping="$TMPDIR/escaping"
mkdir -p "$escaping_generation/bin" "$escaping/programs/wasm32"
printf 'outside generation\n' >"$TMPDIR/outside-generation.wasm"
ln -s "$TMPDIR/outside-generation.wasm" "$escaping_generation/bin/dash.wasm"
ln -s "$escaping_generation/bin/dash.wasm" \
  "$escaping/programs/wasm32/dash.wasm"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$escaping" \
  "$escaping_cache" >/dev/null 2>&1; then
  fail "a copied generation with an escaping link was accepted"
fi

occupied_parent="$TMPDIR/occupied"
occupied="$occupied_parent/binaries"
mkdir -p \
  "$occupied/programs/wasm32" \
  "$occupied_parent/.ci-test-binary-cache"
ln -s "$dash_generation/bin/dash.wasm" \
  "$occupied/programs/wasm32/dash.wasm"
if bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$occupied" \
  "$external" >/dev/null 2>&1; then
  fail "an occupied portable-cache destination was overwritten"
fi
[ -L "$occupied/programs/wasm32/dash.wasm" ] ||
  fail "occupied-destination rejection changed the original mirror"

interrupted_parent="$TMPDIR/interrupted"
interrupted="$interrupted_parent/binaries"
interrupted_cache="$TMPDIR/interrupted-cache"
interrupted_generation="$interrupted_cache/programs/dash-0.5.12-rev0-wasm32-$cache_key"
mkdir -p "$interrupted/programs/wasm32" "$interrupted_generation/bin"
printf 'original artifact\n' >"$interrupted_generation/bin/dash.wasm"
ln -s "$interrupted_generation/bin/dash.wasm" \
  "$interrupted/programs/wasm32/dash.wasm"
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
   "$interrupted_cache" \
   >/dev/null 2>&1; then
  fail "interrupted original-tree rename unexpectedly succeeded"
fi
[ -L "$interrupted/programs/wasm32/dash.wasm" ] && \
  [ "$(cat "$interrupted/programs/wasm32/dash.wasm")" = "original artifact" ] ||
  fail "interrupted original-tree rename did not roll back"
[ ! -e "$interrupted_parent/.ci-test-binary-cache" ] &&
  [ ! -L "$interrupted_parent/.ci-test-binary-cache" ] ||
  fail "interrupted original-tree rename retained the staged portable cache"
if find "$interrupted_parent" -maxdepth 1 -name '.binaries.materialize.*' \
     -print -quit | grep -q .; then
  fail "successful rollback retained a materialization transaction"
fi

committed_parent="$TMPDIR/committed-cleanup-failure"
committed="$committed_parent/binaries"
committed_cache="$TMPDIR/committed-cleanup-cache"
committed_generation="$committed_cache/programs/dash-0.5.12-rev0-wasm32-$cache_key"
mkdir -p "$committed/programs/wasm32" "$committed_generation/bin"
printf 'committed artifact\n' >"$committed_generation/bin/dash.wasm"
ln -s "$committed_generation/bin/dash.wasm" \
  "$committed/programs/wasm32/dash.wasm"
failing_rm_bin="$TMPDIR/failing-rm-bin"
real_rm="$(command -v rm)"
mkdir -p "$failing_rm_bin"
cat >"$failing_rm_bin/rm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
target="\${!#}"
case "\$target" in
  */.binaries.materialize.*/original)
    # Model an rm failure after it has already removed part of the backup.
    "$real_rm" -rf -- "\$target/programs"
    exit 1
    ;;
esac
exec "$real_rm" "\$@"
EOF
chmod 0755 "$failing_rm_bin/rm"
if PATH="$failing_rm_bin:$PATH" \
   bash "$REPO_ROOT/scripts/materialize-resolver-binaries.sh" "$committed" \
   "$committed_cache" \
   >/dev/null 2>&1; then
  fail "partial original-tree cleanup unexpectedly succeeded"
fi
[ -L "$committed/programs/wasm32/dash.wasm" ] && \
  [ "$(cat "$committed/programs/wasm32/dash.wasm")" = "committed artifact" ] ||
  fail "partial backup cleanup replaced the complete committed resolver tree"
committed_portable="$(
  cd "$committed_parent/.ci-test-binary-cache"
  pwd -P
)"
case "$(realpath "$committed/programs/wasm32/dash.wasm")" in
  "$committed_portable"/programs/*) ;;
  *) fail "partial backup cleanup removed the committed portable cache" ;;
esac
committed_transaction="$(
  find "$committed_parent" -maxdepth 1 -type d \
    -name '.binaries.materialize.*' -print -quit
)"
[ -n "$committed_transaction" ] && \
  [ ! -e "$committed_transaction/original/programs" ] ||
  fail "partial backup cleanup did not preserve honest transaction evidence"

echo "test-materialize-resolver-binaries.sh: ok"
