import { verifyOverlayGenerationSeal } from "./overlay-generation-seal";
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
  slot: OverlayGenerationSlot;
}

export async function enableBestOverlayGeneration(
  files: OverlayGenerationFiles,
  enable: (journal: PersistentOverlayStorage) => void,
): Promise<{ journal: PersistentOverlayStorage; slot: OverlayGenerationSlot }> {
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
        candidates.push({ journal, generation: verified.generation, slot });
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
        return { journal: candidate.journal, slot: candidate.slot };
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
      return { journal: legacy, slot: "legacy" };
    } catch (error) {
      legacy.close();
      throw error;
    }
  } finally {
    for (const candidate of candidates) candidate.journal.close();
  }
}
