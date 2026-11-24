#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 5 ]]; then
    printf 'Usage: %s <D SDK directory> <output.wasm> <libcurl package> <openssl package> <zlib package>\n' "$0" >&2
    exit 2
fi

sdk_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sdk="$(cd "$1" && pwd)"
output="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
libcurl="$(cd "$3" && pwd)/lib/libcurl.a"
openssl="$(cd "$4" && pwd)/lib"
zlib="$(cd "$5" && pwd)/lib/libz.a"
work="$(mktemp -d "$(dirname "$output")/.kandelo-dub.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT

version=1.43.0
digest=f69ebd696d0e7c7d826fa835dc8594b20e62c475c0d7e60cfb2f342b4a5887b3
curl --fail --location --silent --show-error \
    "https://codeload.github.com/dlang/dub/tar.gz/refs/tags/v$version" \
    -o "$work/source.tar.gz"
printf '%s  %s\n' "$digest" "$work/source.tar.gz" | sha256sum --check
tar -xzf "$work/source.tar.gz" -C "$work" --strip-components=1

cd "$work"
# DUB's upstream build.d normally writes this module from GITVER.
printf 'module dub.version_;\nenum dubVersion = "%s";\n' "$version" > source/dub/version_.d
# Phobos binds these libcurl functions through dlsym on the executable.
# Export the API it reads without exposing unrelated archive symbols.
curl_api=(
    global_init global_cleanup version_info easy_init easy_setopt easy_perform
    easy_getinfo easy_duphandle easy_strerror easy_pause easy_cleanup slist_append slist_free_all
)
exports=()
for symbol in "${curl_api[@]}"; do
    exports+=("-L--export=curl_$symbol")
done
"$sdk_dir/build-program.sh" "$sdk" "$output" \
    -d-version=DubUseCurl -d-version=DubApplication -I=source -L-ldl \
    "${exports[@]}" @build-files.txt "$libcurl" "$openssl/libssl.a" "$openssl/libcrypto.a" "$zlib"
chmod 0755 "$output"
