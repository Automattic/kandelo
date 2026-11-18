import * as G from './generated/program-extensions.ts';
import { publishMemoryGroupNotification } from './memory-group-notification';

const PAGE = G.MEMORY_GROUP_PAGE_BYTES;
const READ = 1, WRITE = 2;

export class ProcessAddressFault extends RangeError {
  readonly reason: 'bounds' | 'protection' | 'retired' | 'metadata';
  constructor(reason: ProcessAddressFault['reason']) {
    super(`Process address-space ${reason}`);
    this.reason = reason;
  }
}

export type NativeI32ObservationResult =
  | { readonly async: false; readonly value: string }
  | { readonly async: true; readonly value: Promise<string> };
const observationPromiseThen = Promise.prototype.then;

/** Disposable-kernel observer of one exact physical word. Keep that word and
 * its image pin until the engine's actual promise settles, even if the source
 * is revoked or remapped. Waking does not itself establish settlement.
 */
export class NativeI32Observation {
  private phase: 'prepared' | 'pending' | 'settled' = 'prepared';
  constructor(private word: Int32Array | undefined,
    private releasePin?: () => void) {}
  get settled(): boolean { return this.phase === 'settled'; }
  cancelUnarmed(): void {
    if (this.phase !== 'prepared') throw new Error('Native observation has already been armed');
    this.finish();
  }
  arm(expected: number, timeout?: number): NativeI32ObservationResult {
    if (this.phase !== 'prepared' || !this.word) throw new Error('Native observation cannot be armed twice');
    // If arming or continuation registration unexpectedly throws, retain the
    // target/pin for containment. No caller may infer engine cancellation.
    this.phase = 'pending';
    const result = Atomics.waitAsync(this.word, 0, expected, timeout);
    if (!result.async) { this.finish(); return result; }
    const value = Reflect.apply(observationPromiseThen, result.value, [
      (value: string) => { this.finish(); return value; },
      (cause: unknown) => { this.finish(); throw cause; },
    ]) as Promise<string>;
    return { async: true, value };
  }
  wake(): void {
    if (this.phase === 'pending' && this.word) Atomics.notify(this.word, 0);
  }
  private finish(): void {
    this.phase = 'settled'; this.word = undefined;
    const release = this.releasePin; this.releasePin = undefined; release?.();
  }
}

/** Bytes are always guest virtual addresses. Reads return independent storage;
 * neither API exposes a group backing as a pointer-addressed native buffer.
 */
export interface ProcessAddressSpace {
  readonly kind: 'linear' | 'grouped';
  readonly identity: object;
  readonly byteLength: number;
  checkAccessRange(address: number, length: number, access: 'read' | 'write'): void;
  readBytes(address: number, length: number): Uint8Array;
  writeBytes(address: number, source: Uint8Array): void;
  fillBytes(address: number, length: number, value: number): void;
  atomicLoadI32(address: number): number;
  atomicStoreI32(address: number, value: number): number;
  atomicCompareExchangeI32(address: number, expected: number, replacement: number): number;
  notifyI32(address: number, count: number): number;
  /** Preflight both ranges, copy bytes, then publish a status word and wake. */
  publishBytes(address: number, source: Uint8Array, signalAddress: number, signalValue: number, count: number): number;
}
interface Span { physical: number; length: number }

function checkNotifyCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) {
    throw new ProcessAddressFault('bounds');
  }
}

function range(address: number, length: number, limit: number): void {
  if (!Number.isSafeInteger(address) || !Number.isSafeInteger(length)
      || address < 0 || length < 0 || address > limit || length > limit - address) {
    throw new ProcessAddressFault('bounds');
  }
}

/** Validate the original i64 import argument before narrowing it for JS views. */
export function processAddressFromWasm(address: bigint, length: number, limit: number): number {
  if (typeof address !== 'bigint' || address < 0n || address > BigInt(limit)) {
    throw new ProcessAddressFault('bounds');
  }
  const pointer = Number(address);
  range(pointer, length, limit);
  return pointer;
}
function snapshot(source: Uint8Array): Uint8Array {
  // A SharedArrayBuffer obtained before grow can alias a newer buffer object.
  // Own the source before any stores; buffer-object equality is insufficient.
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

export class LinearProcessAddressSpace implements ProcessAddressSpace {
  readonly kind = 'linear' as const;
  readonly identity: object = Object.freeze({});
  private memory: WebAssembly.Memory | undefined;
  constructor(memory: WebAssembly.Memory) { this.memory = memory; }
  private current(): WebAssembly.Memory {
    if (!this.memory) throw new ProcessAddressFault('retired');
    return this.memory;
  }
  detachHostAccess(): void { this.memory = undefined; }
  get byteLength(): number { return this.current().buffer.byteLength; }
  checkAccessRange(address: number, length: number, access: 'read' | 'write'): void {
    if (access !== 'read' && access !== 'write') throw new ProcessAddressFault('metadata');
    range(address, length, this.byteLength);
  }
  readBytes(address: number, length: number): Uint8Array {
    range(address, length, this.byteLength);
    const copy = new Uint8Array(length);
    copy.set(new Uint8Array(this.current().buffer, address, length));
    return copy;
  }
  writeBytes(address: number, source: Uint8Array): void {
    range(address, source.byteLength, this.byteLength);
    new Uint8Array(this.current().buffer, address, source.byteLength).set(source);
  }
  fillBytes(address: number, length: number, value: number): void {
    range(address, length, this.byteLength);
    new Uint8Array(this.current().buffer, address, length).fill(value);
  }
  private atomicWord(address: number): Int32Array {
    const memory = this.current();
    range(address, 4, memory.buffer.byteLength);
    if (address % 4 || !(memory.buffer instanceof SharedArrayBuffer)) {
      throw new ProcessAddressFault('bounds');
    }
    return new Int32Array(memory.buffer, address, 1);
  }
  atomicLoadI32(address: number): number { return Atomics.load(this.atomicWord(address), 0); }
  atomicStoreI32(address: number, value: number): number { return Atomics.store(this.atomicWord(address), 0, value); }
  atomicCompareExchangeI32(address: number, expected: number, replacement: number): number {
    return Atomics.compareExchange(this.atomicWord(address), 0, expected, replacement);
  }
  notifyI32(address: number, count: number): number {
    checkNotifyCount(count);
    return Atomics.notify(this.atomicWord(address), 0, count);
  }
  publishBytes(address: number, source: Uint8Array, signalAddress: number, signalValue: number, count: number): number {
    range(address, source.byteLength, this.byteLength);
    const signal = this.atomicWord(signalAddress);
    checkNotifyCount(count);
    this.writeBytes(address, source);
    Atomics.store(signal, 0, signalValue);
    return Atomics.notify(signal, 0, count);
  }
}

export interface GroupAddressSpaceBinding {
  readonly memory: WebAssembly.Memory;
  readonly root: number;
  readonly maximumPages: number;
  /** The kernel-realm owner validates exact image generation and live custody. */
  readonly assertLive: () => void;
  /** Only the kernel image owner may retain engine observers past revocation. */
  readonly retainNativeObservation?: () => (() => void);
}

/** A virtual root, distinct from the physical Memory shared with other images.
 * Its binding is supplied only after admission/root allocation by the owning
 * Worker. This byte-access primitive does not authorize membership or page reuse.
 */
export class GroupProcessAddressSpace implements ProcessAddressSpace {
  readonly kind = 'grouped' as const;
  readonly identity: object = Object.freeze({});
  private binding: GroupAddressSpaceBinding | undefined;
  constructor(binding: GroupAddressSpaceBinding) {
    const buffer = binding.memory.buffer as ArrayBufferLike;
    if (!(buffer instanceof SharedArrayBuffer)
        || !Number.isSafeInteger(binding.root) || binding.root < PAGE || binding.root % PAGE
        || !Number.isSafeInteger(binding.maximumPages) || binding.maximumPages < 1
        || binding.maximumPages > 65536
        || binding.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES + binding.maximumPages * 4
          > binding.memory.buffer.byteLength) {
      throw new ProcessAddressFault('metadata');
    }
    this.binding = { ...binding };
    this.current();
  }
  private current(): { binding: GroupAddressSpaceBinding; pages: number } {
    const binding = this.binding;
    if (!binding) throw new ProcessAddressFault('retired');
    binding.assertLive();
    const header = new Uint32Array(binding.memory.buffer, binding.root, 1);
    const pages = Atomics.load(header, 0);
    if (pages > binding.maximumPages) throw new ProcessAddressFault('metadata');
    return { binding, pages };
  }
  get byteLength(): number { return this.current().pages * PAGE; }
  /** Revoke host access without claiming quiescence or freeing physical pages.
   * Clearing the entire binding also drops any owner callback retaining storage.
   */
  detachHostAccess(): void { this.binding = undefined; }
  private walk(address: number, length: number, rights: number,
    visit?: (physical: number, length: number) => void): GroupAddressSpaceBinding {
    const { binding, pages } = this.current();
    range(address, length, pages * PAGE);
    // Refresh after the acquire of logical size: C may have grown physical
    // memory and published new PTEs immediately before that acquire.
    const table = new Uint32Array(binding.memory.buffer,
      binding.root + G.MEMORY_GROUP_ROOT_HEADER_BYTES, binding.maximumPages);
    let at = address, remaining = length;
    while (remaining) {
      const entry = table[Math.floor(at / PAGE)];
      const physicalPage = (entry & 0xffff0000) >>> 0;
      if ((entry & rights) !== rights || !physicalPage) {
        throw new ProcessAddressFault('protection');
      }
      if (physicalPage + PAGE > binding.memory.buffer.byteLength) {
        throw new ProcessAddressFault('metadata');
      }
      const offset = at % PAGE, count = Math.min(remaining, PAGE - offset);
      visit?.(physicalPage + offset, count);
      at += count; remaining -= count;
    }
    return binding;
  }
  checkAccessRange(address: number, length: number, access: 'read' | 'write'): void {
    if (access !== 'read' && access !== 'write') throw new ProcessAddressFault('metadata');
    // Walk every page without a payload copy or span-array allocation. This
    // observation grants no future authority; actual access checks again.
    this.walk(address, length, access === 'read' ? READ : WRITE);
  }
  private plan(address: number, length: number, rights: number): { binding: GroupAddressSpaceBinding; spans: Span[] } {
    const spans: Span[] = [];
    const binding = this.walk(address, length, rights, (physical, length) => {
      const previous = spans[spans.length - 1];
      if (previous && previous.physical + previous.length === physical) previous.length += length;
      else spans.push({ physical, length });
    });
    return { binding, spans };
  }
  readBytes(address: number, length: number): Uint8Array {
    const { binding, spans } = this.plan(address, length, READ);
    const result = new Uint8Array(length);
    let at = 0;
    for (const span of spans) {
      result.set(new Uint8Array(binding.memory.buffer, span.physical, span.length), at);
      at += span.length;
    }
    return result;
  }
  /** Check output authority before a host callback without publishing bytes.
   * The eventual store must still revalidate after that callback returns.
   */
  checkWritableRange(address: number, length: number): void {
    this.checkAccessRange(address, length, 'write');
  }
  writeBytes(address: number, source: Uint8Array): void {
    const { binding, spans } = this.plan(address, source.byteLength, WRITE);
    const copy = snapshot(source);
    let at = 0;
    for (const span of spans) {
      new Uint8Array(binding.memory.buffer, span.physical, span.length)
        .set(copy.subarray(at, at + span.length));
      at += span.length;
    }
  }
  fillBytes(address: number, length: number, value: number): void {
    const { binding, spans } = this.plan(address, length, WRITE);
    for (const span of spans) {
      new Uint8Array(binding.memory.buffer, span.physical, span.length).fill(value);
    }
  }
  private atomicWord(address: number, rights: number): { binding: GroupAddressSpaceBinding; physical: number; word: Int32Array } {
    if (address % 4) throw new ProcessAddressFault('bounds');
    const { binding, spans } = this.plan(address, 4, rights);
    const physical = spans[0].physical;
    return { binding, physical, word: new Int32Array(binding.memory.buffer, physical, 1) };
  }
  prepareNativeObservationI32(address: number): NativeI32Observation {
    const { binding, word } = this.atomicWord(address, READ);
    if (!binding.retainNativeObservation) throw new ProcessAddressFault('metadata');
    const release = binding.retainNativeObservation();
    try { return new NativeI32Observation(word, release); }
    catch (error) { release(); throw error; }
  }
  atomicLoadI32(address: number): number { return Atomics.load(this.atomicWord(address, READ).word, 0); }
  atomicStoreI32(address: number, value: number): number { return Atomics.store(this.atomicWord(address, WRITE).word, 0, value); }
  atomicCompareExchangeI32(address: number, expected: number, replacement: number): number {
    return Atomics.compareExchange(this.atomicWord(address, READ | WRITE).word, 0, expected, replacement);
  }
  private atomicU64(address: number, rights: number): BigUint64Array {
    if (address % 8) throw new ProcessAddressFault('bounds');
    const { binding, spans } = this.plan(address, 8, rights);
    return new BigUint64Array(binding.memory.buffer, spans[0].physical, 1);
  }
  atomicLoadU64(address: number): bigint { return Atomics.load(this.atomicU64(address, READ), 0); }
  atomicStoreU64(address: number, value: bigint): bigint { return Atomics.store(this.atomicU64(address, WRITE), 0, value); }
  notifyI32(address: number, count: number): number {
    checkNotifyCount(count);
    const { binding, physical } = this.atomicWord(address, READ);
    return publishMemoryGroupNotification(binding.memory, physical, count, () => {});
  }
  publishBytes(address: number, source: Uint8Array, signalAddress: number, signalValue: number, count: number): number {
    const { binding, spans } = this.plan(address, source.byteLength, WRITE);
    const { physical, word } = this.atomicWord(signalAddress, WRITE);
    checkNotifyCount(count);
    const copy = snapshot(source);
    // Allocate every destination view before publishing bytes or status.
    const destinations = spans.map(span => new Uint8Array(binding.memory.buffer, span.physical, span.length));
    return publishMemoryGroupNotification(binding.memory, physical, count, () => {
      let at = 0;
      for (const destination of destinations) {
        destination.set(copy.subarray(at, at + destination.length)); at += destination.length;
      }
      Atomics.store(word, 0, signalValue);
    });
  }
}
