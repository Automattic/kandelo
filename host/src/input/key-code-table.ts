/**
 * `KeyboardEvent.code` → Linux `KEY_*` lookup.
 *
 * The W3C "UI Events KeyboardEvent code Values" spec defines the
 * `KeyboardEvent.code` strings; this table maps each one to the *name*
 * of its Linux keycode where Linux has an equivalent. The numeric value
 * of each `KEY_*` comes from the generated ABI (`INPUT_CODES`, sourced
 * from `shared::input`), so this file never hard-codes a keycode number:
 * a renumber in the kernel flows through automatically and cannot leave
 * the translator emitting a stale value.
 *
 * Returns `null` for codes we don't translate (locale-specific keys
 * Linux has no UAPI for, browser-specific extensions, etc.). userspace
 * stacks like libxkbcommon handle the locale layer.
 */
import { INPUT_CODES } from "../generated/abi.js";

/** `KeyboardEvent.code` → `shared::input` `KEY_*` name. */
const CODE_TO_KEY_NAME: Record<string, keyof typeof INPUT_CODES> = {
  // Writing-system letters: KeyA → KEY_A, etc.
  KeyA: "KEY_A", KeyB: "KEY_B", KeyC: "KEY_C", KeyD: "KEY_D", KeyE: "KEY_E",
  KeyF: "KEY_F", KeyG: "KEY_G", KeyH: "KEY_H", KeyI: "KEY_I", KeyJ: "KEY_J",
  KeyK: "KEY_K", KeyL: "KEY_L", KeyM: "KEY_M", KeyN: "KEY_N", KeyO: "KEY_O",
  KeyP: "KEY_P", KeyQ: "KEY_Q", KeyR: "KEY_R", KeyS: "KEY_S", KeyT: "KEY_T",
  KeyU: "KEY_U", KeyV: "KEY_V", KeyW: "KEY_W", KeyX: "KEY_X", KeyY: "KEY_Y",
  KeyZ: "KEY_Z",

  // Top-row digits: Digit1 → KEY_1, …, Digit0 → KEY_0.
  Digit1: "KEY_1", Digit2: "KEY_2", Digit3: "KEY_3", Digit4: "KEY_4",
  Digit5: "KEY_5", Digit6: "KEY_6", Digit7: "KEY_7", Digit8: "KEY_8",
  Digit9: "KEY_9", Digit0: "KEY_0",

  // Punctuation.
  Minus: "KEY_MINUS",
  Equal: "KEY_EQUAL",
  BracketLeft: "KEY_LEFTBRACE",
  BracketRight: "KEY_RIGHTBRACE",
  Backslash: "KEY_BACKSLASH",
  Semicolon: "KEY_SEMICOLON",
  Quote: "KEY_APOSTROPHE",
  Backquote: "KEY_GRAVE",
  Comma: "KEY_COMMA",
  Period: "KEY_DOT",
  Slash: "KEY_SLASH",

  // International (rare on US layouts; required for JIS/PT-BR/etc).
  IntlBackslash: "KEY_102ND",
  IntlRo: "KEY_RO",
  IntlYen: "KEY_YEN",

  // Whitespace + editing.
  Enter: "KEY_ENTER",
  Tab: "KEY_TAB",
  Space: "KEY_SPACE",
  Backspace: "KEY_BACKSPACE",
  Escape: "KEY_ESC",

  // Modifiers.
  ShiftLeft: "KEY_LEFTSHIFT",
  ShiftRight: "KEY_RIGHTSHIFT",
  ControlLeft: "KEY_LEFTCTRL",
  ControlRight: "KEY_RIGHTCTRL",
  AltLeft: "KEY_LEFTALT",
  AltRight: "KEY_RIGHTALT",
  MetaLeft: "KEY_LEFTMETA",
  MetaRight: "KEY_RIGHTMETA",
  CapsLock: "KEY_CAPSLOCK",

  // Function keys F1–F24.
  F1: "KEY_F1", F2: "KEY_F2", F3: "KEY_F3", F4: "KEY_F4", F5: "KEY_F5",
  F6: "KEY_F6", F7: "KEY_F7", F8: "KEY_F8", F9: "KEY_F9", F10: "KEY_F10",
  F11: "KEY_F11", F12: "KEY_F12", F13: "KEY_F13", F14: "KEY_F14",
  F15: "KEY_F15", F16: "KEY_F16", F17: "KEY_F17", F18: "KEY_F18",
  F19: "KEY_F19", F20: "KEY_F20", F21: "KEY_F21", F22: "KEY_F22",
  F23: "KEY_F23", F24: "KEY_F24",

  // Control pad.
  Insert: "KEY_INSERT",
  Delete: "KEY_DELETE",
  Home: "KEY_HOME",
  End: "KEY_END",
  PageUp: "KEY_PAGEUP",
  PageDown: "KEY_PAGEDOWN",
  Help: "KEY_HELP",

  // Arrow pad.
  ArrowUp: "KEY_UP",
  ArrowDown: "KEY_DOWN",
  ArrowLeft: "KEY_LEFT",
  ArrowRight: "KEY_RIGHT",

  // System keys.
  PrintScreen: "KEY_SYSRQ",
  ScrollLock: "KEY_SCROLLLOCK",
  Pause: "KEY_PAUSE",
  ContextMenu: "KEY_COMPOSE", // the "menu" key beside RightMeta
  Power: "KEY_POWER",
  Sleep: "KEY_SLEEP",
  WakeUp: "KEY_WAKEUP",

  // Numpad.
  NumLock: "KEY_NUMLOCK",
  Numpad0: "KEY_KP0",
  Numpad1: "KEY_KP1", Numpad2: "KEY_KP2", Numpad3: "KEY_KP3",
  Numpad4: "KEY_KP4", Numpad5: "KEY_KP5", Numpad6: "KEY_KP6",
  Numpad7: "KEY_KP7", Numpad8: "KEY_KP8", Numpad9: "KEY_KP9",
  NumpadAdd: "KEY_KPPLUS",
  NumpadSubtract: "KEY_KPMINUS",
  NumpadMultiply: "KEY_KPASTERISK",
  NumpadDivide: "KEY_KPSLASH",
  NumpadDecimal: "KEY_KPDOT",
  NumpadEnter: "KEY_KPENTER",
  NumpadEqual: "KEY_KPEQUAL",
  NumpadComma: "KEY_KPCOMMA",

  // IME / CJK input.
  Convert: "KEY_HENKAN",
  NonConvert: "KEY_MUHENKAN",
  KanaMode: "KEY_KATAKANAHIRAGANA",
  Lang1: "KEY_HANGEUL", // Korean Hangul/English toggle
  Lang2: "KEY_HANJA", // Korean Hanja conversion
  Lang3: "KEY_KATAKANA",
  Lang4: "KEY_HIRAGANA",

  // Audio / media.
  AudioVolumeMute: "KEY_MUTE",
  AudioVolumeDown: "KEY_VOLUMEDOWN",
  AudioVolumeUp: "KEY_VOLUMEUP",
  MediaPlayPause: "KEY_PLAYPAUSE",
  MediaStop: "KEY_STOPCD",
  MediaTrackNext: "KEY_NEXTSONG",
  MediaTrackPrevious: "KEY_PREVIOUSSONG",
  Eject: "KEY_EJECTCD",

  // Browser-style hotkeys (Linux UAPI subset).
  BrowserRefresh: "KEY_REFRESH",
  BrowserStop: "KEY_STOP",
  LaunchApp2: "KEY_CALC",

  // Editing hotkeys (mostly Sun-keyboard heritage; libinput still emits).
  Cut: "KEY_CUT",
  Copy: "KEY_COPY",
  Paste: "KEY_PASTE",
  Undo: "KEY_UNDO",
  Again: "KEY_AGAIN",
  Find: "KEY_FIND",
  Open: "KEY_OPEN",
  Props: "KEY_PROPS",
};

/** Translate a `KeyboardEvent.code` string to its Linux `KEY_*` value.
 * Returns `null` for codes we don't translate (locale-specific keys
 * outside Linux UAPI, browser-specific extensions). */
export function codeToKey(code: string): number | null {
  const name = CODE_TO_KEY_NAME[code];
  return name === undefined ? null : INPUT_CODES[name];
}
