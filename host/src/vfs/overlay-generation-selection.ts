import { ERRNO } from "../generated/abi";
import { parseSealedGenerationSlot, verifyOverlayGenerationSeal, verifyOverlayGenerationSealSync, writeOverlayGenerationSealSync, type OverlaySealSource } from "./overlay-generation-seal";
import type { PersistentOverlayStorage } from "./overlay-storage";

export class RejectedOverlayGenerationError extends Error {
  constructor(readonly mode: "fixed" | "resizable", readonly errno: number) {
    super(`kernel refused ${mode} rootfs persistence (errno ${errno})`);
  }
}

class RejectedConvertedTargetError extends Error {
  constructor(readonly cause: RejectedOverlayGenerationError) {
    super(cause.message);
  }
}

export class NoValidOverlayGenerationError extends Error {
  readonly recovery = "no-valid-overlay-generation" as const;

  constructor() {
    super("persistent overlay has no valid journal generation; refusing to reset the computer");
    this.name = "NoValidOverlayGenerationError";
  }
}

export function isNoValidOverlayGenerationError(error: unknown): error is NoValidOverlayGenerationError {
  return error instanceof Error &&
    "recovery" in error && error.recovery === "no-valid-overlay-generation";
}

const COMPACTION_SLOTS = ["g0", "g1", "g2"] as const;
const INITIAL_GENERATION_SLOTS = [...COMPACTION_SLOTS, "g3"] as const;

export type OverlayGenerationSlot = "legacy" | `g${number}`;
export type OverlayGenerationFile = "journal" | "seal" | "index";

export interface OverlayGenerationFiles {
  listSlots(): Promise<string[]>;
  open(
    slot: OverlayGenerationSlot,
    file: OverlayGenerationFile,
    create: boolean,
  ): Promise<PersistentOverlayStorage | null>;
}

interface Candidate {
  journal: PersistentOverlayStorage;
  index?: PersistentOverlayStorage;
  generation: number;
  sealedLength: number;
  slot: SealedGenerationSlot;
  source?: OverlaySealSource;
}

type SealedGenerationSlot = `g${number}`;

async function generationSlots(files: OverlayGenerationFiles): Promise<SealedGenerationSlot[]> {
  const slots = new Set<SealedGenerationSlot>(INITIAL_GENERATION_SLOTS);
  for (const name of await files.listSlots()) {
    const slot = parseSealedGenerationSlot(name);
    if (slot === null) throw new Error("persistent overlay generation slot is invalid");
    slots.add(slot);
  }
  return [...slots].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

function conversionTarget(
  slots: readonly SealedGenerationSlot[],
  candidates: readonly Candidate[],
  reusable: SealedGenerationSlot | undefined,
): SealedGenerationSlot {
  if (reusable !== undefined) return reusable;
  const vacant = slots.find((slot) => !candidates.some((candidate) => candidate.slot === slot));
  if (vacant !== undefined) return vacant;
  const next = Number(slots[slots.length - 1]!.slice(1)) + 1;
  if (!Number.isSafeInteger(next + 1)) throw new Error("persistent overlay generation slots exhausted");
  return `g${next}`;
}

function closeCandidate(candidate: Candidate): void {
  const failures: unknown[] = [];
  for (const storage of [candidate.index, candidate.journal]) {
    try {
      storage?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "persistent overlay generation cleanup failed");
  }
}

export interface SelectedOverlayGeneration {
  journal: PersistentOverlayStorage;
  index?: PersistentOverlayStorage;
  slot: OverlayGenerationSlot;
  generation: number;
  sealedLength: number;
  reusableSlots?: ReadonlyMap<number, SealedGenerationSlot>;
}

function withReusableSlots(
  selected: SelectedOverlayGeneration,
  reusableSlots: ReadonlyMap<number, SealedGenerationSlot>,
): SelectedOverlayGeneration {
  const remaining = new Map([...reusableSlots].filter(([generation, slot]) =>
    generation > selected.generation && slot !== selected.slot));
  return remaining.size === 0 ? selected : { ...selected, reusableSlots: remaining };
}

export interface OverlayCompactionHandoff {
  prepare(target: PersistentOverlayStorage): void;
  checkpoint(index: PersistentOverlayStorage): void;
  activate(): void;
  cancel(): void;
}

async function convertOversizedGeneration(
  files: OverlayGenerationFiles,
  source: PersistentOverlayStorage,
  sourceSlot: OverlayGenerationSlot,
  targetSlot: SealedGenerationSlot,
  sourceGeneration: number,
  enable: (journal: PersistentOverlayStorage, index: PersistentOverlayStorage, checkpointEnd: number) => void,
  convert: (source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => void,
): Promise<SelectedOverlayGeneration> {
  if (!Number.isSafeInteger(sourceGeneration + 1)) {
    throw new Error("persistent overlay generation number exhausted");
  }
  const sourceLength = source.len();
  let target: PersistentOverlayStorage | null = null;
  let index: PersistentOverlayStorage | null = null;
  let seal: PersistentOverlayStorage | null = null;
  let published = false;
  let failure: unknown;
  try {
    target = await files.open(targetSlot, "journal", true);
    index = await files.open(targetSlot, "index", true);
    seal = await files.open(targetSlot, "seal", true);
    if (target === null || index === null || seal === null) {
      throw new Error("could not open persistent overlay conversion files");
    }
    seal.truncate(0);
    seal.flush();
    target.truncate(0);
    target.flush();
    index.truncate(0);
    index.flush();
    convert(source, target, index);
    const header = new Uint8Array(40);
    source.readExactAt(0, header);
    const baseDigest = header.slice(8, 40);
    const generation = sourceGeneration + 1;
    writeOverlayGenerationSealSync(target, seal, generation, baseDigest, index,
      { slot: sourceSlot, journalLength: sourceLength });
    verifyOverlayGenerationSealSync(target, seal, baseDigest, false, index);
    const sealedLength = target.len();
    try {
      enable(target, index, sealedLength);
    } catch (error) {
      if (error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
        throw new RejectedConvertedTargetError(error);
      }
      throw error;
    }
    published = true;
    return { journal: target, index, slot: targetSlot, generation, sealedLength };
  } catch (error) {
    failure = error;
    if (seal !== null && !published) {
      try {
        seal.truncate(0);
        seal.flush();
      } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], "persistent overlay conversion seal cleanup failed");
      }
    }
    throw failure;
  } finally {
    const cleanupFailures: unknown[] = [];
    const close = (storage: PersistentOverlayStorage | null) => {
      try {
        storage?.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    close(seal);
    if (!published) {
      close(index);
      close(target);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
        "persistent overlay legacy conversion cleanup failed",
      );
    }
  }
}

export async function enableBestOverlayGeneration(
  files: OverlayGenerationFiles,
  enable: (journal: PersistentOverlayStorage, index?: PersistentOverlayStorage, checkpointEnd?: number) => void,
  requireExisting = false,
  convertJournal?: (source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => void,
): Promise<SelectedOverlayGeneration> {
  const candidates: Candidate[] = [];
  const reusableSlots = new Map<number, SealedGenerationSlot>();
  let foundGenerationFile = false;
  try {
    const slots = await generationSlots(files);
    for (const slot of slots) {
      const journal = await files.open(slot, "journal", false);
      let seal: PersistentOverlayStorage | null = null;
      let index: PersistentOverlayStorage | null = null;
      try {
        seal = await files.open(slot, "seal", false);
        index = await files.open(slot, "index", false);
      } catch (error) {
        journal?.close();
        seal?.close();
        throw error;
      }
      foundGenerationFile ||= journal !== null || seal !== null || index !== null;
      if (journal === null || seal === null) {
        journal?.close();
        seal?.close();
        index?.close();
        continue;
      }
      try {
        const verified = await verifyOverlayGenerationSeal(journal, seal, undefined, true, index);
        const retainedIndex = verified.indexLength === undefined ? undefined : index ?? undefined;
        if (retainedIndex !== undefined) index = null;
        candidates.push({ journal, index: retainedIndex, generation: verified.generation, sealedLength: verified.journalLength, slot, source: verified.source });
      } catch (error) {
        journal.close();
        if (!(error instanceof Error) || error.message !== "persistent overlay generation seal is invalid") {
          throw error;
        }
      } finally {
        seal.close();
        index?.close();
      }
    }
    if (new Set(candidates.map((candidate) => candidate.generation)).size !== candidates.length) {
      throw new Error("persistent overlay has ambiguous sealed generations; refusing to select one");
    }
    const verifiedCandidates = [...candidates];
    const staleCandidates: Candidate[] = [];
    for (const candidate of verifiedCandidates) {
      if (candidate.source === undefined) continue;
      if (candidate.source.slot === candidate.slot) {
        staleCandidates.push(candidate);
        continue;
      }
      if (candidate.source.slot === "legacy") {
        const source = await files.open("legacy", "journal", false);
        try {
          if (source !== null && source.len() === candidate.source.journalLength) continue;
        } finally {
          source?.close();
        }
      } else {
        const source = verifiedCandidates.find((other) => other.slot === candidate.source?.slot
          && other.generation === candidate.generation - 1);
        if (source === undefined || source.journal.len() === candidate.source.journalLength) continue;
      }
      staleCandidates.push(candidate);
    }
    for (const candidate of staleCandidates) {
      candidates.splice(candidates.indexOf(candidate), 1);
      reusableSlots.set(candidate.generation, candidate.slot);
      candidate.journal.close();
      candidate.index?.close();
    }
    candidates.sort((left, right) => right.generation - left.generation);
    for (const candidate of [...candidates]) {
      try {
        if (candidate.index !== undefined
          && candidate.journal.len() >= 32 * 1024 * 1024 && convertJournal !== undefined) {
          const header = new Uint8Array(8);
          candidate.index.readExactAt(0, header);
          const version = new DataView(header.buffer).getUint32(4, true);
          if (version === 1 || version === 2) {
            const targetSlot = conversionTarget(slots, candidates, reusableSlots.get(candidate.generation + 1));
            try {
              const converted = await convertOversizedGeneration(
                files, candidate.journal, candidate.slot, targetSlot, candidate.generation, enable, convertJournal,
              );
              candidates.splice(candidates.indexOf(candidate), 1);
              closeCandidate(candidate);
              return withReusableSlots(converted, reusableSlots);
            } catch (error) {
              if (!(error instanceof RejectedConvertedTargetError)) throw error;
              enable(candidate.journal, candidate.index, candidate.sealedLength);
              candidates.splice(candidates.indexOf(candidate), 1);
              return withReusableSlots(candidate, reusableSlots);
            }
          }
        }
        enable(candidate.journal, candidate.index, candidate.sealedLength);
        candidates.splice(candidates.indexOf(candidate), 1);
        return withReusableSlots(candidate, reusableSlots);
      } catch (error) {
        if (!(error instanceof RejectedOverlayGenerationError) || error.errno !== ERRNO.EIO) {
          throw error;
        }
        candidates.splice(candidates.indexOf(candidate), 1);
        reusableSlots.set(candidate.generation, candidate.slot);
        closeCandidate(candidate);
      }
    }
    const legacy = await files.open("legacy", "journal", !foundGenerationFile && !requireExisting);
    if (legacy === null) {
      throw new NoValidOverlayGenerationError();
    }
    try {
      const legacyLength = legacy.len();
      if ((foundGenerationFile || requireExisting) && legacyLength === 0) {
        throw new NoValidOverlayGenerationError();
      }
      if (legacyLength >= 32 * 1024 * 1024 && convertJournal !== undefined) {
        let converted: SelectedOverlayGeneration;
        try {
          converted = await convertOversizedGeneration(
            files, legacy, "legacy", reusableSlots.get(1) ?? "g0", 0, enable, convertJournal,
          );
        } catch (error) {
          if (error instanceof RejectedConvertedTargetError) {
            try {
              enable(legacy);
            } catch (sourceError) {
              if (sourceError instanceof RejectedOverlayGenerationError && sourceError.errno === ERRNO.EIO) {
                throw new NoValidOverlayGenerationError();
              }
              throw sourceError;
            }
            return withReusableSlots(
              { journal: legacy, slot: "legacy", generation: 0, sealedLength: 0 }, reusableSlots,
            );
          }
          if (error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
            throw new NoValidOverlayGenerationError();
          }
          throw error;
        }
        legacy.close();
        return withReusableSlots(converted, reusableSlots);
      }
      try {
        enable(legacy);
      } catch (error) {
        if (legacyLength > 0 && error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
          throw new NoValidOverlayGenerationError();
        }
        throw error;
      }
      return withReusableSlots({ journal: legacy, slot: "legacy", generation: 0, sealedLength: 0 }, reusableSlots);
    } catch (error) {
      legacy.close();
      throw error;
    }
  } finally {
    for (const candidate of candidates) {
      candidate.journal.close();
      candidate.index?.close();
    }
  }
}

export async function compactOverlayGeneration(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  handoff: OverlayCompactionHandoff,
  minTailBytes = 32 * 1024 * 1024,
  shouldProceed: () => boolean = () => true,
  reportCleanupFailure: (error: unknown) => void = console.error,
): Promise<SelectedOverlayGeneration> {
  if (selected.journal.len() - selected.sealedLength < minTailBytes) return selected;
  if (!Number.isSafeInteger(selected.generation + 1)) {
    throw new Error("persistent overlay generation number exhausted");
  }
  const ringIndex = COMPACTION_SLOTS.findIndex((candidate) => candidate === selected.slot);
  const slot = selected.reusableSlots?.get(selected.generation + 1)
    ?? (ringIndex < 0 ? "g0" : COMPACTION_SLOTS[(ringIndex + 1) % COMPACTION_SLOTS.length]);
  const target = await files.open(slot, "journal", true);
  if (target === null) throw new Error("could not create persistent overlay target journal");
  let seal: PersistentOverlayStorage | null = null;
  let index: PersistentOverlayStorage | null = null;
  let prepared = false;
  let activated = false;
  let targetTouched = false;
  let sealedLength = 0;
  const closeActivatedStorage = (storage: PersistentOverlayStorage | null | undefined): void => {
    if (storage === null || storage === undefined) return;
    try {
      storage.close();
    } catch (error) {
      try {
        reportCleanupFailure(error);
      } catch (reportError) {
        console.error("persistent overlay compaction cleanup report failed", error, reportError);
      }
    }
  };
  try {
    seal = await files.open(slot, "seal", true);
    if (seal === null) throw new Error("could not create persistent overlay target seal");
    index = await files.open(slot, "index", true);
    if (index === null) throw new Error("could not create persistent overlay target checkpoint");
    if (!shouldProceed()) {
      seal.close();
      index.close();
      target.close();
      return selected;
    }
    const header = new Uint8Array(40);
    selected.journal.readExactAt(0, header);
    targetTouched = true;
    target.truncate(0);
    target.flush();
    index.truncate(0);
    index.flush();
    handoff.prepare(target);
    prepared = true;
    const sourceLength = selected.journal.len();
    handoff.checkpoint(index);
    const baseDigest = header.slice(8, 40);
    const generation = selected.generation + 1;
    writeOverlayGenerationSealSync(target, seal, generation, baseDigest, index,
      { slot: selected.slot, journalLength: sourceLength });
    verifyOverlayGenerationSealSync(target, seal, baseDigest, false, index);
    sealedLength = target.len();
    handoff.activate();
    activated = true;
    prepared = false;
    closeActivatedStorage(seal);
    seal = null;
    closeActivatedStorage(selected.journal);
    closeActivatedStorage(selected.index);
    return withReusableSlots({ journal: target, index, slot, generation, sealedLength }, selected.reusableSlots ?? new Map());
  } catch (error) {
    if (activated && index !== null) {
      reportCleanupFailure(error);
      return withReusableSlots(
        { journal: target, index, slot, generation: selected.generation + 1, sealedLength },
        selected.reusableSlots ?? new Map(),
      );
    }
    let failure: unknown = error;
    const openedSeal = seal;
    const openedIndex = index;
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (cleanupError) {
        failure = new AggregateError([failure, cleanupError], "persistent overlay compaction cleanup failed");
      }
    };
    if (targetTouched && openedSeal !== null) {
      cleanup(() => {
        openedSeal.truncate(0);
        openedSeal.flush();
      });
    }
    if (prepared) cleanup(() => handoff.cancel());
    if (openedSeal !== null) cleanup(() => openedSeal.close());
    if (openedIndex !== null) cleanup(() => openedIndex.close());
    cleanup(() => target.close());
    throw failure;
  }
}

export class LiveOverlayCompactor {
  #selected: SelectedOverlayGeneration;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #stopped = false;
  #retryAfter = 0;

  constructor(
    selected: SelectedOverlayGeneration,
    private readonly files: OverlayGenerationFiles,
    private readonly handoff: OverlayCompactionHandoff,
    private readonly onGeneration: (next: SelectedOverlayGeneration) => void,
    private readonly onError: (error: unknown) => void,
    private readonly minTailBytes = 32 * 1024 * 1024,
  ) {
    this.#selected = selected;
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#timer = setInterval(() => { void this.compactIfNeeded(); }, 2_000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async compactIfNeeded(): Promise<void> {
    if (this.#stopped || this.#running || Date.now() < this.#retryAfter) return;
    this.#running = true;
    const selected = this.#selected;
    try {
      const next = await compactOverlayGeneration(
        selected,
        this.files,
        this.handoff,
        this.minTailBytes,
        () => !this.#stopped && this.#selected === selected,
        this.onError,
      );
      if (next !== selected) {
        this.#selected = next;
        this.onGeneration(next);
      }
    } catch (error) {
      this.#retryAfter = Date.now() + 30_000;
      this.onError(error);
    } finally {
      this.#running = false;
    }
  }
}
