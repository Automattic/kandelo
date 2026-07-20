import { describe, it, expect, vi } from "vitest";
import {
  LiveKernelHost,
  type BootDescriptor,
  type FileSystemLike,
  type LazyDownloadEvent,
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
import { parseKandeloShellConfig } from "../src/shell-config";

/**
 * Vitest coverage for the kandelo-session kernel-host surface:
 *
 *   1. LiveKernelHost — status, dmesg, process events, descriptor
 *      cloning, lifecycle hooks, and gallery defaults.
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

const INLINE_OVERLAY_DESCRIPTOR: BootDescriptor = {
  ...DUMMY_DESCRIPTOR,
  id: "delta",
  mounts: [
    ...DUMMY_DESCRIPTOR.mounts,
    { path: "/home/user", source: "inline-overlay", data: "abc123" },
  ],
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

describe("LiveKernelHost: lazy download events", () => {
  it("fans out kernel lazy download events and records history", () => {
    let kernelCb: ((event: LazyDownloadEvent) => void) | null = null;
    const offKernel = vi.fn();
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void) {
          kernelCb = cb;
          return offKernel;
        },
      } as any,
    });
    const seen: LazyDownloadEvent[] = [];
    host.subscribeLazyDownloads((event) => seen.push(event));

    const event: LazyDownloadEvent = {
      id: "file:7",
      kind: "file",
      status: "progress",
      url: "/assets/node.wasm",
      path: "/usr/bin/node",
      loadedBytes: 512,
      totalBytes: 1024,
      t: 10,
    };
    kernelCb?.(event);

    expect(seen).toEqual([event]);
    expect(host.lazyDownloadHistory()).toEqual([event]);
    host.detachKernel();
    expect(offKernel).toHaveBeenCalledOnce();
  });

  it("clears lazy download history when the kernel is replaced", () => {
    let kernelCb: ((event: LazyDownloadEvent) => void) | null = null;
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void) {
          kernelCb = cb;
          return vi.fn();
        },
      } as any,
    });

    kernelCb?.({
      id: "file:7",
      kind: "file",
      status: "complete",
      url: "/assets/curl.wasm",
      path: "/usr/bin/curl",
      loadedBytes: 1024,
      totalBytes: 1024,
      t: 10,
    });
    expect(host.lazyDownloadHistory()).toHaveLength(1);

    host.attachKernel({
      fs: makeFs({ "/etc/passwd": "" }),
    } as any);

    expect(host.lazyDownloadHistory()).toEqual([]);
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

describe("LiveKernelHost: shell command queue", () => {
  it("uses the worker-returned pid for a transferred shell binary", async () => {
    const outputPids: number[] = [];
    const writePids: number[] = [];
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawn(
          _programBytes: ArrayBuffer,
          _argv: string[],
          options?: { onStarted?: (pid: number) => void | Promise<void> },
        ) {
          void options?.onStarted?.(37);
          return new Promise<number>(() => {});
        },
        onPtyOutput(pid: number) {
          outputPids.push(pid);
        },
        ptyResize() {},
        ptyWrite(pid: number) {
          writePids.push(pid);
        },
      } as any,
    });
    host.setDefaultShell({
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
    });

    const pty = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    pty.write("echo ok\n");

    expect(outputPids).toEqual([37]);
    expect(writePids).toEqual([37]);
  });

  it("starts an image-owned shell from the VFS without redundant program bytes", async () => {
    const spawnFromVfs = vi.fn(async () => ({
      pid: 41,
      exit: new Promise<number>(() => {}),
    }));
    const spawn = vi.fn();
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawn,
        spawnFromVfs,
        onPtyOutput() {},
        ptyResize() {},
        ptyWrite() {},
      } as any,
    });
    host.setDefaultShell({
      programPath: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
      uid: 1000,
      gid: 1000,
    });

    await host.attachPty("/dev/pts/0", { cols: 100, rows: 30 });

    expect(spawnFromVfs).toHaveBeenCalledWith(
      "/home/linuxbrew/.linuxbrew/bin/dash",
      ["dash", "-l", "-i"],
      expect.objectContaining({
        pty: true,
        cwd: "/home/user",
        uid: 1000,
        gid: 1000,
        ptyCols: 100,
        ptyRows: 30,
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a default shell without a VFS path or fallback bytes", () => {
    const host = new LiveKernelHost();
    expect(() => host.setDefaultShell({
      argv: ["sh", "-i"],
    })).toThrow("requires programPath or programBytes");
  });

  it("reports when a VFS-only shell is used with a kernel that cannot spawn it", async () => {
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawn: vi.fn(),
        onPtyOutput() {},
        ptyResize() {},
        ptyWrite() {},
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/sh",
      argv: ["sh", "-i"],
    });

    await expect(host.attachPty("/dev/pts/0", { cols: 80, rows: 24 }))
      .rejects.toThrow("does not support spawnFromVfs");
  });

  it("does not treat heredoc continuation prompts as command completion", async () => {
    const encoder = new TextEncoder();
    let onOutput: ((data: Uint8Array) => void) | null = null;
    let releaseFinalPrompt!: () => void;
    const finalPrompt = new Promise<void>((resolve) => {
      releaseFinalPrompt = resolve;
    });

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => ({ pid: 1, exit: new Promise<number>(() => {}) }),
        onPtyOutput(_pid: number, callback: (data: Uint8Array) => void) {
          onOutput = callback;
          callback(encoder.encode("kandelo$ "));
        },
        ptyResize() {},
        ptyWrite(_pid: number, _data: Uint8Array) {
          onOutput?.(encoder.encode("cat > /tmp/k <<'EOF'\n> echo ok\n> "));
          void finalPrompt.then(() => {
            onOutput?.(encoder.encode("EOF\nok\nkandelo$ "));
          });
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
    });

    let completed = false;
    const command = host.runShellCommand("cat > /tmp/k <<'EOF'\necho ok\nEOF");
    void command.then(() => {
      completed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseFinalPrompt();
    await command;
    expect(completed).toBe(true);
  });

  it("does not treat echoed dollar-looking input as shell readiness", async () => {
    const encoder = new TextEncoder();
    let onOutput: ((data: Uint8Array) => void) | null = null;
    let releaseFinalPrompt!: () => void;
    const finalPrompt = new Promise<void>((resolve) => {
      releaseFinalPrompt = resolve;
    });

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => ({ pid: 1, exit: new Promise<number>(() => {}) }),
        onPtyOutput(_pid: number, callback: (data: Uint8Array) => void) {
          onOutput = callback;
          callback(encoder.encode("kandelo$ "));
        },
        ptyResize() {},
        ptyWrite(_pid: number, _data: Uint8Array) {
          onOutput?.(encoder.encode("printf 'literal$ '\n"));
          void finalPrompt.then(() => {
            onOutput?.(encoder.encode("literal$ \nkandelo$ "));
          });
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
    });

    let completed = false;
    const command = host.runShellCommand("printf 'literal$ '");
    void command.then(() => {
      completed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseFinalPrompt();
    await command;
    expect(completed).toBe(true);
  });

  it("serializes concurrent PTY attaches for the same terminal session", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const callbacks = new Map<number, (data: Uint8Array) => void>();
    const writes: Array<{ pid: number; text: string }> = [];
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let spawnCalls = 0;
    let nextPid = 1;

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => {
          spawnCalls++;
          await spawnGate;
          const pid = nextPid++;
          return { pid, exit: new Promise<number>(() => {}) };
        },
        onPtyOutput(pid: number, callback: (data: Uint8Array) => void) {
          callbacks.set(pid, callback);
          callback(encoder.encode(`spawned:${pid}\nkandelo$ `));
        },
        ptyResize() {},
        ptyWrite(pid: number, data: Uint8Array) {
          const text = decoder.decode(data);
          writes.push({ pid, text });
          callbacks.get(pid)?.(encoder.encode(`${text}done\nkandelo$ `));
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
    });

    const visibleAttach = host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    await Promise.resolve();
    const guideCommand = host.runShellCommand("printf guide-visible");
    await Promise.resolve();
    expect(spawnCalls).toBe(1);

    releaseSpawn();
    const visiblePty = await visibleAttach;
    await guideCommand;

    let visibleText = "";
    visiblePty.onData((bytes) => {
      visibleText += decoder.decode(bytes);
    });
    expect(spawnCalls).toBe(1);
    expect(writes).toEqual([{ pid: 1, text: "printf guide-visible\n" }]);
    expect(visibleText).toContain("spawned:1");
    expect(visibleText).toContain("printf guide-visible");
    expect(visibleText).toContain("done");
  });

  it("respawns stale PTY sessions without disconnecting existing listeners", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const callbacks = new Map<number, (data: Uint8Array) => void>();
    const livePids = new Set<number>();
    const writes: number[] = [];
    let nextPid = 1;

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => {
          const pid = nextPid++;
          livePids.add(pid);
          return { pid, exit: new Promise<number>(() => {}) };
        },
        enumProcs: async () => [
          { pid: 99, ppid: 0, uid: 0, gid: 0, vsizeBytes: 1024, state: "S", comm: "dinit", cmdline: "dinit" },
          ...Array.from(livePids).map((pid) => ({
            pid,
            ppid: 99,
            uid: 1000,
            gid: 1000,
            vsizeBytes: 1024,
            state: "S",
            comm: "bash",
            cmdline: "bash -l -i",
          })),
        ],
        onPtyOutput(pid: number, callback: (data: Uint8Array) => void) {
          callbacks.set(pid, callback);
          callback(encoder.encode(`spawned:${pid}\nkandelo$ `));
        },
        ptyResize() {},
        ptyWrite(pid: number, data: Uint8Array) {
          writes.push(pid);
          callbacks.get(pid)?.(encoder.encode(`write:${pid}:${decoder.decode(data)}kandelo$ `));
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
    });

    const firstHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    let seen = "";
    firstHandle.onData((bytes) => {
      seen += decoder.decode(bytes);
    });
    expect(seen).toContain("spawned:1");

    livePids.delete(1);
    const secondHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    secondHandle.write("echo second\n");
    expect(writes).toEqual([2]);
    expect(seen).toContain("spawned:2");
    expect(seen).toContain("write:2:echo second");

    firstHandle.write("echo first\n");
    expect(writes).toEqual([2, 2]);
    expect(seen).toContain("write:2:echo first");
  });

  it("keeps PTY listeners connected when an exited shell respawns", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const callbacks = new Map<number, (data: Uint8Array) => void>();
    const exitResolvers = new Map<number, (status: number) => void>();
    const writes: number[] = [];
    let nextPid = 1;

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => {
          const pid = nextPid++;
          const exit = new Promise<number>((resolve) => {
            exitResolvers.set(pid, resolve);
          });
          return { pid, exit };
        },
        onPtyOutput(pid: number, callback: (data: Uint8Array) => void) {
          callbacks.set(pid, callback);
          callback(encoder.encode(`spawned:${pid}\nkandelo$ `));
        },
        ptyResize() {},
        ptyWrite(pid: number, data: Uint8Array) {
          writes.push(pid);
          callbacks.get(pid)?.(encoder.encode(`write:${pid}:${decoder.decode(data)}kandelo$ `));
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/user",
    });

    const firstHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    let seen = "";
    firstHandle.onData((bytes) => {
      seen += decoder.decode(bytes);
    });
    expect(seen).toContain("spawned:1");

    exitResolvers.get(1)?.(0);
    await Promise.resolve();
    await Promise.resolve();

    const secondHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    secondHandle.write("echo after-exit\n");
    expect(writes).toEqual([2]);
    expect(seen).toContain("spawned:2");
    expect(seen).toContain("write:2:echo after-exit");

    firstHandle.write("echo old-handle\n");
    expect(writes).toEqual([2, 2]);
    expect(seen).toContain("write:2:echo old-handle");
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
  it("marks a configured web preview available only after the HTTP response is ready", () => {
    const host = new LiveKernelHost();
    const seen: boolean[] = [];
    host.subscribeSurfaceAvailability((state) => seen.push(state.web));

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "starting",
      message: "Waiting for HTTP response",
    });

    expect(host.getSurfaceAvailability().web).toBe(false);
    expect(seen).toEqual([]);

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "running",
      message: "HTTP bridge ready",
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

  it("tracks web preview pending requests without affecting availability", () => {
    const host = new LiveKernelHost();
    const seen: number[] = [];
    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "running",
    });
    host.subscribeWebPreview((state) => {
      seen.push(state?.pendingRequests ?? 0);
    });

    host.setWebPreviewPendingRequests(2);

    expect(host.getWebPreview()?.pendingRequests).toBe(2);
    expect(host.getSurfaceAvailability().web).toBe(true);
    expect(seen).toEqual([2]);

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "running",
      message: "HTTP bridge ready",
    });

    expect(host.getWebPreview()?.pendingRequests).toBe(2);

    host.setWebPreviewPendingRequests(-1);

    expect(host.getWebPreview()?.pendingRequests).toBe(0);
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

  it("picks 'delta' when the descriptor carries a small inline overlay", async () => {
    const host = new LiveKernelHost({ descriptor: INLINE_OVERLAY_DESCRIPTOR });
    const snap = await host.snapshot();
    expect(snap.mode).toBe("delta");
    expect(snap.reason).toMatch(/delta/i);
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
    expect(guide?.title).toBe("SpiderMonkey Node.js demo");
    expect(guide?.groups?.[0].actions.map((action) => action.id)).toContain("install-cowsay");
    expect(builtinDemoGuide("wordpress-sqlite")?.groups?.[0].actions[0]).toMatchObject({
      id: "wp-admin-login",
      kind: "web.wordpressLogin",
    });
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

describe("Kandelo default shell image configuration", () => {
  it("accepts one exact VFS executable and interactive argv", () => {
    expect(parseKandeloShellConfig(JSON.stringify({
      version: 1,
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    }))).toEqual({
      version: 1,
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    });
  });

  it("rejects executable paths that can escape or drift", () => {
    expect(() => parseKandeloShellConfig(JSON.stringify({
      version: 1,
      path: "/home/linuxbrew/../bin/dash",
      argv: ["dash", "-l", "-i"],
    }))).toThrow("normalized");
    expect(() => parseKandeloShellConfig(JSON.stringify({
      version: 1,
      path: "home/linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    }))).toThrow("absolute guest file path");
  });

  it("rejects executable fields and oversized argv", () => {
    expect(() => parseKandeloShellConfig(JSON.stringify({
      version: 1,
      path: "/bin/sh",
      argv: ["sh", "-i"],
      env: { PATH: "/tmp" },
    }))).toThrow("exactly version, path, and argv");
    expect(() => parseKandeloShellConfig(JSON.stringify({
      version: 1,
      path: "/bin/sh",
      argv: Array.from({ length: 65 }, () => "sh"),
    }))).toThrow("exceeds 64 arguments");
  });

  it("returns null for an unsupported version", () => {
    expect(parseKandeloShellConfig(JSON.stringify({
      version: 2,
      path: "/bin/sh",
      argv: ["sh", "-i"],
    }))).toBeNull();
  });
});
