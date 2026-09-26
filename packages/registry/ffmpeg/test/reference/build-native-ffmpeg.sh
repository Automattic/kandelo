#!/usr/bin/env bash
# Build native FFmpeg n9.0 on the build host from the same pinned tarball
# the Kandelo package uses. Its only job is to produce reference outputs
# for bit-exact comparison; it is never shipped.
#
# -ffp-contract=off: clang may fuse multiply-adds on arm64 by default,
# which changes float results. Kandelo's wasm build cannot fuse, so the
# reference must not either, or float codecs would differ for reasons
# that have nothing to do with Kandelo.
#
# --disable-asm: the reference must come from FFmpeg's portable C code.
# With its arm64 NEON assembly enabled, native n9.0 decodes the MPEG-4
# Part 2 fixture differently from its own C code from the second GOP on
# (even with -flags +bitexact on the input); `-cpuflags 0` output matches
# the C build, and Kandelo's. Kandelo compiles only FFmpeg's C paths plus
# upstream's wasm simd128 kernels, which FATE checks against C.
set -euo pipefail

VERSION=9.0
SHA256="${FFMPEG_SOURCE_SHA256:-7f607a00dd0d28a729d5a4811205812eef01cf6ef6155025febb6f36a9062d52}"
PREFIX="${KANDELO_FFMPEG_NATIVE_PREFIX:-$HOME/.cache/kandelo/ffmpeg-native-$VERSION-c}"
SRC_CACHE="$HOME/.cache/kandelo/ffmpeg-src"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-native.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ -x "$PREFIX/bin/ffmpeg" ] && "$PREFIX/bin/ffmpeg" -version | head -1 | grep -q "version $VERSION"; then
    echo "native ffmpeg $VERSION already at $PREFIX"
    exit 0
fi

mkdir -p "$SRC_CACHE"
TARBALL="$SRC_CACHE/ffmpeg-$VERSION.tar.xz"
[ -f "$TARBALL" ] || curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$TARBALL"
echo "$SHA256  $TARBALL" | shasum -a 256 -c -
tar xJf "$TARBALL" -C "$WORK" --strip-components=1
cd "$WORK"
# FFmpeg defaults to gcc; the dev shell provides the host compiler as $CC.
./configure --prefix="$PREFIX" --cc="${CC:-cc}" \
    --disable-doc --disable-autodetect --enable-pthreads --disable-asm \
    --extra-cflags="-ffp-contract=off"
make -j"$(getconf _NPROCESSORS_ONLN)"
make install
"$PREFIX/bin/ffmpeg" -version | head -1
