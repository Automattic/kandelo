#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LOCK="$REPO_ROOT/homebrew/transitional-pages-shell-rev22-lock.json"

usage() {
    echo "usage: $0 --out <new-directory>" >&2
    exit 2
}

out=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --out)
            [ "$#" -ge 2 ] && [ -z "$out" ] || usage
            out="$2"
            shift 2
            ;;
        *) usage ;;
    esac
done
[ -n "$out" ] || usage

out_parent="$(dirname "$out")"
out_name="$(basename "$out")"
[ -d "$out_parent" ] && [ ! -L "$out_parent" ] || {
    echo "prepare-transitional-pages-shell: output parent must be a real directory" >&2
    exit 1
}
out_parent="$(cd "$out_parent" && pwd -P)"
case "$out_name" in
    ""|.|..|*/*) usage ;;
esac
out="$out_parent/$out_name"
[ ! -e "$out" ] && [ ! -L "$out" ] || {
    echo "prepare-transitional-pages-shell: output already exists: $out" >&2
    exit 1
}

work_root="$(mktemp -d "$out_parent/.kandelo-pages-shell.XXXXXX")"
cleanup() {
    if [ -n "${work_root:-}" ] && [ -d "$work_root" ]; then
        rm -rf -- "$work_root"
    fi
}
trap cleanup EXIT INT TERM
mkdir "$work_root/sources"
mkdir "$work_root/sources/gallery"
mkdir "$work_root/sources/source-projection"
mkdir "$work_root/gallery"
mkdir "$work_root/source-projection"
mkdir "$work_root/source-projection/wasm32"
mkdir "$work_root/source-projection/wasm64"

fetch_plan="$work_root/fetch-plan.json"
"$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/inspect-transitional-homebrew-pages-shell.ts" \
    --lock "$LOCK" \
    --fetch-plan "$fetch_plan"

download_public_asset() {
    local url="$1"
    local destination="$2"
    # WHY: the deployment claim is public availability. A runner token could
    # hide a private or permission-dependent asset, so these reads deliberately
    # carry no GitHub or GitHub Packages credentials.
    env \
        -u GH_TOKEN \
        -u GITHUB_TOKEN \
        -u HOMEBREW_GITHUB_PACKAGES_TOKEN \
        curl --disable --fail --location --silent --show-error \
            --retry 3 --retry-all-errors \
            --proto '=https' --tlsv1.2 \
            --output "$destination" "$url"
}

verify_download() {
    local path="$1"
    local expected_sha256="$2"
    local expected_bytes="$3"
    local actual_sha256 actual_bytes
    actual_sha256="$(shasum -a 256 "$path" | awk '{print $1}')"
    actual_bytes="$(wc -c <"$path" | tr -d '[:space:]')"
    if [ "$actual_sha256" != "$expected_sha256" ] ||
        [ "$actual_bytes" != "$expected_bytes" ]; then
        echo "prepare-transitional-pages-shell: downloaded bytes differ from lock" >&2
        return 1
    fi
}

fetch_one() {
    local selector="$1"
    local destination="$2"
    local url expected_sha256 expected_bytes
    url="$(jq -er "$selector.url" "$fetch_plan")"
    expected_sha256="$(jq -er "$selector.sha256" "$fetch_plan")"
    expected_bytes="$(jq -er "$selector.bytes" "$fetch_plan")"
    download_public_asset "$url" "$destination"
    verify_download "$destination" "$expected_sha256" "$expected_bytes"
}

shell_archive="$work_root/sources/shell-package.tar.zst"
bootstrap_archive="$work_root/sources/homebrew-bootstrap-package.tar.zst"
mirror_plan="$work_root/sources/kandelo-homebrew-bottle-mirror-plan.json"
fetch_one '.shell_archive' "$shell_archive"
fetch_one '.bootstrap_archive' "$bootstrap_archive"
fetch_one '.mirror_plan' "$mirror_plan"

host_target="$(rustc -vV | sed -n 's/^host: //p')"
xtask="${WASM_POSIX_XTASK_BIN:-$REPO_ROOT/target/$host_target/debug/xtask}"
if [ ! -x "$xtask" ]; then
    cargo build --quiet -p xtask --target "$host_target"
fi
[ -x "$xtask" ] || {
    echo "prepare-transitional-pages-shell: xtask was not built" >&2
    exit 1
}

image="$work_root/shell.vfs.zst"
bootstrap_zip="$work_root/homebrew-bootstrap.zip"
bootstrap_env="$work_root/homebrew-brew.env"
"$xtask" archive-extract-member \
    --archive "$shell_archive" \
    --member "$(jq -er '.shell_archive.member' "$fetch_plan")" \
    --out "$image"
"$xtask" archive-extract-member \
    --archive "$bootstrap_archive" \
    --member "$(jq -er \
        '.bootstrap_archive.members["homebrew-bootstrap.zip"].path' \
        "$fetch_plan")" \
    --out "$bootstrap_zip"
"$xtask" archive-extract-member \
    --archive "$bootstrap_archive" \
    --member "$(jq -er \
        '.bootstrap_archive.members["homebrew-brew.env"].path' \
        "$fetch_plan")" \
    --out "$bootstrap_env"

# WHY: five conventional gallery recipes changed after the currently deployed
# Pages assets were published. Their locked archive members are byte-for-byte
# identical to those live assets, so reusing those exact members preserves the
# non-shell demos without making an unrelated rebuild block the shell cutover.
while IFS=$'\t' read -r package output url expected_sha expected_bytes member; do
    case "$package:$output:$member" in
        lamp:lamp.vfs.zst:artifacts/lamp.vfs.zst | \
        nginx-php-vfs:nginx-php.vfs.zst:artifacts/nginx-php.vfs.zst | \
        nginx-vfs:nginx.vfs.zst:artifacts/nginx.vfs.zst | \
        node-vfs:node-vfs.vfs.zst:artifacts/node-vfs.vfs.zst | \
        wordpress:wordpress.vfs.zst:artifacts/wordpress.vfs.zst) ;;
        *)
            echo "prepare-transitional-pages-shell: unsafe gallery asset" >&2
            exit 1
            ;;
    esac
    archive="$work_root/sources/gallery/$package.tar.zst"
    output_dir="$work_root/gallery/$package"
    mkdir "$output_dir"
    download_public_asset "$url" "$archive"
    verify_download "$archive" "$expected_sha" "$expected_bytes"
    "$xtask" archive-extract-member \
        --archive "$archive" \
        --member "$member" \
        --out "$output_dir/$output"
done < <(
    jq -er '.gallery_compatibility[] |
      [.package, .output, .archive.url, .archive.sha256,
       (.archive.bytes | tostring), .archive.member] | @tsv' "$fetch_plan"
)

# WHY: the descriptor-prefix runtime correction changes files listed as broad
# inputs by six conventional package variants, although it cannot change these
# already-built outputs. Bind the old output bytes to the current local source
# identity explicitly instead of rebuilding them or accepting a stale archive.
while IFS=$'\t' read -r package arch output url expected_sha expected_bytes member; do
    case "$package:$arch:$output:$member" in
        kandelo-sdk:wasm32:kandelo-sdk.vfs.zst:artifacts/kandelo-sdk.vfs.zst | \
        mariadb-test:wasm32:mariadb-test.vfs.zst:artifacts/mariadb-test.vfs.zst | \
        mariadb-vfs:wasm32:mariadb-vfs.vfs.zst:artifacts/mariadb-vfs.vfs.zst | \
        mariadb-vfs:wasm64:mariadb-vfs.vfs.zst:artifacts/mariadb-vfs.vfs.zst | \
        redis-vfs:wasm32:redis.vfs.zst:artifacts/redis.vfs.zst | \
        rootfs:wasm32:rootfs.vfs:artifacts/rootfs.vfs) ;;
        *)
            echo "prepare-transitional-pages-shell: unsafe projection asset" >&2
            exit 1
            ;;
    esac
    archive="$work_root/sources/source-projection/$package-$arch.tar.zst"
    output_dir="$work_root/source-projection/$arch/$package"
    mkdir "$output_dir"
    download_public_asset "$url" "$archive"
    verify_download "$archive" "$expected_sha" "$expected_bytes"
    "$xtask" archive-extract-member \
        --archive "$archive" \
        --member "$member" \
        --out "$output_dir/$output"
done < <(
    jq -er '.source_projection_compatibility[] |
      [.package, .arch, .output, .archive.url, .archive.sha256,
       (.archive.bytes | tostring), .archive.member] | @tsv' "$fetch_plan"
)

"$REPO_ROOT/node_modules/.bin/tsx" \
    "$REPO_ROOT/scripts/inspect-transitional-homebrew-pages-shell.ts" \
    --lock "$LOCK" \
    --shell-archive "$shell_archive" \
    --image "$image" \
    --bootstrap-archive "$bootstrap_archive" \
    --bootstrap-zip "$bootstrap_zip" \
    --bootstrap-env "$bootstrap_env" \
    --mirror-plan "$mirror_plan" \
    --gallery-root "$work_root" \
    --report "$work_root/inspection.json"

mv "$work_root" "$out"
work_root=""
trap - EXIT INT TERM
echo "Prepared exact transitional Homebrew shell in $out"
