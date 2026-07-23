#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
[ -n "$HOST_TARGET" ] || {
    echo "test-install-local-generation.sh: rustc did not report a host target" >&2
    exit 1
}

# This test is also invoked from package-build tests that intentionally export
# caller-owned output variables. Its direct-local scenarios must not inherit
# those sealed-build settings.
unset WASM_POSIX_DEP_OUT_DIR
unset WASM_POSIX_DEP_TARGET_ARCH
unset WASM_POSIX_INSTALL_LOCAL_MIRROR
unset WASM_POSIX_LOCAL_INSTALL_SESSION

work="$(mktemp -d)"
cleanup() {
    chmod -R u+w "$work" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT

fail() {
    echo "test-install-local-generation.sh: $*" >&2
    exit 1
}

registry="$work/registry"
package_dir="$registry/local-python"
mirror="$work/local-binaries"
fetched="$work/fetched-cache"
source_dir="$work/build-output"
mkdir -p "$package_dir" "$mirror/programs/wasm32/local-python" \
    "$fetched/bin" "$fetched/share" "$source_dir"

cat >"$package_dir/package.toml" <<'EOF'
kind = "program"
name = "local-python"
version = "1.0"
depends_on = []

[source]
url = "https://example.test/local-python.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[[outputs]]
name = "python"
wasm = "bin/python.wasm"

[[runtime_files]]
artifact = "share/python-runtime.zip"
guest_path = "/usr/share/local-python/python-runtime.zip"
EOF

# Minimal executables export the two normal program entry points. Distinct
# custom sections make fetched and local bytes observably different while
# retaining valid Wasm.
printf '\000asm\001\000\000\000\001\005\001\140\000\001\177\003\002\001\000\007\032\002\015__abi_version\000\000\006_start\000\000\012\006\001\004\000\101\000\013\000\006\005fetch' \
    >"$fetched/bin/python.wasm"
printf '\000asm\001\000\000\000\001\005\001\140\000\001\177\003\002\001\000\007\032\002\015__abi_version\000\000\006_start\000\000\012\006\001\004\000\101\000\013\000\006\005local' \
    >"$source_dir/python.wasm"
printf 'FETCHED-RUNTIME\n' >"$fetched/share/python-runtime.zip"
printf 'LOCAL-RUNTIME\n' >"$source_dir/python-runtime.zip"

ln -s "$fetched/bin/python.wasm" \
    "$mirror/programs/wasm32/local-python/python.wasm"
mkdir -p "$mirror/programs/wasm32/local-python/share"
ln -s "$fetched/share/python-runtime.zip" \
    "$mirror/programs/wasm32/local-python/share/python-runtime.zip"
fetched_wasm_before="$(shasum -a 256 "$fetched/bin/python.wasm" | awk '{print $1}')"
fetched_runtime_before="$(shasum -a 256 "$fetched/share/python-runtime.zip" | awk '{print $1}')"

run_install() {
    local artifact="$1"
    local source="$2"
    (
        cd "$REPO_ROOT"
        WASM_POSIX_DEPS_REGISTRY="$registry" \
        WASM_POSIX_LOCAL_INSTALL_SOURCE="$source" \
        WASM_POSIX_LOCAL_INSTALL_SESSION=direct-build-one \
            cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
                build-deps --arch wasm32 --binaries-dir "$mirror" \
                install-local-artifact local-python "$artifact"
    )
}

first_log="$work/first.log"
run_install python.wasm "$source_dir/python.wasm" >"$first_log"
grep -F 'waiting for 1 declared package artifact' "$first_log" >/dev/null ||
    fail "first closure member was reported as fully installed"
cmp "$fetched/bin/python.wasm" \
    "$mirror/programs/wasm32/local-python/python.wasm" >/dev/null ||
    fail "incomplete local generation changed the live executable"
cmp "$fetched/share/python-runtime.zip" \
    "$mirror/programs/wasm32/local-python/share/python-runtime.zip" >/dev/null ||
    fail "incomplete local generation changed the live runtime file"

generation="$mirror/.kandelo-local-generations/wasm32/local-python/direct-build-one"
cmp "$source_dir/python.wasm" "$generation/bin/python.wasm" >/dev/null ||
    fail "local output was not collected at its exact declared suffix"
[ ! -e "$generation/share/python-runtime.zip" ] ||
    fail "incomplete generation synthesized a missing runtime file"

second_log="$work/second.log"
run_install share/python-runtime.zip "$source_dir/python-runtime.zip" >"$second_log"
grep -F 'from complete local generation' "$second_log" >/dev/null ||
    fail "complete closure was not reported as published"
cmp "$source_dir/python.wasm" \
    "$mirror/programs/wasm32/local-python/python.wasm" >/dev/null ||
    fail "complete local generation did not publish the executable"
cmp "$source_dir/python-runtime.zip" \
    "$mirror/programs/wasm32/local-python/share/python-runtime.zip" >/dev/null ||
    fail "complete local generation did not publish the runtime file"
generation_physical="$(cd "$generation" && pwd -P)"
[ "$(readlink "$mirror/programs/wasm32/local-python/python.wasm")" = \
    "$generation_physical/bin/python.wasm" ] ||
    fail "live executable does not target the exact declared generation suffix"
[ "$(readlink "$mirror/programs/wasm32/local-python/share/python-runtime.zip")" = \
    "$generation_physical/share/python-runtime.zip" ] ||
    fail "live runtime file does not target the exact declared generation suffix"
[ "$fetched_wasm_before" = \
    "$(shasum -a 256 "$fetched/bin/python.wasm" | awk '{print $1}')" ] ||
    fail "direct build overwrote fetched canonical executable bytes"
[ "$fetched_runtime_before" = \
    "$(shasum -a 256 "$fetched/share/python-runtime.zip" | awk '{print $1}')" ] ||
    fail "direct build overwrote fetched canonical runtime bytes"

# The package-less alias fallback cannot use the manifest-driven Rust command,
# but it must keep the same no-follow invariant. A fake repo makes its mirror
# disposable, while an empty rustc probe deliberately selects the alias path.
fake_repo="$work/fake-repo"
fake_bin="$work/fake-bin"
legacy_canonical="$work/legacy-canonical.wasm"
legacy_source="$work/legacy-source.wasm"
mkdir -p "$fake_repo/scripts" \
    "$fake_repo/local-binaries/programs/wasm32" "$fake_bin"
cp "$REPO_ROOT/scripts/install-local-binary.sh" "$fake_repo/scripts/"
cp "$REPO_ROOT/scripts/wasm-artifact-guards.sh" "$fake_repo/scripts/"
cp "$fetched/bin/python.wasm" "$legacy_canonical"
cp "$source_dir/python.wasm" "$legacy_source"
ln -s "$legacy_canonical" \
    "$fake_repo/local-binaries/programs/wasm32/legacy-alias.wasm"
cat >"$fake_bin/rustc" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$fake_bin/rustc"
legacy_before="$(shasum -a 256 "$legacy_canonical" | awk '{print $1}')"
(
    PATH="$fake_bin:$PATH"
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
    export PATH WASM_POSIX_INSTALL_FORK_INSTRUMENTATION
    # shellcheck source=/dev/null
    source "$fake_repo/scripts/install-local-binary.sh"
    install_local_binary legacy-alias "$legacy_source"
)
legacy_dest="$fake_repo/local-binaries/programs/wasm32/legacy-alias.wasm"
[ ! -L "$legacy_dest" ] ||
    fail "legacy alias left the old destination symlink in place"
cmp "$legacy_source" "$legacy_dest" >/dev/null ||
    fail "legacy alias did not install local bytes"
[ "$legacy_before" = "$(shasum -a 256 "$legacy_canonical" | awk '{print $1}')" ] ||
    fail "legacy alias followed its destination symlink into canonical cache"

# A registered package is not an alias. Manifest parse errors and undeclared
# artifacts must stay visible instead of dropping into the compatibility copy
# path and publishing bytes at a guessed location.
mkdir -p "$fake_repo/packages/registry/registered"
printf 'malformed = [\n' >"$fake_repo/packages/registry/registered/package.toml"
cat >"$fake_bin/rustc" <<'EOF'
#!/usr/bin/env bash
printf 'host: fake-test-target\n'
EOF
cat >"$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf 'fixture manifest lookup failed\n' >&2
exit 19
EOF
chmod +x "$fake_bin/rustc" "$fake_bin/cargo"
registered_dest="$fake_repo/local-binaries/programs/wasm32/registered.wasm"
ln -s "$legacy_canonical" "$registered_dest"
registered_err="$work/registered.err"
if (
    PATH="$fake_bin:$PATH"
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
    export PATH WASM_POSIX_INSTALL_FORK_INSTRUMENTATION
    # shellcheck source=/dev/null
    source "$fake_repo/scripts/install-local-binary.sh"
    install_local_binary registered "$legacy_source"
) 2>"$registered_err"; then
    fail "registered package lookup failure fell through to the legacy copy path"
fi
grep -F "registered package 'registered' does not declare output" \
    "$registered_err" >/dev/null ||
    fail "registered package lookup failure was not explained"
[ -L "$registered_dest" ] ||
    fail "registered package lookup failure changed its existing mirror"
[ "$legacy_before" = "$(shasum -a 256 "$legacy_canonical" | awk '{print $1}')" ] ||
    fail "registered package lookup failure mutated canonical cache bytes"

echo "test-install-local-generation.sh: ok"
