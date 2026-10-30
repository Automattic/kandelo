import { ERRNO } from "../generated/abi";

const OwnedBytes = Uint8Array;
const copyBytes = Function.prototype.call.bind(OwnedBytes.prototype.set) as (destination: Uint8Array, source: Uint8Array, offset?: number) => void;
const bytePrefix = Function.prototype.call.bind(OwnedBytes.prototype.subarray) as (source: Uint8Array<ArrayBuffer>, start: number, end: number) => Uint8Array<ArrayBuffer>;

export class FileReadBufferError extends Error {
  constructor(message: string, readonly errno: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileReadBufferError";
  }
}

export class FileReadBuffer {
  #bytes: Uint8Array<ArrayBuffer> = new OwnedBytes(0);
  #length = 0;
  #finished = false;

  constructor(readonly limit: number, initialCapacity = 0, private readonly overflowErrno: number = ERRNO.ENOMEM) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(initialCapacity) || initialCapacity < 0) {
      throw new FileReadBufferError("Invalid file-read memory allowance", ERRNO.EINVAL);
    }
    this.#grow(initialCapacity);
  }

  get length(): number { return this.#length; }
  get capacity(): number { return this.#bytes.byteLength; }

  append(bytes: Uint8Array): void {
    if (this.#finished) throw new FileReadBufferError("File-read result is already published", ERRNO.EINVAL);
    const required = this.#length + bytes.byteLength;
    if (!Number.isSafeInteger(required) || required > this.limit) {
      throw new FileReadBufferError(`Whole-file read exceeds its ${this.limit}-byte memory allowance; use ranged reads`, this.overflowErrno);
    }
    this.#grow(required);
    copyBytes(this.#bytes, bytes, this.#length);
    this.#length = required;
  }

  finish(): Uint8Array<ArrayBuffer> {
    this.#finished = true;
    return bytePrefix(this.#bytes, 0, this.#length);
  }

  #grow(required: number): void {
    if (required > this.limit) {
      throw new FileReadBufferError(`Whole-file read exceeds its ${this.limit}-byte memory allowance; use ranged reads`, this.overflowErrno);
    }
    if (required <= this.#bytes.byteLength) return;
    const capacity = Math.min(this.limit, Math.max(required, this.#bytes.byteLength * 2));
    let replacement: Uint8Array<ArrayBuffer>;
    try { replacement = new OwnedBytes(capacity); }
    catch (cause) { throw new FileReadBufferError("Unable to allocate whole-file read result", ERRNO.ENOMEM, { cause }); }
    copyBytes(replacement, bytePrefix(this.#bytes, 0, this.#length));
    this.#bytes = replacement;
  }
}
