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

  it("pointermove without pointer lock emits ABS_X/ABS_Y absolute coords", () => {
    target.fire("pointermove", {
      offsetX: 123.7,
      offsetY: 45,
      movementX: 0,
      movementY: 0,
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x03, code: 0x00, value: 124 },
      { device: 1, ev_type: 0x03, code: 0x01, value: 45 },
      { device: 1, ev_type: 0x00, code: 0, value: 0 },
    ]);
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

  it("wheel deltaMode=LINE with -3 lines normalises to +3 ticks", () => {
    target.fire("wheel", {
      deltaMode: 1,
      deltaX: 0,
      deltaY: -3,
      preventDefault() {},
    });
    expect(recorded).toEqual([
      { device: 1, ev_type: 0x02, code: 0x08, value: 3 },
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
