/**
 * Browser-side input helpers for framebuffer demos.
 *
 * Rendering stays in `canvas-renderer.ts`; this module covers the two
 * browser-only device bridge used by fbDOOM:
 *
 *   - Pointer Lock mouse deltas -> `/dev/input/mice` PS/2 packets.
 *
 * The legacy PCM scheduler types remain exported below for source
 * compatibility. Machine-level AudioWorklet playback supersedes that
 * main-thread drain path.
 */

export interface MouseEventSink {
  /**
   * Deltas are in PS/2 convention: positive X is right, positive Y is up.
   * `buttons` uses PS/2 bits: bit0=left, bit1=right, bit2=middle.
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void;
}

export interface PointerLockMouseOptions {
  /**
   * Browser `movementX/Y` are CSS pixels, but `/dev/input/mice` consumers
   * expect mouse mickeys. The default is calibrated for fbDOOM's default
   * sensitivity: around four mickeys per framebuffer pixel makes local
   * pointer-lock motion track the screen-space motion a visible cursor would
   * have across a 90-degree Doom view.
   */
  sensitivity?: number;
  /** Convert CSS-pixel deltas into framebuffer-pixel deltas first. */
  scaleToCanvasPixels?: boolean;
  /** Automatically request pointer lock from a canvas click. */
  requestPointerLockOnClick?: boolean;
  /** Return false to suppress capture/motion while no fb client is bound. */
  getEnabled?: () => boolean;
  onCaptureChange?: (captured: boolean) => void;
}

export interface PointerLockMouseHandle {
  requestCapture(): void;
  releaseCapture(): void;
  releaseButtons(): void;
  isCaptured(): boolean;
  close(): void;
}

export interface KeyboardInputSink {
  /** Send raw Linux MEDIUMRAW keyboard bytes to the focused framebuffer process. */
  sendInput(bytes: Uint8Array): void;
}

export interface LinuxMediumRawKeyboardOptions {
  /** Return false to leave browser handling alone while no fb client is bound. */
  getEnabled?: () => boolean;
  /**
   * Reserved host-side escape from keyboard capture. Defaults to
   * Ctrl+Shift+Esc; all other focused key events stay in the framebuffer path.
   * Set to null to disable the reserved combo.
   */
  isReleaseCaptureEvent?: ((event: KeyboardEvent) => boolean) | null;
  /** Called after the helper has released held guest keys for the escape combo. */
  onReleaseCapture?: () => void;
  /**
   * Delay key releases by a frame. Some framebuffer clients poll input once
   * per tic and can otherwise miss very short press/release pairs.
   */
  releaseDelayMs?: number;
}

export interface LinuxMediumRawKeyboardHandle {
  /** Release every key the helper still believes is down. */
  releaseKeys(): void;
  close(): void;
}

export interface ScalePointerLockMouseDeltaOptions {
  sensitivity?: number;
  scaleToCanvasPixels?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
}

/** @deprecated Use the machine-level shared PCM transport. */
export interface AudioDrainSource {
  drainAudio(maxBytes: number): Promise<{
    bytes: Uint8Array;
    sampleRate: number;
    channels: number;
  }>;
}

/** @deprecated The main-thread PCM scheduler has been retired. */
export interface PcmAudioSchedulerOptions {
  pollMs?: number;
  drainBytes?: number;
  lookaheadSeconds?: number;
  maxLookaheadSeconds?: number;
}

/** @deprecated Use the machine-level browser PCM driver lifecycle. */
export interface AudioOutputHandle {
  resume(): Promise<void>;
  close(): void;
  getState(): AudioContextState | "unavailable";
}

export const DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY = 4;

const MIN_MOUSE_DELTA = -128;
const MAX_MOUSE_DELTA = 127;

/**
 * DOM KeyboardEvent.code -> Linux input keycode.
 *
 * These are the KEY_* values from <linux/input-event-codes.h>, encoded below
 * as Linux MEDIUMRAW bytes. Keep letters as letters: WASD must reach the
 * guest as KEY_W/A/S/D so save names, cheats, and in-game bindings work.
 */
const LINUX_KEYCODE_BY_DOM_CODE: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  Lang5: 85,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  IntlRo: 89,
  Lang3: 90,
  Lang4: 91,
  Convert: 92,
  KanaMode: 93,
  NonConvert: 94,
  NumpadEnter: 96,
  ControlRight: 97,
  NumpadDivide: 98,
  PrintScreen: 99,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  AudioVolumeMute: 113,
  AudioVolumeDown: 114,
  AudioVolumeUp: 115,
  Power: 116,
  NumpadEqual: 117,
  Pause: 119,
  NumpadComma: 121,
  Lang1: 122,
  Lang2: 123,
  IntlYen: 124,
  MetaLeft: 125,
  MetaRight: 126,
  ContextMenu: 127,
};

const LINUX_KEYCODE_BY_KEY_VALUE: Readonly<Record<string, number>> = {
  Escape: 1,
  Esc: 1,
  "1": 2,
  "!": 2,
  "2": 3,
  "@": 3,
  "3": 4,
  "#": 4,
  "4": 5,
  "$": 5,
  "5": 6,
  "%": 6,
  "6": 7,
  "^": 7,
  "7": 8,
  "&": 8,
  "8": 9,
  "*": 9,
  "9": 10,
  "(": 10,
  "0": 11,
  ")": 11,
  "-": 12,
  "_": 12,
  "=": 13,
  "+": 13,
  Backspace: 14,
  Tab: 15,
  q: 16,
  Q: 16,
  w: 17,
  W: 17,
  e: 18,
  E: 18,
  r: 19,
  R: 19,
  t: 20,
  T: 20,
  y: 21,
  Y: 21,
  u: 22,
  U: 22,
  i: 23,
  I: 23,
  o: 24,
  O: 24,
  p: 25,
  P: 25,
  "[": 26,
  "{": 26,
  "]": 27,
  "}": 27,
  Enter: 28,
  Control: 29,
  a: 30,
  A: 30,
  s: 31,
  S: 31,
  d: 32,
  D: 32,
  f: 33,
  F: 33,
  g: 34,
  G: 34,
  h: 35,
  H: 35,
  j: 36,
  J: 36,
  k: 37,
  K: 37,
  l: 38,
  L: 38,
  ";": 39,
  ":": 39,
  "'": 40,
  "\"": 40,
  "`": 41,
  "~": 41,
  Shift: 42,
  "\\": 43,
  "|": 43,
  z: 44,
  Z: 44,
  x: 45,
  X: 45,
  c: 46,
  C: 46,
  v: 47,
  V: 47,
  b: 48,
  B: 48,
  n: 49,
  N: 49,
  m: 50,
  M: 50,
  ",": 51,
  "<": 51,
  ".": 52,
  ">": 52,
  "/": 53,
  "?": 53,
  Alt: 56,
  " ": 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  ZenkakuHankaku: 85,
  F11: 87,
  F12: 88,
  Katakana: 90,
  Hiragana: 91,
  Convert: 92,
  KanaMode: 93,
  NonConvert: 94,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  AudioVolumeMute: 113,
  AudioVolumeDown: 114,
  AudioVolumeUp: 115,
  Power: 116,
  Pause: 119,
  HangulMode: 122,
  HanjaMode: 123,
  Meta: 125,
  OS: 125,
  ContextMenu: 127,
};

export function linuxKeyCodeFromKeyboardEvent(
  event: Pick<KeyboardEvent, "code" | "key">,
): number | null {
  const byCode = LINUX_KEYCODE_BY_DOM_CODE[event.code];
  if (byCode !== undefined) return byCode;
  const byKey = LINUX_KEYCODE_BY_KEY_VALUE[event.key];
  return byKey ?? null;
}

export function encodeLinuxMediumRawKeyCode(
  keyCode: number,
  pressed: boolean,
): Uint8Array | null {
  // The one-byte MEDIUMRAW form uses bit 7 as release state, so the keycode
  // payload must fit in the low seven bits. The browser-facing map above only
  // includes that range.
  if (!Number.isInteger(keyCode) || keyCode <= 0 || keyCode > 0x7f) return null;
  return new Uint8Array([pressed ? keyCode & 0x7f : keyCode | 0x80]);
}

export function encodeKeyboardEventAsLinuxMediumRaw(
  event: Pick<KeyboardEvent, "code" | "key">,
  pressed: boolean,
): Uint8Array | null {
  const keyCode = linuxKeyCodeFromKeyboardEvent(event);
  return keyCode === null ? null : encodeLinuxMediumRawKeyCode(keyCode, pressed);
}

export function attachLinuxMediumRawKeyboard(
  target: HTMLElement,
  sink: KeyboardInputSink,
  opts: LinuxMediumRawKeyboardOptions = {},
): LinuxMediumRawKeyboardHandle {
  const getEnabled = opts.getEnabled ?? (() => true);
  const releaseDelayMs = opts.releaseDelayMs ?? 0;
  const isReleaseCaptureEvent =
    opts.isReleaseCaptureEvent === undefined
      ? isCtrlShiftEscape
      : opts.isReleaseCaptureEvent;
  const held = new Map<string, number>();
  const releaseTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();

  const eventId = (e: KeyboardEvent) => e.code || `key:${e.key}`;

  const emit = (keyCode: number, pressed: boolean) => {
    if (!getEnabled()) return;
    const bytes = encodeLinuxMediumRawKeyCode(keyCode, pressed);
    if (bytes) sink.sendInput(bytes);
  };

  const scheduleRelease = (keyCode: number) => {
    if (releaseDelayMs <= 0) {
      emit(keyCode, false);
      return;
    }
    const timer = globalThis.setTimeout(() => {
      releaseTimers.delete(timer);
      emit(keyCode, false);
    }, releaseDelayMs);
    releaseTimers.add(timer);
  };

  const releaseKeys = () => {
    for (const timer of releaseTimers) globalThis.clearTimeout(timer);
    releaseTimers.clear();
    for (const keyCode of held.values()) emit(keyCode, false);
    held.clear();
  };

  const handleEvent = (e: KeyboardEvent) => {
    if (!getEnabled()) return null;
    e.preventDefault();
    e.stopPropagation();
    const keyCode = linuxKeyCodeFromKeyboardEvent(e);
    return keyCode;
  };

  const onDown = (e: KeyboardEvent) => {
    if (isReleaseCaptureEvent?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      releaseKeys();
      opts.onReleaseCapture?.();
      return;
    }
    const keyCode = handleEvent(e);
    if (keyCode === null) return;
    const id = eventId(e);
    if (held.has(id)) return;
    held.set(id, keyCode);
    emit(keyCode, true);
  };

  const onUp = (e: KeyboardEvent) => {
    const keyCode = handleEvent(e);
    if (keyCode === null) return;
    held.delete(eventId(e));
    scheduleRelease(keyCode);
  };

  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  target.addEventListener("blur", releaseKeys);

  return {
    releaseKeys,
    close: () => {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      target.removeEventListener("blur", releaseKeys);
      releaseKeys();
    },
  };
}

export function scalePointerLockMouseDelta(
  movementX: number,
  movementY: number,
  opts: ScalePointerLockMouseDeltaOptions = {},
): { dx: number; dy: number } {
  const sensitivity = opts.sensitivity ?? DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY;
  const scaleToCanvasPixels = opts.scaleToCanvasPixels ?? true;
  const scaleX = scaleToCanvasPixels && opts.canvasWidth && opts.clientWidth
    ? opts.canvasWidth / opts.clientWidth
    : 1;
  const scaleY = scaleToCanvasPixels && opts.canvasHeight && opts.clientHeight
    ? opts.canvasHeight / opts.clientHeight
    : 1;

  return {
    dx: movementX * scaleX * sensitivity,
    // Browser coordinates are positive-down; PS/2 is positive-up.
    dy: -movementY * scaleY * sensitivity,
  };
}

export function injectChunkedMouseMotion(
  sink: MouseEventSink,
  dx: number,
  dy: number,
  buttons: number,
): void {
  let remainingX = finiteTrunc(dx);
  let remainingY = finiteTrunc(dy);

  while (remainingX !== 0 || remainingY !== 0) {
    const stepX = clamp(remainingX, MIN_MOUSE_DELTA, MAX_MOUSE_DELTA);
    const stepY = clamp(remainingY, MIN_MOUSE_DELTA, MAX_MOUSE_DELTA);
    sink.injectMouseEvent(stepX, stepY, buttons & 0x07);
    remainingX -= stepX;
    remainingY -= stepY;
  }
}

export function attachPointerLockMouse(
  canvas: HTMLCanvasElement,
  sink: MouseEventSink,
  opts: PointerLockMouseOptions = {},
): PointerLockMouseHandle {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const requestPointerLockOnClick = opts.requestPointerLockOnClick ?? true;
  const getEnabled = opts.getEnabled ?? (() => true);
  let closed = false;
  let buttons = 0;
  let fractionalX = 0;
  let fractionalY = 0;

  const buttonBit = (button: number) =>
    button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;

  const captured = () => doc.pointerLockElement === canvas;

  const notifyCapture = () => {
    opts.onCaptureChange?.(captured());
  };

  const requestCapture = () => {
    if (closed || !getEnabled()) return;
    canvas.focus();
    if (!captured()) {
      canvas.requestPointerLock();
    }
  };

  const releaseButtons = () => {
    if (buttons === 0) return;
    buttons = 0;
    sink.injectMouseEvent(0, 0, 0);
  };

  const releaseCapture = () => {
    releaseButtons();
    if (captured()) {
      doc.exitPointerLock();
    }
  };

  const onClick = () => {
    if (requestPointerLockOnClick) requestCapture();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!captured() || !getEnabled()) return;
    const rect = canvas.getBoundingClientRect();
    const scaled = scalePointerLockMouseDelta(e.movementX, e.movementY, {
      sensitivity: opts.sensitivity,
      scaleToCanvasPixels: opts.scaleToCanvasPixels,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      clientWidth: rect.width,
      clientHeight: rect.height,
    });

    fractionalX += scaled.dx;
    fractionalY += scaled.dy;
    const dx = finiteTrunc(fractionalX);
    const dy = finiteTrunc(fractionalY);
    fractionalX -= dx;
    fractionalY -= dy;
    if (dx === 0 && dy === 0) return;
    injectChunkedMouseMotion(sink, dx, dy, buttons);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!captured() || !getEnabled()) return;
    const bit = buttonBit(e.button);
    if (bit === 0) return;
    e.preventDefault();
    buttons |= bit;
    sink.injectMouseEvent(0, 0, buttons);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!captured() && buttons === 0) return;
    const bit = buttonBit(e.button);
    if (bit === 0) return;
    e.preventDefault();
    buttons &= ~bit;
    sink.injectMouseEvent(0, 0, buttons);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  const onPointerLockChange = () => {
    if (!captured()) {
      releaseButtons();
      fractionalX = 0;
      fractionalY = 0;
    }
    notifyCapture();
  };

  const onWindowBlur = () => {
    releaseCapture();
  };

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("contextmenu", onContextMenu);
  doc.addEventListener("mouseup", onMouseUp);
  doc.addEventListener("pointerlockchange", onPointerLockChange);
  win?.addEventListener("blur", onWindowBlur);
  notifyCapture();

  return {
    requestCapture,
    releaseCapture,
    releaseButtons,
    isCaptured: captured,
    close: () => {
      if (closed) return;
      closed = true;
      releaseCapture();
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("contextmenu", onContextMenu);
      doc.removeEventListener("mouseup", onMouseUp);
      doc.removeEventListener("pointerlockchange", onPointerLockChange);
      win?.removeEventListener("blur", onWindowBlur);
      opts.onCaptureChange?.(false);
    },
  };
}

/**
 * Retained only so existing imports fail truthfully at runtime instead of
 * silently reviving the retired timer-driven drain path.
 *
 * @deprecated Browser PCM playback now belongs to the machine-level
 * AudioWorklet transport. Use `BrowserKernel.resumeAudio()` (or the matching
 * `KernelHost` method) from a trusted user gesture.
 */
export function createPcmAudioScheduler(
  source: AudioDrainSource,
  opts: PcmAudioSchedulerOptions = {},
): AudioOutputHandle {
  void source;
  void opts;
  return {
    resume: async () => {
      throw new Error(
        "createPcmAudioScheduler is unavailable; use the machine-level AudioWorklet PCM driver",
      );
    },
    close: () => {},
    getState: () => "unavailable",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteTrunc(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isCtrlShiftEscape(e: KeyboardEvent): boolean {
  return e.ctrlKey && e.shiftKey && e.code === "Escape";
}
