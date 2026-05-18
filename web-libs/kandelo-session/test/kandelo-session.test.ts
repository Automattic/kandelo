import { describe, it, expect, vi } from "vitest";
import {
  LiveKernelHost,
  type BootDescriptor,
  type KernelHost,
  type MachineStatus,
  type ProcessEvent,
} from "../src/kernel-host";
import { MockKernelHost } from "../../../apps/browser-demos/pages/kandelo/kernel-host/mock";

/**
 * Vitest coverage for the kandelo-session kernel-host surface:
 *
 *   1. LiveKernelHost — status, dmesg, process events, descriptor
 *      cloning, lifecycle hooks, and gallery defaults.
 *
 *   2. MockKernelHost — boot replay timing, full lifecycle, snapshot
 *      mode pick from fixture state, and a structural assertion that
 *      the mock implements the full KernelHost interface.
 *
 * Things explicitly NOT covered here (see
 * docs/plans/2026-05-14-kandelo-ui-followups.md): boot-descriptor
 * encode/decode round-trip + caps validation, snapshot mode-picker
 * boundaries, React hook tests, browser-side PTY/framebuffer/focus.
 */

const DUMMY_DESCRIPTOR: BootDescriptor = {
  version: 1,
  id: "test",
  title: "Test machine",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@sha256:0123456789abcdef",
    memoryPages: 1024,
    features: ["pty"],
    time: "real",
  },
  packages: [],
  mounts: [
    { path: "/", source: "image", ref: "rootfs@sha256:abc123", readonly: true },
    { path: "/tmp", source: "scratch", ephemeral: true },
  ],
  boot: { argv: ["/bin/sh"], cwd: "/", env: { HOME: "/" } },
};

// ── LiveKernelHost ─────────────────────────────────────────────────────

describe("LiveKernelHost: status", () => {
  it("returns the initial status from the constructor option", () => {
    const host = new LiveKernelHost({ status: "running" });
    expect(host.getStatus()).toBe("running");
  });

  it("defaults to 'idle' when no status is provided", () => {
    const host = new LiveKernelHost();
    expect(host.getStatus()).toBe("idle");
  });

  it("fires subscribers on setStatus and returns an unsubscribe", () => {
    const host = new LiveKernelHost({ status: "idle" });
    const seen: MachineStatus[] = [];
    const off = host.subscribeStatus((s) => seen.push(s));
    host.setStatus("booting");
    host.setStatus("running");
    off();
    host.setStatus("halted");
    expect(seen).toEqual(["booting", "running"]);
  });

  it("does NOT fire when setStatus is called with the current value", () => {
    const host = new LiveKernelHost({ status: "running" });
    const cb = vi.fn();
    host.subscribeStatus(cb);
    host.setStatus("running");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("LiveKernelHost: dmesg ring", () => {
  it("collects pushed lines into history", () => {
    const host = new LiveKernelHost();
    host.pushDmesg({ t: 0, level: "info", facility: "kernel", msg: "first" });
    host.pushDmesg({ t: 12, level: "warn", facility: "init", msg: "second" });
    const hist = host.dmesgHistory();
    expect(hist).toHaveLength(2);
    expect(hist[0].msg).toBe("first");
    expect(hist[1].level).toBe("warn");
  });

  it("fires subscribers on each pushed line and returns an unsubscribe", () => {
    const host = new LiveKernelHost();
    const seen: string[] = [];
    const off = host.subscribeDmesg((l) => seen.push(l.msg));
    host.pushDmesg({ t: 0, level: "info", facility: "k", msg: "a" });
    host.pushDmesg({ t: 1, level: "info", facility: "k", msg: "b" });
    off();
    host.pushDmesg({ t: 2, level: "info", facility: "k", msg: "c" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("history is a snapshot — mutating the returned array doesn't affect the ring", () => {
    const host = new LiveKernelHost();
    host.pushDmesg({ t: 0, level: "info", facility: "k", msg: "a" });
    const snap = host.dmesgHistory();
    snap.push({ t: 9, level: "err", facility: "k", msg: "fake" });
    expect(host.dmesgHistory()).toHaveLength(1);
  });
});

describe("LiveKernelHost: process events", () => {
  it("fans out emitProcessEvent to subscribers in order", () => {
    const host = new LiveKernelHost();
    const eventsA: ProcessEvent[] = [];
    const eventsB: ProcessEvent[] = [];
    host.subscribeProcessEvents((e) => eventsA.push(e));
    host.subscribeProcessEvents((e) => eventsB.push(e));
    host.emitProcessEvent({ kind: "spawn", pid: 42 });
    host.emitProcessEvent({ kind: "exit", pid: 42, exitStatus: 0 });
    expect(eventsA).toEqual([
      { kind: "spawn", pid: 42 },
      { kind: "exit", pid: 42, exitStatus: 0 },
    ]);
    expect(eventsB).toEqual(eventsA);
  });

  it("subscribe returns an unsubscribe that detaches that listener only", () => {
    const host = new LiveKernelHost();
    const a = vi.fn();
    const b = vi.fn();
    const offA = host.subscribeProcessEvents(a);
    host.subscribeProcessEvents(b);
    offA();
    host.emitProcessEvent({ kind: "spawn", pid: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe("LiveKernelHost: descriptor", () => {
  it("getBootDescriptor returns a deep clone — callers can't mutate internal state", () => {
    const host = new LiveKernelHost({ descriptor: DUMMY_DESCRIPTOR });
    const fetched = host.getBootDescriptor();
    fetched.mounts.push({ path: "/sneaky", source: "scratch" });
    fetched.boot.argv.push("--rogue");
    const second = host.getBootDescriptor();
    expect(second.mounts).toHaveLength(DUMMY_DESCRIPTOR.mounts.length);
    expect(second.boot.argv).toEqual(["/bin/sh"]);
  });

  it("setDescriptor replaces the descriptor without firing status", () => {
    const host = new LiveKernelHost({ status: "running" });
    const cb = vi.fn();
    host.subscribeStatus(cb);
    const next: BootDescriptor = {
      ...DUMMY_DESCRIPTOR,
      id: "next",
      title: "Next machine",
    };
    host.setDescriptor(next);
    expect(host.getBootDescriptor().id).toBe("next");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("LiveKernelHost: descriptor + gallery lifecycle defaults", () => {
  it("applyBootDescriptor stores the descriptor when no live apply hook is installed", async () => {
    const host = new LiveKernelHost();
    await host.applyBootDescriptor(DUMMY_DESCRIPTOR);
    expect(host.getBootDescriptor().id).toBe(DUMMY_DESCRIPTOR.id);
  });

  it("applyBootDescriptor delegates to the installed live apply hook", async () => {
    const applyBootDescriptor = vi.fn(async (desc: BootDescriptor, host: LiveKernelHost) => {
      host.setDescriptor(desc);
      host.setStatus("running");
    });
    const host = new LiveKernelHost({ applyBootDescriptor });
    await host.applyBootDescriptor(DUMMY_DESCRIPTOR);
    expect(applyBootDescriptor).toHaveBeenCalledOnce();
    expect(host.getStatus()).toBe("running");
  });

  it("halt sets status to halted", async () => {
    const host = new LiveKernelHost({ status: "running" });
    await host.halt();
    expect(host.getStatus()).toBe("halted");
  });

  it("galleryQuery returns installed presets and still leaves saveCurrentToGallery as a stub", async () => {
    const host = new LiveKernelHost({
      galleryItems: [{
        id: "shell",
        title: "Shell",
        summary: "Shell preset",
        base: "kandelo:shell@abi8",
        packages: [],
        bootCommand: ["/bin/sh"],
        accent: "#dc6529",
        glyph: "sh",
        estimatedUrlBytes: 10,
      }],
    });
    expect(await host.galleryQuery({ tab: "presets" })).toHaveLength(1);
    expect(await host.galleryQuery({ tab: "recent" })).toEqual([]);
    await expect(host.saveCurrentToGallery("x")).rejects.toThrow("not implemented yet");
  });
});

describe("LiveKernelHost: snapshot delegates to takeSnapshot", () => {
  it("returns a Snapshot whose descriptor matches the host's", async () => {
    const host = new LiveKernelHost({ descriptor: DUMMY_DESCRIPTOR });
    const snap = await host.snapshot();
    expect(snap.descriptor.id).toBe(DUMMY_DESCRIPTOR.id);
    expect(snap.mode).toBe("preset"); // no inline-overlay → preset
    expect(snap.byteSize).toBeGreaterThan(0);
  });

  it("honors preferMode override", async () => {
    const host = new LiveKernelHost({ descriptor: DUMMY_DESCRIPTOR });
    const snap = await host.snapshot({ preferMode: "manifest" });
    expect(snap.mode).toBe("manifest");
    expect(snap.reason).toContain("Mode forced to manifest");
  });
});

// ── MockKernelHost ─────────────────────────────────────────────────────

describe("MockKernelHost: KernelHost contract", () => {
  it("structurally satisfies KernelHost", () => {
    // Compile-time check: if MockKernelHost grows out of sync with
    // KernelHost the assignment below fails tsc. Runtime body is just
    // a smoke test that an instance is constructible.
    const host: KernelHost = new MockKernelHost();
    expect(typeof host.getStatus).toBe("function");
    expect(typeof host.subscribeStatus).toBe("function");
    expect(typeof host.snapshot).toBe("function");
    expect(typeof host.attachFramebuffer).toBe("function");
  });
});

describe("MockKernelHost: boot replay", () => {
  it("starts in 'booting' and transitions to 'running' after the boot log replays", async () => {
    // bootSpeed=1000 → 2240ms boot log compresses to ~2.2ms; add the
    // 80ms tail wait and the transition should hit inside ~150ms.
    const host = new MockKernelHost({ status: "booting", bootSpeed: 1000 });
    expect(host.getStatus()).toBe("booting");
    const reached: MachineStatus[] = [];
    await new Promise<void>((resolve) => {
      const off = host.subscribeStatus((s) => {
        reached.push(s);
        if (s === "running") { off(); resolve(); }
      });
    });
    expect(reached).toContain("running");
    expect(host.getStatus()).toBe("running");
  });

  it("dmesg ring fills as the boot log replays", async () => {
    const host = new MockKernelHost({ status: "booting", bootSpeed: 1000 });
    // Wait for full boot
    await new Promise<void>((resolve) => {
      const off = host.subscribeStatus((s) => {
        if (s === "running") { off(); resolve(); }
      });
    });
    const hist = host.dmesgHistory();
    // The fixture has 56 lines (the static rootfs boot log). Don't pin
    // the exact count — pin a sensible floor so the assertion survives
    // future tweaks to the fixture.
    expect(hist.length).toBeGreaterThan(10);
    // First few lines are kernel-facility info messages.
    expect(hist[0].facility).toBe("kernel");
  });
});

describe("MockKernelHost: snapshot mode picker", () => {
  it("picks 'delta' for the default CURRENT_DESCRIPTOR_TEMPLATE (has inline overlay)", async () => {
    // The fixture descriptor has an inline-overlay with a small 'data'
    // field, so the heuristic in takeSnapshot picks 'delta'.
    const host = new MockKernelHost({ status: "running" });
    const snap = await host.snapshot();
    expect(snap.mode).toBe("delta");
    expect(snap.reason).toMatch(/delta/i);
  });

  it("picks 'preset' for a descriptor with no inline-overlay", async () => {
    const host = new MockKernelHost({
      status: "running",
      descriptor: DUMMY_DESCRIPTOR,
    });
    const snap = await host.snapshot();
    expect(snap.mode).toBe("preset");
  });
});

describe("MockKernelHost: gallery + inspector data", () => {
  it("galleryQuery({tab:'presets'}) returns the preset library", async () => {
    const host = new MockKernelHost({ status: "running" });
    const items = await host.galleryQuery({ tab: "presets" });
    expect(items.length).toBeGreaterThan(0);
    // Each item should have the shape the UI expects.
    expect(items[0]).toHaveProperty("id");
    expect(items[0]).toHaveProperty("title");
    expect(items[0]).toHaveProperty("accent");
    expect(items[0]).toHaveProperty("estimatedUrlBytes");
  });

  it("galleryQuery filters by query string", async () => {
    const host = new MockKernelHost({ status: "running" });
    const all = await host.galleryQuery({ tab: "presets" });
    const wp = await host.galleryQuery({ tab: "presets", q: "wordpress" });
    expect(wp.length).toBeLessThan(all.length);
    expect(wp.every((i) => /wordpress/i.test(i.title) || /wordpress/i.test(i.summary))).toBe(true);
  });

  it("readDir('/') returns the fixture VFS tree", async () => {
    const host = new MockKernelHost({ status: "running" });
    const root = await host.readDir("/");
    expect(root.length).toBeGreaterThan(0);
    const names = root.map((e) => e.name);
    expect(names).toContain("bin");
    expect(names).toContain("etc");
  });

  it("enumProcs / getMounts / getKernelState return fixtures", async () => {
    const host = new MockKernelHost({ status: "running" });
    const [procs, mounts, kstate] = await Promise.all([
      host.enumProcs(),
      host.getMounts(),
      host.getKernelState(),
    ]);
    expect(procs.length).toBeGreaterThan(0);
    expect(mounts.length).toBeGreaterThan(0);
    expect(kstate.length).toBeGreaterThan(0);
    expect(procs[0]).toHaveProperty("pid");
    expect(mounts[0]).toHaveProperty("target");
  });
});
