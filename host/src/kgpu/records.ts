/**
 * Splitting the kernel's kgpu submission stream back into whole records.
 *
 * Ownership: the GPU worker uses this to find record boundaries in the byte
 * stream the kernel worker forwards from `kernel_kgpu_drain`, and to find
 * each submit record's stream extents. It decides nothing about a record's
 * meaning: the Rust executor decodes and validates every record again.
 *
 * WHY the worker reassembles: a record can be up to the kernel outbox's
 * capacity (256 KiB), four times the 64 KiB device ring, so the kernel
 * worker forwards drained bytes in ring-sized chunks and the record
 * boundaries are recovered here from the records' own counts. Field offsets
 * come from the generated `KGPU_RECORD_FIELDS`, never hand copies.
 */
import {
  KGPU_BUFFER_HEADER_SIZE,
  KGPU_EXTENT_SIZE,
  KGPU_MAX_BUFFERS,
  KGPU_MAX_EXTENTS,
  KGPU_OUTBOX_CAPACITY,
  KGPU_RECORD_FIELDS,
  KGPU_SUBMISSION_HEADER_SIZE,
} from "../generated/abi.ts";

const F = KGPU_RECORD_FIELDS;

/** A record the kernel cannot have written: the stream is out of step. */
export class KgpuRecordError extends Error {
  constructor(detail: string) {
    super(`malformed kgpu record stream: ${detail}`);
    this.name = "KgpuRecordError";
  }
}

/** The encoded length of the record at the start of `bytes`, or null while
 * more bytes are needed to know or to hold it. */
export function submissionRecordLength(bytes: Uint8Array): number | null {
  if (bytes.byteLength < KGPU_SUBMISSION_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extents = view.getUint32(F.submission.streamExtentCount, true);
  const buffers = view.getUint32(F.submission.bufferCount, true);
  if (extents > KGPU_MAX_EXTENTS || buffers > KGPU_MAX_BUFFERS) {
    throw new KgpuRecordError(`kgpu record counts ${extents} extents, ${buffers} buffers`);
  }
  let at = KGPU_SUBMISSION_HEADER_SIZE + extents * KGPU_EXTENT_SIZE;
  for (let i = 0; i < buffers; i++) {
    if (bytes.byteLength < at + KGPU_BUFFER_HEADER_SIZE) return null;
    const count = view.getUint32(at + F.buffer.extentCount, true);
    if (count > KGPU_MAX_EXTENTS) throw new KgpuRecordError(`kgpu record buffer of ${count} extents`);
    at += KGPU_BUFFER_HEADER_SIZE + count * KGPU_EXTENT_SIZE;
  }
  if (at > KGPU_OUTBOX_CAPACITY) throw new KgpuRecordError(`kgpu record of ${at} bytes exceeds the outbox`);
  return bytes.byteLength < at ? null : at;
}

/** Accumulates forwarded chunks and yields whole records in order. */
export class RecordAssembler {
  #bytes = new Uint8Array(KGPU_OUTBOX_CAPACITY + 64 * 1024);
  #start = 0;
  #end = 0;

  /** Bytes received but not yet returned as a record. */
  get pending(): number {
    return this.#end - this.#start;
  }

  append(chunk: Uint8Array): void {
    if (this.#end + chunk.byteLength > this.#bytes.byteLength) {
      // Compact; a partial record never exceeds the outbox capacity, so
      // the remainder plus one ring chunk always fits.
      this.#bytes.copyWithin(0, this.#start, this.#end);
      this.#end -= this.#start;
      this.#start = 0;
      if (this.#end + chunk.byteLength > this.#bytes.byteLength) {
        throw new KgpuRecordError(`kgpu record stream holds ${this.#end + chunk.byteLength} unconsumed bytes`);
      }
    }
    this.#bytes.set(chunk, this.#end);
    this.#end += chunk.byteLength;
  }

  /** The next whole record, as a view valid until the next `append`. */
  next(): Uint8Array | null {
    const available = this.#bytes.subarray(this.#start, this.#end);
    const length = submissionRecordLength(available);
    if (length === null) return null;
    this.#start += length;
    if (this.#start === this.#end) this.#start = this.#end = 0;
    return available.subarray(0, length);
  }
}

/** The stream extents of a submit record, as (offset, length) pairs. */
export function streamExtents(record: Uint8Array): { offset: number; length: number }[] {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const count = view.getUint32(F.submission.streamExtentCount, true);
  const extents: { offset: number; length: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = KGPU_SUBMISSION_HEADER_SIZE + i * KGPU_EXTENT_SIZE;
    extents.push({
      offset: Number(view.getBigUint64(at + F.extent.offset, true)),
      length: view.getUint32(at + F.extent.len, true),
    });
  }
  return extents;
}
