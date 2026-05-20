/*
 * Minimal <linux/kd.h> for wasm-posix-kernel.
 *
 * Linux-VT framebuffer software calls KDGKBTYPE to detect the keyboard type,
 * KDSKBMODE to switch keyboard mode, and KDGETMODE/KDSETMODE to switch
 * text/graphics mode. Kandelo reports a 101-key keyboard and accepts mode
 * changes as no-op compatibility requests.
 *
 * Any change here is part of the kernel ABI — bump ABI_VERSION.
 */
#ifndef _LINUX_KD_H
#define _LINUX_KD_H 1

/* KDGKBTYPE — get keyboard type. Result is a single byte. */
#define KDGKBTYPE  0x4B33
/* KDMKTONE — start a keyboard bell tone. */
#define KDMKTONE   0x4B30
/* KDGETMODE / KDSETMODE — get/set text or graphics mode. */
#define KDGETMODE  0x4B3B
#define KDSETMODE  0x4B3A
/* KDGKBMODE / KDSKBMODE — get/set keyboard mode. */
#define KDGKBMODE  0x4B44
#define KDSKBMODE  0x4B45

/* Keyboard type values (KDGKBTYPE results). */
#define KB_84      0x01
#define KB_101     0x02

/* Display mode values. */
#define KD_TEXT     0x00
#define KD_GRAPHICS 0x01

/* Keyboard mode values (KDSKBMODE arguments). */
#define K_RAW       0x00
#define K_XLATE     0x01
#define K_MEDIUMRAW 0x02
#define K_UNICODE   0x03
#define K_OFF       0x04

#endif /* _LINUX_KD_H */
