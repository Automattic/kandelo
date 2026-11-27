import type { PersistentOverlayStorage } from "./overlay-storage";
import { InvalidOverlayActivationError, OVERLAY_ACTIVATION_BYTES,
  type OverlayActivationCodec, type OverlayActivationRecord } from "./overlay-activation-codec";

export { InvalidOverlayActivationError, OVERLAY_ACTIVATION_BYTES,
  type OverlayActivationCodec, type OverlayActivationRecord } from "./overlay-activation-codec";

export class UnconfirmedOverlayActivationError extends Error {
  constructor(cause: unknown) {
    super("Journal activated but durable activation publication failed; stop the writer", { cause });
    this.name = "UnconfirmedOverlayActivationError";
  }
}

export class UnprovenOverlayActivationCleanupError extends AggregateError {
  constructor(failures: unknown[], readonly resources: readonly PersistentOverlayStorage[]) {
    super(failures, "Activation control cleanup failed");
    this.name = "UnprovenOverlayActivationCleanupError";
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function encodeOverlayActivation(record: OverlayActivationRecord, codec: OverlayActivationCodec): Uint8Array {
  return codec.encode(record);
}

export function decodeOverlayActivation(bytes: Uint8Array, codec: OverlayActivationCodec): OverlayActivationRecord {
  return codec.decode(bytes);
}

/** Read-only selection for both boot and the saved-image binding inspector. */
export function selectOverlayActivationReplicas(
  codec: OverlayActivationCodec, copies: readonly (Uint8Array | null)[],
) {
  const replicas: [OverlayActivationRecord | null, OverlayActivationRecord | null] = [null, null];
  let invalid = false;
  for (const replica of [0, 1] as const) {
    const bytes = copies[replica];
    if (!bytes?.length) continue;
    try { replicas[replica] = decodeOverlayActivation(bytes, codec); }
    catch (error) {
      if (!(error instanceof InvalidOverlayActivationError)) throw error;
      invalid = true;
    }
  }
  return { replicas, current: codec.select(replicas, invalid) };
}

export function sameOverlayActivationIdentity(
  left: Omit<OverlayActivationRecord, "sequence">,
  right: Omit<OverlayActivationRecord, "sequence">,
): boolean {
  return left.generation === right.generation && left.slot === right.slot
    && equalBytes(left.baseDigest, right.baseDigest) && equalBytes(left.sealDigest, right.sealDigest);
}

export interface OverlayActivationFiles {
  readonly activationCodec: OverlayActivationCodec;
  open(replica: 0 | 1, create: boolean): Promise<PersistentOverlayStorage | null>;
}

export class OverlayActivationControlPair {
  private readonly handles: [PersistentOverlayStorage | null, PersistentOverlayStorage | null];
  private closed = false;
  private publicationFailed = false;
  private currentRecord: OverlayActivationRecord | null = null;
  private replicas: [OverlayActivationRecord | null, OverlayActivationRecord | null] = [null, null];
  private repaired = false;

  private constructor(private readonly files: OverlayActivationFiles,
    handles: [PersistentOverlayStorage | null, PersistentOverlayStorage | null]) {
    this.handles = handles;
  }

  static async open(files: OverlayActivationFiles): Promise<OverlayActivationControlPair> {
    const handles: [PersistentOverlayStorage | null, PersistentOverlayStorage | null] = [null, null];
    try {
      handles[0] = await files.open(0, false);
      handles[1] = await files.open(1, false);
      const pair = new OverlayActivationControlPair(files, handles);
      pair.read();
      return pair;
    } catch (error) {
      const failures: unknown[] = [error];
      for (const handle of handles) {
        try { handle?.close(); } catch (closeError) { failures.push(closeError); }
      }
      if (failures.length > 1) throw new UnprovenOverlayActivationCleanupError(failures,
        handles.filter((handle): handle is PersistentOverlayStorage => handle !== null));
      throw error;
    }
  }

  get current(): OverlayActivationRecord | null {
    if (this.closed || this.publicationFailed) throw new InvalidOverlayActivationError("Activation controls are not reusable");
    return this.currentRecord;
  }

  async prepare(): Promise<void> {
    if (this.closed || this.publicationFailed) throw new InvalidOverlayActivationError("Activation controls are not reusable");
    for (const replica of [0, 1] as const) {
      if (this.handles[replica] !== null) continue;
      this.handles[replica] = await this.files.open(replica, true);
      if (this.handles[replica] === null) throw new Error("Could not create activation control");
    }
    this.repairCurrent();
  }

  next(identity: Omit<OverlayActivationRecord, "sequence">): OverlayActivationRecord {
    return this.files.activationCodec.next(this.current, identity);
  }

  publish(record: OverlayActivationRecord): void {
    if (this.closed || this.publicationFailed || this.handles.some(handle => handle === null)) {
      throw new InvalidOverlayActivationError("Activation controls were not prepared");
    }
    const bytes = encodeOverlayActivation(record, this.files.activationCodec);
    const expected = this.next(record);
    if (record.sequence !== expected.sequence) throw new InvalidOverlayActivationError("Invalid activation sequence");
    this.repairCurrent();
    if (this.currentRecord !== null && record.sequence === this.currentRecord.sequence) return;
    try {
      for (const handle of this.handles) {
        handle!.writeAllAt(0, bytes);
        handle!.truncate(bytes.length);
        handle!.flush();
      }
    } catch (error) {
      this.publicationFailed = true;
      this.currentRecord = null;
      throw error;
    }
    this.currentRecord = decodeOverlayActivation(bytes, this.files.activationCodec);
    this.replicas[0] = this.currentRecord;
    this.replicas[1] = this.currentRecord;
    this.repaired = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.currentRecord = null;
    const failures: unknown[] = [];
    for (const replica of [0, 1] as const) {
      const handle = this.handles[replica];
      try { handle?.close(); this.handles[replica] = null; } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new UnprovenOverlayActivationCleanupError(failures,
      this.handles.filter((handle): handle is PersistentOverlayStorage => handle !== null));
  }

  private read(): void {
    const copies = this.handles.map(handle => {
      if (handle === null) return null;
      const length = handle.len();
      if (length === 0) return null;
      if (length !== OVERLAY_ACTIVATION_BYTES) return Uint8Array.of(0);
      const bytes = new Uint8Array(OVERLAY_ACTIVATION_BYTES);
      handle.readExactAt(0, bytes);
      return bytes;
    });
    const { current, replicas } = selectOverlayActivationReplicas(this.files.activationCodec, copies);
    this.currentRecord = current;
    this.replicas = replicas;
  }

  private repairCurrent(): void {
    if (this.currentRecord === null || this.repaired) return;
    const record = this.currentRecord;
    const bytes = encodeOverlayActivation(record, this.files.activationCodec);
    try {
      for (const replica of [0, 1] as const) {
        const previous = this.replicas[replica];
        if (previous !== null && previous.sequence === record.sequence && sameOverlayActivationIdentity(previous, record)) continue;
        const handle = this.handles[replica];
        if (handle === null) throw new InvalidOverlayActivationError("Activation controls were not prepared");
        handle.writeAllAt(0, bytes);
        handle.truncate(bytes.length);
        handle.flush();
        this.replicas[replica] = record;
      }
      for (const handle of this.handles) handle!.flush();
      this.repaired = true;
    } catch (error) {
      this.publicationFailed = true;
      this.currentRecord = null;
      throw error;
    }
  }
}
