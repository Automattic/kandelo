/**
 * Kandelo exchange, host side: the byte layouts shared with the kernel and
 * the cache that serves exchange input bytes to it.
 *
 * The kernel reads an input's bytes on demand through
 * `host_exchange_source_read`, which must answer synchronously. A cache miss
 * answers `-EAGAIN` and asks the side that offered the source (the main
 * thread on both hosts) for the range; when the bytes arrive the worker
 * caches them and wakes the blocked syscall, which reads again and hits.
 *
 * Layouts mirror `crates/runtime-core/src/exchange/wire.rs`. All integers are
 * little-endian; optional strings carry a u16 length with 0xFFFF for absent.
 */

export const EXCHANGE_ID_BYTES = 16;

/**
 * The exchange agent the kernel activates, and the environment it gets
 * (`crates/runtime-core/src/exchange/activation.rs`): the platform–image
 * contract path, as a child of init, started as root.
 */
export const EXCHANGE_AGENT_PATH = "/usr/libexec/kandelo/exchange-agent";
export const EXCHANGE_AGENT_ENV: readonly string[] = [
  "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  "KANDELO_EXCHANGE=/run/kandelo/exchange",
];

export type ExchangeActivation = "on-demand" | "off";

/** What the kernel reports about the consumer (spec: ExchangeConsumerState). */
export interface ExchangeConsumerState {
  state: "unavailable" | "idle" | "starting" | "ready";
  activation: ExchangeActivation;
  lastFailure?: { exitStatus?: number; signal?: number; errno?: number };
}
const ABSENT = 0xffff;
const EAGAIN = 11;
const EIO = 5;

/** One input entry as the kernel stages it. */
export interface ExchangeEntryRecord {
  readonly batch: Uint8Array;
  readonly kind: "file" | "directory" | "stream";
  readonly source: bigint;
  readonly size: bigint;
  /** Path components inside the batch, outermost first. */
  readonly path: readonly Uint8Array[];
  readonly mtimeMs: number;
  readonly index?: number;
  readonly mimeType?: Uint8Array;
  readonly originUrl?: Uint8Array;
  readonly originalName?: Uint8Array;
}

function pushOptional(parts: number[], bytes: Uint8Array | undefined): void {
  if (bytes === undefined) {
    parts.push(ABSENT & 0xff, ABSENT >> 8);
    return;
  }
  if (bytes.byteLength >= ABSENT) throw new RangeError("exchange metadata too long");
  parts.push(bytes.byteLength & 0xff, bytes.byteLength >> 8, ...bytes);
}

/** Encode an entry record for `kernel_exchange_add_entry`. */
export function encodeEntryRecord(entry: ExchangeEntryRecord): Uint8Array {
  if (entry.batch.byteLength !== EXCHANGE_ID_BYTES) throw new RangeError("batch id must be 16 bytes");
  const head = new Uint8Array(16 + 1 + 3 + 8 + 8 + 8 + 4 + 4);
  const view = new DataView(head.buffer);
  head.set(entry.batch, 0);
  head[16] = entry.kind === "file" ? 1 : entry.kind === "directory" ? 2 : 3;
  view.setBigUint64(20, entry.source, true);
  view.setBigUint64(28, entry.size, true);
  const seconds = Math.floor(entry.mtimeMs / 1000);
  view.setBigUint64(36, BigInt(Math.max(0, seconds)), true);
  view.setUint32(44, Math.max(0, Math.floor((entry.mtimeMs - seconds * 1000) * 1_000_000)), true);
  view.setUint32(48, entry.index ?? 0xffffffff, true);
  const tail: number[] = [entry.path.length & 0xff, entry.path.length >> 8];
  for (const component of entry.path) {
    if (component.byteLength >= ABSENT) throw new RangeError("path component too long");
    tail.push(component.byteLength & 0xff, component.byteLength >> 8, ...component);
  }
  pushOptional(tail, entry.mimeType);
  pushOptional(tail, entry.originUrl);
  pushOptional(tail, entry.originalName);
  const out = new Uint8Array(head.byteLength + tail.length);
  out.set(head, 0);
  out.set(tail, head.byteLength);
  return out;
}

export type ExchangeSettleOutcome = "removed" | "discarded" | "cancelled";

/** What the kernel reports, decoded. */
export type ExchangeNotification =
  | { kind: "committed"; batch: Uint8Array }
  | { kind: "settled"; batch: Uint8Array; outcome: ExchangeSettleOutcome; status: Uint8Array }
  | { kind: "status"; batch: Uint8Array; status: Uint8Array }
  | { kind: "source-released"; source: bigint }
  | { kind: "stream-demand"; source: bigint; free: number }
  | {
    kind: "output-published";
    output: Uint8Array;
    /** A FIFO the host reads once; its `size` is 0. */
    stream: boolean;
    size: bigint;
    name: Uint8Array;
    mimeType?: Uint8Array;
    derivedFrom: Uint8Array[];
  }
  | { kind: "output-withdrawn"; output: Uint8Array }
  | { kind: "stream-readable"; output: Uint8Array }
  | { kind: "consumer"; present: boolean }
  | { kind: "activation-check" }
  | { kind: "consumer-state"; consumer: ExchangeConsumerState }
  | { kind: "activation-timer"; delayMs: number };

class Reader {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(count: number): Uint8Array {
    const end = this.position + count;
    if (end > this.bytes.byteLength) throw new RangeError("truncated exchange record");
    const slice = this.bytes.slice(this.position, end);
    this.position = end;
    return slice;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    const b = this.take(2);
    return b[0]! | (b[1]! << 8);
  }
  u32(): number {
    return new DataView(this.take(4).buffer).getUint32(0, true);
  }
  u64(): bigint {
    return new DataView(this.take(8).buffer).getBigUint64(0, true);
  }
  string(): Uint8Array {
    return this.take(this.u16());
  }
  optional(): Uint8Array | undefined {
    const length = this.u16();
    return length === ABSENT ? undefined : this.take(length);
  }
}

const OUTCOMES: Record<number, ExchangeSettleOutcome> = { 1: "removed", 2: "discarded", 3: "cancelled" };
const CONSUMER_STATES: Record<number, ExchangeConsumerState["state"]> = {
  1: "unavailable",
  2: "idle",
  3: "starting",
  4: "ready",
};

/** Decode a buffer of notification records. Malformed input throws. */
export function decodeNotifications(bytes: Uint8Array): ExchangeNotification[] {
  const out: ExchangeNotification[] = [];
  let position = 0;
  while (position < bytes.byteLength) {
    if (position + 3 > bytes.byteLength) throw new RangeError("truncated exchange record header");
    const length = bytes[position]! | (bytes[position + 1]! << 8);
    if (length < 3 || position + length > bytes.byteLength) throw new RangeError("bad exchange record length");
    const reader = new Reader(bytes.slice(position + 3, position + length));
    const kind = bytes[position + 2]!;
    switch (kind) {
      case 1:
        out.push({ kind: "committed", batch: reader.take(16) });
        break;
      case 2: {
        const batch = reader.take(16);
        const outcome = OUTCOMES[reader.u8()];
        if (outcome === undefined) throw new RangeError("bad exchange outcome");
        out.push({ kind: "settled", batch, outcome, status: reader.string() });
        break;
      }
      case 3:
        out.push({ kind: "status", batch: reader.take(16), status: reader.string() });
        break;
      case 4:
        out.push({ kind: "source-released", source: reader.u64() });
        break;
      case 5: {
        const output = reader.take(16);
        const outputKind = reader.u8();
        if (outputKind !== 1 && outputKind !== 2) throw new RangeError("bad exchange output kind");
        const stream = outputKind === 2;
        const size = reader.u64();
        const name = reader.string();
        const mimeType = reader.optional();
        const count = reader.u16();
        const derivedFrom: Uint8Array[] = [];
        for (let i = 0; i < count; i++) derivedFrom.push(reader.take(16));
        out.push({ kind: "output-published", output, stream, size, name, ...(mimeType ? { mimeType } : {}), derivedFrom });
        break;
      }
      case 6:
        out.push({ kind: "output-withdrawn", output: reader.take(16) });
        break;
      case 7:
        out.push({ kind: "consumer", present: reader.u8() === 1 });
        break;
      case 8: {
        const source = reader.u64();
        out.push({ kind: "stream-demand", source, free: reader.u32() });
        break;
      }
      case 9:
        out.push({ kind: "stream-readable", output: reader.take(16) });
        break;
      case 10:
        out.push({ kind: "activation-check" });
        break;
      case 11: {
        const state = CONSUMER_STATES[reader.u8()];
        const activation = reader.u8() === 1 ? "on-demand" : "off";
        const failureKind = reader.u8();
        const value = new DataView(reader.take(4).buffer).getInt32(0, true);
        if (state === undefined || failureKind > 3) throw new RangeError("bad exchange consumer state");
        const lastFailure = failureKind === 1 ? { exitStatus: value }
          : failureKind === 2 ? { signal: value }
          : failureKind === 3 ? { errno: value }
          : undefined;
        out.push({ kind: "consumer-state", consumer: { state, activation, ...(lastFailure ? { lastFailure } : {}) } });
        break;
      }
      case 12:
        out.push({ kind: "activation-timer", delayMs: reader.u32() });
        break;
      default:
        throw new RangeError(`unknown exchange record kind ${kind}`);
    }
    if (reader.position !== reader.bytes.byteLength) throw new RangeError("trailing bytes in exchange record");
    position += length;
  }
  return out;
}

const HEX = "0123456789abcdef";

/** Canonical text form of an exchange ID. */
export function formatExchangeId(id: Uint8Array): string {
  let text = "";
  for (let i = 0; i < id.byteLength; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) text += "-";
    text += HEX[id[i]! >> 4]! + HEX[id[i]! & 0xf]!;
  }
  return text;
}

/** Parse the canonical text form; throws on anything else. */
export function parseExchangeId(text: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    throw new RangeError(`not an exchange id: ${text}`);
  }
  const hex = text.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Asks the side that offered `source` for `length` bytes at `offset`. */
export type ExchangeRangeRequester = (source: bigint, offset: bigint, length: number) => void;

interface CachedRange {
  offset: bigint;
  bytes: Uint8Array;
  /** How many bytes were asked for; fewer means the source ran out. */
  requested: number;
}

/**
 * Serves `host_exchange_source_read` from fetched ranges. Reads are clamped
 * by the kernel to the file's size, so a short answer from the source is end
 * of data. Each source keeps one window; a miss asks for a whole window, so
 * sequential reads fetch once per window, not once per syscall.
 */
export class ExchangeSourceCache {
  readonly #windows = new Map<bigint, CachedRange>();
  readonly #inFlight = new Map<bigint, bigint>();
  readonly #failed = new Map<bigint, number>();
  readonly #request: ExchangeRangeRequester;
  readonly #windowBytes: number;

  constructor(request: ExchangeRangeRequester, windowBytes = 1 << 20) {
    this.#request = request;
    this.#windowBytes = windowBytes;
  }

  /**
   * The kernel import: bytes, `-EAGAIN` while fetching, or `-errno`. The
   * kernel never reads past a file's declared size, so a read beyond a short
   * window means the source is shorter than it claimed: EIO, not end of file.
   */
  read(source: bigint, offset: bigint, dest: Uint8Array): number {
    const failure = this.#failed.get(source);
    if (failure !== undefined) return -failure;
    const window = this.#windows.get(source);
    if (window !== undefined && offset >= window.offset) {
      const start = Number(offset - window.offset);
      if (start < window.bytes.byteLength) {
        const count = Math.min(window.bytes.byteLength - start, dest.byteLength);
        dest.set(window.bytes.subarray(start, start + count));
        return count;
      }
      if (start < window.requested) return -EIO;
    }
    if (this.#inFlight.get(source) !== offset) {
      this.#inFlight.set(source, offset);
      this.#request(source, offset, Math.max(this.#windowBytes, dest.byteLength));
    }
    return -EAGAIN;
  }

  /** The source answered a request for `requested` bytes at `offset`. */
  fulfill(source: bigint, offset: bigint, requested: number, bytes: Uint8Array): void {
    if (this.#inFlight.get(source) === offset) this.#inFlight.delete(source);
    this.#windows.set(source, { offset, bytes, requested });
  }

  /** The source could not answer: later reads fail with `errno` (EIO if unset). */
  fail(source: bigint, errno = EIO): void {
    this.#inFlight.delete(source);
    this.#windows.delete(source);
    this.#failed.set(source, errno);
  }

  /** The kernel no longer references the source. */
  release(source: bigint): void {
    this.#inFlight.delete(source);
    this.#windows.delete(source);
    this.#failed.delete(source);
  }

  /** Sources with cached bytes, for diagnostics. */
  get cachedSources(): number {
    return this.#windows.size;
  }
}

// ---- Worker protocol, shared by the Node.js and browser hosts -----------

/** One entry of an offer as the main thread sends it to the kernel worker. */
export interface ExchangeOfferEntry {
  kind: "file" | "directory" | "stream";
  /** Host source id; 0 for directories. Streams have size 0. */
  source: bigint;
  size: bigint;
  path: string[];
  mtimeMs: number;
  index?: number;
  mimeType?: string;
  originUrl?: string;
  originalName?: string;
}

/** A request from the main thread to the kernel worker's exchange. */
export type ExchangeWorkerRequest =
  | { op: "set_listener"; present: boolean }
  | { op: "consumer" }
  | { op: "consumer_state" }
  | { op: "offer"; label: string; entries: ExchangeOfferEntry[] }
  | { op: "cancel"; batch: Uint8Array }
  | { op: "read_output"; output: Uint8Array; offset: number; length: number }
  | { op: "release_output"; output: Uint8Array }
  | { op: "stream_push"; source: bigint; bytes: Uint8Array }
  | { op: "stream_end"; source: bigint; failed: boolean }
  | { op: "stream_start"; output: Uint8Array }
  | { op: "stream_read"; output: Uint8Array; length: number }
  | { op: "output_end"; output: Uint8Array }
  | { op: "interest"; delta: 1 | -1 };

/** Main → kernel worker: a request, answered with the generic response. */
export interface ExchangeRequestMessage {
  type: "exchange_request";
  requestId: number;
  request: ExchangeWorkerRequest;
}

/** Main → kernel worker: the bytes (or failure) for a range request. */
export interface ExchangeRangeMessage {
  type: "exchange_range";
  source: bigint;
  offset: bigint;
  requested: number;
  bytes?: Uint8Array;
  errno?: number;
}

/** Kernel worker → main: read `length` bytes of `source` at `offset`. */
export interface ExchangeRangeRequestMessage {
  type: "exchange_range_request";
  source: bigint;
  offset: bigint;
  length: number;
}

/** Kernel worker → main: what the kernel reported. */
export interface ExchangeNotificationsMessage {
  type: "exchange_notifications";
  notifications: ExchangeNotification[];
}

/** Run one exchange request against the kernel worker (CentralizedKernelWorker.exchangeRequest). */
export async function runExchangeRequest(
  worker: {
    exchangeSetListener(present: boolean): Promise<void>;
    exchangeConsumerPresent(): Promise<boolean>;
    exchangeConsumerState(): Promise<ExchangeConsumerState | null>;
    exchangeOffer(offer: { label: string; entries: readonly Omit<ExchangeEntryRecord, "batch">[] }): Promise<unknown>;
    exchangeCancel(batch: Uint8Array): Promise<number>;
    exchangeReadOutput(output: Uint8Array, offset: number, length: number): Promise<Uint8Array | number>;
    exchangeReleaseOutput(output: Uint8Array): Promise<number>;
    exchangeStreamPush(source: bigint, bytes: Uint8Array): Promise<number>;
    exchangeStreamEnd(source: bigint, failed: boolean): Promise<number>;
    exchangeStreamStart(output: Uint8Array): Promise<number>;
    exchangeStreamRead(output: Uint8Array, length: number): Promise<Uint8Array | number>;
    exchangeOutputEnd(output: Uint8Array): Promise<Uint8Array | number>;
    adjustExchangeInterest(delta: 1 | -1): void;
  },
  request: ExchangeWorkerRequest,
): Promise<unknown> {
  const encoder = new TextEncoder();
  switch (request.op) {
    case "set_listener":
      return worker.exchangeSetListener(request.present);
    case "consumer":
      return worker.exchangeConsumerPresent();
    case "consumer_state":
      return worker.exchangeConsumerState();
    case "offer":
      return worker.exchangeOffer({
        label: request.label,
        entries: request.entries.map((entry) => ({
          kind: entry.kind,
          source: entry.source,
          size: entry.size,
          path: entry.path.map((component) => encoder.encode(component)),
          mtimeMs: entry.mtimeMs,
          ...(entry.index !== undefined ? { index: entry.index } : {}),
          ...(entry.mimeType !== undefined ? { mimeType: encoder.encode(entry.mimeType) } : {}),
          ...(entry.originUrl !== undefined ? { originUrl: encoder.encode(entry.originUrl) } : {}),
          ...(entry.originalName !== undefined ? { originalName: encoder.encode(entry.originalName) } : {}),
        })),
      });
    case "cancel":
      return worker.exchangeCancel(request.batch);
    case "read_output":
      return worker.exchangeReadOutput(request.output, request.offset, request.length);
    case "release_output":
      return worker.exchangeReleaseOutput(request.output);
    case "stream_push":
      return worker.exchangeStreamPush(request.source, request.bytes);
    case "stream_end":
      return worker.exchangeStreamEnd(request.source, request.failed);
    case "stream_start":
      return worker.exchangeStreamStart(request.output);
    case "stream_read":
      return worker.exchangeStreamRead(request.output, request.length);
    case "output_end":
      return worker.exchangeOutputEnd(request.output);
    case "interest":
      worker.adjustExchangeInterest(request.delta);
      return undefined;
  }
}
