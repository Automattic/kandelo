import { ERRNO } from "../generated/abi";
import { verifyOverlayGenerationSeal, verifyOverlayGenerationSealSync, writeOverlayGenerationSealSync, type OverlaySealSource } from "./overlay-generation-seal";
import type { PersistentOverlayStorage } from "./overlay-storage";

export class RejectedOverlayGenerationError extends Error {
  constructor(readonly mode: "fixed" | "resizable", readonly errno: number) {
    super(`kernel refused ${mode} rootfs persistence (errno ${errno})`);
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

const GENERATION_SLOTS = ["g0", "g1", "g2"] as const;

export type OverlayGenerationSlot = "legacy" | (typeof GENERATION_SLOTS)[number];
export type OverlayGenerationFile = "journal" | "seal" | "index";

export interface OverlayGenerationFiles {
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
  slot: (typeof GENERATION_SLOTS)[number];
  source?: OverlaySealSource;
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
  targetSlot: (typeof GENERATION_SLOTS)[number],
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
    enable(target, index, sealedLength);
    published = true;
    return { journal: target, index, slot: targetSlot, generation, sealedLength };
  } catch (error) {
    failure = error;
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
  let foundGenerationFile = false;
  try {
    for (const slot of GENERATION_SLOTS) {
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
      candidate.journal.close();
      candidate.index?.close();
    }
    candidates.sort((left, right) => right.generation - left.generation);
    for (const candidate of [...candidates]) {
      try {
        if (candidates.length < GENERATION_SLOTS.length && candidate.index !== undefined
          && candidate.journal.len() >= 32 * 1024 * 1024 && convertJournal !== undefined) {
          const header = new Uint8Array(8);
          candidate.index.readExactAt(0, header);
          const version = new DataView(header.buffer).getUint32(4, true);
          if (version === 1 || version === 2) {
            const targetSlot = GENERATION_SLOTS.find((slot) => !candidates.some((other) => other.slot === slot));
            if (targetSlot === undefined) throw new Error("persistent overlay conversion has no safe target slot");
            const converted = await convertOversizedGeneration(
              files, candidate.journal, candidate.slot, targetSlot, candidate.generation, enable, convertJournal,
            );
            candidates.splice(candidates.indexOf(candidate), 1);
            closeCandidate(candidate);
            return converted;
          }
        }
        enable(candidate.journal, candidate.index, candidate.sealedLength);
        candidates.splice(candidates.indexOf(candidate), 1);
        return candidate;
      } catch (error) {
        if (!(error instanceof RejectedOverlayGenerationError) || error.errno !== ERRNO.EIO) {
          throw error;
        }
        candidates.splice(candidates.indexOf(candidate), 1);
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
            files, legacy, "legacy", "g0", 0, enable, convertJournal,
          );
        } catch (error) {
          if (error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
            throw new NoValidOverlayGenerationError();
          }
          throw error;
        }
        legacy.close();
        return converted;
      }
      try {
        enable(legacy);
      } catch (error) {
        if (legacyLength > 0 && error instanceof RejectedOverlayGenerationError && error.errno === ERRNO.EIO) {
          throw new NoValidOverlayGenerationError();
        }
        throw error;
      }
      return { journal: legacy, slot: "legacy", generation: 0, sealedLength: 0 };
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
  const slot = selected.slot === "legacy" ? "g0"
    : GENERATION_SLOTS[(GENERATION_SLOTS.indexOf(selected.slot) + 1) % GENERATION_SLOTS.length];
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
    return { journal: target, index, slot, generation, sealedLength };
  } catch (error) {
    if (activated && index !== null) {
      reportCleanupFailure(error);
      return { journal: target, index, slot, generation: selected.generation + 1, sealedLength };
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
