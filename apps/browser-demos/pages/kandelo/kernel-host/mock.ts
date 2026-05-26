// MockKernelHost — feeds the Kandelo UI from static fixtures so designers
// can iterate on the layout without a real kernel running.
//
// Port of design_handoff_kandelo_ui/reference/src/kernel-host.js's
// MockKernelHost. Where the reference reaches into window.KDATA, this
// version imports a typed `fixtures.ts` so the data shape is checked.
//
// What works here:
//   - Status, dmesg streaming (replays a fake boot log), descriptor
//     getter/setter, snapshot mode picker (heuristic on overlay size).
//   - Inspector data (procs, mounts, kstate, memmap, syscalls trace,
//     readDir against a fixture tree).
//   - attachPty: emits a scripted boot banner + shell session for the
//     Shell pane's design preview.
//
// What's deliberately omitted (returns empty / throws):
//   - applyBootDescriptor / halt / reboot do not perform any real work
//     beyond status transitions and replaying the boot log.
//   - Framebuffer attach is a no-op until we port the FbDesktop preview.

import type {
  BootDescriptor, DmesgLine, FramebufferHandle, GalleryItem, GalleryQuery,
  KernelHost, KernelStateKV, MachineStatus, MemMapEntry, MountInfo,
  DemoPresentation, ProcessEvent, ProcessInfo, PtyHandle, Snapshot, SnapshotOptions,
  SurfaceAvailability, SyscallEvent, SyscallFilter, VfsDirent, WebPreviewState,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { DemoGuideConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { genericDemoPresentation } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { takeSnapshot } from "../../../../../web-libs/kandelo-session/src/snapshot";
import {
  BOOT_LOG, KSTATE, MEMMAP, MOUNTS, PROCS, SHELL_SESSION, SYSCALLS,
  VFS_ROOT, PRESET_LIBRARY, CURRENT_DESCRIPTOR_TEMPLATE,
  type VfsNode,
} from "../fixtures";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Listener<T> = (arg: T) => void;
class ListenerSet<T> {
  private listeners = new Set<Listener<T>>();
  add(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(arg: T): void {
    for (const cb of this.listeners) cb(arg);
  }
}

interface MockPtySession {
  listeners: ListenerSet<Uint8Array>;
  history: Uint8Array[];
  started: boolean;
}

export interface MockKernelHostOptions {
  status?: MachineStatus;
  bootSpeed?: number;
  descriptor?: BootDescriptor;
}

export class MockKernelHost implements KernelHost {
  private _status: MachineStatus;
  private statusListeners = new ListenerSet<MachineStatus>();
  private dmesgRing: DmesgLine[] = [];
  private dmesgListeners = new ListenerSet<DmesgLine>();
  private processListeners = new ListenerSet<ProcessEvent>();
  private webPreviewListeners = new ListenerSet<WebPreviewState | null>();
  private presentationListeners = new ListenerSet<DemoPresentation>();
  private surfaceListeners = new ListenerSet<SurfaceAvailability>();
  private demoGuideListeners = new ListenerSet<DemoGuideConfig | null>();
  private ptySessions = new Map<string, MockPtySession>();
  private bootSpeed: number;
  private bootStarted = false;
  private bootTimers: number[] = [];
  private descriptor: BootDescriptor;

  constructor(opts: MockKernelHostOptions = {}) {
    this._status = opts.status ?? "running";
    this.bootSpeed = opts.bootSpeed ?? 1;
    this.descriptor = opts.descriptor
      ? structuredClone(opts.descriptor)
      : structuredClone(CURRENT_DESCRIPTOR_TEMPLATE);
    if (this._status === "booting" || this._status === "running") {
      this.startBoot();
    }
  }

  private ensurePtySession(path: string): MockPtySession {
    let session = this.ptySessions.get(path);
    if (!session) {
      session = {
        listeners: new ListenerSet<Uint8Array>(),
        history: [],
        started: false,
      };
      this.ptySessions.set(path, session);
    }
    return session;
  }

  private emitPty(path: string, text: string): void {
    const session = this.ensurePtySession(path);
    const bytes = new TextEncoder().encode(text);
    session.history.push(bytes);
    if (session.history.length > 2048) session.history.shift();
    session.listeners.emit(bytes);
  }

  // ── status ───────────────────────────────────────────────────────────────

  getStatus(): MachineStatus { return this._status; }
  subscribeStatus(cb: Listener<MachineStatus>): () => void {
    return this.statusListeners.add(cb);
  }
  private setStatus(s: MachineStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.statusListeners.emit(s);
    this.webPreviewListeners.emit(this.getWebPreview());
    this.surfaceListeners.emit(this.getSurfaceAvailability());
  }

  // ── descriptor ───────────────────────────────────────────────────────────

  getBootDescriptor(): BootDescriptor { return structuredClone(this.descriptor); }
  async applyBootDescriptor(desc: BootDescriptor): Promise<void> {
    this.setStatus("booting");
    this.descriptor = structuredClone(desc);
    this.presentationListeners.emit(this.getPresentation());
    this.surfaceListeners.emit(this.getSurfaceAvailability());
    this.demoGuideListeners.emit(this.getDemoGuide());
    this.dmesgRing = [];
    this.dmesgListeners.emit({ t: 0, level: "info", facility: "kernel", msg: "reboot" });
    this.bootStarted = false;
    this.startBoot();
    return new Promise((resolve) => {
      const off = this.subscribeStatus((s) => {
        if (s === "running") { off(); resolve(); }
      });
    });
  }
  async halt(): Promise<void> { this.setStatus("halted"); }
  async reboot(): Promise<void> { await this.applyBootDescriptor(this.descriptor); }

  // ── dmesg ────────────────────────────────────────────────────────────────

  subscribeDmesg(cb: Listener<DmesgLine>): () => void {
    return this.dmesgListeners.add(cb);
  }
  dmesgHistory(): DmesgLine[] { return this.dmesgRing.slice(); }

  subscribeProcessEvents(cb: Listener<ProcessEvent>): () => void {
    return this.processListeners.add(cb);
  }

  /** Test hook: fire a fake process event to drive UI demos. */
  fireProcessEvent(event: ProcessEvent): void {
    this.processListeners.emit(event);
  }

  private startBoot(): void {
    if (this.bootStarted) return;
    this.bootStarted = true;
    this.setStatus("booting");
    // Use bare setTimeout/setInterval (and Number() the result) so the
    // mock runs in Node test environments too — `setTimeout`
    // doesn't exist there. The id is a number in both runtimes.
    for (const [t, level, facility, msg] of BOOT_LOG) {
      const id = Number(setTimeout(() => {
        const line: DmesgLine = { t, level, facility, msg };
        this.dmesgRing.push(line);
        this.dmesgListeners.emit(line);
      }, t / this.bootSpeed));
      this.bootTimers.push(id);
    }
    const last = BOOT_LOG[BOOT_LOG.length - 1];
    const finishId = Number(setTimeout(
      () => this.setStatus("running"),
      last[0] / this.bootSpeed + 80,
    ));
    this.bootTimers.push(finishId);
  }

  // ── PTY ──────────────────────────────────────────────────────────────────

  async attachPty(
    path: string = "/dev/pts/0",
    _opts: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ): Promise<PtyHandle> {
    await delay(20);
    const sessionKey = path || "/dev/pts/0";
    const session = this.ensurePtySession(sessionKey);
    const send = (s: string) => this.emitPty(sessionKey, s);

    let idx = 0;
    const drive = (): void => {
      if (idx >= SHELL_SESSION.length) return;
      const cur = SHELL_SESSION[idx];
      if (cur.kind === "banner") {
        send(
          "\r\n\x1b[38;5;208mkandelo\x1b[0m \x1b[2mb3:9f2a\x1b[0m \x1b[2m·\x1b[0m boot ok\r\n",
        );
        idx++;
        setTimeout(drive, 60);
        return;
      }
      if (cur.kind === "prompt") {
        send("\x1b[38;5;208muser@kandelo\x1b[0m:\x1b[34m~\x1b[0m$ ");
        idx++;
        drive();
        return;
      }
      if (cur.kind === "cmd") {
        let i = 0;
        const tick = (): void => {
          if (i >= cur.text.length) {
            send("\r\n");
            idx++;
            setTimeout(drive, 200);
            return;
          }
          send(cur.text[i]);
          i++;
          setTimeout(tick, 55);
        };
        tick();
        return;
      }
      if (cur.kind === "out") {
        send(cur.text + "\r\n");
        idx++;
        setTimeout(drive, 140);
        return;
      }
      idx++;
    };

    if (!session.started) {
      session.started = true;
      if (this._status === "running") setTimeout(drive, 60);
      else this.subscribeStatus((s) => { if (s === "running") setTimeout(drive, 60); });
    }

    return {
      write: () => { /* mock ignores input */ },
      onData: (cb) => {
        for (const chunk of session.history) cb(chunk);
        return session.listeners.add(cb);
      },
      resize: () => { /* no-op */ },
      close: () => { /* listeners gc with the closure */ },
    };
  }

  async runShellCommand(command: string): Promise<void> {
    const path = "/dev/pts/0";
    const normalized = command.endsWith("\n") ? command : `${command}\n`;
    this.emitPty(path, normalized.replace(/\n/g, "\r\n"));
    this.dmesgRing.push({
      t: performance.now(),
      level: "info",
      facility: "demo",
      msg: `mock action: ${command.split("\n")[0].slice(0, 96)}`,
    });
    this.dmesgListeners.emit(this.dmesgRing[this.dmesgRing.length - 1]);
    await delay(100);
    this.emitPty(
      path,
      `(mock) demo action delivered through KernelHost.runShellCommand\r\n` +
      "\x1b[38;5;208muser@kandelo\x1b[0m:\x1b[34m~\x1b[0m$ ",
    );
  }

  // ── VFS ──────────────────────────────────────────────────────────────────

  async readFile(_path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(`(mock) contents of ${_path}`);
  }
  async readFileText(path: string): Promise<string> {
    return `(mock) contents of ${path}`;
  }
  async readDir(path: string): Promise<VfsDirent[]> {
    await delay(8);
    const node = walkVfs(VFS_ROOT, path);
    if (!node || node.kind !== "d") return [];
    return node.children.map((c) => ({
      name: c.n,
      kind: c.kind,
      mode: c.mode,
      owner: "root",
      group: "root",
      size: c.kind === "d" ? "—" : c.size,
    }));
  }
  async stat(path: string): Promise<VfsDirent | null> {
    await delay(4);
    return {
      name: path.split("/").pop() || "/",
      kind: "d",
      mode: "drwxr-xr-x",
      owner: "root",
      group: "root",
      size: "—",
    };
  }

  // ── Inspector ────────────────────────────────────────────────────────────

  async enumProcs(): Promise<ProcessInfo[]> { await delay(20); return PROCS.slice(); }
  async readMemMap(_pid: number): Promise<MemMapEntry[]> { await delay(12); return MEMMAP.slice(); }
  async getMounts(): Promise<MountInfo[]> { await delay(8); return MOUNTS.slice(); }
  async getKernelState(): Promise<KernelStateKV[]> { await delay(8); return KSTATE.slice(); }

  subscribeSyscalls(cb: Listener<SyscallEvent>, _filter?: SyscallFilter): () => void {
    let i = 0;
    const id = setInterval(() => {
      cb(SYSCALLS[i % SYSCALLS.length]);
      i++;
    }, 850);
    return () => clearInterval(id);
  }
  syscallHistory(_filter?: SyscallFilter): SyscallEvent[] { return SYSCALLS.slice(); }

  // ── Framebuffer ──────────────────────────────────────────────────────────

  attachFramebuffer(_canvas: HTMLCanvasElement): FramebufferHandle {
    // Mock doesn't paint or accept input; return a handle whose methods
    // are all no-ops so the Framebuffer pane mounts cleanly in design
    // mode.
    return {
      sendInput: () => { /* no-op */ },
      sendMouseEvent: () => { /* no-op */ },
      startAudio: async () => null,
      getBoundPid: () => null,
      onBoundPidChange: () => () => { /* no-op */ },
      close: () => { /* no-op */ },
    };
  }

  getWebPreview(): WebPreviewState | null {
    const hasWebService =
      (this.descriptor.runtime.features.includes("tcp-bridge") || hasPackage(this.descriptor, "nginx")) &&
      this.descriptor.boot.argv.some((arg) => arg.includes("dinit"));
    if (!hasWebService) return null;
    return {
      label: this.descriptor.title,
      url: "about:blank",
      status: this._status === "running" ? "running" : "starting",
      message: "Mock preview",
    };
  }

  subscribeWebPreview(cb: (state: WebPreviewState | null) => void): () => void {
    return this.webPreviewListeners.add(cb);
  }

  getPresentation(): DemoPresentation {
    if (this.getWebPreview()) return genericDemoPresentation("web");
    if (
      this.descriptor.runtime.features.includes("framebuffer") ||
      hasPackage(this.descriptor, "fbdoom")
    ) {
      return genericDemoPresentation("framebuffer");
    }
    return genericDemoPresentation("terminal");
  }

  subscribePresentation(cb: (state: DemoPresentation) => void): () => void {
    return this.presentationListeners.add(cb);
  }

  getSurfaceAvailability(): SurfaceAvailability {
    const preview = this.getWebPreview();
    return {
      syslog: true,
      terminal: this._status !== "idle",
      framebuffer: (
        this.descriptor.runtime.features.includes("framebuffer") ||
        hasPackage(this.descriptor, "fbdoom")
      ) && this._status === "running",
      web: preview !== null,
    };
  }

  subscribeSurfaceAvailability(cb: (state: SurfaceAvailability) => void): () => void {
    return this.surfaceListeners.add(cb);
  }

  getDemoGuide(): DemoGuideConfig | null {
    return null;
  }

  subscribeDemoGuide(cb: (state: DemoGuideConfig | null) => void): () => void {
    return this.demoGuideListeners.add(cb);
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  async snapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
    return takeSnapshot(this.getBootDescriptor(), opts);
  }

  // ── Gallery ──────────────────────────────────────────────────────────────

  subscribeGallery(_cb: () => void): () => void {
    return () => {};
  }

  async galleryQuery(q: GalleryQuery): Promise<GalleryItem[]> {
    await delay(12);
    if (q.tab !== "presets") return []; // mock only seeds the presets tab
    const items = PRESET_LIBRARY.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      base: p.base,
      packages: p.packages,
      bootCommand: p.bootCommand,
      accent: p.accent,
      glyph: p.glyph,
      estimatedUrlBytes: p.estimatedUrlBytes,
    }));
    const needle = q.q?.toLowerCase().trim();
    if (!needle) return items;
    return items.filter((i) =>
      i.title.toLowerCase().includes(needle) ||
      i.summary.toLowerCase().includes(needle),
    );
  }

  async saveCurrentToGallery(title: string): Promise<GalleryItem> {
    return {
      id: this.descriptor.id,
      title,
      summary: "Saved from current machine.",
      base: this.descriptor.base,
      packages: this.descriptor.packages,
      bootCommand: this.descriptor.boot.argv,
      accent: "#dc6529",
      glyph: this.descriptor.title.slice(0, 2),
      estimatedUrlBytes: JSON.stringify(this.descriptor).length,
    };
  }
}

function walkVfs(root: VfsNode, path: string): VfsNode | null {
  if (path === "" || path === "/") return root;
  const parts = path.split("/").filter(Boolean);
  let node: VfsNode = root;
  for (const seg of parts) {
    if (node.kind !== "d") return null;
    const next = node.children.find((c) => c.n === seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

function hasPackage(desc: BootDescriptor, name: string): boolean {
  return desc.packages.some((pkg) => pkg === name || pkg.startsWith(`${name}@`));
}
