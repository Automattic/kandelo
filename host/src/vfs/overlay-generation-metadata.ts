import { ERRNO } from "../generated/abi";
import { StorageMemoryBudget, STORAGE_ENTRY_BYTES, type StorageMemoryReservation } from "./storage-memory-budget";

export interface OverlayGenerationMetadataScope {
  retainSlot(slot: string): void;
  finish(success: boolean): void;
}

export const OVERLAY_GENERATION_BASE_BYTES = 17 * STORAGE_ENTRY_BYTES;

export class OverlayGenerationMetadata {
  readonly #slots = new Set<string>();
  readonly #admission: StorageMemoryReservation;
  #busy = false;
  #disposed = false;
  #unprovenCleanup: { owner: object; failure: Error } | null = null;

  constructor(budget = new StorageMemoryBudget()) {
    this.#admission = budget.reserve(OVERLAY_GENERATION_BASE_BYTES);
  }

  enter(): OverlayGenerationMetadataScope {
    if (this.#disposed) throw Object.assign(new Error("Overlay generation metadata is disposed"), { code: "EBADF" });
    if (this.#unprovenCleanup !== null) throw this.#unprovenCleanup.failure;
    if (this.#busy) throw Object.assign(new Error("Overlay generation operation is already active"), { code: "EBUSY", errno: ERRNO.EBUSY });
    const added: string[] = [];
    let finished = false;
    const scope: OverlayGenerationMetadataScope = {
      retainSlot: slot => {
        if (finished) throw new Error("Overlay generation metadata scope is released");
        if (this.#slots.has(slot)) return;
        const previous = this.#admission.size;
        this.#admission.resize(previous + this.slotBytes(slot));
        try {
          added.push(slot);
          this.#slots.add(slot);
        } catch (error) {
          if (added[added.length - 1] === slot) added.pop();
          this.#slots.delete(slot);
          this.#admission.resize(previous);
          throw error;
        }
      },
      finish: success => {
        if (finished) return;
        finished = true;
        if (!success) {
          for (const slot of added) {
            this.#slots.delete(slot);
            this.#admission.resize(this.#admission.size - this.slotBytes(slot));
          }
        }
        added.length = 0;
        this.#busy = false;
      },
    };
    this.#busy = true;
    return scope;
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#busy) throw new Error("Overlay generation metadata still has an active owner");
    if (this.#unprovenCleanup !== null) throw this.#unprovenCleanup.failure;
    this.#slots.clear();
    this.#admission.release();
    this.#disposed = true;
  }

  retainUnprovenCleanup(owner: object, cause: unknown): void {
    this.#unprovenCleanup ??= { owner, failure: new Error("Overlay generation storage retirement is unproven; terminate its owner before reopening", { cause }) };
  }

  private slotBytes(slot: string): number {
    return 16 * STORAGE_ENTRY_BYTES + slot.length * 2;
  }
}

const metadataOwners = new WeakMap<object, OverlayGenerationMetadata>();

export function retainOverlayGenerationCleanup(files: object & { readonly metadata?: OverlayGenerationMetadata }, owner: object, failure: unknown): void {
  const metadata = files.metadata ?? metadataOwners.get(files);
  if (metadata === undefined) throw new Error("Overlay generation cleanup has no metadata owner");
  metadata.retainUnprovenCleanup(owner, failure);
}

export async function withOverlayGenerationMetadata<Result>(
  files: object & { readonly metadata?: OverlayGenerationMetadata },
  operation: (scope: OverlayGenerationMetadataScope) => Promise<Result>,
): Promise<Result> {
  let owner = files.metadata ?? metadataOwners.get(files);
  if (owner === undefined) {
    owner = new OverlayGenerationMetadata();
    metadataOwners.set(files, owner);
  }
  const scope = owner.enter();
  let success = false;
  try {
    const result = await operation(scope);
    success = true;
    return result;
  } finally { scope.finish(success); }
}
