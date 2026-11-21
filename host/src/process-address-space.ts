import { WASM_PAGE_SIZE } from "./constants";

/** Byte size of one page table: one 4-byte entry per 64 KiB wasm32 page. */
export const PAGE_TABLE_BYTES = 4 * 65536;
/** Byte offset of the per-page sharer counts inside a group header. */
export const GROUP_SHARERS_OFFSET = WASM_PAGE_SIZE;
/** Byte size of a group header: allocator page, then one count per page. */
export const GROUP_HEADER_BYTES = GROUP_SHARERS_OFFSET + PAGE_TABLE_BYTES;

const COW_BIT = 1;
const BUSY_BIT = 2;
const PAGE_SHIFT = 16;
const PAGE_INDEX_MASK = 0xffff;
const PAGE_OFFSET_MASK = WASM_PAGE_SIZE - 1;
const STOPPED_OWNED = 1;
const STOPPED_SHARED = 2;

// WHY: kernel imports translate guest addresses while a scratch lease is
// live, and leases can cross arbitrary host callbacks. Capture every
// byte-access intrinsic before those callbacks can replace a prototype method,
// as kernel-scratch.ts does for the bytes it moves.
const IntrinsicUint8Array = Uint8Array;
const IntrinsicInt32Array = Int32Array;
const intrinsicApply = Reflect.apply;
const intrinsicMathMin = Math.min;
const intrinsicMathCeil = Math.ceil;
const IntrinsicBigInt = BigInt;
const intrinsicUint8ArraySet = IntrinsicUint8Array.prototype.set;
const intrinsicUint8ArraySubarray = IntrinsicUint8Array.prototype.subarray;
const intrinsicUint8ArrayCopyWithin = IntrinsicUint8Array.prototype.copyWithin;
const intrinsicUint8ArrayFill = IntrinsicUint8Array.prototype.fill;
const intrinsicUint8ArrayIndexOf = IntrinsicUint8Array.prototype.indexOf;
const intrinsicAtomicsLoad = Atomics.load;
const intrinsicAtomicsStore = Atomics.store;
const intrinsicAtomicsAdd = Atomics.add;
const intrinsicAtomicsSub = Atomics.sub;
const intrinsicAtomicsCompareExchange = Atomics.compareExchange;
const intrinsicMemoryGrow = WebAssembly.Memory.prototype.grow;
const intrinsicMemoryBuffer = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!.get!,
) as (memory: WebAssembly.Memory) => ArrayBufferLike;
const intrinsicTypedArrayBuffer = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(IntrinsicUint8Array.prototype),
    "buffer",
  )!.get!,
) as (view: ArrayBufferView) => ArrayBufferLike;
const intrinsicTypedArrayLength = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(IntrinsicUint8Array.prototype),
    "length",
  )!.get!,
) as (view: ArrayBufferView) => number;

/**
 * Address-space mode for programs rewritten by `wasm-memory-instrument`.
 * `"copy"` treats their Memory as the identity mapping. `"share"` gives each
 * such process a group header and translates host access through its page
 * tables.
 */
export type ForkMemory = "copy" | "share";

/** `count` guest pages from virtual page `page`. */
export interface PageRun {
  page: number;
  count: number;
}

/**
 * Physical placement of one process inside a shared Memory, as set by
 * `wasm-memory-instrument`: `table` is the value of the program's
 * `__memory_table_base` global and `group` the value of its
 * `__memory_group_base` global.
 */
export interface PageTableLocation {
  readonly table: number;
  readonly group: number;
  /**
   * Value of `__memory_stop_base` for the thread whose Worker holds this
   * location: the physical offset of the thread's stop words.
   */
  readonly stop?: number;
}

/** Byte size of the stop words of one thread: the request and its echo. */
export const STOP_WORDS_BYTES = 8;

/**
 * The guest-virtual view of one process's linear memory.
 *
 * A program rewritten by `wasm-memory-instrument` translates every access
 * through a per-process page table. Read entries hold `physical - virtual`
 * per 64 KiB page; write entries hold the same delta plus a copy-on-write bit
 * and a copy-in-progress bit. Host accesses must use the same translation,
 * and a host write to a shared page must copy it first, exactly as the
 * guest's copy-on-write helper does. Without a table the space is the
 * identity mapping.
 */
export class ProcessAddressSpace {
  #words: Int32Array | null = null;
  #bytes: Uint8Array | null = null;
  #pages = 0;
  #stopped: Uint8Array | null = null;

  constructor(
    readonly memory: WebAssembly.Memory,
    readonly location: PageTableLocation | null,
  ) {
    if (location === null) return;
    this.#pages = intrinsicTypedArrayLength(this.#byteView()) / WASM_PAGE_SIZE;
    // WHY: a new group owns every page of its Memory. The first process
    // starts the allocator there; a zero allocator would hand out page 0.
    intrinsicAtomicsCompareExchange(this.#view(), location.group / 4, 0, this.#pages);
  }

  /** Byte size of the guest-virtual address space. */
  get byteLength(): number {
    if (this.location === null) return intrinsicTypedArrayLength(this.#byteView());
    return this.#pages * WASM_PAGE_SIZE;
  }

  /**
   * Extend the guest-virtual address space to cover `endOffset`.
   *
   * WHY: in a group, the pages after a process's last page can hold another
   * process's copies, so growth cannot be `memory.grow` alone. The new
   * virtual pages map to one fresh physical run from the group allocator.
   * For a process that has not forked, that run starts at the same page
   * number, and the mapping stays the identity.
   */
  grow(endOffset: number, pointerWidth: 4 | 8 = 4): void {
    const pages = intrinsicMathCeil(endOffset / WASM_PAGE_SIZE);
    if (this.location === null) {
      this.#growPhysical(pages, pointerWidth);
      return;
    }
    const count = pages - this.#pages;
    if (count <= 0) return;
    const fresh = this.#allocate(count);
    const delta = (fresh - this.#pages) << PAGE_SHIFT;
    const words = this.#view();
    for (let page = this.#pages; page < pages; page++) {
      const address = page << PAGE_SHIFT;
      intrinsicAtomicsStore(words, this.#slot(address, 0), delta);
      intrinsicAtomicsStore(words, this.#slot(address, PAGE_TABLE_BYTES), delta);
    }
    this.#pages = pages;
  }

  /**
   * Physical page of the one unshared run that holds the `count` guest pages
   * from `page`, for pages the host accesses at their physical offset.
   *
   * WHY: the guest writes its syscall channel through the tables while the
   * host reads it at a fixed physical offset. A shared page would move on the
   * guest's first write. Pages that already form one unshared run keep it
   * and their bytes; other pages get a new run that reads as zero.
   */
  privateRun(page: number, count: number, pointerWidth: 4 | 8 = 4): number {
    this.grow((page + count) * WASM_PAGE_SIZE, pointerWidth);
    if (this.location === null) return page;
    const first = this.#view()[this.#slot(page << PAGE_SHIFT, PAGE_TABLE_BYTES)];
    let kept = (first & (COW_BIT | BUSY_BIT)) === 0;
    for (let index = 1; kept && index < count; index++) {
      kept = this.#view()[this.#slot((page + index) << PAGE_SHIFT, PAGE_TABLE_BYTES)] === first;
    }
    if (kept) return page + (first >> PAGE_SHIFT);

    const fresh = this.#allocate(count);
    const delta = (fresh - page) << PAGE_SHIFT;
    const words = this.#view();
    const sharers = (this.location.group + GROUP_SHARERS_OFFSET) / 4;
    for (let index = 0; index < count; index++) {
      const address = (page + index) << PAGE_SHIFT;
      const slot = this.#slot(address, PAGE_TABLE_BYTES);
      const entry = intrinsicAtomicsLoad(words, slot);
      if (entry & COW_BIT) {
        const physical = (page + index + (entry >> PAGE_SHIFT)) & PAGE_INDEX_MASK;
        intrinsicAtomicsSub(words, sharers + physical, 1);
      }
      intrinsicAtomicsStore(words, this.#slot(address, 0), delta);
      intrinsicAtomicsStore(words, slot, delta);
    }
    return fresh;
  }

  /** Physical byte offset of a guest address, for a read. */
  readable(address: number): number {
    if (this.location === null) return address;
    return (address + this.#view()[this.#slot(address, 0)]) >>> 0;
  }

  /** Physical byte offset of a guest address, for a write. */
  writable(address: number): number {
    if (this.location === null) return address;
    let entry = this.#view()[this.#slot(address, PAGE_TABLE_BYTES)];
    if (entry & COW_BIT) entry = this.#copyOnWrite(address);
    return (address + entry) >>> 0;
  }

  /**
   * Physical byte offset of `length` guest bytes at `address` when one
   * physical run holds them for a read, or -1 when they must be split.
   */
  readableRun(address: number, length: number): number {
    if (this.location === null) return address;
    const words = this.#view();
    const delta = words[this.#slot(address, 0)];
    const end = address + length;
    for (let page = (address >>> PAGE_SHIFT) + 1; page * WASM_PAGE_SIZE < end; page++) {
      if (words[this.#slot(page << PAGE_SHIFT, 0)] !== delta) return -1;
    }
    return (address + delta) >>> 0;
  }

  /** Copy `length` guest bytes at `address` into a new buffer. */
  read(address: number, length: number): Uint8Array {
    const bytes = new IntrinsicUint8Array(length);
    let offset = 0;
    while (offset < length) {
      const size = this.#runLength(address + offset, length - offset);
      const physical = this.readable(address + offset);
      intrinsicApply(intrinsicUint8ArraySet, bytes, [
        intrinsicApply(intrinsicUint8ArraySubarray, this.#byteView(), [physical, physical + size]),
        offset,
      ]);
      offset += size;
    }
    return bytes;
  }

  /**
   * `length` guest bytes at `address`, for a read: a view when one physical
   * run holds them, a copy when they cross into another run.
   */
  readableBytes(address: number, length: number): Uint8Array {
    const offset = this.readableRun(address, length);
    if (offset < 0) return this.read(address, length);
    return new IntrinsicUint8Array(intrinsicMemoryBuffer(this.memory), offset, length);
  }

  /** Offset of the first zero byte in `length` guest bytes at `address`, or -1. */
  indexOfZero(address: number, length: number): number {
    let offset = 0;
    while (offset < length) {
      const size = this.#runLength(address + offset, length - offset);
      const physical = this.readable(address + offset);
      const found: number = intrinsicApply(intrinsicUint8ArrayIndexOf, intrinsicApply(
        intrinsicUint8ArraySubarray,
        this.#byteView(),
        [physical, physical + size],
      ), [0]);
      if (found >= 0) return offset + found;
      offset += size;
    }
    return -1;
  }

  /** Copy `bytes` to guest memory at `address`. */
  write(address: number, bytes: Uint8Array): void {
    const length = intrinsicTypedArrayLength(bytes);
    let offset = 0;
    while (offset < length) {
      const size = this.#runLength(address + offset, length - offset);
      const physical = this.writable(address + offset);
      intrinsicApply(intrinsicUint8ArraySet, this.#byteView(), [
        intrinsicApply(intrinsicUint8ArraySubarray, bytes, [offset, offset + size]),
        physical,
      ]);
      offset += size;
    }
  }

  /**
   * Create the address space of a fork child inside the same Memory.
   *
   * The child gets its own tables with the parent's entries. Every mapped
   * page becomes shared: both write entries get the copy-on-write bit, and
   * the page's count grows by one. The pages of `privateRuns` are the
   * exception. The host reads and writes those control pages at their
   * physical offset, so the child gets a copy of each run in one physical
   * run, and the parent keeps its pages unshared.
   *
   * WHY: no thread of the parent may run during this call. A thread that
   * loaded a write entry before the bit was set would write a shared page
   * in place. `stopWrites` parks the threads that run.
   */
  fork(privateRuns: readonly PageRun[]): ProcessAddressSpace {
    const { table, group } = this.location!;
    const tablePages = 2 * PAGE_TABLE_BYTES / WASM_PAGE_SIZE;
    const isPrivate = this.#privatePages(privateRuns);
    let privateCount = 0;
    for (let run = 0; run < privateRuns.length; run++) privateCount += privateRuns[run].count;
    this.#stopped = null;
    const fresh = this.#allocate(tablePages + privateCount);
    const childTable = fresh << PAGE_SHIFT;
    const bytes = this.#byteView();
    intrinsicApply(intrinsicUint8ArrayCopyWithin, bytes, [
      childTable,
      table,
      table + 2 * PAGE_TABLE_BYTES,
    ]);
    const child = new ProcessAddressSpace(this.memory, { table: childTable, group });
    child.#pages = this.#pages;

    const words = this.#view();
    const sharers = (group + GROUP_SHARERS_OFFSET) / 4;
    for (let page = 0; page < this.#pages; page++) {
      if (isPrivate[page]) continue;
      const address = page << PAGE_SHIFT;
      const slot = this.#slot(address, PAGE_TABLE_BYTES);
      const entry = (intrinsicAtomicsLoad(words, slot) | COW_BIT) & ~BUSY_BIT;
      const physical = (page + (entry >> PAGE_SHIFT)) & PAGE_INDEX_MASK;
      intrinsicAtomicsAdd(words, sharers + physical, 1);
      intrinsicAtomicsStore(words, slot, entry);
      intrinsicAtomicsStore(words, child.#slot(address, PAGE_TABLE_BYTES), entry);
    }

    let firstPrivate = fresh + tablePages;
    for (let run = 0; run < privateRuns.length; run++) {
      const { page, count } = privateRuns[run];
      const delta = (firstPrivate - page) << PAGE_SHIFT;
      for (let index = 0; index < count; index++) {
        const address = (page + index) << PAGE_SHIFT;
        const source = this.readable(address);
        const target = (firstPrivate + index) << PAGE_SHIFT;
        intrinsicApply(intrinsicUint8ArrayCopyWithin, bytes, [target, source, source + WASM_PAGE_SIZE]);
        intrinsicAtomicsStore(words, child.#slot(address, 0), delta);
        intrinsicAtomicsStore(words, child.#slot(address, PAGE_TABLE_BYTES), delta);
      }
      firstPrivate += count;
    }
    return child;
  }

  /**
   * Make every store of the process wait, before a `fork` that shares pages
   * while other threads of the process run.
   *
   * WHY: a running thread cannot be stopped from outside. With the
   * copy-on-write bit and the lock bit set on every page, the next store of
   * a thread enters the copy-on-write helper, and the helper parks the
   * thread while its stop word is set. The pages of `privateRuns` stay
   * writable: a thread writes its syscall request there. `fork` or
   * `resumeWrites` must follow.
   */
  stopWrites(privateRuns: readonly PageRun[]): void {
    const isPrivate = this.#privatePages(privateRuns);
    const stopped = new IntrinsicUint8Array(this.#pages);
    const words = this.#view();
    for (let page = 0; page < this.#pages; page++) {
      if (isPrivate[page]) continue;
      const slot = this.#slot(page << PAGE_SHIFT, PAGE_TABLE_BYTES);
      for (;;) {
        const entry = intrinsicAtomicsLoad(words, slot);
        // A thread is copying this page; it clears both bits when it ends.
        if (entry & BUSY_BIT) continue;
        if (intrinsicAtomicsCompareExchange(words, slot, entry, entry | COW_BIT | BUSY_BIT) !== entry) continue;
        stopped[page] = entry & COW_BIT ? STOPPED_SHARED : STOPPED_OWNED;
        break;
      }
    }
    this.#stopped = stopped;
  }

  /** Undo `stopWrites` when no `fork` follows. */
  resumeWrites(): void {
    const stopped = this.#stopped!;
    const words = this.#view();
    for (let page = 0; page < intrinsicTypedArrayLength(stopped); page++) {
      if (stopped[page] === 0) continue;
      const slot = this.#slot(page << PAGE_SHIFT, PAGE_TABLE_BYTES);
      const kept = stopped[page] === STOPPED_SHARED ? COW_BIT : 0;
      intrinsicAtomicsStore(words, slot, words[slot] & ~(COW_BIT | BUSY_BIT) | kept);
    }
    this.#stopped = null;
  }

  /** Set `length` guest bytes at `address` to zero. */
  zero(address: number, length: number): void {
    let offset = 0;
    while (offset < length) {
      const size = this.#runLength(address + offset, length - offset);
      const physical = this.writable(address + offset);
      intrinsicApply(intrinsicUint8ArrayFill, this.#byteView(), [0, physical, physical + size]);
      offset += size;
    }
  }

  /** Copy `length` guest bytes from `source` to `target`, lowest address first. */
  copy(target: number, source: number, length: number): void {
    let offset = 0;
    while (offset < length) {
      const size = intrinsicMathMin(
        this.#runLength(source + offset, length - offset),
        this.#runLength(target + offset, length - offset),
      );
      const from = this.readable(source + offset);
      const to = this.writable(target + offset);
      intrinsicApply(intrinsicUint8ArrayCopyWithin, this.#byteView(), [to, from, from + size]);
      offset += size;
    }
  }

  /** Take `count` contiguous physical pages from the group allocator. */
  #allocate(count: number): number {
    const allocator = this.location!.group / 4;
    for (;;) {
      const fresh = intrinsicAtomicsLoad(this.#view(), allocator);
      // Grow before the allocator moves: a refused grow then leaks no pages.
      this.#growPhysical(fresh + count, 4);
      if (intrinsicAtomicsCompareExchange(this.#view(), allocator, fresh, fresh + count) === fresh) {
        return fresh;
      }
    }
  }

  #growPhysical(pages: number, pointerWidth: 4 | 8): void {
    const delta = pages - intrinsicTypedArrayLength(this.#byteView()) / WASM_PAGE_SIZE;
    if (delta <= 0) return;
    intrinsicApply(intrinsicMemoryGrow, this.memory, [
      pointerWidth === 8 ? IntrinsicBigInt(delta) : delta,
    ]);
  }

  #privatePages(privateRuns: readonly PageRun[]): Uint8Array {
    const isPrivate = new IntrinsicUint8Array(this.#pages);
    for (let run = 0; run < privateRuns.length; run++) {
      const { page, count } = privateRuns[run];
      intrinsicApply(intrinsicUint8ArrayFill, isPrivate, [1, page, page + count]);
    }
    return isPrivate;
  }

  #runLength(address: number, remaining: number): number {
    if (this.location === null) return remaining;
    return intrinsicMathMin(remaining, WASM_PAGE_SIZE - (address & PAGE_OFFSET_MASK));
  }

  #view(): Int32Array {
    const buffer = intrinsicMemoryBuffer(this.memory);
    if (this.#words === null || intrinsicTypedArrayBuffer(this.#words) !== buffer) {
      this.#words = new IntrinsicInt32Array(buffer);
    }
    return this.#words;
  }

  #byteView(): Uint8Array {
    const buffer = intrinsicMemoryBuffer(this.memory);
    if (this.#bytes === null || intrinsicTypedArrayBuffer(this.#bytes) !== buffer) {
      this.#bytes = new IntrinsicUint8Array(buffer);
    }
    return this.#bytes;
  }

  #slot(address: number, table: number): number {
    return (this.location!.table + table) / 4 + (address >>> PAGE_SHIFT);
  }

  /**
   * WHY: this mirrors the guest helper emitted by `wasm-memory-instrument`
   * step for step, including the lock bit, because host writes and guest
   * threads can fault on the same page at the same time.
   */
  #copyOnWrite(address: number): number {
    const { group } = this.location!;
    const readSlot = this.#slot(address, 0);
    const writeSlot = this.#slot(address, PAGE_TABLE_BYTES);
    let entry: number;
    for (;;) {
      const words = this.#view();
      entry = intrinsicAtomicsLoad(words, writeSlot);
      if ((entry & COW_BIT) === 0) return entry;
      if (entry & BUSY_BIT) continue;
      if (intrinsicAtomicsCompareExchange(words, writeSlot, entry, entry | BUSY_BIT) === entry) break;
    }

    const delta = entry & ~(COW_BIT | BUSY_BIT);
    const page = address >>> PAGE_SHIFT;
    const physical = (page + (delta >> PAGE_SHIFT)) & PAGE_INDEX_MASK;
    const sharers = (group + GROUP_SHARERS_OFFSET) / 4 + physical;
    if (intrinsicAtomicsLoad(this.#view(), sharers) === 0) {
      intrinsicAtomicsStore(this.#view(), writeSlot, delta);
      return delta;
    }

    const fresh = intrinsicAtomicsAdd(this.#view(), group / 4, 1);
    this.#growPhysical(fresh + 1, 4);
    intrinsicApply(intrinsicUint8ArrayCopyWithin, this.#byteView(), [
      fresh << PAGE_SHIFT,
      physical << PAGE_SHIFT,
      (physical + 1) << PAGE_SHIFT,
    ]);
    const copied = (fresh - page) << PAGE_SHIFT;
    const words = this.#view();
    intrinsicAtomicsStore(words, readSlot, copied);
    intrinsicAtomicsStore(words, writeSlot, copied);
    intrinsicAtomicsSub(words, sharers, 1);
    return copied;
  }
}
