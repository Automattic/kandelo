#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKER="$REPO_ROOT/scripts/pack-exact-abi-source-test-workspace.sh"
PRIVATE="$(mktemp -d "${RUNNER_TEMP:-/tmp}/kandelo-exact-workspace-test.XXXXXX")"
cleanup() {
    local status="$?"
    trap - EXIT
    rm -rf -- "$PRIVATE"
    exit "$status"
}
trap cleanup EXIT

SOURCE="$PRIVATE/source"
CONSUMER="$PRIVATE/consumer"
ARCHIVE="$PRIVATE/exact-source.tar.zst"
SECOND_ARCHIVE="$PRIVATE/exact-source-second.tar.zst"
mkdir -p "$SOURCE"
git -C "$SOURCE" init -q
git -C "$SOURCE" config user.name "Kandelo exact workspace test"
git -C "$SOURCE" config user.email "exact-workspace@example.invalid"
printf '%s\n' '/target/' '/host/wasm/' '/host/test/fixtures/*.wasm' \
    '/local-binaries/' > "$SOURCE/.gitignore"
printf '%s\n' 'exact source fixture' > "$SOURCE/README.md"
git -C "$SOURCE" add .gitignore README.md
git -C "$SOURCE" commit -q -m fixture

declare -A created_sources=()
while IFS=$'\t' read -r source_path destination_path extra; do
    [ -n "$source_path" ] && [ -n "$destination_path" ] && [ -z "$extra" ] || {
        echo "exact workspace packer returned an invalid allowlist row" >&2
        exit 1
    }
    if [ -z "${created_sources[$source_path]:-}" ]; then
        mkdir -p "$SOURCE/$(dirname "$source_path")"
        printf 'fixture:%s\n' "$source_path" > "$SOURCE/$source_path"
        created_sources[$source_path]=1
    fi
done < <(bash "$PACKER" list)

kernel_source="target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"
kernel_generation="local-binaries/.kandelo-local-generations/kernel-fixture"
mkdir -p "$SOURCE/$kernel_generation"
cp -- "$SOURCE/$kernel_source" "$SOURCE/$kernel_generation/kernel.wasm"
ln -s ".kandelo-local-generations/kernel-fixture/kernel.wasm" \
    "$SOURCE/local-binaries/kernel.wasm"

git clone -q "$SOURCE" "$CONSUMER"

bash "$PACKER" pack \
    --source-root "$SOURCE" \
    --archive "$ARCHIVE"
bash "$PACKER" pack \
    --source-root "$SOURCE" \
    --archive "$SECOND_ARCHIVE"
cmp "$ARCHIVE" "$SECOND_ARCHIVE"

bash "$PACKER" extract \
    --source-root "$CONSUMER" \
    --archive "$ARCHIVE"

expected_paths="$PRIVATE/expected-paths"
actual_paths="$PRIVATE/actual-paths"
bash "$PACKER" list | cut -f2 | LC_ALL=C sort > "$expected_paths"
printf '%s\n' '.ci-exact-abi-source-test-inventory.json' \
    >> "$expected_paths"
LC_ALL=C sort -o "$expected_paths" "$expected_paths"
tar --zstd -tf "$ARCHIVE" |
    sed -e 's#^\./##' -e '/^$/d' -e '/\/$/d' |
    LC_ALL=C sort > "$actual_paths"
cmp "$expected_paths" "$actual_paths" || {
    echo "exact source archive member inventory differs" >&2
    diff -u "$expected_paths" "$actual_paths" >&2 || true
    exit 1
}

while IFS= read -r destination_path; do
    [ "$destination_path" = ".ci-exact-abi-source-test-inventory.json" ] && continue
    [ -f "$CONSUMER/$destination_path" ] && \
        [ ! -L "$CONSUMER/$destination_path" ] || {
        echo "extracted exact workspace member is not a regular file: $destination_path" >&2
        exit 1
    }
done < "$expected_paths"

if tar --zstd -tf "$ARCHIVE" | grep -Eq \
    '(^|/)(binaries|packages/registry/program-packages\.json)(/|$)|\.vfs(\.zst)?$|\.tar\.zst$'; then
    echo "exact source workspace retained a package or product artifact" >&2
    exit 1
fi

expect_failure() {
    local label="$1"
    local expected="$2"
    shift 2
    local output="$PRIVATE/$label.out"
    if "$@" > "$output" 2>&1; then
        echo "exact workspace packer accepted $label" >&2
        exit 1
    fi
    grep -Fq "$expected" "$output" || {
        echo "exact workspace packer reported the wrong $label error" >&2
        cat "$output" >&2
        exit 1
    }
}

tampered_root="$PRIVATE/tampered-workspace"
mkdir "$tampered_root"
tar --zstd -xf "$ARCHIVE" -C "$tampered_root"
mkdir "$tampered_root/undeclared-empty-directory"
tar --zstd -cf "$PRIVATE/extra-directory.tar.zst" -C "$tampered_root" .
expect_failure extra-directory "undeclared directory" \
    bash "$PACKER" extract --source-root "$CONSUMER" \
        --archive "$PRIVATE/extra-directory.tar.zst"
rmdir "$tampered_root/undeclared-empty-directory"

printf 'tampered\n' >> "$tampered_root/host/wasm/audiotest.wasm"
tar --zstd -cf "$PRIVATE/tampered-member.tar.zst" -C "$tampered_root" .
expect_failure tampered-member "workspace member differs" \
    bash "$PACKER" extract --source-root "$CONSUMER" \
        --archive "$PRIVATE/tampered-member.tar.zst"
rm -rf "$tampered_root"

mkdir -p "$SOURCE/host/wasm"
printf 'rogue\n' > "$SOURCE/host/wasm/rogue.wasm"
expect_failure undeclared "undeclared source-test artifact" \
    bash "$PACKER" pack --source-root "$SOURCE" \
        --archive "$PRIVATE/undeclared.tar.zst"
rm "$SOURCE/host/wasm/rogue.wasm"

mv "$SOURCE/host/test/fixtures" "$PRIVATE/external-fixtures"
ln -s "$PRIVATE/external-fixtures" "$SOURCE/host/test/fixtures"
expect_failure symlink-ancestor "source artifact parent is a symbolic link" \
    bash "$PACKER" pack --source-root "$SOURCE" \
        --archive "$PRIVATE/symlink-ancestor.tar.zst"
rm "$SOURCE/host/test/fixtures"
mv "$PRIVATE/external-fixtures" "$SOURCE/host/test/fixtures"

printf 'product\n' > "$SOURCE/host/wasm/rootfs.vfs"
expect_failure product-vfs "product VFS" \
    bash "$PACKER" pack --source-root "$SOURCE" \
        --archive "$PRIVATE/product-vfs.tar.zst"
rm "$SOURCE/host/wasm/rootfs.vfs"

mkdir "$SOURCE/binaries"
expect_failure binaries "legacy binaries" \
    bash "$PACKER" pack --source-root "$SOURCE" \
        --archive "$PRIVATE/binaries.tar.zst"
rmdir "$SOURCE/binaries"

rm "$SOURCE/local-binaries/kernel.wasm"
printf 'mutable kernel\n' > "$SOURCE/local-binaries/kernel.wasm"
expect_failure mutable-kernel "immutable local generation" \
    bash "$PACKER" pack --source-root "$SOURCE" \
        --archive "$PRIVATE/mutable-kernel.tar.zst"
rm "$SOURCE/local-binaries/kernel.wasm"
ln -s ".kandelo-local-generations/kernel-fixture/kernel.wasm" \
    "$SOURCE/local-binaries/kernel.wasm"

printf '%s\n' 'different exact source' >> "$CONSUMER/README.md"
git -C "$CONSUMER" add README.md
git -C "$CONSUMER" -c user.name=test -c user.email=test@example.invalid \
    commit -q -m different
expect_failure source-identity "source identity differs" \
    bash "$PACKER" extract --source-root "$CONSUMER" --archive "$ARCHIVE"

echo "Exact ABI source-test workspace packing: PASS"
