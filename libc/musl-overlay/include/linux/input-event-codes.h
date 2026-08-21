/*
 * Minimal <linux/input-event-codes.h> for kandelo.
 *
 * Mirrors the constant set kandelo's kernel-side `shared::input` module
 * defines in `crates/shared/src/lib.rs` — same numeric space SDL2's
 * evdev backend (and any Linux userspace) would consume on real Linux.
 * The KEY_* range covers what Chrome / Firefox / WebKit emit through
 * `KeyboardEvent.code`; values >248 (KEY_BUTTONCONFIG, KEY_VENDOR
 * range, etc.) are not browser-reachable and aren't vendored.
 *
 * Any change here is part of the kernel ABI — bump ABI_VERSION.
 */
#ifndef _LINUX_INPUT_EVENT_CODES_H
#define _LINUX_INPUT_EVENT_CODES_H 1

/* --- Event types (struct input_event.type) --------------------------- */

#define EV_SYN              0x00
#define EV_KEY              0x01
#define EV_REL              0x02
#define EV_ABS              0x03
#define EV_MSC              0x04

/* --- SYN codes (struct input_event.code when type == EV_SYN) --------- */

#define SYN_REPORT          0
#define SYN_DROPPED         3

/* --- KEY_* codes (verbatim from upstream linux/input-event-codes.h) -- */

#define KEY_RESERVED        0
#define KEY_ESC             1
#define KEY_1               2
#define KEY_2               3
#define KEY_3               4
#define KEY_4               5
#define KEY_5               6
#define KEY_6               7
#define KEY_7               8
#define KEY_8               9
#define KEY_9               10
#define KEY_0               11
#define KEY_MINUS           12
#define KEY_EQUAL           13
#define KEY_BACKSPACE       14
#define KEY_TAB             15
#define KEY_Q               16
#define KEY_W               17
#define KEY_E               18
#define KEY_R               19
#define KEY_T               20
#define KEY_Y               21
#define KEY_U               22
#define KEY_I               23
#define KEY_O               24
#define KEY_P               25
#define KEY_LEFTBRACE       26
#define KEY_RIGHTBRACE      27
#define KEY_ENTER           28
#define KEY_LEFTCTRL        29
#define KEY_A               30
#define KEY_S               31
#define KEY_D               32
#define KEY_F               33
#define KEY_G               34
#define KEY_H               35
#define KEY_J               36
#define KEY_K               37
#define KEY_L               38
#define KEY_SEMICOLON       39
#define KEY_APOSTROPHE      40
#define KEY_GRAVE           41
#define KEY_LEFTSHIFT       42
#define KEY_BACKSLASH       43
#define KEY_Z               44
#define KEY_X               45
#define KEY_C               46
#define KEY_V               47
#define KEY_B               48
#define KEY_N               49
#define KEY_M               50
#define KEY_COMMA           51
#define KEY_DOT             52
#define KEY_SLASH           53
#define KEY_RIGHTSHIFT      54
#define KEY_KPASTERISK      55
#define KEY_LEFTALT         56
#define KEY_SPACE           57
#define KEY_CAPSLOCK        58
#define KEY_F1              59
#define KEY_F2              60
#define KEY_F3              61
#define KEY_F4              62
#define KEY_F5              63
#define KEY_F6              64
#define KEY_F7              65
#define KEY_F8              66
#define KEY_F9              67
#define KEY_F10             68
#define KEY_NUMLOCK         69
#define KEY_SCROLLLOCK      70
#define KEY_KP7             71
#define KEY_KP8             72
#define KEY_KP9             73
#define KEY_KPMINUS         74
#define KEY_KP4             75
#define KEY_KP5             76
#define KEY_KP6             77
#define KEY_KPPLUS          78
#define KEY_KP1             79
#define KEY_KP2             80
#define KEY_KP3             81
#define KEY_KP0             82
#define KEY_KPDOT           83
#define KEY_ZENKAKUHANKAKU  85
#define KEY_102ND           86
#define KEY_F11             87
#define KEY_F12             88
#define KEY_RO              89
#define KEY_KATAKANA        90
#define KEY_HIRAGANA        91
#define KEY_HENKAN          92
#define KEY_KATAKANAHIRAGANA 93
#define KEY_MUHENKAN        94
#define KEY_KPJPCOMMA       95
#define KEY_KPENTER         96
#define KEY_RIGHTCTRL       97
#define KEY_KPSLASH         98
#define KEY_SYSRQ           99
#define KEY_RIGHTALT        100
#define KEY_LINEFEED        101
#define KEY_HOME            102
#define KEY_UP              103
#define KEY_PAGEUP          104
#define KEY_LEFT            105
#define KEY_RIGHT           106
#define KEY_END             107
#define KEY_DOWN            108
#define KEY_PAGEDOWN        109
#define KEY_INSERT          110
#define KEY_DELETE          111
#define KEY_MACRO           112
#define KEY_MUTE            113
#define KEY_VOLUMEDOWN      114
#define KEY_VOLUMEUP        115
#define KEY_POWER           116
#define KEY_KPEQUAL         117
#define KEY_KPPLUSMINUS     118
#define KEY_PAUSE           119
#define KEY_SCALE           120
#define KEY_KPCOMMA         121
#define KEY_HANGEUL         122
#define KEY_HANJA           123
#define KEY_YEN             124
#define KEY_LEFTMETA        125
#define KEY_RIGHTMETA       126
#define KEY_COMPOSE         127
#define KEY_STOP            128
#define KEY_AGAIN           129
#define KEY_PROPS           130
#define KEY_UNDO            131
#define KEY_FRONT           132
#define KEY_COPY            133
#define KEY_OPEN            134
#define KEY_PASTE           135
#define KEY_FIND            136
#define KEY_CUT             137
#define KEY_HELP            138
#define KEY_MENU            139
#define KEY_CALC            140
#define KEY_SLEEP           142
#define KEY_WAKEUP          143
#define KEY_EJECTCD         161
#define KEY_NEXTSONG        163
#define KEY_PLAYPAUSE       164
#define KEY_PREVIOUSSONG    165
#define KEY_STOPCD          166
#define KEY_REFRESH         173
#define KEY_F13             183
#define KEY_F14             184
#define KEY_F15             185
#define KEY_F16             186
#define KEY_F17             187
#define KEY_F18             188
#define KEY_F19             189
#define KEY_F20             190
#define KEY_F21             191
#define KEY_F22             192
#define KEY_F23             193
#define KEY_F24             194
#define KEY_PLAYCD          200
#define KEY_PAUSECD         201
#define KEY_BRIGHTNESSDOWN  224
#define KEY_BRIGHTNESSUP    225
#define KEY_MICMUTE         248

/* --- BTN_* codes (button class; reuse the EV_KEY event type) --------- */

#define BTN_LEFT            0x110
#define BTN_RIGHT           0x111
#define BTN_MIDDLE          0x112
#define BTN_SIDE            0x113
#define BTN_EXTRA           0x114

/* --- REL_* codes (relative axes; EV_REL records carry these) --------- */

#define REL_X               0x00
#define REL_Y               0x01
#define REL_HWHEEL          0x06
#define REL_WHEEL           0x08

/* --- ABS_* codes (absolute axes; EV_ABS records carry these) --------- */

#define ABS_X               0x00
#define ABS_Y               0x01

/* --- BUS_* constants (subset) ---------------------------------------- */

/* `BUS_VIRTUAL` — closest match for a kernel-synthesised device (Linux
 * uses this for `uinput`-backed devices). */
#define BUS_VIRTUAL         0x06

#endif /* _LINUX_INPUT_EVENT_CODES_H */
