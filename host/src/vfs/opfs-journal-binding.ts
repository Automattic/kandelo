import { bytesToHex } from "@noble/hashes/utils.js";
import { browserPersistenceDirectory } from "../browser-computer-storage";
import { ERRNO } from "../generated/abi";
import { InvalidOverlayActivationError, KIFS_GENERATION_SEAL_BYTES,
  OVERLAY_ACTIVATION_BYTES, type OverlayActivationCodec } from "./overlay-activation-codec";
import { selectOverlayActivationReplicas } from "./overlay-generation-activation";
import { parseSealedGenerationSlot } from "./overlay-generation-seal";
import { InvalidOverlaySealError, OVERLAY_DIGEST_CHUNK_BYTES, type OverlaySealCodec } from "./overlay-seal-codec";

/** Manifest preflight on file snapshots. The shared mount verifies the selected
 * volume and opens it for writes under the computer lease. */
export async function inspectOpfsJournalBinding(
  name: string, expectedBase: string, activation: OverlayActivationCodec, openLegacyCodec: () => OverlaySealCodec,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new Error("Invalid persistent journal namespace");
  const directory = await browserPersistenceDirectory(name);
  async function snapshot(suffix: string): Promise<File | null> {
    try { return await (await directory.getFileHandle(name + "." + suffix)).getFile(); }
    catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  const copies = await Promise.all(["activation0", "activation1"].map(async suffix => {
    const file = await snapshot(suffix);
    if (!file || file.size === 0) return null;
    if (file.size !== OVERLAY_ACTIVATION_BYTES) return Uint8Array.of(0);
    return new Uint8Array(await file.arrayBuffer());
  }));
  const { current } = selectOverlayActivationReplicas(activation, copies);
  if (current !== null && bytesToHex(current.baseDigest) !== expectedBase) throw new InvalidOverlayActivationError();
  if (current === null) {
    for (const slot of ["g0", "g1"]) {
      if (await snapshot(slot + ".volume-seal") || await snapshot(slot + ".volume") || await snapshot(slot + ".retirement")) {
        // An upgrade first anchors its predecessor. Missing controls with
        // upgrade files present cannot prove the initialized outer binding.
        throw new InvalidOverlayActivationError();
      }
    }
  }
  if (current !== null && current.slot !== "legacy") {
    const marker = await snapshot(current.slot + ".volume-seal");
    if (marker?.size === KIFS_GENERATION_SEAL_BYTES) {
      const seal = new Uint8Array(await marker.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seal));
      if (digest.every((byte, index) => byte === current.sealDigest[index])) {
        activation.kifsGenerationSource(current, seal);
        if (!(await snapshot(current.slot + ".volume"))?.size) throw new InvalidOverlayActivationError();
        return;
      }
    }
  }

  const legacy = openLegacyCodec();
  const headerBytes = legacy.journalHeaderLength();
  async function matches(suffix: string): Promise<boolean> {
    const journal = await snapshot(suffix);
    if (!journal || journal.size < headerBytes) return false;
    const header = new Uint8Array(await journal.slice(0, headerBytes).arrayBuffer());
    try { return bytesToHex(legacy.journalBaseDigest(header)) === expectedBase; }
    catch (error) {
      if (error instanceof InvalidOverlaySealError) return false;
      throw error;
    }
  }
  if (current !== null) {
    if (current.slot !== "legacy") {
      // A legacy checkpoint and KIFS staging files can share a numbered
      // slot. Require the actual checkpoint seal named by the controls
      // before accepting its journal as evidence for a manifest repair.
      const seal = await snapshot(current.slot + ".seal");
      if (!seal || seal.size < 8) throw new InvalidOverlayActivationError();
      const prefix = new Uint8Array(await seal.slice(0, 8).arrayBuffer());
      const header = new Uint8Array(await seal.slice(0, legacy.headerLength(prefix)).arrayBuffer());
      if (legacy.layout(header).totalBytes !== seal.size) throw new InvalidOverlayActivationError();
      const hash = legacy.hasher();
      for (let offset = 0; offset < seal.size; offset += OVERLAY_DIGEST_CHUNK_BYTES) {
        hash.update(new Uint8Array(await seal.slice(offset, offset + OVERLAY_DIGEST_CHUNK_BYTES).arrayBuffer()));
      }
      if (!hash.finish().every((byte, index) => byte === current.sealDigest[index])) throw new InvalidOverlayActivationError();
    }
    const journal = current.slot === "legacy" ? "journal" : current.slot + ".journal";
    if (!await matches(journal)) throw new InvalidOverlayActivationError();
    return;
  }
  if (await matches("journal")) return;
  // Before activation records existed, a saved computer could contain only a
  // sealed numbered journal. Preserve discovery for those unanchored images.
  for await (const entry of directory.keys()) {
    if (!entry.startsWith(name + ".") || !entry.endsWith(".journal")) continue;
    const suffix = entry.slice(name.length + 1);
    if (parseSealedGenerationSlot(suffix.slice(0, -".journal".length)) !== null && await matches(suffix)) return;
  }
  throw Object.assign(new Error("Persistent journal does not belong to this image or is not initialized"), { errno: ERRNO.EIO });
}
