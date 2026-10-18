#!/usr/bin/env bash
# install_local_binary must never stop to ask a question. Workspace setup runs
# builds with stdin attached to a terminal, and a build that waits on a prompt
# never finishes: it also holds the shared source-only cache lock, so cache
# garbage collection skips for as long as it waits. `mv` and `rm` prompt
# before replacing a read-only file when stdin is a terminal, and recipes
# routinely copy read-only binaries out of a `make install` stage. Each
# scenario below therefore runs with stdin on a pseudo-terminal that answers
# "n" to any question, so a prompt shows up as wrong output instead of a hang.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
    echo "test-install-local-binary-noninteractive.sh: $*" >&2
    exit 1
}

for tool in python3 wat2wasm wasm-objdump; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done

unset WASM_POSIX_DEP_OUT_DIR
unset WASM_POSIX_DEP_TARGET_ARCH
unset WASM_POSIX_INSTALL_LOCAL_MIRROR
unset WASM_POSIX_INSTALL_FORK_INSTRUMENTATION
unset WASM_POSIX_LOCAL_INSTALL_SESSION

work="$(mktemp -d)"
cleanup() {
    chmod -R u+w "$work" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT

# Run a command with stdin on a fresh pseudo-terminal. Python's pty module
# behaves the same on Linux and macOS, unlike the util-linux and BSD `script`
# command lines. The queued "n" answers the first prompt, so a prompting
# command declines instead of blocking; the timeout bounds anything else.
run_on_tty() {
    python3 -c '
import os, subprocess, sys
master, slave = os.openpty()
os.write(master, b"n\n")
try:
    result = subprocess.run(sys.argv[1:], stdin=slave, timeout=600)
except subprocess.TimeoutExpired:
    sys.exit(124)
sys.exit(result.returncode)
' "$@"
}

# Prompt wording differs between BSD mv ("override r-xr-xr-x ...?") and GNU
# coreutils mv ("replace '...', overriding mode 0555 ...?").
require_no_prompt() {
    local log="$1"
    if grep -i -E 'overrid|\?[[:space:]]*\(y/n' "$log" >/dev/null; then
        cat "$log" >&2
        fail "$2"
    fi
}

mode_of() {
    stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

cat >"$work/forky.wat" <<'WAT'
(module
  (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start") (drop (call $fork (i32.const 0)))))
WAT

# Scenario 1: a read-only, not-yet-instrumented source. The instrumented
# module replaces the source in place without asking, and keeps the mode the
# recipe gave the source.
source_dir="$work/source"
out_dir="$work/output"
mkdir -p "$source_dir" "$out_dir"
wat2wasm "$work/forky.wat" -o "$source_dir/forky.wasm"
chmod 0555 "$source_dir/forky.wasm"
uninstrumented_sha="$(shasum -a 256 "$source_dir/forky.wasm" | awk '{print $1}')"

instrument_log="$work/instrument.log"
if ! run_on_tty env \
    REPO_ROOT="$REPO_ROOT" \
    SRC="$source_dir/forky.wasm" \
    WASM_POSIX_DEP_OUT_DIR="$out_dir" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
    bash -c '
        set -euo pipefail
        [ -t 0 ] || { echo "stdin is not a terminal" >&2; exit 90; }
        source "$REPO_ROOT/scripts/install-local-binary.sh"
        install_local_binary forky "$SRC"
    ' >"$instrument_log" 2>&1; then
    cat "$instrument_log" >&2
    fail "fork-instrumenting a read-only source failed with stdin on a terminal"
fi
require_no_prompt "$instrument_log" "fork instrumentation prompted before replacing a read-only source"
[ "$(shasum -a 256 "$source_dir/forky.wasm" | awk '{print $1}')" != "$uninstrumented_sha" ] ||
    fail "the read-only source was not replaced by its instrumented module"
(
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    wasm_has_complete_fork_instrumentation "$source_dir/forky.wasm"
) || fail "the replaced source is not completely fork-instrumented"
[ "$(mode_of "$source_dir/forky.wasm")" = 555 ] ||
    fail "instrumentation changed the source mode to $(mode_of "$source_dir/forky.wasm")"
cmp "$source_dir/forky.wasm" "$out_dir/forky.wasm" ||
    fail "the published artifact is not the instrumented source"
[ "$(mode_of "$out_dir/forky.wasm")" = 555 ] ||
    fail "the published artifact mode is $(mode_of "$out_dir/forky.wasm"), not the source mode"

# Scenario 2: a failed publication restores the previous destination. If a
# read-only entry appears at the destination before the restore, it won the
# pathname race: the restore must neither ask about it nor replace it, and the
# quarantined previous destination stays in the transaction as evidence. The
# installer resolves its output root with `pwd -P`, so the fake `mv` matches
# the physical destination path (macOS /tmp is a symlink to /private/tmp).
fake_bin="$work/fake-bin"
mkdir -p "$fake_bin"
real_mv="$(command -v mv)"
cat >"$fake_bin/ln" <<'EOF'
#!/usr/bin/env bash
exit 91
EOF
cat >"$fake_bin/mv" <<EOF
#!/usr/bin/env bash
set -euo pipefail
target="\${!#}"
if [ "\$target" = "\$RACE_DEST" ] && [ ! -e "\$RACE_DEST" ]; then
    printf 'race-winner\n' >"\$RACE_DEST"
    chmod 0444 "\$RACE_DEST"
fi
exec "$real_mv" "\$@"
EOF
chmod +x "$fake_bin/ln" "$fake_bin/mv"

race_out="$work/race-output"
mkdir "$race_out"
printf 'previous-runtime\n' >"$race_out/runtime.dat"
printf 'new-runtime\n' >"$work/runtime.dat"
race_log="$work/race.log"
if run_on_tty env \
    REPO_ROOT="$REPO_ROOT" \
    SRC="$work/runtime.dat" \
    PATH="$fake_bin:$PATH" \
    RACE_DEST="$(cd "$race_out" && pwd -P)/runtime.dat" \
    WASM_POSIX_DEP_OUT_DIR="$race_out" \
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
    bash -c '
        set -euo pipefail
        [ -t 0 ] || { echo "stdin is not a terminal" >&2; exit 90; }
        source "$REPO_ROOT/scripts/install-local-binary.sh"
        install_local_runtime_file forky "$SRC" runtime.dat
    ' >"$race_log" 2>&1; then
    cat "$race_log" >&2
    fail "a failed publication reported success"
fi
grep -F 'stdin is not a terminal' "$race_log" >/dev/null &&
    fail "the restore scenario did not run with stdin on a terminal"
require_no_prompt "$race_log" "restoring the previous destination prompted"
[ "$(cat "$race_out/runtime.dat")" = "race-winner" ] ||
    fail "restoring the previous destination replaced an entry that won the race"
race_transactions=("$race_out"/.kandelo-install.*)
[ "${#race_transactions[@]}" -eq 1 ] || fail "expected one preserved transaction"
[ "$(cat "${race_transactions[0]}/backup")" = "previous-runtime" ] ||
    fail "the quarantined previous destination was not preserved"

echo "test-install-local-binary-noninteractive.sh: ok"
