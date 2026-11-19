/** Independent byte storage: trimming diagnostics must neither retain old
 * whole-history strings nor truncate an in-flight Sway IPC reply. */
class ByteTail {
  private readonly bytes: Uint8Array;
  private end = 0;
  private size = 0;
  discarded = 0;
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw RangeError('Invalid diagnostic tail capacity');
    this.bytes = new Uint8Array(capacity);
  }
  append(input: Uint8Array): void {
    const overflow = Math.max(0, this.size + input.length - this.capacity);
    if (input.length >= this.capacity) {
      this.bytes.set(input.subarray(input.length - this.capacity));
      this.end = 0; this.size = this.capacity;
    } else {
      const first = Math.min(input.length, this.capacity - this.end);
      this.bytes.set(input.subarray(0, first), this.end);
      this.bytes.set(input.subarray(first), 0);
      this.end = (this.end + input.length) % this.capacity;
      this.size = Math.min(this.capacity, this.size + input.length);
    }
    this.discarded += overflow;
  }
  text(): string {
    const result = new Uint8Array(this.size);
    const start = (this.end - this.size + this.capacity) % this.capacity;
    const first = Math.min(this.size, this.capacity - start);
    result.set(this.bytes.subarray(start, start + first));
    result.set(this.bytes.subarray(0, this.size - first), first);
    // A retained suffix can start inside a UTF-8 character. Drop that partial
    // prefix instead of presenting it as corruption in the original stream.
    let begin = 0;
    if (this.discarded) while (begin < result.length && (result[begin] & 0xc0) === 0x80) begin++;
    return new TextDecoder().decode(result.subarray(begin));
  }
}

export class DesktopOutputCapture {
  private readonly out: ByteTail;
  private readonly err: ByteTail;
  private active?: Uint8Array[];
  constructor(readonly tailBytes = 65536) {
    this.out = new ByteTail(tailBytes); this.err = new ByteTail(tailBytes);
  }
  get stdout(): string { return this.out.text(); }
  get stderr(): string { return this.err.text(); }
  get stdoutDiscardedBytes(): number { return this.out.discarded; }
  get stderrDiscardedBytes(): number { return this.err.discarded; }
  appendStdout(bytes: Uint8Array): void {
    // Callback buffers may be reused after delivery. Own each command chunk
    // independently; the diagnostic ring never owns its command's history.
    const copy = this.active ? Uint8Array.from(bytes) : undefined;
    this.out.append(bytes);
    if (copy) this.active!.push(copy);
  }
  appendStderr(bytes: Uint8Array): void { this.err.append(bytes); }
  async capture(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
    if (this.active) throw Error('A desktop command already owns stdout capture');
    const chunks: Uint8Array[] = []; this.active = chunks;
    try {
      const code = await run(), decoder = new TextDecoder();
      const text = chunks.map(chunk => decoder.decode(chunk, { stream: true }));
      text.push(decoder.decode());
      return { code, stdout: text.join('') };
    } finally { this.active = undefined; }
  }
}
