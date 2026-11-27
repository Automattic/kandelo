import { InvalidOverlayActivationError, type OverlayActivationRecord } from "./overlay-activation-codec";
import { digestOverlayStoragePrefix } from "./overlay-generation-seal";
import type { OverlayGenerationFiles, PersistenceBootReport, SelectedOverlayGeneration } from "./overlay-generation-selection";

export function createRetirementReceipt(files: OverlayGenerationFiles, source: SelectedOverlayGeneration) {
  const digest = (file: SelectedOverlayGeneration["journal"]) => digestOverlayStoragePrefix(files.sealCodec, file, file.len());
  const receipt = files.activationCodec.retirementReceipt(crypto.getRandomValues(new Uint8Array(32)),
    digest(source.journal), source.index && digest(source.index));
  const hash = files.sealCodec.hasher();
  hash.update(receipt);
  return { receipt, nonce: hash.finish() };
}

export async function stageRetirementReceipt(
  files: OverlayGenerationFiles, active: OverlayActivationRecord, seal: Uint8Array, receipt: Uint8Array,
): Promise<void> {
  const target = await files.open(active.slot, "retirement", true);
  if (!target) throw new Error("Cannot stage legacy journal retirement");
  try {
    target.truncate(0);
    target.writeAllAt(0, receipt);
    target.flush();
    if (target.len() !== receipt.length) throw new InvalidOverlayActivationError();
    const saved = new Uint8Array(receipt.length);
    target.readExactAt(0, saved);
    files.activationCodec.retirementDigests(active, seal, saved);
  } finally { target.close(); }
}

/** Called after both controls and the mounted kernel name this volume. Missing
 * files are already retired. Compare everything still present before removing
 * any file, including the appended journal tail beyond a legacy checkpoint. */
export async function finishKifsRetirement(
  files: OverlayGenerationFiles, active: OverlayActivationRecord, seal: Uint8Array, report: PersistenceBootReport,
): Promise<void> {
  const handle = await files.open(active.slot, "retirement", false);
  if (!handle) return;
  let digests;
  try {
    if (handle.len() !== 72 && handle.len() !== 104) throw new InvalidOverlayActivationError();
    const bytes = new Uint8Array(handle.len());
    handle.readExactAt(0, bytes);
    digests = files.activationCodec.retirementDigests(active, seal, bytes);
  } catch (error) {
    if (!(error instanceof InvalidOverlayActivationError)) throw error;
    // A stale or damaged marker confers no authority to erase user data.
    report("Could not verify legacy retirement evidence. Preserved the predecessor files.");
    return;
  } finally { handle.close(); }

  report("Finishing the filesystem upgrade. Checking the previous journal for cleanup.", "Filesystem upgrade");
  const source = files.activationCodec.kifsGenerationSource(active, seal);
  const expected: ["journal" | "index" | "seal", Uint8Array][] = [["journal", digests.journal]];
  if (digests.index) expected.push(["index", digests.index]);
  if (source.slot !== "legacy") expected.push(["seal", source.sealDigest]);
  for (const [kind, digest] of expected) {
    const file = await files.open(source.slot, kind, false);
    if (!file) continue;
    let matches;
    try {
      const observed = digestOverlayStoragePrefix(files.sealCodec, file, file.len());
      matches = observed.every((byte, index) => byte === digest[index]);
    } finally { file.close(); }
    if (!matches) {
      report("Legacy files changed after migration. Preserved the predecessor files.");
      // The authenticated receipt cannot authorize any future deletion of
      // this changed namespace. Avoid hashing it again on ordinary boots.
      await files.remove(active.slot, "retirement");
      return;
    }
  }
  for (const [kind] of expected) await files.remove(source.slot, kind);
  await files.remove(active.slot, "retirement");
}
