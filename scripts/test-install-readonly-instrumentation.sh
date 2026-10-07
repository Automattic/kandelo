#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_ROOT/sdk/activate.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-readonly-install.XXXXXX")"
cleanup() { chmod -R u+w "$work"; rm -rf "$work"; }
trap cleanup EXIT
export TMPDIR="$work"
cat > "$work/fork.c" <<'C'
#include <unistd.h>
int main(void) { return fork() < 0; }
C
wasm32posix-cc -O0 "$work/fork.c" -o "$work/fork.wasm"
chmod 0555 "$work/fork.wasm"
mkdir -p "$work/out"
export WASM_POSIX_DEP_OUT_DIR="$work/out"
export WASM_POSIX_DEP_TARGET_ARCH=wasm32
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
unset WASM_POSIX_LOCAL_INSTALL_SESSION

# A pipe would conceal mv's interactive override prompt. Exercise the actual
# installer with terminal stdin, as in a developer's declared shell.
python3 - "$REPO_ROOT" "$work/fork.wasm" <<'PY'
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
process = subprocess.Popen([
    "bash", "-c",
    'source "$1/scripts/install-local-binary.sh"; install_local_binary unzip "$2" unzip.wasm',
    "readonly-install-test", sys.argv[1], sys.argv[2],
], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
deadline = time.monotonic() + 60
output = bytearray()
try:
    while process.poll() is None:
        if time.monotonic() > deadline:
            raise RuntimeError("readonly installation waited for terminal input: " + output.decode(errors="replace")[-1000:])
        if select.select([master], [], [], 0.1)[0]:
            try: output.extend(os.read(master, 65536))
            except OSError: break
    status = process.wait(timeout=1)
    print(output.decode(errors="replace"), end="")
    if status: raise RuntimeError(f"readonly installation exited {status}")
    if b"overriding mode" in output:
        raise RuntimeError("readonly installation prompted for permission")
finally:
    if process.poll() is None:
        os.killpg(process.pid, 9)
        process.wait()
    os.close(master)
PY
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
wasm_require_fork_instrumentation_if_needed "$work/out/unzip.wasm"
echo "test-install-readonly-instrumentation: ok"
