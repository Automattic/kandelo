#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# WHY: ordinary files stay in Vitest's deterministic two-way partition while
# declared heavyweight cases run separately. Exercise the real CLI so an
# upgrade cannot make the shards overlap, omit the isolated file, or execute
# more than the one selected case in each fresh process.
vitest_fixture="$TMP_DIR/vitest-shard-fixture"
vitest_expected="$TMP_DIR/vitest-regular-expected"
vitest_all_expected="$TMP_DIR/vitest-all-expected"
vitest_seen="$TMP_DIR/vitest-seen"
mkdir -p "$vitest_fixture"
for number in 1 2 3 4 5 6 7; do
    printf 'test("case %s", () => {});\n' "$number" \
        > "$vitest_fixture/case-$number.test.js"
done
resource_fixture="$vitest_fixture/resource-isolated.test.js"
resource_names=(
    "RESOURCE_CASE_ALPHA"
    "RESOURCE_CASE_BRAVO"
    "RESOURCE_CASE_CHARLIE"
    "RESOURCE_CASE_DELTA"
    "RESOURCE_CASE_ECHO"
)
printf 'describe("nested resource suite", () => {\n' > "$resource_fixture"
for resource_name in "${resource_names[@]}"; do
    printf '  test("%s", () => {});\n' "$resource_name" \
        >> "$resource_fixture"
done
printf '});\n' >> "$resource_fixture"
find "$vitest_fixture" -name 'case-*.test.js' -print | LC_ALL=C sort \
    > "$vitest_expected"
find "$vitest_fixture" -name '*.test.js' -print | LC_ALL=C sort \
    > "$vitest_all_expected"
: > "$vitest_seen"
for shard in 1 2; do
    report="$TMP_DIR/vitest-$shard-of-2.json"
    paths="$TMP_DIR/vitest-$shard-of-2"
    "$REPO_ROOT/host/node_modules/.bin/vitest" run \
        --root "$vitest_fixture" \
        --globals \
        --shard="$shard/2" \
        --exclude="$resource_fixture" \
        --reporter=json \
        --outputFile="$report" \
        > "$TMP_DIR/vitest-$shard-of-2.out"
    jq -r '.testResults[].name' "$report" | LC_ALL=C sort > "$paths"
    if comm -12 "$vitest_seen" "$paths" | grep -q .; then
        echo "Vitest shard $shard/2 overlaps an earlier shard" >&2
        exit 1
    fi
    LC_ALL=C sort -m "$vitest_seen" "$paths" \
        > "$TMP_DIR/vitest-union"
    mv "$TMP_DIR/vitest-union" "$vitest_seen"
done
cmp "$vitest_expected" "$vitest_seen"
if grep -Fxq "$resource_fixture" "$vitest_seen"; then
    echo "ordinary Vitest shards included the resource-isolated file" >&2
    exit 1
fi
printf '%s\n' "$resource_fixture" >> "$vitest_seen"
LC_ALL=C sort -o "$vitest_seen" "$vitest_seen"
cmp "$vitest_all_expected" "$vitest_seen"

resource_expected="$TMP_DIR/vitest-resource-expected"
resource_seen="$TMP_DIR/vitest-resource-seen"
resource_list_json="$TMP_DIR/vitest-resource-list.json"
: > "$resource_expected"
: > "$resource_seen"
"$REPO_ROOT/host/node_modules/.bin/vitest" list \
    --root "$vitest_fixture" \
    --globals \
    "$resource_fixture" \
    --json="$resource_list_json" \
    > "$TMP_DIR/vitest-resource-list.out"
[ "$(jq 'length' "$resource_list_json")" -eq "${#resource_names[@]}" ]
resource_number=0
for marker in "${resource_names[@]}"; do
    resource_number=$((resource_number + 1))
    test_pattern="(^|[^A-Z0-9_])${marker}([^A-Z0-9_]|$)"
    [ "$(jq --arg pattern "$test_pattern" \
        '[.[] | select(.name | test($pattern))] | length' \
        "$resource_list_json")" -eq 1 ] || {
        echo "fixture marker does not identify exactly one nested test: $marker" >&2
        exit 1
    }
    printf 'nested resource suite %s\n' "$marker" \
        >> "$resource_expected"
    report="$TMP_DIR/vitest-resource-$resource_number.json"
    "$REPO_ROOT/host/node_modules/.bin/vitest" run \
        --root "$vitest_fixture" \
        --globals \
        "$resource_fixture" \
        --testNamePattern="$test_pattern" \
        --reporter=json \
        --outputFile="$report" \
        > "$TMP_DIR/vitest-resource-$resource_number.out"
    jq -r '
      .testResults[].assertionResults[]
      | select(.status == "passed")
      | .fullName
    ' "$report" >> "$resource_seen"
done
LC_ALL=C sort -o "$resource_expected" "$resource_expected"
LC_ALL=C sort -o "$resource_seen" "$resource_seen"
cmp "$resource_expected" "$resource_seen" || {
    echo "resource-isolated selectors did not cover the fixture exactly once" >&2
    diff -u "$resource_expected" "$resource_seen" >&2 || true
    exit 1
}
(
    cd "$REPO_ROOT/host"
    npx vitest list --filesOnly
) > "$TMP_DIR/vitest-repository-inventory"
[ -s "$TMP_DIR/vitest-repository-inventory" ]

FIXTURE="$TMP_DIR/repo"
mkdir -p \
    "$FIXTURE/scripts" \
    "$FIXTURE/host" \
    "$FIXTURE/host/src" \
    "$FIXTURE/host/test" \
    "$FIXTURE/host/wasm" \
    "$FIXTURE/local-binaries" \
    "$FIXTURE/examples" \
    "$FIXTURE/benchmarks/wasm" \
    "$FIXTURE/apps/browser-demos" \
    "$FIXTURE/apps/browser-demos/public" \
    "$FIXTURE/crates/shared/src" \
    "$FIXTURE/packages/registry/zip/test" \
    "$FIXTURE/bin"
cp \
    "$REPO_ROOT/scripts/activate-ci-test-workspace.sh" \
    "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" \
    "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh" \
    "$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt" \
    "$REPO_ROOT/scripts/ci-run-test-suite.sh" \
    "$REPO_ROOT/scripts/ci-vitest-resource-isolated-cases.tsv" \
    "$REPO_ROOT/scripts/inspect-homebrew-main-shell-public-product.ts" \
    "$REPO_ROOT/scripts/pack-ci-test-workspace.sh" \
    "$REPO_ROOT/scripts/stage-portable-resolver-binaries.sh" \
    "$REPO_ROOT/scripts/validate-publication-blocker-report.sh" \
    "$REPO_ROOT/scripts/verify-ci-staging-shell-handoff.sh" \
    "$FIXTURE/scripts/"
printf 'export const safeFixture = true;\n' \
    > "$FIXTURE/host/src/safe-fixture.ts"
printf 'import { safeFixture } from "../src/safe-fixture";\ntest("source", () => safeFixture);\n' \
    > "$FIXTURE/host/test/source-only.test.ts"
printf 'export const resolveBinary = () => "prepared";\n' \
    > "$FIXTURE/host/src/binary-resolver.ts"
printf 'import { resolveBinary } from "../src/binary-resolver";\ntest("prepared", () => resolveBinary());\n' \
    > "$FIXTURE/host/test/prepared-product.test.ts"
printf 'test("host zip", () => {});\n' \
    > "$FIXTURE/host/test/zip.test.ts"
printf 'import { resolveBinary } from "../../../../host/src/binary-resolver";\ntest("prepared zip", () => resolveBinary());\n' \
    > "$FIXTURE/packages/registry/zip/test/zip.test.ts"
printf '%s\t%s\n' \
    'host/test/prepared-product.test.ts' prepared-product \
    'host/test/source-only.test.ts' source-only \
    'host/test/zip.test.ts' source-only \
    'packages/registry/ruby/test/posix-spawn.test.ts' source-only \
    'packages/registry/zip/test/zip.test.ts' prepared-product \
    > "$FIXTURE/scripts/ci-vitest-evidence-classes.tsv"
printf '%s\n' 'pub const ABI_VERSION: u32 = 42;' \
    > "$FIXTURE/crates/shared/src/lib.rs"
mkdir -p "$FIXTURE/packages/registry/ruby/test"
: > "$FIXTURE/packages/registry/ruby/test/posix-spawn.test.ts"

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

write_resolved_browser_mirror_state() {
    local image="$1"
    local bootstrap="$2"
    local blockers="$3"
    local out="$4"
    local sha
    local bytes
    local source_commit
    local blocker_sha
    local inspection
    local bootstrap_sha
    local bootstrap_bytes
    sha="$(sha256_file "$image")"
    bytes="$(wc -c < "$image" | tr -d '[:space:]')"
    bootstrap_sha="$(sha256_file "$bootstrap")"
    bootstrap_bytes="$(wc -c < "$bootstrap" | tr -d '[:space:]')"
    source_commit="$(git -C "$FIXTURE" rev-parse HEAD)"
    blocker_sha="$(sha256_file "$blockers")"
    inspection="$(jq -nc \
        --arg sha "$sha" \
        --argjson bytes "$bytes" \
        --arg bootstrap_sha "$bootstrap_sha" \
        --argjson bootstrap_bytes "$bootstrap_bytes" '
          {
            schema: 1,
            kind: "kandelo-homebrew-main-shell-public-product",
            image: {
              sha256: $sha,
              bytes: $bytes,
              kernel_abi: 42
            },
            homebrew_bootstrap: {
              sha256: $bootstrap_sha,
              bytes: $bootstrap_bytes,
              activation_root: "/usr/bin/brew"
            },
            partition: {
              embedded_bottles: 3,
              bootstrap_trees: 1,
              runtime_cohort_bottles: 2,
              ordinary_deferred_bottles: 35,
              deferred_bottles: 37,
              initial_pending_trees: 38
            },
            bottle_mirror: {
              repository: "kandelo-dev/homebrew-tap-core",
              collection_sha256: ("a" * 64),
              tag: "fixture",
              plan_url: "https://example.invalid/plan.json",
              plan_sha256: ("b" * 64),
              plan_bytes: 19901,
              asset_count: 37
            }
          }
        ')"
    jq -n \
        --arg cache_key_sha "$(printf 'b%.0s' {1..64})" \
        --arg source_commit "$source_commit" \
        --arg blocker_sha "$blocker_sha" \
        --arg sha "$sha" \
        --argjson bytes "$bytes" \
        --argjson inspection "$inspection" '
          {
            schema: 3,
            mode: "resolved",
            abi_version: 42,
            package: "shell",
            arch: "wasm32",
            source_commit: $source_commit,
            publication_blockers_sha256: $blocker_sha,
            revision: 22,
            cache_key_sha: $cache_key_sha,
            image: {sha256: $sha, bytes: $bytes},
            inspection: $inspection,
            transport: "flat-lazy",
            mirror_required: true
          }
        ' > "$out"
}

write_blocked_browser_mirror_state() {
    local blockers="$1"
    local out="$2"
    local source_commit
    local blocker_sha
    local blocker_chain
    source_commit="$(git -C "$FIXTURE" rev-parse HEAD)"
    blocker_sha="$(sha256_file "$blockers")"
    blocker_chain="$(
        jq -ce '[.entries[] | select(.package == "shell")][0].blocker_chain' \
            "$blockers"
    )"
    jq -n \
        --arg source_commit "$source_commit" \
        --arg blocker_sha "$blocker_sha" \
        --argjson blocker_chain "$blocker_chain" '
          {
            schema: 2,
            mode: "publication-blocked",
            abi_version: 42,
            package: "shell",
            arch: "wasm32",
            source_commit: $source_commit,
            publication_blockers_sha256: $blocker_sha,
            blocker_chain: $blocker_chain,
            mirror_required: false
          }
        ' > "$out"
}

BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$REPO_ROOT"
BROWSER_MEMORY64_FIXTURES_MANIFEST="$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh"
memory64_sources="$(browser_memory64_fixture_sources)"
while IFS= read -r source; do
    cp "$REPO_ROOT/$source" "$FIXTURE/$source"
done <<< "$memory64_sources"

cat > "$FIXTURE/bin/npm" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = run ] && [ "${2:-}" = build ]; then
    if [ -e public/homebrew-main-shell-bottles ] || \
       [ -L public/homebrew-main-shell-bottles ]; then
        echo "fixture production build observed the closed mirror" >&2
        exit 1
    fi
    if [ -n "${PRODUCTION_BUILD_CAPTURE:-}" ]; then
        {
            printf 'inputs=%s\n' "${KANDELO_BROWSER_DEMO_INPUTS:-<unset>}"
            printf 'vite_closed=%s\n' \
                "${VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT:-<unset>}"
            printf 'playwright_closed=%s\n' \
                "${KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT:-<unset>}"
            printf 'source_shell_expectation=%s\n' \
                "${KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL:-<unset>}"
            printf 'vite_mode=%s\n' \
                "${KANDELO_PLAYWRIGHT_VITE_MODE:-<unset>}"
            printf 'serve_dist=%s\n' \
                "${KANDELO_PLAYWRIGHT_SERVE_DIST:-<unset>}"
            printf 'base=%s\n' "${VITE_BASE:-<unset>}"
            printf 'cors=%s\n' "${VITE_CORS_PROXY_URL:-<unset>}"
        } > "$PRODUCTION_BUILD_CAPTURE"
    fi
    mkdir -p \
        dist/pages/kandelo \
        dist/pages/network
    : > dist/index.html
    : > dist/pages/kandelo/index.html
    : > dist/pages/network/index.html
    : > dist/service-worker.js
    if [ "${PRODUCTION_BUILD_EXPOSE_PRIVATE_ENTRY:-0}" = 1 ]; then
        mkdir -p dist/pages/homebrew-vfs-test
        : > dist/pages/homebrew-vfs-test/index.html
    fi
fi
exit 0
EOF

cat > "$FIXTURE/bin/npx" <<'EOF'
#!/usr/bin/env bash
select_vitest_files() {
    local -a filters=()
    local -a excludes=()
    local arg file filter excluded
    for arg in "$@"; do
        case "$arg" in
            vitest|list|run|--filesOnly) ;;
            --exclude=*) excludes+=("${arg#--exclude=}") ;;
            --*) ;;
            *) filters+=("$arg") ;;
        esac
    done
    while IFS= read -r file || [ -n "$file" ]; do
        [ -n "$file" ] || continue
        if [ "${#filters[@]}" -gt 0 ]; then
            selected=false
            for filter in "${filters[@]}"; do
                if [[ "$file" == *"$filter"* ]]; then
                    selected=true
                    break
                fi
            done
            [ "$selected" = true ] || continue
        fi
        excluded=false
        for filter in "${excludes[@]}"; do
            if [ "$file" = "$filter" ]; then
                excluded=true
                break
            fi
        done
        [ "$excluded" = false ] && printf '%s\n' "$file"
    done <<< "${VITEST_FILES_ONLY_INVENTORY:-}"
}

if [ "${1:-}" = "vitest" ] && [ "${2:-}" = "list" ] &&
   printf '%s\n' "$@" | grep -Fxq -- --filesOnly; then
    [ -n "${VITEST_FILES_ONLY_INVENTORY:-}" ] || exit 2
    select_vitest_files "$@"
    exit 0
fi
if [ "${1:-}" = "vitest" ] && [ "${2:-}" = "list" ]; then
    [ -n "${VITEST_LIST_INVENTORY:-}" ] || exit 2
    output=""
    for arg in "$@"; do
        case "$arg" in
            --json=*) output="${arg#--json=}" ;;
        esac
    done
    [ -n "$output" ] || exit 2
    cp "$VITEST_LIST_INVENTORY" "$output"
    exit 0
fi
if [ "${1:-}" = "vitest" ] && [ -n "${VITEST_CAPTURE:-}" ]; then
    printf '%s\n' "$*" >> "$VITEST_CAPTURE"
    if [ -n "${VITEST_SELECTED_CAPTURE:-}" ] &&
       ! printf '%s\n' "$@" | grep -q '^--testNamePattern='; then
        select_vitest_files "$@" > "$VITEST_SELECTED_CAPTURE"
    fi
    exit 0
fi
if [ "${1:-}" = "tsx" ]; then
    case "${2:-}" in
        */inspect-homebrew-main-shell-public-product.ts | \
            scripts/inspect-homebrew-main-shell-public-product.ts)
            shift 2
            image=""
            bootstrap=""
            out=""
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --image) image="$2"; shift 2 ;;
                    --homebrew-bootstrap-archive) bootstrap="$2"; shift 2 ;;
                    --homebrew-bootstrap-spec | --selection | \
                        --materialization-policy | --runtime-support-policy | \
                        --mirror-plan) shift 2 ;;
                    --out) out="$2"; shift 2 ;;
                    *) exit 2 ;;
                esac
            done
            [ -n "$image" ] && [ -n "$bootstrap" ] && \
                [ -n "$out" ] || exit 2
            if command -v sha256sum >/dev/null 2>&1; then
                image_sha="$(sha256sum "$image" | awk '{print $1}')"
                bootstrap_sha="$(sha256sum "$bootstrap" | awk '{print $1}')"
            else
                image_sha="$(shasum -a 256 "$image" | awk '{print $1}')"
                bootstrap_sha="$(shasum -a 256 "$bootstrap" | awk '{print $1}')"
            fi
            image_bytes="$(wc -c < "$image" | tr -d '[:space:]')"
            bootstrap_bytes="$(wc -c < "$bootstrap" | tr -d '[:space:]')"
            kernel_abi=42
            if [ -n "${KANDELO_CANONICAL_FLAT_SELECTION:-}" ]; then
                kernel_abi="$(
                    jq -er '.kandeloAbi' \
                        "$KANDELO_CANONICAL_FLAT_SELECTION"
                )"
            fi
            jq -n \
                --arg sha "$image_sha" \
                --argjson bytes "$image_bytes" \
                --arg bootstrap_sha "$bootstrap_sha" \
                --argjson bootstrap_bytes "$bootstrap_bytes" \
                --argjson kernel_abi "$kernel_abi" '
              {
                schema: 1,
                kind: "kandelo-homebrew-main-shell-public-product",
                image: {
                  sha256: $sha,
                  bytes: $bytes,
                  kernel_abi: $kernel_abi
                },
                homebrew_bootstrap: {
                  sha256: $bootstrap_sha,
                  bytes: $bootstrap_bytes,
                  activation_root: "/usr/bin/brew"
                },
                partition: {
                  embedded_bottles: 3,
                  bootstrap_trees: 1,
                  runtime_cohort_bottles: 2,
                  ordinary_deferred_bottles: 35,
                  deferred_bottles: 37,
                  initial_pending_trees: 38
                },
                bottle_mirror: {
                  repository: "kandelo-dev/homebrew-tap-core",
                  collection_sha256: ("a" * 64),
                  tag: "fixture",
                  plan_url: "https://example.invalid/plan.json",
                  plan_sha256: ("b" * 64),
                  plan_bytes: 19901,
                  asset_count: 37
                }
              }
            ' > "$out"
            exit 0
            ;;
        */assert-source-rootfs-shell-composition.ts | \
            scripts/assert-source-rootfs-shell-composition.ts)
            printf '%s\n' "${3:-}" > "$SOURCE_COMPOSITION_CHECK_CAPTURE"
            if [ "${SOURCE_COMPOSITION_CHECK_RESULT:-pass}" != pass ]; then
                echo "fixture rejected source shell composition" >&2
                exit 1
            fi
            exit 0
            ;;
    esac
fi
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
    printf '%s\n' "${KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT:-<unset>}" \
        >> "$CLOSED_ROOT_CAPTURE"
    printf '%s\n' "${VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT:-<unset>}" \
        >> "$CLOSED_VITE_ROOT_CAPTURE"
    printf '%s\n' "${KANDELO_PLAYWRIGHT_VITE_MODE:-<unset>}" \
        >> "$CLOSED_MODE_CAPTURE"
    printf '%s\n' \
        "${KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL:-<unset>}" \
        >> "$SOURCE_SHELL_EXPECTATION_CAPTURE"
fi
exit 0
EOF

cat > "$FIXTURE/bin/bun" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "x" ] && [ "${2:-}" = "vitest" ] &&
    [ -n "${BUN_CAPTURE:-}" ]; then
    printf '%s\n' "$*" >> "$BUN_CAPTURE"
    exit 0
fi
exit 2
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

cat > "$FIXTURE/bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CARGO_CAPTURE"
exit 0
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
[ "$#" -eq 1 ] || exit 2
case "$1" in
    programs/shell.vfs.zst)
        printf '%s\n' "$FIXTURE_SHELL_IMAGE"
        ;;
    programs/homebrew-bootstrap/homebrew-bootstrap.zip)
        printf '%s\n' "$FIXTURE_HOMEBREW_BOOTSTRAP"
        ;;
    *) exit 2 ;;
esac
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
exit 2
EOF

chmod +x \
    "$FIXTURE/bin/bun" \
    "$FIXTURE/bin/cargo" \
    "$FIXTURE/bin/npm" \
    "$FIXTURE/bin/npx" \
    "$FIXTURE/bin/rustc" \
    "$FIXTURE/bin/uname" \
    "$FIXTURE/run.sh" \
    "$FIXTURE/scripts/ci-check-browser-assets.sh" \
    "$FIXTURE/scripts/resolve-binary.sh" \
    "$FIXTURE/scripts/materialize-ci-publication-blockers.sh" \
    "$prepared_xtask"

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.name "Kandelo CI fixture"
git -C "$FIXTURE" config user.email "ci-fixture@invalid.example"
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm "fixture source identity"
fixture_base_branch="$(git -C "$FIXTURE" branch --show-current)"
git -C "$FIXTURE" switch -qc fixture-pr-head
git -C "$FIXTURE" commit --allow-empty -qm "fixture PR head"
git -C "$FIXTURE" switch -q "$fixture_base_branch"
git -C "$FIXTURE" merge --no-ff -qm "fixture synthetic merge" \
    fixture-pr-head

check_premerge_browser_production_contract() {
    local runner="$1"
    local function_block
    local browser_block
    local materialize_line
    local state_line
    local source_authority_line
    local fetch_first_line
    local fetch_last_line
    local production_line
    local mirror_line
    function_block="$(sed -n \
        '/^run_pages_shaped_browser_build() {$/,/^}$/p' "$runner")"
    browser_block="$(sed -n '/^    browser)$/,/^        ;;/p' "$runner")"

    for binding in \
        '-u KANDELO_BROWSER_DEMO_INPUTS' \
        '-u VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT' \
        '-u KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT' \
        '-u KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL' \
        '-u KANDELO_PLAYWRIGHT_VITE_MODE' \
        '-u KANDELO_PLAYWRIGHT_SERVE_DIST' \
        'VITE_BASE=/kandelo/' \
        'VITE_CORS_PROXY_URL='
    do
        grep -Fq -- "$binding" <<<"$function_block" || return 1
    done
    for output in \
        'index.html' \
        'pages/kandelo/index.html' \
        'pages/network/index.html' \
        'service-worker.js'
    do
        grep -Fq -- "$output" <<<"$function_block" || return 1
    done
    grep -Fq 'ordinary browser build found a closed test mirror' \
        <<<"$function_block" || return 1
    grep -Fq 'ordinary browser build exposed the private Homebrew acceptance page' \
        <<<"$function_block" || return 1
    [ "$(grep -Fc 'run_pages_shaped_browser_build' <<<"$browser_block")" -eq 1 ] ||
        return 1
    materialize_line="$(grep -nF \
        'bash scripts/materialize-ci-publication-blockers.sh' \
        <<<"$browser_block" | cut -d: -f1)"
    state_line="$(grep -nF 'validate_ci_homebrew_browser_state' \
        <<<"$browser_block" | cut -d: -f1)"
    source_authority_line="$(grep -nF \
        'WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY="$CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY"' \
        <<<"$browser_block" | cut -d: -f1)"
    [ "$(grep -Fc \
        './run.sh --already-materialized --fetch-only prepare-browser' \
        <<<"$browser_block")" -eq 2 ] || return 1
    fetch_first_line="$(grep -nF \
        './run.sh --already-materialized --fetch-only prepare-browser' \
        <<<"$browser_block" | head -n 1 | cut -d: -f1)"
    fetch_last_line="$(grep -nF \
        './run.sh --already-materialized --fetch-only prepare-browser' \
        <<<"$browser_block" | tail -n 1 | cut -d: -f1)"
    production_line="$(grep -nF 'run_pages_shaped_browser_build' \
        <<<"$browser_block" | cut -d: -f1)"
    mirror_line="$(grep -nF 'prepare_ci_homebrew_browser_mirror' \
        <<<"$browser_block" | cut -d: -f1)"
    [ -n "$materialize_line" ] && [ -n "$state_line" ] &&
        [ -n "$source_authority_line" ] &&
        [ -n "$fetch_first_line" ] && [ -n "$fetch_last_line" ] &&
        [ -n "$production_line" ] && [ -n "$mirror_line" ] &&
        [ "$materialize_line" -lt "$state_line" ] &&
        [ "$state_line" -lt "$source_authority_line" ] &&
        [ "$source_authority_line" -lt "$fetch_first_line" ] &&
        [ "$fetch_last_line" -lt "$production_line" ] &&
        [ "$production_line" -lt "$mirror_line" ]
}

check_premerge_browser_production_contract \
    "$REPO_ROOT/scripts/ci-run-test-suite.sh" || {
    echo "prepare-merge browser shard lacks its ordinary production build" >&2
    exit 1
}
sed '/^                run_pages_shaped_browser_build$/d' \
    "$REPO_ROOT/scripts/ci-run-test-suite.sh" \
    > "$TMP_DIR/browser-runner-without-production-build.sh"
if check_premerge_browser_production_contract \
    "$TMP_DIR/browser-runner-without-production-build.sh"
then
    echo "production-build contract accepted a removed invocation" >&2
    exit 1
fi
sed 's/-u KANDELO_BROWSER_DEMO_INPUTS/KANDELO_BROWSER_DEMO_INPUTS=main/' \
    "$REPO_ROOT/scripts/ci-run-test-suite.sh" \
    > "$TMP_DIR/browser-runner-with-shell-selector.sh"
if check_premerge_browser_production_contract \
    "$TMP_DIR/browser-runner-with-shell-selector.sh"
then
    echo "production-build contract accepted a shell-only selector" >&2
    exit 1
fi

CARGO_CAPTURE="$TMP_DIR/cargo-build.args"
export CARGO_CAPTURE

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

run_vitest_group() {
    local group="$1"
    local expected_vitest="$2"
    local expected_bun_count="$3"
    local safe_group="${group//\//-}"
    local vitest_capture="$TMP_DIR/vitest-$safe_group.args"
    local bun_capture="$TMP_DIR/bun-$safe_group.args"
    : > "$vitest_capture"
    : > "$bun_capture"
    PATH="$FIXTURE/bin:$PATH" \
        VITEST_CAPTURE="$vitest_capture" \
        VITEST_LIST_INVENTORY="$resource_inventory" \
        BUN_CAPTURE="$bun_capture" \
        bash "$FIXTURE/scripts/ci-run-test-suite.sh" vitest "$group"
    [ "$(cat "$vitest_capture")" = "$expected_vitest" ] || {
        echo "vitest/$group did not select its expected file shard" >&2
        printf 'actual:\n%s\nexpected:\n%s\n' \
            "$(cat "$vitest_capture")" "$expected_vitest" >&2
        exit 1
    }
    [ "$(wc -l < "$bun_capture" | tr -d '[:space:]')" \
        -eq "$expected_bun_count" ] || {
        echo "vitest/$group ran the Bun teardown check unexpectedly" >&2
        exit 1
    }
}

resource_path=../packages/registry/ruby/test/posix-spawn.test.ts
resource_exclude="--exclude=$resource_path"
resource_manifest="$FIXTURE/scripts/ci-vitest-resource-isolated-cases.tsv"
resource_manifest_valid="$TMP_DIR/vitest-resource-manifest-valid.tsv"
resource_inventory="$TMP_DIR/vitest-resource-inventory"
cp "$resource_manifest" "$resource_manifest_valid"
jq -Rn \
    --arg file "$FIXTURE/packages/registry/ruby/test/posix-spawn.test.ts" '
      [
        inputs
        | select(length > 0 and (startswith("#") | not))
        | split("\t")
        | {
            name: (
              "Ruby Process.spawn on Kandelo > " +
              .[1] +
              " preserves process semantics"
            ),
            file: $file
          }
      ]
    ' < "$resource_manifest" > "$resource_inventory"
resource_invocations=""
while IFS=$'\t' read -r test_file test_marker; do
    case "$test_file" in ""|\#*) continue ;; esac
    test_pattern="(^|[^A-Z0-9_])${test_marker}([^A-Z0-9_]|$)"
    invocation="vitest run ../$test_file --testNamePattern=$test_pattern"
    if [ -n "$resource_invocations" ]; then
        resource_invocations="$resource_invocations"$'\n'
    fi
    resource_invocations="$resource_invocations$invocation"
done < "$REPO_ROOT/scripts/ci-vitest-resource-isolated-cases.tsv"

run_vitest_group all \
    "vitest run $resource_exclude"$'\n'"$resource_invocations" 1
run_vitest_group 1/2 "vitest run --shard=1/2 $resource_exclude" 1
run_vitest_group 2/2 "vitest run --shard=2/2 $resource_exclude" 0
run_vitest_group resource-isolated "$resource_invocations" 0

exact_vitest_inventory=$'../packages/registry/ruby/test/posix-spawn.test.ts\n../packages/registry/zip/test/zip.test.ts\ntest/prepared-product.test.ts\ntest/source-only.test.ts\ntest/zip.test.ts'
exact_vitest_capture="$TMP_DIR/vitest-exact-abi-source.args"
exact_vitest_selected="$TMP_DIR/vitest-exact-abi-source.selected"
: > "$exact_vitest_capture"
PATH="$FIXTURE/bin:$PATH" \
    VITEST_CAPTURE="$exact_vitest_capture" \
    VITEST_SELECTED_CAPTURE="$exact_vitest_selected" \
    VITEST_FILES_ONLY_INVENTORY="$exact_vitest_inventory" \
    VITEST_LIST_INVENTORY="$resource_inventory" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" \
        vitest exact-abi-source
[ "$(cat "$exact_vitest_selected")" = \
    $'test/source-only.test.ts\ntest/zip.test.ts' ] || {
    echo "vitest/exact-abi-source expanded into prepared-product evidence" >&2
    cat "$exact_vitest_selected" >&2
    exit 1
}
[ "$(cat "$exact_vitest_capture")" = \
    'vitest run --exclude=test/prepared-product.test.ts --exclude=../packages/registry/zip/test/zip.test.ts --exclude=../packages/registry/ruby/test/posix-spawn.test.ts'$'\n'"$resource_invocations" ] || {
    echo "vitest/exact-abi-source did not select only source evidence" >&2
    cat "$exact_vitest_capture" >&2
    exit 1
}
if grep -Fq prepared-product "$exact_vitest_selected"; then
    echo "vitest/exact-abi-source selected prepared-product evidence" >&2
    exit 1
fi

exact_manifest="$FIXTURE/scripts/ci-vitest-evidence-classes.tsv"
exact_manifest_valid="$TMP_DIR/vitest-exact-manifest-valid.tsv"
source_only_valid="$TMP_DIR/vitest-exact-source-only-valid.ts"
cp "$exact_manifest" "$exact_manifest_valid"
cp "$FIXTURE/host/test/source-only.test.ts" "$source_only_valid"

run_invalid_exact_manifest() {
    local label="$1"
    local expected="$2"
    local inventory="${3:-$exact_vitest_inventory}"
    local output="$TMP_DIR/vitest-exact-invalid-$label.out"
    if PATH="$FIXTURE/bin:$PATH" \
        VITEST_CAPTURE="$TMP_DIR/vitest-exact-invalid-$label.args" \
        VITEST_FILES_ONLY_INVENTORY="$inventory" \
        VITEST_LIST_INVENTORY="$resource_inventory" \
        bash "$FIXTURE/scripts/ci-run-test-suite.sh" \
            vitest exact-abi-source > "$output" 2>&1; then
        echo "exact-abi-source manifest accepted $label" >&2
        exit 1
    fi
    grep -Fq "$expected" "$output" || {
        echo "exact-abi-source manifest reported the wrong $label error" >&2
        cat "$output" >&2
        exit 1
    }
}

# The exact route may run only an exhaustive, immutable two-class inventory.
# Mutation coverage keeps new files, duplicate rows, class typos, and resolver
# dependencies from silently entering the source-only evidence lane.
printf '%s\t%s\n' \
    'host/test/source-only.test.ts' source-only \
    >> "$exact_manifest"
run_invalid_exact_manifest duplicate \
    "Vitest evidence classes must be sorted and duplicate-free"

cp "$exact_manifest_valid" "$exact_manifest"
sed 's/source-only$/unknown/' "$exact_manifest_valid" > "$exact_manifest"
run_invalid_exact_manifest unknown-class \
    "unknown Vitest evidence class"

cp "$exact_manifest_valid" "$exact_manifest"
run_invalid_exact_manifest missing-file \
    "do not exactly cover the live file inventory" \
    $'test/prepared-product.test.ts\ntest/source-only.test.ts\ntest/unclassified.test.ts'

cp "$exact_manifest_valid" "$exact_manifest"
printf '%s\n' \
    'import { resolveBinary } from "../src/binary-resolver";' \
    'test("source", () => resolveBinary());' \
    > "$FIXTURE/host/test/source-only.test.ts"
run_invalid_exact_manifest binary-resolver \
    "source-only import closure reaches binary-resolver"

cp "$source_only_valid" "$FIXTURE/host/test/source-only.test.ts"
printf '%s\n' \
    'import "./prepared-product.test";' \
    >> "$FIXTURE/host/test/source-only.test.ts"
run_invalid_exact_manifest prepared-test \
    "source-only import closure reaches prepared-product test"

cp "$exact_manifest_valid" "$exact_manifest"
cp "$source_only_valid" "$FIXTURE/host/test/source-only.test.ts"

run_invalid_resource_manifest() {
    local label="$1"
    local expected="$2"
    local output="$TMP_DIR/vitest-resource-invalid-$label.out"
    if PATH="$FIXTURE/bin:$PATH" \
        VITEST_CAPTURE="$TMP_DIR/vitest-resource-invalid-$label.args" \
        VITEST_LIST_INVENTORY="$resource_inventory" \
        BUN_CAPTURE="$TMP_DIR/vitest-resource-invalid-$label.bun" \
        bash "$FIXTURE/scripts/ci-run-test-suite.sh" \
            vitest resource-isolated > "$output" 2>&1; then
        echo "resource-isolated manifest accepted $label" >&2
        exit 1
    fi
    grep -Fq "$expected" "$output" || {
        echo "resource-isolated manifest reported the wrong $label error" >&2
        cat "$output" >&2
        exit 1
    }
}

# Every excluded file must be represented by an exact one-to-one case list.
# Exercise each drift mode so future runner changes cannot silently skip or
# multiply tests while retaining a superficially green isolated job.
cp "$resource_manifest_valid" "$resource_manifest"
printf 'malformed-row-without-a-tab\n' >> "$resource_manifest"
run_invalid_resource_manifest malformed \
    "invalid resource-isolated case"

cp "$resource_manifest_valid" "$resource_manifest"
printf '%s\t\t%s\n' \
    "packages/registry/ruby/test/posix-spawn.test.ts" \
    "RUBY_POSIX_SPAWN_DOUBLE_TAB" \
    >> "$resource_manifest"
run_invalid_resource_manifest double-tab \
    "invalid resource-isolated case"

awk -F '\t' 'BEGIN { OFS = "\t" }
    !changed && !/^#/ && NF {
        $2 = "UNSAFE.*MARKER"
        changed = 1
    }
    { print }
' "$resource_manifest_valid" > "$resource_manifest"
run_invalid_resource_manifest unsafe-marker \
    "invalid resource-isolated marker"

cp "$resource_manifest_valid" "$resource_manifest"
awk -F '\t' '!/^#/ && NF { print; exit }' "$resource_manifest_valid" \
    >> "$resource_manifest"
run_invalid_resource_manifest duplicate \
    "duplicate resource-isolated case"

awk -F '\t' 'BEGIN { OFS = "\t" }
    !changed && !/^#/ && NF {
        $2 = $2 "_TYPO"
        changed = 1
    }
    { print }
' "$resource_manifest_valid" > "$resource_manifest"
run_invalid_resource_manifest typo \
    "marker must select exactly one test"

awk 'BEGIN { omitted = 0 }
    !omitted && !/^#/ && NF {
        omitted = 1
        next
    }
    { print }
' "$resource_manifest_valid" > "$resource_manifest"
run_invalid_resource_manifest omission \
    "manifest does not exactly cover"

cp "$resource_manifest_valid" "$resource_manifest"
cp "$resource_inventory" "$TMP_DIR/vitest-resource-inventory-valid"
jq \
    --arg file "$FIXTURE/packages/registry/ruby/test/posix-spawn.test.ts" '
      . + [{
        name: "Ruby Process.spawn on Kandelo > EXTRA_CASE preserves process semantics",
        file: $file
      }]
    ' "$TMP_DIR/vitest-resource-inventory-valid" \
    > "$resource_inventory"
run_invalid_resource_manifest extra-case \
    "manifest does not exactly cover"
cp "$TMP_DIR/vitest-resource-inventory-valid" "$resource_inventory"
cp "$resource_manifest_valid" "$resource_manifest"

if PATH="$FIXTURE/bin:$PATH" \
    VITEST_CAPTURE="$TMP_DIR/vitest-invalid.args" \
    BUN_CAPTURE="$TMP_DIR/bun-invalid.args" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" vitest 3/2 \
        > "$TMP_DIR/vitest-invalid.out" 2>&1; then
    echo "invalid Vitest shard unexpectedly succeeded" >&2
    exit 1
fi
grep -Fq "unknown vitest test group: 3/2" \
    "$TMP_DIR/vitest-invalid.out"

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
closed_vite_root_capture="$TMP_DIR/browser-closed-vite-root"
closed_mode_capture="$TMP_DIR/browser-closed-mode"
source_shell_expectation_capture="$TMP_DIR/browser-source-shell-expectation"
source_composition_check_capture="$TMP_DIR/browser-source-composition-check"
production_build_capture="$TMP_DIR/browser-production-build"
fixture_shell_image="$TMP_DIR/shell.vfs.zst"
fixture_homebrew_bootstrap="$TMP_DIR/homebrew-bootstrap.zip"
runner_temp="$TMP_DIR/runner"
printf 'shell image\n' > "$fixture_shell_image"
printf 'Homebrew bootstrap\n' > "$fixture_homebrew_bootstrap"
mkdir "$runner_temp"
cat > "$FIXTURE/.ci-test-publication-blockers.json" <<'EOF'
{"abi_version":42,"entries":[{"package":"shell","blocker_chain":["shell"]}]}
EOF
write_blocked_browser_mirror_state \
    "$FIXTURE/.ci-test-publication-blockers.json" \
    "$FIXTURE/.ci-homebrew-browser-mirror-state.json"
rm -f \
    "$recovery_capture" \
    "$closed_root_capture" \
    "$closed_vite_root_capture" \
    "$closed_mode_capture" \
    "$source_shell_expectation_capture" \
    "$source_composition_check_capture"
PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    RECOVERY_CAPTURE="$recovery_capture" \
    CLOSED_ROOT_CAPTURE="$closed_root_capture" \
    CLOSED_VITE_ROOT_CAPTURE="$closed_vite_root_capture" \
    CLOSED_MODE_CAPTURE="$closed_mode_capture" \
    SOURCE_SHELL_EXPECTATION_CAPTURE="$source_shell_expectation_capture" \
    SOURCE_COMPOSITION_CHECK_CAPTURE="$source_composition_check_capture" \
    PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    RUNNER_TEMP="$runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser
grep -Fxq materialized "$blocker_capture"
grep -Fxq -- \
    "--already-materialized --fetch-only prepare-browser" \
    "$browser_capture"
for production_binding in \
    'inputs=<unset>' \
    'vite_closed=<unset>' \
    'playwright_closed=<unset>' \
    'source_shell_expectation=<unset>' \
    'vite_mode=<unset>' \
    'serve_dist=<unset>' \
    'base=/kandelo/' \
    'cors=https://wordpress-playground-cors-proxy.net/?'
do
    grep -Fxq "$production_binding" "$production_build_capture" || {
        echo "ordinary production build lacks binding: $production_binding" >&2
        exit 1
    }
done
[ ! -e "$FIXTURE/apps/browser-demos/dist" ] || {
    echo "browser suite retained its ordinary production build" >&2
    exit 1
}
[ ! -e "$recovery_capture" ] || {
    echo "source-rootfs browser validation attempted bottle-mirror recovery" >&2
    exit 1
}
[ -f "$closed_root_capture" ] &&
    [ -f "$closed_vite_root_capture" ] &&
    [ -f "$closed_mode_capture" ] &&
    [ -f "$source_shell_expectation_capture" ] || {
    echo "source-rootfs browser validation omitted Playwright invocations" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$closed_root_capture")" -eq 2 ] || {
    echo "source-rootfs browser validation inherited a closed mirror root" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$closed_vite_root_capture")" -eq 2 ] || {
    echo "source-rootfs browser validation inherited closed Vite authority" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$closed_mode_capture")" -eq 2 ] || {
    echo "source-rootfs browser validation selected closed acceptance" >&2
    exit 1
}
[ "$(grep -Fxc '1' "$source_shell_expectation_capture")" -eq 2 ] || {
    echo "source-rootfs browser validation omitted its shell ownership" >&2
    exit 1
}
grep -Fxq "$fixture_shell_image" "$source_composition_check_capture" || {
    echo "source-rootfs browser validation did not inspect its image" >&2
    exit 1
}
[ ! -e "$FIXTURE/apps/browser-demos/public/homebrew-main-shell-bottles" ] || {
    echo "browser suite left its pre-merge Homebrew mirror behind" >&2
    exit 1
}

if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    RECOVERY_CAPTURE="$recovery_capture" \
    CLOSED_ROOT_CAPTURE="$closed_root_capture" \
    CLOSED_VITE_ROOT_CAPTURE="$closed_vite_root_capture" \
    CLOSED_MODE_CAPTURE="$closed_mode_capture" \
    SOURCE_SHELL_EXPECTATION_CAPTURE="$source_shell_expectation_capture" \
    SOURCE_COMPOSITION_CHECK_CAPTURE="$source_composition_check_capture" \
    SOURCE_COMPOSITION_CHECK_RESULT=fail \
    PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    RUNNER_TEMP="$runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=false \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
    >"$TMP_DIR/browser-invalid-source-composition.out" 2>&1; then
    echo "source-rootfs browser validation accepted invalid composition" >&2
    exit 1
fi
grep -Fq "fixture rejected source shell composition" \
    "$TMP_DIR/browser-invalid-source-composition.out"

# Source mode must not silently inherit closed bytes from an earlier task.
# This run disables the ordinary production build so the mirror preparer
# itself proves the fail-closed check precedes the source-mode bypass.
stale_mirror="$FIXTURE/apps/browser-demos/public/homebrew-main-shell-bottles"
mkdir -p "$stale_mirror"
printf 'stale\n' > "$stale_mirror/stale-bottle"
if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    RECOVERY_CAPTURE="$recovery_capture" \
    CLOSED_ROOT_CAPTURE="$closed_root_capture" \
    CLOSED_VITE_ROOT_CAPTURE="$closed_vite_root_capture" \
    CLOSED_MODE_CAPTURE="$closed_mode_capture" \
    SOURCE_SHELL_EXPECTATION_CAPTURE="$source_shell_expectation_capture" \
    SOURCE_COMPOSITION_CHECK_CAPTURE="$source_composition_check_capture" \
    PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    RUNNER_TEMP="$runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=false \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
    >"$TMP_DIR/browser-stale-source-mirror.out" 2>&1; then
    echo "source-rootfs browser validation accepted a stale mirror" >&2
    exit 1
fi
grep -Fq "closed Homebrew browser mirror already exists" \
    "$TMP_DIR/browser-stale-source-mirror.out"
rm -rf -- "$stale_mirror"

for leaked_authority in \
    VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT \
    KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT \
    KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL \
    KANDELO_PLAYWRIGHT_VITE_MODE
do
    if env "$leaked_authority=/untrusted-closed-authority" \
        PATH="$FIXTURE/bin:$PATH" \
        RUN_CAPTURE="$browser_capture" \
        BLOCKER_CAPTURE="$blocker_capture" \
        RECOVERY_CAPTURE="$recovery_capture" \
        CLOSED_ROOT_CAPTURE="$closed_root_capture" \
        CLOSED_VITE_ROOT_CAPTURE="$closed_vite_root_capture" \
        CLOSED_MODE_CAPTURE="$closed_mode_capture" \
        SOURCE_SHELL_EXPECTATION_CAPTURE="$source_shell_expectation_capture" \
        SOURCE_COMPOSITION_CHECK_CAPTURE="$source_composition_check_capture" \
        PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
        FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
        FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
        RUNNER_TEMP="$runner_temp" \
        PREPARE_BROWSER_ASSETS=true \
        VERIFY_BROWSER_PRODUCTION_BUILD=false \
        bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
        >"$TMP_DIR/browser-leaked-$leaked_authority.out" 2>&1; then
        echo "browser validation accepted ambient $leaked_authority" >&2
        exit 1
    fi
    grep -Fq \
        "ambient closed Homebrew browser authority is forbidden: $leaked_authority" \
        "$TMP_DIR/browser-leaked-$leaked_authority.out"
done

private_entry_error="$TMP_DIR/browser-private-entry.err"
if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    RECOVERY_CAPTURE="$recovery_capture" \
    CLOSED_ROOT_CAPTURE="$closed_root_capture" \
    CLOSED_VITE_ROOT_CAPTURE="$closed_vite_root_capture" \
    CLOSED_MODE_CAPTURE="$closed_mode_capture" \
    SOURCE_SHELL_EXPECTATION_CAPTURE="$source_shell_expectation_capture" \
    SOURCE_COMPOSITION_CHECK_CAPTURE="$source_composition_check_capture" \
    PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
    PRODUCTION_BUILD_EXPOSE_PRIVATE_ENTRY=1 \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    RUNNER_TEMP="$runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
    > "$private_entry_error" 2>&1
then
    echo "ordinary production build accepted its private Homebrew page" >&2
    exit 1
fi
grep -Fq \
    'ordinary browser build exposed the private Homebrew acceptance page' \
    "$private_entry_error"
rm -rf -- "$FIXTURE/apps/browser-demos/dist"

# A resolved canonical shell is a flat-lazy product. The browser consumer must
# revalidate its exact inspection, recover the closed mirror, and grant only
# the bounded closed-acceptance authority.
printf '%s\n' \
    '{"abi_version":42,"entries":[]}' \
    > "$FIXTURE/.ci-test-publication-blockers.json"
write_resolved_browser_mirror_state \
    "$fixture_shell_image" \
    "$fixture_homebrew_bootstrap" \
    "$FIXTURE/.ci-test-publication-blockers.json" \
    "$FIXTURE/.ci-homebrew-browser-mirror-state.json"
rm -f \
    "$recovery_capture" \
    "$closed_root_capture" \
    "$closed_vite_root_capture" \
    "$closed_mode_capture" \
    "$source_shell_expectation_capture" \
    "$source_composition_check_capture"
PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    RECOVERY_CAPTURE="$recovery_capture" \
    CLOSED_ROOT_CAPTURE="$closed_root_capture" \
    CLOSED_VITE_ROOT_CAPTURE="$closed_vite_root_capture" \
    CLOSED_MODE_CAPTURE="$closed_mode_capture" \
    SOURCE_SHELL_EXPECTATION_CAPTURE="$source_shell_expectation_capture" \
    SOURCE_COMPOSITION_CHECK_CAPTURE="$source_composition_check_capture" \
    PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    RUNNER_TEMP="$runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser
[ -e "$recovery_capture" ] || {
    echo "resolved flat-lazy shell omitted closed-mirror recovery" >&2
    exit 1
}
[ "$(grep -Fxc '/homebrew-main-shell-bottles' "$closed_root_capture")" -eq 2 ] || {
    echo "resolved flat-lazy shell omitted closed browser authority" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$closed_vite_root_capture")" -eq 2 ] || {
    echo "resolved flat shell leaked closed Vite authority" >&2
    exit 1
}
[ "$(grep -Fxc 'homebrew-closed-acceptance' "$closed_mode_capture")" -eq 2 ] || {
    echo "resolved flat-lazy shell omitted the closed Vite mode" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$source_shell_expectation_capture")" -eq 2 ] || {
    echo "resolved flat shell weakened source-shell assertions" >&2
    exit 1
}
[ ! -e "$FIXTURE/apps/browser-demos/public/homebrew-main-shell-bottles" ] || {
    echo "resolved unpublished shell left its pre-merge mirror behind" >&2
    exit 1
}

printf '{\n' > "$FIXTURE/.ci-homebrew-browser-mirror-state.json"
if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
        > "$TMP_DIR/browser-invalid-mirror-state.out" 2>&1; then
    echo "browser suite accepted malformed Homebrew mirror state" >&2
    exit 1
fi
grep -Fq \
    "ci-homebrew-browser-mirror-state: invalid state" \
    "$TMP_DIR/browser-invalid-mirror-state.out"
# A resolved state may not drop the closed mirror required by lazy transport.
printf '%s\n' \
    '{"abi_version":42,"entries":[]}' \
    > "$FIXTURE/.ci-test-publication-blockers.json"
write_resolved_browser_mirror_state \
    "$fixture_shell_image" \
    "$fixture_homebrew_bootstrap" \
    "$FIXTURE/.ci-test-publication-blockers.json" \
    "$FIXTURE/.ci-homebrew-browser-mirror-state.json"
jq '.mirror_required = false' \
    "$FIXTURE/.ci-homebrew-browser-mirror-state.json" \
    > "$FIXTURE/.ci-homebrew-browser-mirror-state.changed.json"
mv "$FIXTURE/.ci-homebrew-browser-mirror-state.changed.json" \
    "$FIXTURE/.ci-homebrew-browser-mirror-state.json"
if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$fixture_homebrew_bootstrap" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
        > "$TMP_DIR/browser-open-resolved-mirror-state.out" 2>&1; then
    echo "browser suite accepted a lazy shell without its mirror" >&2
    exit 1
fi
grep -Fq \
    "invalid resolved state contract" \
    "$TMP_DIR/browser-open-resolved-mirror-state.out"
rm "$FIXTURE/.ci-homebrew-browser-mirror-state.json"
if PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    FIXTURE_SHELL_IMAGE="$fixture_shell_image" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" browser \
        > "$TMP_DIR/browser-missing-mirror-state.out" 2>&1; then
    echo "browser suite accepted a prepared workspace without Homebrew mirror state" >&2
    exit 1
fi
grep -Fq \
    "prepared browser workspace lacks Homebrew mirror state" \
    "$TMP_DIR/browser-missing-mirror-state.out"

if ! awk '
    $0 != "build --release -p xtask --target fixture-host --quiet" {
        exit 1
    }
' "$CARGO_CAPTURE"; then
    echo "ci-run-test-suite.sh used an unexpected package-checker build command:" >&2
    cat "$CARGO_CAPTURE" >&2
    exit 1
fi
[ -s "$CARGO_CAPTURE" ] || {
    echo "ci-run-test-suite.sh did not prepare the source-workspace package checker" >&2
    exit 1
}

: > "$CARGO_CAPTURE"
PATH="$FIXTURE/bin:$PATH" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" cargo-xtask all
grep -Fxq \
    "test -p xtask --target fixture-host -- --skip homebrew --skip formula --skip bottle --skip tap" \
    "$CARGO_CAPTURE" || {
    echo "ci-run-test-suite.sh did not dispatch the cargo-xtask suite" >&2
    cat "$CARGO_CAPTURE" >&2
    exit 1
}
: > "$CARGO_CAPTURE"
PATH="$FIXTURE/bin:$PATH" \
    bash "$FIXTURE/scripts/ci-run-test-suite.sh" cargo-workspace all
grep -Fxq \
    "test --workspace --exclude xtask --target fixture-host" \
    "$CARGO_CAPTURE" || {
    echo "ci-run-test-suite.sh did not dispatch cargo-workspace" >&2
    cat "$CARGO_CAPTURE" >&2
    exit 1
}

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
    expected_rows=$'vitest:1/2\nvitest:2/2\nvitest:resource-isolated\nbrowser:all\nlibc:functional-regression\nlibc:math\nposix:all\nsortix:include\nsortix:basic\nsortix:runtime'
    if [ "$matrix_rows" != "$expected_rows" ]; then
        echo "$(basename "$workflow"): unexpected test-suite matrix:" >&2
        printf '%s\n' "$matrix_rows" >&2
        exit 1
    fi

    early_rows=$(sed -n '/^  test-suite-early:/,/^    env:/p' "$workflow" | awk '
        /^          - suite: / {
            suite = $0
            sub(/^          - suite: /, "", suite)
        }
        /^            kernel_only: / {
            kernel_only = $0
            sub(/^            kernel_only: /, "", kernel_only)
        }
        /^            submodules: / {
            submodules = $0
            sub(/^            submodules: /, "", submodules)
            gsub(/^\047|\047$/, "", submodules)
            print suite ":" kernel_only ":" submodules
        }
    ')
    expected_early_rows=$'cargo-workspace:true:\ncargo-xtask:false:libc/musl'
    if [ "$early_rows" != "$expected_early_rows" ]; then
        echo "$(basename "$workflow"): unexpected early Cargo suite matrix:" >&2
        printf '%s\n' "$early_rows" >&2
        exit 1
    fi
    early_block="$TMP_DIR/$(basename "$workflow").early-cargo"
    sed -n '/^  test-suite-early:/,/^  exact-abi-source-test-prepare:/p' \
        "$workflow" > "$early_block"
    grep -Fq '      - name: Fetch early suite submodule' "$early_block" || {
        echo "$(basename "$workflow"): early Cargo suites do not fetch declared submodules" >&2
        exit 1
    }
    grep -Fq '          submodules: ${{ matrix.submodules }}' "$early_block" || {
        echo "$(basename "$workflow"): early Cargo submodule fetch ignores the matrix" >&2
        exit 1
    }

    case "$(basename "$workflow")" in
        staging-build.yml)
            node_acceptance_name="Run exact staged Node npm acceptance"
            ;;
        prepare-merge.yml)
            node_acceptance_name="Build and run exact candidate Node npm acceptance"
            ;;
    esac
    node_acceptance_block="$TMP_DIR/$(basename "$workflow").node-acceptance"
    awk -v expected="      - name: $node_acceptance_name" '
        $0 == expected {
            inside = 1
            print
            next
        }
        inside && /^      - name: / { exit }
        inside { print }
    ' "$workflow" > "$node_acceptance_block"
    if [ "$(basename "$workflow")" = prepare-merge.yml ]; then
        dev_shell_count="$(grep -Fc 'scripts/dev-shell.sh' "$node_acceptance_block")"
        if [ "$dev_shell_count" -ne 1 ] ||
           ! grep -Fq "bash <<'NODE_ACCEPTANCE'" "$node_acceptance_block"; then
            echo "prepare-merge.yml: candidate Node resolve, build, and acceptance do not share one activated dev-shell process" >&2
            exit 1
        fi
    fi
    for contract in \
        "scripts/recover-homebrew-bottle-mirror.ts" \
        "programs/homebrew-bootstrap/homebrew-bootstrap.zip" \
        "KANDELO_NODE_LOCAL_BOOT_ASSET_ROOT" \
        "KANDELO_NODE_LOCAL_PROXY_PORT" \
        "http://127.0.0.1:\${node_proxy_port}/?" \
        "KANDELO_PLAYWRIGHT_SERVE_DIST=1" \
        "--grep '@node-npm-acceptance'"
    do
        grep -Fq -- "$contract" "$node_acceptance_block" || {
            echo "$(basename "$workflow"): exact Node acceptance lacks $contract" >&2
            exit 1
        }
    done
done

grep -Fq \
    'VERIFY_BROWSER_PRODUCTION_BUILD: ${{ matrix.suite == '\''browser'\'' }}' \
    "$REPO_ROOT/.github/workflows/prepare-merge.yml" &&
    grep -Fq \
        'VERIFY_BROWSER_PRODUCTION_BUILD="$VERIFY_BROWSER_PRODUCTION_BUILD" \' \
        "$REPO_ROOT/.github/workflows/prepare-merge.yml" || {
    echo "prepare-merge does not request the ordinary browser production build" >&2
    exit 1
}
if grep -Fq 'VERIFY_BROWSER_PRODUCTION_BUILD' \
    "$REPO_ROOT/.github/workflows/staging-build.yml"
then
    echo "staging duplicated prepare-merge's ordinary browser production build" >&2
    exit 1
fi

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
expected_force_rebuild_rows=$'cargo-workspace:all\ncargo-xtask:all\nvitest:1/2\nvitest:2/2\nvitest:resource-isolated\nlibc:functional-regression\nlibc:math\nposix:all\nsortix:include\nsortix:basic\nsortix:runtime'
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
                kernel|local-fixture|local-one|shell)
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
                shell:shell.vfs.zst)
                    printf '%s\n' \
                        '{"source_artifact":"shell.vfs.zst","mirror_path":"shell.vfs.zst"}'
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
: > "$CARGO_CAPTURE"
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
[ ! -s "$CARGO_CAPTURE" ] || {
    echo "ci-run-test-suite.sh rebuilt a transported package checker" >&2
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
)
BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$FIXTURE"
BROWSER_MEMORY64_FIXTURES_MANIFEST="$FIXTURE/scripts/browser-memory64-example-fixtures.txt"
memory64_outputs="$(browser_memory64_fixture_outputs)"
while IFS= read -r output; do
    prepared_files+=("$output")
done <<< "$memory64_outputs"
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
    "$source_cache/programs/$generation/bin/fixture.wasm" \
    "$FIXTURE/binaries/programs/wasm32/shell.vfs.zst"
mkdir -p \
    "$source_cache/programs/$generation/homebrew-bootstrap" \
    "$FIXTURE/binaries/programs/wasm32/homebrew-bootstrap"
printf 'Homebrew bootstrap\n' \
    > "$source_cache/programs/$generation/homebrew-bootstrap/homebrew-bootstrap.zip"
fixture_provenance="$source_cache/programs/.$generation.kandelo-provenance.toml"
printf 'fixture immutable Git provenance\n' > "$fixture_provenance"
ln -s \
    "$source_cache/programs/$generation/homebrew-bootstrap/homebrew-bootstrap.zip" \
    "$FIXTURE/binaries/programs/wasm32/homebrew-bootstrap/homebrew-bootstrap.zip"
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
homebrew_browser_mirror_state="$TMP_DIR/homebrew-browser-mirror-state.json"
printf '%s\n' \
    '{"abi_version":42,"entries":[{"package":"shell","blocker_chain":["shell"]}]}' \
    > "$publication_blockers"
write_blocked_browser_mirror_state \
    "$publication_blockers" \
    "$homebrew_browser_mirror_state"
PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        --publication-blockers "$publication_blockers" \
        --homebrew-browser-mirror-state "$homebrew_browser_mirror_state" \
        "$pack_archive"
pack_capture="$TMP_DIR/pack.list"
tar --zstd -tf "$pack_archive" > "$pack_capture"
grep -Fxq ".ci-test-publication-blockers.json" "$pack_capture" || {
    echo "pack-ci-test-workspace.sh: omitted publication blocker report" >&2
    exit 1
}
grep -Fxq ".ci-homebrew-browser-mirror-state.json" "$pack_capture" || {
    echo "pack-ci-test-workspace.sh: omitted Homebrew browser mirror state" >&2
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
cmp \
    "$homebrew_browser_mirror_state" \
    "$pack_extract/.ci-homebrew-browser-mirror-state.json"

resolved_pack_archive="$TMP_DIR/resolved-shell-workspace.tar.zst"
resolved_pack_blockers="$TMP_DIR/resolved-shell-publication-blockers.json"
resolved_pack_state="$TMP_DIR/resolved-shell-browser-mirror-state.json"
printf '%s\n' \
    '{"abi_version":42,"entries":[]}' \
    > "$resolved_pack_blockers"
write_resolved_browser_mirror_state \
    "$FIXTURE/binaries/programs/wasm32/shell.vfs.zst" \
    "$FIXTURE/binaries/programs/wasm32/homebrew-bootstrap/homebrew-bootstrap.zip" \
    "$resolved_pack_blockers" \
    "$resolved_pack_state"
PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        --publication-blockers "$resolved_pack_blockers" \
        --homebrew-browser-mirror-state "$resolved_pack_state" \
        "$resolved_pack_archive"
resolved_pack_extract="$TMP_DIR/resolved-shell-workspace"
mkdir -p "$resolved_pack_extract"
tar --zstd -xf "$resolved_pack_archive" -C "$resolved_pack_extract"
cmp \
    "$resolved_pack_state" \
    "$resolved_pack_extract/.ci-homebrew-browser-mirror-state.json"
cmp \
    "$FIXTURE/binaries/programs/wasm32/shell.vfs.zst" \
    "$resolved_pack_extract/binaries/programs/wasm32/shell.vfs.zst"

# A publication-blocked candidate is neither a public shell nor the legacy
# source bridge. Its receipt, mirror state, local generation, and frozen
# workspace must all name the same bytes and synthetic-merge tree.
candidate_handoff="$TMP_DIR/candidate-shell-handoff"
candidate_image="$candidate_handoff/main-shell.vfs.zst"
candidate_report="$candidate_handoff/main-shell-report.json"
candidate_receipt="$candidate_handoff/receipt.json"
mkdir -p "$candidate_handoff"
cp "$FIXTURE/binaries/programs/wasm32/shell.vfs.zst" "$candidate_image"
jq -n '
  {
    schema: 1,
    image: "main-shell.vfs.zst",
    metadata: {
      kandelo_repository: "Automattic/kandelo",
      kandelo_abi: 42
    },
    package_deferred_trees: [{
      state: "deferred",
      package: {name: "homebrew-bootstrap"}
    }],
    bottle_mirror: {assets: [{name: "bash"}]}
  }
' > "$candidate_report"
candidate_base="$(git -C "$FIXTURE" show -s --format=%P HEAD | awk '{print $1}')"
candidate_head="$(git -C "$FIXTURE" show -s --format=%P HEAD | awk '{print $2}')"
candidate_tree="$(git -C "$FIXTURE" rev-parse 'HEAD^{tree}')"
candidate_image_sha="$(sha256_file "$candidate_image")"
candidate_image_bytes="$(wc -c < "$candidate_image" | tr -d '[:space:]')"
candidate_report_sha="$(sha256_file "$candidate_report")"
candidate_report_bytes="$(wc -c < "$candidate_report" | tr -d '[:space:]')"
jq -n \
    --arg base "$candidate_base" \
    --arg head "$candidate_head" \
    --arg tree "$candidate_tree" \
    --arg image_sha "$candidate_image_sha" \
    --argjson image_bytes "$candidate_image_bytes" \
    --arg report_sha "$candidate_report_sha" \
    --argjson report_bytes "$candidate_report_bytes" '
      {
        schema: 1,
        kind: "kandelo-ci-staging-shell-handoff",
        repository: "Automattic/kandelo",
        workflow: ".github/workflows/staging-build.yml",
        validation_pull_request_number: 1160,
        validation_base_sha: $base,
        producer_head_sha: $head,
        producer_tree_sha: $tree,
        run_id: 30695913285,
        artifact: {
          id: 8817612908,
          name: "homebrew-main-shell-closure",
          archive_sha256:
            "9b44b0137cf63345f128bd5ffa2307d47c637166fc6244d8823d533faf38e523",
          bytes: 58453095
        },
        image: {sha256: $image_sha, bytes: $image_bytes},
        report: {sha256: $report_sha, bytes: $report_bytes}
      }
    ' > "$candidate_receipt"
candidate_identity="$FIXTURE/local-binaries/.kandelo-local-generations/wasm32/shell/$cache_key"
candidate_member="$candidate_identity/staging/shell.vfs.zst"
candidate_mirror="$FIXTURE/local-binaries/programs/wasm32/shell.vfs.zst"
mkdir -p "$(dirname "$candidate_member")" "$(dirname "$candidate_mirror")"
cp "$candidate_image" "$candidate_member"
: > "$candidate_identity/.staging.publication-claimed"
ln -s "$candidate_member" "$candidate_mirror"

candidate_expected="$TMP_DIR/candidate-expected.json"
candidate_blockers="$TMP_DIR/candidate-blockers.json"
candidate_index="$TMP_DIR/candidate-index.toml"
candidate_state="$TMP_DIR/candidate-mirror-state.json"
jq -n '{abi_version: 42, entries: []}' > "$candidate_expected"
jq -n '{
  abi_version: 42,
  entries: [{package: "shell", blocker_chain: ["shell"]}]
}' > "$candidate_blockers"
printf '%s\n' 'abi_version = 42' > "$candidate_index"
(
    cd "$FIXTURE"
    FIXTURE_SHELL_IMAGE="$candidate_member" \
        bash scripts/ci-homebrew-browser-mirror-state.sh create \
            "$candidate_expected" "$candidate_blockers" \
            "$candidate_index" https://invalid.example/index.toml \
            "$candidate_member" - "$candidate_state" "$candidate_receipt"
    FIXTURE_SHELL_IMAGE="$candidate_member" \
        bash scripts/ci-homebrew-browser-mirror-state.sh validate consumer \
            "$candidate_state" "$candidate_blockers" \
            "$candidate_member" - "$candidate_receipt"
)
[ "$(jq -r '.mirror_required' "$candidate_state")" = true ] || {
    echo "transported candidate lost closed bottle-mirror acceptance" >&2
    exit 1
}
candidate_archive="$TMP_DIR/candidate-workspace.tar.zst"
(
    cd "$FIXTURE"
    PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
        bash scripts/pack-ci-test-workspace.sh \
            --publication-blockers "$candidate_blockers" \
            --homebrew-browser-mirror-state "$candidate_state" \
            --staging-shell-handoff "$candidate_handoff" \
            "$candidate_archive"
)
candidate_extract="$TMP_DIR/candidate-workspace"
mkdir -p "$candidate_extract"
tar --zstd -xf "$candidate_archive" -C "$candidate_extract"
for authority in \
    .ci-homebrew-browser-mirror-state.json \
    .ci-staging-shell-receipt.json \
    .ci-staging-shell-report.json; do
    [ -f "$candidate_extract/$authority" ] &&
        [ ! -L "$candidate_extract/$authority" ] || {
        echo "candidate workspace omitted regular authority $authority" >&2
        exit 1
    }
done
cmp "$candidate_receipt" \
    "$candidate_extract/.ci-staging-shell-receipt.json"
cmp "$candidate_report" \
    "$candidate_extract/.ci-staging-shell-report.json"
cmp "$candidate_image" \
    "$candidate_extract/local-binaries/programs/wasm32/shell.vfs.zst"

candidate_plain_state="$TMP_DIR/candidate-plain-state.json"
(
    cd "$FIXTURE"
    bash scripts/ci-homebrew-browser-mirror-state.sh create \
        "$candidate_expected" "$candidate_blockers" \
        "$candidate_index" https://invalid.example/index.toml \
        - - "$candidate_plain_state"
)
if (
    cd "$FIXTURE"
    PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
        bash scripts/pack-ci-test-workspace.sh \
            --publication-blockers "$candidate_blockers" \
            --homebrew-browser-mirror-state "$candidate_plain_state" \
            --staging-shell-handoff "$candidate_handoff" \
            "$TMP_DIR/rejected-downgraded-candidate.tar.zst"
) > "$TMP_DIR/rejected-downgraded-candidate.out" 2>&1; then
    echo "candidate workspace accepted a downgrade to the source bridge" >&2
    exit 1
fi
grep -Fq 'staging handoff requires candidate mirror state' \
    "$TMP_DIR/rejected-downgraded-candidate.out"
if (
    cd "$FIXTURE"
    PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
        bash scripts/pack-ci-test-workspace.sh \
            --publication-blockers "$candidate_blockers" \
            --homebrew-browser-mirror-state "$candidate_state" \
            "$TMP_DIR/rejected-missing-candidate.tar.zst"
) > "$TMP_DIR/rejected-missing-candidate.out" 2>&1; then
    echo "candidate workspace accepted missing handoff authority" >&2
    exit 1
fi
grep -Fq 'candidate mirror state lacks its staging handoff' \
    "$TMP_DIR/rejected-missing-candidate.out"
printf 'substituted local shell\n' > "$candidate_member"
if (
    cd "$FIXTURE"
    PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
        bash scripts/pack-ci-test-workspace.sh \
            --publication-blockers "$candidate_blockers" \
            --homebrew-browser-mirror-state "$candidate_state" \
            --staging-shell-handoff "$candidate_handoff" \
            "$TMP_DIR/rejected-substituted-candidate.tar.zst"
) > "$TMP_DIR/rejected-substituted-candidate.out" 2>&1; then
    echo "candidate workspace accepted substituted local shell bytes" >&2
    exit 1
fi
grep -Fq 'candidate shell bytes do not match state' \
    "$TMP_DIR/rejected-substituted-candidate.out"
rm -rf "$candidate_identity"
rm -f "$candidate_mirror"

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
cmp \
    "$fixture_provenance" \
    "$pack_extract/.ci-test-binary-cache/programs/.$generation.kandelo-provenance.toml"
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
    "$FIXTURE/scripts/activate-ci-test-workspace.sh" \
    "$FIXTURE/scripts/ci-homebrew-browser-mirror-state.sh" \
    "$FIXTURE/scripts/ci-run-test-suite.sh" \
    "$FIXTURE/scripts/ci-check-browser-assets.sh" \
    "$FIXTURE/scripts/resolve-binary.sh" \
    "$FIXTURE/scripts/materialize-ci-publication-blockers.sh" \
    "$FIXTURE/scripts/validate-publication-blocker-report.sh" \
    "$pack_extract/scripts/"
cp "$FIXTURE/run.sh" "$pack_extract/run.sh"
git -C "$pack_extract" init -q
git -C "$pack_extract" fetch -q "$FIXTURE" HEAD
fixture_source_commit="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$pack_extract" update-ref refs/heads/fixture "$fixture_source_commit"
git -C "$pack_extract" symbolic-ref HEAD refs/heads/fixture
browser_cache_capture="$TMP_DIR/relocated-browser-cache"
browser_xtask_capture="$TMP_DIR/relocated-browser-xtask"
relocated_recovery_capture="$TMP_DIR/relocated-browser-recovery.args"
relocated_closed_root_capture="$TMP_DIR/relocated-browser-closed-root"
relocated_closed_vite_root_capture="$TMP_DIR/relocated-browser-closed-vite-root"
relocated_closed_mode_capture="$TMP_DIR/relocated-browser-closed-mode"
relocated_source_shell_expectation_capture="$TMP_DIR/relocated-browser-source-shell-expectation"
relocated_source_composition_check_capture="$TMP_DIR/relocated-browser-source-composition-check"
relocated_runner_temp="$TMP_DIR/relocated-runner"
mkdir "$relocated_runner_temp"
PATH="$FIXTURE/bin:$PATH" \
    RUN_CAPTURE="$TMP_DIR/relocated-browser-run.args" \
    RUN_CACHE_CAPTURE="$browser_cache_capture" \
    RUN_XTASK_CAPTURE="$browser_xtask_capture" \
    BLOCKER_CAPTURE="$TMP_DIR/relocated-browser-blockers" \
    RECOVERY_CAPTURE="$relocated_recovery_capture" \
    CLOSED_ROOT_CAPTURE="$relocated_closed_root_capture" \
    CLOSED_VITE_ROOT_CAPTURE="$relocated_closed_vite_root_capture" \
    CLOSED_MODE_CAPTURE="$relocated_closed_mode_capture" \
    SOURCE_SHELL_EXPECTATION_CAPTURE="$relocated_source_shell_expectation_capture" \
    SOURCE_COMPOSITION_CHECK_CAPTURE="$relocated_source_composition_check_capture" \
    FIXTURE_SHELL_IMAGE="$(realpath "$pack_extract/binaries/programs/wasm32/shell.vfs.zst")" \
    FIXTURE_HOMEBREW_BOOTSTRAP="$(realpath "$pack_extract/binaries/programs/wasm32/homebrew-bootstrap/homebrew-bootstrap.zip")" \
    RUNNER_TEMP="$relocated_runner_temp" \
    PREPARE_BROWSER_ASSETS=true \
    VERIFY_BROWSER_PRODUCTION_BUILD=true \
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
[ ! -e "$relocated_recovery_capture" ] || {
    echo "relocated source bridge attempted bottle-mirror recovery" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$relocated_closed_root_capture")" -eq 2 ] || {
    echo "relocated source bridge inherited a closed mirror root" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$relocated_closed_vite_root_capture")" -eq 2 ] || {
    echo "relocated source bridge inherited closed Vite authority" >&2
    exit 1
}
[ "$(grep -Fxc '<unset>' "$relocated_closed_mode_capture")" -eq 2 ] || {
    echo "relocated source bridge selected closed acceptance" >&2
    exit 1
}
[ "$(grep -Fxc '1' "$relocated_source_shell_expectation_capture")" -eq 2 ] || {
    echo "relocated source bridge omitted its shell ownership" >&2
    exit 1
}
grep -Fxq \
    "$(realpath "$pack_extract/binaries/programs/wasm32/shell.vfs.zst")" \
    "$relocated_source_composition_check_capture" || {
    echo "relocated source bridge did not inspect its image" >&2
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
    test_gate_prepare_job="$TMP_DIR/$(basename "$workflow").test-gate-prepare"
    awk '
      /^  test-gate-prepare:$/ {
        inside = 1
        print
        next
      }
      inside && /^  [a-zA-Z0-9_-]+:$/ { exit }
      inside { print }
    ' "$workflow" > "$test_gate_prepare_job"
    npm_install_line="$(awk '
      /npm ci --no-audit --no-fund/ { print NR; exit }
    ' "$test_gate_prepare_job")"
    mirror_state_line="$(awk '
      /scripts\/ci-homebrew-browser-mirror-state\.sh/ { print NR; exit }
    ' "$test_gate_prepare_job")"
    if ! [[ "$npm_install_line" =~ ^[1-9][0-9]*$ ]] ||
       ! [[ "$mirror_state_line" =~ ^[1-9][0-9]*$ ]] ||
       [ "$npm_install_line" -ge "$mirror_state_line" ]; then
        echo "$(basename "$workflow"): fresh test-gate shell inspection runs before installing declared root JavaScript dependencies" >&2
        exit 1
    fi
    required_root_install='      - name: Install root npm dependencies for shell inspection
        run: |
          bash scripts/dev-shell.sh env \
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
            npm ci --no-audit --no-fund'
    grep -Fq "$required_root_install" "$test_gate_prepare_job" || {
        echo "$(basename "$workflow"): fresh test-gate shell inspection does not use the root dev-shell lockfile install without browser downloads" >&2
        exit 1
    }
    grep -Fq -- '--blocked-output "$BLOCKED"' "$workflow" || {
        echo "$(basename "$workflow"): expected ledger omits the publication blocker report" >&2
        exit 1
    }
    grep -Fq -- '--publication-blockers "$RUNNER_TEMP/' "$workflow" || {
        echo "$(basename "$workflow"): prepared workspace omits the publication blocker report" >&2
        exit 1
    }
    case "$(basename "$workflow")" in
        prepare-merge.yml)
            grep -Fq 'state_args=(' "$workflow" &&
                grep -Fq 'scripts/ci-homebrew-browser-mirror-state.sh \' \
                    "$workflow" &&
                grep -Fq 'bash scripts/dev-shell.sh bash \' "$workflow" || {
                echo "$(basename "$workflow"): candidate shell lacks canonical publication comparison" >&2
                exit 1
            }
            ;;
        *)
            grep -Fq \
                'scripts/ci-homebrew-browser-mirror-state.sh create \' \
                "$workflow" || {
                echo "$(basename "$workflow"): candidate shell lacks canonical publication comparison" >&2
                exit 1
            }
            if ! grep -F -A1 'bash scripts/dev-shell.sh \' "$workflow" |
                grep -Fq \
                    'bash scripts/ci-homebrew-browser-mirror-state.sh create \'; then
                echo "$(basename "$workflow"): browser mirror authority uses ambient runner tools" >&2
                exit 1
            fi
            ;;
    esac
    grep -Fq 'scripts/materialize-ci-canonical-package-index.sh \' "$workflow" || {
        echo "$(basename "$workflow"): candidate shell bypasses authenticated canonical index materialization" >&2
        exit 1
    }
    grep -Fq -- '--homebrew-browser-mirror-state "$RUNNER_TEMP/' "$workflow" || {
        echo "$(basename "$workflow"): prepared workspace omits Homebrew browser mirror state" >&2
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

mirror_expected="$TMP_DIR/homebrew-browser-mirror-expected.json"
mirror_blockers="$TMP_DIR/homebrew-browser-mirror-blockers.json"
mirror_canonical="$TMP_DIR/homebrew-browser-mirror-canonical.toml"
mirror_abi="$(sed -nE \
    's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
    "$REPO_ROOT/crates/shared/src/lib.rs")"
[[ "$mirror_abi" =~ ^[0-9]+$ ]] || {
    echo "cannot derive the active ABI for the browser mirror fixture" >&2
    exit 1
}
mirror_selection="$TMP_DIR/homebrew-browser-mirror-selection.json"
node --input-type=module - \
    "$REPO_ROOT/homebrew/main-shell-flat-selection.json" \
    "$mirror_selection" "$mirror_abi" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
};
const selection = JSON.parse(readFileSync(process.argv[2], "utf8"));
const abi = Number(process.argv[4]);
if (!Number.isInteger(abi) || abi < 0) {
  throw new Error("browser mirror selection fixture requires a nonnegative integer ABI");
}
selection.kandeloAbi = abi;
selection.name = `main-shell-abi${abi}-wasm32`;
for (const bottle of selection.bottles) bottle.kandeloAbi = abi;
writeFileSync(process.argv[3], `${JSON.stringify(normalize(selection))}\n`);
NODE
export KANDELO_CANONICAL_FLAT_SELECTION="$mirror_selection"
mirror_canonical_url="https://github.com/Automattic/kandelo/releases/download/binaries-abi-v${mirror_abi}/index.toml"
mirror_state="$TMP_DIR/generated-homebrew-browser-mirror-state.json"
mirror_shell_image="$TMP_DIR/canonical-flat-lazy-shell.vfs.zst"
mirror_homebrew_bootstrap="$TMP_DIR/homebrew-bootstrap.zip"
mirror_stub_bin="$TMP_DIR/mirror-state-bin"
mirror_cache_key="$(printf 'b%.0s' {1..64})"
mirror_archive_sha="$(printf 'a%.0s' {1..64})"
printf 'flat-lazy shell\n' > "$mirror_shell_image"
printf 'Homebrew bootstrap\n' > "$mirror_homebrew_bootstrap"
mkdir "$mirror_stub_bin"
cp "$FIXTURE/bin/npx" "$mirror_stub_bin/npx"
# WHY: the production mirror-state script must consume an already-built,
# reviewed parser instead of compiling code while deciding publication
# authority. This source-only integration test owns that prerequisite so it
# exercises the current Rust parser even in a clean CI checkout.
mirror_host_target="$(rustc -vV | awk '/^host/ {print $2}')"
cargo build --release -p xtask --target "$mirror_host_target"
mirror_xtask="$REPO_ROOT/target/$mirror_host_target/release/xtask"
printf '%s\n' \
    "{\"abi_version\":${mirror_abi},\"entries\":[]}" \
    > "$mirror_blockers"
jq -n --arg cache_key "$mirror_cache_key" --argjson abi "$mirror_abi" '
  {
    abi_version: $abi,
    entries: [{
      package: "shell",
      kind: "program",
      arch: "wasm32",
      version: "0.1.0",
      revision: 22,
      cache_key_sha: $cache_key,
      git_inputs: []
    }]
  }
' > "$mirror_expected"
cat > "$mirror_canonical" <<EOF
abi_version = $mirror_abi
generated_at = "1970-01-01T00:00:00Z"
generator = "fixture"

[[packages]]
name = "shell"
version = "0.1.0"
revision = 22

[packages.binary.wasm32]
status = "success"
archive_url = "shell-0.1.0-rev22-abi${mirror_abi}-wasm32-bbbbbbbb.tar.zst"
archive_sha256 = "$mirror_archive_sha"
cache_key_sha = "$mirror_cache_key"
EOF
PATH="$mirror_stub_bin:$PATH" WASM_POSIX_XTASK_BIN="$mirror_xtask" \
  bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" create \
    "$mirror_expected" \
    "$mirror_blockers" \
    "$mirror_canonical" \
    "$mirror_canonical_url" \
    "$mirror_shell_image" \
    "$mirror_homebrew_bootstrap" \
    "$mirror_state"
[ "$(jq -r '.mirror_required' "$mirror_state")" = true ] &&
    [ "$(jq -r '.transport' "$mirror_state")" = flat-lazy ] || {
    echo "canonical shell identity did not retain flat-lazy transport" >&2
    exit 1
}
sed '/^archive_url = /d' \
    "$mirror_canonical" > "$TMP_DIR/homebrew-browser-mirror-incomplete.toml"
if PATH="$mirror_stub_bin:$PATH" WASM_POSIX_XTASK_BIN="$mirror_xtask" \
  bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" create \
    "$mirror_expected" \
    "$mirror_blockers" \
    "$TMP_DIR/homebrew-browser-mirror-incomplete.toml" \
    "$mirror_canonical_url" \
    "$mirror_shell_image" \
    "$mirror_homebrew_bootstrap" \
    "$mirror_state" \
    >"$TMP_DIR/homebrew-browser-mirror-incomplete.out" 2>&1; then
    echo "incomplete canonical success authorized shell publication" >&2
    exit 1
fi
grep -Fq "canonical shell entry is invalid" \
    "$TMP_DIR/homebrew-browser-mirror-incomplete.out"
sed 's/revision = 22/revision = 21/' \
    "$mirror_canonical" > "$TMP_DIR/homebrew-browser-mirror-stale.toml"
PATH="$mirror_stub_bin:$PATH" WASM_POSIX_XTASK_BIN="$mirror_xtask" \
  bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" create \
    "$mirror_expected" \
    "$mirror_blockers" \
    "$TMP_DIR/homebrew-browser-mirror-stale.toml" \
    "$mirror_canonical_url" \
    "$mirror_shell_image" \
    "$mirror_homebrew_bootstrap" \
    "$mirror_state"
[ "$(jq -r '.mirror_required' "$mirror_state")" = true ] &&
    [ "$(jq -r '.transport' "$mirror_state")" = flat-lazy ] || {
    echo "unpublished canonical identity lost its flat-lazy inspection" >&2
    exit 1
}
printf 'mutated shell image\n' > "$TMP_DIR/mutated-shell.vfs.zst"
if PATH="$mirror_stub_bin:$PATH" WASM_POSIX_XTASK_BIN="$mirror_xtask" \
  bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" validate \
    consumer "$mirror_state" "$mirror_blockers" \
    "$TMP_DIR/mutated-shell.vfs.zst" \
    "$mirror_homebrew_bootstrap" \
    >"$TMP_DIR/mutated-shell-state.out" 2>&1; then
    echo "Homebrew browser mirror state accepted different shell bytes" >&2
    exit 1
fi
grep -Fq "resolved shell bytes do not match state" \
    "$TMP_DIR/mutated-shell-state.out"

blocked_expected="$TMP_DIR/homebrew-browser-blocked-expected.json"
blocked_report="$TMP_DIR/homebrew-browser-blocked-report.json"
jq -n --argjson abi "$mirror_abi" \
    '{abi_version: $abi, entries: []}' > "$blocked_expected"
printf '%s\n' \
    "{\"abi_version\":${mirror_abi},\"entries\":[{\"package\":\"shell\",\"blocker_chain\":[\"shell\"]}]}" \
    > "$blocked_report"
bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" create \
    "$blocked_expected" \
    "$blocked_report" \
    "$mirror_canonical" \
    "$mirror_canonical_url" \
    - \
    - \
    "$mirror_state"
[ "$(jq -r '.mode' "$mirror_state")" = publication-blocked ] || {
    echo "publication-blocked shell did not receive source authority state" >&2
    exit 1
}
[ "$(jq -r '.mirror_required' "$mirror_state")" = false ] || {
    echo "source authority state incorrectly required a bottle mirror" >&2
    exit 1
}
bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" validate \
    producer "$mirror_state" "$blocked_report" - -
blocked_forged_state="$TMP_DIR/homebrew-browser-blocked-forged.json"
jq '.mirror_required = true' "$mirror_state" > "$blocked_forged_state"
if bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" validate \
    producer "$blocked_forged_state" "$blocked_report" - - \
    >"$TMP_DIR/blocked-forged-producer.out" 2>&1; then
    echo "publication-blocked producer accepted forged mirror authority" >&2
    exit 1
fi
grep -Fq "invalid publication-blocked state contract" \
    "$TMP_DIR/blocked-forged-producer.out"
if bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" validate \
    consumer "$blocked_forged_state" "$blocked_report" \
    "$fixture_shell_image" - \
    >"$TMP_DIR/blocked-forged-consumer.out" 2>&1; then
    echo "publication-blocked consumer accepted forged mirror authority" >&2
    exit 1
fi
grep -Fq "invalid publication-blocked state contract" \
    "$TMP_DIR/blocked-forged-consumer.out"
if bash "$REPO_ROOT/scripts/ci-homebrew-browser-mirror-state.sh" validate \
    producer "$mirror_state" "$blocked_report" "$fixture_shell_image" - \
    >"$TMP_DIR/blocked-preauthorization.out" 2>&1; then
    echo "publication-blocked producer pre-authorized shell bytes" >&2
    exit 1
fi
grep -Fq "producer must not pre-authorize" \
    "$TMP_DIR/blocked-preauthorization.out"
unset KANDELO_CANONICAL_FLAT_SELECTION

canonical_state_stub="$TMP_DIR/canonical-index-state-stub.sh"
canonical_parser_stub="$TMP_DIR/canonical-index-parser-stub.sh"
cat > "$canonical_state_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = snapshot ] || exit 2
shift
output=""
head_file=""
abi=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --target-tag) shift 2 ;;
        --expected-abi) abi="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        --head-file) head_file="$2"; shift 2 ;;
        *) exit 2 ;;
    esac
done
case "${STATE_MODE:-valid}" in
    absent) exit 44 ;;
    uncertain) exit 47 ;;
    missing-head)
        printf 'abi_version = %s\ngenerated_at = "now"\ngenerator = "stub"\n' \
            "$abi" > "$output"
        ;;
    malformed)
        printf 'abi_version = %s\nMALFORMED\n' "$abi" > "$output"
        printf 'empty\n' > "$head_file"
        ;;
    valid)
        printf 'abi_version = %s\ngenerated_at = "now"\ngenerator = "stub"\n' \
            "$abi" > "$output"
        printf 'empty\n' > "$head_file"
        ;;
    *) exit 2 ;;
esac
EOF
cat > "$canonical_parser_stub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = index-candidate ] && [ "${2:-}" = seed ] || exit 2
printf '%s\n' "$*" > "$PARSER_CAPTURE"
shift 2
input=""
output=""
abi=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --canonical-index) input="$2"; shift 2 ;;
        --candidate-index) output="$2"; shift 2 ;;
        --expected-abi) abi="$2"; shift 2 ;;
        --canonical-index-url|--generated-at|--generator) shift 2 ;;
        *) exit 2 ;;
    esac
done
[ -f "$input" ] && [ -n "$output" ] && [ -n "$abi" ] || exit 1
grep -Fqx "abi_version = $abi" "$input" || exit 1
grep -Fq 'generated_at = "' "$input" || exit 1
grep -Fq 'generator = "' "$input" || exit 1
! grep -Fq MALFORMED "$input" || exit 1
cp "$input" "$output"
EOF
chmod +x "$canonical_state_stub" "$canonical_parser_stub"

canonical_out="$TMP_DIR/materialized-canonical-index.toml"
parser_capture="$TMP_DIR/canonical-parser.args"
CANONICAL_INDEX_STATE_SCRIPT="$canonical_state_stub" \
WASM_POSIX_XTASK_BIN="$canonical_parser_stub" \
PARSER_CAPTURE="$parser_capture" \
GITHUB_REPOSITORY=Automattic/kandelo \
STATE_MODE=valid \
    bash "$REPO_ROOT/scripts/materialize-ci-canonical-package-index.sh" \
        binaries-abi-v42 42 "$canonical_out"
[ -s "$canonical_out" ] || {
    echo "canonical index materializer omitted its validated snapshot" >&2
    exit 1
}
grep -Fq \
    'https://github.com/Automattic/kandelo/releases/download/binaries-abi-v42/index.toml' \
    "$parser_capture" || {
    echo "canonical index parser did not receive the release-bound URL" >&2
    exit 1
}

authenticated_canonical="$TMP_DIR/authenticated-canonical-index.toml"
printf '%s\n' \
    'abi_version = 42' \
    'generated_at = "trusted"' \
    'generator = "trusted predecessor"' > "$authenticated_canonical"
authenticated_out="$TMP_DIR/materialized-authenticated-index.toml"
STATE_MODE=uncertain \
CANONICAL_INDEX_STATE_SCRIPT="$canonical_state_stub" \
WASM_POSIX_XTASK_BIN="$canonical_parser_stub" \
PARSER_CAPTURE="$parser_capture" \
GITHUB_REPOSITORY=Automattic/kandelo \
    bash "$REPO_ROOT/scripts/materialize-ci-canonical-package-index.sh" \
        binaries-abi-v42 42 "$authenticated_out" \
        --authenticated-snapshot "$authenticated_canonical"
cmp "$authenticated_canonical" "$authenticated_out" || {
    echo "canonical index materializer changed authenticated snapshot bytes" >&2
    exit 1
}

ln -s "$authenticated_canonical" \
    "$TMP_DIR/symlinked-authenticated-canonical-index.toml"
if WASM_POSIX_XTASK_BIN="$canonical_parser_stub" \
    PARSER_CAPTURE="$parser_capture" \
    GITHUB_REPOSITORY=Automattic/kandelo \
    bash "$REPO_ROOT/scripts/materialize-ci-canonical-package-index.sh" \
        binaries-abi-v42 42 \
        "$TMP_DIR/rejected-symlinked-authenticated-index.toml" \
        --authenticated-snapshot \
        "$TMP_DIR/symlinked-authenticated-canonical-index.toml" \
        >"$TMP_DIR/rejected-symlinked-authenticated.out" 2>&1; then
    echo "canonical index materializer accepted a symlinked snapshot" >&2
    exit 1
fi

printf '%s\n' \
    'abi_version = 43' \
    'generated_at = "wrong ABI"' \
    'generator = "trusted predecessor"' \
    > "$TMP_DIR/wrong-abi-authenticated-index.toml"
printf 'preserve-on-parser-failure\n' \
    > "$TMP_DIR/rejected-wrong-abi-authenticated-index.toml"
if WASM_POSIX_XTASK_BIN="$canonical_parser_stub" \
    PARSER_CAPTURE="$parser_capture" \
    GITHUB_REPOSITORY=Automattic/kandelo \
    bash "$REPO_ROOT/scripts/materialize-ci-canonical-package-index.sh" \
        binaries-abi-v42 42 \
        "$TMP_DIR/rejected-wrong-abi-authenticated-index.toml" \
        --authenticated-snapshot \
        "$TMP_DIR/wrong-abi-authenticated-index.toml" \
        >"$TMP_DIR/rejected-wrong-abi-authenticated.out" 2>&1; then
    echo "canonical index materializer accepted a wrong-ABI snapshot" >&2
    exit 1
fi
grep -Fqx 'preserve-on-parser-failure' \
    "$TMP_DIR/rejected-wrong-abi-authenticated-index.toml" || {
    echo "canonical index parser failure replaced the prior output" >&2
    exit 1
}

STATE_MODE=absent \
CANONICAL_INDEX_STATE_SCRIPT="$canonical_state_stub" \
WASM_POSIX_XTASK_BIN="$canonical_parser_stub" \
PARSER_CAPTURE="$parser_capture" \
GITHUB_REPOSITORY=Automattic/kandelo \
    bash "$REPO_ROOT/scripts/materialize-ci-canonical-package-index.sh" \
        binaries-abi-v43 43 "$canonical_out"
grep -Fqx 'abi_version = 43' "$canonical_out" || {
    echo "confirmed-absent ABI release did not materialize an empty index" >&2
    exit 1
}

for rejected_state in uncertain missing-head malformed; do
    rejected_out="$TMP_DIR/rejected-$rejected_state-index.toml"
    if STATE_MODE="$rejected_state" \
        CANONICAL_INDEX_STATE_SCRIPT="$canonical_state_stub" \
        WASM_POSIX_XTASK_BIN="$canonical_parser_stub" \
        PARSER_CAPTURE="$parser_capture" \
        GITHUB_REPOSITORY=Automattic/kandelo \
        bash "$REPO_ROOT/scripts/materialize-ci-canonical-package-index.sh" \
            binaries-abi-v42 42 "$rejected_out" \
            >"$TMP_DIR/rejected-$rejected_state.out" 2>&1; then
        echo "canonical index materializer accepted $rejected_state state" >&2
        exit 1
    fi
    [ ! -e "$rejected_out" ] || {
        echo "canonical index materializer published $rejected_state output" >&2
        exit 1
    }
done

echo "ci-run-test-suite: conformance group mappings passed"
