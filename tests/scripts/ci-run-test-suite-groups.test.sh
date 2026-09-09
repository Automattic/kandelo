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
    "$FIXTURE/web-libs/kandelo-web" \
    "$FIXTURE/bin"
cp \
    "$REPO_ROOT/scripts/activate-ci-test-workspace.sh" \
    "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh" \
    "$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt" \
    "$REPO_ROOT/scripts/ci-run-test-suite.sh" \
    "$REPO_ROOT/scripts/ci-vitest-resource-isolated-cases.tsv" \
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
    if [ -n "${PRODUCTION_BUILD_CAPTURE:-}" ]; then
        {
            printf 'inputs=%s\n' "${KANDELO_BROWSER_DEMO_INPUTS:-<unset>}"
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
    local fetch_line
    local production_line
    function_block="$(sed -n \
        '/^run_pages_shaped_browser_build() {$/,/^}$/p' "$runner")"
    browser_block="$(sed -n '/^    browser)$/,/^        ;;/p' "$runner")"

    for binding in \
        '-u KANDELO_BROWSER_DEMO_INPUTS' \
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
    grep -Fq 'ordinary browser build found stale output' \
        <<<"$function_block" || return 1
    [ "$(grep -Fc 'run_pages_shaped_browser_build' <<<"$browser_block")" -eq 1 ] ||
        return 1
    materialize_line="$(grep -nF \
        'bash scripts/materialize-ci-publication-blockers.sh' \
        <<<"$browser_block" | cut -d: -f1)"
    [ "$(grep -Fc \
        './run.sh --already-materialized --fetch-only prepare-browser' \
        <<<"$browser_block")" -eq 1 ] || return 1
    fetch_line="$(grep -nF \
        './run.sh --already-materialized --fetch-only prepare-browser' \
        <<<"$browser_block" | head -n 1 | cut -d: -f1)"
    production_line="$(grep -nF 'run_pages_shaped_browser_build' \
        <<<"$browser_block" | cut -d: -f1)"
    [ -n "$materialize_line" ] &&
        [ -n "$fetch_line" ] &&
        [ -n "$production_line" ] &&
        [ "$materialize_line" -lt "$fetch_line" ] &&
        [ "$fetch_line" -lt "$production_line" ]
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
# The runner appends the disabled-software exclusions to every ordinary and
# exact Vitest run. Mirror that exact suffix so the captured command lines match.
disabled_software_excludes="--exclude=**/*brew* --exclude=../**/*brew* --exclude=**/*bottle* --exclude=../**/*bottle* --exclude=**/*formula* --exclude=../**/*formula* --exclude=**/*tap* --exclude=../**/*tap* --exclude=test/abi-staging-mini-vfs.test.ts --exclude=test/abi-staging-product-builders.test.ts --exclude=test/privileged-projection.test.ts --exclude=test/shell-vfs-build.test.ts --exclude=test/vfs-product-builder-contract.test.ts"
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
    "vitest run $resource_exclude $disabled_software_excludes"$'\n'"$resource_invocations" 1
run_vitest_group 1/2 \
    "vitest run --shard=1/2 $resource_exclude $disabled_software_excludes" 1
run_vitest_group 2/2 \
    "vitest run --shard=2/2 $resource_exclude $disabled_software_excludes" 0
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
    "vitest run --exclude=test/prepared-product.test.ts --exclude=../packages/registry/zip/test/zip.test.ts --exclude=../packages/registry/ruby/test/posix-spawn.test.ts $disabled_software_excludes"$'\n'"$resource_invocations" ] || {
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
production_build_capture="$TMP_DIR/browser-production-build"
runner_temp="$TMP_DIR/runner"
mkdir "$runner_temp"
PATH="$FIXTURE/bin:$PATH" RUN_CAPTURE="$browser_capture" \
    BLOCKER_CAPTURE="$blocker_capture" \
    PRODUCTION_BUILD_CAPTURE="$production_build_capture" \
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
    "test -p xtask --target fixture-host -- --skip formula --skip bottle --skip tap" \
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
fixture_provenance="$source_cache/programs/.$generation.kandelo-provenance.toml"
printf 'fixture immutable Git provenance\n' > "$fixture_provenance"
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

# The kernel compatibility path is a package mirror. Regular bytes at that
# path have no generation/cache ownership and must never enter a prepared
# workspace.
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

printf 'internal but identityless root bytes\n' \
    > "$FIXTURE/local-binaries/not-a-generation.wasm"
package_owned_root="$FIXTURE/local-binaries/kernel.wasm"
rm "$package_owned_root"
ln -s "not-a-generation.wasm" "$package_owned_root"
if PATH="$FIXTURE/bin:$PATH" \
    WASM_POSIX_BINARY_CACHE_ROOT="$source_cache" \
    bash "$FIXTURE/scripts/pack-ci-test-workspace.sh" \
        "$TMP_DIR/internal-kernel-workspace.tar.zst" \
        > "$TMP_DIR/internal-kernel-workspace.out" 2>&1; then
    echo "pack-ci-test-workspace.sh accepted an internal identityless kernel mirror" >&2
    exit 1
fi
grep -Fq "package-owned root mirror must select a declared local generation" \
    "$TMP_DIR/internal-kernel-workspace.out"
rm "$package_owned_root"
ln -s "$local_kernel" "$package_owned_root"
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
relocated_runner_temp="$TMP_DIR/relocated-runner"
mkdir "$relocated_runner_temp"
PATH="$FIXTURE/bin:$PATH" \
    RUN_CAPTURE="$TMP_DIR/relocated-browser-run.args" \
    RUN_CACHE_CAPTURE="$browser_cache_capture" \
    RUN_XTASK_CAPTURE="$browser_xtask_capture" \
    BLOCKER_CAPTURE="$TMP_DIR/relocated-browser-blockers" \
    PRODUCTION_BUILD_CAPTURE="$TMP_DIR/relocated-browser-production-build" \
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

for workflow in \
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
