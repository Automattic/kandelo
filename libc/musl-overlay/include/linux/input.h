/*
 * Kandelo <linux/input.h>. The full evdev *code* vocabulary lives in the
 * verbatim <linux/input-event-codes.h> (vendored from Linux UAPI so any
 * evdev consumer — e.g. SDL's Linux input backend — compiles). This file
 * carries the marshalled structs, the bus-type IDs, and the `EVIOC*`
 * ioctl numbers. `struct input_event` uses kandelo's wasm32-musl layout
 * (see crates/shared/src/lib.rs::input::WpkInputEvent).
 *
 * The kernel only *implements* a subset of the evdev surface at runtime
 * (keyboard + pointer, the EVIOCG* queries below); ioctls it does not
 * support return ENOTTY. Force-feedback, MT-slot, and keymap structs are
 * not marshalled here.
 *
 * Any change to the struct/ioctl marshalling here is part of the kernel
 * ABI — bump ABI_VERSION.
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

/* Bus types (struct input_id.bustype). Verbatim from <linux/input.h>;
 * kandelo's virtual devices report BUS_VIRTUAL. Upstream keeps these in
 * input.h (not input-event-codes.h), so they live here. */
#define BUS_PCI			0x01
#define BUS_ISAPNP		0x02
#define BUS_USB			0x03
#define BUS_HIL			0x04
#define BUS_BLUETOOTH		0x05
#define BUS_VIRTUAL		0x06

#define BUS_ISA			0x10
#define BUS_I8042		0x11
#define BUS_XTKBD		0x12
#define BUS_RS232		0x13
#define BUS_GAMEPORT		0x14
#define BUS_PARPORT		0x15
#define BUS_AMIGA		0x16
#define BUS_ADB			0x17
#define BUS_I2C			0x18
#define BUS_HOST		0x19
#define BUS_GSC			0x1A
#define BUS_ATARI		0x1B
#define BUS_SPI			0x1C
#define BUS_RMI			0x1D
#define BUS_CEC			0x1E
#define BUS_INTEL_ISHTP		0x1F
#define BUS_AMD_SFH		0x20

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

/* Kandelo's kernel implements these queries. */
#define EVIOCGVERSION       _IOR('E', 0x01, int)
#define EVIOCGID            _IOR('E', 0x02, struct input_id)
#define EVIOCGNAME(len)     _IOC(_IOC_READ, 'E', 0x06, len)
#define EVIOCGBIT(ev, len)  _IOC(_IOC_READ, 'E', 0x20 + (ev), len)
#define EVIOCGABS(abs)      _IOR('E', 0x40 + (abs), struct input_absinfo)

/* Defined so evdev consumers (e.g. SDL's Linux input backend) compile
 * against the full ioctl vocabulary. Values are Linux UAPI verbatim. The
 * kernel does not implement these yet and returns ENOTTY at runtime; a
 * portable consumer treats ENOTTY as "unsupported" and degrades. (The
 * keymap-v2, force-feedback, and event-mask ioctls that require extra
 * structs are omitted until they are marshalled.) */
#define EVIOCGREP           _IOR('E', 0x03, unsigned int[2])
#define EVIOCSREP           _IOW('E', 0x03, unsigned int[2])
#define EVIOCGKEYCODE       _IOR('E', 0x04, unsigned int[2])
#define EVIOCSKEYCODE       _IOW('E', 0x04, unsigned int[2])
#define EVIOCGPHYS(len)     _IOC(_IOC_READ, 'E', 0x07, len)
#define EVIOCGUNIQ(len)     _IOC(_IOC_READ, 'E', 0x08, len)
#define EVIOCGPROP(len)     _IOC(_IOC_READ, 'E', 0x09, len)
#define EVIOCGMTSLOTS(len)  _IOC(_IOC_READ, 'E', 0x0a, len)
#define EVIOCGKEY(len)      _IOC(_IOC_READ, 'E', 0x18, len)
#define EVIOCGLED(len)      _IOC(_IOC_READ, 'E', 0x19, len)
#define EVIOCGSND(len)      _IOC(_IOC_READ, 'E', 0x1a, len)
#define EVIOCGSW(len)       _IOC(_IOC_READ, 'E', 0x1b, len)
#define EVIOCSABS(abs)      _IOW('E', 0xc0 + (abs), struct input_absinfo)
#define EVIOCRMFF           _IOW('E', 0x81, int)
#define EVIOCGEFFECTS       _IOR('E', 0x84, int)
#define EVIOCGRAB           _IOW('E', 0x90, int)
#define EVIOCREVOKE         _IOW('E', 0x91, int)
#define EVIOCSCLOCKID       _IOW('E', 0xa0, int)

#endif /* _LINUX_INPUT_H */
