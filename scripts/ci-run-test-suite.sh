#!/usr/bin/env bash
set -euo pipefail

# CI-shaped suite runner. The optional group selects deterministic shards:
#   vitest: 1/2 | 2/2 | resource-isolated | exact-abi-source
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
    echo "usage: $0 <cargo-workspace|cargo-xtask|vitest|browser|libc|posix|sortix> [group]" >&2
    exit 2
fi
group="${2:-${TEST_GROUP:-all}}"
disabled_software_vitest_excludes=(
    # Vitest is invoked from host/. Its ordinary file list includes both
    # host-local paths (test/**) and repository siblings (../tests/**), so
    # every disabled-software marker needs both spellings.
    "--exclude=**/*brew*"
    "--exclude=../**/*brew*"
    "--exclude=**/*bottle*"
    "--exclude=../**/*bottle*"
    "--exclude=**/*formula*"
    "--exclude=../**/*formula*"
    "--exclude=**/*tap*"
    "--exclude=../**/*tap*"
    "--exclude=test/abi-staging-mini-vfs.test.ts"
    "--exclude=test/abi-staging-product-builders.test.ts"
    "--exclude=test/privileged-projection.test.ts"
    "--exclude=test/shell-vfs-build.test.ts"
    "--exclude=test/vfs-product-builder-contract.test.ts"
)
disabled_software_cargo_test_args=(
    "--skip" "formula"
    "--skip" "bottle"
    "--skip" "tap"
)

# WHY: every conformance case starts a fresh Node resolver under a short
# timeout. Prepare one exact worktree-local checker before parallel cases
# begin; each process still executes the source-freshness check, but none
# starts a competing Cargo build or waits on Cargo's target-directory lock.
case "$suite" in
    vitest|browser|libc|posix|sortix)
        prepared_xtask="$REPO_ROOT/target/$(host_target)/release/xtask"
        if [ ! -d "$REPO_ROOT/.ci-test-binary-cache/programs" ]; then
            cargo build --release -p xtask --target "$(host_target)" --quiet
        fi
        if [ ! -f "$prepared_xtask" ] || [ ! -x "$prepared_xtask" ]; then
            echo "ci-run-test-suite: missing executable prepared package checker: $prepared_xtask" >&2
            exit 1
        fi
        export WASM_POSIX_XTASK_BIN="$prepared_xtask"
        ;;
esac

invalid_group() {
    echo "unknown $suite test group: $group" >&2
    exit 2
}

run_exact_abi_source_vitest() {
    local classes="$REPO_ROOT/scripts/ci-vitest-evidence-classes.tsv"
    local inventory_root
    local declared="$REPO_ROOT/.ci-exact-abi-vitest-declared"
    local live="$REPO_ROOT/.ci-exact-abi-vitest-live"
    local live_raw="$REPO_ROOT/.ci-exact-abi-vitest-live-raw"
    local source_declared
    local source_shared_declared
    local selected
    local selected_raw
    local resource_cases
    local resource_line
    local resource_file_number
    local test_file
    local test_marker
    local test_pattern
    local inventory_json
    local mapped_names
    local listed_names
    local matches
    local excluded_arg
    local index
    local path
    local class
    local extra
    local previous=""
    local line_number=0
    local source_count=0
    local prepared_count=0
    local selected_path
    local -a prepared_excludes=()
    local -a source_resource_files=()
    local -a source_resource_markers=()
    local -a source_resource_excludes=()
    local seen_source_resource_files="|"

    if [ ! -f "$classes" ] || [ -L "$classes" ] ||
       [ "$(wc -c < "$classes" | tr -d '[:space:]')" -gt 1048576 ]; then
        echo "ci-run-test-suite: Vitest evidence classes must be one bounded regular file" >&2
        exit 2
    fi
    inventory_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/kandelo-exact-abi-vitest.XXXXXX")"
    EXACT_ABI_VITEST_INVENTORY_ROOT="$inventory_root"
    cleanup_exact_abi_vitest_inventory() {
        if [ -n "${EXACT_ABI_VITEST_INVENTORY_ROOT:-}" ]; then
            rm -rf -- "$EXACT_ABI_VITEST_INVENTORY_ROOT"
            EXACT_ABI_VITEST_INVENTORY_ROOT=""
        fi
    }
    trap cleanup_exact_abi_vitest_inventory EXIT
    declared="$inventory_root/declared"
    live="$inventory_root/live"
    live_raw="$inventory_root/live-raw"
    source_declared="$inventory_root/source-declared"
    source_shared_declared="$inventory_root/source-shared-declared"
    selected="$inventory_root/selected"
    selected_raw="$inventory_root/selected-raw"
    : > "$declared"
    : > "$source_declared"
    while IFS=$'\t' read -r path class extra ||
          [ -n "${path:-}${class:-}${extra:-}" ]; do
        line_number=$((line_number + 1))
        case "${path:-}" in
            ""|\#*) continue ;;
        esac
        if [ -z "${class:-}" ] || [ -n "${extra:-}" ]; then
            echo "ci-run-test-suite: invalid Vitest evidence class at $classes:$line_number" >&2
            exit 2
        fi
        case "$path" in
            /*|*//*|../*|*/../*|*/..|./*|*/./*|*/.)
                echo "ci-run-test-suite: invalid Vitest evidence path at $classes:$line_number" >&2
                exit 2
                ;;
        esac
        case "$path" in
            host/test/*.test.ts|host/test/*/*.test.ts|\
            web-libs/*/test/*.test.ts|packages/registry/*/test/*.test.ts|\
            tests/package-system/*.test.ts|examples/dlopen/*.test.ts)
                ;;
            *)
                echo "ci-run-test-suite: unsupported Vitest evidence path at $classes:$line_number" >&2
                exit 2
                ;;
        esac
        if [ -n "$previous" ] && [[ "$previous" > "$path" || "$previous" = "$path" ]]; then
            echo "ci-run-test-suite: Vitest evidence classes must be sorted and duplicate-free" >&2
            exit 2
        fi
        previous="$path"
        if [ ! -f "$REPO_ROOT/$path" ] || [ -L "$REPO_ROOT/$path" ]; then
            echo "ci-run-test-suite: classified Vitest evidence is not a regular file: $path" >&2
            exit 2
        fi
        case "$class" in
            source-only)
                source_count=$((source_count + 1))
                printf '%s\n' "$path" >> "$source_declared"
                ;;
            prepared-product)
                prepared_count=$((prepared_count + 1))
                case "$path" in
                    host/*) selected_path="${path#host/}" ;;
                    *) selected_path="../$path" ;;
                esac
                prepared_excludes+=("--exclude=$selected_path")
                ;;
            *)
                echo "ci-run-test-suite: unknown Vitest evidence class at $classes:$line_number" >&2
                exit 2
                ;;
        esac
        printf '%s\n' "$path" >> "$declared"
    done < "$classes"
    if [ "$source_count" -eq 0 ] || [ "$prepared_count" -eq 0 ] ||
       [ "$((source_count + prepared_count))" -gt 1024 ]; then
        echo "ci-run-test-suite: Vitest evidence classes must contain a bounded two-class inventory" >&2
        exit 2
    fi
    cp "$source_declared" "$source_shared_declared"

    # Resource-isolated tests retain their fresh-process boundary even when
    # they are source-only. Exclude each such file from the shared exact run,
    # prove that its marker inventory is exhaustive, and restore every case in
    # a separate Vitest process below.
    resource_cases="$REPO_ROOT/scripts/ci-vitest-resource-isolated-cases.tsv"
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
        grep -Fxq "$test_file" "$source_declared" || continue
        for index in "${!source_resource_files[@]}"; do
            if [ "${source_resource_files[$index]}" = "$test_file" ] && \
               [ "${source_resource_markers[$index]}" = "$test_marker" ]; then
                echo "ci-run-test-suite: duplicate resource-isolated case at $resource_cases:$line_number" >&2
                exit 2
            fi
        done
        source_resource_files+=("$test_file")
        source_resource_markers+=("$test_marker")
        case "$seen_source_resource_files" in
            *"|$test_file|"*) ;;
            *)
                case "$test_file" in
                    host/*) selected_path="${test_file#host/}" ;;
                    *) selected_path="../$test_file" ;;
                esac
                source_resource_excludes+=("--exclude=$selected_path")
                prepared_excludes+=("--exclude=$selected_path")
                awk -v omitted="$test_file" '$0 != omitted' \
                    "$source_shared_declared" \
                    > "$source_shared_declared.next"
                mv "$source_shared_declared.next" "$source_shared_declared"
                seen_source_resource_files="${seen_source_resource_files}${test_file}|"
                ;;
        esac
    done < "$resource_cases"

    resource_file_number=0
    for excluded_arg in "${source_resource_excludes[@]}"; do
        resource_file_number=$((resource_file_number + 1))
        selected_path="${excluded_arg#--exclude=}"
        case "$selected_path" in
            test/*) test_file="host/$selected_path" ;;
            ../*) test_file="${selected_path#../}" ;;
            *)
                echo "ci-run-test-suite: invalid source-only resource path: $selected_path" >&2
                exit 2
                ;;
        esac
        inventory_json="$inventory_root/resource-$resource_file_number.json"
        mapped_names="$inventory_root/resource-$resource_file_number-mapped"
        listed_names="$inventory_root/resource-$resource_file_number-listed"
        if ! (
            cd host
            npx vitest list "$selected_path" --json="$inventory_json"
        ); then
            echo "ci-run-test-suite: could not enumerate source-only resource-isolated file: $test_file" >&2
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
            echo "ci-run-test-suite: invalid source-only resource-isolated inventory for $test_file" >&2
            exit 2
        fi
        : > "$mapped_names"
        for index in "${!source_resource_files[@]}"; do
            [ "${source_resource_files[$index]}" = "$test_file" ] || continue
            test_marker="${source_resource_markers[$index]}"
            test_pattern="(^|[^A-Z0-9_])${test_marker}([^A-Z0-9_]|$)"
            matches="$(jq \
                --arg pattern "$test_pattern" \
                '[.[] | select(.name | test($pattern))] | length' \
                "$inventory_json")"
            if [ "$matches" -ne 1 ]; then
                echo "ci-run-test-suite: source-only resource-isolated marker must select exactly one test in $test_file: $test_marker" >&2
                exit 2
            fi
            jq -r \
                --arg pattern "$test_pattern" \
                '.[] | select(.name | test($pattern)) | .name' \
                "$inventory_json" >> "$mapped_names"
        done
        jq -r '.[].name' "$inventory_json" | LC_ALL=C sort > "$listed_names"
        LC_ALL=C sort -o "$mapped_names" "$mapped_names"
        if [ "$(LC_ALL=C uniq -d "$mapped_names" | wc -l | tr -d '[:space:]')" -ne 0 ] || \
           ! cmp -s "$listed_names" "$mapped_names"; then
            echo "ci-run-test-suite: source-only resource-isolated manifest does not exactly cover $test_file" >&2
            exit 2
        fi
    done

    (
        cd host
        npx vitest list --filesOnly "${disabled_software_vitest_excludes[@]}"
    ) > "$live_raw"
    : > "$live"
    while IFS= read -r path || [ -n "${path:-}" ]; do
        case "$path" in
            test/*) printf 'host/%s\n' "$path" >> "$live" ;;
            ../*) printf '%s\n' "${path#../}" >> "$live" ;;
            "$REPO_ROOT"/*) printf '%s\n' "${path#"$REPO_ROOT"/}" >> "$live" ;;
            *)
                echo "ci-run-test-suite: Vitest returned an invalid evidence path: $path" >&2
                exit 2
                ;;
        esac
    done < "$live_raw"
    LC_ALL=C sort -o "$live" "$live"
    if [ ! -s "$live" ] || [ -n "$(LC_ALL=C uniq -d "$live")" ] ||
       ! cmp -s "$declared" "$live"; then
        echo "ci-run-test-suite: Vitest evidence classes do not exactly cover the live file inventory" >&2
        diff -u "$declared" "$live" >&2 || true
        exit 2
    fi

    node --input-type=module - "$REPO_ROOT" "$classes" <<'NODE'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

const [rootInput, classesPath] = process.argv.slice(2);
const root = realpathSync(rootInput);
const rows = readFileSync(classesPath, "utf8")
  .split("\n")
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => line.split("\t"));
const prepared = new Set(
  rows
    .filter(([, evidenceClass]) => evidenceClass === "prepared-product")
    .map(([path]) => resolve(root, path)),
);
const sources = rows
  .filter(([, evidenceClass]) => evidenceClass === "source-only")
  .map(([path]) => resolve(root, path));
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

function withoutComments(source) {
  let output = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (current === "\n") {
        state = "code";
        output += current;
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      output += current;
      if (current === "\\") {
        output += next ?? "";
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block";
    } else {
      output += current;
      if (current === "'") state = "single";
      else if (current === '"') state = "double";
      else if (current === "`") state = "template";
    }
  }
  return output;
}

function importSpecifiers(source) {
  const clean = withoutComments(source);
  const result = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;]{0,1000}?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) result.add(match[1]);
  }
  return result;
}

function candidates(base) {
  const values = [base];
  const extension = extname(base);
  for (const candidateExtension of extensions) values.push(base + candidateExtension);
  if (extension) {
    const stem = base.slice(0, -extension.length);
    for (const candidateExtension of extensions) values.push(stem + candidateExtension);
  } else {
    for (const candidateExtension of extensions) values.push(base + candidateExtension);
    for (const candidateExtension of extensions) {
      values.push(join(base, "index" + candidateExtension));
    }
  }
  return [...new Set(values)];
}

function localImport(from, specifier) {
  const clean = specifier.replace(/[?#].*$/, "");
  let base = null;
  if (clean.startsWith(".")) base = resolve(dirname(from), clean);
  else if (clean === "@host") base = resolve(root, "host/src/index");
  else if (clean.startsWith("@host/")) {
    base = resolve(root, "host/src", clean.slice("@host/".length));
  } else {
    return null;
  }
  for (const candidate of candidates(base)) {
    if (!existsSync(candidate)) continue;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    const exact = normalize(candidate);
    const rel = relative(root, exact);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`source-only import escapes the repository: ${specifier}`);
    }
    return exact;
  }
  throw new Error(
    `source-only local import cannot be resolved: ${relative(root, from)} -> ${specifier}`,
  );
}

for (const source of sources) {
  const pending = [source];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const rel = relative(root, current);
    if (rel === "host/src/binary-resolver.ts") {
      throw new Error(`source-only import closure reaches binary-resolver: ${relative(root, source)}`);
    }
    if (current !== source && prepared.has(current)) {
      throw new Error(`source-only import closure reaches prepared-product test: ${relative(root, source)} -> ${rel}`);
    }
    for (const specifier of importSpecifiers(readFileSync(current, "utf8"))) {
      const imported = localImport(current, specifier);
      if (imported !== null) pending.push(imported);
    }
  }
}
NODE

    if [ -s "$source_shared_declared" ]; then
        (
            cd host
            npx vitest list --filesOnly \
                "${prepared_excludes[@]}" \
                "${disabled_software_vitest_excludes[@]}"
        ) > "$selected_raw"
    else
        : > "$selected_raw"
    fi
    : > "$selected"
    while IFS= read -r path || [ -n "${path:-}" ]; do
        case "$path" in
            test/*) printf 'host/%s\n' "$path" >> "$selected" ;;
            ../*) printf '%s\n' "${path#../}" >> "$selected" ;;
            "$REPO_ROOT"/*) printf '%s\n' "${path#"$REPO_ROOT"/}" >> "$selected" ;;
            *)
                echo "ci-run-test-suite: Vitest returned an invalid source-only path: $path" >&2
                exit 2
                ;;
        esac
    done < "$selected_raw"
    LC_ALL=C sort -o "$selected" "$selected"
    if [ -n "$(LC_ALL=C uniq -d "$selected")" ] ||
       ! cmp -s "$source_shared_declared" "$selected"; then
        echo "ci-run-test-suite: Vitest source-only selection differs from the protected evidence classes" >&2
        diff -u "$source_shared_declared" "$selected" >&2 || true
        exit 2
    fi

    npx --prefix host playwright install chromium
    if [ -s "$source_shared_declared" ]; then
        (
            cd host
            npx vitest run \
                "${prepared_excludes[@]}" \
                "${disabled_software_vitest_excludes[@]}"
        )
    fi
    for index in "${!source_resource_files[@]}"; do
        test_file="${source_resource_files[$index]}"
        case "$test_file" in
            host/*) selected_path="${test_file#host/}" ;;
            *) selected_path="../$test_file" ;;
        esac
        test_marker="${source_resource_markers[$index]}"
        test_pattern="(^|[^A-Z0-9_])${test_marker}([^A-Z0-9_]|$)"
        (
            cd host
            npx vitest run "$selected_path" \
                --testNamePattern="$test_pattern"
        )
    done
    cleanup_exact_abi_vitest_inventory
    trap - EXIT
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

run_pages_shaped_browser_build() {
    local app="$REPO_ROOT/apps/browser-demos"
    local dist="$app/dist"
    local output

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
    )
    rm -rf -- "$dist"
}

case "$suite" in
    cargo-workspace)
        # Host-run unit + integration tests for every workspace crate EXCEPT
        # xtask: kandelo (kernel), fork-instrument, wasm-posix-shared,
        # wasm-local-root-spill. `--workspace` is
        # closed-by-default: a new crate under crates/ is gated with no
        # allow-list edit, and each crate's integration tests run too (no
        # `--lib`, which would silently run 0 tests for a bin-only crate such
        # as wasm-local-root-spill). xtask is excluded because it is gated
        # separately as the always-run `cargo-xtask` suite -- it lives under
        # tools/ (outside the kernel change-scope) and its regressions are
        # independent of kernel changes. `--target <host>` is REQUIRED: the
        # default wasm32-unknown-unknown target has no host test runner, and
        # host-only deps (getrandom; xtask's ring/zstd) do not cross-compile.
        HOST_TARGET="$(host_target)"
        cargo test --workspace --exclude xtask --target "$HOST_TARGET"
        ;;
    cargo-xtask)
        # Package-system automation unit tests (tools/xtask/**): package
        # resolver, binaries-dir placement, and archive staging/naming. Pure
        # host-target cargo tests; no wasm sysroots or prepared workspace needed.
        HOST_TARGET="$(host_target)"
        cargo test -p xtask --target "$HOST_TARGET" -- \
            "${disabled_software_cargo_test_args[@]}"
        ;;
    vitest)
        if [ "$group" = "exact-abi-source" ]; then
            install_node_deps
            run_exact_abi_source_vitest
            exit 0
        fi
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
                    "${resource_excludes[@]}" \
                    "${disabled_software_vitest_excludes[@]}"
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
            ./run.sh --already-materialized --fetch-only prepare-browser
            if [ "${VERIFY_BROWSER_PRODUCTION_BUILD:-false}" = "true" ] || \
                [ "${VERIFY_BROWSER_PRODUCTION_BUILD:-0}" = "1" ]; then
                run_pages_shaped_browser_build
            fi
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
                    test/wasm-gc-reference-transport.spec.ts \
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
