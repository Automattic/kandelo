import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserInputSource } from "../src/input/browser-input-source.js";
import { demoSurfaceCaptureGate } from "../src/input/demo-surface-gate.js";
import type { InputEvent } from "../src/input/input-source.js";

/** Minimal EventTarget stub (mirrors browser-input-source.test.ts). */
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
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((x) => x !== l),
    );
  }
  dispatchEvent(): boolean {
    return true;
  }
  fire(name: string, ev: object): void {
    for (const l of this.listeners.get(name) ?? []) l(ev as Event);
  }
}

describe("BrowserInputSource — shouldCapture gate", () => {
  let target: FakeTarget;
  let recorded: InputEvent[];
  let src: BrowserInputSource;

  beforeEach(() => {
    target = new FakeTarget();
    vi.stubGlobal(
      "document",
      Object.assign(new FakeTarget(), { pointerLockElement: null }),
    );
    recorded = [];
  });

  afterEach(() => {
    src.stop();
    vi.unstubAllGlobals();
  });

  it("when shouldCapture returns false, keydown does not preventDefault and emits nothing", () => {
    src = new BrowserInputSource(target, { shouldCapture: () => false });
    src.start((ev) => recorded.push(ev));
    const preventDefault = vi.fn();
    target.fire("keydown", { code: "KeyA", repeat: false, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("when shouldCapture returns false, wheel does not preventDefault and emits nothing", () => {
    src = new BrowserInputSource(target, { wheel: true, shouldCapture: () => false });
    src.start((ev) => recorded.push(ev));
    const preventDefault = vi.fn();
    target.fire("wheel", { deltaY: 120, deltaX: 0, deltaMode: 0, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it("when shouldCapture returns false, pointer motion emits nothing", () => {
    src = new BrowserInputSource(target, { shouldCapture: () => false });
    src.start((ev) => recorded.push(ev));
    target.fire("pointermove", { clientX: 10, clientY: 10 });
    expect(recorded).toEqual([]);
  });

  it("when shouldCapture returns true, keydown behaves normally (preventDefault + emit)", () => {
    src = new BrowserInputSource(target, { shouldCapture: () => true });
    src.start((ev) => recorded.push(ev));
    const preventDefault = vi.fn();
    target.fire("keydown", { code: "KeyA", repeat: false, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(recorded.length).toBeGreaterThan(0);
  });

  it("defaults to capturing when no shouldCapture is supplied (unchanged behavior)", () => {
    src = new BrowserInputSource(target);
    src.start((ev) => recorded.push(ev));
    const preventDefault = vi.fn();
    target.fire("keydown", { code: "KeyA", repeat: false, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(recorded.length).toBeGreaterThan(0);
  });
});

describe("demoSurfaceCaptureGate", () => {
  // Tiny element stub with contains().
  function el(children: object[] = []): any {
    const self: any = {
      _children: children,
      contains(n: unknown) {
        return n === self || children.includes(n as object);
      },
    };
    return self;
  }

  it("captures keyboard when focus is on the body (nothing in chrome focused)", () => {
    const body = el();
    const surface = el();
    const gate = demoSurfaceCaptureGate(
      () => surface,
      () => body,
      () => body,
    );
    expect(gate({ type: "keydown" } as any)).toBe(true);
    expect(gate({ type: "keyup" } as any)).toBe(true);
  });

  it("captures keyboard when focus is inside the demo surface", () => {
    const inSurface = el();
    const surface = el([inSurface]);
    const body = el();
    const gate = demoSurfaceCaptureGate(() => surface, () => inSurface, () => body);
    expect(gate({ type: "keydown" } as any)).toBe(true);
  });

  it("releases keyboard when a control outside the surface (New menu / dialog) is focused", () => {
    const menuButton = el();
    const surface = el(); // does not contain menuButton
    const body = el();
    const gate = demoSurfaceCaptureGate(() => surface, () => menuButton, () => body);
    expect(gate({ type: "keydown" } as any)).toBe(false);
    expect(gate({ type: "keyup" } as any)).toBe(false);
  });

  it("captures wheel/pointer only when the event targets the demo surface", () => {
    const onSurface = el();
    const surface = el([onSurface]);
    const offSurface = el();
    const body = el();
    const gate = demoSurfaceCaptureGate(() => surface, () => body, () => body);
    expect(gate({ type: "wheel", target: onSurface } as any)).toBe(true);
    expect(gate({ type: "wheel", target: offSurface } as any)).toBe(false);
    expect(gate({ type: "pointermove", target: onSurface } as any)).toBe(true);
    expect(gate({ type: "pointermove", target: offSurface } as any)).toBe(false);
  });

  it("does NOT capture when the demo surface is absent (input goes to the active surface)", () => {
    // e.g. during boot before the pane mounts, or after switching to
    // another primary view where the demo surface is not resolvable.
    const body = el();
    const gate = demoSurfaceCaptureGate(() => null, () => body, () => body);
    expect(gate({ type: "keydown" } as any)).toBe(false);
    expect(gate({ type: "wheel", target: el() } as any)).toBe(false);
  });

  it("releases sibling in-<main> surfaces (terminal / Inspector) not inside the demo surface", () => {
    // I1: the terminal and Inspector are siblings of the demo surface
    // inside <main>. Scoping to the demo surface (not all of <main>) must
    // leave them scrollable/typable while the demo runs.
    const terminalTextarea = el();
    const inspectorRow = el();
    const demoSurface = el(); // contains neither the terminal nor Inspector
    const body = el();
    const gate = demoSurfaceCaptureGate(() => demoSurface, () => body, () => body);
    // wheel over the terminal / Inspector → not captured (they scroll).
    expect(gate({ type: "wheel", target: terminalTextarea } as any)).toBe(false);
    expect(gate({ type: "wheel", target: inspectorRow } as any)).toBe(false);
    // keyboard while the terminal is focused → not captured (typing works).
    const gateFocused = demoSurfaceCaptureGate(
      () => demoSurface,
      () => terminalTextarea,
      () => body,
    );
    expect(gateFocused({ type: "keydown" } as any)).toBe(false);
  });
});
