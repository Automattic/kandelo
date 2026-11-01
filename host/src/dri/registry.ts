import { mergeChangedByteRuns } from "../shared-byte-runs";
import { isKernelExportFailure } from "../kernel-entry-gate.js";

const mappingMemoryBufferGetter = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,"buffer")!.get!;
const mappingApply = Reflect.apply;
function mappingMemoryBuffer(memory: WebAssembly.Memory): ArrayBuffer {
  // Authenticate the native Memory receiver; an own `buffer` property cannot
  // redirect original mapping authority into another address space.
  return mappingApply(mappingMemoryBufferGetter,memory,[]) as ArrayBuffer;
}

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
  /** Exact process mapping length, including permitted trailing page padding.
   * Coherence copies are independently clipped to canonical BO storage. */
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

function primedMapping(e: InternalEntry, binding: InternalBinding): string {
  return `GBM BO ${e.bo_id}: pid ${binding.pid}'s primed mapping 0x${binding.addr.toString(16)}+${binding.len}`;
}

function describe(error: unknown): string {
  return String((error as Error | null)?.message ?? error);
}

/**
 * A broken mapping invariant or lost mapping data: a kernel-unmapped
 * mapping whose final writeback could not be published, one that could not
 * detach, or a primed mapping whose address space no longer covers it.
 *
 * WHY THIS IS FATAL. The kernel has already unmapped the range and will
 * reuse it, so a lost writeback can never be republished and a binding left
 * behind would copy unrelated bytes into the buffer. A primed mapping always
 * keeps the Memory it was primed from and Wasm memories never shrink, so
 * the other cases mean host state is corrupt. The registry reports the fault
 * through `onFault` (the kernel's fatal host-fault path) before throwing, so
 * no intermediate catch can turn it into a recoverable result.
 */
export class GbmMappingFault extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GbmMappingFault";
  }
}

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
  /** One admission identity; splits retain it, replacements never do. */
  lineage: MappingLineage;
};
type MappingLineage = {
  memory: WebAssembly.Memory | null;
  fragments: Set<InternalBinding>;
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

/** Consulted only for a NEW mapping admission. Later coherence and cleanup
 * retain that exact Memory, including across PID registration replacement. */
export type ProcessMemoryResolver = (
  pid: number,
) => WebAssembly.Memory | undefined;

export interface GbmBoRegistryOptions {
  /** Resolves a new binding's original Memory once. A binding admitted before
   * registration may authenticate its Memory at its first prime instead. No later
   * publication, import or retirement resolves the PID again. */
  getProcessMemory?: ProcessMemoryResolver;
  /** A fatal mapping fault (see GbmMappingFault), reported before it is
   * thrown. The kernel wires this to its fatal host-fault path. */
  onFault?: (fault: GbmMappingFault) => void;
}

export class GbmBoRegistry {
  private bos = new Map<number, InternalEntry>();
  private listeners = new Set<GbmBoChangeListener>();
  /** Live bo bindings held per pid. hasStaleableImports runs on every
   *  process's poll/epoll/select return; this lets a process that maps no bo
   *  at all -- nearly every process -- answer without scanning every bo. */
  private bindingCounts = new Map<number, number>();
  /** External change observers may inspect but not reenter a staged mutation. */
  private mutating = false;

  private stageLineages(removed: InternalBinding[], added: InternalBinding[]): Map<MappingLineage, Set<InternalBinding>> {
    const staged = new Map<MappingLineage, Set<InternalBinding>>();
    for (const binding of [...removed, ...added]) {
      if (!staged.has(binding.lineage)) staged.set(binding.lineage, new Set(binding.lineage.fragments));
    }
    for (const binding of removed) staged.get(binding.lineage)!.delete(binding);
    for (const binding of added) staged.get(binding.lineage)!.add(binding);
    return staged;
  }

  /** Publish each lineage's surviving fragments. A lineage with none left
   * releases its Memory reference. */
  private finishLineages(staged: Map<MappingLineage, Set<InternalBinding>>): void {
    for (const [lineage, fragments] of staged) {
      lineage.fragments = fragments;
      if (!fragments.size) lineage.memory = null;
    }
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
  private onFault: GbmBoRegistryOptions["onFault"] | null;

  constructor(opts: GbmBoRegistryOptions = {}) {
    this.getProcessMemory = opts.getProcessMemory ?? null;
    this.onFault = opts.onFault ?? null;
  }

  /** Report and throw a fatal mapping fault. An exception the reporter
   * throws is dropped unless it is a kernel export failure: the fault being
   * thrown is the one that must reach the caller. */
  private fault(message: string, cause?: unknown): never {
    const fault = new GbmMappingFault(message, cause);
    try { this.onFault?.(fault); }
    catch (error) { if (isKernelExportFailure(error)) throw error; }
    throw fault;
  }

  setProcessMemoryResolver(fn: ProcessMemoryResolver | null): void {
    this.getProcessMemory = fn;
  }

  create(b: GbmBoCreateInput): void {
    if (this.mutating) throw new Error("Reentrant BO mapping mutation");
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
    if (this.mutating) throw new Error("Reentrant BO mapping mutation");
    const e = this.bos.get(bo_id);
    if (!e) return;
    for (const holder of Array.from(e.bindingsByPid.keys())) this.deleteBinding(e, holder);
    this.bos.delete(bo_id);
    for (const l of this.listeners) l(pid, bo_id, "destroy");
  }

  bind(pid: number, bo_id: number, addr: number, len: number, boOffset = 0,
    allocationLength?: number): number {
    const entry = this.bos.get(bo_id);
    if (this.mutating || !entry || !Number.isSafeInteger(addr) || !Number.isSafeInteger(len) ||
        !Number.isSafeInteger(boOffset) || addr < 0 || len < 0 || boOffset < 0 ||
        !Number.isSafeInteger(boOffset + len) || !Number.isSafeInteger(addr + len)) return -1;
    if (allocationLength !== undefined && (!Number.isSafeInteger(allocationLength) ||
        allocationLength <= 0 || allocationLength < len || !Number.isSafeInteger(addr + allocationLength))) return -1;

    const previousBos = this.bos, previousCounts = this.bindingCounts;
    this.mutating = true;
    let committed = false;
    try {
      // Stage complete metadata before publishing a replacement. Canonical
      // publication may happen during admission, but failed admission must
      // preserve every old mapping and its independent baseline.
      const nextBos = new Map(this.bos);
      const changed = new Map<number, {original: InternalEntry; next: InternalEntry}>();
      const cloneEntry = (original: InternalEntry) => {
        let staged = changed.get(original.bo_id);
        if (!staged) {
          staged = {original, next: {...original, pids: new Set(original.pids),
            bindingsByPid: new Map(original.bindingsByPid)}};
          const aliases = original.bindingsByPid.get(pid);
          staged.next.bindingsByPid.set(pid, new Map(aliases));
          changed.set(original.bo_id, staged);
          nextBos.set(original.bo_id, staged.next);
        }
        return staged.next;
      };
      const retiring: {entry: InternalEntry; binding: InternalBinding}[] = [];
      const fragments: {binding: InternalBinding; source: Uint8Array}[] = [];
      const unbound = new Set<number>();
      if (allocationLength !== undefined) {
        const end = addr + allocationLength;
        for (const original of this.bos.values()) {
          for (const binding of original.bindingsByPid.get(pid)?.values() ?? []) {
            const start = Math.max(addr, binding.addr);
            const stop = Math.min(end, binding.addr + binding.len);
            if (start >= stop) continue;
            const next = cloneEntry(original);
            const aliases = next.bindingsByPid.get(pid)!;
            aliases.delete(binding.addr);
            const fragment = (offset: number, length: number) => {
              const source = binding.snapshot.subarray(offset, offset + length);
              const snapshot = new Uint8Array(source.byteLength);
              const child = {...binding, addr: binding.addr + offset,
                len: length, boOffset: binding.boOffset + offset, snapshot};
              aliases.set(child.addr, child);
              fragments.push({binding:child,source});
            };
            if (start > binding.addr) fragment(0, start - binding.addr);
            if (stop < binding.addr + binding.len) fragment(stop - binding.addr, binding.addr + binding.len - stop);
            retiring.push({entry: original,binding});
            unbound.add(original.bo_id);
          }
        }
      }
      const target = cloneEntry(entry);
      target.pids.add(pid);
      // Same-address admission without a VMA replacement is still a new
      // generation. Publish/detach the old object, never silently overwrite it.
      const previous = target.bindingsByPid.get(pid)!.get(addr);
      if (previous) { retiring.push({entry,binding:previous}); unbound.add(bo_id); }
      const lineage: MappingLineage = {memory:this.getProcessMemory?.(pid) ?? null,
        fragments:new Set()};
      if (lineage.memory) mappingMemoryBuffer(lineage.memory);
      const admitted: InternalBinding = {pid,addr,len,boOffset,primed:false,lineage,
        snapshot:new Uint8Array(Math.max(0,Math.min(len,entry.size-boOffset)))};
      target.bindingsByPid.get(pid)!.set(addr, admitted);
      const stagedLineages = this.stageLineages(retiring.map(value => value.binding),
        [...fragments.map(value => value.binding), admitted]);
      const nextCounts = new Map(this.bindingCounts);
      let count = 0;
      for (const candidate of nextBos.values()) count += candidate.bindingsByPid.get(pid)?.size ?? 0;
      if (count) nextCounts.set(pid,count);
      else nextCounts.delete(pid);

      // The process bytes still contain the old mappings here. The kernel
      // worker zero-fills/populates the accepted mmap only after this return.
      for (const record of retiring) this.flushMemoryToSab(record.entry,record.binding);
      for (const {binding,source} of fragments) binding.snapshot.set(source);
      for (const {original,next} of changed.values()) {
        next.pendingReaders = new Set(original.pendingReaders);
        if (!next.bindingsByPid.get(pid)?.size) {
          next.bindingsByPid.delete(pid);
          next.pendingReaders.delete(pid);
        }
      }
      this.bos = nextBos;
      this.bindingCounts = nextCounts;
      for (const oldBo of unbound) for (const listener of this.listeners) listener(pid,oldBo,"unbind");
      for (const listener of this.listeners) listener(pid,bo_id,"bind");
      committed = true;
      this.finishLineages(stagedLineages);
      return 0;
    } catch (error) {
      if (committed || error instanceof GbmMappingFault || isKernelExportFailure(error)) throw error;
      // Flushes above can legitimately publish old dirty bytes. Restoring the
      // old metadata retains those updated baselines, without admitting the
      // replacement or losing any old alias if a later allocation/observer fails.
      this.bos = previousBos;
      this.bindingCounts = previousCounts;
      return -1;
    } finally { this.mutating = false; }
  }

  /**
   * The kernel has already unmapped this range (munmap, exec or exit) and
   * will reuse it, so the binding must detach and its final writeback must
   * reach the BO in this call: a binding left for an unmapped range would
   * publish whatever the process later stores at a reused address, and a
   * lost writeback can never be republished. Anything short of that is a
   * fatal GbmMappingFault (reported through onFault, then thrown): a call
   * made during another registry mutation, a range that is not an address
   * span, a staging fault, or a lost publication.
   */
  unbind(pid: number, bo_id: number, addr?: number, len?: number): void {
    const range = () => addr === undefined ? "every mapping" : `unmapped range 0x${addr.toString(16)}+${len ?? "*"}`;
    if (this.mutating) this.fault(`GBM BO ${bo_id}: pid ${pid}'s ${range()} cannot detach during another mapping mutation`);
    const entry = this.bos.get(bo_id);
    if (!entry) return;
    if (addr !== undefined && (!Number.isSafeInteger(addr) || addr < 0 ||
        (len !== undefined && (!Number.isSafeInteger(len) || len < 0 || !Number.isSafeInteger(addr + len)))))
      this.fault(`GBM BO ${bo_id}: pid ${pid}'s ${range()} is not an address span`);
    this.removeMappings(entry, pid, addr, len);
  }

  /** Detach a kernel-unmapped range. Stage all descendants and baselines
   * before the first publication; a staging or publication failure is a
   * fatal GbmMappingFault (see unbind). Callers have checked `mutating`. */
  private removeMappings(entry: InternalEntry, pid: number, addr?: number, len?: number): void {
    this.mutating = true;
    let committed = false;
    try {
      const aliases = new Map(entry.bindingsByPid.get(pid));
      const removed: InternalBinding[] = [], added: InternalBinding[] = [];
      const baselines: {binding: InternalBinding; source: Uint8Array}[] = [];
      for (const binding of aliases.values()) {
        if (addr !== undefined && len === undefined && binding.addr !== addr) continue;
        const start = addr === undefined || len === undefined ? binding.addr : Math.max(addr,binding.addr);
        const end = addr === undefined || len === undefined ? binding.addr + binding.len : Math.min(addr + len,binding.addr + binding.len);
        if (start >= end) continue;
        aliases.delete(binding.addr); removed.push(binding);
        const fragment = (offset: number, length: number) => {
          const source = binding.snapshot.subarray(offset,offset+length);
          const child = {...binding,addr:binding.addr+offset,len:length,boOffset:binding.boOffset+offset,
            snapshot:new Uint8Array(source.length)};
          aliases.set(child.addr,child); added.push(child); baselines.push({binding:child,source});
        };
        if (start > binding.addr) fragment(0,start-binding.addr);
        if (end < binding.addr+binding.len) fragment(end-binding.addr,binding.addr+binding.len-end);
      }
      const stagedLineages = this.stageLineages(removed,added);
      const nextByPid = new Map(entry.bindingsByPid);
      if (aliases.size) nextByPid.set(pid,aliases); else nextByPid.delete(pid);
      const counts = new Map(this.bindingCounts);
      const count = (counts.get(pid) ?? 0) - removed.length + added.length;
      if (count) counts.set(pid,count); else counts.delete(pid);
      for (const binding of removed) {
        try { this.flushMemoryToSab(entry,binding); }
        catch (error) {
          if (error instanceof GbmMappingFault || isKernelExportFailure(error)) throw error;
          this.fault(`GBM BO ${entry.bo_id}: the final writeback of pid ${pid}'s unmapped range `
            + `0x${binding.addr.toString(16)}+${binding.len} could not be published: ${describe(error)}`, error);
        }
      }
      for (const {binding,source} of baselines) binding.snapshot.set(source);
      entry.bindingsByPid = nextByPid; this.bindingCounts = counts;
      if (!aliases.size) entry.pendingReaders.delete(pid);
      committed = true;
      this.finishLineages(stagedLineages);
      // Change observers cannot undo a physical detach.
      for (const listener of this.listeners) {
        try { listener(pid,entry.bo_id,"unbind"); }
        catch (error) { if (isKernelExportFailure(error)) throw error; }
      }
    } catch (error) {
      if (committed || error instanceof GbmMappingFault || isKernelExportFailure(error)) throw error;
      this.mutating = false;
      this.fault(`GBM BO ${entry.bo_id}: pid ${pid}'s unmapped range `
        + `0x${(addr ?? 0).toString(16)}+${len ?? "*"} could not detach: ${describe(error)}`, error);
    } finally { this.mutating = false; }
  }

  /** Exec replaces mappings, while non-CLOEXEC GEM handles remain open.
   * Flush the retiring address space without discarding kernel-owned BOs.
   * A mapping that cannot detach with its final writeback is fatal (unbind). */
  releaseProcessMappings(pid: number): void {
    for (const [boId, entry] of this.bos) {
      if (entry.bindingsByPid.has(pid)) this.unbind(pid,boId);
    }
  }

  /**
   * Retire a process's observed mappings and metadata using each admitted
   * original address space. The process's mappings are gone, so a mapping
   * that cannot detach with its final writeback is fatal (see unbind).
   * Kernel handles (including unmapped imports) determine storage lifetime;
   * only destroy() can release a BO.
   */
  releaseProcess(pid: number): void {
    for (const [bo_id, e] of Array.from(this.bos)) {
      if (e.bindingsByPid.has(pid)) this.unbind(pid,bo_id);
      // pids records observed mappings, not all kernel references. An
      // importer may hold a valid GEM/cursor/PRIME reference without mapping.
      // Storage dies only on destroy(), driven by the kernel's last ref.
      e.pids.delete(pid);
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
  ): boolean {
    try {
      const e = this.bos.get(bo_id);
      if (!e) return false;
      const binding = addr === undefined ? this.latestBinding(e,pid) : e.bindingsByPid.get(pid)?.get(addr);
      if (!binding || this.mutating || (binding.lineage.memory !== null && binding.lineage.memory !== memory)) return false;
      const copyLen = Math.max(0,Math.min(binding.len, e.size - binding.boOffset));
      if (binding.addr + binding.len > mappingMemoryBuffer(memory).byteLength || binding.snapshot.length !== copyLen) return false;
      for (const other of this.bindings(e)) if (other !== binding) this.flushMemoryToSab(e, other);
      const dst = new Uint8Array(mappingMemoryBuffer(memory), binding.addr, copyLen);
      const src = new Uint8Array(e.sab, Math.min(binding.boOffset,e.size), copyLen);
      dst.set(src);
      binding.snapshot.set(src);
      binding.lineage.memory = memory;
      binding.primed = true;
      e.pendingReaders.delete(pid);
      return true;
    } catch (error) {
      if (error instanceof GbmMappingFault || isKernelExportFailure(error)) throw error;
      return false;
    }
  }

  /** Prime kernel-announced inherited aliases after the child's clone is
   * complete. Preflight every destination before exposing any child mapping.
   * Pending clone bytes never become a writer. Local guest views do not escape. */
  primeProcessMappings(pid: number, memory: WebAssembly.Memory): boolean {
    if (this.mutating) return false;
    if (!this.bindingCounts.has(pid)) return true;
    try {
      const targets: {entry: InternalEntry; binding: InternalBinding;
        destination: Uint8Array; source: Uint8Array; length: number}[] = [];
      for (const entry of this.bos.values()) {
        const aliases = entry.bindingsByPid.get(pid);
        if (!aliases) continue;
        this.syncToSab(entry.bo_id);
        for (const binding of aliases.values()) {
          if (binding.lineage.memory !== null && binding.lineage.memory !== memory) return false;
          if (binding.primed) continue;
          const length = Math.max(0,Math.min(binding.len, entry.size - binding.boOffset));
          if (binding.addr + binding.len > mappingMemoryBuffer(memory).byteLength || binding.snapshot.length !== length) return false;
          targets.push({entry, binding, length,
            destination: new Uint8Array(mappingMemoryBuffer(memory),binding.addr,length), source: new Uint8Array(entry.sab,Math.min(binding.boOffset,entry.size),length)});
        }
      }
      if (targets.some(target => target.destination.byteLength !== target.length)) return false;
      for (const {entry,binding,destination,source} of targets) {
        destination.set(source); binding.snapshot.set(source); binding.lineage.memory=memory; binding.primed=true;
        entry.pendingReaders.delete(pid);
      }
      return true;
    } catch (error) {
      if (error instanceof GbmMappingFault || isKernelExportFailure(error)) throw error;
      return false;
    }
  }

  /** Merge one mapping's changed bytes into canonical storage. A primed
   * mapping keeps the Memory it was primed from, which covered it then and
   * cannot shrink, and a baseline sized for its whole copy; a mapping that
   * breaks either can never publish, which is a fatal GbmMappingFault. */
  private flushMemoryToSab(
    e: InternalEntry,
    binding: InternalBinding,
    byteLimit = Infinity,
  ): void {
    if (!binding.primed) return;
    // Messages are built only on the fault path: this runs at every
    // publication boundary (submit, scanout, readiness).
    const mem = binding.lineage.memory;
    if (!mem) this.fault(`${primedMapping(e,binding)} has no address space to publish from`);
    const copyLen = Math.max(0, Math.min(binding.len, e.size - binding.boOffset, byteLimit - binding.boOffset));
    const memoryBytes = mappingMemoryBuffer(mem).byteLength;
    if (binding.addr + binding.len > memoryBytes)
      this.fault(`${primedMapping(e,binding)} extends past its ${memoryBytes}-byte address space`);
    if (binding.snapshot.length < copyLen)
      this.fault(`${primedMapping(e,binding)} has a ${binding.snapshot.length}-byte baseline for a ${copyLen}-byte publication`);
    if (!copyLen) return;
    const dst = new Uint8Array(e.sab, Math.min(binding.boOffset,e.size), copyLen);
    const src = new Uint8Array(mappingMemoryBuffer(mem), binding.addr, copyLen);
    const snapshot = binding.snapshot;
    if (mergeChangedByteRuns(src, 0, snapshot, 0, dst, 0, copyLen)) {
      // A reader must consume the final publication even if this writer's
      // mapping disappears before the reader's next poll/epoll/select return.
      for (const reader of this.bindings(e)) if (reader !== binding) e.pendingReaders.add(reader.pid);
      snapshot.set(src);
    }
    // An unchanged scan already agrees with this independent baseline. Do
    // not copy the whole mapping again or capture later, unpublished stores.
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
        const memory = binding.lineage.memory;
        if (!memory) return false;
        const length = Math.max(0,Math.min(binding.len, e.size - binding.boOffset));
        const snapshot = binding.snapshot;
        if (!snapshot || snapshot.byteLength !== length ||
            binding.addr + binding.len > mappingMemoryBuffer(memory).byteLength) return false;
        targets.push({pid, length, view: new Uint8Array(mappingMemoryBuffer(memory), binding.addr, length),
          source: canonical.subarray(binding.boOffset, binding.boOffset + length), snapshot});
      }
      // All destinations belong to their original mapping admissions.
      // Allocate every view and recheck all destinations before writing.
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
        if (binding.lineage.memory !== memory) { complete = false; continue; }
        const copyLen = Math.max(0,Math.min(binding.len, e.size - binding.boOffset));
        if (binding.addr + binding.len > mappingMemoryBuffer(memory).byteLength) { complete = false; continue; }
        const dst = new Uint8Array(mappingMemoryBuffer(memory), binding.addr, copyLen);
        dst.set(new Uint8Array(e.sab, Math.min(binding.boOffset,e.size), copyLen));
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
