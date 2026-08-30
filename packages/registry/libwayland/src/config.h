/*
 * Hand-curated replacement for the config.h that wayland's meson build
 * generates via feature probes. We bypass meson (see build-libwayland.sh)
 * and compile the core TUs directly, so this file must reflect what the
 * wasm32 musl sysroot actually provides — NOT what a probe against the
 * host (macOS/Linux) would report.
 *
 * Only wayland-os.c and wayland-shm.c consume these macros. The guards
 * are a mix of `#ifdef` (presence-only) and `#if` (needs a 0/1 value):
 *   - #ifdef HAVE_SYS_UCRED_H   (wayland-os.c)  — absent in our sysroot,
 *                                                 so leave UNDEFINED.
 *   - #if HAVE_XUCRED_CR_PID    (wayland-os.c)  — needs an explicit 0.
 *   - #if HAVE_BROKEN_MSG_CMSG_CLOEXEC (os.c)   — needs an explicit 0.
 *   - #ifdef HAVE_ACCEPT4       (wayland-os.c)  — present, so DEFINE.
 *   - #ifdef HAVE_MEMFD_CREATE  (wayland-shm.c) — present, so DEFINE.
 *
 * The remaining HAVE_* (mkostemp/posix_fallocate/prctl/mremap/strndup)
 * are only referenced by scanner.c, which is a HOST tool we do not build
 * here (we use the flake's wayland-scanner). They are defined to match
 * the sysroot for completeness/coherence.
 *
 * Verified against sysroot/include: all listed functions are declared and
 * MREMAP_MAYMOVE is defined, so wayland-shm.c's shm_pool_grow_mapping()
 * takes the direct mremap() path rather than the wl_os_mremap_maymove()
 * emulation. See docs/plans/2026-07-08-dri-wayland-compositor-plan.md §3.
 */
#ifndef WAYLAND_CONFIG_H
#define WAYLAND_CONFIG_H

#define PACKAGE "wayland"
#define PACKAGE_VERSION "1.24.0"

/* Headers: sys/prctl.h is present; sys/procctl.h and sys/ucred.h are not
 * (leaving the latter two undefined keeps their guarded #includes out). */
#define HAVE_SYS_PRCTL_H 1

/* Functions present in the wasm32 musl sysroot. */
#define HAVE_ACCEPT4 1
#define HAVE_MKOSTEMP 1
#define HAVE_POSIX_FALLOCATE 1
#define HAVE_PRCTL 1
#define HAVE_MEMFD_CREATE 1
#define HAVE_MREMAP 1
#define HAVE_STRNDUP 1

/* No struct xucred (BSD) on musl; no FreeBSD MSG_CMSG_CLOEXEC bug. */
#define HAVE_XUCRED_CR_PID 0
#define HAVE_BROKEN_MSG_CMSG_CLOEXEC 0

#endif /* WAYLAND_CONFIG_H */
