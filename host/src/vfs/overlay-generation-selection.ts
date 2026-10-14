import { verifyOverlayGenerationSeal, verifyOverlayGenerationSealSync, writeOverlayGenerationSealSync } from "./overlay-generation-seal";
import type { PersistentOverlayStorage } from "./overlay-storage";

export type OverlayGenerationSlot = "legacy" | "g0" | "g1";
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
  slot: OverlayGenerationSlot;
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

export async function enableBestOverlayGeneration(
  files: OverlayGenerationFiles,
  enable: (journal: PersistentOverlayStorage, index?: PersistentOverlayStorage, checkpointEnd?: number) => void,
): Promise<SelectedOverlayGeneration> {
  const candidates: Candidate[] = [];
  let foundGenerationFile = false;
  try {
    for (const slot of ["g0", "g1"] as const) {
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
        candidates.push({ journal, index: retainedIndex, generation: verified.generation, sealedLength: verified.journalLength, slot });
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
    candidates.sort((left, right) => right.generation - left.generation);
    for (const candidate of candidates) {
      try {
        enable(candidate.journal, candidate.index, candidate.sealedLength);
        candidates.splice(candidates.indexOf(candidate), 1);
        return candidate;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("kernel refused fixed rootfs persistence")) {
          throw error;
        }
      }
    }
    const legacy = await files.open("legacy", "journal", !foundGenerationFile);
    if (legacy === null) {
      throw new Error("persistent overlay has no valid journal generation; refusing to reset the computer");
    }
    try {
      enable(legacy);
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
  const slot = selected.slot === "g0" ? "g1" : "g0";
  const target = await files.open(slot, "journal", true);
  if (target === null) throw new Error("could not create persistent overlay target journal");
  let seal: PersistentOverlayStorage | null = null;
  let index: PersistentOverlayStorage | null = null;
  let prepared = false;
  let activated = false;
  let targetTouched = false;
  let sealedLength = 0;
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
    handoff.checkpoint(index);
    const baseDigest = header.slice(8, 40);
    const generation = selected.generation + 1;
    writeOverlayGenerationSealSync(target, seal, generation, baseDigest, index);
    verifyOverlayGenerationSealSync(target, seal, baseDigest, false, index);
    sealedLength = target.len();
    handoff.activate();
    activated = true;
    prepared = false;
    seal.close();
    seal = null;
    selected.journal.close();
    selected.index?.close();
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
