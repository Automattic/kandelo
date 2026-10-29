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
  /** Offset in canonical BO storage; omitted for the original zero-offset view. */
  boOffset?: number;
};

/** Metadata for a BO observed by a process. `binding` is its most recently
 * registered alias for inspection; coherence tracks every live alias. */
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

type InternalBinding = GbmBoBinding & {
  pid: number;
  boOffset: number;
  /** Independent baseline; never a guest memory view. */
  snapshot: Uint8Array;
  primed: boolean;
};
type InternalEntry = {
  bo_id: number;
  size: number;
  w: number;
  h: number;
  stride: number;
  sab: SharedArrayBuffer;
  /** Observed mappings are metadata, never a kernel ownership count. */
  pids: Set<number>;
  bindingsByPid: Map<number, Map<number, InternalBinding>>;
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

  private setBinding(e: InternalEntry, pid: number, binding: InternalBinding): void {
    let aliases = e.bindingsByPid.get(pid);
    if (!aliases) { aliases = new Map(); e.bindingsByPid.set(pid, aliases); }
    if (!aliases.has(binding.addr)) this.bindingCounts.set(pid, (this.bindingCounts.get(pid) ?? 0) + 1);
    aliases.set(binding.addr, binding);
  }

  private deleteBinding(e: InternalEntry, pid: number, addr?: number): void {
    const aliases = e.bindingsByPid.get(pid);
    if (!aliases) return;
    const removed = addr === undefined ? aliases.size : Number(aliases.delete(addr));
    if (addr === undefined) aliases.clear();
    if (!aliases.size) { e.bindingsByPid.delete(pid); e.pendingReaders.delete(pid); }
    const count = (this.bindingCounts.get(pid) ?? removed) - removed;
    if (count > 0) this.bindingCounts.set(pid, count);
    else this.bindingCounts.delete(pid);
  }

  private *bindings(e: InternalEntry): Iterable<InternalBinding> {
    for (const aliases of e.bindingsByPid.values()) yield* aliases.values();
  }
  private latestBinding(e: InternalEntry, pid: number): InternalBinding | undefined {
    let last: InternalBinding | undefined;
    for (const binding of e.bindingsByPid.get(pid)?.values() ?? []) last = binding;
    return last;
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

  bind(pid: number, bo_id: number, addr: number, len: number, boOffset = 0): number {
    const e = this.bos.get(bo_id);
    if (!e || !Number.isSafeInteger(addr) || !Number.isSafeInteger(len) ||
        !Number.isSafeInteger(boOffset) || addr < 0 || len < 0 || boOffset < 0 ||
        boOffset > e.size || !Number.isSafeInteger(addr + len)) return -1;
    // First bind for an importer pid registers it in the bo's pids
    // set — PRIME_FD_TO_HANDLE doesn't fire a host-side create.
    // Pure metadata at this point: the actual SAB→Memory prime is
    // deferred to `primeBindFromSab`, called after the kernel-worker
    // post-syscall path has grown the Memory and zero-filled the
    // mmap region. If we wrote here, the zero-fill would clobber
    // our primed bytes.
    e.pids.add(pid);
    this.setBinding(e, pid, {pid, addr, len, boOffset, primed: false,
      snapshot: new Uint8Array(Math.min(len, e.size - boOffset))});
    for (const l of this.listeners) l(pid, bo_id, "bind");
    return 0;
  }

  unbind(pid: number, bo_id: number, addr?: number, len?: number): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    if (addr !== undefined && (!Number.isSafeInteger(addr) || addr < 0 ||
        (len !== undefined && (!Number.isSafeInteger(len) || len < 0 || !Number.isSafeInteger(addr + len))))) return;
    const removed: InternalBinding[] = [], fragments: InternalBinding[] = [];
    for (const binding of e.bindingsByPid.get(pid)?.values() ?? []) {
      if (addr !== undefined && len === undefined && binding.addr !== addr) continue;
      const start = addr === undefined || len === undefined ? binding.addr : Math.max(addr,binding.addr);
      const end = addr === undefined || len === undefined ? binding.addr + binding.len : Math.min(addr + len,binding.addr + binding.len);
      if (start >= end) continue;
      // Flush while the retiring bytes still belong to this address space.
      // Snapshot fragments remain independent storage, never guest views.
      this.flushMemoryToSab(e,binding);
      removed.push(binding);
      if (start > binding.addr) fragments.push({...binding, len: start - binding.addr,
        snapshot: binding.snapshot.slice(0,start-binding.addr)});
      if (end < binding.addr + binding.len) {
        const delta = end - binding.addr;
        fragments.push({...binding, addr: end, len: binding.addr + binding.len - end,
          boOffset: binding.boOffset + delta, snapshot: binding.snapshot.slice(delta)});
      }
    }
    // A flush above can make a surviving alias stale. Preserve that wakeup
    // even when removing the last original entry temporarily clears the pid.
    const pending = e.pendingReaders.has(pid);
    for (const binding of removed) this.deleteBinding(e,pid,binding.addr);
    for (const binding of fragments) this.setBinding(e,pid,binding);
    if (pending && e.bindingsByPid.has(pid)) e.pendingReaders.add(pid);
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
      if (e.bindingsByPid.has(pid)) this.unbind(pid, bo_id);
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
      if (e.bindingsByPid.get(pid)?.has(addr)) return e.bo_id;
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
    addr?: number,
  ): void {
    const e = this.bos.get(bo_id);
    if (!e) return;
    const binding = addr === undefined ? this.latestBinding(e,pid) : e.bindingsByPid.get(pid)?.get(addr);
    if (!binding) return;
    for (const other of this.bindings(e)) if (other !== binding) this.flushMemoryToSab(e, other);
    const copyLen = Math.min(binding.len, e.size - binding.boOffset);
    if (binding.addr + copyLen > memory.buffer.byteLength) return;
    const dst = new Uint8Array(memory.buffer, binding.addr, copyLen);
    const src = new Uint8Array(e.sab, binding.boOffset, copyLen);
    dst.set(src);
    binding.snapshot.set(src);
    binding.primed = true;
    e.pendingReaders.delete(pid);
  }

  /** Prime kernel-announced inherited aliases after the child's clone is
   * complete. Preflight every destination before exposing any child mapping.
   * Pending clone bytes never become a writer. Local guest views do not escape. */
  primeProcessMappings(pid: number, memory: WebAssembly.Memory): boolean {
    if (!this.bindingCounts.has(pid)) return true;
    try {
      const targets: {entry: InternalEntry; binding: InternalBinding;
        destination: Uint8Array; source: Uint8Array; length: number}[] = [];
      for (const entry of this.bos.values()) {
        const aliases = entry.bindingsByPid.get(pid);
        if (!aliases) continue;
        this.syncToSab(entry.bo_id);
        for (const binding of aliases.values()) {
          if (binding.primed) continue;
          const length = Math.min(binding.len, entry.size - binding.boOffset);
          if (binding.addr + length > memory.buffer.byteLength || binding.snapshot.length !== length) return false;
          targets.push({entry, binding, length,
            destination: new Uint8Array(memory.buffer,binding.addr,length), source: new Uint8Array(entry.sab,binding.boOffset,length)});
        }
      }
      if (targets.some(target => target.destination.byteLength !== target.length)) return false;
      for (const {entry,binding,destination,source} of targets) {
        destination.set(source); binding.snapshot.set(source); binding.primed=true;
        entry.pendingReaders.delete(pid);
      }
      return true;
    } catch { return false; }
  }

  private flushMemoryToSab(
    e: InternalEntry,
    binding: InternalBinding,
    byteLimit = Infinity,
  ): void {
    const resolver = this.getProcessMemory;
    if (!resolver || !binding.primed) return;
    const mem = resolver(binding.pid);
    if (!mem) return;
    const copyLen = Math.max(0, Math.min(binding.len, e.size - binding.boOffset, byteLimit - binding.boOffset));
    if (binding.addr + copyLen > mem.buffer.byteLength) return;
    const dst = new Uint8Array(e.sab, binding.boOffset, copyLen);
    const src = new Uint8Array(mem.buffer, binding.addr, copyLen);
    const snapshot = binding.snapshot;
    if (mergeChangedByteRuns(src, 0, snapshot, 0, dst, 0, copyLen)) {
      // A reader must consume the final publication even if this writer's
      // mapping disappears before the reader's next poll/epoll/select return.
      for (const reader of this.bindings(e)) if (reader !== binding) e.pendingReaders.add(reader.pid);
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

  /** Publish a complete device write and refresh every live mapped reader.
   * Views are local to this synchronous call. Updating their snapshots keeps
   * a later unchanged reader from publishing pre-render bytes over the frame.
   * Validate every destination before the first write. */
  publishDevicePixels(bo_id: number, pixels: Uint8Array): boolean {
    const e = this.bos.get(bo_id);
    if (!e || pixels.byteLength !== e.size) return false;
    try {
      const canonical = new Uint8Array(e.sab);
      const targets: {pid: number; length: number; view: Uint8Array; source: Uint8Array; snapshot: Uint8Array}[] = [];
      for (const binding of this.bindings(e)) {
        if (!binding.primed) continue;
        const pid = binding.pid;
        const memory = this.getProcessMemory?.(pid);
        if (!memory) continue;
        const length = Math.min(binding.len, e.size - binding.boOffset);
        const snapshot = binding.snapshot;
        if (!snapshot || snapshot.byteLength !== length ||
            binding.addr + length > memory.buffer.byteLength) return false;
        targets.push({pid, length, view: new Uint8Array(memory.buffer, binding.addr, length),
          source: canonical.subarray(binding.boOffset, binding.boOffset + length), snapshot});
      }
      // A resolver callback may replace or grow an unshared test memory.
      // Allocate every source view and recheck all destinations before writing.
      if (targets.some(target => target.view.byteLength !== target.length) || pixels.byteLength !== e.size)
        return false;
      canonical.set(pixels);
      for (const {pid, view, source, snapshot} of targets) {
        view.set(source);
        snapshot.set(view);
        e.pendingReaders.delete(pid);
      }
      return true;
    } catch { return false; }
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
    for (const binding of this.bindings(e)) this.flushMemoryToSab(e, binding, byteLimit);
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
      const aliases = e.bindingsByPid.get(pid);
      if (!aliases || ![...aliases.values()].some(binding => binding.primed)) continue;
      if (e.bindingsByPid.size > 1 || aliases.size > 1 || e.pendingReaders.has(pid)) return true;
    }
    return false;
  }

  /** Publish changed bytes from every writer, then refresh this process's
   * view and baseline at a readiness boundary. */
  syncImportsForPid(pid: number, memory: WebAssembly.Memory): void {
    for (const e of this.bos.values()) {
      const aliases = e.bindingsByPid.get(pid);
      if (!aliases) continue;
      this.syncToSab(e.bo_id);
      let complete = true;
      for (const binding of aliases.values()) {
        if (!binding.primed) continue;
        const copyLen = Math.min(binding.len, e.size - binding.boOffset);
        if (binding.addr + copyLen > memory.buffer.byteLength) { complete = false; continue; }
        const dst = new Uint8Array(memory.buffer, binding.addr, copyLen);
        dst.set(new Uint8Array(e.sab, binding.boOffset, copyLen));
        binding.snapshot.set(dst);
      }
      if (complete) e.pendingReaders.delete(pid);
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
      binding: (() => { const value = this.latestBinding(e,pid); return value ? {addr:value.addr,len:value.len,...(value.boOffset ? {boOffset:value.boOffset} : {})} : null; })(),
    };
  }
}
