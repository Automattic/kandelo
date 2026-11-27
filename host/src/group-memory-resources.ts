import { ERRNO } from './generated/abi';
import { GROUP_MEMORY_SCAN_BYTES } from './generated/group-memory-scan';
let scanModule: WebAssembly.Module | undefined;
import { MEMORY_GROUP_MAXIMUM_PAGES, MEMORY_GROUP_PAGE_BYTES as PAGE } from './generated/program-extensions';
import { prepareMemoryGroupPhysicalStore, prepareMemoryGroupQueueUnlock } from './memory-group-notification';

export class GroupMemoryResourceError extends Error {
  constructor(readonly errno: number) { super(`Group memory resource operation failed: errno ${errno}`); }
}
interface Resource {
  readonly memory: WebAssembly.Memory;
  readonly store: (address: number, value: number) => void;
  readonly scan: (address: number, words: number) => bigint;
}
const IntrinsicGroupMemory = WebAssembly.Memory;
const fail = (errno: number): never => { throw new GroupMemoryResourceError(errno); };
const u32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

/** Platform objects only, owned by one disposable kernel Worker. Rust issues
 * resource identities, chooses extents/pages and decides when to drop them.
 * There are no image, replica, mapping or retirement records in this adapter.
 */
export class GroupMemoryResources {
  readonly #resources = new Map<bigint, Resource>();

  create(id: bigint, initial: number, maximum: number): void {
    if (id <= 0n || id > 0xffffffffffffffffn || !u32(initial) || !u32(maximum)
        || initial < 1 || initial > maximum || maximum > MEMORY_GROUP_MAXIMUM_PAGES) fail(ERRNO.EINVAL);
    if (this.#resources.has(id)) fail(ERRNO.EEXIST);
    let memory: WebAssembly.Memory;
    try { memory = new IntrinsicGroupMemory({ initial, maximum, shared: true }); }
    catch (error) { if (error instanceof RangeError) fail(ERRNO.ENOMEM); throw error; }
    // [RUNTIME-WORKAROUND: JSC-GROUP-MUTEX-STORE-STALL] Bind before publication.
    const store = prepareMemoryGroupPhysicalStore(memory);
    prepareMemoryGroupQueueUnlock(memory);
    const scanner = new WebAssembly.Instance(scanModule ??= new WebAssembly.Module(GROUP_MEMORY_SCAN_BYTES), { env: { memory } });
    const scan = scanner.exports.next_nonzero as (address: number, words: number) => bigint;
    this.#resources.set(id, { memory, store, scan });
  }

  drop(id: bigint): void {
    if (!this.#resources.delete(id)) fail(ERRNO.ENOENT);
  }

  memory(id: bigint): WebAssembly.Memory { return this.#resource(id).memory; }
  pages(id: bigint): number { return this.memory(id).buffer.byteLength / PAGE; }

  grow(id: bigint, additional: number): number {
    if (!u32(additional)) fail(ERRNO.EINVAL);
    try { return this.memory(id).grow(additional); }
    catch (error) { if (error instanceof RangeError) fail(ERRNO.ENOMEM); throw error; }
  }

  read(id: bigint, address: number, output: Uint8Array): void {
    output.set(this.#bytes(id, address, output.byteLength));
  }
  write(id: bigint, address: number, input: Uint8Array): void {
    this.#bytes(id, address, input.byteLength).set(input);
  }
  /** Scatter/gather transport for a Rust-lent, immutable BO page descriptor.
   * Preflight the complete span before copying any bytes. The descriptor's
   * owner, lifetime and page selection remain kernel decisions. */
  readPages(id: bigint, pages: readonly number[], offset: number, output: Uint8Array): number {
    const spans = this.#pageSpans(id, pages, offset, output.length);
    let copied = 0;
    for (const span of spans) { output.set(span, copied); copied += span.length; }
    return copied;
  }
  writePages(id: bigint, pages: readonly number[], offset: number, input: Uint8Array): number {
    const spans = this.#pageSpans(id, pages, offset, input.length);
    let copied = 0;
    for (const span of spans) { span.set(input.subarray(copied, copied + span.length)); copied += span.length; }
    return copied;
  }
  fill(id: bigint, address: number, length: number, byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) fail(ERRNO.EINVAL);
    this.#bytes(id, address, length).fill(byte);
  }
  copy(id: bigint, destination: number, source: number, length: number): void {
    // Preflight both intervals before the overlap-safe physical copy.
    this.#bytes(id, destination, length); this.#bytes(id, source, length);
    new Uint8Array(this.memory(id).buffer).copyWithin(destination, source, source + length);
  }
  nextNonzero(id: bigint, address: number, words: number): bigint {
    if (!u32(address) || !u32(words)) fail(ERRNO.EINVAL);
    return this.#resource(id).scan(address, words);
  }
  load(id: bigint, address: number): number { return Atomics.load(this.#word(id, address), 0) >>> 0; }
  store(id: bigint, address: number, value: number): void {
    this.#word(id, address);
    if (!u32(value)) fail(ERRNO.EINVAL);
    this.#resource(id).store(address, value);
  }
  compareExchange(id: bigint, address: number, expected: number, replacement: number): number {
    if (!u32(expected) || !u32(replacement)) fail(ERRNO.EINVAL);
    return Atomics.compareExchange(this.#word(id, address), 0, expected, replacement) >>> 0;
  }
  notify(id: bigint, address: number, count: number): number {
    if (!u32(count)) fail(ERRNO.EINVAL);
    return Atomics.notify(this.#word(id, address), 0, count);
  }

  #resource(id: bigint): Resource { return this.#resources.get(id) ?? fail(ERRNO.ENOENT); }
  #bytes(id: bigint, address: number, length: number): Uint8Array {
    const buffer = this.memory(id).buffer;
    if (!u32(address) || !u32(length) || address > buffer.byteLength || length > buffer.byteLength - address) fail(ERRNO.EFAULT);
    return new Uint8Array(buffer, address, length);
  }
  #word(id: bigint, address: number): Int32Array {
    if (!u32(address) || address % 4) fail(ERRNO.EINVAL);
    const bytes = this.#bytes(id, address, 4);
    return new Int32Array(bytes.buffer, address, 1);
  }
  #pageSpans(id: bigint, pages: readonly number[], offset: number, length: number): Uint8Array[] {
    if (!Number.isSafeInteger(offset) || offset < 0 || !u32(length)
        || offset > pages.length * PAGE || length > pages.length * PAGE - offset) fail(ERRNO.EFAULT);
    const spans: Uint8Array[] = [];
    for (let copied = 0; copied < length;) {
      const logical = offset + copied, page = pages[Math.floor(logical / PAGE)], within = logical % PAGE;
      if (!u32(page) || page === 0 || page >= MEMORY_GROUP_MAXIMUM_PAGES) fail(ERRNO.EFAULT);
      const count = Math.min(length - copied, PAGE - within);
      spans.push(this.#bytes(id, page * PAGE + within, count)); copied += count;
    }
    return spans;
  }
}
