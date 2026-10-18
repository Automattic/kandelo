/*
 * Hand-curated config.h for the wasm32-posix-kernel libinput port
 * (packages/registry/libinput), pinned to libinput 1.25.0.
 *
 * We bypass upstream's meson build because its feature probes run against
 * the build host, not the wasm sysroot (see build-libinput.sh and
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5, PR5c). Every
 * value below is the result meson's `config_h` would compute for our
 * wasm32 musl sysroot, derived by reading each `config_h.set*` in
 * upstream meson.build against what the sysroot actually provides:
 *
 *   _GNU_SOURCE                     always set by meson.
 *   MESON_BUILD_ROOT ""            release build → empty (builddir.h then
 *                                   short-circuits its /proc/self/exe probe).
 *   HAVE_VERSIONSORT               dirent.h provides versionsort under
 *                                   _GNU_SOURCE (checked in the sysroot);
 *                                   libinput-versionsort.h keys on #ifndef.
 *   HAVE_LOCALE_H                  locale.h + newlocale link (verified).
 *   HAVE_LIBEVDEV_DISABLE_PROPERTY libevdev 1.13.3 >= 1.9.902 (PR5a).
 *   HAVE_LIBWACOM 0               no libwacom port; tablet code #if-guards it.
 *   HAVE_INSTALLED_TESTS 0        not building the test suite.
 *   LIBINPUT_QUIRKS_*             runtime data paths (quirks are optional;
 *                                   a missing dir logs and continues).
 *   HTTP_DOC_LINK                 diagnostic URL embedded in log messages.
 *
 * Deliberately NOT defined (the sysroot already satisfies them, so meson
 * would leave them unset):
 *   static_assert(...)            musl <assert.h> #defines static_assert.
 *   program_invocation_short_name no TU in the path backend references it.
 *   HAVE_XLOCALE_H                musl ships no <xlocale.h>.
 *   PTRACE_* / _Float128          unused by the path backend / coverity-only.
 */
#ifndef LIBINPUT_WASM_CONFIG_H
#define LIBINPUT_WASM_CONFIG_H

#define _GNU_SOURCE 1

#define MESON_BUILD_ROOT ""

#define HAVE_VERSIONSORT 1
#define HAVE_LOCALE_H 1
#define HAVE_LIBEVDEV_DISABLE_PROPERTY 1
#define HAVE_LIBWACOM 0
#define HAVE_INSTALLED_TESTS 0

#define LIBINPUT_QUIRKS_DIR "/usr/share/libinput"
#define LIBINPUT_QUIRKS_OVERRIDE_FILE "/etc/libinput/local-overrides.quirks"
#define LIBINPUT_QUIRKS_SRCDIR "/usr/share/libinput"

#define HTTP_DOC_LINK "https://wayland.freedesktop.org/libinput/doc/1.25.0"

#endif /* LIBINPUT_WASM_CONFIG_H */
