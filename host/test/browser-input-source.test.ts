import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserInputSource } from "../src/input/browser-input-source.js";
import type { InputEvent } from "../src/input/input-source.js";

/**
 * Minimal EventTarget stub. We don't pull in jsdom/happy-dom — these
 * tests cover translation logic, not DOM semantics. `fire(name, ev)`
 * synchronously invokes every listener bound for that event name.
 */
class FakeTarget implements EventTarget {
  private listeners = new Map<string, EventListener[]>();
  addEventListener(name: string, l: EventListenerOrEventListenerObject | null) {
    if (typeof l !== "function") return;
    const arr = this.listeners.get(name) ?? [];
    arr.push(l);
    this.listeners.set(name, arr);
  }
  removeEventListener(name: string, l: EventListenerOrEventListenerObject | null) {
    if (typeof l !== "function") return;
    const arr = (this.listeners.get(name) ?? []).filter((x) => x !== l);
    this.listeners.set(name, arr);
  }
  dispatchEvent(_e: Event): boolean {
    return true;
  }
  fire(name: string, ev: object): void {
    for (const l of this.listeners.get(name) ?? []) l(ev as Event);
  }
  count(name: string): number {
    return (this.listeners.get(name) ?? []).length;
  }
}

describe("BrowserInputSource", () => {
  let target: FakeTarget;
  let doc: FakeTarget & { pointerLockElement: Element | null };
  let recorded: InputEvent[];
  let src: BrowserInputSource;

  beforeEach(() => {
    target = new FakeTarget();
    doc = Object.assign(new FakeTarget(), {
      pointerLockElement: null as Element | null,
    });
    vi.stubGlobal("document", doc);
    recorded = [];
    src = new BrowserInputSource(target);
    src.start((ev) => recorded.push(ev));
  });

  afterEach(() => {
    src.stop();
    vi.unstubAllGlobals();
  });

  it("keydown emits EV_KEY(KEY_A, 1) then SYN_REPORT on the keyboard device", () => {
    target.fire("keydown", {
      code: "KeyA",
      repeat: false,
      preventDefault() {},
    });
    expect(recorded).toEqual([
      { device: 0, ev_type: 0x01, code: 30, value: 1 },
      { device: 0, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("repeat keydown emits value=2 (Linux autorepeat convention)", () => {
    target.fire("keydown", {
      code: "Space",
      repeat: true,
      preventDefault() {},
    });
    expect(recorded[0]).toEqual({
      device: 0,
      ev_type: 0x01,
      code: 57,
      value: 2,
    });
  });

  it("unknown KeyboardEvent.code is ignored and preventDefault is not called", () => {
    let prevented = false;
    target.fire("keydown", {
      code: "Hyper",
      repeat: false,
      preventDefault() {
        prevented = true;
      },
    });
    expect(recorded).toEqual([]);
    expect(prevented).toBe(false);
  });

  it("keyup emits EV_KEY(code, 0) then SYN_REPORT", () => {
    target.fire("keyup", {
      code: "Escape",
      repeat: false,
      preventDefault() {},
    });
    expect(recorded).toEqual([
      { device: 0, ev_type: 0x01, code: 1, value: 0 },
      { device: 0, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("pointermove without pointer lock emits REL deltas from the previous clientX/Y", () => {
    // event1 advertises REL_X/REL_Y, so SDL's evdev backend treats it as a
    // relative mouse and drops EV_ABS. The first move only establishes the
    // baseline (a relative device has no absolute origin); the second
    // reports the delta. clientX/Y (viewport) is the source, not offsetX/Y.
    target.fire("pointermove", {
      clientX: 100,
      clientY: 50,
      offsetX: 9,
      offsetY: 9,
      movementX: 0,
      movementY: 0,
    });
    expect(recorded).toEqual([{ device: 1, ev_type: 0x00, code: 0, value: 0 }]);
    recorded.length = 0;
    target.fire("pointermove", {
      clientX: 123.7,
      clientY: 45,
      offsetX: 9,
      offsetY: 9,
      movementX: 0,
      movementY: 0,
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x00, value: 24 }, // round(123.7)-100
      { device: 1, ev_type: 0x02, code: 0x01, value: -5 }, // 45-50
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("pointermove without lock skips an axis whose delta is zero", () => {
    target.fire("pointermove", {
      clientX: 10,
      clientY: 10,
      movementX: 0,
      movementY: 0,
    });
    recorded.length = 0;
    target.fire("pointermove", {
      clientX: 15,
      clientY: 10,
      movementX: 0,
      movementY: 0,
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x00, value: 5 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("pointerleave resets the baseline so re-entry emits no phantom jump", () => {
    target.fire("pointermove", {
      clientX: 10,
      clientY: 10,
      movementX: 0,
      movementY: 0,
    });
    target.fire("pointerleave", {});
    recorded.length = 0;
    target.fire("pointermove", {
      clientX: 500,
      clientY: 500,
      movementX: 0,
      movementY: 0,
    });
    expect(recorded).toEqual([{ device: 1, ev_type: 0x00, code: 0, value: 0 }]);
  });

  it("pointerlockchange clears the absolute baseline", () => {
    target.fire("pointermove", {
      clientX: 10,
      clientY: 10,
      movementX: 0,
      movementY: 0,
    });
    doc.fire("pointerlockchange", {}); // resets baseline + frames
    recorded.length = 0;
    target.fire("pointermove", {
      clientX: 300,
      clientY: 300,
      movementX: 0,
      movementY: 0,
    });
    expect(recorded).toEqual([{ device: 1, ev_type: 0x00, code: 0, value: 0 }]);
  });

  it("pointermove with pointer lock active emits REL_X/REL_Y deltas", () => {
    doc.pointerLockElement = {} as Element;
    target.fire("pointermove", {
      offsetX: 0,
      offsetY: 0,
      movementX: -3,
      movementY: 7,
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x00, value: -3 },
      { device: 1, ev_type: 0x02, code: 0x01, value: 7 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("pointermove in lock with zero movement on one axis skips that axis", () => {
    doc.pointerLockElement = {} as Element;
    target.fire("pointermove", {
      offsetX: 0,
      offsetY: 0,
      movementX: 5,
      movementY: 0,
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x00, value: 5 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("pointerdown emits BTN_LEFT/MIDDLE/RIGHT for each mouse button", () => {
    target.fire("pointerdown", { button: 0 });
    target.fire("pointerdown", { button: 1 });
    target.fire("pointerdown", { button: 2 });
    const codes = recorded.filter((e) => e.ev_type === 0x01).map((e) => e.code);
    expect(codes).toEqual([0x110, 0x112, 0x111]);
  });

  it("pointerup emits BTN_LEFT release", () => {
    target.fire("pointerup", { button: 0 });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x01, code: 0x110, value: 0 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("pointerdown for unknown button (e.g. side button) drops the event", () => {
    target.fire("pointerdown", { button: 3 });
    expect(recorded).toEqual([]);
  });

  it("wheel deltaMode=PIXEL with ±120 chunks normalises to ±1 tick", () => {
    target.fire("wheel", {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 120,
      preventDefault() {},
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x08, value: -1 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("wheel deltaMode=LINE with -3 lines (one Firefox notch) normalises to +1 tick", () => {
    target.fire("wheel", {
      deltaMode: 1,
      deltaX: 0,
      deltaY: -3,
      preventDefault() {},
    });
    // One physical notch is ±3 lines in LINE mode, so it must yield a single
    // REL_WHEEL detent — the same as one ±120px notch in PIXEL mode — not 3.
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x08, value: 1 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("wheel small-but-nonzero pixel delta clamps to ±1 tick (trackpad)", () => {
    target.fire("wheel", {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 1,
      preventDefault() {},
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x08, value: -1 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("wheel horizontal-only emits REL_HWHEEL and frames", () => {
    target.fire("wheel", {
      deltaMode: 0,
      deltaX: 240,
      deltaY: 0,
      preventDefault() {},
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x06, value: 2 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("wheel with zero delta emits no records", () => {
    target.fire("wheel", {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      preventDefault() {},
    });
    expect(recorded).toEqual([]);
  });

  it("pointerlockchange emits a bare SYN_REPORT on the pointer device", () => {
    doc.fire("pointerlockchange", {});
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
  });

  it("stop() removes all listeners; subsequent fires emit nothing", () => {
    src.stop();
    expect(target.count("keydown")).toBe(0);
    expect(target.count("pointermove")).toBe(0);
    expect(doc.count("pointerlockchange")).toBe(0);
    target.fire("keydown", {
      code: "KeyA",
      repeat: false,
      preventDefault() {},
    });
    doc.fire("pointerlockchange", {});
    expect(recorded).toEqual([]);
  });
});

/**
 * A target that remembers the exact `options` each listener was registered
 * and de-registered with. `removeEventListener` matches on the capture flag,
 * so "registered with capture, removed without" is a real leak the plain
 * FakeTarget above cannot see.
 */
class OptionRecordingTarget implements EventTarget {
  readonly added: Array<[string, EventListener, unknown]> = [];
  readonly removed: Array<[string, EventListener, unknown]> = [];
  addEventListener(
    name: string,
    l: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (typeof l !== "function") return;
    this.added.push([name, l, options]);
  }
  removeEventListener(
    name: string,
    l: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (typeof l !== "function") return;
    this.removed.push([name, l, options]);
  }
  dispatchEvent(_e: Event): boolean {
    return true;
  }
}

describe("BrowserInputSource — listener registration", () => {
  it("binds the keyboard in the capture phase and removes it the same way", () => {
    const target = new OptionRecordingTarget();
    const doc = Object.assign(new OptionRecordingTarget(), {
      pointerLockElement: null,
    });
    vi.stubGlobal("document", doc);
    const src = new BrowserInputSource(target as unknown as EventTarget);
    src.start(() => {});

    // A focused widget can stopPropagation() a bubbling keydown — xterm.js
    // does exactly that for every key it handles — so the demo's global
    // input capture has to see the event before any target handler runs.
    for (const name of ["keydown", "keyup"]) {
      const entry = target.added.find(([n]) => n === name);
      expect(entry, `${name} must be bound`).toBeDefined();
      expect(entry![2], `${name} must bind in the capture phase`).toEqual({
        capture: true,
      });
    }

    src.stop();
    for (const [name, listener, options] of target.added) {
      expect(
        target.removed.some(
          ([n, l, o]) => n === name && l === listener && o === options,
        ),
        `${name} must be removed with the options it was added with`,
      ).toBe(true);
    }
    vi.unstubAllGlobals();
  });
});
