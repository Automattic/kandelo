/**
 * `BrowserInputSource` — captures DOM keyboard/pointer/wheel events,
 * translates them to Linux evdev records (`KEY_*`, `BTN_*`, `REL_*`,
 * `ABS_*`) and closes each logical input with a `SYN_REPORT`. Wired
 * into `kernel.exports.kernel_input_event` by the browser host's worker
 * entry at boot (B4).
 *
 * Coordinate convention:
 *   - Pointer-lock active   → REL_X / REL_Y deltas (from movementX/Y).
 *   - Pointer-lock inactive → REL_X / REL_Y deltas derived from the
 *     change in absolute viewport position (clientX/Y minus the previous
 *     clientX/Y).
 *   Both branches emit *relative* motion because `/dev/input/event1`
 *   advertises REL_X/REL_Y: SDL2's evdev backend classifies it as a
 *   relative mouse and ignores EV_ABS entirely (see the PEG note in
 *   web-libs/kandelo-session kernel-host.ts). Emitting EV_ABS here would
 *   silently produce no motion. The device still advertises ABS_X/Y with
 *   canvas maxima for callers that read EVIOCGABS bounds, which is why the
 *   resize hook below keeps those maxima current.
 *   The absolute→delta baseline is cleared on a pointer-lock transition
 *   and when the pointer leaves the target, so re-entry never reports a
 *   phantom jump. On a lock transition we also emit a bare SYN_REPORT so
 *   SDL2 sees a re-sync point and doesn't carry a stale axis value.
 *
 * Event-type / SYN / REL / BTN codes come from the generated ABI
 * (`INPUT_CODES`), sourced from `shared::input`, so a code renumber in
 * the kernel cannot silently leave this translator emitting a stale
 * value.
 */
import type { InputSource, InputEvent } from "./input-source.js";
import { INPUT_CODES } from "../generated/abi.js";
import { charToKey, codeToKey } from "./key-code-table.js";
import type { ClipboardOfferFailure, ClipboardOfferResult } from "../clipboard.js";

const {
  EV_SYN,
  EV_KEY,
  EV_REL,
  SYN_REPORT,
  REL_X,
  REL_Y,
  REL_WHEEL,
  REL_HWHEEL,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_MIDDLE,
  KEY_LEFTCTRL,
  KEY_LEFTSHIFT,
  KEY_LEFTALT,
  KEY_LEFTMETA,
} = INPUT_CODES;

/**
 * Modifiers follow what the OS says a key IS, not where it sits. A user who
 * remaps Caps Lock to Control (macOS System Settings, or a Linux xkb option)
 * presses a key whose `code` is still "CapsLock" but which the OS reports as
 * Control — as `key: "Control"` on the key itself, or only as `ctrlKey` on the
 * keys pressed while it is held, depending on the platform and browser. The
 * guest's keymap is a fixed US layout, so the wire must carry the modifier
 * the user meant; `code` alone would send KEY_CAPSLOCK and no bind fires.
 */
type ModifierKind = "Control" | "Shift" | "Alt" | "Meta";
const MODIFIER_KINDS: readonly ModifierKind[] = ["Control", "Shift", "Alt", "Meta"];
const MODIFIER_FLAG = {
  Control: "ctrlKey",
  Shift: "shiftKey",
  Alt: "altKey",
  Meta: "metaKey",
} as const;
const MODIFIER_LEFT_KEY: Record<ModifierKind, number> = {
  Control: KEY_LEFTCTRL,
  Shift: KEY_LEFTSHIFT,
  Alt: KEY_LEFTALT,
  Meta: KEY_LEFTMETA,
};
const MODIFIER_CODES: Record<ModifierKind, readonly string[]> = {
  Control: ["ControlLeft", "ControlRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Alt: ["AltLeft", "AltRight"],
  Meta: ["MetaLeft", "MetaRight"],
};

/** Every evdev code a modifier key can arrive as, either side. */
const MODIFIER_KEY_CODES: ReadonlySet<number> = new Set(
  MODIFIER_KINDS.flatMap((kind) => [
    MODIFIER_LEFT_KEY[kind],
    ...MODIFIER_CODES[kind].map((code) => codeToKey(code) ?? MODIFIER_LEFT_KEY[kind]),
  ]),
);

/**
 * The browser's own paste chord: V with exactly one of Cmd or Ctrl (Shift
 * allowed, Alt not). Whether it really is a paste is the browser's call —
 * Ctrl+V is not one on macOS — so this only makes a keydown a candidate.
 */
function isPasteChordCandidate(e: KeyboardEvent): boolean {
  if (e.repeat || e.altKey) return false;
  // Shift+Insert: the CUA paste chord on Linux and Windows.
  if (e.key === "Insert") return e.shiftKey && !e.ctrlKey && !e.metaKey;
  return (e.key === "v" || e.key === "V") && e.metaKey !== e.ctrlKey;
}

/**
 * Chords that may make the guest copy (or cut): Cmd+C/X on macOS;
 * Ctrl+C/X, Ctrl+Shift+C (the terminal convention) and Ctrl+Insert
 * elsewhere. Arming on one that copies nothing — Ctrl+C in a terminal is
 * SIGINT — is harmless: the guest reports no new selection, and the host
 * clipboard is left alone.
 */
function isCopyChordCandidate(e: KeyboardEvent): boolean {
  if (e.repeat || e.altKey || e.metaKey === e.ctrlKey) return false;
  const key = e.key.toLowerCase();
  if (key === "c" || key === "x") return true;
  return e.key === "Insert" && e.ctrlKey && !e.shiftKey;
}

/**
 * How long a paste-chord candidate waits for the browser's `paste` event.
 *
 * WHY not "until the next task": a real macOS key equivalent (Cmd+V) reaches
 * the page as a keydown first; only after the page leaves it unhandled does
 * the browser run its Edit > Paste menu command, which fires `paste` in a
 * later task (observed in Brave). Playwright's synthetic chord carries the
 * paste command inside the key event, so it fires in the same task and hid
 * this. A chord that is not a paste (Ctrl+V on macOS) is held this long
 * before it reaches the guest as plain keys.
 */
export const PASTE_DECISION_MS = 500;

/** Wires the browser paste gesture to the guest's clipboard. */
export interface BrowserPasteHandler {
  /** Offer pasted text to the guest's clipboard agent. */
  offer(text: string): Promise<ClipboardOfferResult>;
  /** A paste that could not reach the guest; the keys typed while it was
   *  pending were discarded. */
  onFailure?(failure: {
    reason: ClipboardOfferFailure;
    errno?: number;
    discardedKeystrokes: number;
  }): void;
  /** A paste chord the browser did not turn into a `paste` event in time;
   *  it went to the guest as ordinary keys. */
  onNoPaste?(): void;
}

/** Wires copy gestures over the desktop to the host clipboard. */
export interface BrowserCopyHandler {
  /**
   * Called synchronously from the copy chord's keydown, before the chord
   * reaches the guest (see `startHostClipboardCopyOut`). Resolves with the
   * text that reached the host clipboard.
   */
  onCopyGesture(): Promise<string>;
}

/** A paste chord awaiting the browser's verdict, then the guest's answer. */
interface PendingPaste {
  /** Keyboard records held back, in order; the chord's own come first. */
  queue: InputEvent[];
  /** The evdev code of the chord's key (V). */
  chordKey: number;
  sawPaste: boolean;
  timer: ReturnType<typeof setTimeout>;
}

function isModifierKind(key: unknown): key is ModifierKind {
  return typeof key === "string" && (MODIFIER_KINDS as readonly string[]).includes(key);
}

/** The modifier a key event is, by its OS meaning; keeps the physical side
 *  when the code agrees with the meaning (ControlRight stays right). */
function modifierKeyOf(e: KeyboardEvent): { kind: ModifierKind; key: number } | null {
  if (!isModifierKind(e.key)) return null;
  const kind = e.key;
  const positional = MODIFIER_CODES[kind].includes(e.code) ? codeToKey(e.code) : null;
  return { kind, key: positional ?? MODIFIER_LEFT_KEY[kind] };
}

export class BrowserInputSource implements InputSource {
  private dispatch: ((ev: InputEvent) => void) | null = null;
  private bindings: Array<
    [EventTarget, string, EventListener, AddEventListenerOptions | undefined]
  > = [];
  // Previous absolute pointer position (rounded clientX/Y), used to derive
  // REL deltas outside pointer lock. `null` means "no baseline yet" — the
  // next non-lock move only re-establishes it and emits no motion.
  private lastAbsX: number | null = null;
  private lastAbsY: number | null = null;
  // Modifiers the guest currently holds down, by kind, with the key code
  // that was pressed for each (so the release matches the press).
  private heldModifiers = new Map<ModifierKind, number>();
  // Non-modifier keys the guest holds down, by DOM `code` (the key's
  // position, stable between its keydown and keyup), with the evdev code
  // sent for each; and which of them went down while Meta was held.
  // macOS delivers no keyup for a key released while Cmd is held, so a
  // Cmd+V would otherwise leave V down in the guest forever, and libinput
  // drops a press of a key it believes is already down: the next V typed
  // would vanish. Releasing those keys when Meta goes up is the only signal
  // the page gets. Elsewhere the real keyup usually arrives first and
  // removes the key here; if it arrives after Meta's, the guest sees a
  // second release, which evdev consumers ignore.
  private heldKeys = new Map<string, number>();
  private keysPressedUnderMeta = new Set<string>();
  // The paste gesture (opts.paste). While a paste is pending, keyboard
  // records queue here instead of reaching the guest.
  private pendingPaste: PendingPaste | null = null;
  // Text the guest accepted from the last paste. Re-pasting the same host
  // text is not offered again, so an in-desktop copy made since survives.
  // (Known gap until copy-out exists: copy X on the host, Y in the guest,
  // X on the host again, and the guest pastes Y.)
  private lastOfferedText: string | null = null;

  /**
   * @param target  Event source to bind to (defaults to `window`).
   * @param opts.pointer  When `false`, the pointer motion/button handlers
   *   are not bound. Used when another surface owns the pointer feed (e.g.
   *   the Modeset pane injects framebuffer-positioned pointer events into
   *   `/dev/input/event1` itself, and a second window feed would fight it).
   * @param opts.wheel  Overrides whether the wheel handler is bound;
   *   defaults to following `pointer`. Wheel events are REL_WHEEL and carry
   *   no absolute coordinates, so `{ pointer: false, wheel: true }` lets a
   *   pane keep the pointer while the wheel still scrolls.
   * @param opts.paste  Turns the browser's paste gesture into an offer on
   *   the guest's clipboard (images declaring the `clipboard` feature). A
   *   Cmd/Ctrl+V keydown is left to the browser; if it fires `paste`, the
   *   text is offered and the chord — with every key typed meanwhile —
   *   reaches the guest only once the guest's agent has installed it. If
   *   no `paste` follows within PASTE_DECISION_MS, the chord is ordinary
   *   keys.
   * @param opts.copy  Copy-out: on a copy chord over the desktop, the
   *   guest's next selection is written to the host clipboard.
   * @param opts.shouldCapture  Consulted at the top of every handler. When
   *   it returns `false` the event is left entirely to the browser — no
   *   `preventDefault`, no evdev emission — so the surrounding app chrome
   *   (the "New" menu, dialogs, scrollable panels) stays usable while a
   *   demo runs. Bind to `window` for global reach, then scope capture to
   *   the demo stage here (see `demoSurfaceCaptureGate`). Defaults to
   *   always capturing, preserving the original global behavior.
   */
  constructor(
    private target: EventTarget = window,
    private opts: {
      pointer?: boolean;
      wheel?: boolean;
      shouldCapture?: (e: Event) => boolean;
      paste?: BrowserPasteHandler;
      copy?: BrowserCopyHandler;
    } = {},
  ) {}

  /** Whether this event should be captured for the demo (vs. left to the
   *  browser so the app chrome keeps working). */
  private shouldCapture(e: Event): boolean {
    return this.opts.shouldCapture ? this.opts.shouldCapture(e) : true;
  }

  start(dispatch: (ev: InputEvent) => void): void {
    this.dispatch = dispatch;
    // Keyboard in the CAPTURE phase. This source binds to `window` for
    // global reach and lets `shouldCapture` decide what the demo owns, but a
    // focused widget inside the demo stage gets the event first and can end
    // it: xterm.js calls `stopPropagation()` on every key it handles, so a
    // bubbling keydown never reaches window while the Shell pane holds focus
    // — and keyup, which xterm does not cancel, still does. That asymmetry
    // handed `/dev/input/event0` a key release with no matching press, which
    // is worse for an evdev consumer than receiving neither. Capture phase
    // sees the event before any target handler can cancel it; the gate still
    // decides whether this demo wants it.
    this.bind("keydown", this.onKeyDown, { capture: true });
    this.bind("keyup", this.onKeyUp, { capture: true });
    if (this.opts.paste) this.bind("paste", this.onPaste, { capture: true });
    if (this.opts.pointer !== false) {
      this.bind("pointermove", this.onPointerMove);
      this.bind("pointerdown", this.onPointerDown);
      this.bind("pointerup", this.onPointerUp);
      this.bind("pointerleave", this.onPointerLeave);
    }
    // `wheel` listeners default to passive on window/document, which makes
    // onWheel's e.preventDefault() a silent no-op (the page scrolls while we
    // also inject REL_WHEEL). Register it non-passive so preventDefault works.
    if (this.opts.wheel ?? this.opts.pointer !== false) {
      this.bind("wheel", this.onWheel, { passive: false });
    }
    // `pointerlockchange` only fires on document, never on window — so
    // it can't go through this.bind which is parametric over `target`.
    // Tracked in `bindings` for symmetric removal in stop().
    const lockHandler = this.onPointerLockChange.bind(this) as EventListener;
    this.bindings.push([document, "pointerlockchange", lockHandler, undefined]);
    document.addEventListener("pointerlockchange", lockHandler);
  }

  stop(): void {
    // `removeEventListener` matches on the capture flag as well as the
    // callback, so the options a binding was registered with have to come
    // back with it or a capture-phase listener outlives stop().
    for (const [t, n, l, o] of this.bindings) t.removeEventListener(n, l, o);
    this.bindings = [];
    if (this.pendingPaste) clearTimeout(this.pendingPaste.timer);
    this.pendingPaste = null;
    this.dispatch = null;
  }

  private bind(
    name: string,
    handler: (e: any) => void,
    options?: AddEventListenerOptions,
  ) {
    const wrapped = handler.bind(this);
    this.target.addEventListener(name, wrapped as EventListener, options);
    this.bindings.push([this.target, name, wrapped as EventListener, options]);
  }

  private emit(
    device: 0 | 1,
    ev_type: number,
    code: number,
    value: number,
  ): void {
    // A DOM event already queued when stop() runs can still fire its
    // listener after dispatch was nulled and before removeEventListener
    // unwinds; drop it rather than call null.
    if (!this.dispatch) return;
    // Keys typed while a paste is pending wait behind it, so "paste, Enter"
    // cannot run the command line before the pasted text lands. The pointer
    // is not held: it carries no text and lagging it would be felt.
    if (device === 0 && this.pendingPaste) {
      this.pendingPaste.queue.push({ device, ev_type, code, value });
      return;
    }
    this.dispatch({ device, ev_type, code, value });
  }

  private frame(device: 0 | 1): void {
    this.emit(device, EV_SYN, SYN_REPORT, 0);
  }

  private onPointerLockChange(): void {
    // The absolute→delta baseline is meaningless across a lock transition
    // (clientX/Y vs movementX/Y coordinate spaces differ), so drop it; the
    // next non-lock move re-establishes it.
    this.lastAbsX = null;
    this.lastAbsY = null;
    this.frame(1);
  }

  private onPointerLeave(): void {
    // Forget the baseline so a re-entry elsewhere in the viewport doesn't
    // report the gap as one large motion delta.
    this.lastAbsX = null;
    this.lastAbsY = null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.shouldCapture(e)) return;
    const modifier = modifierKeyOf(e);
    if (modifier !== null) {
      e.preventDefault();
      this.emit(0, EV_KEY, modifier.key, e.repeat ? 2 : 1);
      this.heldModifiers.set(modifier.kind, modifier.key);
      this.frame(0);
      return;
    }
    // A Caps Lock the OS did not engage is a remapped key whose meaning
    // arrives as a modifier flag on the next key (see above); forwarding it
    // would toggle the guest into upper case.
    if (e.key === "CapsLock" && typeof e.getModifierState === "function"
      && e.getModifierState("CapsLock") === false) {
      return;
    }
    const key = charToKey(e.key) ?? codeToKey(e.code);
    if (key === null) return;
    if (this.opts.copy && !this.pendingPaste && isCopyChordCandidate(e)) {
      // Before the chord's keys go out, so the wait samples the guest's
      // selection generation ahead of the copy it is waiting for.
      this.opts.copy.onCopyGesture().then(
        // Host and guest now hold the same text, so a later paste of it is
        // not re-offered — and a host copy of anything else is.
        (text) => { this.lastOfferedText = text; },
        () => {},
      );
    }
    if (this.opts.paste && !this.pendingPaste && isPasteChordCandidate(e)) {
      // Leave the keydown to the browser so its paste binding can fire
      // `paste`; hold the chord until we know what it was.
      this.beginPaste(key);
    } else {
      e.preventDefault();
    }
    this.syncModifiers(e);
    this.emit(0, EV_KEY, key, e.repeat ? 2 : 1);
    this.heldKeys.set(e.code, key);
    if (this.heldModifiers.has("Meta")) this.keysPressedUnderMeta.add(e.code);
    this.frame(0);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!this.shouldCapture(e)) return;
    const modifier = modifierKeyOf(e);
    if (modifier !== null) {
      e.preventDefault();
      if (modifier.kind === "Meta") this.releaseKeysPressedUnderMeta();
      this.emit(0, EV_KEY, this.heldModifiers.get(modifier.kind) ?? modifier.key, 0);
      this.heldModifiers.delete(modifier.kind);
      this.frame(0);
      return;
    }
    const key = charToKey(e.key) ?? codeToKey(e.code);
    if (key === null) return;
    e.preventDefault();
    // Forget the key before syncing modifiers: a Meta release synced here
    // would otherwise release it once on Meta's behalf and once below.
    this.heldKeys.delete(e.code);
    this.keysPressedUnderMeta.delete(e.code);
    this.syncModifiers(e);
    this.emit(0, EV_KEY, key, 0);
    this.frame(0);
  }

  private beginPaste(chordKey: number): void {
    const pending: PendingPaste = {
      queue: [],
      chordKey,
      sawPaste: false,
      timer: setTimeout(() => {
        if (this.pendingPaste === pending && !pending.sawPaste) {
          this.finishPaste();
          this.opts.paste?.onNoPaste?.();
        }
      }, PASTE_DECISION_MS),
    };
    this.pendingPaste = pending;
  }

  private onPaste(e: ClipboardEvent): void {
    const pending = this.pendingPaste;
    if (!pending || pending.sawPaste) return;
    pending.sawPaste = true;
    clearTimeout(pending.timer);
    // Nothing is pasted into the page: the text is for the guest.
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    // No text on the clipboard, or the same text the guest already has:
    // the chord pastes the guest's current selection.
    if (text === "" || text === this.lastOfferedText) {
      this.finishPaste();
      return;
    }
    this.opts.paste!.offer(text).then(
      (result) => {
        if (this.pendingPaste !== pending) return;   // stopped meanwhile
        if (result.ok) {
          this.lastOfferedText = text;
          this.finishPaste();
        } else {
          this.finishPaste({ reason: result.reason, errno: result.errno });
        }
      },
      () => {
        if (this.pendingPaste === pending) this.finishPaste({ reason: "agent-error" });
      },
    );
  }

  /**
   * Release the held keyboard records. On success (or no paste at all)
   * they reach the guest in order, chord first. On failure the chord and
   * every key typed meanwhile are dropped — delivering "Enter" after a
   * paste that never landed could run a half-typed command — but modifier
   * transitions still go through, so the guest's view of Shift, Ctrl, Alt
   * and Super stays true, as do releases of keys pressed before the paste.
   */
  private finishPaste(failure?: { reason: ClipboardOfferFailure; errno?: number }): void {
    const pending = this.pendingPaste;
    if (!pending || !this.dispatch) return;
    clearTimeout(pending.timer);
    this.pendingPaste = null;
    if (!failure) {
      for (const ev of pending.queue) this.dispatch(ev);
      return;
    }
    const dropped = new Set<number>();
    let discardedKeystrokes = 0;
    for (const ev of pending.queue) {
      if (ev.ev_type === EV_KEY && !MODIFIER_KEY_CODES.has(ev.code)) {
        if (ev.value === 1) {
          if (!(dropped.size === 0 && ev.code === pending.chordKey)) discardedKeystrokes++;
          dropped.add(ev.code);
          continue;
        }
        if (dropped.has(ev.code)) continue;   // repeat or release of a dropped press
      }
      this.dispatch(ev);
    }
    // The guest never saw those presses; forget them here too.
    for (const [code, key] of this.heldKeys) {
      if (dropped.has(key)) {
        this.heldKeys.delete(code);
        this.keysPressedUnderMeta.delete(code);
      }
    }
    this.opts.paste?.onFailure?.({ ...failure, discardedKeystrokes });
  }

  /** Release every key still held that went down while Meta was held (see
   *  `heldKeys`). Called just before the guest's Meta release. */
  private releaseKeysPressedUnderMeta(): void {
    for (const code of this.keysPressedUnderMeta) {
      const key = this.heldKeys.get(code);
      if (key === undefined) continue;
      this.emit(0, EV_KEY, key, 0);
      this.heldKeys.delete(code);
    }
    this.keysPressedUnderMeta.clear();
  }

  /**
   * Make the guest's held modifiers match the event's modifier flags before
   * a non-modifier key. The flags are the OS's word on what is held, so this
   * covers a remapped key that never produced a modifier keydown, and a
   * modifier released while the page did not have focus. An event without
   * boolean flags (a synthetic one) leaves the state alone.
   */
  private syncModifiers(e: KeyboardEvent): void {
    for (const kind of MODIFIER_KINDS) {
      const flag = (e as unknown as Record<string, unknown>)[MODIFIER_FLAG[kind]];
      if (typeof flag !== "boolean") continue;
      const held = this.heldModifiers.get(kind);
      if (flag && held === undefined) {
        const key = MODIFIER_LEFT_KEY[kind];
        this.emit(0, EV_KEY, key, 1);
        this.heldModifiers.set(kind, key);
      } else if (!flag && held !== undefined) {
        if (kind === "Meta") this.releaseKeysPressedUnderMeta();
        this.emit(0, EV_KEY, held, 0);
        this.heldModifiers.delete(kind);
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.shouldCapture(e)) {
      // Drop the absolute baseline so re-entering the stage re-derives it
      // from the first in-stage move rather than reporting a phantom jump
      // across the region the pointer traversed off-stage.
      this.lastAbsX = null;
      this.lastAbsY = null;
      return;
    }
    if (document.pointerLockElement) {
      if (e.movementX !== 0) this.emit(1, EV_REL, REL_X, e.movementX);
      if (e.movementY !== 0) this.emit(1, EV_REL, REL_Y, e.movementY);
    } else {
      // event1 is a relative device to SDL, so convert the absolute
      // viewport position (clientX/Y — the same space as the EVIOCGABS
      // maxima) into a delta from the last position. offsetX/offsetY would
      // be element-relative and unrelated to that axis range.
      const x = Math.round(e.clientX);
      const y = Math.round(e.clientY);
      if (this.lastAbsX !== null && this.lastAbsY !== null) {
        const dx = x - this.lastAbsX;
        const dy = y - this.lastAbsY;
        if (dx !== 0) this.emit(1, EV_REL, REL_X, dx);
        if (dy !== 0) this.emit(1, EV_REL, REL_Y, dy);
      }
      this.lastAbsX = x;
      this.lastAbsY = y;
    }
    this.frame(1);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.shouldCapture(e)) return;
    const btn = pointerButton(e);
    if (btn === null) return;
    this.emit(1, EV_KEY, btn, 1);
    this.frame(1);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.shouldCapture(e)) return;
    const btn = pointerButton(e);
    if (btn === null) return;
    this.emit(1, EV_KEY, btn, 0);
    this.frame(1);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.shouldCapture(e)) return;
    e.preventDefault();
    // Browser deltaMode quanta, normalised to ~1 detent per physical notch:
    //   0 = PIXEL (Chromium ±100/±120, Safari ±1–10 per notch) → ÷120
    //   1 = LINE  (Firefox, ±3 lines per notch)                → ÷3
    //   2 = PAGE  (±1 page per notch)                          → ÷120 = 0,
    //             rescued by the ±1 clamp below.
    // Then clamp small-but-nonzero deltas to ±1 so a continuous-trackpad
    // scroll still emits at least one tick (otherwise Math.trunc(0.3/120)=0
    // and the entire scroll event disappears).
    const scale = e.deltaMode === 1 ? 3 : 120;
    let ticks_y = Math.trunc(e.deltaY / -scale);
    let ticks_x = Math.trunc(e.deltaX / scale);
    if (ticks_y === 0 && e.deltaY !== 0) ticks_y = e.deltaY < 0 ? 1 : -1;
    if (ticks_x === 0 && e.deltaX !== 0) ticks_x = e.deltaX > 0 ? 1 : -1;
    if (ticks_y !== 0) this.emit(1, EV_REL, REL_WHEEL, ticks_y);
    if (ticks_x !== 0) this.emit(1, EV_REL, REL_HWHEEL, ticks_x);
    if (ticks_y !== 0 || ticks_x !== 0) this.frame(1);
  }
}

function pointerButton(e: PointerEvent): number | null {
  switch (e.button) {
    case 0:
      return BTN_LEFT;
    case 1:
      return BTN_MIDDLE;
    case 2:
      return BTN_RIGHT;
    default:
      return null;
  }
}
