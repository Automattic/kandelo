/**
 * Kandelo exchange on the main thread: the host interface, shared by the
 * Node.js and browser hosts so both behave the same.
 *
 * The kernel worker owns exchange state; this side owns what the kernel
 * cannot: the sources behind inputs (Blobs) and the leases on outputs.
 *
 * - `offer()` stages a batch. It resolves once the batch is visible to the
 *   guest, or rejects with a typed reason. A batch waiting for a consumer
 *   resolves when one arrives, or fails with `consumer-timeout`.
 *   A `Blob` becomes a regular file whose bytes are read on demand; a
 *   `ReadableStream` becomes a FIFO the host writes as readers make room.
 * - `onOutput()` registers the single output listener. Each output's lease
 *   lasts until the listener's returned promise settles and every stream
 *   from `read()` has closed; then the output is released from `outbox/`.
 *   A listener that ignores an output releases it at once, so ignoring
 *   leaks nothing. Aborting the listener's signal ends every lease. A
 *   streamed output is read once, and its stream closes only if the guest
 *   declared it `complete`.
 *
 * Nothing here turns an output into a file, a download, or anything else:
 * that is the embedding app's decision.
 */

import {
  type ExchangeConsumerState,
  formatExchangeId,
  parseExchangeId,
  type ExchangeNotification,
  type ExchangeOfferEntry,
  type ExchangeRangeMessage,
  type ExchangeWorkerRequest,
} from "./exchange-host";

/** One file or directory the host offers. */
export interface ExchangeItem {
  name: string;
  /** Directories inside the batch, outermost first (folder drops). */
  dirs?: readonly string[];
  /** The bytes: a Blob (a file) or a stream (a FIFO); omit for an empty directory. */
  source?: Blob | ReadableStream<Uint8Array>;
  mimeType?: string;
  modifiedMs?: number;
  originUrl?: string;
}

export type ExchangeSource = "drop" | "picker" | "paste" | "share" | "api";
export type { ExchangeConsumerState };

export type ExchangeOfferFailure =
  /** No executable at the agent path and no consumer: nothing could take it. */
  | "unavailable"
  | "consumer-timeout"
  | "quota"
  | "invalid-name"
  | "aborted"
  | "failed";

export class ExchangeOfferError extends Error {
  constructor(readonly reason: ExchangeOfferFailure, message: string) {
    super(message);
    this.name = "ExchangeOfferError";
  }
}

export interface ExchangeSettlement {
  outcome: "removed" | "discarded" | "cancelled";
  status?: string;
}

export interface ExchangeBatch {
  readonly id: string;
  readonly entries: readonly { id: string; path: string }[];
  readonly status: string | undefined;
  onStatus(listener: (status: string) => void): () => void;
  /** Resolves when the batch leaves the inbox. */
  readonly settled: Promise<ExchangeSettlement>;
  /** Resolves when the kernel references none of the batch's sources. */
  readonly released: Promise<void>;
  cancel(): void;
}

export interface ExchangeOutput {
  readonly id: string;
  readonly name: string;
  readonly kind: "stored" | "stream";
  /** Stored outputs only. */
  readonly size?: number;
  readonly mimeType?: string;
  readonly derivedFrom: readonly string[];
  /**
   * Stored: bytes from `range.start` (default 0) to `range.end` (default the
   * end), any number of times. Stream: the bytes as the guest writes them,
   * once; the stream errors unless the guest declared it `complete`.
   */
  read(range?: { start?: number; end?: number }): ReadableStream<Uint8Array>;
  /** Resolves when the guest withdraws the output. */
  readonly withdrawn: Promise<void>;
}

export type ExchangeOutputListener = (
  output: ExchangeOutput,
  scope: { signal: AbortSignal },
) => void | Promise<void>;

export interface ExchangeStats {
  sources: number;
  batches: number;
  leases: number;
  listener: boolean;
}

/** How the controller talks to the kernel worker. */
export interface ExchangeTransport {
  request(request: ExchangeWorkerRequest): Promise<unknown>;
  sendRange(message: ExchangeRangeMessage, transfer: Transferable[]): void;
}

const READ_CHUNK_BYTES = 64 * 1024;
const EAGAIN = 11;

/** A host stream feeding an input FIFO. */
interface StreamSource {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Bytes read from the stream that the FIFO had no room for yet. */
  pending: Uint8Array | null;
  /** The kernel's last report of room, in bytes. */
  room: number;
  /** A report arrived since the pump last pushed (it is then authoritative). */
  roomReported: boolean;
  pumping: boolean;
  ended: boolean;
}

/**
 * The exchange quota for `work/` and `outbox/`: the smaller of 256 MiB and a
 * quarter of the kernel's memory, since those bytes live in kernel memory.
 */
export function exchangeByteLimit(kernelMaxPages: number): number {
  return Math.min(256 * 1024 * 1024, Math.floor((kernelMaxPages * 65536) / 4));
}
const DEFAULT_CONSUMER_TIMEOUT_MS = 30_000;
const decoder = new TextDecoder();

/**
 * A batch is tracked until it has both settled and released every source:
 * the kernel reports a settlement before the source releases it causes.
 */
interface BatchState {
  settle: (settlement: ExchangeSettlement) => void;
  settled: boolean;
  commit?: () => void;
  /** Ends a pending offer's wait when the batch settles before it commits. */
  fail?: (error: ExchangeOfferError) => void;
  status: string | undefined;
  statusListeners: Set<(status: string) => void>;
  sources: Set<bigint>;
  releaseResolvers: Array<() => void>;
}

interface Lease {
  abort: AbortController;
  openStreams: number;
  scopeSettled: boolean;
  released: boolean;
  withdraw: () => void;
}

export class ExchangeController {
  readonly #transport: ExchangeTransport;
  readonly #sources = new Map<bigint, Blob>();
  readonly #streams = new Map<bigint, StreamSource>();
  /** Wakes a streamed output's reader when the kernel reports bytes. */
  readonly #readable = new Map<string, () => void>();
  #nextSource = 1n;
  readonly #batches = new Map<string, BatchState>();
  readonly #leases = new Map<string, Lease>();
  #consumer: ExchangeConsumerState | null = null;
  readonly #consumerListeners = new Set<(state: ExchangeConsumerState) => void>();
  #listener: { callback: ExchangeOutputListener; signal: AbortSignal } | null = null;

  constructor(transport: ExchangeTransport) {
    this.#transport = transport;
  }

  /** Whether a consumer holds `events` now. */
  async consumerPresent(): Promise<boolean> {
    return (await this.#transport.request({ op: "consumer" })) === true;
  }

  /**
   * The last consumer state the kernel reported, or null before the first
   * report. Reports arrive while an offer, a lease, or an `onConsumer`
   * listener is live; `consumerState()` asks the kernel now.
   */
  get consumer(): ExchangeConsumerState | null {
    return this.#consumer;
  }

  /** Ask the kernel for its consumer state now. */
  async consumerState(): Promise<ExchangeConsumerState | null> {
    const state = (await this.#transport.request({ op: "consumer_state" })) as ExchangeConsumerState | null;
    if (state !== null) this.#setConsumer(state);
    return this.#consumer;
  }

  /** Follow the consumer state; returns the unsubscribe function. */
  onConsumer(listener: (state: ExchangeConsumerState) => void): () => void {
    this.#consumerListeners.add(listener);
    if (this.#consumerListeners.size === 1) this.#fireAndForget({ op: "interest", delta: 1 });
    void this.consumerState();
    return () => {
      if (this.#consumerListeners.delete(listener) && this.#consumerListeners.size === 0) {
        this.#fireAndForget({ op: "interest", delta: -1 });
      }
    };
  }

  #setConsumer(state: ExchangeConsumerState): void {
    const before = this.#consumer;
    this.#consumer = state;
    if (JSON.stringify(before) === JSON.stringify(state)) return;
    for (const listener of this.#consumerListeners) listener(state);
  }

  /** Offer files to the guest as one batch. */
  async offer(
    items: readonly ExchangeItem[],
    options: { source?: ExchangeSource; signal?: AbortSignal; consumerTimeoutMs?: number } = {},
  ): Promise<ExchangeBatch> {
    if (options.signal?.aborted) throw new ExchangeOfferError("aborted", "offer aborted");
    const sources = new Set<bigint>();
    const entries: ExchangeOfferEntry[] = items.map((item, index) => {
      const path = [...(item.dirs ?? []), item.name];
      const base = {
        path,
        mtimeMs: item.modifiedMs ?? Date.now(),
        index,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.originUrl ? { originUrl: item.originUrl } : {}),
      };
      if (item.source === undefined) {
        return { kind: "directory", source: 0n, size: 0n, ...base };
      }
      const source = this.#nextSource++;
      sources.add(source);
      if (item.source instanceof ReadableStream) {
        this.#streams.set(source, {
          reader: item.source.getReader(),
          pending: null,
          room: 0,
          roomReported: false,
          pumping: false,
          ended: false,
        });
        return { kind: "stream", source, size: 0n, ...base };
      }
      this.#sources.set(source, item.source);
      return { kind: "file", source, size: BigInt(item.source.size), ...base };
    });
    await this.#transport.request({ op: "interest", delta: 1 });
    let result: { ok: boolean; errno?: number; batch?: Uint8Array; entries?: Uint8Array[]; committed?: boolean };
    try {
      result = (await this.#transport.request({
        op: "offer",
        label: options.source ?? "api",
        entries,
      })) as typeof result;
    } catch (error) {
      this.#dropSources(sources);
      await this.#transport.request({ op: "interest", delta: -1 });
      throw error;
    }
    if (!result.ok) {
      this.#dropSources(sources);
      await this.#transport.request({ op: "interest", delta: -1 });
      throw offerFailure(result.errno ?? 5);
    }
    const id = formatExchangeId(result.batch!);
    let settle!: (settlement: ExchangeSettlement) => void;
    const settled = new Promise<ExchangeSettlement>((resolve) => (settle = resolve));
    const state: BatchState = {
      settle,
      settled: false,
      status: undefined,
      statusListeners: new Set(),
      sources,
      releaseResolvers: [],
    };
    const released = new Promise<void>((resolve) => state.releaseResolvers.push(resolve));
    if (sources.size === 0) state.releaseResolvers.splice(0).forEach((resolve) => resolve());
    this.#batches.set(id, state);
    // The offer's interest lasts until the batch has settled and released
    // every source (see #forgetIfDone), so the host keeps learning of
    // releases and stream demand after the settlement.
    const batch: ExchangeBatch = {
      id,
      entries: result.entries!.map((entryId, index) => ({
        id: formatExchangeId(entryId),
        path: entries[index]!.path.join("/"),
      })),
      get status() {
        return state.status;
      },
      onStatus: (listener) => {
        state.statusListeners.add(listener);
        return () => state.statusListeners.delete(listener);
      },
      settled,
      released,
      cancel: () => {
        this.#fireAndForget({ op: "cancel", batch: parseExchangeId(id) });
      },
    };
    if (!result.committed) {
      // Pending: wait for a consumer, bounded by the caller's patience.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          batch.cancel();
          reject(new ExchangeOfferError("consumer-timeout", "no consumer opened events in time"));
        }, options.consumerTimeoutMs ?? DEFAULT_CONSUMER_TIMEOUT_MS);
        const onAbort = () => {
          clearTimeout(timeout);
          batch.cancel();
          reject(new ExchangeOfferError("aborted", "offer aborted"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        state.commit = () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
          state.fail = undefined;
          resolve();
        };
        // The kernel could not commit it (it settles without committing).
        state.fail = (error) => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
          state.commit = undefined;
          reject(error);
        };
      });
    }
    // Aborting after the batch is visible cancels it.
    options.signal?.addEventListener("abort", () => batch.cancel(), { once: true });
    return batch;
  }

  /** Register the single output listener for as long as `signal` is live. */
  onOutput(callback: ExchangeOutputListener, options: { signal: AbortSignal }): void {
    if (this.#listener !== null && !this.#listener.signal.aborted) {
      throw new Error("an exchange output listener is already registered");
    }
    if (options.signal.aborted) return;
    this.#listener = { callback, signal: options.signal };
    this.#fireAndForget({ op: "interest", delta: 1 });
    this.#fireAndForget({ op: "set_listener", present: true });
    options.signal.addEventListener(
      "abort",
      () => {
        if (this.#listener?.signal === options.signal) this.#listener = null;
        for (const lease of this.#leases.values()) lease.abort.abort();
        this.#fireAndForget({ op: "set_listener", present: false });
        this.#fireAndForget({ op: "interest", delta: -1 });
      },
      { once: true },
    );
  }

  stats(): ExchangeStats {
    return {
      sources: this.#sources.size + this.#streams.size,
      batches: this.#batches.size,
      leases: this.#leases.size,
      listener: this.#listener !== null && !this.#listener.signal.aborted,
    };
  }

  /** The kernel worker asked for bytes of a source. */
  handleRangeRequest(source: bigint, offset: bigint, length: number): void {
    const blob = this.#sources.get(source);
    if (blob === undefined) {
      this.#transport.sendRange({ type: "exchange_range", source, offset, requested: length, errno: 5 }, []);
      return;
    }
    const start = Number(offset);
    blob
      .slice(start, start + length)
      .arrayBuffer()
      .then(
        (buffer) => {
          const bytes = new Uint8Array(buffer);
          this.#transport.sendRange(
            { type: "exchange_range", source, offset, requested: length, bytes },
            [buffer],
          );
        },
        () => {
          // NotReadableError: the file changed or vanished after the offer.
          this.#transport.sendRange({ type: "exchange_range", source, offset, requested: length, errno: 5 }, []);
        },
      );
  }

  /** The kernel reported what happened. */
  handleNotifications(notifications: readonly ExchangeNotification[]): void {
    for (const notification of notifications) {
      switch (notification.kind) {
        case "committed": {
          const state = this.#batches.get(formatExchangeId(notification.batch));
          state?.commit?.();
          if (state) state.commit = undefined;
          break;
        }
        case "settled": {
          const id = formatExchangeId(notification.batch);
          const state = this.#batches.get(id);
          if (state === undefined || state.settled) break;
          state.settled = true;
          state.commit = undefined;
          const status = decoder.decode(notification.status);
          if (state.fail) {
            state.fail(new ExchangeOfferError("failed", status || `the batch was ${notification.outcome} before it was delivered`));
            state.fail = undefined;
          }
          state.settle({ outcome: notification.outcome, ...(status ? { status } : {}) });
          this.#forgetIfDone(id, state);
          break;
        }
        case "status": {
          const state = this.#batches.get(formatExchangeId(notification.batch));
          if (state === undefined) break;
          state.status = decoder.decode(notification.status);
          for (const listener of state.statusListeners) listener(state.status);
          break;
        }
        case "source-released":
          this.#releaseSource(notification.source);
          break;
        case "stream-demand": {
          const stream = this.#streams.get(notification.source);
          if (stream === undefined) break;
          stream.room = notification.free;
          stream.roomReported = true;
          void this.#pump(notification.source, stream);
          break;
        }
        case "stream-readable":
          this.#readable.get(formatExchangeId(notification.output))?.();
          break;
        case "output-published":
          this.#deliverOutput(notification);
          break;
        case "output-withdrawn": {
          const id = formatExchangeId(notification.output);
          this.#leases.get(id)?.withdraw();
          this.#readable.get(id)?.();
          break;
        }
        case "consumer":
          break;
        case "consumer-state":
          this.#setConsumer(notification.consumer);
          break;
        case "activation-check":
        case "activation-timer":
          break;
      }
    }
  }

  /** A request whose answer nothing waits for; a failure (the kernel is gone) is not an unhandled rejection. */
  #fireAndForget(request: ExchangeWorkerRequest): void {
    this.#transport.request(request).catch(() => {});
  }

  #dropSources(sources: Set<bigint>): void {
    for (const source of sources) {
      this.#sources.delete(source);
      this.#dropStream(source);
    }
  }

  /** The kernel no longer reaches a stream: stop and cancel it. */
  #dropStream(source: bigint): void {
    const stream = this.#streams.get(source);
    if (stream === undefined) return;
    this.#streams.delete(source);
    stream.ended = true;
    stream.reader.cancel().catch(() => {});
  }

  /**
   * Feed an input stream into its FIFO while the kernel reports room. Chunks
   * larger than the room wait in `pending`; the next demand resumes.
   */
  async #pump(source: bigint, stream: StreamSource): Promise<void> {
    if (stream.pumping || stream.ended) return;
    stream.pumping = true;
    try {
      while (!stream.ended && stream.room > 0) {
        if (stream.pending === null) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await stream.reader.read();
          } catch {
            stream.ended = true;
            await this.#transport.request({ op: "stream_end", source, failed: true });
            return;
          }
          if (stream.ended) return;
          if (next.done) {
            stream.ended = true;
            await this.#transport.request({ op: "stream_end", source, failed: false });
            return;
          }
          if (next.value.byteLength === 0) continue;
          stream.pending = next.value;
        }
        const chunk = stream.pending.subarray(0, stream.room);
        stream.roomReported = false;
        let accepted: number;
        try {
          accepted = (await this.#transport.request({ op: "stream_push", source, bytes: chunk })) as number;
        } catch {
          this.#dropStream(source);
          return;
        }
        if (accepted < 0) {
          // Released (ENOENT) while pumping: nothing will read it.
          this.#dropStream(source);
          return;
        }
        stream.pending = accepted < stream.pending.byteLength ? stream.pending.subarray(accepted) : null;
        // A report that arrived during the push already counts these bytes.
        if (!stream.roomReported) stream.room = accepted < chunk.byteLength ? 0 : stream.room - accepted;
      }
    } finally {
      stream.pumping = false;
    }
  }

  #releaseSource(source: bigint): void {
    this.#sources.delete(source);
    this.#dropStream(source);
    for (const [id, state] of this.#batches) {
      if (state.sources.delete(source) && state.sources.size === 0) {
        state.releaseResolvers.splice(0).forEach((resolve) => resolve());
        this.#forgetIfDone(id, state);
      }
    }
  }

  #forgetIfDone(id: string, state: BatchState): void {
    if (state.settled && state.sources.size === 0 && this.#batches.delete(id)) {
      this.#fireAndForget({ op: "interest", delta: -1 });
    }
  }

  /** The one read of a streamed output: the host becomes its FIFO's reader. */
  #readStream(id: string, output: Uint8Array, lease: Lease, maybeRelease: () => void): ReadableStream<Uint8Array> {
    const transport = this.#transport;
    const readable = this.#readable;
    let closed = false;
    lease.openStreams++;
    const close = () => {
      if (closed) return;
      closed = true;
      readable.delete(id);
      lease.openStreams--;
      maybeRelease();
    };
    const nextReport = () => new Promise<void>((resolve) => readable.set(id, resolve));
    let report = nextReport();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let started: number;
        try {
          started = (await transport.request({ op: "stream_start", output })) as number;
        } catch (error) {
          controller.error(error);
          close();
          return;
        }
        if (started < 0) {
          controller.error(new Error(`exchange stream start failed with errno ${-started}`));
          close();
        }
      },
      async pull(controller) {
        try {
          await pullStream(controller);
        } catch (error) {
          // The kernel went away mid-read: end the stream, and with it the lease.
          controller.error(error);
          close();
        }
      },
      cancel() {
        close();
      },
    });

    async function pullStream(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
        for (;;) {
          if (lease.released) {
            controller.error(new Error("the exchange lease on this output has ended"));
            close();
            return;
          }
          const chunk = await transport.request({ op: "stream_read", output, length: READ_CHUNK_BYTES });
          if (chunk instanceof Uint8Array && chunk.byteLength > 0) {
            controller.enqueue(chunk);
            return;
          }
          if (chunk instanceof Uint8Array) {
            const failure = streamEnd((await transport.request({ op: "output_end", output })) as Uint8Array | number);
            if (failure === null) controller.close();
            else controller.error(failure);
            close();
            return;
          }
          if (chunk !== -EAGAIN) {
            controller.error(new Error(`exchange stream read failed with errno ${-(chunk as number)}`));
            close();
            return;
          }
          // Nothing yet: wait for the kernel to report bytes or the end.
          await report;
          report = nextReport();
        }
    }
    return stream;
  }

  #deliverOutput(notification: Extract<ExchangeNotification, { kind: "output-published" }>): void {
    const id = formatExchangeId(notification.output);
    const outputBytes = notification.output;
    const listener = this.#listener;
    const lease: Lease = {
      abort: new AbortController(),
      openStreams: 0,
      scopeSettled: false,
      released: false,
      withdraw: () => {},
    };
    this.#leases.set(id, lease);
    const release = () => {
      if (lease.released) return;
      lease.released = true;
      this.#leases.delete(id);
      this.#fireAndForget({ op: "release_output", output: outputBytes });
    };
    const maybeRelease = () => {
      if (lease.scopeSettled && lease.openStreams === 0) release();
    };
    lease.abort.signal.addEventListener("abort", release, { once: true });
    const withdrawn = new Promise<void>((resolve) => {
      lease.withdraw = () => {
        lease.released = true;
        this.#leases.delete(id);
        resolve();
      };
    });
    const size = Number(notification.size);
    const transport = this.#transport;
    const stream = notification.stream;
    let streamRead = false;
    const output: ExchangeOutput = {
      id,
      name: decoder.decode(notification.name),
      kind: stream ? "stream" : "stored",
      ...(stream ? {} : { size }),
      ...(notification.mimeType ? { mimeType: decoder.decode(notification.mimeType) } : {}),
      derivedFrom: notification.derivedFrom.map(formatExchangeId),
      withdrawn,
      read: (range = {}) => {
        if (lease.released) throw new Error("the exchange lease on this output has ended");
        if (stream) {
          if (streamRead) throw new Error("a streamed output can be read only once");
          streamRead = true;
          return this.#readStream(id, outputBytes, lease, maybeRelease);
        }
        let position = range.start ?? 0;
        const end = Math.min(range.end ?? size, size);
        lease.openStreams++;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          lease.openStreams--;
          maybeRelease();
        };
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (position >= end) {
              controller.close();
              close();
              return;
            }
            const length = Math.min(READ_CHUNK_BYTES, end - position);
            let chunk: unknown;
            try {
              chunk = await transport.request({ op: "read_output", output: outputBytes, offset: position, length });
            } catch (error) {
              controller.error(error);
              close();
              return;
            }
            if (typeof chunk === "number") {
              controller.error(new Error(`exchange output read failed with errno ${-chunk}`));
              close();
              return;
            }
            const bytes = chunk as Uint8Array;
            if (bytes.byteLength === 0) {
              controller.close();
              close();
              return;
            }
            position += bytes.byteLength;
            controller.enqueue(bytes);
          },
          cancel() {
            close();
          },
        });
      },
    };
    if (listener === null || listener.signal.aborted) {
      lease.scopeSettled = true;
      release();
      return;
    }
    lease.abort.signal.addEventListener("abort", () => this.#readable.get(id)?.(), { once: true });
    let returned: void | Promise<void>;
    try {
      returned = listener.callback(output, { signal: lease.abort.signal });
    } catch {
      returned = undefined;
    }
    Promise.resolve(returned).finally(() => {
      lease.scopeSettled = true;
      maybeRelease();
    });
  }
}

/** How a streamed output's guest declared its end, as the host stream ends. */
function streamEnd(end: Uint8Array | number): Error | null {
  if (typeof end === "number") return new Error("the guest ended the stream without declaring it complete");
  const text = decoder.decode(end);
  if (text === "complete") return null;
  if (text.startsWith("aborted ")) return new Error(`the guest aborted the stream: ${text.slice(8)}`);
  return new Error(`the guest ended the stream as ${JSON.stringify(text)}`);
}

function offerFailure(errno: number): ExchangeOfferError {
  switch (errno) {
    case 6: // ENXIO
      return new ExchangeOfferError("unavailable", "this machine has no exchange agent and no consumer");
    case 28: // ENOSPC
      return new ExchangeOfferError("quota", "the machine's exchange limits are reached");
    case 22: // EINVAL
    case 17: // EEXIST
      return new ExchangeOfferError("invalid-name", "the kernel refused a name or entry");
    default:
      return new ExchangeOfferError("failed", `the kernel refused the offer (errno ${errno})`);
  }
}
