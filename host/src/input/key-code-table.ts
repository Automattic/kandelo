/**
 * `KeyboardEvent.code` → Linux `KEY_*` lookup.
 *
 * Matches the kernel-side `shared::input::KEY_*` constants (Linux UAPI
 * verbatim — same numeric space SDL2's evdev backend would consume on
 * real Linux). The W3C "UI Events KeyboardEvent code Values" spec
 * defines the `KeyboardEvent.code` strings; we map each one to its
 * Linux keycode where Linux has an equivalent.
 *
 * Returns `null` for codes we don't translate (locale-specific keys
 * Linux has no UAPI for, browser-specific extensions, etc.). userspace
 * stacks like libxkbcommon handle the locale layer.
 */

const CODE_TO_KEY: Record<string, number> = {
  // Writing-system letters: KeyA → KEY_A = 30, etc.
  KeyA: 30, KeyB: 48, KeyC: 46, KeyD: 32, KeyE: 18, KeyF: 33,
  KeyG: 34, KeyH: 35, KeyI: 23, KeyJ: 36, KeyK: 37, KeyL: 38,
  KeyM: 50, KeyN: 49, KeyO: 24, KeyP: 25, KeyQ: 16, KeyR: 19,
  KeyS: 31, KeyT: 20, KeyU: 22, KeyV: 47, KeyW: 17, KeyX: 45,
  KeyY: 21, KeyZ: 44,

  // Top-row digits: Digit1 → KEY_1 = 2, …, Digit0 → KEY_0 = 11.
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,

  // Punctuation.
  Minus: 12,
  Equal: 13,
  BracketLeft: 26,
  BracketRight: 27,
  Backslash: 43,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  Comma: 51,
  Period: 52,
  Slash: 53,

  // International (rare on US layouts; required for JIS/PT-BR/etc).
  IntlBackslash: 86,   // KEY_102ND
  IntlRo: 89,          // KEY_RO
  IntlYen: 124,        // KEY_YEN

  // Whitespace + editing.
  Enter: 28,
  Tab: 15,
  Space: 57,
  Backspace: 14,
  Escape: 1,

  // Modifiers.
  ShiftLeft: 42,
  ShiftRight: 54,
  ControlLeft: 29,
  ControlRight: 97,
  AltLeft: 56,
  AltRight: 100,
  MetaLeft: 125,
  MetaRight: 126,
  CapsLock: 58,

  // Function keys F1–F24.
  F1: 59,  F2: 60,  F3: 61,  F4: 62,  F5: 63,  F6: 64,
  F7: 65,  F8: 66,  F9: 67,  F10: 68, F11: 87, F12: 88,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188,
  F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,

  // Control pad.
  Insert: 110,
  Delete: 111,
  Home: 102,
  End: 107,
  PageUp: 104,
  PageDown: 109,
  Help: 138,

  // Arrow pad.
  ArrowUp: 103,
  ArrowDown: 108,
  ArrowLeft: 105,
  ArrowRight: 106,

  // System keys.
  PrintScreen: 99,     // KEY_SYSRQ
  ScrollLock: 70,
  Pause: 119,
  ContextMenu: 127,    // KEY_COMPOSE — the "menu" key beside RightMeta
  Power: 116,
  Sleep: 142,
  WakeUp: 143,

  // Numpad.
  NumLock: 69,
  Numpad0: 82,
  Numpad1: 79, Numpad2: 80, Numpad3: 81,
  Numpad4: 75, Numpad5: 76, Numpad6: 77,
  Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadAdd: 78,        // KEY_KPPLUS
  NumpadSubtract: 74,   // KEY_KPMINUS
  NumpadMultiply: 55,   // KEY_KPASTERISK
  NumpadDivide: 98,     // KEY_KPSLASH
  NumpadDecimal: 83,    // KEY_KPDOT
  NumpadEnter: 96,      // KEY_KPENTER
  NumpadEqual: 117,     // KEY_KPEQUAL
  NumpadComma: 121,     // KEY_KPCOMMA

  // IME / CJK input.
  Convert: 92,             // KEY_HENKAN
  NonConvert: 94,          // KEY_MUHENKAN
  KanaMode: 93,            // KEY_KATAKANAHIRAGANA
  Lang1: 122,              // KEY_HANGEUL — Korean Hangul/English toggle
  Lang2: 123,              // KEY_HANJA   — Korean Hanja conversion
  Lang3: 90,               // KEY_KATAKANA
  Lang4: 91,               // KEY_HIRAGANA

  // Audio / media.
  AudioVolumeMute: 113,    // KEY_MUTE
  AudioVolumeDown: 114,    // KEY_VOLUMEDOWN
  AudioVolumeUp: 115,      // KEY_VOLUMEUP
  MediaPlayPause: 164,
  MediaStop: 166,          // KEY_STOPCD
  MediaTrackNext: 163,     // KEY_NEXTSONG
  MediaTrackPrevious: 165, // KEY_PREVIOUSSONG
  Eject: 161,              // KEY_EJECTCD

  // Browser-style hotkeys (Linux UAPI subset).
  BrowserRefresh: 173,
  BrowserStop: 128,        // KEY_STOP
  LaunchApp2: 140,         // KEY_CALC

  // Editing hotkeys (mostly Sun-keyboard heritage; libinput still emits).
  Cut: 137,
  Copy: 133,
  Paste: 135,
  Undo: 131,
  Again: 129,
  Find: 136,
  Open: 134,
  Props: 130,
};

/** Translate a `KeyboardEvent.code` string to its Linux `KEY_*` value.
 * Returns `null` for codes we don't translate (locale-specific keys
 * outside Linux UAPI, browser-specific extensions). */
export function codeToKey(code: string): number | null {
  const k = CODE_TO_KEY[code];
  return k === undefined ? null : k;
}
