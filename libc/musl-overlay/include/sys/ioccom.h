/*
 * Compatibility shim for wasm-posix-kernel's wasm32 sysroot.
 *
 * The vendored Linux UAPI DRM headers (libc/musl-overlay/include/drm/)
 * use a triple-branch include strategy:
 *
 *   #if defined(__KERNEL__)            -> kernel build, not us
 *   #elif defined(__linux__)           -> normal user-space on Linux
 *   #else / * One of the BSDs * /      -> BSD/Darwin fallback
 *      #include <sys/ioccom.h>
 *      ...
 *
 * clang targeting `wasm32-unknown-unknown` predefines only `__wasm__`
 * (verified: `clang --target=wasm32 -dM -E - </dev/null | grep linux`
 * yields nothing). So vendored UAPI headers in our sysroot hit the
 * "BSD" branch and #include <sys/ioccom.h> — a header that exists on
 * BSDs/Darwin but not on Linux/musl. This file provides it.
 *
 * BSD's <sys/ioccom.h> exposes the _IO/_IOR/_IOW/_IOWR macros that
 * encode an ioctl request number. Linux/musl provides the same macros
 * via <sys/ioctl.h>, using the same direction-bit encoding
 * (NR in [0..7], type in [8..15], size in [16..29], dir in [30..31]) —
 * so the numerical values match upstream Linux UAPI, which is what the
 * kernel-side ioctl-number tests in crates/shared/src/dri.rs verify.
 * Forwarding the include keeps consumer code working.
 *
 * The BSD branch of drm.h also uses `__user` as a struct-field
 * annotation but does not define it in that branch (in real Linux
 * builds it comes from <linux/compiler.h> via <linux/types.h>).
 * Define it as empty here so the same vendored headers compile in
 * both branches without further per-consumer flags.
 */

#ifndef _SYS_IOCCOM_H
#define _SYS_IOCCOM_H 1

#include <sys/ioctl.h>

#ifndef __user
#define __user
#endif

#endif /* _SYS_IOCCOM_H */
