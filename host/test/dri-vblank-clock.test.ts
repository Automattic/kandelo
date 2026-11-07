import { describe, expect, it } from "vitest";
import {
  VBLANK_ABSENT_MS,
  VBLANK_PERIOD_MS,
  VblankClock,
  type VblankSource,
} from "../src/dri/vblank-clock";

/**
 * A deterministic host: a virtual clock, one-shot timers, and an optional
 * display that delivers animation frames at `frameMs` intervals while
 * `visible`, each callback `lagMs` after its frame time (a busy worker).
 */
class SimHost {
  time = 0;
  timers = new Map<number, { at: number; cb: () => void }>();
  frames = new Map<number, (t: number) => void>();
  nextId = 1;
  visible = true;
  lagMs = 0;
  frameRequests = 0;
  throwOnRequest = false;
  constructor(public frameMs: number | null) {}

  host(display: boolean) {
    return {
      now: () => this.time,
      setTimer: (cb: () => void, delay: number) => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.time + delay, cb });
        return id;
      },
      clearTimer: (id: unknown) => { this.timers.delete(id as number); },
      requestFrame: display
        ? (cb: (t: number) => void) => {
          if (this.throwOnRequest) throw new DOMException("no", "NotSupportedError");
          this.frameRequests++;
          const id = this.nextId++;
          this.frames.set(id, cb);
          return id;
        }
        : undefined,
      cancelFrame: display ? (id: unknown) => { this.frames.delete(id as number); } : undefined,
    };
  }

  /** Run until `end`, firing timers and display frames in time order. */
  run(end: number): void {
    let nextFrame = this.frameMs === null ? Infinity
      : Math.ceil((this.time + 1e-9) / this.frameMs) * this.frameMs;
    for (;;) {
      let timerId = -1;
      let timerAt = Infinity;
      for (const [id, t] of this.timers) if (t.at < timerAt) { timerAt = t.at; timerId = id; }
      const frameCallbackAt = nextFrame + this.lagMs;
      const at = Math.min(timerAt, frameCallbackAt);
      if (at > end) { this.time = end; return; }
      if (timerAt <= frameCallbackAt) {
        const t = this.timers.get(timerId)!;
        this.timers.delete(timerId);
        this.time = Math.max(this.time, timerAt);
        t.cb();
      } else {
        this.time = Math.max(this.time, frameCallbackAt);
        const frameTime = nextFrame;
        nextFrame += this.frameMs!;
        if (!this.visible) continue;
        const pending = [...this.frames.values()];
        this.frames.clear();
        for (const cb of pending) cb(frameTime);
      }
    }
  }
}

function record(sim: SimHost, display: boolean) {
  const ticks: Array<{ t: number; source: VblankSource }> = [];
  const clock = new VblankClock(sim.host(display), (t, source) => ticks.push({ t, source }));
  return { clock, ticks };
}

const gaps = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]);

describe("VblankClock", () => {
  it("runs on a timer at the mode's rate without a display (Node)", () => {
    const sim = new SimHost(null);
    const { clock, ticks } = record(sim, false);
    clock.start();
    sim.run(1000);
    expect(ticks.every((tick) => tick.source === "timer")).toBe(true);
    expect(ticks.length).toBe(60);
    for (const gap of gaps(ticks.map((tick) => tick.t))) {
      expect(gap).toBeCloseTo(VBLANK_PERIOD_MS, 6);
    }
    expect(clock.followsDisplay).toBe(false);
  });

  it("keeps the mode's average rate when timers fire late", () => {
    const sim = new SimHost(null);
    const ticks: number[] = [];
    const host = sim.host(false);
    // Every timer fires 1.2 ms late, as busy event loops make them.
    const late = { ...host, setTimer: (cb: () => void, d: number) => host.setTimer(cb, d + 1.2) };
    new VblankClock(late, (t) => ticks.push(t)).start();
    sim.run(10_000);
    expect(ticks.length).toBeGreaterThanOrEqual(599);
    expect(ticks.length).toBeLessThanOrEqual(600);
  });

  it("puts one vblank on every frame of a 60 Hz display, at the frame's time", () => {
    const sim = new SimHost(VBLANK_PERIOD_MS);
    sim.lagMs = 1;
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(2000);
    expect(ticks.every((tick) => tick.source === "frame")).toBe(true);
    // Frame times, not callback times.
    for (const tick of ticks) {
      expect(tick.t / VBLANK_PERIOD_MS).toBeCloseTo(Math.round(tick.t / VBLANK_PERIOD_MS), 6);
    }
    expect(ticks.length).toBeGreaterThanOrEqual(118);
    for (const gap of gaps(ticks.map((tick) => tick.t))) {
      expect(gap).toBeCloseTo(VBLANK_PERIOD_MS, 6);
    }
    expect(clock.followsDisplay).toBe(true);
  });

  it("keeps every frame of a slightly slow 60 Hz display and the mode's rate on a slightly fast one", () => {
    for (const hz of [59.94, 60.05, 60.5, 61]) {
      const sim = new SimHost(1000 / hz);
      const { clock, ticks } = record(sim, true);
      clock.start();
      sim.run(30_000);
      const frames = Math.floor(30_000 / (1000 / hz));
      expect(ticks.every((tick) => tick.source === "frame")).toBe(true);
      if (hz < 60) expect(frames - ticks.length).toBeLessThanOrEqual(2);
      else expect(Math.abs(ticks.length - 1800)).toBeLessThanOrEqual(15);
    }
  });

  it("decimates a 120 Hz display to every other frame", () => {
    const sim = new SimHost(1000 / 120);
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(2000);
    const g = gaps(ticks.map((tick) => tick.t));
    for (const gap of g) expect(gap).toBeCloseTo(2000 / 120, 6);
    expect(ticks.length).toBeGreaterThanOrEqual(118);
  });

  it("averages close to 60 Hz on displays whose rate is not a multiple of 60", () => {
    // Every rate from 61 Hz averages 60 Hz except 100-120 Hz panels whose
    // frames are closer than MIN_GAP_MS (110 Hz gives 55). A 64.5 Hz source
    // stands for WebKit's 15 ms worker animation timer.
    for (const hz of [61, 64.5, 72, 75, 85, 90, 100, 144, 165, 240]) {
      const sim = new SimHost(1000 / hz);
      const { clock, ticks } = record(sim, true);
      clock.start();
      sim.run(10_000);
      const rate = ticks.length / 10;
      expect(rate, `${hz} Hz display`).toBeGreaterThanOrEqual(59);
      expect(rate, `${hz} Hz display`).toBeLessThanOrEqual(60.5);
      // Every vblank is a display frame, and none closer than 0.6 periods.
      expect(ticks.every((tick) => tick.source === "frame")).toBe(true);
      for (const gap of gaps(ticks.map((tick) => tick.t))) {
        expect(gap).toBeGreaterThanOrEqual(VBLANK_PERIOD_MS * 0.6 - 1e-9);
      }
    }
  });

  it("follows a display throttled below 60 Hz frame by frame", () => {
    const sim = new SimHost(1000 / 30);
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(2000);
    expect(ticks.every((tick) => tick.source === "frame")).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(58);
    expect(ticks.length).toBeLessThanOrEqual(61);
  });

  it("falls back to the mode's rate while frames stop (a hidden page) and returns to frames", () => {
    const sim = new SimHost(VBLANK_PERIOD_MS);
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(1000);
    const visibleTicks = ticks.length;
    sim.visible = false;
    sim.run(3000);
    const hidden = ticks.slice(visibleTicks);
    expect(hidden.every((tick) => tick.source === "timer")).toBe(true);
    // The first timer vblank comes ABSENT_MS after the last frame; then 60 Hz.
    expect(hidden[0]!.t - ticks[visibleTicks - 1]!.t).toBeCloseTo(VBLANK_ABSENT_MS, 0);
    expect(hidden.length).toBeGreaterThanOrEqual(118);
    expect(hidden.length).toBeLessThanOrEqual(120);
    expect(clock.followsDisplay).toBe(false);
    sim.visible = true;
    sim.run(4000);
    const back = ticks.slice(visibleTicks + hidden.length);
    expect(back.at(-1)!.source).toBe("frame");
    expect(back.filter((tick) => tick.source === "timer").length).toBeLessThanOrEqual(1);
    expect(clock.followsDisplay).toBe(true);
    // No two vblanks closer than 0.6 periods across both transitions.
    for (const gap of gaps(ticks.map((tick) => tick.t))) {
      expect(gap).toBeGreaterThanOrEqual(VBLANK_PERIOD_MS * 0.6 - 1e-9);
    }
  });

  it("never gives two vblanks for one display frame when frame callbacks run late", () => {
    const sim = new SimHost(VBLANK_PERIOD_MS);
    sim.lagMs = 9.5;
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(2000);
    expect(new Set(ticks.map((tick) => tick.t)).size).toBe(ticks.length);
    for (const gap of gaps(ticks.map((tick) => tick.t))) {
      expect(gap).toBeGreaterThanOrEqual(VBLANK_PERIOD_MS * 0.6 - 1e-9);
    }
    expect(ticks.length).toBeGreaterThanOrEqual(118);
  });

  it("uses the timer when the worker cannot animate", () => {
    const sim = new SimHost(VBLANK_PERIOD_MS);
    sim.throwOnRequest = true;
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(1000);
    expect(ticks.length).toBe(60);
    expect(ticks.every((tick) => tick.source === "timer")).toBe(true);
  });

  it("stop() cancels its timer and frame request", () => {
    const sim = new SimHost(VBLANK_PERIOD_MS);
    const { clock, ticks } = record(sim, true);
    clock.start();
    sim.run(100);
    clock.stop();
    expect(sim.timers.size).toBe(0);
    expect(sim.frames.size).toBe(0);
    const before = ticks.length;
    sim.run(1000);
    expect(ticks.length).toBe(before);
    expect(clock.running).toBe(false);
  });

  it("asks for one frame at a time and no timer wakeups while frames flow", () => {
    const sim = new SimHost(VBLANK_PERIOD_MS);
    const host = sim.host(true);
    let timerFires = 0;
    const counting = {
      ...host,
      setTimer: (cb: () => void, d: number) => host.setTimer(() => { timerFires++; cb(); }, d),
    };
    const clock = new VblankClock(counting, () => {});
    clock.start();
    sim.run(5000);
    expect(timerFires).toBe(0);
    expect(sim.frames.size).toBe(1);
    expect(sim.frameRequests).toBeLessThanOrEqual(Math.ceil(5000 / VBLANK_PERIOD_MS) + 1);
    clock.stop();
  });
});
