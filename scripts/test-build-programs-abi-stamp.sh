#!/usr/bin/env bash
# The ABI-stamp step of scripts/build-programs.sh stamps the outputs that run
# built, and nothing else. A .wasm another producer left in a shared output
# tree (Vitest builds examples/*.wasm64.wasm on demand) still carries the
# previous kandelo.abi.contract digest after an ABI change. The stamper
# correctly refuses to restamp it; that refusal must neither fail
# build-programs.sh nor be bypassed, so the stale file keeps failing loudly
# wherever it is used.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
    echo "test-build-programs-abi-stamp.sh: $*" >&2
    exit 1
}

command -v python3 >/dev/null 2>&1 || fail "missing required tool: python3"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A minimal module, optionally carrying a kandelo.abi.contract custom section
# with the given 32-byte digest (hex).
write_module() {
    python3 - "$1" "${2:-}" <<'PY'
import sys
path, digest_hex = sys.argv[1], sys.argv[2]
data = bytearray(b"\0asm\x01\0\0\0")
if digest_hex:
    name = b"kandelo.abi.contract"
    payload = bytes([len(name)]) + name + bytes.fromhex(digest_hex)
    data += bytes([0, len(payload)]) + payload
open(path, "wb").write(data)
PY
}

sha_of() {
    shasum -a 256 "$1" | awk '{print $1}'
}

mkdir -p "$work/examples" "$work/local-binaries/programs/wasm32"
built="$work/local-binaries/programs/wasm32/built-this-run.wasm"
stale="$work/examples/stale_fixture_test.wasm64.wasm"
write_module "$built"
write_module "$stale" "$(printf 'ab%.0s' {1..32})"
stale_sha="$(sha_of "$stale")"

# Precondition: the stamper refuses the stale file. This is the refusal that
# made the old sweep-everything step exit 1.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
refusal="$work/refusal.log"
if (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        stamp-abi-contract "$stale") >"$refusal" 2>&1; then
    fail "stamp-abi-contract restamped a file carrying another ABI snapshot's digest"
fi
grep -F 'from a different ABI snapshot' "$refusal" >/dev/null || {
    cat "$refusal" >&2
    fail "stamp-abi-contract refused the stale file for an unexpected reason"
}

# The build-programs step: only recorded outputs are stamped.
stamp_log="$work/stamp.log"
if ! (
    export REPO_ROOT HOST_TARGET
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$built"
    stamp_built_program_outputs
) >"$stamp_log" 2>&1; then
    cat "$stamp_log" >&2
    fail "the stamp step failed because of a stale file it did not build"
fi
grep -F 'stamped 1, already current 0' "$stamp_log" >/dev/null || {
    cat "$stamp_log" >&2
    fail "the stamp step did not stamp exactly the one recorded output"
}
grep -a -F 'kandelo.abi.contract' "$built" >/dev/null ||
    fail "the recorded output carries no ABI contract stamp"
[ "$(sha_of "$stale")" = "$stale_sha" ] ||
    fail "the stamp step modified a stale file it did not build"

# The stale file still carries its old digest, so the stamper (and the host's
# digest gate, covered by host/test/abi-contract-digest.test.ts) still refuse it.
if (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        stamp-abi-contract "$stale") >/dev/null 2>&1; then
    fail "the stale file no longer fails loudly"
fi

# An empty record is a no-op, including under Bash 3.2 `set -u`.
(
    export REPO_ROOT
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    stamp_built_program_outputs
) || fail "the stamp step failed with no recorded outputs"

# build-programs.sh must use this step rather than sweep its output trees.
grep -F 'source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"' \
    "$REPO_ROOT/scripts/build-programs.sh" >/dev/null ||
    fail "build-programs.sh does not source the recorded-output stamp step"
grep -Fx 'stamp_built_program_outputs' "$REPO_ROOT/scripts/build-programs.sh" >/dev/null ||
    fail "build-programs.sh does not run the recorded-output stamp step"
if grep -F 'stamp-abi-contract' "$REPO_ROOT/scripts/build-programs.sh" >/dev/null; then
    fail "build-programs.sh stamps outside the recorded-output step"
fi

echo "test-build-programs-abi-stamp.sh: ok"
