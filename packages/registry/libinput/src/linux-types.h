/*
 * Minimal <linux/types.h> shim for the libinput port.
 *
 * libinput is compiled against its own bundled full linux UAPI headers
 * (include/linux/linux/input.h), whose input.h opens with
 * `#include <linux/types.h>` for the fixed-width kernel aliases. Our musl
 * wasm sysroot deliberately ships no <linux/types.h>. This shim supplies
 * exactly the aliases the bundled headers reference, mapped onto stdint
 * types, so the bundled set is self-consistent without touching the
 * sysroot. It mirrors the libevdev port's shim (PR5a).
 *
 * build-libinput.sh copies this to the bundled include tree as
 * linux/types.h before compiling.
 */
#ifndef LIBINPUT_WASM_LINUX_TYPES_H
#define LIBINPUT_WASM_LINUX_TYPES_H

#include <stdint.h>

typedef uint8_t  __u8;
typedef uint16_t __u16;
typedef int16_t  __s16;
typedef uint32_t __u32;
typedef int32_t  __s32;
typedef uint64_t __u64;

/* Only referenced by input.h's __USE_TIME_BITS64 branch, which musl
 * wasm32 (no __USE_TIME_BITS64) does not take; defined for completeness. */
typedef unsigned long __kernel_ulong_t;

#endif /* LIBINPUT_WASM_LINUX_TYPES_H */
