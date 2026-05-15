// Builds a LiveKernelHost over a real BrowserKernel. Used when the kandelo
// page is loaded with `?live=1` (otherwise the page uses MockKernelHost).
//
// Today this wires:
//   - kernel.wasm   → BrowserKernel.init()
//   - rootfs.vfs    → MemoryFileSystem.fromImage()
//   - bash.wasm     → LiveKernelHost.setDefaultShell()
//
// Once the snapshot exporter, procfs enumerator, mount introspection, etc.
// land in host/, they'll be wired here too — the page itself doesn't change.

import { BrowserKernel } from "../../../lib/browser-kernel";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  LiveKernelHost,
  type BootDescriptor,
} from "../../../../../host/src/kandelo-ui/kernel-host";

import kernelWasmUrl from "@kernel-wasm?url";
import rootfsUrl from "@rootfs-vfs?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import fbtestWasmUrl from "@binaries/programs/wasm32/fbtest.wasm?url";
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom/fbdoom.wasm?url";
import doomWadUrl from "@binaries/programs/wasm32/fbdoom/doom1.wad?url";

const LIVE_DESCRIPTOR: BootDescriptor = {
  version: 1,
  id: "live",
  title: "Live machine",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@local",
    memoryPages: 4096,
    features: ["shared-array-buffer", "pty"],
    time: "real",
  },
  packages: ["bash@local"],
  mounts: [
    { path: "/", source: "image", ref: "rootfs@local", readonly: false },
  ],
  boot: {
    argv: ["bash", "-l", "-i"],
    cwd: "/home",
    env: {
      HOME: "/home",
      TMPDIR: "/tmp",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PS1: "kandelo$ ",
    },
  },
  caps: { network: false, persistence: false, clipboard: false },
};

const SHELL_ENV: string[] = [
  "HOME=/home",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "PS1=kandelo$ ",
];

export type FbDemo = "none" | "test" | "doom";

export interface CreateLiveHostOptions {
  /**
   * Optional framebuffer demo to spawn alongside bash. The Framebuffer
   * pane auto-attaches to whichever process binds `/dev/fb0` first.
   *   - "none"  — bash only (default)
   *   - "test"  — paints a gradient and pauses; smoke test for the
   *               canvas attach path.
   *   - "doom"  — runs fbDOOM with the shareware WAD.
   */
  fb?: FbDemo;
}

export async function createLiveHost(opts: CreateLiveHostOptions = {}): Promise<LiveKernelHost> {
  const host = new LiveKernelHost({
    status: "booting",
    descriptor: LIVE_DESCRIPTOR,
  });
  const fb = opts.fb ?? "none";

  // Surface fetch progress on the dmesg ring so the UI has something
  // honest to show while the wasm binaries download.
  let t = 0;
  const tick = (msg: string) => {
    host.pushDmesg({ t: (t += 50), level: "info", facility: "kandelo", msg });
  };

  tick("loading kernel.wasm…");
  const [kernelBytes, rootfsBytes, bashBytes] = await Promise.all([
    fetch(kernelWasmUrl).then(failOn("kernel.wasm")).then((r) => r.arrayBuffer()),
    fetch(rootfsUrl).then(failOn("rootfs.vfs")).then((r) => r.arrayBuffer()),
    fetch(bashWasmUrl).then(failOn("bash.wasm")).then((r) => r.arrayBuffer()),
  ]);
  tick(`kernel.wasm: ${kib(kernelBytes.byteLength)} · rootfs.vfs: ${kib(rootfsBytes.byteLength)} · bash.wasm: ${kib(bashBytes.byteLength)}`);

  tick("mounting rootfs…");
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(rootfsBytes), {
    maxByteLength: 256 * 1024 * 1024,
  });

  tick("instantiating kernel…");
  const kernel = new BrowserKernel({
    memfs,
    // Forward process lifecycle events through to LiveKernelHost so
    // Inspector → Procs / Memory tabs can refresh on spawn/exit
    // instead of polling.
    onProcessEvent: (event) => host.emitProcessEvent(event),
  });
  await kernel.init(kernelBytes);

  host.attachKernel(kernel);
  host.setDefaultShell({
    programBytes: bashBytes,
    argv: ["bash", "-l", "-i"],
    env: SHELL_ENV,
    cwd: "/home",
  });

  // Register the framebuffer painters as lazy files so they're
  // available from the bash shell after the kandelo demo boots. The
  // kernel materializes them on first exec; we don't pay the bandwidth
  // unless the user actually runs them. Sizes come from a HEAD probe.
  await registerFbPrograms(kernel);

  // Stage doom1.wad eagerly — it's a data file fbDOOM opens at runtime,
  // and the kernel's synchronous read path can't fetch over the wire.
  // ~4MB, fast on a local dev server.
  tick("staging /doom1.wad…");
  try {
    const wadBytes = await fetch(doomWadUrl)
      .then(failOn("doom1.wad"))
      .then((r) => r.arrayBuffer());
    writeFileSync(kernel.fs, "/doom1.wad", new Uint8Array(wadBytes));
  } catch (err) {
    tick(`doom1.wad stage failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  tick("ready · /bin/bash · /usr/local/bin/{fbdoom,fbtest}");
  tick("run: fbdoom -iwad /doom1.wad");
  host.setStatus("running");

  // Spawn an optional framebuffer painter. We don't await its exit —
  // it runs concurrently with whatever the user does in bash. After it
  // exits the user can re-run it from the shell.
  if (fb === "test") {
    void spawnLazy(kernel, "/usr/local/bin/fbtest", ["fbtest"], tick);
  } else if (fb === "doom") {
    void spawnLazy(
      kernel,
      "/usr/local/bin/fbdoom",
      ["fbdoom", "-iwad", "/doom1.wad"],
      tick,
    );
  }

  return host;
}

/**
 * Lazy-register fbtest + fbdoom under /usr/local/bin so the user can run
 * them from the bash shell after the kandelo demo boots. The kernel
 * materializes them on exec — no bandwidth cost until first use.
 */
async function registerFbPrograms(kernel: BrowserKernel): Promise<void> {
  const probes: Array<{ path: string; url: string }> = [
    { path: "/usr/local/bin/fbdoom", url: fbdoomWasmUrl },
    { path: "/usr/local/bin/fbtest", url: fbtestWasmUrl },
  ];
  const sizes = await Promise.all(probes.map(async (p) => {
    try {
      const r = await fetch(p.url, { method: "HEAD" });
      if (!r.ok) return 0;
      return Number(r.headers.get("content-length") ?? 0);
    } catch {
      return 0;
    }
  }));
  const entries = probes
    .map((p, i) => ({ ...p, size: sizes[i], mode: 0o755 }))
    .filter((e) => e.size > 0);
  if (entries.length > 0) kernel.registerLazyFiles(entries);
}

/**
 * Spawn a lazy-registered program by VFS path. We can't pass programBytes
 * because the binary is lazy — the kernel materializes on exec. The
 * canonical flow is `posix_spawn(path)` from bash; for the auto-spawn at
 * boot, we still need bytes. Fetch them, then call kernel.spawn.
 */
async function spawnLazy(
  kernel: BrowserKernel,
  url: string,
  argv: string[],
  tick: (msg: string) => void,
): Promise<void> {
  try {
    const fetchUrl = url === "/usr/local/bin/fbdoom" ? fbdoomWasmUrl
      : url === "/usr/local/bin/fbtest" ? fbtestWasmUrl
      : "";
    if (!fetchUrl) throw new Error(`spawnLazy: unknown program ${url}`);
    tick(`fetching ${argv[0]}…`);
    const bytes = await fetch(fetchUrl).then(failOn(argv[0])).then((r) => r.arrayBuffer());
    tick(`spawning ${argv[0]}…`);
    await kernel.spawn(bytes, argv, { env: SHELL_ENV });
    tick(`${argv[0]} exited`);
  } catch (err) {
    tick(`${argv[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Synchronous helper to write a file into the MemoryFileSystem. The fs
// API is fd-based; write in chunks until exhausted.
function writeFileSync(fs: MemoryFileSystem, path: string, bytes: Uint8Array): void {
  const O_WRONLY = 1;
  const O_CREAT = 64;
  const O_TRUNC = 512;
  const handle = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  try {
    let off = 0;
    while (off < bytes.byteLength) {
      const n = fs.write(handle, bytes.subarray(off), null, bytes.byteLength - off);
      if (n <= 0) break;
      off += n;
    }
  } finally {
    try { fs.close(handle); } catch { /* noop */ }
  }
}

function failOn(label: string): (r: Response) => Response {
  return (r) => {
    if (!r.ok) throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}
