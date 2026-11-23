#!/bin/bash
set -euo pipefail

real_driver=$(command -v wasm32posix-cc)
export real_driver
mkdir cache-probe-tools
cat > cache-probe-tools/wasm32posix-cc <<'EOF'
#!/bin/bash
set -e
if [[ $1 == --print-kandelo-sdk ]]; then
    identity=$("$real_driver" "$@")
    printf '%s-%s\n' "$identity" "$sdk_revision"
    exit 0
fi
for arg in "$@"; do
    case $arg in
        *cache_probe_zcu.o.bc) printf 'lower\n' >> "$lowering_log" ;;
    esac
done
exec "$real_driver" "$@"
EOF
chmod +x cache-probe-tools/wasm32posix-cc
export PATH="$PWD/cache-probe-tools:$PATH"
export lowering_log="$PWD/cache-lowering.log" sdk_revision

compile() {
    # Zig's little-endian client messages: update (1), then exit (0).
    # --listen stores outputs in the same whole-compilation cache used by zig build.
    printf '\001\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' |
        zig "$1" -fno-compiler-rt --cache-dir .cache-probe --global-cache-dir .cache-probe \
            --listen=- cache_probe.zig > compiler-response.bin
}

check_cache() {
    local command=$1 artifact=$2
    : > "$lowering_log"
    sdk_revision=first
    compile "$command"
    check_outputs "$artifact" 1
    compile "$command"
    check_outputs "$artifact" 1
    sdk_revision=second
    compile "$command"
    check_outputs "$artifact" 2
}

check_outputs() {
    local artifact=$1 expected=$2 lowered outputs
    lowered=$(wc -l < "$lowering_log")
    outputs=$(find .cache-probe/o -name "$artifact" | wc -l)
    if [[ $lowered -ne $expected || $outputs -ne $expected ]]; then
        printf '%s: expected %s SDK lowerings and cache entries, saw %s and %s\n' \
            "$artifact" "$expected" "$lowered" "$outputs" >&2
        exit 1
    fi
}

check_cache build-obj cache_probe.o
check_cache build-lib libcache_probe.a
printf 'SDK identity invalidated cached Zig objects and archives\n'
