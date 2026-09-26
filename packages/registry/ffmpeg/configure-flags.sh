# Sourced, not executed. The single definition of FFmpeg's configure
# environment and flags, shared by build-ffmpeg.sh, the hand-run aperture
# rungs, and test/fate/run-fate.sh, so they can never build different
# FFmpegs.
#
# WHY each flag (docs/plans/2026-09-26-ffmpeg-port-design.md §5):
#   --arch=wasm           upstream n9.0 knows wasm and its simd128 extension;
#                         ffmpeg.wasm's --arch=x86_32 is a lie we do not tell.
#   --target-os=none      configure's empty `none)` case: no OS assumptions,
#                         every feature probed. The default is `uname -s` of
#                         the build machine, which would say darwin on a Mac.
#   (no --disable-asm)    configure disables every arch extension, simd128
#                         included, when asm is disabled.
#   --disable-autodetect  the external dependency set must equal depends_on;
#                         autodetect would pick up anything in the sysroot.
#   --enable-pthreads     AUTODETECT_LIBS includes $THREADS_LIST, so
#                         --disable-autodetect silently disables threads.
#   --disable-openssl     linking OpenSSL requires --enable-nonfree.
#   --host-cc=cc          configure builds a few helper tools for the build
#                         machine and defaults their compiler to gcc; the
#                         dev shell provides the host compiler as cc.
#   (no -I for GNU libiconv) with --disable-autodetect FFmpeg probes the
#                         libc's iconv (musl has one). GNU libiconv's iconv.h
#                         renames iconv to libiconv, so putting it on the
#                         include path makes that probe link the wrong
#                         symbol. libiconv stays a dependency because
#                         libxml2's static link requires it; pkg-config
#                         supplies it through libxml2's Requires.private.
#                         SDL2 flags come from pkg-config. libxml2's install
#                         include root is added explicitly: FFmpeg includes
#                         <libxml2/libxml/xmlversion.h>, which a system install
#                         finds on the default include path.
#   --pkg-config-flags=--static
#                         every library is linked statically; FFmpeg's own
#                         configure recommends this for static binaries.

# Export the pkg-config search path for the resolved dependency prefixes.
# Requires ZLIB_PREFIX, LIBICONV_PREFIX, LIBXML2_PREFIX, SDL2_PREFIX.
ffmpeg_configure_env() {
    local p path=""
    for p in "$ZLIB_PREFIX" "$LIBICONV_PREFIX" "$LIBXML2_PREFIX" "$SDL2_PREFIX"; do
        path="${path:+$path:}$p/lib/pkgconfig"
    done
    export PKG_CONFIG_PATH="$path${WASM_POSIX_DEP_PKG_CONFIG_PATH:+:$WASM_POSIX_DEP_PKG_CONFIG_PATH}"
}

# Fill FFMPEG_CONFIGURE_FLAGS for mode `target` (the package) or `rung1`
# (development instrument only; never the package's build).
ffmpeg_configure_flags() {
    local mode="$1"
    FFMPEG_CONFIGURE_FLAGS=(
        --prefix=/usr
        --enable-cross-compile --arch=wasm --target-os=none
        --cc=wasm32posix-cc --cxx=wasm32posix-c++ --ar=wasm32posix-ar
        --nm=wasm32posix-nm --ranlib=wasm32posix-ranlib --host-cc=cc
        --pkg-config=wasm32posix-pkg-config --pkg-config-flags=--static
        "--extra-cflags=-msimd128 -O3 -I$ZLIB_PREFIX/include -I$LIBXML2_PREFIX/include"
        "--extra-ldflags=-L$ZLIB_PREFIX/lib"
        --enable-static --disable-shared --disable-doc
        --disable-autodetect --disable-openssl
        --enable-pthreads
    )
    case "$mode" in
        target)
            FFMPEG_CONFIGURE_FLAGS+=(
                --enable-zlib --enable-sdl2 --enable-iconv --enable-libxml2
            )
            ;;
        rung1)
            FFMPEG_CONFIGURE_FLAGS+=(
                --disable-everything
                --enable-protocol=file,pipe
                --enable-demuxer=mov,wav,nut
                --enable-muxer=mp4,mov,wav,nut,framecrc,streamhash,null,rawvideo,pcm_s16le
                --enable-decoder=mpeg4,aac,aac_fixed,pcm_s16le,rawvideo,wrapped_avframe
                --enable-encoder=mpeg4,pcm_s16le,rawvideo
                --enable-parser=mpeg4video,aac
                --enable-indev=lavfi
                --enable-filter=testsrc,sine,scale,format,aformat,aresample,null,anull,buffer,buffersink,abuffer,abuffersink
            )
            ;;
        *) echo "ffmpeg_configure_flags: unknown mode $mode" >&2; return 1 ;;
    esac
}
