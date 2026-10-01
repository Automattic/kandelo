#!/usr/bin/env bash
#
# Build basu (libbasu.a — standalone sd-bus) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). basu is meson-only upstream, so we bypass
# it like foot/libinput: a hand-curated config.h (src/config.h), the two
# errno table generators run directly (wasm cpp → awk / gperf), and the
# upstream TU list compiled straight — minus the libcap/audit sources,
# which upstream also drops when those Linux-only deps are absent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/basu-src"

BASU_VERSION="${WASM_POSIX_DEP_VERSION:-0.2.1}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/basu-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://git.sr.ht/~emersion/basu/archive/v${BASU_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/basu-build"

for tool in wasm32posix-cc gperf python3 awk; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading basu $BASU_VERSION..."
    TARBALL="/tmp/basu-${BASU_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: basu resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
GEN="$BUILD_DIR/gen"
mkdir -p "$GEN" "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include/basu"

cp "$SCRIPT_DIR/src/config.h" "$GEN/config.h"

echo "==> Generating errno lookup tables..."
sh "$SRC_DIR/src/basic/generate-errno-list.sh" "wasm32posix-cc -E" \
    > "$GEN/errno-list.txt"
python3 "$SRC_DIR/src/basic/generate-gperfs.py" errno '' "$GEN/errno-list.txt" \
    > "$GEN/errno-from-name.gperf"
gperf -L ANSI-C -t --ignore-case -N lookup_errno -H hash_errno_name -p -C \
    "$GEN/errno-from-name.gperf" > "$GEN/errno-from-name.h"
awk -f "$SRC_DIR/src/basic/errno-to-name.awk" "$GEN/errno-list.txt" \
    > "$GEN/errno-to-name.h"

CFLAGS=(
    -O2 -std=gnu99
    # The kernel emulates the Linux syscall ABI (SO_PEERCRED,
    # SCM_CREDENTIALS, /proc) but the toolchain only defines __wasm32__;
    # without this bus-socket.c's auth falls into "#error auth not
    # implemented for this OS". Same boundary erlang and spidermonkey draw.
    -D__linux__
    -include "$GEN/config.h"
    -fvisibility=default
    "-I$GEN"
    "-I$SRC_DIR/src/basic"
    "-I$SRC_DIR/src/systemd"
    "-I$SRC_DIR/src/libsystemd/sd-bus"
    "-I$SRC_DIR/src/libsystemd/sd-daemon"
    "-I$SRC_DIR/src/libsystemd/sd-id128"
    -Wno-typedef-redefinition -Wno-gnu-variable-sized-type-not-at-end
)

# Upstream basic_sources minus the HAVE_LIBCAP-gated cap-list.c +
# capability-util.c.
BASIC_TUS=(
    alloc-util.c audit-util.c bus-label.c env-util.c errno-list.c
    escape.c fd-util.c fileio.c fs-util.c gunicode.c hash-funcs.c
    hashmap.c hexdecoct.c io-util.c json.c locale-util.c log.c
    memfd-util.c parse-util.c path-util.c prioq.c process-util.c
    random-util.c siphash24.c socket-util.c string-util.c strv.c
    syslog-util.c terminal-util.c time-util.c user-util.c utf8.c
    util.c verbs.c xml.c
)

SDBUS_TUS=(
    bus-common-errors.c bus-control.c bus-convenience.c bus-creds.c
    bus-dump.c bus-error.c bus-gvariant.c bus-internal.c
    bus-introspect.c bus-kernel.c bus-match.c bus-message.c
    bus-objects.c bus-signature.c bus-slot.c bus-socket.c bus-track.c
    bus-type.c sd-bus.c
)

echo "==> Compiling basu for wasm32..."
OBJS=()
for tu in "${BASIC_TUS[@]}"; do
    obj="$BUILD_DIR/basic-${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/src/basic/$tu" -o "$obj"
    OBJS+=("$obj")
done
for tu in "${SDBUS_TUS[@]}"; do
    obj="$BUILD_DIR/sd-bus-${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/src/libsystemd/sd-bus/$tu" -o "$obj"
    OBJS+=("$obj")
done
for tu in sd-id128/id128-util.c sd-id128/sd-id128.c sd-daemon/sd-daemon.c; do
    base="$(basename "$tu" .c)"
    obj="$BUILD_DIR/$base.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/src/libsystemd/$tu" -o "$obj"
    OBJS+=("$obj")
done

wasm32posix-ar rcs "$INSTALL_DIR/lib/libbasu.a" "${OBJS[@]}"

for h in sd-bus.h sd-bus-protocol.h sd-bus-vtable.h sd-id128.h _sd-common.h; do
    cp "$SRC_DIR/src/systemd/$h" "$INSTALL_DIR/include/basu/$h"
done

cat > "$INSTALL_DIR/lib/pkgconfig/basu.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: basu
Description: sd-bus library, extracted from systemd
Version: $BASU_VERSION
Libs: -L\${libdir} -lbasu
Cflags: -I\${includedir}
EOF

echo "==> basu build complete!"
ls -lh "$INSTALL_DIR/lib/libbasu.a"
