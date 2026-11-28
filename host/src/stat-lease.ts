import { KIFS_STAT_CERTIFICATE as CERT } from "./generated/abi";
import { STAT_CACHE_MODULE, STAT_CACHE_SYSCALL_BITS, STAT_CACHE_SYSCALL_MASK } from "./generated/program-extensions";

// One kernel's bounded publication of checked stat results.
const WORDS = CERT.INODE_BUCKETS;
const PATH_BYTES = CERT.PATH_BYTES;
const STAT_BYTES = CERT.STAT_BYTES;
const STAT_START = CERT.STAT_OFFSET;
const CERT_EPOCHS = CERT.GENERATIONS_OFFSET;
export const CERT_BYTES = CERT.BYTES;
const WAYS = 4;
const SLOTS = 512;
const SLOT_STAT = 40 + PATH_BYTES;
const SLOT = SLOT_STAT + STAT_BYTES;
const FIRST_SLOT = 32 + WORDS * 8;
const INITIAL_CLOSED = 1n;
const EXHAUSTED = (1n << 64n) - 1n;

function setOf(path: Uint8Array, syscall: number, flags: number): number {
  let hash = 0x811c9dc5 ^ syscall ^ (flags << 8);
  for (const byte of path) hash = Math.imul(hash ^ byte, 0x01000193);
  return ((hash ^ (hash >>> 16)) & (SLOTS / WAYS - 1)) * WAYS;
}

function matches(view: DataView, bytes: Uint8Array, at: number,
                 name: Uint8Array, syscall: number, flags: number): boolean {
  if (view.getUint32(at, true) !== name.length || view.getUint32(at + 4, true) !== syscall
      || view.getUint32(at + 8, true) !== flags) return false;
  for (let i = 0; i < name.length; i++) if (bytes[at + 40 + i] !== name[i]) return false;
  return true;
}

export class StatLeasePublisher {
  readonly buffer = new SharedArrayBuffer(FIRST_SLOT + SLOT * SLOTS);
  readonly #header = new BigUint64Array(this.buffer, 0, 2);
  readonly #bytes = new Uint8Array(this.buffer);
  readonly #view = new DataView(this.buffer);
  readonly #epochs = new Uint32Array(SLOTS);
  #age = 0;
  #sequence = INITIAL_CLOSED;
  #open = false;
  #prepared?: object;
  #binding = 0n;
  #previousCandidate = 0n;
  #scope = 0n;

  constructor() { Atomics.store(this.#header, 0, this.#sequence); }

  close(): void {
    this.#prepared = undefined;
    if (!this.#open) return;
    this.#open = false;
    this.#sequence += 1n;
    Atomics.store(this.#header, 0, this.#sequence);
  }

  canOffer(binding: bigint): boolean {
    // A publication has one owner. Wait for consecutive eligible completions
    // before copying a certificate and replacing another process's entries.
    const same = this.#previousCandidate === binding;
    this.#previousCandidate = binding;
    return same;
  }

  prepareTicket(): object {
    // The guest is already fenced. The ticket only guards the trusted
    // publisher against a later kernel activity while completion is detached.
    this.close();
    const ticket = {};
    this.#prepared = ticket;
    return ticket;
  }

  ticket(): object | undefined { return this.#prepared; }

  publish(binding: bigint, certified: Uint8Array): boolean {
    this.close();
    if (this.#sequence === EXHAUSTED || binding <= 0n || binding > EXHAUSTED || certified.length !== CERT_BYTES) {
      return false;
    }
    const input = new DataView(certified.buffer, certified.byteOffset, certified.byteLength);
    const length = input.getUint32(CERT.PATH_LENGTH_OFFSET, true);
    const bucket = input.getUint32(CERT.BUCKET_OFFSET, true);
    const syscall = input.getUint32(CERT.SYSCALL_OFFSET, true);
    const flags = input.getUint32(CERT.FLAGS_OFFSET, true);
    const scope = input.getBigUint64(CERT.SCOPE_OFFSET, true);
    if (input.getUint32(CERT.MAGIC_OFFSET, true) !== CERT.MAGIC || input.getUint32(CERT.LENGTH_OFFSET, true) !== CERT_BYTES
        || length < 1 || length > PATH_BYTES || scope === 0n || bucket >= WORDS
        || input.getBigUint64(CERT_EPOCHS + 8 * bucket, true) !== input.getBigUint64(CERT.INODE_GENERATION_OFFSET, true)) {
      return false;
    }
    if (this.#binding !== binding || this.#scope !== scope || this.#age === 0xffffffff) {
      this.#bytes.fill(0, FIRST_SLOT);
      this.#epochs.fill(0);
      this.#age = 0;
      this.#binding = binding;
      this.#scope = scope;
    }

    const path = certified.subarray(CERT.PATH_OFFSET, CERT.PATH_OFFSET + length);
    const first = setOf(path, syscall, flags);
    let victim = first;
    for (let index = first; index < first + WAYS; index++) {
      if (matches(this.#view, this.#bytes, FIRST_SLOT + SLOT * index, path, syscall, flags)) {
        victim = index;
        break;
      }
      if (this.#epochs[index] < this.#epochs[victim]) victim = index;
    }
    const destination = FIRST_SLOT + SLOT * victim;
    this.#view.setUint32(destination, length, true);
    this.#view.setUint32(destination + 4, syscall, true);
    this.#view.setUint32(destination + 8, flags, true);
    this.#view.setUint32(destination + 12, bucket, true);
    this.#bytes.set(certified.subarray(CERT.ROUTE_OFFSET, CERT.BUCKET_OFFSET), destination + 16);
    this.#bytes.set(path, destination + 40);
    this.#bytes.set(certified.subarray(STAT_START, CERT_EPOCHS), destination + SLOT_STAT);
    this.#epochs[victim] = ++this.#age;
    // The shared payload keeps the pathname and route generations immediately
    // ahead of the bucket array. The lease sequence is the publication fence.
    this.#bytes.set(certified.subarray(CERT.ROUTE_OFFSET, CERT.INODE_GENERATION_OFFSET), 16);
    this.#bytes.set(certified.subarray(CERT_EPOCHS), 32);
    Atomics.store(this.#header, 1, binding);
    this.#sequence += 1n;
    this.#open = true;
    Atomics.store(this.#header, 0, this.#sequence);
    return true;
  }
}

export interface StatLeaseBinding {
  readonly buffer: SharedArrayBuffer;
  readonly token: bigint;
}

export function importsStatCache(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(entry => entry.module === STAT_CACHE_MODULE);
}

export function makeStatLeaseImport(
  memory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
  binding?: StatLeaseBinding,
): (pointer: number | bigint, output: number, request: number) => number {
  if (ptrWidth !== 4 || !binding) return () => 0;
  const reader = new StatLeaseReader(binding.buffer, binding.token);
  return (pointer, output, request): number => {
    if (typeof pointer !== "number") return 0;
    const syscall = request & STAT_CACHE_SYSCALL_MASK;
    const flags = request >>> STAT_CACHE_SYSCALL_BITS;
    const bytes = new Uint8Array(memory.buffer);
    const from = pointer >>> 0;
    const to = output >>> 0;
    if (!from || !to || from >= bytes.length || to > bytes.length - STAT_BYTES) return 0;
    const end = Math.min(from + PATH_BYTES + 1, bytes.length);
    let stop = from;
    while (stop < end && bytes[stop] !== 0) stop++;
    if (stop === end || stop === from) return 0;
    return Number(reader.copy(bytes.subarray(from, stop), syscall, flags, (result) => bytes.set(result, to)));
  };
}

export class StatLeaseReader {
  readonly #header: BigUint64Array;
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  readonly #copy = new Uint8Array(STAT_BYTES);
  readonly #binding: bigint;

  constructor(buffer: SharedArrayBuffer, binding: bigint) {
    this.#header = new BigUint64Array(buffer, 0, 2);
    this.#view = new DataView(buffer);
    this.#bytes = new Uint8Array(buffer);
    this.#binding = binding;
  }

  // The callback runs only with an owned, validated result. A failed read
  // leaves the caller's memory and its ordinary syscall fallback untouched.
  copy(name: Uint8Array, syscall: number, flags: number, commit: (result: Uint8Array) => void): boolean {
    if (!name.length || name.length > PATH_BYTES) return false;
    const sequence = Atomics.load(this.#header, 0);
    if (sequence === 0n || (sequence & 1n) !== 0n || Atomics.load(this.#header, 1) !== this.#binding) {
      return false;
    }
    const first = setOf(name, syscall, flags);
    for (let index = first; index < first + WAYS; index++) {
      const at = FIRST_SLOT + SLOT * index;
      if (!matches(this.#view, this.#bytes, at, name, syscall, flags)) continue;
      const bucket = this.#view.getUint32(at + 12, true);
      if (bucket >= WORDS
          || this.#view.getBigUint64(at + 16, true) !== this.#view.getBigUint64(16, true)
          || this.#view.getBigUint64(at + 24, true) !== this.#view.getBigUint64(24, true)
          || this.#view.getBigUint64(at + 32, true) !== this.#view.getBigUint64(32 + bucket * 8, true)) {
        return false;
      }
      this.#copy.set(this.#bytes.subarray(at + SLOT_STAT, at + SLOT));
      if (Atomics.load(this.#header, 0) !== sequence) return false;
      commit(this.#copy);
      return true;
    }
    return false;
  }
}
