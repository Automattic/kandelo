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
    work_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/kandelo-ci-source-shell.XXXXXX")"
    cleanup() {
        rm -rf -- "$work_root"
    }
    trap cleanup EXIT
    archive_root="$work_root/archive"
    mkdir "$archive_root"
    source_commit="$(git rev-parse HEAD)"
    source_repository="https://github.com/${GITHUB_REPOSITORY:-Automattic/kandelo}"
    cache_root="$("$xtask" build-deps cache-root)"
    # WHY: the canonical shell must remain publication-pending until its final
    # tap commit and reviewed digest exist. Reuse the separately identified
    # source-rootfs bridge for CI instead of asking the canonical recipe to
    # bypass that lock. Its dependencies come from the authenticated prepared
    # workspace; only the bridge itself is built here.
    "$xtask" archive-stage \
        --package "$REPO_ROOT/homebrew/source-rootfs-shell-package" \
        --registry "$REPO_ROOT/packages/registry" \
        --arch wasm32 \
        --binaries-dir "$REPO_ROOT/local-binaries" \
        --out "$archive_root" \
        --build-timestamp "1970-01-01T00:00:00Z" \
        --build-host "ci-publication-blocker-materialization" \
        --source-repository "$source_repository" \
        --source-commit "$source_commit" \
        --cache-root "$cache_root" \
        --force-source-build
    mapfile -t source_archives < <(
        find "$archive_root" -maxdepth 1 -type f -name '*.tar.zst' -print
    )
    if [ "${#source_archives[@]}" -ne 1 ]; then
        echo "materialize-ci-publication-blockers: source shell produced ${#source_archives[@]} archives; expected one" >&2
        exit 1
    fi
    source_manifest="$work_root/manifest.toml"
    "$xtask" archive-extract-member \
        --archive "${source_archives[0]}" \
        --member manifest.toml \
        --out "$source_manifest"
    archive_package="$(sed -nE \
        's/^name[[:space:]]*=[[:space:]]*"([^"]+)"$/\1/p' \
        "$source_manifest" | head -n 1)"
    archive_repository="$(sed -nE \
        's/^repo_url[[:space:]]*=[[:space:]]*"([^"]+)"$/\1/p' \
        "$source_manifest")"
    archive_commit="$(sed -nE \
        's/^commit[[:space:]]*=[[:space:]]*"([0-9a-f]{40})"$/\1/p' \
        "$source_manifest")"
    if [ "$archive_package" != "source-rootfs-shell" ] ||
        [ "$archive_repository" != "$source_repository" ] ||
        [ "$archive_commit" != "$source_commit" ] ||
        grep -Fq UNPUBLISHED "$source_manifest"; then
        echo "materialize-ci-publication-blockers: source shell archive provenance does not match the exact checkout" >&2
        exit 1
    fi
    source_image="$work_root/shell.vfs.zst"
    "$xtask" archive-extract-member \
        --archive "${source_archives[0]}" \
        --member artifacts/shell.vfs.zst \
        --out "$source_image"
    bash scripts/install-local-shell-artifact.sh \
        "$source_image" \
        "ci-publication-blockers-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
    bash scripts/activate-local-shell-build-override.sh "$source_image"
fi

for package in "${blocked_packages[@]}"; do
    # The source-rootfs bridge above deliberately occupies this local package
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
