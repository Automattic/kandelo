import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomebrewFlatVfsProofEvidence,
  encodeHomebrewFlatVfsProofEvidence,
} from "./homebrew_flat_vfs_proof_evidence";

const TAP_REVISION = "1".repeat(40);
const SELECTION_SHA256 = "2".repeat(64);
const IMAGE_SHA256 = "3".repeat(64);
const REPORT_SHA256 = "4".repeat(64);
const KERNEL_SHA256 = "5".repeat(64);

function validInput(host: "node" | "chromium" = "node") {
  return {
    host,
    tapRevision: TAP_REVISION,
    selectionSha256: SELECTION_SHA256,
    image: { sha256: IMAGE_SHA256, bytes: 31 },
    report: { sha256: REPORT_SHA256, bytes: 37 },
    kernel: { sha256: KERNEL_SHA256, bytes: 41 },
    proof: {
      tapRevision: TAP_REVISION,
      kandeloAbi: 42,
      selectionSha256: SELECTION_SHA256,
      lazyDownloads: [],
    },
  } as const;
}

test("builds the exact deterministic evidence schema for each host", () => {
  for (const host of ["node", "chromium"] as const) {
    const evidence = buildHomebrewFlatVfsProofEvidence(validInput(host));
    assert.deepEqual(evidence, {
      schema: 1,
      kind: "kandelo-homebrew-flat-vfs-proof",
      host,
      arch: "wasm32",
      kandelo_abi: 42,
      tap_revision: TAP_REVISION,
      selection_sha256: SELECTION_SHA256,
      image: { sha256: IMAGE_SHA256, bytes: 31 },
      report: { sha256: REPORT_SHA256, bytes: 37 },
      kernel: { sha256: KERNEL_SHA256, bytes: 41 },
      lazy_downloads: 0,
    });
    assert.equal(
      new TextDecoder().decode(encodeHomebrewFlatVfsProofEvidence(evidence)),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
});

test("rejects mismatched proof identity and any lazy download", () => {
  assert.throws(
    () => buildHomebrewFlatVfsProofEvidence({
      ...validInput(),
      proof: { ...validInput().proof, tapRevision: "6".repeat(40) },
    }),
    /tap revision does not match/,
  );
  assert.throws(
    () => buildHomebrewFlatVfsProofEvidence({
      ...validInput(),
      proof: { ...validInput().proof, kandeloAbi: 41 },
    }),
    /ABI 42/,
  );
  assert.throws(
    () => buildHomebrewFlatVfsProofEvidence({
      ...validInput(),
      proof: { ...validInput().proof, selectionSha256: "7".repeat(64) },
    }),
    /selection SHA-256 does not match/,
  );
  assert.throws(
    () => buildHomebrewFlatVfsProofEvidence({
      ...validInput(),
      proof: {
        ...validInput().proof,
        lazyDownloads: [{ url: "https://example.test/unexpected" }] as never,
      },
    }),
    /lazy downloads/,
  );
});

test("rejects malformed or extended file identities instead of normalizing them", () => {
  for (const image of [
    { sha256: "A".repeat(64), bytes: 31 },
    { sha256: IMAGE_SHA256, bytes: 0 },
    { sha256: IMAGE_SHA256, bytes: 31, path: "/tmp/image" },
  ]) {
    assert.throws(
      () => buildHomebrewFlatVfsProofEvidence({
        ...validInput(),
        image: image as never,
      }),
      /image identity is invalid/,
    );
  }
  assert.throws(
    () => buildHomebrewFlatVfsProofEvidence({
      ...validInput(),
      host: "firefox" as never,
    }),
    /evidence host is invalid/,
  );
});
