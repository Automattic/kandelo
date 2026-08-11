#!/usr/bin/env bash
set -euo pipefail

# CI-shaped suite runner. The optional group selects deterministic shards:
#   vitest: 1/2 | 2/2 | resource-isolated
#   libc:   functional-regression | math
#   sortix: include | basic | runtime
# Omitting the group preserves the complete local suite behavior.
# Set PREPARE_BROWSER_ASSETS=1 when the caller supplied an already-materialized
# binaries/ artifact but intentionally deferred local browser asset generation.
# Prepare-merge also sets VERIFY_BROWSER_PRODUCTION_BUILD=1 to compile the
# ordinary Pages-shaped product before closed test transport is exposed.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

host_target() {
    rustc -vV | awk '/^host/ {print $2}'
}

# Prepared CI workspaces transport fetched programs as relative links into a
# repo-local copy of the exact content-addressed cache generations. Activate
# their shared cache/checker identity before any suite can read `binaries/`.
# Direct post-suite consumers use the same helper so the binding cannot be
# lost merely because GitHub starts a new workflow step.
source "$REPO_ROOT/scripts/activate-ci-test-workspace.sh"
activate_ci_test_workspace

suite="${1:-}"
if [ -z "$suite" ]; then
    echo "usage: $0 <cargo-kernel|fork-instrument|vitest|browser|libc|posix|sortix> [group]" >&2
    exit 2
fi
group="${2:-${TEST_GROUP:-all}}"

invalid_group() {
    echo "unknown $suite test group: $group" >&2
    exit 2
}

install_node_deps() {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
    (
        cd host
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
    )
}

run_timed() {
    local limit="$1"
    local label="$2"
    shift 2

    echo "::group::$label"
    set +e
    if command -v timeout >/dev/null 2>&1; then
        timeout --kill-after=30s "$limit" "$@"
    else
        "$@"
    fi
    local status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        echo "::error::$label failed with status $status"
    fi
    echo "::endgroup::"
    return "$status"
}

CI_HOMEBREW_BROWSER_MIRROR=""
CI_HOMEBREW_BROWSER_REPORT_ROOT=""
CI_HOMEBREW_BROWSER_IMAGE=""
CI_HOMEBREW_BROWSER_MIRROR_REQUIRED=""
CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY=""
CI_HOMEBREW_BROWSER_STATE_MODE=""
CI_HOMEBREW_BROWSER_TRANSPORT=""
CI_HOMEBREW_BROWSER_STATE_VALIDATED=0

cleanup_ci_homebrew_browser_mirror() {
    local status="$?"
    trap - EXIT
    if [ -n "$CI_HOMEBREW_BROWSER_MIRROR" ]; then
        rm -rf -- "$CI_HOMEBREW_BROWSER_MIRROR"
    fi
    if [ -n "$CI_HOMEBREW_BROWSER_REPORT_ROOT" ]; then
        rm -rf -- "$CI_HOMEBREW_BROWSER_REPORT_ROOT"
    fi
    exit "$status"
}

validate_ci_homebrew_browser_state() {
    local state="$REPO_ROOT/.ci-homebrew-browser-mirror-state.json"
    local authority
    local mirror_required
    local image
    local publication_blockers="$REPO_ROOT/.ci-test-publication-blockers.json"
    local receipt="$REPO_ROOT/.ci-staging-shell-receipt.json"
    local state_mode
    local transport

    CI_HOMEBREW_BROWSER_IMAGE=""
    CI_HOMEBREW_BROWSER_MIRROR_REQUIRED=""
    CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY=""
    CI_HOMEBREW_BROWSER_STATE_MODE=""
    CI_HOMEBREW_BROWSER_TRANSPORT=""
    CI_HOMEBREW_BROWSER_STATE_VALIDATED=0

    # WHY: closed-acceptance variables authorize private test transport.
    # Reject inherited values before validating the exact state contract;
    # otherwise a source shell or a different bottle mirror could look like
    # the reviewed candidate.
    for authority in \
        VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT \
        KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT \
        KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL \
        KANDELO_PLAYWRIGHT_VITE_MODE \
        WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY
    do
        if [ "${!authority+x}" = x ]; then
            echo "ci-run-test-suite: ambient closed Homebrew browser authority is forbidden: $authority" >&2
            return 1
        fi
    done

    if [ ! -f "$state" ]; then
        echo "ci-run-test-suite: prepared browser workspace lacks Homebrew mirror state: $state" >&2
        return 1
    fi
    if [ ! -f "$publication_blockers" ]; then
        echo "ci-run-test-suite: prepared browser workspace lacks its publication blocker report: $publication_blockers" >&2
        return 1
    fi
    image="$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)"
    state_mode="$(jq -er '.mode' "$state")" || {
        echo "ci-homebrew-browser-mirror-state: invalid state: $state" >&2
        return 1
    }
    state_args=(validate consumer "$state" "$publication_blockers" "$image")
    if [ "$state_mode" = publication-blocked-candidate ]; then
        state_args+=("$receipt")
    fi
    bash scripts/ci-homebrew-browser-mirror-state.sh "${state_args[@]}"
    mirror_required="$(jq -r '.mirror_required' "$state")"
    transport="$(jq -r '.transport // ""' "$state")"

    CI_HOMEBREW_BROWSER_IMAGE="$image"
    CI_HOMEBREW_BROWSER_MIRROR_REQUIRED="$mirror_required"
    CI_HOMEBREW_BROWSER_STATE_MODE="$state_mode"
    CI_HOMEBREW_BROWSER_TRANSPORT="$transport"

    # WHY: the authenticated source bridge deliberately has no Homebrew
    # selection and no bootstrap bottle. Grant only the following run.sh call
    # permission to skip that product asset; sealed and bottle-backed states
    # continue through the normal bootstrap preparer.
    if [ "$state_mode" = publication-blocked ]; then
        CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY=source-rootfs-mirror-state-v1
        CI_HOMEBREW_BROWSER_STATE_VALIDATED=1
        return 0
    fi
    if [ "$state_mode" = resolved ]; then
        [ "$transport" = flat-self-contained ] &&
            [ "$mirror_required" = false ] || {
            echo "ci-run-test-suite: resolved shell lacks self-contained flat transport" >&2
            return 1
        }
        CI_HOMEBREW_BROWSER_STATE_VALIDATED=1
        return 0
    fi
    [ "$mirror_required" = "true" ] || {
        echo "ci-run-test-suite: bottle-backed shell omitted its closed mirror" >&2
        return 1
    }
    CI_HOMEBREW_BROWSER_STATE_VALIDATED=1
}

prepare_ci_homebrew_browser_mirror() {
    local mirror="$REPO_ROOT/apps/browser-demos/public/homebrew-main-shell-bottles"
    local report

    [ "$CI_HOMEBREW_BROWSER_STATE_VALIDATED" -eq 1 ] || {
        echo "ci-run-test-suite: Homebrew browser state was not validated" >&2
        return 1
    }
    # WHY: the first validation grants only the immediately following run.sh
    # call. Revalidate after browser preparation before granting Playwright
    # authority or reading a mirror, so changed image/state bytes cannot cross
    # the gap between those two operations.
    validate_ci_homebrew_browser_state
    if [ -e "$mirror" ] || [ -L "$mirror" ]; then
        echo "ci-run-test-suite: closed Homebrew browser mirror already exists: $mirror" >&2
        return 1
    fi
    if [ "$CI_HOMEBREW_BROWSER_STATE_MODE" = publication-blocked ]; then
        export KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL=1
        return 0
    fi
    if [ "$CI_HOMEBREW_BROWSER_TRANSPORT" = flat-self-contained ]; then
        [ "$CI_HOMEBREW_BROWSER_MIRROR_REQUIRED" = false ] || {
            echo "ci-run-test-suite: flat shell unexpectedly requires a closed mirror" >&2
            return 1
        }
        return 0
    fi
    [ "$CI_HOMEBREW_BROWSER_MIRROR_REQUIRED" = "true" ] || {
        echo "ci-run-test-suite: bottle-backed shell omitted its closed mirror" >&2
        return 1
    }

    CI_HOMEBREW_BROWSER_REPORT_ROOT="$(
        mktemp -d "${RUNNER_TEMP:-/tmp}/kandelo-ci-homebrew-browser.XXXXXX"
    )"
    report="$CI_HOMEBREW_BROWSER_REPORT_ROOT/recovery.json"
    CI_HOMEBREW_BROWSER_MIRROR="$mirror"
    trap cleanup_ci_homebrew_browser_mirror EXIT

    # WHY: an expected-ledger identity absent from the immutable canonical
    # package index names final bottle URLs that cannot exist until this exact
    # Kandelo commit reaches main. Recover the same digest-bound layers
    # anonymously from their public source packages for pre-merge browser
    # validation instead of publishing early or weakening the candidate
    # image's production transport identity.
    npx tsx scripts/recover-homebrew-bottle-mirror.ts \
        --image "$CI_HOMEBREW_BROWSER_IMAGE" \
        --out "$mirror" \
        --report "$report"
    [ -f "$mirror/kandelo-homebrew-bottle-mirror-plan.json" ] &&
        [ -f "$report" ] || {
        echo "ci-run-test-suite: closed Homebrew browser mirror is incomplete" >&2
        return 1
    }
    export KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT=/homebrew-main-shell-bottles
    export KANDELO_PLAYWRIGHT_VITE_MODE=homebrew-closed-acceptance
}

run_pages_shaped_browser_build() {
    local app="$REPO_ROOT/apps/browser-demos"
    local dist="$app/dist"
    local mirror="$app/public/homebrew-main-shell-bottles"
    local output

    if [ -e "$mirror" ] || [ -L "$mirror" ]; then
        echo "ci-run-test-suite: ordinary browser build found a closed test mirror: $mirror" >&2
        return 1
    fi
    if [ -e "$dist" ] || [ -L "$dist" ]; then
        echo "ci-run-test-suite: ordinary browser build found stale output: $dist" >&2
        return 1
    fi
    # WHY: the narrow shell proof selects two Vite entries and later exposes
    # private mirror bytes. Prepare-merge must first compile the ordinary
    # Pages-shaped product so neither test-only setting can hide a broken
    # gallery entry, production base path, or service-worker build.
    (
        cd "$app"
        env \
            -u KANDELO_BROWSER_DEMO_INPUTS \
            -u VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT \
            -u KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT \
            -u KANDELO_PLAYWRIGHT_EXPECT_SOURCE_ROOTFS_SHELL \
            -u KANDELO_PLAYWRIGHT_VITE_MODE \
            -u KANDELO_PLAYWRIGHT_SERVE_DIST \
            VITE_BASE=/kandelo/ \
            VITE_CORS_PROXY_URL='https://wordpress-playground-cors-proxy.net/?' \
            npm run build
        for output in \
            index.html \
            pages/kandelo/index.html \
            pages/network/index.html \
            service-worker.js
        do
            [ -f "$dist/$output" ] || {
                echo "ci-run-test-suite: ordinary browser build omitted $output" >&2
                return 1
            }
        done
        # WHY: homebrew-vfs-test is a private closed-mirror acceptance page,
        # not a Pages product entry. Requiring it here contradicts Vite's
        # production input set; emitting it would expose test-only UI instead.
        if [ -e "$dist/pages/homebrew-vfs-test/index.html" ] ||
           [ -L "$dist/pages/homebrew-vfs-test/index.html" ]; then
            echo "ci-run-test-suite: ordinary browser build exposed the private Homebrew acceptance page" >&2
            return 1
        fi
    )
    rm -rf -- "$dist"
}

case "$suite" in
    cargo-kernel)
        HOST_TARGET="$(host_target)"
        cargo test -p kandelo --target "$HOST_TARGET" --lib
        ;;
    fork-instrument)
        HOST_TARGET="$(host_target)"
        cargo test -p fork-instrument --target "$HOST_TARGET"
        ;;
    vitest)
        resource_cases="$REPO_ROOT/scripts/ci-vitest-resource-isolated-cases.tsv"
        resource_files=()
        resource_markers=()
        resource_excludes=()
        seen_resource_files="|"
        line_number=0
        while IFS= read -r resource_line || [ -n "${resource_line:-}" ]; do
            line_number=$((line_number + 1))
            case "${resource_line:-}" in
                ""|\#*) continue ;;
            esac
            case "$resource_line" in
                *$'\t'*) ;;
                *)
                    echo "ci-run-test-suite: invalid resource-isolated case at $resource_cases:$line_number" >&2
                    exit 2
                    ;;
            esac
            test_file="${resource_line%%$'\t'*}"
            test_marker="${resource_line#*$'\t'}"
            if [ -z "$test_file" ] || [ -z "$test_marker" ] || \
                [[ "$test_marker" == *$'\t'* ]] || \
                [ ! -f "$REPO_ROOT/$test_file" ]; then
                echo "ci-run-test-suite: invalid resource-isolated case at $resource_cases:$line_number" >&2
                exit 2
            fi
            case "$test_marker" in
                [A-Z]*) ;;
                *)
                    echo "ci-run-test-suite: invalid resource-isolated marker at $resource_cases:$line_number" >&2
                    exit 2
                    ;;
            esac
            case "$test_marker" in
                *[!A-Z0-9_]*)
                    echo "ci-run-test-suite: invalid resource-isolated marker at $resource_cases:$line_number" >&2
                    exit 2
                    ;;
            esac
            for index in "${!resource_files[@]}"; do
                if [ "${resource_files[$index]}" = "$test_file" ] && \
                    [ "${resource_markers[$index]}" = "$test_marker" ]; then
                    echo "ci-run-test-suite: duplicate resource-isolated case at $resource_cases:$line_number" >&2
                    exit 2
                fi
            done
            resource_files+=("$test_file")
            resource_markers+=("$test_marker")
            case "$seen_resource_files" in
                *"|$test_file|"*) ;;
                *)
                    resource_excludes+=("--exclude=../$test_file")
                    seen_resource_files="${seen_resource_files}${test_file}|"
                    ;;
            esac
        done < "$resource_cases"
        if [ "${#resource_files[@]}" -eq 0 ]; then
            echo "ci-run-test-suite: resource-isolated case manifest is empty" >&2
            exit 2
        fi

        case "$group" in
            all) vitest_args=() ;;
            1/2|2/2) vitest_args=("--shard=$group") ;;
            resource-isolated) vitest_args=() ;;
            *) invalid_group ;;
        esac
        install_node_deps
        (
            cd web-libs/kandelo-web
            npm ci --no-audit --no-fund
        )

        # The ordinary shards exclude each whole declared file. Prove that the
        # manifest is a bijection with the file's live Vitest inventory before
        # doing so: a new, removed, misspelled, or duplicate case must fail
        # loudly rather than silently losing or multiplying coverage.
        vitest_resource_inventory_dir="$(
            mktemp -d \
                "${RUNNER_TEMP:-/tmp}/kandelo-vitest-resource.XXXXXX"
        )"
        cleanup_vitest_resource_inventory() {
            rm -rf -- "$vitest_resource_inventory_dir"
        }
        trap cleanup_vitest_resource_inventory EXIT
        resource_file_number=0
        for excluded_arg in "${resource_excludes[@]}"; do
            resource_file_number=$((resource_file_number + 1))
            test_file="${excluded_arg#--exclude=../}"
            inventory_json="$vitest_resource_inventory_dir/inventory-$resource_file_number.json"
            mapped_names="$vitest_resource_inventory_dir/mapped-$resource_file_number"
            listed_names="$vitest_resource_inventory_dir/listed-$resource_file_number"
            if ! (
                cd host
                npx vitest list \
                    "../$test_file" \
                    --json="$inventory_json"
            ); then
                echo "ci-run-test-suite: could not enumerate resource-isolated file: $test_file" >&2
                exit 2
            fi
            if ! jq -e \
                --arg expected_file "$REPO_ROOT/$test_file" '
                  type == "array" and
                  length > 0 and
                  all(.[];
                    type == "object" and
                    .file == $expected_file and
                    (.name | type) == "string" and
                    (.name | length) > 0
                  )
                ' "$inventory_json" >/dev/null; then
                echo "ci-run-test-suite: invalid resource-isolated inventory for $test_file" >&2
                exit 2
            fi
            : > "$mapped_names"
            for index in "${!resource_files[@]}"; do
                [ "${resource_files[$index]}" = "$test_file" ] || continue
                test_marker="${resource_markers[$index]}"
                test_pattern="(^|[^A-Z0-9_])${test_marker}([^A-Z0-9_]|$)"
                matches="$(jq \
                    --arg pattern "$test_pattern" \
                    '[.[] | select(.name | test($pattern))] | length' \
                    "$inventory_json")"
                if [ "$matches" -ne 1 ]; then
                    echo "ci-run-test-suite: resource-isolated marker must select exactly one test in $test_file: $test_marker" >&2
                    exit 2
                fi
                jq -r \
                    --arg pattern "$test_pattern" \
                    '.[] | select(.name | test($pattern)) | .name' \
                    "$inventory_json" >> "$mapped_names"
            done
            jq -r '.[].name' "$inventory_json" | LC_ALL=C sort \
                > "$listed_names"
            LC_ALL=C sort -o "$mapped_names" "$mapped_names"
            if [ "$(LC_ALL=C uniq -d "$mapped_names" | wc -l | tr -d '[:space:]')" -ne 0 ] || \
                ! cmp -s "$listed_names" "$mapped_names"; then
                echo "ci-run-test-suite: resource-isolated manifest does not exactly cover $test_file" >&2
                exit 2
            fi
        done

        npx --prefix host playwright install chromium
        if [ "$group" != "resource-isolated" ]; then
            # WHY: Vitest owns the hash-based ordinary-file partition. The
            # declarative heavyweight files are excluded from both shards and
            # restored below, one case per fresh process, so the combined jobs
            # retain exact coverage without carrying their observed resident
            # memory from one case into the next.
            (
                cd host
                npx vitest run \
                    "${vitest_args[@]}" \
                    "${resource_excludes[@]}"
            )
        fi
        if [ "$group" = "all" ] || [ "$group" = "resource-isolated" ]; then
            for index in "${!resource_files[@]}"; do
                # WHY: host/options/program-byte WeakRefs cleared after each
                # measured case, but RSS stayed elevated in a long-lived
                # Vitest process. Fresh OS-process exit is the deterministic
                # reclamation boundary.
                test_marker="${resource_markers[$index]}"
                test_pattern="(^|[^A-Z0-9_])${test_marker}([^A-Z0-9_]|$)"
                (
                    cd host
                    npx vitest run \
                        "../${resource_files[$index]}" \
                        --testNamePattern="$test_pattern"
                )
            done
        fi
        # [JSC-TERMINATE-ATOMICS-WAIT-LEAK] Re-run the teardown-reclamation tests
        # on JSC (Bun) as well as V8, since the workaround exists for JSC (Safari
        # and Bun) and is a no-op on V8. `bun` comes from the flake dev shell.
        # See docs/jsc-terminate-atomics-wait-workaround.md.
        # WHY: this is a separate cross-runtime check, not part of Vitest's V8
        # partition. Run it on one shard so CI retains the check exactly once.
        if [ "$group" = "all" ] || [ "$group" = "1/2" ]; then
            (
                cd host
                bun x vitest run \
                    test/teardown-reclaim.test.ts \
                    test/pthread.test.ts
            )
        fi
        ;;
    browser)
        install_node_deps
        (
            cd apps/browser-demos
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
        )
        if [ "${PREPARE_BROWSER_ASSETS:-false}" = "true" ] || \
            [ "${PREPARE_BROWSER_ASSETS:-0}" = "1" ]; then
            # Publication-pending packages are deliberately absent from the
            # prepared release ledger. Materialize their exact PR recipes as
            # local test generations before the ordinary fetch-only browser
            # pass proves that every browser dependency is now resolvable.
            bash scripts/materialize-ci-publication-blockers.sh
            validate_ci_homebrew_browser_state
            if [ -n "$CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY" ]; then
                env \
                    WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY="$CI_HOMEBREW_BROWSER_SOURCE_AUTHORITY" \
                    ./run.sh --already-materialized --fetch-only prepare-browser
            else
                ./run.sh --already-materialized --fetch-only prepare-browser
            fi
            if [ "${VERIFY_BROWSER_PRODUCTION_BUILD:-false}" = "true" ] || \
                [ "${VERIFY_BROWSER_PRODUCTION_BUILD:-0}" = "1" ]; then
                run_pages_shaped_browser_build
            fi
            prepare_ci_homebrew_browser_mirror
        fi
        bash scripts/ci-check-browser-assets.sh
        (
            cd apps/browser-demos
            if [ "$(uname -s)" = "Linux" ]; then
                run_timed 30m "Install Playwright browsers" \
                    env PATH="/usr/bin:/bin:$PATH" \
                    npx playwright install --with-deps chromium firefox webkit
            else
                run_timed 30m "Install Playwright browsers" \
                    npx playwright install chromium firefox webkit
            fi
            run_timed 20m "Run Chromium browser demo smoke suite" \
                npx playwright test --grep-invert "@slow|@trap-signal" \
                    --project=chromium
            run_timed 10m "Run cross-browser contract smoke suite" \
                npx playwright test \
                    test/boot-current-boundary.spec.ts \
                    test/coi.spec.ts \
                    test/package-deferred-tree-browser.spec.ts \
                    test/vfs-import-seal-boundary.spec.ts \
                    test/wasm-trap-signal.spec.ts \
                    --project=chromium --project=firefox --project=webkit
        )
        ;;
    libc)
        install_node_deps
        case "$group" in
            all)                   bash scripts/run-libc-tests.sh ;;
            functional-regression) bash scripts/run-libc-tests.sh functional regression ;;
            math)                  bash scripts/run-libc-tests.sh math ;;
            *)                     invalid_group ;;
        esac
        ;;
    posix)
        install_node_deps
        bash scripts/run-posix-tests.sh
        ;;
    sortix)
        install_node_deps
        case "$group" in
            all)     bash scripts/run-sortix-tests.sh --all ;;
            include) bash scripts/run-sortix-tests.sh include ;;
            basic)   bash scripts/run-sortix-tests.sh basic ;;
            runtime) bash scripts/run-sortix-tests.sh limits malloc stdio io signal process paths udp ;;
            *)       invalid_group ;;
        esac
        ;;
    *)
        echo "unknown CI test suite: $suite" >&2
        exit 2
        ;;
esac
