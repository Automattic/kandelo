/*
 * Subset of <linux/input.h> matching what crates/shared/src/lib.rs::input
 * marshals. Force-feedback, autorepeat, MT slots, and the rest of the
 * Linux UAPI surface are intentionally omitted — kandelo doesn't
 * implement them.
 *
 * Any change here is part of the kernel ABI — bump ABI_VERSION.
 */
#ifndef _LINUX_INPUT_H
#define _LINUX_INPUT_H 1

#include <linux/input-event-codes.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <sys/time.h>

/* Linux UAPI naming. Defined inline rather than dragging in a separate
 * <linux/types.h> stub. Guard each so a parent project that already
 * defines them via its own <linux/types.h> doesn't see a redefinition. */
#ifndef __u8
typedef uint8_t  __u8;
#endif
#ifndef __u16
typedef uint16_t __u16;
#endif
#ifndef __u32
typedef uint32_t __u32;
#endif
#ifndef __s8
typedef int8_t   __s8;
#endif
#ifndef __s16
typedef int16_t  __s16;
#endif
#ifndef __s32
typedef int32_t  __s32;
#endif

/* `struct input_event` on wasm32-musl. Total 24 bytes:
 *   struct timeval (i64 tv_sec + i32 tv_usec + 4B trailing pad to
 *                   re-align to 8) = 16 bytes,
 *   __u16 type + __u16 code + __s32 value                          = 8.
 * Matches `shared::input::WpkInputEvent`. */
struct input_event {
    struct timeval time;
    __u16 type;
    __u16 code;
    __s32 value;
};

/* Returned by EVIOCGID. Total 8 bytes. */
struct input_id {
    __u16 bustype;
    __u16 vendor;
    __u16 product;
    __u16 version;
};

/* Returned by EVIOCGABS(axis). Total 24 bytes. The kernel reports
 * `maximum = canvas_dim - 1`, `resolution = 1` unit per pixel; other
 * fields are zero. */
struct input_absinfo {
    __s32 value;
    __s32 minimum;
    __s32 maximum;
    __s32 fuzz;
    __s32 flat;
    __s32 resolution;
};

/* --- ioctl numbers ('E' magic, Linux UAPI verbatim) ------------------
 *
 * The kernel A3 dispatch matches on (dir, magic, nr); the `size` field
 * (bits 16..29) is informational on the userspace side — the kernel
 * re-computes the buffer length from `size` at dispatch time. */

#define EVIOCGVERSION       _IOR('E', 0x01, int)
#define EVIOCGID            _IOR('E', 0x02, struct input_id)
#define EVIOCGNAME(len)     _IOC(_IOC_READ, 'E', 0x06, len)
#define EVIOCGBIT(ev, len)  _IOC(_IOC_READ, 'E', 0x20 + (ev), len)
#define EVIOCGABS(abs)      _IOR('E', 0x40 + (abs), struct input_absinfo)
#define EVIOCGRAB           _IOW('E', 0x90, int)

#endif /* _LINUX_INPUT_H */
