import { verifyOverlayGenerationSeal, writeOverlayGenerationSeal } from "./overlay-generation-seal";
import type { PersistentOverlayStorage } from "./overlay-storage";

export type OverlayGenerationSlot = "legacy" | "g0" | "g1";
export type OverlayGenerationFile = "journal" | "seal";

export interface OverlayGenerationFiles {
  open(
    slot: OverlayGenerationSlot,
    file: OverlayGenerationFile,
    create: boolean,
  ): Promise<PersistentOverlayStorage | null>;
}

interface Candidate {
  journal: PersistentOverlayStorage;
  generation: number;
  sealedLength: number;
  slot: OverlayGenerationSlot;
}

export interface SelectedOverlayGeneration {
  journal: PersistentOverlayStorage;
  slot: OverlayGenerationSlot;
  generation: number;
  sealedLength: number;
}

export async function enableBestOverlayGeneration(
  files: OverlayGenerationFiles,
  enable: (journal: PersistentOverlayStorage) => void,
): Promise<SelectedOverlayGeneration> {
  const candidates: Candidate[] = [];
  let foundGenerationFile = false;
  try {
    for (const slot of ["g0", "g1"] as const) {
      const journal = await files.open(slot, "journal", false);
      let seal: PersistentOverlayStorage | null;
      try {
        seal = await files.open(slot, "seal", false);
      } catch (error) {
        journal?.close();
        throw error;
      }
      foundGenerationFile ||= journal !== null || seal !== null;
      if (journal === null || seal === null) {
        journal?.close();
        seal?.close();
        continue;
      }
      try {
        const verified = await verifyOverlayGenerationSeal(journal, seal, undefined, true);
        candidates.push({ journal, generation: verified.generation, sealedLength: verified.journalLength, slot });
      } catch (error) {
        journal.close();
        if (!(error instanceof Error) || error.message !== "persistent overlay generation seal is invalid") {
          throw error;
        }
      } finally {
        seal.close();
      }
    }
    candidates.sort((left, right) => right.generation - left.generation);
    for (const candidate of candidates) {
      try {
        enable(candidate.journal);
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
    for (const candidate of candidates) candidate.journal.close();
  }
}

export async function compactOverlayGenerationAtBoot(
  selected: SelectedOverlayGeneration,
  files: OverlayGenerationFiles,
  compact: (target: PersistentOverlayStorage) => void,
  minTailBytes = 32 * 1024 * 1024,
): Promise<SelectedOverlayGeneration> {
  if (selected.journal.len() - selected.sealedLength < minTailBytes) return selected;
  if (!Number.isSafeInteger(selected.generation + 1)) {
    throw new Error("persistent overlay generation number exhausted");
  }
  const slot = selected.slot === "g0" ? "g1" : "g0";
  const target = await files.open(slot, "journal", true);
  if (target === null) throw new Error("could not create persistent overlay target journal");
  let seal: PersistentOverlayStorage | null = null;
  try {
    seal = await files.open(slot, "seal", true);
    if (seal === null) throw new Error("could not create persistent overlay target seal");
    const header = new Uint8Array(40);
    selected.journal.readExactAt(0, header);
    target.truncate(0);
    target.flush();
    compact(target);
    const baseDigest = header.slice(8, 40);
    const generation = selected.generation + 1;
    await writeOverlayGenerationSeal(target, seal, generation, baseDigest);
    await verifyOverlayGenerationSeal(target, seal, baseDigest);
    seal.close();
    selected.journal.close();
    return { journal: target, slot, generation, sealedLength: target.len() };
  } catch (error) {
    seal?.close();
    target.close();
    selected.journal.close();
    throw error;
  }
}
