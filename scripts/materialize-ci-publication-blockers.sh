#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

report="${1:-$REPO_ROOT/.ci-test-publication-blockers.json}"
abi="$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')"
[ -n "$abi" ] || {
    echo "materialize-ci-publication-blockers: could not read the current ABI" >&2
    exit 1
}
bash scripts/validate-publication-blocker-report.sh "$report" "$abi"

mapfile -t blocked_packages < <(jq -r '.entries[].package' "$report")
if [ "${#blocked_packages[@]}" -eq 0 ]; then
    echo "materialize-ci-publication-blockers: no publication-blocked packages"
    exit 0
fi

host_target="$(rustc -vV | awk '/^host/ {print $2}')"
xtask="target/$host_target/release/xtask"
if [ ! -x "$xtask" ]; then
    echo "materialize-ci-publication-blockers: missing prepared resolver: $xtask" >&2
    exit 1
fi

mkdir -p local-binaries

if jq -e 'any(.entries[]; .package == "shell")' "$report" >/dev/null; then
    receipt="$REPO_ROOT/.ci-staging-shell-receipt.json"
    handoff_report="$REPO_ROOT/.ci-staging-shell-report.json"
    if [ ! -f "$receipt" ] || [ -L "$receipt" ] ||
       [ ! -f "$handoff_report" ] || [ -L "$handoff_report" ]; then
        echo "materialize-ci-publication-blockers: staging shell handoff is incomplete" >&2
        exit 1
    fi
    parents="$(git show --no-patch --format=%P HEAD)"
    expected_base="$(printf '%s\n' "$parents" | awk '{print $1}')"
    expected_head="$(printf '%s\n' "$parents" | awk '{print $2}')"
    expected_tree="$(git rev-parse 'HEAD^{tree}')"
    unexpected_parent="$(printf '%s\n' "$parents" | awk '{print $3}')"
    if ! [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] ||
       [ -n "$unexpected_parent" ]; then
        echo "materialize-ci-publication-blockers: staging shell requires the exact synthetic merge" >&2
        exit 1
    fi
    expected_run_id="$(jq -er '.run_id' "$receipt")"
    selected_image="$(
        bash scripts/resolve-binary.sh programs/shell.vfs.zst
    )" || {
        echo "materialize-ci-publication-blockers: transported staging shell is not resolver-selected" >&2
        exit 1
    }
    source_image="$(realpath "$selected_image" 2>/dev/null || true)"
    bash scripts/verify-ci-staging-shell-handoff.sh \
        "$receipt" "$source_image" "$handoff_report" \
        "$expected_base" "$expected_head" "$expected_tree" \
        "$expected_run_id"
    # WHY: this exact local generation contains the shell-composition
    # metadata already proved by Node and Chromium. Rebuilding a fresh
    # source-rootfs bridge here discards that metadata and makes derived
    # products such as LAMP impossible to validate truthfully.
    echo "materialize-ci-publication-blockers: reuse exact staged shell"
    bash scripts/activate-local-shell-build-override.sh "$source_image"
fi

for package in "${blocked_packages[@]}"; do
    # The staging shell handoff above deliberately occupies this local package
    # identity. Resolving the canonical package would correctly hit its
    # pending reviewed-artifact lock and defeat the distinction being tested.
    [ "$package" != "shell" ] || continue
    package_root="packages/registry/$package"
    if [ ! -f "$package_root/package.toml" ] ||
        [ ! -f "$package_root/build.toml" ]; then
        echo "materialize-ci-publication-blockers: blocker names an unknown publishable package: $package" >&2
        exit 1
    fi
    echo "materialize-ci-publication-blockers: source-materialize $package for tests only"
    # WHY: publication_state=pending protects releases, not validation. Build
    # the exact PR recipe into the resolver's local generation so browser tests
    # exercise current bytes without publishing them or accepting stale
    # canonical archives. Already-admitted dependencies still reuse the
    # authenticated prepared workspace.
    WASM_POSIX_FETCH_ONLY=0 \
        "$xtask" build-deps \
            --arch wasm32 \
            --binaries-dir "$REPO_ROOT/local-binaries" \
            --force-source-build \
            resolve "$package"
done
