import {
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY,
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION,
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC,
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION,
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE,
} from "./generated/abi";

function littleEndianMagic(bytes: readonly number[]): number {
  return bytes.reduce(
    (magic, byte, index) => magic | (byte << (index * 8)),
    0,
  ) >>> 0;
}

const REPLAY_EVENT_MAGIC = littleEndianMagic(
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC,
);
export const FORK_REPLAY_EVENT_VERSION =
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION;
export const FORK_REPLAY_EVENT_HEADER_SIZE =
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE;
export const FORK_REPLAY_EVENT_SEGMENT_VERSION =
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION;
export const FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE =
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE;
export const FORK_REPLAY_EVENT_ENTRY_SIZE =
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE;
/**
 * Allocation geometry, not a continuation-depth limit.
 *
 * A roughly 32-KiB event page fits twice in the arena's normal 64-KiB chunks,
 * including two record envelopes and the larger wasm64 chunk header.
 */
export const FORK_REPLAY_EVENT_SEGMENT_CAPACITY =
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY;
const REPLAY_EVENT_KNOWN_FLAGS =
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS;
const REPLAY_EVENT_SEGMENT_KNOWN_FLAGS =
  WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS;
const MAX_U32 = 0xffff_ffff;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export interface ForkReplayEvent {
  readonly activationId: number;
  readonly functionOrdinal: number;
}

export interface ForkResumeTarget {
  readonly functionOrdinal: number;
  /** No-parameter Wasm thunk that restores params from the unconsumed frame. */
  readonly thunk: CallableFunction;
}

type JournalPhase = "idle" | "capture" | "sealed-parent" | "replay";

function assertU32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new RangeError(`${context} is not a u32: ${value}`);
  }
}

function exactU64(value: bigint | number, context: string): bigint {
  if (
    typeof value === "number"
    && (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new RangeError(`${context} is not an exact nonnegative integer`);
  }
  const exact = typeof value === "bigint" ? value : BigInt(value);
  if (exact < 0n || exact > MAX_U64) {
    throw new RangeError(`${context} is not representable as u64`);
  }
  return exact;
}

function eventKey(activationId: number, functionOrdinal: number): string {
  return `${activationId}:${functionOrdinal}`;
}

interface CapturedEventPage {
  readonly words: Uint32Array;
  count: number;
  previous: ReplayEventPage | null;
  next: ReplayEventPage | null;
}

interface ChildEventPage {
  readonly payload: Uint8Array;
  readonly view: DataView;
  readonly count: number;
  previous: ReplayEventPage | null;
  next: ReplayEventPage | null;
}

type ReplayEventPage = CapturedEventPage | ChildEventPage;

export interface ForkReplayEventWire {
  readonly manifest: Uint8Array;
  /** Restartable ordered source; callers may validate before attaching. */
  readonly segments: Iterable<Uint8Array>;
}

export interface ForkReplayEventCaptureSource {
  capturedSegmentPayloads(): Iterable<Uint8Array>;
  capturedManifestPayload(): Uint8Array;
}

export interface ForkReplayEventWireSummary {
  readonly eventCount: bigint;
  readonly segmentCount: bigint;
  readonly activationIds: ReadonlySet<number>;
}

function segmentCountForEvents(eventCount: bigint): bigint {
  if (eventCount === 0n) return 0n;
  return (
    eventCount + BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY) - 1n
  ) / BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY);
}

export function encodeForkReplayEventManifest(
  eventCount: bigint,
  segmentCount: bigint | number,
): Uint8Array {
  const exactEventCount = exactU64(eventCount, "fork replay event count");
  const exactSegmentCount = exactU64(
    segmentCount,
    "fork replay event segment count",
  );
  if (segmentCountForEvents(exactEventCount) !== exactSegmentCount) {
    throw new RangeError(
      "fork replay event segment count is inconsistent with event count",
    );
  }
  const bytes = new Uint8Array(FORK_REPLAY_EVENT_HEADER_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, REPLAY_EVENT_MAGIC, true);
  view.setUint16(4, FORK_REPLAY_EVENT_VERSION, true);
  view.setUint16(6, FORK_REPLAY_EVENT_HEADER_SIZE, true);
  view.setUint16(8, FORK_REPLAY_EVENT_ENTRY_SIZE, true);
  view.setUint16(10, FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE, true);
  view.setUint32(12, FORK_REPLAY_EVENT_SEGMENT_CAPACITY, true);
  view.setUint16(16, REPLAY_EVENT_KNOWN_FLAGS, true);
  view.setUint16(18, 0, true);
  view.setUint32(20, 0, true);
  view.setBigUint64(24, exactSegmentCount, true);
  view.setBigUint64(32, exactEventCount, true);
  return bytes;
}

export function encodeForkReplayEventSegment(
  words: Uint32Array,
  count: number,
  sequence: bigint | number,
): Uint8Array {
  const exactSequence = exactU64(
    sequence,
    "fork replay event segment sequence",
  );
  if (
    !Number.isInteger(count)
    || count <= 0
    || count > FORK_REPLAY_EVENT_SEGMENT_CAPACITY
    || words.length < count * 2
  ) {
    throw new RangeError(`invalid fork replay event segment count ${count}`);
  }
  const bytes = new Uint8Array(
    FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
      + count * FORK_REPLAY_EVENT_ENTRY_SIZE,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(0, FORK_REPLAY_EVENT_SEGMENT_VERSION, true);
  view.setUint16(2, FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE, true);
  view.setUint16(4, FORK_REPLAY_EVENT_ENTRY_SIZE, true);
  view.setUint16(6, REPLAY_EVENT_SEGMENT_KNOWN_FLAGS, true);
  view.setBigUint64(8, exactSequence, true);
  view.setUint32(16, count, true);
  view.setUint32(20, 0, true);
  for (let index = 0; index < count; index++) {
    const offset =
      FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
      + index * FORK_REPLAY_EVENT_ENTRY_SIZE;
    view.setUint32(offset, words[index * 2]!, true);
    view.setUint32(offset + 4, words[index * 2 + 1]!, true);
  }
  return bytes;
}

interface DecodedReplayEventManifest {
  readonly eventCount: bigint;
  readonly segmentCount: bigint;
}

function decodeForkReplayEventManifest(
  bytes: Uint8Array,
): DecodedReplayEventManifest {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.byteLength < FORK_REPLAY_EVENT_HEADER_SIZE
  ) {
    throw new Error("fork replay event manifest is truncated");
  }
  if (bytes.byteLength !== FORK_REPLAY_EVENT_HEADER_SIZE) {
    throw new Error("fork replay event manifest has inconsistent bounds");
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  if (view.getUint32(0, true) !== REPLAY_EVENT_MAGIC) {
    throw new Error("fork replay event manifest has invalid magic");
  }
  if (view.getUint16(4, true) !== FORK_REPLAY_EVENT_VERSION) {
    throw new Error(
      `fork replay event manifest has version ${view.getUint16(4, true)}`,
    );
  }
  if (view.getUint16(6, true) !== FORK_REPLAY_EVENT_HEADER_SIZE) {
    throw new Error("fork replay event manifest has an invalid header size");
  }
  if (
    view.getUint16(8, true) !== FORK_REPLAY_EVENT_ENTRY_SIZE
    || view.getUint16(10, true) !== FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
  ) {
    throw new Error("fork replay event manifest has an invalid entry size");
  }
  if (view.getUint32(12, true) !== FORK_REPLAY_EVENT_SEGMENT_CAPACITY) {
    throw new Error("fork replay event manifest has an invalid segment capacity");
  }
  if (
    (view.getUint16(16, true) & ~REPLAY_EVENT_KNOWN_FLAGS) !== 0
    || view.getUint16(18, true) !== 0
    || view.getUint32(20, true) !== 0
  ) {
    throw new Error("fork replay event manifest has nonzero reserved fields");
  }
  const segmentCount = view.getBigUint64(24, true);
  const eventCount = view.getBigUint64(32, true);
  if (segmentCountForEvents(eventCount) !== segmentCount) {
    throw new Error(
      "fork replay event manifest segment count is inconsistent with event count",
    );
  }
  return { eventCount, segmentCount };
}

function decodeForkReplayEventSegment(
  payload: Uint8Array,
  sequence: bigint,
  expectedCount: number,
): ChildEventPage {
  if (
    !(payload instanceof Uint8Array)
    || payload.byteLength < FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
  ) {
    throw new Error(`fork replay event segment ${sequence} is truncated`);
  }
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  if (
    view.getUint16(0, true) !== FORK_REPLAY_EVENT_SEGMENT_VERSION
    || view.getUint16(2, true) !== FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
    || view.getUint16(4, true) !== FORK_REPLAY_EVENT_ENTRY_SIZE
  ) {
    throw new Error(
      `fork replay event segment ${sequence} has an invalid version or layout`,
    );
  }
  if (
    (view.getUint16(6, true) & ~REPLAY_EVENT_SEGMENT_KNOWN_FLAGS) !== 0
  ) {
    throw new Error(`fork replay event segment ${sequence} has unknown flags`);
  }
  if (view.getBigUint64(8, true) !== sequence) {
    throw new Error(
      `fork replay event segment sequence ${view.getBigUint64(8, true)} `
      + `is out of order; expected ${sequence}`,
    );
  }
  const count = view.getUint32(16, true);
  if (view.getUint32(20, true) !== 0) {
    throw new Error(`fork replay event segment ${sequence} has reserved data`);
  }
  if (count !== expectedCount) {
    throw new Error(
      `fork replay event segment ${sequence} has ${count} entries; `
      + `expected ${expectedCount}`,
    );
  }
  const expectedSize =
    FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
    + count * FORK_REPLAY_EVENT_ENTRY_SIZE;
  if (payload.byteLength !== expectedSize) {
    throw new Error(
      `fork replay event segment ${sequence} has inconsistent bounds`,
    );
  }
  return {
    payload,
    view,
    count,
    previous: null,
    next: null,
  };
}

function inspectForkReplayEventWire(
  wire: ForkReplayEventWire,
  retainPages: boolean,
): {
  readonly summary: ForkReplayEventWireSummary;
  readonly firstPage: ChildEventPage | null;
  readonly lastPage: ChildEventPage | null;
} {
  const manifest = decodeForkReplayEventManifest(wire.manifest);
  const iterator = wire.segments[Symbol.iterator]();
  const activationIds = new Set<number>();
  let firstPage: ChildEventPage | null = null;
  let lastPage: ChildEventPage | null = null;
  let remaining = manifest.eventCount;
  let sequence = 0n;
  while (sequence < manifest.segmentCount) {
    const item = iterator.next();
    if (item.done) {
      throw new Error(
        `fork replay event wire ended after ${sequence} segments; `
        + `expected ${manifest.segmentCount}`,
      );
    }
    const count = Number(
      remaining > BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY)
        ? BigInt(FORK_REPLAY_EVENT_SEGMENT_CAPACITY)
        : remaining,
    );
    const page = decodeForkReplayEventSegment(
      item.value,
      sequence,
      count,
    );
    for (let index = 0; index < page.count; index++) {
      activationIds.add(readPageWord(page, index, 0));
    }
    if (retainPages) {
      page.previous = lastPage;
      if (lastPage) lastPage.next = page;
      firstPage ??= page;
      lastPage = page;
    }
    remaining -= BigInt(page.count);
    sequence++;
  }
  if (!iterator.next().done) {
    throw new Error(
      "fork replay event wire has segments after its declared segment count "
      + `${manifest.segmentCount}`,
    );
  }
  if (remaining !== 0n) {
    throw new Error("fork replay event wire ended before its declared event count");
  }
  return {
    summary: {
      eventCount: manifest.eventCount,
      segmentCount: manifest.segmentCount,
      activationIds,
    },
    firstPage,
    lastPage,
  };
}

/**
 * Validate segmented replay-event bytes and derive only their active modules.
 *
 * The caller does not receive per-frame objects, so exact-set validation stays
 * proportional to the number of activations rather than continuation depth.
 */
export function validateForkReplayEventWire(
  wire: ForkReplayEventWire,
): ForkReplayEventWireSummary {
  return inspectForkReplayEventWire(wire, false).summary;
}

function readPageWord(
  page: ReplayEventPage,
  eventIndex: number,
  wordIndex: 0 | 1,
): number {
  if ("words" in page) {
    return page.words[eventIndex * 2 + wordIndex]!;
  }
  return page.view.getUint32(
    FORK_REPLAY_EVENT_SEGMENT_HEADER_SIZE
      + eventIndex * FORK_REPLAY_EVENT_ENTRY_SIZE
      + wordIndex * 4,
    true,
  );
}

/**
 * Global ordering for frames committed into per-module linked continuations.
 *
 * Unwind commits the innermost activation first. Replay therefore consumes
 * the exact reverse order. `peek` is non-consuming so a resume thunk can be
 * selected before the original function preamble atomically validates and
 * consumes the same event alongside `frame_next`.
 */
export class ForkReplayEventJournal {
  private phase: JournalPhase = "idle";
  private capturedFirstPage: CapturedEventPage | null = null;
  private capturedLastPage: CapturedEventPage | null = null;
  private capturedPageCount = 0n;
  private capturedCount = 0n;
  private replayPage: ReplayEventPage | null = null;
  private replayEventIndex = -1;
  private replayRemaining = 0n;
  private selected: ForkReplayEvent | null = null;

  beginCapture(): void {
    this.requirePhase("idle", "begin replay-event capture");
    this.capturedFirstPage = null;
    this.capturedLastPage = null;
    this.capturedPageCount = 0n;
    this.capturedCount = 0n;
    this.phase = "capture";
  }

  recordCommit(activationId: number, functionOrdinal: number): void {
    this.requirePhase("capture", "record a replay event");
    assertU32(activationId, "fork replay activation id");
    assertU32(functionOrdinal, "fork replay function ordinal");
    let page = this.capturedLastPage;
    if (!page || page.count === FORK_REPLAY_EVENT_SEGMENT_CAPACITY) {
      page = {
        words: new Uint32Array(FORK_REPLAY_EVENT_SEGMENT_CAPACITY * 2),
        count: 0,
        previous: this.capturedLastPage,
        next: null,
      };
      if (this.capturedLastPage) this.capturedLastPage.next = page;
      this.capturedFirstPage ??= page;
      this.capturedLastPage = page;
      this.capturedPageCount++;
    }
    page.words[page.count * 2] = activationId;
    page.words[page.count * 2 + 1] = functionOrdinal;
    page.count++;
    this.capturedCount++;
  }

  sealCapture(): void {
    this.requirePhase("capture", "seal replay-event capture");
    this.phase = "sealed-parent";
  }

  capturedEventCount(): bigint {
    if (this.phase !== "capture" && this.phase !== "sealed-parent") {
      throw new Error(
        `cannot read captured replay events while replay-event journal is ${this.phase}`,
      );
    }
    return this.capturedCount;
  }

  capturedActivationIds(): Set<number> {
    if (this.phase !== "capture" && this.phase !== "sealed-parent") {
      throw new Error(
        `cannot read captured replay events while replay-event journal is ${this.phase}`,
      );
    }
    const ids = new Set<number>();
    for (
      let page: ReplayEventPage | null = this.capturedFirstPage;
      page;
      page = page.next
    ) {
      if (!("words" in page)) {
        throw new Error("captured replay-event chain contains a child page");
      }
      for (let index = 0; index < page.count; index++) {
        ids.add(page.words[index * 2]!);
      }
    }
    return ids;
  }

  *capturedSegmentPayloads(): IterableIterator<Uint8Array> {
    if (this.phase !== "capture" && this.phase !== "sealed-parent") {
      throw new Error(
        `cannot encode captured replay events while replay-event journal is ${this.phase}`,
      );
    }
    let sequence = 0n;
    for (
      let page: ReplayEventPage | null = this.capturedFirstPage;
      page;
      page = page.next
    ) {
      if (!("words" in page)) {
        throw new Error("captured replay-event chain contains a child page");
      }
      yield encodeForkReplayEventSegment(page.words, page.count, sequence);
      sequence++;
    }
  }

  capturedManifestPayload(): Uint8Array {
    if (this.phase !== "capture" && this.phase !== "sealed-parent") {
      throw new Error(
        `cannot encode captured replay events while replay-event journal is ${this.phase}`,
      );
    }
    return encodeForkReplayEventManifest(
      this.capturedCount,
      this.capturedPageCount,
    );
  }

  beginParentReplay(): void {
    this.requirePhase("sealed-parent", "begin parent replay events");
    this.beginReplayFrom(this.capturedLastPage, this.capturedCount);
  }

  attachChild(wire: ForkReplayEventWire): void {
    this.requirePhase("idle", "attach child replay events");
    const { summary, lastPage } = inspectForkReplayEventWire(wire, true);
    this.beginReplayFrom(lastPage, summary.eventCount);
  }

  peek(): ForkReplayEvent | null {
    this.requirePhase("replay", "peek a replay event");
    if (this.selected) return this.selected;
    const page = this.replayPage;
    if (!page) return null;
    this.selected = {
      activationId: readPageWord(page, this.replayEventIndex, 0),
      functionOrdinal: readPageWord(page, this.replayEventIndex, 1),
    };
    return this.selected;
  }

  consume(activationId: number, functionOrdinal: number): void {
    this.requirePhase("replay", "consume a replay event");
    const event = this.selected;
    if (!event) {
      throw new Error(
        "fork replay frame was consumed without selecting its resume target",
      );
    }
    if (
      event.activationId !== activationId
      || event.functionOrdinal !== functionOrdinal
    ) {
      throw new Error(
        `fork replay event expected ${event.activationId}:${event.functionOrdinal}, `
        + `found ${activationId}:${functionOrdinal}`,
      );
    }
    this.replayRemaining--;
    this.replayEventIndex--;
    if (this.replayEventIndex < 0) {
      this.replayPage = this.replayPage?.previous ?? null;
      this.replayEventIndex = this.replayPage
        ? this.replayPage.count - 1
        : -1;
    }
    this.selected = null;
  }

  finishReplay(): void {
    this.requirePhase("replay", "finish replay events");
    if (this.replayRemaining !== 0n || this.selected !== null) {
      throw new Error(
        `fork replay event stream has ${this.replayRemaining} unconsumed entries`,
      );
    }
    this.clear();
  }

  abort(): void {
    this.clear();
  }

  phaseName(): JournalPhase {
    return this.phase;
  }

  private beginReplayFrom(
    lastPage: ReplayEventPage | null,
    eventCount: bigint,
  ): void {
    this.replayPage = lastPage;
    this.replayEventIndex = lastPage ? lastPage.count - 1 : -1;
    this.replayRemaining = eventCount;
    this.selected = null;
    this.phase = "replay";
  }

  private clear(): void {
    this.capturedFirstPage = null;
    this.capturedLastPage = null;
    this.capturedPageCount = 0n;
    this.capturedCount = 0n;
    this.replayPage = null;
    this.replayEventIndex = -1;
    this.replayRemaining = 0n;
    this.selected = null;
    this.phase = "idle";
  }

  private requirePhase(expected: JournalPhase, operation: string): void {
    if (this.phase !== expected) {
      throw new Error(
        `cannot ${operation} while replay-event journal is ${this.phase}; `
        + `expected ${expected}`,
      );
    }
  }
}

interface RegisteredResumeTarget extends ForkResumeTarget {
  readonly activationId: number;
  readonly slot: number;
}

/**
 * Host reconstruction owner for the private heterogeneous resume table.
 *
 * The table is not guest state. Every fresh worker populates it from exact
 * artifact catalogs after all main/side activations instantiate. Slots may
 * differ across workers because continuation bytes name activation/function
 * coordinates, never raw table indexes.
 */
export class ForkResumeTable {
  readonly table = new WebAssembly.Table({
    element: "anyfunc",
    initial: 1,
  });

  private readonly targets = new Map<string, RegisteredResumeTarget>();
  private readonly activationKeys = new Map<number, string[]>();
  private freeSlots: number[] = [];

  registerActivation(
    activationId: number,
    targets: readonly ForkResumeTarget[],
  ): void {
    assertU32(activationId, "resume-table activation id");
    if (this.activationKeys.has(activationId)) {
      throw new Error(`resume-table activation ${activationId} is already registered`);
    }
    const ordered = [...targets].sort(
      (left, right) => left.functionOrdinal - right.functionOrdinal,
    );
    const keys: string[] = [];
    let previous: number | undefined;
    for (const target of ordered) {
      assertU32(target.functionOrdinal, "resume function ordinal");
      if (typeof target.thunk !== "function") {
        throw new TypeError("resume target thunk is not a Wasm function");
      }
      if (previous === target.functionOrdinal) {
        throw new Error(
          `resume-table activation ${activationId} repeats function ordinal ${previous}`,
        );
      }
      previous = target.functionOrdinal;
      const slot = this.allocateSlot();
      this.table.set(slot, target.thunk);
      const key = eventKey(activationId, target.functionOrdinal);
      this.targets.set(key, { ...target, activationId, slot });
      keys.push(key);
    }
    this.activationKeys.set(activationId, keys);
  }

  unregisterActivation(activationId: number): void {
    assertU32(activationId, "resume-table activation id");
    const keys = this.activationKeys.get(activationId);
    if (!keys) {
      throw new Error(`resume-table activation ${activationId} is not registered`);
    }
    for (const key of keys) {
      const target = this.targets.get(key)!;
      this.table.set(target.slot, null);
      this.targets.delete(key);
      this.freeSlots.push(target.slot);
    }
    this.freeSlots.sort((left, right) => left - right);
    this.activationKeys.delete(activationId);
  }

  slotFor(event: ForkReplayEvent | null): number {
    if (!event) return 0;
    const target = this.targets.get(
      eventKey(event.activationId, event.functionOrdinal),
    );
    if (!target) {
      throw new Error(
        `fork replay target ${event.activationId}:${event.functionOrdinal} `
        + `is not registered`,
      );
    }
    // WHY: recursive/reference type equality belongs to the Wasm engine. The
    // caller invokes this heterogeneous slot through a statically typed
    // call_indirect, which validates the exact result type before the thunk
    // can consume its frame. Reimplementing canonical recursive types in JS
    // would create a second, weaker type system.
    return target.slot;
  }

  clear(): void {
    for (const activationId of [...this.activationKeys.keys()].sort(
      (left, right) => right - left,
    )) {
      this.unregisterActivation(activationId);
    }
    this.freeSlots = [];
  }

  private allocateSlot(): number {
    const reused = this.freeSlots.shift();
    if (reused !== undefined) return reused;
    const slot = this.table.length;
    this.table.grow(1);
    return slot;
  }
}
