import { describe, it, expect, vi } from "vitest";
import {
  LiveKernelHost,
  type BootDescriptor,
  type FileSystemLike,
  type KernelHost,
  type MachineStatus,
  type ProcessEvent,
} from "../src/kernel-host";
import {
  genericDemoPresentation,
  parseKandeloDemoConfig,
  resolveDemoAssets,
  resolveDemoGuide,
  resolveDemoPresentation,
} from "../src/demo-config";
import {
  DOOM_COMMAND,
  builtinDemoAssets,
  builtinDemoGuide,
  builtinDemoPresentation,
  nodeGuide,
} from "../src/demo-guides";
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

function makeFs(files: Record<string, string>): FileSystemLike {
  const encoder = new TextEncoder();
  const entries = new Map(
    Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]),
  );
  const handles = new Map<number, { data: Uint8Array; offset: number }>();
  let nextHandle = 1;

  const fs: FileSystemLike = {
    stat(path: string) {
      const data = entries.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return { mode: 0o100644, size: data.byteLength, mtimeMs: 0, uid: 0, gid: 0 };
    },
    open(path: string) {
      const data = entries.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      const handle = nextHandle++;
      handles.set(handle, { data, offset: 0 });
      return handle;
    },
    read(handle: number, buffer: Uint8Array, offset: number | null, length: number) {
      const entry = handles.get(handle);
      if (!entry) throw new Error(`EBADF: ${handle}`);
      const start = offset ?? 0;
      const available = entry.data.byteLength - entry.offset;
      const n = Math.max(0, Math.min(length, available, buffer.byteLength - start));
      if (n > 0) {
        buffer.set(entry.data.subarray(entry.offset, entry.offset + n), start);
        entry.offset += n;
      }
      return n;
    },
    close(handle: number) {
      handles.delete(handle);
      return 0;
    },
    readlink(path: string) {
      throw new Error(`EINVAL: ${path}`);
    },
    opendir(path: string) {
      throw new Error(`ENOTDIR: ${path}`);
    },
    readdir() {
      return null;
    },
    closedir() {},
  };
  return fs;
}

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

describe("LiveKernelHost: process listing", () => {
  it("resolves process snapshot UIDs through /etc/passwd", async () => {
    const fs = makeFs({
      "/etc/passwd": [
        "root:x:0:0:root:/root:/bin/sh",
        "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin",
        "mysql:x:101:101:mysql:/var/lib/mysql:/usr/sbin/nologin",
        "",
      ].join("\n"),
    });
    const host = new LiveKernelHost({
      kernel: {
        fs,
        nextPid: 1,
        enumProcs: async () => [
          { pid: 1, ppid: 0, uid: 0, gid: 0, vsizeBytes: 1024, state: "S", comm: "dinit", cmdline: "/sbin/dinit" },
          { pid: 2, ppid: 1, uid: 33, gid: 33, vsizeBytes: 2048, state: "S", comm: "php-fpm", cmdline: "php-fpm: pool www" },
          { pid: 3, ppid: 1, uid: 4242, gid: 4242, vsizeBytes: 4096, state: "S", comm: "worker", cmdline: "worker" },
        ],
      } as any,
    });

    const procs = await host.enumProcs();
    expect(procs.map((p) => p.user)).toEqual(["root", "www-data", "4242"]);
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

  it("setGalleryItems replaces presets and notifies gallery subscribers", async () => {
    const host = new LiveKernelHost();
    const cb = vi.fn();
    const off = host.subscribeGallery(cb);
    host.setGalleryItems([{
      id: "node",
      title: "Node",
      summary: "Node preset",
      base: "kandelo:shell@abi8",
      packages: ["node@1"],
      bootCommand: ["node"],
      accent: "#43853d",
      glyph: "js",
      estimatedUrlBytes: 20,
    }]);
    off();
    host.setGalleryItems([]);

    expect(cb).toHaveBeenCalledOnce();
    const items = await host.galleryQuery({ tab: "presets" });
    expect(items).toHaveLength(0);
  });
});

describe("LiveKernelHost: surface availability", () => {
  it("marks a configured web preview available before the HTTP response is ready", () => {
    const host = new LiveKernelHost();
    const seen: boolean[] = [];
    host.subscribeSurfaceAvailability((state) => seen.push(state.web));

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "starting",
      message: "Waiting for HTTP response",
    });

    expect(host.getSurfaceAvailability().web).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("clears web availability when the preview is removed", () => {
    const host = new LiveKernelHost();
    host.setWebPreview({ label: "WordPress", url: "/app/", status: "error" });
    host.setWebPreview(null);

    expect(host.getSurfaceAvailability().web).toBe(false);
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

describe("Kandelo demo config", () => {
  it("provides generic presentation defaults for web-backed profiles", () => {
    expect(genericDemoPresentation("web")).toMatchObject({
      bootPrimary: "syslog",
      runningPrimary: ["web", "terminal", "syslog"],
      terminalAccess: "drawer",
    });
  });

  it("resolves profile presentation over image defaults", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      presentation: {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      },
      profiles: {
        doom: {
          presentation: {
            bootPrimary: "syslog",
            runningPrimary: ["framebuffer", "terminal", "syslog"],
            terminalAccess: "drawer",
            internalsAccess: "drawer",
            autoCommand: "/usr/local/bin/fbdoom -iwad /doom1.wad",
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    const presentation = resolveDemoPresentation(config!, "doom");
    expect(presentation.runningPrimary).toEqual(["framebuffer", "terminal", "syslog"]);
    expect(presentation.terminalAccess).toBe("drawer");
    expect(presentation.autoCommand).toContain("fbdoom");
  });

  it("throws when profile metadata is incomplete", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        webapp: {
          presentation: {
            runningPrimary: ["web", "terminal"],
            terminalAccess: "drawer",
            internalsAccess: "drawer",
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoPresentation(config!, "webapp")).toThrow("bootPrimary");
  });

  it("throws when profile metadata has an invalid surface", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        webapp: {
          presentation: {
            bootPrimary: "syslog",
            runningPrimary: ["bogus", "web", "web", "terminal"],
            terminalAccess: "drawer",
            internalsAccess: "drawer",
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoPresentation(config!, "webapp")).toThrow("runningPrimary[0]");
  });

  it("resolves and validates profile assets", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      assets: [
        { path: "/common.dat", url: "https://example.invalid/common.dat" },
      ],
      profiles: {
        doom: {
          assets: [
            {
              path: "/doom1.wad",
              url: "https://example.invalid/doom1.wad",
              sha256: "abc123",
              mode: 420,
              devCorsProxy: true,
            },
          ],
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(resolveDemoAssets(config!, "doom")).toEqual([
      { path: "/common.dat", url: "https://example.invalid/common.dat" },
      {
        path: "/doom1.wad",
        url: "https://example.invalid/doom1.wad",
        sha256: "abc123",
        mode: 420,
        devCorsProxy: true,
      },
    ]);
  });

  it("throws when profile assets use a relative path", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        doom: {
          assets: [
            { path: "doom1.wad", url: "https://example.invalid/doom1.wad" },
          ],
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoAssets(config!, "doom")).toThrow("path must be absolute");
  });

  it("resolves and validates guide actions", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        node: {
          guide: {
            title: "Node demo",
            groups: [
              {
                title: "REPL",
                actions: [
                  {
                    id: "expr",
                    label: "Expression",
                    description: "Send input.",
                    kind: "terminal.write",
                    payload: "process.version\n",
                  },
                ],
              },
            ],
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(resolveDemoGuide(config!, "node")?.groups?.[0].actions[0].kind).toBe("terminal.write");
    expect(resolveDemoGuide(config!, "missing")).toBeNull();
  });

  it("provides built-in Node guide metadata for stale VFS images", () => {
    const guide = builtinDemoGuide("node");

    expect(guide).toEqual(nodeGuide());
    expect(guide?.title).toBe("Node.js demo");
    expect(guide?.groups?.[0].actions.map((action) => action.id)).toContain("node-version");
    expect(builtinDemoGuide("wordpress-sqlite")).toBeNull();
  });

  it("provides built-in presentation and assets for stale VFS images", () => {
    expect(builtinDemoPresentation("shell")).toMatchObject({
      runningPrimary: ["terminal", "syslog"],
    });
    expect(builtinDemoPresentation("wordpress-mariadb")).toMatchObject({
      runningPrimary: ["web", "terminal", "syslog"],
    });
    expect(builtinDemoPresentation("doom")).toMatchObject({
      runningPrimary: ["framebuffer", "terminal", "syslog"],
      autoCommand: DOOM_COMMAND,
    });

    expect(builtinDemoAssets("doom")).toEqual([
      expect.objectContaining({ path: "/doom1.wad", devCorsProxy: true }),
    ]);
    expect(builtinDemoAssets("node")).toEqual([]);
  });

  it("rejects duplicate guide action ids", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      guide: {
        title: "Bad guide",
        groups: [
          {
            title: "Actions",
            actions: [
              { id: "dup", label: "One", kind: "terminal.run", payload: "echo one" },
              { id: "dup", label: "Two", kind: "terminal.write", payload: "two\n" },
            ],
          },
        ],
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoGuide(config!, "shell")).toThrow("duplicate action id");
  });

  it("returns null when no matching presentation exists", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {},
    }));
    expect(config).not.toBeNull();

    expect(resolveDemoPresentation(config!, "missing")).toBeNull();
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
    expect(typeof host.subscribeGallery).toBe("function");
    expect(typeof host.getDemoGuide).toBe("function");
  });
});

describe("MockKernelHost: demo presentation", () => {
  it("exposes a web demo pane during boot for web-backed presets", () => {
    const host = new MockKernelHost({
      status: "booting",
      bootSpeed: 1000,
      descriptor: {
        ...DUMMY_DESCRIPTOR,
        title: "WordPress SQLite",
        runtime: {
          ...DUMMY_DESCRIPTOR.runtime,
          features: [...DUMMY_DESCRIPTOR.runtime.features, "tcp-bridge"],
        },
        packages: ["nginx@local", "wordpress@local"],
        boot: {
          ...DUMMY_DESCRIPTOR.boot,
          argv: ["/sbin/dinit", "--container"],
        },
      },
    });

    expect(host.getWebPreview()?.status).toBe("starting");
    expect(host.getSurfaceAvailability().web).toBe(true);
    expect(host.getPresentation().runningPrimary[0]).toBe("web");
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
