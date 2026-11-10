import { snapshotPersistentImageReadBinding, type PersistentImageReadBinding } from "../vfs/image-integrity";
import {
  MemoryOverlayGenerationFiles,
  type OverlayFileBytes,
} from "../vfs/memory-overlay-storage";
import type { OverlayActivationCodec } from "../vfs/overlay-activation-codec";
import type { OverlayGenerationMetadata } from "../vfs/overlay-generation-metadata";
import { parseSealedGenerationSlot } from "../vfs/overlay-generation-seal";
import {
  LiveOverlayCompactor,
  type OverlayCompactionHandoff,
  type OverlayGenerationFile,
  type OverlayGenerationFiles,
  type OverlayGenerationSlot,
  type SelectedOverlayGeneration,
} from "../vfs/overlay-generation-selection";
import type { OverlaySealCodec } from "../vfs/overlay-seal-codec";
import type { PersistentOverlayStorage } from "../vfs/overlay-storage";

/**
 * A persistent `/` in a checkpoint: the computer kept in browser storage, or
 * in a Node journal file, carried whole.
 *
 * Kernel memory alone is not that computer. Its bounded cache may have
 * evicted committed blocks to the journal, so the journal bytes travel too,
 * in the slots the kernel memory names. The base image travels as the bytes
 * the kernel read, which for a checked base is its physical layout: the kernel
 * memory holds that layout's geometry and verifies each block against it on
 * demand. The receiver cannot rebuild it: a stored computer's base was
 * composed once, at creation, and is never recomposed.
 */
export interface CheckpointPersistentRoot {
  /** The base image, byte for byte as the kernel reads it. */
  readonly image: Uint8Array;
  /** The checked base's identity, or null for a base the kernel reads unchecked. */
  readonly binding: PersistentImageReadBinding | null;
  /** Every file of the persistence directory, the live journal included. */
  readonly files: readonly OverlayFileBytes[];
  /** The generation the compactor held, which the receiver's compactor continues. */
  readonly generation: CheckpointOverlayGeneration;
  readonly slots: CheckpointPersistenceSlots;
}

export interface CheckpointPersistenceSlots {
  readonly journal: 0 | 1 | 2;
  readonly index: 0 | 1 | 2 | null;
}

/**
 * `SelectedOverlayGeneration` without its open storages, and with its maps as
 * entry lists, which is what crosses a byte wire.
 */
export type CheckpointOverlayGeneration =
  & Omit<SelectedOverlayGeneration, "journal" | "index" | "reusableSlots" | "knownGenerations">
  & {
    readonly reusableSlots?: readonly (readonly [number, `g${number}`])[];
    readonly knownGenerations?: readonly (readonly [`g${number}`, number])[];
  };

/** What a host entry knows about its persistent `/`, for the freeze. */
export interface PersistentRootSource {
  readonly compactor: LiveOverlayCompactor;
  readonly files: OverlayGenerationFiles;
  readonly imageLength: number;
  readonly imageRead: (offset: number, destination: Uint8Array) => number;
  readonly binding: PersistentImageReadBinding | null;
  readonly slots: () => CheckpointPersistenceSlots | null;
}

const LEGACY_FILES: readonly OverlayGenerationFile[] = ["journal", "activation0", "activation1"];
const SEALED_FILES: readonly OverlayGenerationFile[] = ["journal", "seal", "index"];
const IMAGE_READ_BYTES = 1024 * 1024;

/**
 * Hold compaction off, read what holds still, and hand `capture` the read of
 * what does not.
 *
 * The base image, the seals, the activation records and every other
 * generation change only when a compaction runs, so they are read here, before
 * the freeze, where reading may wait. The live journal and its index change
 * with every kernel write, so `capture` reads them under the freeze, in the
 * same instant as the kernel memory that describes them.
 *
 * `compactionDemand` settles when a syscall at the tail bound waits for the
 * hold. That syscall completes only after a compaction, so its process may
 * never reach the freeze while the hold lasts.
 */
export async function holdPersistentRoot<T>(
  source: PersistentRootSource,
  capture: (readRoot: () => CheckpointPersistentRoot, compactionDemand: Promise<void>) => Promise<T>,
): Promise<T> {
  let demand!: () => void;
  const compactionDemand = new Promise<void>(resolve => { demand = resolve; });
  return source.compactor.whileHeld(async selected => {
    const image = readImage(source);
    const files: OverlayFileBytes[] = [];
    for (const slot of await listedSlots(source.files)) {
      for (const file of slot === "legacy" ? LEGACY_FILES : SEALED_FILES) {
        if (slot === selected.slot && (file === "journal" || file === "index")) continue;
        const storage = await source.files.open(slot, file, false);
        if (storage === null) continue;
        try {
          files.push({ slot, file, bytes: readStorage(storage) });
        } finally {
          storage.close();
        }
      }
    }
    return capture(() => {
      const slots = source.slots();
      if (slots === null) throw new Error("the persistent root has no mounted journal");
      if ((slots.index === null) !== (selected.index === undefined)) {
        throw new Error("the persistent root's index does not match its kernel slots");
      }
      return {
        image,
        binding: source.binding,
        files: [
          ...files,
          { slot: selected.slot, file: "journal", bytes: readStorage(selected.journal) },
          ...(selected.index === undefined
            ? []
            : [{ slot: selected.slot, file: "index" as const, bytes: readStorage(selected.index) }]),
        ],
        generation: describeGeneration(selected),
        slots,
      };
    }, compactionDemand);
  }, demand);
}

/** The receiver's half: what the entry wires a restored persistent `/` with. */
export interface RestoredPersistentRoot {
  readonly files: OverlayGenerationFiles;
  readonly journal: PersistentOverlayStorage;
  readonly index: PersistentOverlayStorage | null;
  readonly compactor: LiveOverlayCompactor;
}

/**
 * Give an adopted kernel the copies of the journal its memory names, and a
 * compactor over them.
 *
 * The copies live in this realm's memory: a replica of a stored computer is
 * not that computer, and nothing it writes reaches this computer's storage.
 * The compactor continues the captured generation, so a replica that writes
 * past the journal's tail bound compacts as its original would, rather than
 * failing a write the original accepted.
 */
export function restorePersistentRoot(
  root: CheckpointPersistentRoot,
  codecs: {
    readonly activationCodec: OverlayActivationCodec;
    readonly sealCodec: OverlaySealCodec;
    readonly metadata: OverlayGenerationMetadata;
  },
  adopt: (journal: PersistentOverlayStorage, index: PersistentOverlayStorage | null, slots: CheckpointPersistenceSlots) => void,
  handoff: OverlayCompactionHandoff,
  onGeneration: (next: SelectedOverlayGeneration) => void,
  onError: (error: unknown) => void,
): RestoredPersistentRoot {
  const files = new MemoryOverlayGenerationFiles(codecs.activationCodec, codecs.sealCodec, codecs.metadata, root.files);
  const { slot, reusableSlots, knownGenerations, ...rest } = root.generation;
  const journal = files.storage(slot, "journal");
  const index = root.slots.index === null ? null : files.storage(slot, "index");
  if (journal === null || (root.slots.index !== null && index === null)) {
    throw new Error("the checkpoint's persistent root is missing its live journal");
  }
  adopt(journal, index, root.slots);
  const selected: SelectedOverlayGeneration = {
    ...rest,
    slot,
    journal,
    ...(index === null ? {} : { index }),
    ...(reusableSlots === undefined ? {} : { reusableSlots: new Map(reusableSlots) }),
    ...(knownGenerations === undefined ? {} : { knownGenerations: new Map(knownGenerations) }),
  };
  const compactor = new LiveOverlayCompactor(selected, files, handoff, onGeneration, onError);
  return { files, journal, index, compactor };
}

/**
 * Refuse a persistent root whose shape a restore cannot adopt.
 *
 * The bytes themselves are as trusted as the kernel memory they belong to:
 * the receiver adopts that memory whole, and the kernel verifies each base
 * block against the geometry it holds. What is checked here is what the host
 * acts on before the kernel runs.
 */
export function validatePersistentRoot(root: CheckpointPersistentRoot): string | null {
  try {
    if (root.binding !== null) snapshotPersistentImageReadBinding(root.binding);
  } catch {
    return "the persistent root's image binding is invalid";
  }
  if (!(root.image instanceof Uint8Array) || root.image.byteLength === 0) {
    return "the persistent root carries no base image";
  }
  const { journal, index } = root.slots;
  if (![0, 1, 2].includes(journal) || (index !== null && ![0, 1, 2].includes(index)) || journal === index) {
    return "the persistent root's kernel slots are invalid";
  }
  const seen = new Set<string>();
  for (const entry of root.files) {
    if (!validSlot(entry.slot) || !(entry.bytes instanceof Uint8Array)
      || !(entry.slot === "legacy" ? LEGACY_FILES : SEALED_FILES).includes(entry.file)) {
      return `the persistent root carries an invalid file ${JSON.stringify(`${entry.slot}.${entry.file}`)}`;
    }
    const key = `${entry.slot}.${entry.file}`;
    if (seen.has(key)) return `the persistent root carries ${key} twice`;
    seen.add(key);
  }
  const slot = root.generation.slot;
  if (!validSlot(slot) || !seen.has(`${slot}.journal`) || (index !== null) !== seen.has(`${slot}.index`)) {
    return "the persistent root's live generation does not match its files";
  }
  return null;
}

/** Every buffer a persistent root owns, for a transfer list. */
export function persistentRootTransferList(root: CheckpointPersistentRoot): ArrayBuffer[] {
  return [root.image.buffer as ArrayBuffer, ...root.files.map(entry => entry.bytes.buffer as ArrayBuffer)];
}

function validSlot(slot: unknown): slot is OverlayGenerationSlot {
  return slot === "legacy" || (typeof slot === "string" && parseSealedGenerationSlot(slot) !== null);
}

async function listedSlots(files: OverlayGenerationFiles): Promise<OverlayGenerationSlot[]> {
  const slots = new Set<OverlayGenerationSlot>(["legacy"]);
  for await (const slot of await files.listSlots()) {
    if (!validSlot(slot)) throw new Error("persistent overlay generation slot is invalid");
    slots.add(slot);
  }
  return [...slots];
}

function readImage(source: PersistentRootSource): Uint8Array {
  const image = new Uint8Array(source.imageLength);
  for (let offset = 0; offset < image.byteLength;) {
    const count = source.imageRead(offset, image.subarray(offset, offset + IMAGE_READ_BYTES));
    if (count <= 0) throw new Error(`the persistent base image ended at ${offset} of ${image.byteLength} bytes`);
    offset += count;
  }
  return image;
}

function readStorage(storage: PersistentOverlayStorage): Uint8Array {
  const bytes = new Uint8Array(storage.len());
  for (let offset = 0; offset < bytes.byteLength; offset += IMAGE_READ_BYTES) {
    storage.readExactAt(offset, bytes.subarray(offset, offset + IMAGE_READ_BYTES));
  }
  return bytes;
}

function describeGeneration(selected: SelectedOverlayGeneration): CheckpointOverlayGeneration {
  const { journal: _journal, index: _index, reusableSlots, knownGenerations, ...rest } = selected;
  return {
    ...rest,
    ...(reusableSlots === undefined ? {} : { reusableSlots: [...reusableSlots] }),
    ...(knownGenerations === undefined ? {} : { knownGenerations: [...knownGenerations] }),
  };
}
