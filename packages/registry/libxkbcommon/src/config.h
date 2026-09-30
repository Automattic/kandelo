/*
 * Hand-curated config.h for the wasm32-posix-kernel libxkbcommon port
 * (packages/registry/libxkbcommon), pinned to libxkbcommon 1.7.0.
 *
 * We bypass upstream's meson build because its feature probes run against
 * the build host, not the wasm sysroot (see build-libxkbcommon.sh and
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5). The HAVE_*
 * flags below therefore reflect our musl wasm sysroot:
 *   - present: __builtin_expect, mmap, strndup, asprintf, vasprintf.
 *   - absent: eaccess/euidaccess (glibc-only) and secure_getenv — omitting
 *     the latter makes utils.c fall back to plain getenv, which is correct
 *     under the single-user kernel.
 */
#ifndef XKB_WASM_CONFIG_H
#define XKB_WASM_CONFIG_H

#define _GNU_SOURCE 1

/* Kandelo ships no xkeyboard-config tree on disk: a client receives a full
 * keymap *string* from the compositor and compiles it via
 * xkb_keymap_new_from_string, a path that never reads these roots. They
 * exist only so the RMLVO-from-names API links against conventional
 * locations. */
#define DFLT_XKB_CONFIG_ROOT "/usr/share/X11/xkb"
#define DFLT_XKB_CONFIG_EXTRA_PATH "/etc/xkb"
#define XLOCALEDIR "/usr/share/X11/locale"
#define DEFAULT_XKB_RULES "evdev"
#define DEFAULT_XKB_MODEL "pc105"
#define DEFAULT_XKB_LAYOUT "us"
#define DEFAULT_XKB_VARIANT NULL
#define DEFAULT_XKB_OPTIONS NULL

#define HAVE_UNISTD_H 1
#define HAVE___BUILTIN_EXPECT 1
#define HAVE_MMAP 1
#define HAVE_STRNDUP 1
#define HAVE_ASPRINTF 1
#define HAVE_VASPRINTF 1

#endif /* XKB_WASM_CONFIG_H */
