/*
 * Minimal <linux/keyboard.h> for wasm-posix-kernel.
 *
 * Linux's real header carries hundreds of keysym/keycode macros for the
 * kernel's own keymap translation tables. fbDOOM (and similar fbdev
 * software) only needs the file to *exist* — it reads from a tty in
 * MEDIUMRAW mode and decodes the bytes itself via its own scancode
 * table. So an empty stub is sufficient.
 */
#ifndef _LINUX_KEYBOARD_H
#define _LINUX_KEYBOARD_H 1

#endif /* _LINUX_KEYBOARD_H */
