import type {
  ForkExternrefToken,
  ForkExternrefTokenCache,
} from "./fork-reference-broker";

/**
 * Version 2 is a catalog-sized, one-request-at-a-time mailbox. It is private
 * to the host runtime, but versioning it prevents a mixed Worker/owner build
 * from interpreting the same scalar words differently.
 */
export const FORK_EXTERNREF_IMPORT_MAILBOX_VERSION = 2;
export const FORK_EXTERNREF_IMPORT_DESCRIPTOR_VERSION = 1;

const MAILBOX_MAGIC = 0x4b465849; // "KFXI"
const MAX_U32 = 0xffff_ffff;
const MAX_I32 = 0x7fff_ffff;
const MIN_I32 = -0x8000_0000;
const MAX_I64 = (1n << 63n) - 1n;
const MIN_I64 = -(1n << 63n);

const enum HeaderWord {
  Status = 0,
  Magic = 1,
  MailboxVersion = 2,
  Pid = 3,
  Generation = 4,
  Sender = 5,
  SequenceLow = 6,
  SequenceHigh = 7,
  DescriptorVersion = 8,
  Ordinal = 9,
  ParamCount = 10,
  ResultCount = 11,
  ParamCapacity = 12,
  ResultCapacity = 13,
  FailureCode = 14,
  ExceptionHandle = 15,
  CloseReason = 16,
  Reserved1 = 17,
}

const HEADER_WORDS = HeaderWord.Reserved1 + 1;
const HEADER_BYTES = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
const SLOT_BYTES = BigInt64Array.BYTES_PER_ELEMENT;
const TYPE_CODES_PER_BYTE = 2;

export interface ForkExternrefImportMailboxCapacity {
  readonly params: number;
  readonly results: number;
}

interface ForkExternrefImportMailboxLayout
  extends ForkExternrefImportMailboxCapacity {
  readonly paramTypesOffset: number;
  readonly resultTypesOffset: number;
  readonly paramOffset: number;
  readonly resultOffset: number;
  readonly byteLength: number;
}

const enum MailboxStatus {
  Idle = 0,
  Writing = 1,
  RequestReady = 2,
  Dispatching = 3,
  ResultReady = 4,
  ExceptionReady = 5,
  Failed = 6,
  Closed = 7,
}

export enum ForkExternrefImportFailureCode {
  Protocol = 1,
  Unauthorized = 2,
  ArgumentAuthorization = 3,
  HandlerContract = 4,
  OwnerFailure = 5,
  NotificationFailure = 6,
  Teardown = 7,
}

export type ForkExternrefImportValueType =
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "externref";

export type ForkExternrefImportValue =
  | number
  | bigint
  | null
  | ForkExternrefToken;

export interface ForkExternrefImportDescriptor {
  readonly version: typeof FORK_EXTERNREF_IMPORT_DESCRIPTOR_VERSION;
  readonly ordinal: number;
  readonly params: readonly ForkExternrefImportValueType[];
  readonly results: readonly ForkExternrefImportValueType[];
}

export interface ForkExternrefImportBinding {
  readonly pid: number;
  readonly generationId: number;
  /**
   * One nonzero u32 assigned to one process or pthread Worker. Side modules
   * execute on that same Worker and deliberately reuse the same sender.
   */
  readonly senderId: number;
}

/**
 * The only per-call message that needs to cross postMessage. All fields are
 * scalar; the mailbox itself is transferred once in the Worker init message.
 */
export interface ForkExternrefImportWake {
  readonly mailboxVersion: number;
  readonly pid: number;
  readonly generationId: number;
  readonly senderId: number;
  readonly sequenceLow: number;
  readonly sequenceHigh: number;
}

export interface ForkExternrefImportAuthority {
  authorizeForWire(
    pid: number,
    generationId: number,
    handle: number,
  ): unknown;
  registerForWire(
    pid: number,
    generationId: number,
    value: unknown,
  ): number;
}

export interface ForkExternrefImportHandlerContext
  extends ForkExternrefImportBinding {
  readonly descriptor: ForkExternrefImportDescriptor;
}

export type ForkExternrefImportHandler = (
  context: ForkExternrefImportHandlerContext,
  ...args: unknown[]
) => unknown;

export interface ForkExternrefImportOwnerEndpointOptions {
  /**
   * Revalidate the exact live Worker and process image for every request.
   * Implementations should compare object identity owned by the entrypoint,
   * not trust PID/generation numbers copied from the wake message.
   */
  readonly authorizeSender: (
    binding: ForkExternrefImportBinding,
  ) => void;
  /** Owner-realm diagnostics; no Error or host value crosses the mailbox. */
  readonly onDiagnostic?: (
    error: unknown,
    failure: ForkExternrefImportFailureCode,
  ) => void;
}

interface RegisteredHandler {
  readonly descriptor: ForkExternrefImportDescriptor;
  readonly handler: ForkExternrefImportHandler;
}

function assertSafeByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} exceeds JavaScript's safe byte range`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  assertSafeByteCount(result, label);
  return result;
}

function checkedMultiply(
  left: number,
  right: number,
  label: string,
): number {
  const result = left * right;
  assertSafeByteCount(result, label);
  return result;
}

function alignToSlot(value: number): number {
  const remainder = value % SLOT_BYTES;
  return remainder === 0
    ? value
    : checkedAdd(value, SLOT_BYTES - remainder, "mailbox alignment");
}

function validateCapacity(
  capacity: ForkExternrefImportMailboxCapacity,
): void {
  if (
    typeof capacity !== "object"
    || capacity === null
  ) {
    throw new TypeError("fork externref import mailbox capacity is required");
  }
  assertU32(capacity.params, "mailbox parameter capacity", true);
  assertU32(capacity.results, "mailbox result capacity", true);
}

function typeSignatureBytes(count: number): number {
  return Math.ceil(count / TYPE_CODES_PER_BYTE);
}

function mailboxLayout(
  capacity: ForkExternrefImportMailboxCapacity,
): ForkExternrefImportMailboxLayout {
  validateCapacity(capacity);
  const paramTypesOffset = HEADER_BYTES;
  const resultTypesOffset = checkedAdd(
    paramTypesOffset,
    typeSignatureBytes(capacity.params),
    "mailbox parameter type signature",
  );
  const typeEnd = checkedAdd(
    resultTypesOffset,
    typeSignatureBytes(capacity.results),
    "mailbox result type signature",
  );
  const paramOffset = alignToSlot(typeEnd);
  const resultOffset = checkedAdd(
    paramOffset,
    checkedMultiply(
      capacity.params,
      SLOT_BYTES,
      "mailbox parameter slots",
    ),
    "mailbox result offset",
  );
  const byteLength = checkedAdd(
    resultOffset,
    checkedMultiply(
      capacity.results,
      SLOT_BYTES,
      "mailbox result slots",
    ),
    "mailbox byte length",
  );
  return Object.freeze({
    params: capacity.params,
    results: capacity.results,
    paramTypesOffset,
    resultTypesOffset,
    paramOffset,
    resultOffset,
    byteLength,
  });
}

function assertU32(value: number, label: string, allowZero = false): void {
  if (
    !Number.isInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > MAX_U32
  ) {
    throw new RangeError(
      `${label} must be ${allowZero ? "an" : "a positive"} unsigned 32-bit integer`,
    );
  }
}

function validateBinding(binding: ForkExternrefImportBinding): void {
  assertU32(binding.pid, "fork externref import pid");
  assertU32(
    binding.generationId,
    "fork externref import generation",
  );
  assertU32(binding.senderId, "fork externref import sender");
}

function valueTypeCode(type: ForkExternrefImportValueType): number {
  switch (type) {
    case "i32":
      return 1;
    case "i64":
      return 2;
    case "f32":
      return 3;
    case "f64":
      return 4;
    case "externref":
      return 5;
    default:
      throw new TypeError(
        `unsupported fork externref import value type ${String(type)}`,
      );
  }
}

function validateTypes(
  types: readonly ForkExternrefImportValueType[],
  label: string,
): void {
  if (!Array.isArray(types)) {
    throw new TypeError(`${label} types must be an array`);
  }
  assertU32(types.length, `${label} count`, true);
  for (const type of types) valueTypeCode(type);
}

function writeTypeSequence(
  view: DataView,
  byteOffset: number,
  types: readonly ForkExternrefImportValueType[],
): void {
  for (
    let typeIndex = 0;
    typeIndex < types.length;
    typeIndex += TYPE_CODES_PER_BYTE
  ) {
    const low = valueTypeCode(types[typeIndex]!);
    const high = typeIndex + 1 < types.length
      ? valueTypeCode(types[typeIndex + 1]!)
      : 0;
    view.setUint8(byteOffset + typeIndex / TYPE_CODES_PER_BYTE, low | (high << 4));
  }
}

function typeSequenceMatches(
  view: DataView,
  byteOffset: number,
  types: readonly ForkExternrefImportValueType[],
): boolean {
  for (
    let typeIndex = 0;
    typeIndex < types.length;
    typeIndex += TYPE_CODES_PER_BYTE
  ) {
    const low = valueTypeCode(types[typeIndex]!);
    const high = typeIndex + 1 < types.length
      ? valueTypeCode(types[typeIndex + 1]!)
      : 0;
    if (
      view.getUint8(byteOffset + typeIndex / TYPE_CODES_PER_BYTE)
        !== (low | (high << 4))
    ) {
      return false;
    }
  }
  return true;
}

export function defineForkExternrefImport(
  ordinal: number,
  params: readonly ForkExternrefImportValueType[],
  results: readonly ForkExternrefImportValueType[],
): ForkExternrefImportDescriptor {
  assertU32(ordinal, "fork externref import ordinal", true);
  validateTypes(params, "parameter");
  validateTypes(results, "result");
  return Object.freeze({
    version: FORK_EXTERNREF_IMPORT_DESCRIPTOR_VERSION,
    ordinal,
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
  });
}

export function forkExternrefImportMailboxBytes(
  capacity: ForkExternrefImportMailboxCapacity,
): number {
  return mailboxLayout(capacity).byteLength;
}

export function createForkExternrefImportMailbox(
  capacity: ForkExternrefImportMailboxCapacity,
): SharedArrayBuffer {
  const layout = mailboxLayout(capacity);
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const words = new Int32Array(buffer);
  words[HeaderWord.Magic] = MAILBOX_MAGIC;
  words[HeaderWord.MailboxVersion] =
    FORK_EXTERNREF_IMPORT_MAILBOX_VERSION;
  words[HeaderWord.ParamCapacity] = capacity.params;
  words[HeaderWord.ResultCapacity] = capacity.results;
  Atomics.store(words, HeaderWord.Status, MailboxStatus.Idle);
  return buffer;
}

function readMailboxLayout(
  buffer: SharedArrayBuffer,
): ForkExternrefImportMailboxLayout {
  if (
    !(buffer instanceof SharedArrayBuffer)
    || buffer.byteLength < HEADER_BYTES
    || buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new TypeError(
      "fork externref import mailbox is not a complete shared header",
    );
  }
  const words = new Int32Array(buffer);
  if ((words[HeaderWord.Magic]! >>> 0) !== MAILBOX_MAGIC) {
    throw new Error("invalid fork externref import mailbox magic");
  }
  if (
    (words[HeaderWord.MailboxVersion]! >>> 0)
      !== FORK_EXTERNREF_IMPORT_MAILBOX_VERSION
  ) {
    throw new Error(
      `unsupported fork externref import mailbox version `
      + `${words[HeaderWord.MailboxVersion]! >>> 0}`,
    );
  }
  const layout = mailboxLayout({
    params: words[HeaderWord.ParamCapacity]! >>> 0,
    results: words[HeaderWord.ResultCapacity]! >>> 0,
  });
  if (buffer.byteLength !== layout.byteLength) {
    throw new TypeError(
      `fork externref import mailbox has ${buffer.byteLength} bytes; `
      + `declared capacity requires exactly ${layout.byteLength}`,
    );
  }
  return layout;
}

function validateMailboxHeader(
  words: Int32Array,
  layout: ForkExternrefImportMailboxLayout,
): void {
  if ((words[HeaderWord.Magic]! >>> 0) !== MAILBOX_MAGIC) {
    throw new Error("invalid fork externref import mailbox magic");
  }
  if (
    (words[HeaderWord.MailboxVersion]! >>> 0)
      !== FORK_EXTERNREF_IMPORT_MAILBOX_VERSION
  ) {
    throw new Error(
      `unsupported fork externref import mailbox version `
      + `${words[HeaderWord.MailboxVersion]! >>> 0}`,
    );
  }
  if (
    (words[HeaderWord.ParamCapacity]! >>> 0) !== layout.params
    || (words[HeaderWord.ResultCapacity]! >>> 0) !== layout.results
  ) {
    throw new Error("fork externref import mailbox capacity changed");
  }
}

function writeU32(view: DataView, byteOffset: number, value: number): void {
  view.setUint32(byteOffset, value >>> 0, true);
}

function readU32(view: DataView, byteOffset: number): number {
  return view.getUint32(byteOffset, true);
}

function wordOffset(word: HeaderWord): number {
  return word * Int32Array.BYTES_PER_ELEMENT;
}

function writeHeaderU32(
  view: DataView,
  word: HeaderWord,
  value: number,
): void {
  writeU32(view, wordOffset(word), value);
}

function readHeaderU32(view: DataView, word: HeaderWord): number {
  return readU32(view, wordOffset(word));
}

function slotOffset(base: number, index: number): number {
  return base + index * SLOT_BYTES;
}

function writeScalarSlot(
  view: DataView,
  base: number,
  index: number,
  type: Exclude<ForkExternrefImportValueType, "externref">,
  value: unknown,
): void {
  const offset = slotOffset(base, index);
  view.setBigUint64(offset, 0n, true);
  switch (type) {
    case "i32":
      if (
        typeof value !== "number"
        || !Number.isInteger(value)
        || value < MIN_I32
        || value > MAX_I32
      ) {
        throw new TypeError(`i32 value at slot ${index} is not signed i32`);
      }
      view.setInt32(offset, value, true);
      return;
    case "i64":
      if (
        typeof value !== "bigint"
        || value < MIN_I64
        || value > MAX_I64
      ) {
        throw new TypeError(`i64 value at slot ${index} is not signed i64`);
      }
      view.setBigInt64(offset, value, true);
      return;
    case "f32":
      if (typeof value !== "number") {
        throw new TypeError(`f32 value at slot ${index} is not a number`);
      }
      view.setFloat32(offset, value, true);
      return;
    case "f64":
      if (typeof value !== "number") {
        throw new TypeError(`f64 value at slot ${index} is not a number`);
      }
      view.setFloat64(offset, value, true);
      return;
  }
}

function readScalarSlot(
  view: DataView,
  base: number,
  index: number,
  type: Exclude<ForkExternrefImportValueType, "externref">,
): number | bigint {
  const offset = slotOffset(base, index);
  switch (type) {
    case "i32":
      return view.getInt32(offset, true);
    case "i64":
      return view.getBigInt64(offset, true);
    case "f32":
      return view.getFloat32(offset, true);
    case "f64":
      return view.getFloat64(offset, true);
  }
}

function nextSequence(
  low: number,
  high: number,
): { low: number; high: number } {
  if (low === MAX_U32) {
    if (high === MAX_U32) {
      throw new RangeError(
        "fork externref import mailbox sequence space exhausted",
      );
    }
    return { low: 0, high: high + 1 };
  }
  return { low: low + 1, high };
}

function bindingEquals(
  first: ForkExternrefImportBinding,
  second: ForkExternrefImportBinding,
): boolean {
  return first.pid === second.pid
    && first.generationId === second.generationId
    && first.senderId === second.senderId;
}

function failureDescription(code: number): string {
  const known = ForkExternrefImportFailureCode[
    code as ForkExternrefImportFailureCode
  ];
  return known ?? `Unknown(${code})`;
}

export class ForkExternrefImportRemoteFailure extends Error {
  constructor(
    readonly failureCode: number,
    options?: ErrorOptions,
  ) {
    super(
      `fork externref host import failed: ${failureDescription(failureCode)}`,
      options,
    );
    this.name = "ForkExternrefImportRemoteFailure";
  }
}

export class ForkExternrefImportClosedError extends Error {
  constructor(readonly reasonCode: number) {
    super(
      `fork externref host import mailbox is closed: `
      + `${failureDescription(reasonCode)}`,
    );
    this.name = "ForkExternrefImportClosedError";
  }
}

/**
 * One synchronous caller per process or pthread Worker.
 *
 * The caller can bind imports from the main module and any side module to this
 * same object. Its single atomic state rejects reentrancy instead of allowing
 * two Wasm activations to overwrite one mailbox and deadlock each other.
 */
export class ForkExternrefImportWorkerCaller {
  private readonly words: Int32Array;
  private readonly view: DataView;
  private readonly layout: ForkExternrefImportMailboxLayout;
  private sequenceLow = 0;
  private sequenceHigh = 0;

  constructor(
    readonly mailbox: SharedArrayBuffer,
    readonly binding: ForkExternrefImportBinding,
    private readonly tokens: ForkExternrefTokenCache,
    private readonly notifyOwner: (wake: ForkExternrefImportWake) => void,
  ) {
    this.layout = readMailboxLayout(mailbox);
    validateBinding(binding);
    if (tokens.generationId !== binding.generationId) {
      throw new Error(
        `fork externref token generation ${tokens.generationId} does not `
        + `match mailbox generation ${binding.generationId}`,
      );
    }
    this.words = new Int32Array(mailbox);
    this.view = new DataView(mailbox);
    validateMailboxHeader(this.words, this.layout);
  }

  bind(
    descriptor: ForkExternrefImportDescriptor,
  ): (...args: ForkExternrefImportValue[]) => unknown {
    this.validateDescriptor(descriptor);
    return (...args: ForkExternrefImportValue[]) =>
      this.call(descriptor, args);
  }

  call(
    descriptor: ForkExternrefImportDescriptor,
    args: readonly ForkExternrefImportValue[],
  ): unknown {
    this.validateDescriptor(descriptor);
    if (args.length !== descriptor.params.length) {
      throw new TypeError(
        `fork externref import ${descriptor.ordinal} expects `
        + `${descriptor.params.length} arguments, received ${args.length}`,
      );
    }

    const prior = Atomics.compareExchange(
      this.words,
      HeaderWord.Status,
      MailboxStatus.Idle,
      MailboxStatus.Writing,
    );
    if (prior === MailboxStatus.Closed) throw this.closedError();
    if (prior !== MailboxStatus.Idle) {
      throw new Error(
        `reentrant fork externref host import while mailbox state=${prior}`,
      );
    }

    try {
      const sequence = nextSequence(
        this.sequenceLow,
        this.sequenceHigh,
      );
      this.sequenceLow = sequence.low;
      this.sequenceHigh = sequence.high;
      this.writeRequest(descriptor, args, sequence);

      if (
        Atomics.compareExchange(
          this.words,
          HeaderWord.Status,
          MailboxStatus.Writing,
          MailboxStatus.RequestReady,
        ) !== MailboxStatus.Writing
      ) {
        throw this.closedError();
      }

      const wake: ForkExternrefImportWake = Object.freeze({
        mailboxVersion: FORK_EXTERNREF_IMPORT_MAILBOX_VERSION,
        pid: this.binding.pid,
        generationId: this.binding.generationId,
        senderId: this.binding.senderId,
        sequenceLow: sequence.low,
        sequenceHigh: sequence.high,
      });
      try {
        this.notifyOwner(wake);
      } catch (error) {
        const reset = Atomics.compareExchange(
          this.words,
          HeaderWord.Status,
          MailboxStatus.RequestReady,
          MailboxStatus.Idle,
        );
        if (reset === MailboxStatus.RequestReady) {
          throw new ForkExternrefImportRemoteFailure(
            ForkExternrefImportFailureCode.NotificationFailure,
            { cause: error },
          );
        }
        // The owner already claimed the request. It owns completion now, so
        // waiting is the only state-safe choice even if notification reported
        // a local error after publishing the wake.
      }
      return this.waitForCompletion(descriptor);
    } catch (error) {
      Atomics.compareExchange(
        this.words,
        HeaderWord.Status,
        MailboxStatus.Writing,
        MailboxStatus.Idle,
      );
      throw error;
    }
  }

  private writeRequest(
    descriptor: ForkExternrefImportDescriptor,
    args: readonly ForkExternrefImportValue[],
    sequence: { low: number; high: number },
  ): void {
    writeHeaderU32(this.view, HeaderWord.Pid, this.binding.pid);
    writeHeaderU32(
      this.view,
      HeaderWord.Generation,
      this.binding.generationId,
    );
    writeHeaderU32(this.view, HeaderWord.Sender, this.binding.senderId);
    writeHeaderU32(this.view, HeaderWord.SequenceLow, sequence.low);
    writeHeaderU32(this.view, HeaderWord.SequenceHigh, sequence.high);
    writeHeaderU32(
      this.view,
      HeaderWord.DescriptorVersion,
      descriptor.version,
    );
    writeHeaderU32(this.view, HeaderWord.Ordinal, descriptor.ordinal);
    writeHeaderU32(
      this.view,
      HeaderWord.ParamCount,
      descriptor.params.length,
    );
    writeHeaderU32(
      this.view,
      HeaderWord.ResultCount,
      descriptor.results.length,
    );
    writeTypeSequence(
      this.view,
      this.layout.paramTypesOffset,
      descriptor.params,
    );
    writeTypeSequence(
      this.view,
      this.layout.resultTypesOffset,
      descriptor.results,
    );
    writeHeaderU32(this.view, HeaderWord.FailureCode, 0);
    writeHeaderU32(this.view, HeaderWord.ExceptionHandle, 0);

    for (let index = 0; index < descriptor.params.length; index++) {
      const type = descriptor.params[index]!;
      const value = args[index];
      if (type === "externref") {
        const handle = value === null ? 0 : this.tokens.encode(value);
        if (handle === null) {
          throw new Error(
            `externref argument ${index} for import ${descriptor.ordinal} `
            + `did not come from this process-image owner`,
          );
        }
        this.view.setBigUint64(
          slotOffset(this.layout.paramOffset, index),
          BigInt(handle),
          true,
        );
      } else {
        writeScalarSlot(
          this.view,
          this.layout.paramOffset,
          index,
          type,
          value,
        );
      }
    }
  }

  private waitForCompletion(
    descriptor: ForkExternrefImportDescriptor,
  ): unknown {
    for (;;) {
      const status = Atomics.load(this.words, HeaderWord.Status);
      if (
        status === MailboxStatus.RequestReady
        || status === MailboxStatus.Dispatching
      ) {
        Atomics.wait(this.words, HeaderWord.Status, status);
        continue;
      }
      if (status === MailboxStatus.ResultReady) {
        if (!this.takeCompletion(MailboxStatus.ResultReady)) continue;
        return this.readResults(descriptor);
      }
      if (status === MailboxStatus.ExceptionReady) {
        if (!this.takeCompletion(MailboxStatus.ExceptionReady)) continue;
        const handle = readHeaderU32(
          this.view,
          HeaderWord.ExceptionHandle,
        );
        throw handle === 0 ? null : this.tokens.materialize(handle);
      }
      if (status === MailboxStatus.Failed) {
        const code = readHeaderU32(this.view, HeaderWord.FailureCode);
        if (!this.takeCompletion(MailboxStatus.Failed)) continue;
        throw new ForkExternrefImportRemoteFailure(code);
      }
      if (status === MailboxStatus.Closed) throw this.closedError();
      throw new Error(
        `invalid fork externref import completion state ${status}`,
      );
    }
  }

  private takeCompletion(expected: MailboxStatus): boolean {
    // Once the Worker returns the status to IDLE, only its own synchronous JS
    // stack can start another request. Result slots therefore remain stable
    // while this call decodes them, without an extra per-call buffer.
    return Atomics.compareExchange(
      this.words,
      HeaderWord.Status,
      expected,
      MailboxStatus.Idle,
    ) === expected;
  }

  private readResults(
    descriptor: ForkExternrefImportDescriptor,
  ): unknown {
    const results = descriptor.results.map((type, index) => {
      if (type === "externref") {
        const bits = this.view.getBigUint64(
          slotOffset(this.layout.resultOffset, index),
          true,
        );
        if (bits > BigInt(MAX_U32)) {
          throw new Error(
            `invalid externref result handle ${bits} at slot ${index}`,
          );
        }
        const handle = Number(bits);
        return handle === 0 ? null : this.tokens.materialize(handle);
      }
      return readScalarSlot(
        this.view,
        this.layout.resultOffset,
        index,
        type,
      );
    });
    if (results.length === 0) return undefined;
    if (results.length === 1) return results[0];
    return results;
  }

  private closedError(): ForkExternrefImportClosedError {
    return new ForkExternrefImportClosedError(
      readHeaderU32(this.view, HeaderWord.CloseReason),
    );
  }

  private validateDescriptor(
    descriptor: ForkExternrefImportDescriptor,
  ): void {
    if (
      descriptor.version !== FORK_EXTERNREF_IMPORT_DESCRIPTOR_VERSION
    ) {
      throw new Error(
        `unsupported fork externref import descriptor version `
        + `${descriptor.version}`,
      );
    }
    assertU32(descriptor.ordinal, "fork externref import ordinal", true);
    validateTypes(descriptor.params, "parameter");
    validateTypes(descriptor.results, "result");
    if (
      descriptor.params.length > this.layout.params
      || descriptor.results.length > this.layout.results
    ) {
      throw new RangeError(
        `fork externref import ${descriptor.ordinal} signature `
        + `(${descriptor.params.length}, ${descriptor.results.length}) exceeds `
        + `mailbox capacity (${this.layout.params}, ${this.layout.results})`,
      );
    }
  }
}

/**
 * Immutable owner-realm descriptor catalog. The ordinal alone never selects a
 * handler: every request must also match its complete packed type sequence.
 */
export class ForkExternrefImportOwnerCatalog {
  private readonly handlers = new Map<number, RegisteredHandler>();
  private maxParams = 0;
  private maxResults = 0;

  register(
    descriptor: ForkExternrefImportDescriptor,
    handler: ForkExternrefImportHandler,
  ): void {
    if (this.handlers.has(descriptor.ordinal)) {
      throw new Error(
        `duplicate fork externref import ordinal ${descriptor.ordinal}`,
      );
    }
    const canonical = defineForkExternrefImport(
      descriptor.ordinal,
      descriptor.params,
      descriptor.results,
    );
    if (descriptor.version !== canonical.version) {
      throw new Error(
        `unsupported fork externref import descriptor version `
        + `${descriptor.version}`,
      );
    }
    this.handlers.set(descriptor.ordinal, {
      descriptor: canonical,
      handler,
    });
    this.maxParams = Math.max(this.maxParams, canonical.params.length);
    this.maxResults = Math.max(this.maxResults, canonical.results.length);
  }

  lookup(ordinal: number): RegisteredHandler | undefined {
    return this.handlers.get(ordinal);
  }

  get mailboxCapacity(): ForkExternrefImportMailboxCapacity {
    return Object.freeze({
      params: this.maxParams,
      results: this.maxResults,
    });
  }
}

/**
 * Owner-side endpoint bound to one exact Worker mailbox.
 *
 * Entry-point message handlers pass the independently observed sender binding
 * into dispatch(). That prevents a numeric sender copied from an untrusted
 * wake message from authorizing itself.
 */
export class ForkExternrefImportOwnerEndpoint {
  private readonly words: Int32Array;
  private readonly view: DataView;
  private readonly layout: ForkExternrefImportMailboxLayout;

  constructor(
    readonly mailbox: SharedArrayBuffer,
    readonly binding: ForkExternrefImportBinding,
    private readonly catalog: ForkExternrefImportOwnerCatalog,
    private readonly authority: ForkExternrefImportAuthority,
    private readonly options: ForkExternrefImportOwnerEndpointOptions,
  ) {
    this.layout = readMailboxLayout(mailbox);
    validateBinding(binding);
    const required = catalog.mailboxCapacity;
    if (
      required.params > this.layout.params
      || required.results > this.layout.results
    ) {
      throw new RangeError(
        `fork externref import catalog requires capacity `
        + `(${required.params}, ${required.results}); mailbox provides `
        + `(${this.layout.params}, ${this.layout.results})`,
      );
    }
    this.words = new Int32Array(mailbox);
    this.view = new DataView(mailbox);
    validateMailboxHeader(this.words, this.layout);
  }

  /**
   * Dispatch one ready request. False means the wake was stale, duplicated, or
   * routed from a different Worker; in those cases this endpoint does not
   * disturb a possibly newer live request.
   */
  dispatch(
    wake: ForkExternrefImportWake,
    observedSender: ForkExternrefImportBinding,
  ): boolean {
    validateBinding(observedSender);
    if (
      !bindingEquals(observedSender, this.binding)
      || wake.mailboxVersion !== FORK_EXTERNREF_IMPORT_MAILBOX_VERSION
      || wake.pid !== this.binding.pid
      || wake.generationId !== this.binding.generationId
      || wake.senderId !== this.binding.senderId
      || wake.sequenceLow !== readHeaderU32(
        this.view,
        HeaderWord.SequenceLow,
      )
      || wake.sequenceHigh !== readHeaderU32(
        this.view,
        HeaderWord.SequenceHigh,
      )
    ) {
      return false;
    }
    if (
      Atomics.compareExchange(
        this.words,
        HeaderWord.Status,
        MailboxStatus.RequestReady,
        MailboxStatus.Dispatching,
      ) !== MailboxStatus.RequestReady
    ) {
      return false;
    }

    let registered: RegisteredHandler;
    try {
      this.validateClaimedRequest(wake);
      registered = this.requireRegisteredHandler();
    } catch (error) {
      this.completeFailure(
        ForkExternrefImportFailureCode.Protocol,
        error,
      );
      return true;
    }
    try {
      this.options.authorizeSender(this.binding);
    } catch (error) {
      this.completeFailure(
        ForkExternrefImportFailureCode.Unauthorized,
        error,
      );
      return true;
    }

    let args: unknown[];
    try {
      args = this.readArguments(registered.descriptor);
    } catch (error) {
      this.completeFailure(
        ForkExternrefImportFailureCode.ArgumentAuthorization,
        error,
      );
      return true;
    }

    let returned: unknown;
    try {
      returned = registered.handler(
        {
          ...this.binding,
          descriptor: registered.descriptor,
        },
        ...args,
      );
    } catch (thrown) {
      try {
        // WHY: exception completion never uses the externref-null sentinel.
        // JavaScript may throw null, undefined, or any other primitive; each
        // still needs a nonzero owner handle so CatchAllRef cannot retain a
        // raw Worker-local value that the fork recipe provider cannot encode.
        const handle = this.authority.registerForWire(
          this.binding.pid,
          this.binding.generationId,
          thrown,
        );
        assertU32(
          handle,
          "fork externref exception handle",
        );
        writeHeaderU32(
          this.view,
          HeaderWord.ExceptionHandle,
          handle,
        );
        this.complete(MailboxStatus.ExceptionReady);
      } catch (error) {
        this.completeFailure(
          ForkExternrefImportFailureCode.OwnerFailure,
          error,
        );
      }
      return true;
    }

    try {
      this.writeResults(registered.descriptor, returned);
      this.complete(MailboxStatus.ResultReady);
    } catch (error) {
      this.completeFailure(
        ForkExternrefImportFailureCode.HandlerContract,
        error,
      );
    }
    return true;
  }

  /**
   * Close on exec, exit, Worker crash, or host destruction. Any blocked call is
   * woken even if teardown races request publication or owner dispatch.
   */
  close(
    reason: ForkExternrefImportFailureCode =
      ForkExternrefImportFailureCode.Teardown,
  ): void {
    // WHY: failure completion and teardown can race. Keep the terminal close
    // reason in its own word so a losing dispatch cannot rewrite what wakes a
    // blocked Worker after the owner has retired this process image.
    writeHeaderU32(this.view, HeaderWord.CloseReason, reason);
    Atomics.exchange(
      this.words,
      HeaderWord.Status,
      MailboxStatus.Closed,
    );
    Atomics.notify(this.words, HeaderWord.Status);
  }

  private validateClaimedRequest(wake: ForkExternrefImportWake): void {
    validateMailboxHeader(this.words, this.layout);
    const requestBinding: ForkExternrefImportBinding = {
      pid: readHeaderU32(this.view, HeaderWord.Pid),
      generationId: readHeaderU32(
        this.view,
        HeaderWord.Generation,
      ),
      senderId: readHeaderU32(this.view, HeaderWord.Sender),
    };
    if (!bindingEquals(requestBinding, this.binding)) {
      throw new Error("fork externref mailbox request binding mismatch");
    }
    if (
      readHeaderU32(this.view, HeaderWord.SequenceLow)
        !== wake.sequenceLow
      || readHeaderU32(this.view, HeaderWord.SequenceHigh)
        !== wake.sequenceHigh
    ) {
      throw new Error("fork externref mailbox sequence changed after claim");
    }
  }

  private requireRegisteredHandler(): RegisteredHandler {
    const descriptorVersion = readHeaderU32(
      this.view,
      HeaderWord.DescriptorVersion,
    );
    if (
      descriptorVersion !== FORK_EXTERNREF_IMPORT_DESCRIPTOR_VERSION
    ) {
      throw new Error(
        `unsupported fork externref descriptor version `
        + `${descriptorVersion}`,
      );
    }
    const ordinal = readHeaderU32(this.view, HeaderWord.Ordinal);
    const registered = this.catalog.lookup(ordinal);
    if (!registered) {
      throw new Error(`unknown fork externref import ordinal ${ordinal}`);
    }
    const descriptor = registered.descriptor;
    const matches =
      readHeaderU32(this.view, HeaderWord.ParamCount)
        === descriptor.params.length
      && readHeaderU32(this.view, HeaderWord.ResultCount)
        === descriptor.results.length
      && typeSequenceMatches(
        this.view,
        this.layout.paramTypesOffset,
        descriptor.params,
      )
      && typeSequenceMatches(
        this.view,
        this.layout.resultTypesOffset,
        descriptor.results,
      );
    if (!matches) {
      throw new Error(
        `fork externref import ${ordinal} signature mismatch`,
      );
    }
    return registered;
  }

  private readArguments(
    descriptor: ForkExternrefImportDescriptor,
  ): unknown[] {
    return descriptor.params.map((type, index) => {
      if (type === "externref") {
        const bits = this.view.getBigUint64(
          slotOffset(this.layout.paramOffset, index),
          true,
        );
        if (bits > BigInt(MAX_U32)) {
          throw new RangeError(
            `externref argument handle ${bits} exceeds u32`,
          );
        }
        const handle = Number(bits);
        return handle === 0
          ? null
          : this.authority.authorizeForWire(
            this.binding.pid,
            this.binding.generationId,
            handle,
          );
      }
      return readScalarSlot(
        this.view,
        this.layout.paramOffset,
        index,
        type,
      );
    });
  }

  private writeResults(
    descriptor: ForkExternrefImportDescriptor,
    returned: unknown,
  ): void {
    let values: readonly unknown[];
    if (descriptor.results.length === 0) {
      // Match the WebAssembly JS embedding: a return value from a void import
      // is ignored. This also lets every host import use the exception-
      // normalization path without imposing a new result-value policy.
      values = [];
    } else if (descriptor.results.length === 1) {
      values = [returned];
    } else {
      if (
        !Array.isArray(returned)
        || returned.length !== descriptor.results.length
      ) {
        throw new TypeError(
          `fork externref import ${descriptor.ordinal} must return `
          + `${descriptor.results.length} values`,
        );
      }
      values = returned;
    }

    for (let index = 0; index < descriptor.results.length; index++) {
      const type = descriptor.results[index]!;
      const value = values[index];
      if (type === "externref") {
        const handle = value === null
          ? 0
          : this.authority.registerForWire(
            this.binding.pid,
            this.binding.generationId,
            value,
          );
        assertU32(
          handle,
          "fork externref result handle",
          value === null,
        );
        this.view.setBigUint64(
          slotOffset(this.layout.resultOffset, index),
          BigInt(handle),
          true,
        );
      } else {
        writeScalarSlot(
          this.view,
          this.layout.resultOffset,
          index,
          type,
          value,
        );
      }
    }
  }

  private complete(status: MailboxStatus): void {
    const previous = Atomics.compareExchange(
      this.words,
      HeaderWord.Status,
      MailboxStatus.Dispatching,
      status,
    );
    // Teardown wins a race with dispatch. Never resurrect a closed mailbox or
    // publish a result from an image whose generation was already retired.
    if (previous === MailboxStatus.Dispatching) {
      Atomics.notify(this.words, HeaderWord.Status);
    }
  }

  private completeFailure(
    failure: ForkExternrefImportFailureCode,
    error: unknown,
  ): void {
    try {
      this.options.onDiagnostic?.(error, failure);
    } catch {
      // WHY: diagnostics are observational. A throwing logger must not leave
      // the Worker asleep forever with the mailbox stuck in DISPATCHING.
    }
    writeHeaderU32(this.view, HeaderWord.FailureCode, failure);
    this.complete(MailboxStatus.Failed);
  }
}
