import { mergeChangedByteRuns } from "../shared-byte-runs";

/**
 * The kernel owns BO lifetime through GEM, PRIME, framebuffer and cursor
 * references. This worker-local store owns bounded independent pixel backing.
 * Address-space retirement removes mappings only; only the kernel's final
 * destroy notification releases storage.
 *
 * Wasm memories cannot alias the same bytes. At map/unmap, device submission,
 * cursor/scanout presentation and imported-read readiness boundaries, merge
 * changed bytes from each mapping's private snapshot into canonical storage.
 * An unchanged reader cannot overwrite a newer writer. Overlapping unsynchronized
 * writes have no ordering guarantee; applications must synchronize their writers.
 */
export type GbmBoCreateInput = {
  pid: number;
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
};

export type GbmBoBinding = {
  /** Offset within the process's wasm Memory. */
  addr: number;
  /** Length in bytes — equal to or less than `size`. */
  len: number;
};

/** Projected view of a bo for a specific pid — what `get`/`listForPid`
 *  return. Backward-compatible with the pre-rekey shape so existing
 *  callers reading `e.binding` keep working. */
export type GbmBoEntry = {
  pid: number;
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
  /** This pid's binding, or null if the pid holds a handle but
   *  hasn't mmap'd (post-create / post-unbind). */
  binding: GbmBoBinding | null;
};

export type GbmBoChangeEvent = "create" | "bind" | "unbind" | "destroy";
export type GbmBoChangeListener = (
  pid: number,
  bo_id: number,
  ev: GbmBoChangeEvent,
) => void;

type InternalEntry = {
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
  /** Canonical pixel storage. Pre-`mmap_shared`, this is also the
   *  authoritative buffer that bind/unbind syncs each pid's wasm
   *  Memory against. Allocated on the first `create` for the bo. */
  sab: SharedArrayBuffer;
  /** Observed pids, registered by create or first bind. Unmapped imports
   * are not visible here; this set is never a kernel reference count. */
  pids: Set<number>;
  /** Per-pid bindings. A pid has at most one bo mmap in v1 (the
   *  shim always maps the whole bo). */
  bindingsByPid: Map<number, GbmBoBinding>;
  // At most min(mapping length, BO size) bytes per live mapping, owned only
  // by the disposable kernel worker. Never retains guest Memory or a view.
  snapshotsByPid: Map<number, Uint8Array>;
  /** Readers still awaiting published bytes, even after the writer retires. */
  pendingReaders: Set<number>;
};

/** Per-pid Memory resolver. Returning `undefined` for a pid that
 *  currently has a binding signals the bind/unbind path that the
 *  process has gone away (post-exit) and the sync should be
 *  skipped for that pid. */
export type ProcessMemoryResolver = (
  pid: number,
) => WebAssembly.Memory | undefined;

export interface GbmBoRegistryOptions {
  /** Lets `bind`/`unbind` reach a pid's `WebAssembly.Memory` to
   *  flush/prime the bo's SAB. When omitted, the registry is
   *  pure-metadata and bind/unbind do not touch any Memory. */
  getProcessMemory?: ProcessMemoryResolver;
}

export class GbmBoRegistry {
  private bos = new Map<number, InternalEntry>();
  private listeners = new Set<GbmBoChangeListener>();
  /** Live bo bindings held per pid. hasStaleableImports runs on every
   *  process's poll/epoll/select return; this lets a process that maps no bo
   *  at all -- nearly every process -- answer without scanning every bo. */
  private bindingCounts = new Map<number, number>();

  private setBinding(e: InternalEntry, pid: number, binding: GbmBoBinding): void {
    if (!e.bindingsByPid.has(pid)) {
      this.bindingCounts.set(pid, (this.bindingCounts.get(pid) ?? 0) + 1);
    }
    e.bindingsByPid.set(pid, binding);
  }

  private deleteBinding(e: InternalEntry, pid: number): void {
    if (!e.bindingsByPid.delete(pid)) return;
    e.snapshotsByPid.delete(pid);
    e.pendingReaders.delete(pid);
    const n = (this.bindingCounts.get(pid) ?? 1) - 1;
    if (n > 0) this.bindingCounts.set(pid, n);
    else this.bindingCounts.delete(pid);
  }
  private getProcessMemory: ProcessMemoryResolver | null;

  constructor(opts: GbmBoRegistryOptions = {}) {
    this.getProcessMemory = opts.getProcessMemory ?? null;
  }

  setProcessMemoryResolver(fn: ProcessMemoryResolver | null): void {
    this.getProcessMemory = fn;
  }

  create(b: GbmBoCreateInput): void {
    const existing = this.bos.get(b.bo_id);
    if (existing) {
      // Defensive: a second create for the same bo_id should never
      // happen (the kernel allocates monotonic ids and tears down on
      // destroy). Treat it as an additional consumer if it does —
      // safer than clobbering live bindings under the same id.
      existing.pids.add(b.pid);
    } else {
      this.bos.set(b.bo_id, {
        bo_id: b.bo_id,
        size: b.size,
        w: b.w,
        h: b.h,
        stride: b.stride,
        sab: new SharedArrayBuffer(b.size),
        pids: new Set([b.pid]),
        bindingsByPid: new Map(),
        snapshotsByPid: new Map(),
        pendingReaders: new Set(),
      });
    }
    for (const l of this.listeners) l(b.pid, b.bo_id, "create");
  }

  destroy(pid: number, bo_id: number): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    for (const holder of Array.from(e.bindingsByPid.keys())) this.deleteBinding(e, holder);
    this.bos.delete(bo_id);
    for (const l of this.listeners) l(pid, bo_id, "destroy");
  }

  bind(pid: number, bo_id: number, addr: number, len: number): number {
    const e = this.bos.get(bo_id);
    if (!e) return -1;
    // First bind for an importer pid registers it in the bo's pids
    // set — PRIME_FD_TO_HANDLE doesn't fire a host-side create.
    // Pure metadata at this point: the actual SAB→Memory prime is
    // deferred to `primeBindFromSab`, called after the kernel-worker
    // post-syscall path has grown the Memory and zero-filled the
    // mmap region. If we wrote here, the zero-fill would clobber
    // our primed bytes.
    e.pids.add(pid);
    this.setBinding(e, pid, { addr, len });
    // mmap is zero-filled then primed after the syscall. primeBindFromSab
    // replaces this initial baseline once the actual memory exists.
    e.snapshotsByPid.set(pid, new Uint8Array(Math.min(len, e.size)));
    for (const l of this.listeners) l(pid, bo_id, "bind");
    return 0;
  }

  unbind(pid: number, bo_id: number): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    // Flush the unbinding pid's current bytes into the SAB before
    // dropping the binding — a subsequent bind (in another pid or
    // the same pid re-importing) needs to see the latest writes.
    // The kernel fires `gbm_bo_unbind` BEFORE `proc.memory.munmap`
    // releases pages (see crates/kernel/src/syscalls.rs sys_munmap),
    // so the Memory still has the bytes here.
    const binding = e.bindingsByPid.get(pid);
    if (binding) this.flushMemoryToSab(e, pid, binding);
    this.deleteBinding(e, pid);
    for (const l of this.listeners) l(pid, bo_id, "unbind");
  }

  /** Exec replaces mappings, while non-CLOEXEC GEM handles remain open.
   * Flush the retiring address space without discarding kernel-owned BOs. */
  releaseProcessMappings(pid: number): void {
    for (const [boId, entry] of this.bos) {
      if (entry.bindingsByPid.has(pid)) this.unbind(pid, boId);
    }
  }

  /**
   * Retire a process's observed mappings and metadata. Flush while the old
   * address space is still resolvable. Kernel handles (including unmapped
   * imports) determine storage lifetime; only destroy() can release a BO.
   */
  releaseProcess(pid: number): void {
    for (const [bo_id, e] of Array.from(this.bos)) {
      const binding = e.bindingsByPid.get(pid);
      if (binding) {
        this.flushMemoryToSab(e, pid, binding);
        this.deleteBinding(e, pid);
        for (const l of this.listeners) l(pid, bo_id, "unbind");
      }
      if (!e.pids.delete(pid)) continue;
      // pids records observed mappings, not all kernel references. An
      // importer may hold a valid GEM/cursor/PRIME reference without mapping.
      // Storage dies only on destroy(), driven by the kernel's last ref.
    }
  }

  /** Find the bo bound for `pid` at `addr`. Used by kernel-worker's
   *  post-mmap hook to decide whether to run `primeBindFromSab`. */
  findBindingByAddr(pid: number, addr: number): number | undefined {
    for (const e of this.bos.values()) {
      const b = e.bindingsByPid.get(pid);
      if (b && b.addr === addr) return e.bo_id;
    }
    return undefined;
  }

  /** Post-mmap prime — flushes every OTHER bound pid's wasm Memory
   *  into the bo's SAB, then copies the SAB into `pid`'s `memory`
   *  at the recorded [addr, len). Caller (kernel-worker.ts) invokes
   *  this AFTER `ensureProcessMemoryCovers` has grown the Memory and
   *  the anonymous-mmap zero-fill has run, so our primed bytes are
   *  the final state seen by the user program. */
  primeBindFromSab(
    pid: number,
    bo_id: number,
    memory: WebAssembly.Memory,
  ): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    const binding = e.bindingsByPid.get(pid);
    if (!binding) return;
    for (const [otherPid, otherBinding] of e.bindingsByPid) {
      if (otherPid === pid) continue;
      this.flushMemoryToSab(e, otherPid, otherBinding);
    }
    const copyLen = Math.min(binding.len, e.size);
    if (binding.addr + copyLen > memory.buffer.byteLength) return;
    const dst = new Uint8Array(memory.buffer, binding.addr, copyLen);
    const src = new Uint8Array(e.sab, 0, copyLen);
    dst.set(src);
    e.snapshotsByPid.get(pid)?.set(src);
    e.pendingReaders.delete(pid);
  }

  private flushMemoryToSab(
    e: InternalEntry,
    pid: number,
    binding: GbmBoBinding,
    byteLimit = Infinity,
  ): void {
    const resolver = this.getProcessMemory;
    if (!resolver) return;
    const mem = resolver(pid);
    if (!mem) return;
    const copyLen = Math.min(binding.len, e.size, byteLimit);
    if (binding.addr + copyLen > mem.buffer.byteLength) return;
    const dst = new Uint8Array(e.sab, 0, copyLen);
    const src = new Uint8Array(mem.buffer, binding.addr, copyLen);
    const snapshot = e.snapshotsByPid.get(pid);
    if (!snapshot) throw new Error("DRI mapping has no publication snapshot");
    if (mergeChangedByteRuns(src, 0, snapshot, 0, dst, 0, copyLen)) {
      // A reader must consume the final publication even if this writer's
      // mapping disappears before the reader's next poll/epoll/select return.
      for (const reader of e.bindingsByPid.keys()) {
        if (reader !== pid) e.pendingReaders.add(reader);
      }
    }
    snapshot.set(src);
  }

  get(pid: number, bo_id: number): GbmBoEntry | undefined {
    const e = this.bos.get(bo_id);
    if (!e || !e.pids.has(pid)) return undefined;
    return this.project(e, pid);
  }

  listForPid(pid: number): GbmBoEntry[] {
    const out: GbmBoEntry[] = [];
    for (const e of this.bos.values()) {
      if (e.pids.has(pid)) out.push(this.project(e, pid));
    }
    return out;
  }

  /** Direct view onto a bo's canonical pixel SAB. Undefined for unknown bos. */
  pixelView(bo_id: number): Uint8Array | undefined {
    const e = this.bos.get(bo_id);
    if (!e) return undefined;
    return new Uint8Array(e.sab);
  }

  /** Pid-independent geometry lookup. The GL bridge's foreign-texture
   *  upload path needs dims for a bo the caller holds only a kernel
   *  handle to (PRIME import without an mmap), which `get(pid, bo_id)`
   *  can't serve — that requires the pid in the bo's consumer set. */
  dims(bo_id: number): { w: number; h: number; stride: number } | undefined {
    const e = this.bos.get(bo_id);
    if (!e) return undefined;
    return { w: e.w, h: e.h, stride: e.stride };
  }

  /** Publish every writer, preserving bytes untouched by stale readers. */
  syncToSab(bo_id: number, byteLimit = Infinity): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    for (const [pid, binding] of e.bindingsByPid) {
      this.flushMemoryToSab(e, pid, binding, byteLimit);
    }
  }

  /** Flush each bound pid's Memory into the SAB (KMS scanout calls this
   *  per vblank so mid-bind paints land without an explicit munmap). */
  syncFromMemory(bo_id: number): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    this.syncToSab(bo_id);
  }

  /** O(1) for processes without BO mappings. A mapping can be stale when
   * another process maps that BO or its final publication is still pending. */
  hasStaleableImports(pid: number): boolean {
    // A process that maps no bo imports none: O(1) for everything but the
    // few processes taking part in buffer sharing.
    if (!this.bindingCounts.has(pid)) return false;
    for (const e of this.bos.values()) {
      if (
        e.bindingsByPid.has(pid) && (e.bindingsByPid.size > 1 || e.pendingReaders.has(pid))
      ) {
        return true;
      }
    }
    return false;
  }

  /** Publish changed bytes from every writer, then refresh this process's
   * view and baseline at a readiness boundary. */
  syncImportsForPid(pid: number, memory: WebAssembly.Memory): void {
    for (const e of this.bos.values()) {
      const binding = e.bindingsByPid.get(pid);
      if (!binding) continue;
      // Publish all writers before refreshing this reader's mapping.
      this.syncToSab(e.bo_id);
      const copyLen = Math.min(binding.len, e.size);
      if (binding.addr + copyLen > memory.buffer.byteLength) continue;
      const dst = new Uint8Array(memory.buffer, binding.addr, copyLen);
      dst.set(new Uint8Array(e.sab, 0, copyLen));
      e.snapshotsByPid.get(pid)?.set(dst);
      e.pendingReaders.delete(pid);
    }
  }

  onChange(fn: GbmBoChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private project(e: InternalEntry, pid: number): GbmBoEntry {
    return {
      pid,
      bo_id: e.bo_id,
      size: e.size,
      w: e.w,
      h: e.h,
      stride: e.stride,
      binding: e.bindingsByPid.get(pid) ?? null,
    };
  }
}
