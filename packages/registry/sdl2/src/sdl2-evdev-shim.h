/*
 * sdl2-evdev-shim.h — additional <linux/input-event-codes.h> constants
 * needed by SDL2's evdev backend (src/core/linux/SDL_evdev*.c +
 * SDL_evdev_capabilities.h).
 *
 * Force-included on every SDL2 translation unit via the build script's
 * `-include` flag. Every define is guarded with `#ifndef`, so if a future
 * kandelo sysroot rebuild extends `libc/musl-overlay/include/linux/
 * input-event-codes.h` to cover these upstream Linux UAPI codes
 * verbatim, this file becomes a no-op and can be deleted.
 *
 * Values mirror the upstream linux/input-event-codes.h numeric space
 * — SDL2 uses them purely as opaque match-codes against events that
 * read() returns from /dev/input/event*. The kernel-side
 * `crates/shared/src/input.rs` synthesises events using the same
 * numeric space (when it has a translation; codes it doesn't recognise
 * are passed through untouched).
 */
#ifndef KANDELO_SDL2_EVDEV_SHIM_H
#define KANDELO_SDL2_EVDEV_SHIM_H 1

/* --- Event-type / category MAX values (bitset-size sentinels) -------- */

#ifndef EV_MAX
#define EV_MAX  0x1f
#endif
#ifndef KEY_MAX
#define KEY_MAX 0x2ff
#endif
#ifndef REL_MAX
#define REL_MAX 0x0f
#endif
#ifndef ABS_MAX
#define ABS_MAX 0x3f
#endif

/* --- MSC codes (struct input_event.code when type == EV_MSC) --------- */

#ifndef MSC_TIMESTAMP
#define MSC_TIMESTAMP 0x05
#endif

/* --- Extra KEY_* codes SDL2 polls for media/system keys -------------- */

#ifndef KEY_OK
#define KEY_OK         0x160
#endif
#ifndef KEY_RECORD
#define KEY_RECORD     0xa7   /* 167 */
#endif
#ifndef KEY_ALS_TOGGLE
#define KEY_ALS_TOGGLE 0x230
#endif

/* --- Extra REL_* codes (high-res wheel) ------------------------------ */

#ifndef REL_WHEEL_HI_RES
#define REL_WHEEL_HI_RES  0x0b
#endif
#ifndef REL_HWHEEL_HI_RES
#define REL_HWHEEL_HI_RES 0x0c
#endif

/* --- Extra ABS_* axes (joystick/gamepad axes + multi-touch) ---------- */

#ifndef ABS_Z
#define ABS_Z        0x02
#endif
#ifndef ABS_RX
#define ABS_RX       0x03
#endif
#ifndef ABS_RY
#define ABS_RY       0x04
#endif
#ifndef ABS_RZ
#define ABS_RZ       0x05
#endif
#ifndef ABS_THROTTLE
#define ABS_THROTTLE 0x06
#endif
#ifndef ABS_RUDDER
#define ABS_RUDDER   0x07
#endif
#ifndef ABS_WHEEL
#define ABS_WHEEL    0x08
#endif
#ifndef ABS_GAS
#define ABS_GAS      0x09
#endif
#ifndef ABS_BRAKE
#define ABS_BRAKE    0x0a
#endif
#ifndef ABS_HAT0X
#define ABS_HAT0X    0x10
#endif
#ifndef ABS_HAT0Y
#define ABS_HAT0Y    0x11
#endif
#ifndef ABS_HAT1X
#define ABS_HAT1X    0x12
#endif
#ifndef ABS_HAT1Y
#define ABS_HAT1Y    0x13
#endif
#ifndef ABS_HAT2X
#define ABS_HAT2X    0x14
#endif
#ifndef ABS_HAT2Y
#define ABS_HAT2Y    0x15
#endif
#ifndef ABS_HAT3X
#define ABS_HAT3X    0x16
#endif
#ifndef ABS_HAT3Y
#define ABS_HAT3Y    0x17
#endif
#ifndef ABS_CNT
#define ABS_CNT      (ABS_MAX + 1)
#endif

/* --- Multi-touch axes ------------------------------------------------ */

#ifndef ABS_MT_SLOT
#define ABS_MT_SLOT          0x2f
#endif
#ifndef ABS_MT_POSITION_X
#define ABS_MT_POSITION_X    0x35
#endif
#ifndef ABS_MT_POSITION_Y
#define ABS_MT_POSITION_Y    0x36
#endif
#ifndef ABS_MT_TRACKING_ID
#define ABS_MT_TRACKING_ID   0x39
#endif
#ifndef ABS_MT_PRESSURE
#define ABS_MT_PRESSURE      0x3a
#endif

/* --- BTN_* codes (button class — reuse EV_KEY event type) ------------ */

#ifndef BTN_MISC
#define BTN_MISC     0x100
#endif
#ifndef BTN_0
#define BTN_0        0x100
#endif
#ifndef BTN_1
#define BTN_1        0x101
#endif
#ifndef BTN_MOUSE
#define BTN_MOUSE    0x110
#endif
#ifndef BTN_FORWARD
#define BTN_FORWARD  0x115
#endif
#ifndef BTN_BACK
#define BTN_BACK     0x116
#endif
#ifndef BTN_TASK
#define BTN_TASK     0x117
#endif

#ifndef BTN_JOYSTICK
#define BTN_JOYSTICK 0x120
#endif
#ifndef BTN_TRIGGER
#define BTN_TRIGGER  0x120
#endif
#ifndef BTN_THUMB
#define BTN_THUMB    0x121
#endif

#ifndef BTN_GAMEPAD
#define BTN_GAMEPAD  0x130
#endif
#ifndef BTN_A
#define BTN_A        0x130
#endif
#ifndef BTN_B
#define BTN_B        0x131
#endif
#ifndef BTN_X
#define BTN_X        0x133
#endif
#ifndef BTN_Y
#define BTN_Y        0x134
#endif
#ifndef BTN_NORTH
#define BTN_NORTH    BTN_X
#endif
#ifndef BTN_WEST
#define BTN_WEST     BTN_Y
#endif
#ifndef BTN_TL
#define BTN_TL       0x136
#endif
#ifndef BTN_TR
#define BTN_TR       0x137
#endif
#ifndef BTN_TL2
#define BTN_TL2      0x138
#endif
#ifndef BTN_TR2
#define BTN_TR2      0x139
#endif
#ifndef BTN_SELECT
#define BTN_SELECT   0x13a
#endif
#ifndef BTN_START
#define BTN_START    0x13b
#endif
#ifndef BTN_MODE
#define BTN_MODE     0x13c
#endif
#ifndef BTN_THUMBL
#define BTN_THUMBL   0x13d
#endif
#ifndef BTN_THUMBR
#define BTN_THUMBR   0x13e
#endif

#ifndef BTN_TOOL_PEN
#define BTN_TOOL_PEN     0x140
#endif
#ifndef BTN_TOOL_FINGER
#define BTN_TOOL_FINGER  0x145
#endif
#ifndef BTN_TOUCH
#define BTN_TOUCH        0x14a
#endif
#ifndef BTN_STYLUS
#define BTN_STYLUS       0x14b
#endif

#ifndef BTN_DPAD_UP
#define BTN_DPAD_UP    0x220
#endif
#ifndef BTN_DPAD_DOWN
#define BTN_DPAD_DOWN  0x221
#endif
#ifndef BTN_DPAD_LEFT
#define BTN_DPAD_LEFT  0x222
#endif
#ifndef BTN_DPAD_RIGHT
#define BTN_DPAD_RIGHT 0x223
#endif

#ifndef BTN_TRIGGER_HAPPY
#define BTN_TRIGGER_HAPPY   0x2c0
#endif
#ifndef BTN_TRIGGER_HAPPY1
#define BTN_TRIGGER_HAPPY1  0x2c0
#endif
#ifndef BTN_TRIGGER_HAPPY2
#define BTN_TRIGGER_HAPPY2  0x2c1
#endif
#ifndef BTN_TRIGGER_HAPPY3
#define BTN_TRIGGER_HAPPY3  0x2c2
#endif
#ifndef BTN_TRIGGER_HAPPY4
#define BTN_TRIGGER_HAPPY4  0x2c3
#endif
#ifndef BTN_TRIGGER_HAPPY5
#define BTN_TRIGGER_HAPPY5  0x2c4
#endif
#ifndef BTN_TRIGGER_HAPPY6
#define BTN_TRIGGER_HAPPY6  0x2c5
#endif
#ifndef BTN_TRIGGER_HAPPY7
#define BTN_TRIGGER_HAPPY7  0x2c6
#endif
#ifndef BTN_TRIGGER_HAPPY8
#define BTN_TRIGGER_HAPPY8  0x2c7
#endif
#ifndef BTN_TRIGGER_HAPPY9
#define BTN_TRIGGER_HAPPY9  0x2c8
#endif
#ifndef BTN_TRIGGER_HAPPY10
#define BTN_TRIGGER_HAPPY10 0x2c9
#endif
#ifndef BTN_TRIGGER_HAPPY11
#define BTN_TRIGGER_HAPPY11 0x2ca
#endif
#ifndef BTN_TRIGGER_HAPPY12
#define BTN_TRIGGER_HAPPY12 0x2cb
#endif
#ifndef BTN_TRIGGER_HAPPY13
#define BTN_TRIGGER_HAPPY13 0x2cc
#endif
#ifndef BTN_TRIGGER_HAPPY14
#define BTN_TRIGGER_HAPPY14 0x2cd
#endif
#ifndef BTN_TRIGGER_HAPPY15
#define BTN_TRIGGER_HAPPY15 0x2ce
#endif
#ifndef BTN_TRIGGER_HAPPY16
#define BTN_TRIGGER_HAPPY16 0x2cf
#endif
#ifndef BTN_TRIGGER_HAPPY17
#define BTN_TRIGGER_HAPPY17 0x2d0
#endif
#ifndef BTN_TRIGGER_HAPPY18
#define BTN_TRIGGER_HAPPY18 0x2d1
#endif
#ifndef BTN_TRIGGER_HAPPY19
#define BTN_TRIGGER_HAPPY19 0x2d2
#endif
#ifndef BTN_TRIGGER_HAPPY20
#define BTN_TRIGGER_HAPPY20 0x2d3
#endif
#ifndef BTN_TRIGGER_HAPPY21
#define BTN_TRIGGER_HAPPY21 0x2d4
#endif
#ifndef BTN_TRIGGER_HAPPY22
#define BTN_TRIGGER_HAPPY22 0x2d5
#endif
#ifndef BTN_TRIGGER_HAPPY23
#define BTN_TRIGGER_HAPPY23 0x2d6
#endif
#ifndef BTN_TRIGGER_HAPPY24
#define BTN_TRIGGER_HAPPY24 0x2d7
#endif
#ifndef BTN_TRIGGER_HAPPY25
#define BTN_TRIGGER_HAPPY25 0x2d8
#endif
#ifndef BTN_TRIGGER_HAPPY26
#define BTN_TRIGGER_HAPPY26 0x2d9
#endif
#ifndef BTN_TRIGGER_HAPPY27
#define BTN_TRIGGER_HAPPY27 0x2da
#endif
#ifndef BTN_TRIGGER_HAPPY28
#define BTN_TRIGGER_HAPPY28 0x2db
#endif
#ifndef BTN_TRIGGER_HAPPY29
#define BTN_TRIGGER_HAPPY29 0x2dc
#endif
#ifndef BTN_TRIGGER_HAPPY30
#define BTN_TRIGGER_HAPPY30 0x2dd
#endif
#ifndef BTN_TRIGGER_HAPPY31
#define BTN_TRIGGER_HAPPY31 0x2de
#endif
#ifndef BTN_TRIGGER_HAPPY32
#define BTN_TRIGGER_HAPPY32 0x2df
#endif
#ifndef BTN_TRIGGER_HAPPY33
#define BTN_TRIGGER_HAPPY33 0x2e0
#endif
#ifndef BTN_TRIGGER_HAPPY34
#define BTN_TRIGGER_HAPPY34 0x2e1
#endif
#ifndef BTN_TRIGGER_HAPPY35
#define BTN_TRIGGER_HAPPY35 0x2e2
#endif
#ifndef BTN_TRIGGER_HAPPY36
#define BTN_TRIGGER_HAPPY36 0x2e3
#endif
#ifndef BTN_TRIGGER_HAPPY37
#define BTN_TRIGGER_HAPPY37 0x2e4
#endif
#ifndef BTN_TRIGGER_HAPPY38
#define BTN_TRIGGER_HAPPY38 0x2e5
#endif
#ifndef BTN_TRIGGER_HAPPY39
#define BTN_TRIGGER_HAPPY39 0x2e6
#endif
#ifndef BTN_TRIGGER_HAPPY40
#define BTN_TRIGGER_HAPPY40 0x2e7
#endif

/* --- Force-feedback (joystick rumble) — disabled by --disable-joystick
 *     but the FF_* identifiers are referenced by capability bitset
 *     macros even when joystick is off. */

#ifndef EV_FF
#define EV_FF 0x15
#endif
#ifndef EV_LED
#define EV_LED 0x11
#endif
#ifndef EV_SND
#define EV_SND 0x12
#endif
#ifndef EV_SW
#define EV_SW 0x05
#endif

#endif /* KANDELO_SDL2_EVDEV_SHIM_H */
