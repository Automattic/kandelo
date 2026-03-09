const HEADER_SIZE = 16;
const HEAD_OFFSET = 0;
const TAIL_OFFSET = 1; // Int32Array index (4 bytes each)
const LEN_OFFSET = 2;
const FLAGS_OFFSET = 3;
const FLAG_READ_OPEN = 1;
const FLAG_WRITE_OPEN = 2;

export class SharedPipeBuffer {
  private meta: Int32Array; // View of header (4 x Int32)
  private data: Uint8Array; // View of ring buffer data
  private cap: number;
  private sab: SharedArrayBuffer;

  private constructor(sab: SharedArrayBuffer, capacity: number) {
    this.sab = sab;
    this.cap = capacity;
    this.meta = new Int32Array(sab, 0, 4);
    this.data = new Uint8Array(sab, HEADER_SIZE, capacity);
  }

  static create(capacity: number = 65536): SharedPipeBuffer {
    const sab = new SharedArrayBuffer(HEADER_SIZE + capacity);
    const pipe = new SharedPipeBuffer(sab, capacity);
    Atomics.store(pipe.meta, HEAD_OFFSET, 0);
    Atomics.store(pipe.meta, TAIL_OFFSET, 0);
    Atomics.store(pipe.meta, LEN_OFFSET, 0);
    Atomics.store(pipe.meta, FLAGS_OFFSET, FLAG_READ_OPEN | FLAG_WRITE_OPEN);
    return pipe;
  }

  static fromSharedBuffer(sab: SharedArrayBuffer): SharedPipeBuffer {
    const capacity = sab.byteLength - HEADER_SIZE;
    return new SharedPipeBuffer(sab, capacity);
  }

  getBuffer(): SharedArrayBuffer {
    return this.sab;
  }

  capacity(): number {
    return this.cap;
  }

  available(): number {
    return Atomics.load(this.meta, LEN_OFFSET);
  }

  isReadOpen(): boolean {
    return (Atomics.load(this.meta, FLAGS_OFFSET) & FLAG_READ_OPEN) !== 0;
  }

  isWriteOpen(): boolean {
    return (Atomics.load(this.meta, FLAGS_OFFSET) & FLAG_WRITE_OPEN) !== 0;
  }

  write(src: Uint8Array): number {
    const len = Atomics.load(this.meta, LEN_OFFSET);
    const free = this.cap - len;
    const n = Math.min(src.length, free);
    if (n === 0) return 0;

    let tail = Atomics.load(this.meta, TAIL_OFFSET);
    for (let i = 0; i < n; i++) {
      this.data[tail] = src[i];
      tail = (tail + 1) % this.cap;
    }
    Atomics.store(this.meta, TAIL_OFFSET, tail);
    Atomics.add(this.meta, LEN_OFFSET, n);
    return n;
  }

  read(dst: Uint8Array): number {
    const len = Atomics.load(this.meta, LEN_OFFSET);
    const n = Math.min(dst.length, len);
    if (n === 0) return 0;

    let head = Atomics.load(this.meta, HEAD_OFFSET);
    for (let i = 0; i < n; i++) {
      dst[i] = this.data[head];
      head = (head + 1) % this.cap;
    }
    Atomics.store(this.meta, HEAD_OFFSET, head);
    Atomics.sub(this.meta, LEN_OFFSET, n);
    return n;
  }

  closeRead(): void {
    Atomics.and(this.meta, FLAGS_OFFSET, ~FLAG_READ_OPEN);
  }

  closeWrite(): void {
    Atomics.and(this.meta, FLAGS_OFFSET, ~FLAG_WRITE_OPEN);
  }
}
