import { verifyOverlayGenerationSeal, writeOverlayGenerationSeal } from "./overlay-generation-seal";
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

export async function compactOverlayGenerationAtBoot(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  handoff: OverlayCompactionHandoff,
  minTailBytes = 32 * 1024 * 1024,
): Promise<SelectedOverlayGeneration> {
  if (selected.index !== undefined) return selected;
  if (selected.journal.len() - selected.sealedLength < minTailBytes) return selected;
  if (!Number.isSafeInteger(selected.generation + 1)) {
    throw new Error("persistent overlay generation number exhausted");
  }
  const slot = selected.slot === "g0" ? "g1" : "g0";
  const target = await files.open(slot, "journal", true);
  if (target === null) throw new Error("could not create persistent overlay target journal");
  let seal: PersistentOverlayStorage | null = null;
  let prepared = false;
  let activated = false;
  try {
    seal = await files.open(slot, "seal", true);
    if (seal === null) throw new Error("could not create persistent overlay target seal");
    const header = new Uint8Array(40);
    selected.journal.readExactAt(0, header);
    target.truncate(0);
    target.flush();
    handoff.prepare(target);
    prepared = true;
    const baseDigest = header.slice(8, 40);
    const generation = selected.generation + 1;
    await writeOverlayGenerationSeal(target, seal, generation, baseDigest);
    await verifyOverlayGenerationSeal(target, seal, baseDigest);
    handoff.activate();
    activated = true;
    prepared = false;
    seal.close();
    selected.journal.close();
    return { journal: target, slot, generation, sealedLength: target.len() };
  } catch (error) {
    let failure: unknown = error;
    const openedSeal = seal;
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (cleanupError) {
        failure = new AggregateError([failure, cleanupError], "persistent overlay compaction cleanup failed");
      }
    };
    if (!activated && openedSeal !== null) {
      cleanup(() => {
        openedSeal.truncate(0);
        openedSeal.flush();
      });
    }
    if (prepared) cleanup(() => handoff.cancel());
    if (openedSeal !== null) cleanup(() => openedSeal.close());
    cleanup(() => target.close());
    cleanup(() => selected.journal.close());
    throw failure;
  }
}

export async function checkpointCompactedOverlayGenerationAtBoot(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  checkpoint: (index: PersistentOverlayStorage) => void,
): Promise<SelectedOverlayGeneration> {
  if (selected.slot === "legacy" || selected.index !== undefined) {
    throw new Error("only a newly compacted generation can be checkpointed");
  }
  const index = await files.open(selected.slot, "index", true);
  if (index === null) throw new Error("could not create persistent overlay checkpoint");
  let seal: PersistentOverlayStorage | null = null;
  try {
    seal = await files.open(selected.slot, "seal", false);
    if (seal === null) throw new Error("could not open persistent overlay generation seal");
    const header = new Uint8Array(40);
    selected.journal.readExactAt(0, header);
    index.truncate(0);
    index.flush();
    checkpoint(index);
    const baseDigest = header.slice(8, 40);
    await writeOverlayGenerationSeal(selected.journal, seal, selected.generation, baseDigest, index);
    await verifyOverlayGenerationSeal(selected.journal, seal, baseDigest, false, index);
    seal.close();
    return { ...selected, index, sealedLength: selected.journal.len() };
  } catch (error) {
    seal?.close();
    index.close();
    selected.journal.close();
    throw error;
  }
}
