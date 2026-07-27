#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FIXTURE="$TMP_DIR/repo"
mkdir -p \
    "$FIXTURE/scripts" \
    "$FIXTURE/host" \
    "$FIXTURE/host/wasm" \
    "$FIXTURE/local-binaries" \
    "$FIXTURE/examples" \
    "$FIXTURE/benchmarks/wasm" \
    "$FIXTURE/apps/browser-demos" \
    "$FIXTURE/apps/browser-demos/public" \
    "$FIXTURE/bin"
cp \
    "$REPO_ROOT/scripts/ci-run-test-suite.sh" \
    "$REPO_ROOT/scripts/pack-ci-test-workspace.sh" \
    "$REPO_ROOT/scripts/stage-portable-resolver-binaries.sh" \
    "$FIXTURE/scripts/"

cat > "$FIXTURE/bin/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FIXTURE/bin/npx" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "tsx" ] &&
    [ "${2:-}" = "scripts/recover-homebrew-bottle-mirror.ts" ]; then
    printf '%s\n' "$*" > "$RECOVERY_CAPTURE"
    shift 2
    out=""
    report=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --image) shift 2 ;;
            --out) out="$2"; shift 2 ;;
            --report) report="$2"; shift 2 ;;
            *) exit 2 ;;
        esac
    done
    mkdir -p "$out"
    printf '{}\n' > "$out/kandelo-homebrew-bottle-mirror-plan.json"
    printf '{}\n' > "$report"
    exit 0
fi
if [ "${1:-}" = "playwright" ] && [ "${2:-}" = "test" ] &&
    [ -n "${CLOSED_ROOT_CAPTURE:-}" ]; then
    printf '%s\n' "${VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT:-}" \
        >> "$CLOSED_ROOT_CAPTURE"
fi
exit 0
EOF

cat > "$FIXTURE/bin/uname" <<'EOF'
#!/usr/bin/env bash
echo Darwin
EOF

cat > "$FIXTURE/bin/rustc" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-vV" ]; then
    echo "host: fixture-host"
    exit 0
fi
exit 2
EOF

cat > "$FIXTURE/run.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$RUN_CAPTURE"
if [ -n "${RUN_CACHE_CAPTURE:-}" ]; then
    printf '%s\n' "${WASM_POSIX_BINARY_CACHE_ROOT:-}" > "$RUN_CACHE_CAPTURE"
fi
if [ -n "${RUN_XTASK_CAPTURE:-}" ]; then
    printf '%s\n' "${WASM_POSIX_XTASK_BIN:-}" > "$RUN_XTASK_CAPTURE"
fi
EOF

cat > "$FIXTURE/scripts/ci-check-browser-assets.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FIXTURE/scripts/resolve-binary.sh" <<'EOF'
#!/usr/bin/env bash
[ "$#" -eq 1 ] && [ "$1" = "programs/shell.vfs.zst" ] || exit 2
printf '%s\n' "$FIXTURE_SHELL_IMAGE"
EOF

cat > "$FIXTURE/scripts/materialize-ci-publication-blockers.sh" <<'EOF'
#!/usr/bin/env bash
printf 'materialized\n' > "$BLOCKER_CAPTURE"
EOF

for runner in run-libc-tests.sh run-sortix-tests.sh; do
    cat > "$FIXTURE/scripts/$runner" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$TEST_CAPTURE"
if [ -n "${CACHE_CAPTURE:-}" ]; then
    printf '%s\n' "${WASM_POSIX_BINARY_CACHE_ROOT:-}" > "$CACHE_CAPTURE"
fi
if [ -n "${XTASK_CAPTURE:-}" ]; then
    printf '%s\n' "${WASM_POSIX_XTASK_BIN:-}" > "$XTASK_CAPTURE"
fi
EOF
    chmod +x "$FIXTURE/scripts/$runner"
done
chmod +x \
    "$FIXTURE/bin/npm" \
    "$FIXTURE/bin/npx" \
    "$FIXTURE/bin/rustc" \
    "$FIXTURE/bin/uname" \
    "$FIXTURE/run.sh" \
    "$FIXTURE/scripts/ci-check-browser-assets.sh" \
    "$FIXTURE/scripts/resolve-binary.sh" \
    "$FIXTURE/scripts/materialize-ci-publication-blockers.sh"

run_group() {
    local suite="$1"
    local group="$2"
    local expected="$3"
    local capture="$TMP_DIR/${suite}-${group}.args"
    PATH="$FIXTURE/bin:$PATH" TEST_CAPTURE="$capture" \
        bash "$FIXTURE/scripts/ci-run-test-suite.sh" "$suite" "$group"
    grep -Fxq -- "$expected" "$capture" || {
        echo "$suite/$group mapped to '$(cat "$capture")', expected '$expected'" >&2
        exit 1
    }
}

run_group libc functional-regression "functional regression"
run_group libc math "math"
run_group libc all ""
run_group sortix include "include"
run_group sortix basic "basic"
run_group sortix runtime "limits malloc stdio io signal process paths udp"
run_group sortix all "--all"

capture="$TMP_DIR/env-group.args"
PATH="$FIXTURE/bin:$PATH" TEST_CAPTURE="$capture" TEST_GROUP=math \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" libc
grep -Fxq math "$capture"

if PATH="$FIXTURE/bin:$PATH" TEST_CAPTURE="$TMP_DIR/invalid.args" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" libc invalid \
    > "$TMP_DIR/invalid.out" 2>&1; then
    echo "invalid libc group unexpectedly succeeded" >&2
    exit 1
fi
grep -Fq "unknown libc test group: invalid" "$TMP_DIR/invalid.out"

browser_capture="$TMP_DIR/browser-run.args"
blocker_capture="$TMP_DIR/browser-blockers"
recovery_capture="$TMP_DIR/browser-recovery.args"
closed_root_capture="$TMP_DIR/browser-closed-root"
fixture_shell_image="$TMP_DIR/shell.vfs.zst"
runner_temp="$TMP_DIR/runner"
printf 'shell image\n' > "$fixture_shell_image"
mkdir "$runner_temp"
cat > "$FIXTURE/.ci-test-publication-blockers.json" <<'EOF'
{"entries":[{"package":"shell"}]}
EOF
PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    RECOVERY_CAPTURE="$recovery_capture" \
    CLOSED_ROOT_CAPTURE="$closed_root_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    RUNNER_TEMP="$runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser
grep -Fxq materialized "$blocker_capture"
grep -Fxq -- \
    "--already-materialized --fetch-only prepare-browser" \
    "$browser_capture"
grep -Fq -- \
    "tsx scripts/recover-homebrew-bottle-mirror.ts --image $fixture_shell_image --out $FIXTURE/apps/browser-demos/public/homebrew-main-shell-bottles --report " \
    "$recovery_capture"
grep -Eq -- \
    "--report $runner_temp/kandelo-ci-homebrew-browser\\.[^/]+/recovery\\.json$" \
    "$recovery_capture"
[ "$(grep -Fxc /homebrew-main-shell-bottles "$closed_root_capture")" -eq 2 ] || {
    echo "browser Playwright invocations did not inherit the closed mirror root" >&2
    exit 1
}
[ ! -e "$FIXTURE/apps/browser-demos/public/homebrew-main-shell-bottles" ] || {
    echo "browser suite left its pre-merge Homebrew mirror behind" >&2
    exit 1
}
printf '{\n' > "$FIXTURE/.ci-test-publication-blockers.json"
if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    PREPARE_BROWSER_ASSETS=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
        > "$TMP_DIR/browser-invalid-blockers.out" 2>&1; then
    echo "browser suite accepted a malformed publication blocker report" >&2
    exit 1
fi
grep -Fq \
    "ci-run-test-suite: invalid publication blocker report" \
    "$TMP_DIR/browser-invalid-blockers.out"

for workflow in \
    "$REPO_ROOT/.github/workflows/staging-build.yml" \
    "$REPO_ROOT/.github/workflows/prepare-merge.yml"; do
    grep -Fq 'PREPARE_BROWSER_ASSETS="$PREPARE_BROWSER_ASSETS" \' "$workflow" || {
        echo "$(basename "$workflow"): browser preparation is not passed through the dev shell" >&2
        exit 1
    }
    grep -Fq 'bash scripts/ci-run-test-suite.sh "$SUITE" "$TEST_GROUP"' "$workflow" || {
        echo "$(basename "$workflow"): test group is not passed positionally through the dev shell" >&2
        exit 1
    }

    matrix_rows=$(sed -n '/^  test-suite:/,/^    env:/p' "$workflow" | awk '
        /^          - suite: / {
            suite = $0
            sub(/^          - suite: /, "", suite)
        }
        /^            group: / {
            group = $0
            sub(/^            group: /, "", group)
            print suite ":" group
        }
    ')
    expected_rows=$'vitest:all\nbrowser:all\nlibc:functional-regression\nlibc:math\nposix:all\nsortix:include\nsortix:basic\nsortix:runtime'
    if [ "$matrix_rows" != "$expected_rows" ]; then
        echo "$(basename "$workflow"): unexpected test-suite matrix:" >&2
        printf '%s\n' "$matrix_rows" >&2
        exit 1
    fi
done

force_rebuild_workflow="$REPO_ROOT/.github/workflows/force-rebuild.yml"
grep -Fq 'name: test-suite (${{ matrix.label }})' \
    "$force_rebuild_workflow" || {
    echo "force-rebuild.yml: sharded suite jobs do not use unique labels" >&2
    exit 1
}
grep -Fq 'TEST_GROUP: ${{ matrix.group }}' \
    "$force_rebuild_workflow" || {
    echo "force-rebuild.yml: matrix group is not exposed to the suite step" >&2
    exit 1
}
grep -Fq 'bash scripts/ci-run-test-suite.sh "$SUITE" "$TEST_GROUP"' \
    "$force_rebuild_workflow" || {
    echo "force-rebuild.yml: test group is not passed positionally through the dev shell" >&2
    exit 1
}

force_rebuild_rows=$(sed -n \
    '/^  test-suite:/,/^    env:/p' \
    "$force_rebuild_workflow" | awk '
    /^          - suite: / {
        suite = $0
        sub(/^          - suite: /, "", suite)
    }
    /^            group: / {
        group = $0
        sub(/^            group: /, "", group)
        print suite ":" group
    }
')
expected_force_rebuild_rows=$'cargo-kernel:all\nfork-instrument:all\nvitest:all\nlibc:functional-regression\nlibc:math\nposix:all\nsortix:include\nsortix:basic\nsortix:runtime'
if [ "$force_rebuild_rows" != "$expected_force_rebuild_rows" ]; then
    echo "force-rebuild.yml: unexpected test-suite matrix:" >&2
    printf '%s\n' "$force_rebuild_rows" >&2
    exit 1
fi

force_rebuild_gate=$(sed -n \
    '/^  test-gate:/,/^  # publish/p' \
    "$force_rebuild_workflow")
grep -Fq 'needs: [test-gate-prepare, test-suite]' \
    <<<"$force_rebuild_gate" || {
    echo "force-rebuild.yml: test gate no longer depends on the complete suite matrix" >&2
    exit 1
}
grep -Fq 'TEST_SUITE_RESULT: ${{ needs.test-suite.result }}' \
    <<<"$force_rebuild_gate" || {
    echo "force-rebuild.yml: test gate no longer receives the suite matrix result" >&2
    exit 1
}
grep -Fq 'if [ "$TEST_SUITE_RESULT" != "success" ]; then' \
    <<<"$force_rebuild_gate" || {
    echo "force-rebuild.yml: test gate no longer rejects a failed suite matrix" >&2
    exit 1
}

prepared_xtask="$FIXTURE/target/fixture-host/release/xtask"
mkdir -p "$(dirname "$prepared_xtask")"
cat > "$prepared_xtask" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "build-deps" ] && [ "${2:-}" = "cache-root" ] &&
   [ "$#" -eq 2 ]; then
    case "${WASM_POSIX_BINARY_CACHE_ROOT:-}" in
        /*) printf '%s\n' "$WASM_POSIX_BINARY_CACHE_ROOT" ;;
        *) printf '%s\n' "$PWD/${WASM_POSIX_BINARY_CACHE_ROOT:-.cache/kandelo}" ;;
    esac
    exit 0
fi
if [ "${1:-}" = "build-deps" ]; then
    shift
    arch=""
    if [ "${1:-}" = "--arch" ]; then
        arch="${2:-}"
        shift 2
    fi
    case "${1:-}" in
        sha)
            [ "$arch" = wasm32 ] || exit 2
            case "${2:-}" in
                kernel|local-fixture|local-one)
                    printf 'a%.0s' {1..64}
                    printf '\n'
                    exit 0
                    ;;
            esac
            ;;
        output-metadata)
            case "${2:-}:${3:-}" in
                kernel:kernel.wasm)
                    printf '%s\n' \
                        '{"source_artifact":"kernel.wasm","mirror_path":"kernel.wasm"}'
                    exit 0
                    ;;
                local-fixture:bin/local.wasm)
                    printf '%s\n' \
                        '{"source_artifact":"bin/local.wasm","mirror_path":"local-fixture/local.wasm"}'
                    exit 0
                    ;;
                local-one:bin/local-one.wasm)
                    printf '%s\n' \
                        '{"source_artifact":"bin/local-one.wasm","mirror_path":"local-one.wasm"}'
                    exit 0
                    ;;
            esac
            ;;
        runtime-file-metadata)
            exit 2
            ;;
    esac
fi
exit 2
EOF
chmod +x "$prepared_xtask"

mkdir -p "$FIXTURE/.ci-test-binary-cache/programs"
cache_capture="$TMP_DIR/portable-cache-root"
xtask_capture="$TMP_DIR/portable-xtask"
PATH="$FIXTURE/bin:$PATH" \
    TEST_CAPTURE="$TMP_DIR/portable-cache-suite.args" \
    CACHE_CAPTURE="$cache_capture" \
    XTASK_CAPTURE="$xtask_capture" \
    WASM_POSIX_BINARY_CACHE_ROOT="$TMP_DIR/wrong-cache" \
    WASM_POSIX_XTASK_BIN="$TMP_DIR/wrong-xtask" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" libc all
grep -Fxq "$FIXTURE/.ci-test-binary-cache" "$cache_capture" || {
    echo "ci-run-test-suite.sh did not select the transported program cache" >&2
    exit 1
}
grep -Fxq "$prepared_xtask" "$xtask_capture" || {
    echo "ci-run-test-suite.sh did not select the transported package checker" >&2
    exit 1
}
missing_xtask_capture="$TMP_DIR/missing-xtask-suite.args"
chmod -x "$prepared_xtask"
if PATH="$FIXTURE/bin:$PATH" \
    TEST_CAPTURE="$missing_xtask_capture" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" libc all \
    > "$TMP_DIR/missing-xtask.out" 2>&1; then
    echo "ci-run-test-suite.sh accepted a non-executable transported package checker" >&2
    exit 1
fi
grep -Fq \
    "missing executable prepared package checker: $prepared_xtask" \
    "$TMP_DIR/missing-xtask.out"
[ ! -e "$missing_xtask_capture" ] || {
    echo "ci-run-test-suite.sh dispatched a suite without its transported package checker" >&2
    exit 1
}
chmod +x "$prepared_xtask"
rm -rf "$FIXTURE/.ci-test-binary-cache"

prepared_files=(
    target/fixture-host/release/xtask
    local-binaries/kernel.wasm
    host/wasm/rootfs.vfs
    examples/gencat.wasm
    examples/pthread_channel_reuse_test.wasm
    examples/wait_lifecycle_test.wasm
    examples/wait_lifecycle_test.wasm64.wasm
    examples/terminal_attributes_api_test.wasm64.wasm
)
for benchmark in \
    pipe-throughput.wasm \
    file-throughput.wasm \
    syscall-latency.wasm \
    fork-bench.wasm \
    clone-bench.wasm \
    spawn-bench.wasm \
    hello.wasm; do
    prepared_files+=("benchmarks/wasm/$benchmark")
done
for prepared in "${prepared_files[@]}"; do
    mkdir -p "$FIXTURE/$(dirname "$prepared")"
    if [ "$prepared" != "target/fixture-host/release/xtask" ]; then
        : > "$FIXTURE/$prepared"
    fi
done

cache_key="$(printf 'a%.0s' {1..64})"
generation="fixture-1.0.0-rev1-wasm32-$cache_key"
one_member_generation="one-member-1.0.0-rev1-wasm32-$cache_key"
source_cache="$TMP_DIR/source-cache"
local_kernel="$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/kernel/$cache_key/session/kernel.wasm"
mkdir -p \
    "$source_cache/programs/$generation/bin" \
    "$source_cache/programs/$generation/share" \
    "$source_cache/programs/$one_member_generation/bin" \
    "$FIXTURE/binaries/programs/wasm32/fixture" \
    "$(dirname "$local_kernel")" \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-one/$cache_key/session/bin" \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-fixture/$cache_key/session/bin" \
    "$FIXTURE/local-binaries/programs/wasm32/local-fixture"
printf 'fixture program\n' \
    > "$source_cache/programs/$generation/bin/fixture.wasm"
printf 'fixture runtime\n' \
    > "$source_cache/programs/$generation/share/runtime.dat"
printf 'one member package\n' \
    > "$source_cache/programs/$one_member_generation/bin/one-member.wasm"
printf 'local fixture\n' \
    > "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-fixture/$cache_key/session/bin/local.wasm"
printf 'local one member package\n' \
    > "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-one/$cache_key/session/bin/local-one.wasm"
printf 'local kernel\n' > "$local_kernel"
for claimed_identity in \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/kernel/$cache_key" \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-fixture/$cache_key" \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-one/$cache_key"; do
    : > "$claimed_identity/.session.publication-claimed"
done
rm "$FIXTURE/local-binaries/kernel.wasm"
ln -s "$local_kernel" "$FIXTURE/local-binaries/kernel.wasm"
ln -s \
    "$source_cache/programs/$generation/bin/fixture.wasm" \
    "$FIXTURE/binaries/programs/wasm32/fixture/fixture.wasm"
ln -s \
    "$source_cache/programs/$generation/share/runtime.dat" \
    "$FIXTURE/binaries/programs/wasm32/fixture/runtime.dat"
ln -s \
    "$source_cache/programs/$one_member_generation/bin/one-member.wasm" \
    "$FIXTURE/binaries/programs/wasm32/one-member.wasm"
ln -s \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-fixture/$cache_key/session/bin/local.wasm" \
    "$FIXTURE/local-binaries/programs/wasm32/local-fixture/local.wasm"
ln -s \
    "$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/local-one/$cache_key/session/bin/local-one.wasm" \
    "$FIXTURE/local-binaries/programs/wasm32/local-one.wasm"

scalar_source="$TMP_DIR/scalar-kernel.wasm"
printf 'scalar kernel\n' > "$scalar_source"
ln -s "$scalar_source" "$FIXTURE/binaries/kernel.wasm"

outside_source="$TMP_DIR/outside-program.wasm"
printf 'outside program\n' > "$outside_source"
ln -s \
    "$outside_source" \
    "$FIXTURE/binaries/programs/wasm32/outside.wasm"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/rejected-workspace.tar.zst" \
        > "$TMP_DIR/rejected-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted a program mirror outside the selected cache" >&2
    exit 1
fi
grep -Fq "program resolver link targets a noncanonical cache" \
    "$TMP_DIR/rejected-workspace.out"
rm "$FIXTURE/binaries/programs/wasm32/outside.wasm"

printf 'flattened program\n' \
    > "$FIXTURE/binaries/programs/wasm32/flattened.wasm"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/flattened-workspace.tar.zst" \
        > "$TMP_DIR/flattened-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted a flattened fetched program mirror" >&2
    exit 1
fi
grep -Fq "fetched program mirrors must remain generation symlinks" \
    "$TMP_DIR/flattened-workspace.out"
rm "$FIXTURE/binaries/programs/wasm32/flattened.wasm"

ln -s \
    "$outside_source" \
    "$source_cache/programs/$generation/share/escaping-link"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/escaping-workspace.tar.zst" \
        > "$TMP_DIR/escaping-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted an escaping cache-generation link" >&2
    exit 1
fi
grep -Fq "portable resolver closure contains an absolute, dangling, or escaping link" \
    "$TMP_DIR/escaping-workspace.out" || {
    cat "$TMP_DIR/escaping-workspace.out" >&2
    echo "pack-ci-test-workspace.sh did not explain the escaping cache-generation link" >&2
    exit 1
}
rm "$source_cache/programs/$generation/share/escaping-link"

local_outside_generation="$FIXTURE/local-binaries/not-a-generation/local.wasm"
mkdir -p \
    "$(dirname "$local_outside_generation")" \
    "$FIXTURE/local-binaries/programs/wasm32/outside-local"
printf 'outside local generation\n' > "$local_outside_generation"
ln -s \
    "$local_outside_generation" \
    "$FIXTURE/local-binaries/programs/wasm32/outside-local/outside-local.wasm"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/outside-local-workspace.tar.zst" \
        > "$TMP_DIR/outside-local-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted a local program outside its generation cache" >&2
    exit 1
fi
# GNU/Linux can translate this source-contained absolute link into a staged
# relative path before the generation-shape check, while Darwin's /tmp alias
# reaches the earlier external-target check. Both reject the same forbidden
# ownership claim, so assert the stable safety outcome instead of one host's
# diagnostic order.
if ! grep -Fq "staged local resolver link retains an external absolute target" \
        "$TMP_DIR/outside-local-workspace.out" &&
   ! grep -Fq "local program resolver link targets a noncanonical generation" \
        "$TMP_DIR/outside-local-workspace.out"; then
    cat "$TMP_DIR/outside-local-workspace.out" >&2
    echo "pack-ci-test-workspace.sh did not explain the non-generation local program" >&2
    exit 1
fi
rm -rf \
    "$FIXTURE/local-binaries/programs/wasm32/outside-local" \
    "$FIXTURE/local-binaries/not-a-generation"

# A matching generation suffix is not sufficient ownership evidence. Keep a
# valid internal generation in place while selecting different bytes through an
# external lookalike namespace; the packer must reject instead of silently
# substituting the internal member with the same identity.
external_generation="$TMP_DIR/external-local-binaries/.kandelo-local-generations/wasm32/kernel/$cache_key/session"
mkdir -p "$external_generation"
printf 'external lookalike kernel\n' > "$external_generation/kernel.wasm"
rm "$FIXTURE/local-binaries/kernel.wasm"
ln -s "$external_generation/kernel.wasm" "$FIXTURE/local-binaries/kernel.wasm"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/external-generation-workspace.tar.zst" \
        > "$TMP_DIR/external-generation-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted an external lookalike local generation" >&2
    exit 1
fi
grep -Fq "staged local resolver link has an untrusted generation namespace root" \
    "$TMP_DIR/external-generation-workspace.out"
rm "$FIXTURE/local-binaries/kernel.wasm"
ln -s "$local_kernel" "$FIXTURE/local-binaries/kernel.wasm"

# Kernel and userspace compatibility paths are package mirrors. Regular bytes
# at either path have no generation/cache ownership and must never enter a
# prepared workspace.
cp "$local_kernel" "$TMP_DIR/regular-kernel.wasm"
rm "$FIXTURE/local-binaries/kernel.wasm"
cp "$TMP_DIR/regular-kernel.wasm" "$FIXTURE/local-binaries/kernel.wasm"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/regular-kernel-workspace.tar.zst" \
        > "$TMP_DIR/regular-kernel-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted an identityless regular kernel mirror" >&2
    exit 1
fi
grep -Fq "package-owned root mirror must remain a local-generation symlink" \
    "$TMP_DIR/regular-kernel-workspace.out"
rm "$FIXTURE/local-binaries/kernel.wasm"
ln -s "$local_kernel" "$FIXTURE/local-binaries/kernel.wasm"

printf 'identityless userspace\n' > "$FIXTURE/local-binaries/userspace.wasm"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/regular-userspace-workspace.tar.zst" \
        > "$TMP_DIR/regular-userspace-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted an identityless regular userspace mirror" >&2
    exit 1
fi
grep -Fq "package-owned root mirror must remain a local-generation symlink" \
    "$TMP_DIR/regular-userspace-workspace.out"
rm "$FIXTURE/local-binaries/userspace.wasm"

printf 'internal but identityless root bytes\n' \
    > "$FIXTURE/local-binaries/not-a-generation.wasm"
for package_owned_root in kernel userspace; do
    root_mirror="$FIXTURE/local-binaries/$package_owned_root.wasm"
    if [ "$package_owned_root" = kernel ]; then
        rm "$root_mirror"
    fi
    ln -s "not-a-generation.wasm" "$root_mirror"
    if PATH="$FIXTURE/bin:$PATH" \
        WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
        bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
            "$TMP_DIR/internal-$package_owned_root-workspace.tar.zst" \
            > "$TMP_DIR/internal-$package_owned_root-workspace.out" 2>&1; then
        echo "pack-ci-test-workspace.sh accepted an internal identityless $package_owned_root mirror" >&2
        exit 1
    fi
    grep -Fq "package-owned root mirror must select a declared local generation" \
        "$TMP_DIR/internal-$package_owned_root-workspace.out"
    rm "$root_mirror"
    if [ "$package_owned_root" = kernel ]; then
        ln -s "$local_kernel" "$root_mirror"
    fi
done
rm "$FIXTURE/local-binaries/not-a-generation.wasm"

mv "$FIXTURE/binaries/programs" "$TMP_DIR/programs-with-package-mirrors"
PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$TMP_DIR/nonexistent-scalar-cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/scalar-only-workspace.tar.zst"
scalar_extract="$TMP_DIR/scalar-only-extract"
mkdir -p "$scalar_extract"
tar --zstd -xf "$TMP_DIR/scalar-only-workspace.tar.zst" -C "$scalar_extract"
[ -f "$scalar_extract/binaries/kernel.wasm" ] && \
    [ ! -L "$scalar_extract/binaries/kernel.wasm" ] || {
    echo "pack-ci-test-workspace.sh: scalar-only workspace was not self-contained" >&2
    exit 1
}
[ -L "$scalar_extract/local-binaries/kernel.wasm" ] || {
    echo "pack-ci-test-workspace.sh: scalar-only workspace flattened its package-owned root scalar" >&2
    exit 1
}
case "$(readlink "$scalar_extract/local-binaries/kernel.wasm")" in
    /*)
        echo "pack-ci-test-workspace.sh: scalar-only workspace retained an absolute local generation link" >&2
        exit 1
        ;;
esac
cmp \
    "$scalar_extract/local-binaries/kernel.wasm" \
    "$scalar_extract/local-binaries/.kandelo-local-generations/wasm32/kernel/$cache_key/session/kernel.wasm"
if tar --zstd -tf "$TMP_DIR/scalar-only-workspace.tar.zst" |
   grep -q '^\.ci-test-binary-cache/'; then
    echo "pack-ci-test-workspace.sh: scalar-only workspace invented a program cache" >&2
    exit 1
fi
mv "$TMP_DIR/programs-with-package-mirrors" "$FIXTURE/binaries/programs"

pack_archive="$TMP_DIR/workspace.tar.zst"
publication_blockers="$TMP_DIR/publication-blockers.json"
printf '%s\n' \
    '{"abi_version":42,"entries":[{"package":"shell","blocker_chain":["shell"]}]}' \
    > "$publication_blockers"
PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        --publication-blockers "$publication_blockers" \
        "$pack_archive"
pack_capture="$TMP_DIR/pack.list"
tar --zstd -tf "$pack_archive" > "$pack_capture"
grep -Fxq ".ci-test-publication-blockers.json" "$pack_capture" || {
    echo "pack-ci-test-workspace.sh: omitted publication blocker report" >&2
    exit 1
}
for prepared in "${prepared_files[@]}"; do
    grep -Fxq "$prepared" "$pack_capture" || {
        echo "pack-ci-test-workspace.sh: omitted prepared artifact $prepared" >&2
        exit 1
    }
done
pack_extract="$TMP_DIR/pack-extract"
mkdir -p "$pack_extract"
tar --zstd -xf "$pack_archive" -C "$pack_extract"
cmp \
    "$publication_blockers" \
    "$pack_extract/.ci-test-publication-blockers.json"
if [ ! -x "$pack_extract/target/fixture-host/release/xtask" ]; then
    echo "pack-ci-test-workspace.sh: package resolver lost its executable mode" >&2
    exit 1
fi
for member in fixture.wasm runtime.dat; do
    mirror="$pack_extract/binaries/programs/wasm32/fixture/$member"
    [ -L "$mirror" ] || {
        echo "pack-ci-test-workspace.sh: flattened package mirror $member" >&2
        exit 1
    }
    case "$(readlink "$mirror")" in
        /*)
            echo "pack-ci-test-workspace.sh: retained an absolute package mirror $member" >&2
            exit 1
            ;;
    esac
done
cmp \
    "$pack_extract/binaries/programs/wasm32/fixture/fixture.wasm" \
    "$pack_extract/.ci-test-binary-cache/programs/$generation/bin/fixture.wasm"
cmp \
    "$pack_extract/binaries/programs/wasm32/fixture/runtime.dat" \
    "$pack_extract/.ci-test-binary-cache/programs/$generation/share/runtime.dat"
one_member_mirror="$pack_extract/binaries/programs/wasm32/one-member.wasm"
[ -L "$one_member_mirror" ] || {
    echo "pack-ci-test-workspace.sh: flattened a fetched one-member package" >&2
    exit 1
}
case "$(readlink "$one_member_mirror")" in
    /*)
        echo "pack-ci-test-workspace.sh: retained an absolute fetched one-member package link" >&2
        exit 1
        ;;
esac
cmp \
    "$one_member_mirror" \
    "$pack_extract/.ci-test-binary-cache/programs/$one_member_generation/bin/one-member.wasm"
local_mirror="$pack_extract/local-binaries/programs/wasm32/local-fixture/local.wasm"
[ -L "$local_mirror" ] || {
    echo "pack-ci-test-workspace.sh: flattened a local package generation" >&2
    exit 1
}
case "$(readlink "$local_mirror")" in
    /*)
        echo "pack-ci-test-workspace.sh: retained an absolute local generation link" >&2
        exit 1
        ;;
esac
cmp \
    "$local_mirror" \
    "$pack_extract/local-binaries/.kandelo-local-generations/wasm32/local-fixture/$cache_key/session/bin/local.wasm"
local_one_mirror="$pack_extract/local-binaries/programs/wasm32/local-one.wasm"
[ -L "$local_one_mirror" ] || {
    echo "pack-ci-test-workspace.sh: flattened a local one-member package" >&2
    exit 1
}
case "$(readlink "$local_one_mirror")" in
    /*)
        echo "pack-ci-test-workspace.sh: retained an absolute local one-member package link" >&2
        exit 1
        ;;
esac
cmp \
    "$local_one_mirror" \
    "$pack_extract/local-binaries/.kandelo-local-generations/wasm32/local-one/$cache_key/session/bin/local-one.wasm"
local_kernel_mirror="$pack_extract/local-binaries/kernel.wasm"
[ -L "$local_kernel_mirror" ] || {
    echo "pack-ci-test-workspace.sh: flattened a package-owned root-level local scalar" >&2
    exit 1
}
case "$(readlink "$local_kernel_mirror")" in
    /*)
        echo "pack-ci-test-workspace.sh: retained an absolute root-level local generation link" >&2
        exit 1
        ;;
esac
cmp \
    "$local_kernel_mirror" \
    "$pack_extract/local-binaries/.kandelo-local-generations/wasm32/kernel/$cache_key/session/kernel.wasm"

# The packer must validate the exact immutable generation selected by its
# frozen snapshot. A missing one-shot publication claim or member is not a
# portable local package identity.
kernel_claim="$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/kernel/$cache_key/.session.publication-claimed"
mv "$kernel_claim" "$TMP_DIR/kernel-claim.saved"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/unclaimed-local-workspace.tar.zst" \
        >"$TMP_DIR/unclaimed-local-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted an unclaimed local generation" >&2
    exit 1
fi
grep -Fq "local generation lacks its regular publication claim" \
    "$TMP_DIR/unclaimed-local-workspace.out"
mv "$TMP_DIR/kernel-claim.saved" "$kernel_claim"

mv "$local_kernel" "$TMP_DIR/local-kernel.saved"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/dangling-local-workspace.tar.zst" \
        >"$TMP_DIR/dangling-local-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted a dangling local generation" >&2
    exit 1
fi
grep -Fq "missing required artifact: local-binaries/kernel.wasm" \
    "$TMP_DIR/dangling-local-workspace.out"
mv "$TMP_DIR/local-kernel.saved" "$local_kernel"

# Mutate the source mirror immediately after cp completes. The archive must
# still be derived entirely from that private copy; consulting the live source
# during classification would observe the replacement link and fail or select
# a different package.
real_cp="$(command -v cp)"
cat >"$FIXTURE/bin/cp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
"${PACKER_REAL_CP:?}" "$@"
if [ "${1:-}" = -a ] && [ "${2:-}" = local-binaries ] &&
   [ -n "${PACKER_CP_RACE_MIRROR:-}" ]; then
    rm "$PACKER_CP_RACE_MIRROR"
    ln -s "$PACKER_CP_RACE_REPLACEMENT" "$PACKER_CP_RACE_MIRROR"
fi
EOF
chmod +x "$FIXTURE/bin/cp"
kernel_source_target="$(readlink "$FIXTURE/local-binaries/kernel.wasm")"
PATH="$FIXTURE/bin:$PATH" \
    PACKER_REAL_CP="$real_cp" \
    PACKER_CP_RACE_MIRROR="$FIXTURE/local-binaries/kernel.wasm" \
    PACKER_CP_RACE_REPLACEMENT="$outside_source" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/raced-local-workspace.tar.zst"
rm "$FIXTURE/bin/cp" "$FIXTURE/local-binaries/kernel.wasm"
ln -s "$kernel_source_target" "$FIXTURE/local-binaries/kernel.wasm"
race_extract="$TMP_DIR/race-extract"
mkdir -p "$race_extract"
tar --zstd -xf "$TMP_DIR/raced-local-workspace.tar.zst" -C "$race_extract"
[ -L "$race_extract/local-binaries/kernel.wasm" ] || {
    echo "pack-ci-test-workspace.sh flattened the frozen raced kernel mirror" >&2
    exit 1
}
cmp "$local_kernel" "$race_extract/local-binaries/kernel.wasm"

[ -f "$pack_extract/binaries/kernel.wasm" ] && \
    [ ! -L "$pack_extract/binaries/kernel.wasm" ] || {
    echo "pack-ci-test-workspace.sh: scalar resolver entry was not materialized" >&2
    exit 1
}
cmp "$scalar_source" "$pack_extract/binaries/kernel.wasm"
if find "$pack_extract/binaries" "$pack_extract/.ci-test-binary-cache" \
    -type l -exec sh -c '
        for link do
            [ -e "$link" ] || exit 1
        done
    ' sh {} +; then
    :
else
    echo "pack-ci-test-workspace.sh: relocated workspace contains a dangling package mirror" >&2
    exit 1
fi

mkdir -p \
    "$pack_extract/scripts" \
    "$pack_extract/host" \
    "$pack_extract/apps/browser-demos"
cp \
    "$FIXTURE/scripts/ci-run-test-suite.sh" \
    "$FIXTURE/scripts/ci-check-browser-assets.sh" \
    "$FIXTURE/scripts/resolve-binary.sh" \
    "$FIXTURE/scripts/materialize-ci-publication-blockers.sh" \
    "$pack_extract/scripts/"
cp "$FIXTURE/run.sh" "$pack_extract/run.sh"
browser_cache_capture="$TMP_DIR/relocated-browser-cache"
browser_xtask_capture="$TMP_DIR/relocated-browser-xtask"
relocated_recovery_capture="$TMP_DIR/relocated-browser-recovery.args"
relocated_closed_root_capture="$TMP_DIR/relocated-browser-closed-root"
relocated_runner_temp="$TMP_DIR/relocated-runner"
mkdir "$relocated_runner_temp"
PATH="$FIXTURE/bin:$PATH" \
    RUN_CAPTURE="$TMP_DIR/relocated-browser-run.args" \
    RUN_CACHE_CAPTURE="$browser_cache_capture" \
    RUN_XTASK_CAPTURE="$browser_xtask_capture" \
    BLOCKER_CAPTURE="$TMP_DIR/relocated-browser-blockers" \
    RECOVERY_CAPTURE="$relocated_recovery_capture" \
    CLOSED_ROOT_CAPTURE="$relocated_closed_root_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    RUNNER_TEMP="$relocated_runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    WASM_POSIX_BINARY_CACHE_ROOT="$TMP_DIR/wrong-relocated-cache" \
    WASM_POSIX_XTASK_BIN="$TMP_DIR/wrong-relocated-xtask" \
    bash "$pack_extract/scripts/ci-run-test-suite.sh" browser
grep -Fxq \
    "$pack_extract/.ci-test-binary-cache" \
    "$browser_cache_capture" || {
    echo "relocated browser preparation did not select the transported cache" >&2
    exit 1
}
grep -Fxq \
    "$pack_extract/target/fixture-host/release/xtask" \
    "$browser_xtask_capture" || {
    echo "relocated browser preparation did not select the transported package checker" >&2
    exit 1
}
grep -Fxq -- \
    "--already-materialized --fetch-only prepare-browser" \
    "$TMP_DIR/relocated-browser-run.args"
grep -Fxq materialized "$TMP_DIR/relocated-browser-blockers"
[ "$(grep -Fxc /homebrew-main-shell-bottles "$relocated_closed_root_capture")" -eq 2 ] || {
    echo "relocated browser Playwright invocations did not inherit the closed mirror root" >&2
    exit 1
}
[ ! -e "$pack_extract/apps/browser-demos/public/homebrew-main-shell-bottles" ] || {
    echo "relocated browser suite left its pre-merge Homebrew mirror behind" >&2
    exit 1
}

for workflow in \
    "$REPO_ROOT/.github/workflows/homebrew-main-shell-ci.yml" \
    "$REPO_ROOT/.github/workflows/staging-build.yml" \
    "$REPO_ROOT/.github/workflows/prepare-merge.yml" \
    "$REPO_ROOT/.github/workflows/force-rebuild.yml"; do
    grep -Fq 'source scripts/install-local-binary.sh' "$workflow" || {
        echo "$(basename "$workflow"): candidate kernel bypasses the local generation installer" >&2
        exit 1
    }
    grep -Fq 'install_local_binary kernel' "$workflow" || {
        echo "$(basename "$workflow"): candidate kernel lacks package-owned installation" >&2
        exit 1
    }
    grep -Fq 'local-binaries/kernel.wasm' "$workflow" || {
        echo "$(basename "$workflow"): candidate kernel lacks exact-byte verification" >&2
        exit 1
    }
done

for workflow in \
    "$REPO_ROOT/.github/workflows/staging-build.yml" \
    "$REPO_ROOT/.github/workflows/prepare-merge.yml" \
    "$REPO_ROOT/.github/workflows/force-rebuild.yml"; do
    grep -Fq 'scripts/pack-ci-test-workspace.sh' "$workflow" || {
        echo "$(basename "$workflow"): prepared workspace bypasses the shared packer" >&2
        exit 1
    }
    grep -Fq 'scripts/ci-run-test-suite.sh' "$workflow" || {
        echo "$(basename "$workflow"): prepared workspace bypasses the shared suite runner" >&2
        exit 1
    }
done

for workflow in \
    "$REPO_ROOT/.github/workflows/staging-build.yml" \
    "$REPO_ROOT/.github/workflows/prepare-merge.yml"; do
    grep -Fq -- '--blocked-output "$BLOCKED"' "$workflow" || {
        echo "$(basename "$workflow"): expected ledger omits the publication blocker report" >&2
        exit 1
    }
    grep -Fq -- '--publication-blockers "$RUNNER_TEMP/' "$workflow" || {
        echo "$(basename "$workflow"): prepared workspace omits the publication blocker report" >&2
        exit 1
    }
done

valid_blockers="$TMP_DIR/valid-publication-blockers.json"
printf '%s\n' \
    '{"abi_version":42,"entries":[{"package":"lamp","blocker_chain":["lamp","shell"]},{"package":"shell","blocker_chain":["shell"]}]}' \
    > "$valid_blockers"
bash "$REPO_ROOT/scripts/validate-publication-blocker-report.sh" \
    "$valid_blockers" 42

for invalid in wrong-abi duplicate unsafe-chain extra-key; do
    case "$invalid" in
        wrong-abi)
            body='{"abi_version":41,"entries":[]}'
            ;;
        duplicate)
            body='{"abi_version":42,"entries":[{"package":"shell","blocker_chain":["shell"]},{"package":"shell","blocker_chain":["shell"]}]}'
            ;;
        unsafe-chain)
            body='{"abi_version":42,"entries":[{"package":"shell","blocker_chain":["shell","../escape"]}]}'
            ;;
        extra-key)
            body='{"abi_version":42,"entries":[],"permit_stale":true}'
            ;;
    esac
    invalid_report="$TMP_DIR/$invalid-publication-blockers.json"
    printf '%s\n' "$body" > "$invalid_report"
    if bash "$REPO_ROOT/scripts/validate-publication-blocker-report.sh" \
        "$invalid_report" 42 >/dev/null 2>&1; then
        echo "publication blocker validator accepted $invalid" >&2
        exit 1
    fi
done

echo "ci-run-test-suite: conformance group mappings passed"
