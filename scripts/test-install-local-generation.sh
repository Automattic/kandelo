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

cache_key="$(
    cd "$REPO_ROOT"
    WASM_POSIX_DEPS_REGISTRY="$registry" \
        cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps --arch wasm32 sha local-python
)"
printf '%s\n' "$cache_key" | grep -Eq '^[0-9a-f]{64}$' ||
    fail "resolver did not return a full local generation cache identity"

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

generation="$mirror/.kandelo-local-generations/wasm32/local-python/$cache_key/direct-build-one"
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

# Undeclared package names must fail before changing either source bytes or a
# destination. A fake repo makes the negative path disposable.
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
printf 'host: fake-test-target\n'
EOF
cat >"$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf 'fixture manifest lookup failed\n' >&2
exit 19
EOF
chmod +x "$fake_bin/rustc" "$fake_bin/cargo"
legacy_before="$(shasum -a 256 "$legacy_canonical" | awk '{print $1}')"
legacy_source_before="$(shasum -a 256 "$legacy_source" | awk '{print $1}')"
legacy_err="$work/legacy.err"
if (
    PATH="$fake_bin:$PATH"
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
    export PATH WASM_POSIX_INSTALL_FORK_INSTRUMENTATION
    # shellcheck source=/dev/null
    source "$fake_repo/scripts/install-local-binary.sh"
    install_local_binary legacy-alias "$legacy_source"
) 2>"$legacy_err"; then
    fail "undeclared package was installed through a guessed path"
fi
legacy_dest="$fake_repo/local-binaries/programs/wasm32/legacy-alias.wasm"
[ -L "$legacy_dest" ] ||
    fail "failed package lookup changed its existing mirror"
[ "$legacy_before" = "$(shasum -a 256 "$legacy_canonical" | awk '{print $1}')" ] ||
    fail "failed package lookup mutated canonical cache bytes"
[ "$legacy_source_before" = "$(shasum -a 256 "$legacy_source" | awk '{print $1}')" ] ||
    fail "failed package lookup mutated source bytes before resolving policy"
grep -F "does not uniquely declare output" "$legacy_err" >/dev/null ||
    fail "undeclared package lookup failure was not explained"

# A selected malformed package also fails at the same pre-mutation lookup.
mkdir -p "$fake_repo/packages/registry/registered"
printf 'malformed = [\n' >"$fake_repo/packages/registry/registered/package.toml"
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
grep -F "package 'registered' does not uniquely declare output" \
    "$registered_err" >/dev/null ||
    fail "registered package lookup failure was not explained"
[ -L "$registered_dest" ] ||
    fail "registered package lookup failure changed its existing mirror"
[ "$legacy_before" = "$(shasum -a 256 "$legacy_canonical" | awk '{print $1}')" ] ||
    fail "registered package lookup failure mutated canonical cache bytes"

# Exact-build helpers may publish only artifacts produced by the command they
# just ran. In particular, a kernel-only Cargo build must never adopt an old
# userspace target that happens to remain in target/ from an earlier command.
for kernel_builder in \
    "$REPO_ROOT/build.sh" \
    "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"; do
    if grep -Fq 'wasm_posix_userspace.wasm' "$kernel_builder"; then
        fail "$(basename "$kernel_builder") opportunistically publishes a userspace artifact it did not build"
    fi
done
grep -Fq 'install_local_binary userspace "$OUT" wasm_posix_userspace.wasm' \
    "$REPO_ROOT/packages/registry/userspace/build-userspace.sh" ||
    fail "the userspace build does not own its direct local publication"

# Exercise the complete producer/consumer boundary with the real xtask and
# workspace packer. Unit tests cover the installer and resolver together, and
# the packer tests cover link relocation, but this fixture deliberately composes
# all four steps so neither side can silently weaken the other's identity
# contract.
composed_registry="$work/composed-registry"
composed_repo="$work/composed-repo"
composed_mirror="$composed_repo/local-binaries"
composed_sources="$work/composed-sources"
mkdir -p "$composed_registry" "$composed_mirror" "$composed_sources"

write_scalar_package() {
    local package="$1"
    local output="$2"
    local artifact="$3"
    local package_root="$composed_registry/$package"
    mkdir -p "$package_root"
    cat >"$package_root/package.toml" <<EOF
kind = "program"
name = "$package"
version = "1.0"
depends_on = []

[source]
url = "https://example.test/$package.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

# The resolver's declared default build hook is build-$package.sh beside this
# manifest. That hook copies the fixture's distinct fetched bytes into its
# caller-owned output root, so a successful resolve cannot be a no-op.
[[outputs]]
name = "$output"
wasm = "$artifact"
EOF
    cat >"$package_root/build-$package.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\$WASM_POSIX_DEP_OUT_DIR"
cp "\$(cd "\$(dirname "\$0")" && pwd)/fetched.wasm" \
    "\$WASM_POSIX_DEP_OUT_DIR/$artifact"
EOF
    chmod +x "$package_root/build-$package.sh"
}

write_program_wat() {
    local marker="$1"
    local output="$2"
    cat >"$work/program-$marker.wat" <<EOF
(module
  (func \$entry (result i32) i32.const 0)
  (export "__abi_version" (func \$entry))
  (export "_start" (func \$entry))
  (global (export "$marker") i32 (i32.const 1)))
EOF
    wat2wasm "$work/program-$marker.wat" -o "$output"
}

write_kernel_wat() {
    local marker="$1"
    local output="$2"
    local required_exports
    required_exports="$(
        jq -er '.host_adapter.required_kernel_exports[]' \
            "$REPO_ROOT/abi/snapshot.json"
    )" || fail "could not read required kernel exports from the ABI snapshot"
    [ -n "$required_exports" ] ||
        fail "ABI snapshot has no required kernel exports"
    {
        printf '%s\n' '(module' \
            '  (func $entry (result i32) i32.const 0)'
        # WHY: this fixture validates relocation, not an independent adapter
        # protocol. Reading the generated ABI evidence prevents every required
        # export change from creating a second hand-maintained manifest here.
        while IFS= read -r export_name; do
            printf '  (export "%s" (func $entry))\n' "$export_name"
        done <<<"$required_exports"
        printf '  (global (export "%s") i32 (i32.const 1)))\n' "$marker"
    } >"$work/kernel-$marker.wat"
    wat2wasm "$work/kernel-$marker.wat" -o "$output"
}

write_scalar_package scalar-proof scalar-proof scalar-proof.wasm
write_scalar_package kernel kernel kandelo-kernel.wasm
write_scalar_package userspace userspace wasm_posix_userspace.wasm

write_program_wat local_scalar "$composed_sources/scalar-proof.wasm"
write_program_wat fetched_scalar \
    "$composed_registry/scalar-proof/fetched.wasm"
write_kernel_wat local_kernel "$composed_sources/kandelo-kernel.wasm"
write_kernel_wat fetched_kernel "$composed_registry/kernel/fetched.wasm"
write_program_wat local_userspace \
    "$composed_sources/wasm_posix_userspace.wasm"
write_program_wat fetched_userspace \
    "$composed_registry/userspace/fetched.wasm"

real_xtask="$REPO_ROOT/target/$HOST_TARGET/debug/xtask"
[ -x "$real_xtask" ] ||
    fail "real xtask was not built at $real_xtask"

run_composed_xtask() {
    (
        cd "$REPO_ROOT"
        WASM_POSIX_DEPS_REGISTRY="$composed_registry" \
        WASM_POSIX_BINARY_CACHE_ROOT="$work/composed-cache" \
            "$real_xtask" "$@"
    )
}

install_composed_scalar() {
    local package="$1"
    local artifact="$2"
    local source="$3"
    WASM_POSIX_LOCAL_INSTALL_SOURCE="$source" \
    WASM_POSIX_LOCAL_INSTALL_SESSION="composed-$package" \
        run_composed_xtask \
            build-deps --arch wasm32 --binaries-dir "$composed_mirror" \
            install-local-artifact "$package" "$artifact"
}

install_composed_scalar \
    scalar-proof scalar-proof.wasm "$composed_sources/scalar-proof.wasm"
install_composed_scalar \
    kernel kandelo-kernel.wasm "$composed_sources/kandelo-kernel.wasm"
install_composed_scalar \
    userspace wasm_posix_userspace.wasm \
    "$composed_sources/wasm_posix_userspace.wasm"

mkdir -p \
    "$composed_repo/scripts" \
    "$composed_repo/host/wasm" \
    "$composed_repo/examples" \
    "$composed_repo/benchmarks/wasm" \
    "$composed_repo/target/$HOST_TARGET/release"
for packer_support in \
    pack-ci-test-workspace.sh \
    browser-memory64-example-fixtures.sh \
    browser-memory64-example-fixtures.txt; do
    cp "$REPO_ROOT/scripts/$packer_support" "$composed_repo/scripts/"
done
: >"$composed_repo/host/wasm/rootfs.vfs"
for required in \
    gencat.wasm \
    pthread_channel_reuse_test.wasm \
    wait_lifecycle_test.wasm; do
    : >"$composed_repo/examples/$required"
done
memory64_sources="$(
    BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$REPO_ROOT"
    BROWSER_MEMORY64_FIXTURES_MANIFEST="$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt"
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh"
    browser_memory64_fixture_sources
)" || fail "could not read the browser memory64 fixture contract"
while IFS= read -r source; do
    cp "$REPO_ROOT/$source" "$composed_repo/$source"
    : >"$composed_repo/${source%.c}.wasm64.wasm"
done <<<"$memory64_sources"
for required in \
    pipe-throughput.wasm \
    file-throughput.wasm \
    syscall-latency.wasm \
    fork-bench.wasm \
    clone-bench.wasm \
    spawn-bench.wasm \
    hello.wasm; do
    : >"$composed_repo/benchmarks/wasm/$required"
done
cp "$real_xtask" "$composed_repo/target/$HOST_TARGET/release/xtask"

composed_archive="$work/composed-workspace.tar.zst"
(
    cd "$composed_repo"
    WASM_POSIX_DEPS_REGISTRY="$composed_registry" \
        bash scripts/pack-ci-test-workspace.sh "$composed_archive"
)
relocated="$work/composed-relocated"
mkdir -p "$relocated"
tar --zstd -xf "$composed_archive" -C "$relocated"

resolve_relocated_scalar() {
    local package="$1"
    local mirror_root="$2"
    run_composed_xtask \
        build-deps --arch wasm32 --binaries-dir "$mirror_root" \
        resolve "$package"
}

scalar_mirror="$relocated/local-binaries/programs/wasm32/scalar-proof.wasm"
kernel_mirror="$relocated/local-binaries/kernel.wasm"
userspace_mirror="$relocated/local-binaries/userspace.wasm"
for relocated_mirror in \
    "$scalar_mirror" \
    "$kernel_mirror" \
    "$userspace_mirror"; do
    [ -L "$relocated_mirror" ] ||
        fail "packer flattened a composed local generation: $relocated_mirror"
    case "$(readlink "$relocated_mirror")" in
        /*) fail "packer retained an absolute composed mirror: $relocated_mirror" ;;
    esac
done

scalar_target_before="$(readlink "$scalar_mirror")"
kernel_target_before="$(readlink "$kernel_mirror")"
userspace_target_before="$(readlink "$userspace_mirror")"
scalar_canonical="$(
    resolve_relocated_scalar scalar-proof "$relocated/local-binaries"
)"
kernel_canonical="$(
    resolve_relocated_scalar kernel "$relocated/local-binaries"
)"
userspace_canonical="$(
    resolve_relocated_scalar userspace "$relocated/local-binaries"
)"
cmp "$composed_registry/scalar-proof/fetched.wasm" \
    "$scalar_canonical/scalar-proof.wasm" >/dev/null ||
    fail "ordinary dependency resolve did not produce distinct canonical bytes"
cmp "$composed_registry/kernel/fetched.wasm" \
    "$kernel_canonical/kandelo-kernel.wasm" >/dev/null ||
    fail "kernel dependency resolve did not produce distinct canonical bytes"
cmp "$composed_registry/userspace/fetched.wasm" \
    "$userspace_canonical/wasm_posix_userspace.wasm" >/dev/null ||
    fail "userspace dependency resolve did not produce distinct canonical bytes"
[ "$(readlink "$scalar_mirror")" = "$scalar_target_before" ] ||
    fail "dependency resolution retargeted the relocated ordinary scalar"
[ "$(readlink "$kernel_mirror")" = "$kernel_target_before" ] ||
    fail "dependency resolution retargeted the relocated kernel"
[ "$(readlink "$userspace_mirror")" = "$userspace_target_before" ] ||
    fail "dependency resolution retargeted the relocated userspace adapter"
cmp "$composed_sources/scalar-proof.wasm" "$scalar_mirror" >/dev/null ||
    fail "relocated ordinary scalar lost its exact local bytes"
cmp "$composed_sources/kandelo-kernel.wasm" "$kernel_mirror" >/dev/null ||
    fail "relocated kernel lost its exact local bytes"
cmp "$composed_sources/wasm_posix_userspace.wasm" \
    "$userspace_mirror" >/dev/null ||
    fail "relocated userspace adapter lost its exact local bytes"

# Changing a declared build input changes the contextual cache identity. The
# relocated old generation must fail closed instead of yielding to newly built
# release bytes.
scalar_manifest="$composed_registry/scalar-proof/package.toml"
sed 's/^version = "1.0"$/version = "1.1"/' \
    "$scalar_manifest" >"$work/scalar-proof.changed.toml"
mv "$work/scalar-proof.changed.toml" "$scalar_manifest"
stale_err="$work/composed-stale.err"
if resolve_relocated_scalar \
    scalar-proof "$relocated/local-binaries" \
    >"$work/composed-stale.out" 2>"$stale_err"; then
    fail "relocated stale local generation was silently substituted"
fi
grep -F 'selects stale local generation cache identity' "$stale_err" >/dev/null ||
    fail "relocated stale generation rejection was not explained"
[ "$(readlink "$scalar_mirror")" = "$scalar_target_before" ] ||
    fail "stale identity rejection retargeted the local scalar"
cmp "$composed_sources/scalar-proof.wasm" "$scalar_mirror" >/dev/null ||
    fail "stale identity rejection changed exact local scalar bytes"

# A regular file carries bytes but no generation identity. Even when its bytes
# match the candidate, dependency placement must not infer ownership from
# content and replace it.
regular_relocated="$work/composed-regular-relocated"
mkdir -p "$regular_relocated"
cp -a "$relocated/local-binaries" "$regular_relocated/local-binaries"
regular_userspace="$regular_relocated/local-binaries/userspace.wasm"
cp "$regular_userspace" "$regular_relocated/userspace.wasm"
rm "$regular_userspace"
mv "$regular_relocated/userspace.wasm" "$regular_userspace"
regular_before="$(shasum -a 256 "$regular_userspace" | awk '{print $1}')"
regular_err="$work/composed-regular.err"
if resolve_relocated_scalar \
    userspace "$regular_relocated/local-binaries" \
    >"$work/composed-regular.out" 2>"$regular_err"; then
    fail "identityless relocated regular scalar was silently replaced"
fi
grep -F 'refusing to replace regular file at scalar mirror' \
    "$regular_err" >/dev/null ||
    fail "identityless relocated scalar rejection was not explained"
[ ! -L "$regular_userspace" ] ||
    fail "identityless relocated scalar became a resolver symlink"
[ "$regular_before" = \
    "$(shasum -a 256 "$regular_userspace" | awk '{print $1}')" ] ||
    fail "identityless relocated scalar changed during rejection"

echo "test-install-local-generation.sh: ok"
