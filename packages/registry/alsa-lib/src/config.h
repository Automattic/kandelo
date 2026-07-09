/*
 * Hand-curated config.h for alsa-lib 1.2.10 — wasm32-posix-kernel
 * PCM-hardware-direct subset.
 *
 * Replaces the autoconf-generated header. Upstream's `configure`
 * runs host feature-detection compile/link probes which return
 * misleading results when cross-compiling to wasm32 (e.g.
 * `feenableexcept` is detected as present on macOS/Linux even when
 * not in the wasm sysroot — see CLAUDE.md "Cross-Compilation and
 * Configure Scripts"). The build script (build-alsa-lib.sh) skips
 * configure entirely; this header is the source of truth.
 *
 * Defines correspond to include/config.h.in knobs. Anything left
 * undefined means "no" — matching the autoconf convention where an
 * #undef line gets either a #define or is silently dropped.
 */

#ifndef WPK_ALSA_CONFIG_H
#define WPK_ALSA_CONFIG_H

/* --- Package identity --- */
#define PACKAGE        "alsa-lib"
#define PACKAGE_NAME   "alsa-lib"
#define PACKAGE_STRING "alsa-lib 1.2.10"
#define PACKAGE_VERSION "1.2.10"
#define VERSION        "1.2.10"
#define PACKAGE_TARNAME "alsa-lib"
#define PACKAGE_BUGREPORT "alsa-devel@alsa-project.org"
#define PACKAGE_URL    ""

/* --- ALSA install-prefix paths (unused in the subset; configure
 *     hands these to the runtime config-tree loader, which we
 *     bypass via 0001-default-to-hw00.patch). Provide non-empty
 *     strings so any stray reference compiles. --- */
#define ALSA_CONFIG_DIR     "/etc/alsa"
#define ALSA_PKGCONF_DIR    "/etc/alsa.conf.d"
#define ALSA_PLUGIN_DIR     "/usr/lib/alsa-lib"
#define ALSA_DEVICE_DIRECTORY "/dev/snd/"
#define ALOAD_DEVICE_DIRECTORY "/dev/"
#define SND_MAX_CARDS       8
#define TMPDIR              "/tmp"
#define LT_OBJDIR           ".libs/"

/* --- Subsystems --- */
#define BUILD_PCM 1
/* BUILD_MIXER / BUILD_HWDEP / BUILD_RAWMIDI / BUILD_SEQ /
 * BUILD_TOPOLOGY / BUILD_UCM intentionally undefined. */

/* --- PCM plugins (deliberately none — hw direct only) ---
 * BUILD_PCM_PLUGIN_{ADPCM,ALAW,LFLOAT,MMAP_EMUL,MULAW,RATE,ROUTE}
 * intentionally undefined. */

/* --- Standard C headers (all available via musl) --- */
#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_MEMORY_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_DLFCN_H 1
#define HAVE_MALLOC_H 1
#define HAVE_ENDIAN_H 1
/* HAVE_SYS_ENDIAN_H undefined (musl uses endian.h) */
/* HAVE_SYS_SHM_H undefined (no SysV shm path in subset) */

/* --- libc features --- */
#define HAVE_CLOCK_GETTIME 1
#define HAVE_EACCESS 1
/* HAVE_USELOCALE undefined — not available in wasm musl */
/* HAVE_WORDEXP undefined — not available in wasm musl */
#define HAVE___THREAD 1

/* --- pthread --- */
#define HAVE_LIBPTHREAD 1
#define HAVE_PTHREAD_MUTEX_RECURSIVE 1

/* --- librt / dynamic loader --- */
#define HAVE_LIBRT 1
/* HAVE_LIBDL undefined — no dlopen on wasm32 kernel; dlmisc.c
 * gates its real body on #ifdef HAVE_LIBDL and degrades to
 * "feature unavailable" stubs otherwise. */

/* --- Thread-safety wrappers (subset built single-threaded for
 *     the smoke test; SDL2 will manage its own locking around
 *     snd_pcm_* calls). Leaving THREAD_SAFE_API undefined drops
 *     the recursive-mutex wrappers around every snd_pcm_* entry
 *     point. --- */
/* THREAD_SAFE_API undefined */
#define LOCKLESS_DMIX_DEFAULT 0

/* --- Large-file support --- */
#define HAVE_LFS 1
#define _FILE_OFFSET_BITS 64
#define _LARGE_FILES 1
#define TIME_WITH_SYS_TIME 1

/* --- Misc --- */
/* HAVE_LIBRESMGR undefined */
/* HAVE_SOFT_FLOAT undefined */
/* HAVE_MMX undefined */
/* HAVE_ATTRIBUTE_SYMVER undefined — wasm-ld does not implement
 * .symver; we replace the use_default_symbol_version macro via
 * 0002-wasm-attribute-alias.patch. */
/* VERSIONED_SYMBOLS undefined — static build, no shared-lib
 * symbol versioning. */
/* SUPPORT_ALOAD / SUPPORT_RESMGR undefined */
/* NDEBUG undefined (assert() still active) */

/* --- Symbol prefix (empty on ELF/wasm). --- */
#define __SYMBOL_PREFIX ""

/* --- glibc compat: alsa-lib's global.h leaves __STRING undefined on
 * the PIC branch (it expects libc's <sys/cdefs.h> to provide it).
 * musl ships <sys/cdefs.h> but doesn't define __STRING — provide it
 * here so SND_DLSYM_VERSION(x) → __STRING(x) → #x stringifies as
 * intended. --- */
#ifndef __STRING
#define __STRING(x) #x
#endif

#endif /* WPK_ALSA_CONFIG_H */
