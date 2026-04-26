/*
 * Minimal <linux/kd.h> for wasm-posix-kernel.
 *
 * fbDOOM (and similar Linux-VT software) calls KDGKBTYPE to detect the
 * keyboard type, then KDSKBMODE to switch into raw scancode mode. Our
 * kernel reports a 101-key keyboard and accepts any KDSKBMODE value
 * (no-op success) — the input pipeline delivers AT scancodes via stdin
 * regardless of the requested mode.
 *
 * Any change here is part of the kernel ABI — bump ABI_VERSION.
 */
#ifndef _LINUX_KD_H
#define _LINUX_KD_H 1

/* KDGKBTYPE — get keyboard type. Result is a single byte. */
#define KDGKBTYPE  0x4B33
/* KDGKBMODE / KDSKBMODE — get/set keyboard mode. */
#define KDGKBMODE  0x4B44
#define KDSKBMODE  0x4B45

/* Keyboard type values (KDGKBTYPE results). */
#define KB_84      0x01
#define KB_101     0x02

/* Keyboard mode values (KDSKBMODE arguments). */
#define K_RAW       0x00
#define K_XLATE     0x01
#define K_MEDIUMRAW 0x02
#define K_UNICODE   0x03
#define K_OFF       0x04

#endif /* _LINUX_KD_H */
