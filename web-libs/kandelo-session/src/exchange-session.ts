/**
 * Kandelo exchange for a browser session: what the app shows about moving
 * files into and out of the machine.
 *
 * The platform does the work (`host/src/exchange-controller.ts`, reached
 * through `KernelLike.exchange`); this module only keeps the session's view
 * of it, so the UI can render it:
 *
 * - the consumer state (whether, and how, the machine accepts files);
 * - one entry per offered batch, with its status text and outcome, for the
 *   drop toasts;
 * - the output tray. The session registers the machine's single output
 *   listener for as long as a kernel is attached, and holds each output's
 *   lease until the user saves or dismisses it. Nothing here writes a file
 *   or starts a download: saving is the app's decision.
 *
 * Types are structural, like `KernelLike`: this package does not import the
 * host runtime.
 */

/** One item to offer: a file (Blob), a stream, or an empty directory. */
export interface ExchangeOfferItem {
  name: string;
  dirs?: readonly string[];
  source?: Blob | ReadableStream<Uint8Array>;
  mimeType?: string;
  modifiedMs?: number;
}

export type ExchangeOfferSource = "drop" | "picker" | "paste" | "share" | "api";

export interface ExchangeConsumerStateView {
  state: "unavailable" | "idle" | "starting" | "ready";
  activation: "on-demand" | "off";
  lastFailure?: { exitStatus?: number; signal?: number; errno?: number };
}

/** The slice of the host's ExchangeController the session uses. */
export interface ExchangeLike {
  offer(
    items: readonly ExchangeOfferItem[],
    options?: { source?: ExchangeOfferSource; signal?: AbortSignal; consumerTimeoutMs?: number },
  ): Promise<{
    readonly id: string;
    readonly entries: readonly { id: string; path: string }[];
    onStatus(listener: (status: string) => void): () => void;
    readonly settled: Promise<{ outcome: "removed" | "discarded" | "cancelled"; status?: string }>;
  }>;
  onOutput(
    callback: (
      output: {
        readonly id: string;
        readonly name: string;
        readonly kind: "stored" | "stream";
        readonly size?: number;
        readonly mimeType?: string;
        readonly derivedFrom: readonly string[];
        read(range?: { start?: number; end?: number }): ReadableStream<Uint8Array>;
        readonly withdrawn: Promise<void>;
      },
      scope: { signal: AbortSignal },
    ) => void | Promise<void>,
    options: { signal: AbortSignal },
  ): void;
  consumerState(): Promise<ExchangeConsumerStateView | null>;
  onConsumer(listener: (state: ExchangeConsumerStateView) => void): () => void;
}

/** A batch as the UI shows it. */
export interface ExchangeBatchView {
  /** Session-local key; the exchange ID once the kernel accepted the batch. */
  readonly key: string;
  readonly names: readonly string[];
  /**
   * `waiting`: offered, no consumer yet. `active`: the guest has it.
   * `done` / `failed`: it left the inbox (failed covers a refused offer, a
   * timeout, a cancelled or discarded batch, and a handler's `failed: …`).
   */
  readonly phase: "waiting" | "active" | "done" | "failed";
  /** The latest status text: the guest's, or why the platform refused it. */
  readonly status: string;
}

/** An output waiting in the tray. */
export interface ExchangeOutputView {
  readonly id: string;
  readonly name: string;
  readonly kind: "stored" | "stream";
  readonly size?: number;
  readonly mimeType?: string;
  /** Names of the inputs it came from, where this session offered them. */
  readonly derivedFrom: readonly string[];
  /** The guest removed it before the user acted. */
  readonly withdrawn: boolean;
}

type OutputRecord = {
  view: ExchangeOutputView;
  read: (range?: { start?: number; end?: number }) => ReadableStream<Uint8Array>;
  finish: () => void;
};

const REASONS: Record<string, string> = {
  unavailable: "This machine doesn't accept files",
  "consumer-timeout": "No file handler took the files in time",
  quota: "The machine's file limits are reached",
  "invalid-name": "The machine refused a file name",
  aborted: "Cancelled",
};

/** The text a consumer state should show, or null when nothing needs saying. */
export function describeExchangeConsumer(state: ExchangeConsumerStateView | null): string | null {
  if (state === null) return null;
  switch (state.state) {
    case "unavailable":
      return "This machine doesn't accept files";
    case "ready":
      return null;
    case "idle":
      return state.activation === "off" ? "Waiting for a file handler" : "Starting the file handler…";
    case "starting": {
      const failure = state.lastFailure;
      if (!failure) return "Starting the file handler…";
      const how = failure.exitStatus !== undefined ? `exited with status ${failure.exitStatus}`
        : failure.signal !== undefined ? `was stopped by signal ${failure.signal}`
        : `could not start (errno ${failure.errno})`;
      return `The file handler ${how}; retrying`;
    }
  }
}

export class ExchangeSession {
  #exchange: ExchangeLike | null = null;
  #listening: AbortController | null = null;
  #unsubscribeConsumer: (() => void) | null = null;
  #consumer: ExchangeConsumerStateView | null = null;
  #batches: ExchangeBatchView[] = [];
  #outputs = new Map<string, OutputRecord>();
  /** Input entry IDs this session offered, to name an output's provenance. */
  #entryNames = new Map<string, string>();
  #nextKey = 1;
  readonly #consumerListeners = new Set<(state: ExchangeConsumerStateView | null) => void>();
  readonly #batchListeners = new Set<(batches: readonly ExchangeBatchView[]) => void>();
  readonly #outputListeners = new Set<(outputs: readonly ExchangeOutputView[]) => void>();

  /** Start following a kernel's exchange (the machine booted). */
  attach(exchange: ExchangeLike | undefined): void {
    this.detach();
    if (!exchange) return;
    this.#exchange = exchange;
    const listening = new AbortController();
    this.#listening = listening;
    exchange.onOutput((output) => this.#hold(output), { signal: listening.signal });
    this.#unsubscribeConsumer = exchange.onConsumer((state) => this.#setConsumer(state));
    void exchange.consumerState().then((state) => {
      if (this.#exchange === exchange && state) this.#setConsumer(state);
    });
  }

  /** Stop following (the machine stopped); every lease ends. */
  detach(): void {
    this.#listening?.abort();
    this.#listening = null;
    this.#unsubscribeConsumer?.();
    this.#unsubscribeConsumer = null;
    this.#exchange = null;
    this.#outputs.clear();
    this.#entryNames.clear();
    this.#batches = [];
    this.#setConsumer(null);
    this.#emitOutputs();
    this.#emitBatches();
  }

  get available(): boolean {
    return this.#exchange !== null;
  }

  get consumer(): ExchangeConsumerStateView | null {
    return this.#consumer;
  }

  get batches(): readonly ExchangeBatchView[] {
    return this.#batches;
  }

  get outputs(): readonly ExchangeOutputView[] {
    return [...this.#outputs.values()].map((record) => record.view);
  }

  subscribeConsumer(listener: (state: ExchangeConsumerStateView | null) => void): () => void {
    this.#consumerListeners.add(listener);
    return () => this.#consumerListeners.delete(listener);
  }

  subscribeBatches(listener: (batches: readonly ExchangeBatchView[]) => void): () => void {
    this.#batchListeners.add(listener);
    return () => this.#batchListeners.delete(listener);
  }

  subscribeOutputs(listener: (outputs: readonly ExchangeOutputView[]) => void): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  /**
   * Offer items as one batch. Resolves with the batch's key once it is
   * tracked; its progress and outcome arrive through `subscribeBatches`.
   * Never rejects for a platform refusal: that is shown as a failed batch.
   */
  async offer(items: readonly ExchangeOfferItem[], source: ExchangeOfferSource): Promise<string> {
    const names = items.map((item) => [...(item.dirs ?? []), item.name][0]!)
      .filter((name, index, all) => all.indexOf(name) === index);
    let key = `local-${this.#nextKey++}`;
    const exchange = this.#exchange;
    if (!exchange) {
      this.#putBatch({ key, names, phase: "failed", status: "This machine doesn't accept files" });
      return key;
    }
    const waiting = this.#consumer?.state !== "ready";
    this.#putBatch({ key, names, phase: waiting ? "waiting" : "active", status: waiting ? describeExchangeConsumer(this.#consumer) ?? "" : "" });
    let batch: Awaited<ReturnType<ExchangeLike["offer"]>>;
    try {
      batch = await exchange.offer(items, { source });
    } catch (error) {
      const reason = (error as { reason?: string }).reason;
      this.#putBatch({
        key,
        names,
        phase: "failed",
        status: (reason && REASONS[reason]) || (error instanceof Error ? error.message : String(error)),
      });
      return key;
    }
    for (const entry of batch.entries) {
      this.#entryNames.set(entry.id, entry.path.split("/").pop() ?? entry.path);
    }
    this.#removeBatch(key);
    key = batch.id;
    this.#putBatch({ key, names, phase: "active", status: "" });
    batch.onStatus((status) => {
      const current = this.#batches.find((b) => b.key === key);
      if (current && current.phase === "active") this.#putBatch({ ...current, status });
    });
    void batch.settled.then((settlement) => {
      const status = settlement.status ?? "";
      const failed = settlement.outcome !== "removed" || /^(failed|no handler)\b/.test(status);
      this.#putBatch({
        key,
        names,
        phase: failed ? "failed" : "done",
        status: status || (settlement.outcome === "removed" ? "Done"
          : settlement.outcome === "discarded" ? "The file handler exited before finishing"
          : "Cancelled"),
      });
    });
    return key;
  }

  /**
   * Show a drop or pick the browser could not read as a failed batch, so the
   * user sees why nothing reached the machine.
   */
  reportUnreadable(reason: string): string {
    const key = `local-${this.#nextKey++}`;
    this.#putBatch({ key, names: [], phase: "failed", status: `Could not read the files: ${reason}` });
    return key;
  }

  /** Forget a finished batch (its toast was dismissed). */
  dismissBatch(key: string): void {
    this.#removeBatch(key);
  }

  /**
   * Read an output's bytes. A stored output may be read again; a streamed
   * one only once. The lease lasts until `finishOutput`.
   */
  readOutput(id: string): ReadableStream<Uint8Array> {
    const record = this.#outputs.get(id);
    if (!record) throw new Error(`no exchange output ${id}`);
    return record.read();
  }

  /** The user saved or dismissed the output: release it from the machine. */
  finishOutput(id: string): void {
    const record = this.#outputs.get(id);
    if (!record) return;
    this.#outputs.delete(id);
    record.finish();
    this.#emitOutputs();
  }

  #hold(output: Parameters<Parameters<ExchangeLike["onOutput"]>[0]>[0]): Promise<void> {
    return new Promise<void>((finish) => {
      const view: ExchangeOutputView = {
        id: output.id,
        name: output.name,
        kind: output.kind,
        ...(output.size !== undefined ? { size: output.size } : {}),
        ...(output.mimeType ? { mimeType: output.mimeType } : {}),
        derivedFrom: output.derivedFrom.map((id) => this.#entryNames.get(id)).filter((n): n is string => !!n),
        withdrawn: false,
      };
      this.#outputs.set(output.id, { view, read: (range) => output.read(range), finish });
      this.#emitOutputs();
      void output.withdrawn.then(() => {
        const record = this.#outputs.get(output.id);
        if (!record) return;
        record.view = { ...record.view, withdrawn: true };
        this.#emitOutputs();
      });
    });
  }

  #setConsumer(state: ExchangeConsumerStateView | null): void {
    this.#consumer = state;
    for (const listener of this.#consumerListeners) listener(state);
    // Waiting batches say what they are waiting for.
    const text = describeExchangeConsumer(state);
    let changed = false;
    this.#batches = this.#batches.map((batch) => {
      if (batch.phase !== "waiting" || text === null || batch.status === text) return batch;
      changed = true;
      return { ...batch, status: text };
    });
    if (changed) this.#emitBatches();
  }

  #putBatch(batch: ExchangeBatchView): void {
    const index = this.#batches.findIndex((b) => b.key === batch.key);
    this.#batches = index < 0
      ? [...this.#batches, batch]
      : this.#batches.map((b, i) => (i === index ? batch : b));
    this.#emitBatches();
  }

  #removeBatch(key: string): void {
    const before = this.#batches.length;
    this.#batches = this.#batches.filter((b) => b.key !== key);
    if (this.#batches.length !== before) this.#emitBatches();
  }

  #emitBatches(): void {
    for (const listener of this.#batchListeners) listener(this.#batches);
  }

  #emitOutputs(): void {
    const outputs = this.outputs;
    for (const listener of this.#outputListeners) listener(outputs);
  }
}
