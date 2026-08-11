import { expect, test } from "@playwright/test";

import {
  validateHomebrewFlatVfsShippingProofRequest,
} from "../pages/homebrew-vfs-test/flat-vfs-shipping-request";

const KERNEL_SHA256 = "1".repeat(64);
const IMAGE_SHA256 = "2".repeat(64);

function request() {
  return {
    allowLiveNetwork: true as const,
    vfsUrl: "/artifacts/candidate.vfs.zst",
    expectedImageSha256: IMAGE_SHA256,
    expectedKernelSha256: KERNEL_SHA256,
    shellPath: "/bin/bash",
    shellArgv0: "bash",
    tapRevision: "3".repeat(40),
    timeoutMs: 1_000,
  };
}

test("accepts an exact same-origin image and the actual kernel identity", () => {
  const validated = validateHomebrewFlatVfsShippingProofRequest(
    request(),
    {
      locationHref: "https://kandelo.test/pages/homebrew-vfs-test/",
      actualKernelSha256: KERNEL_SHA256,
    },
  );
  expect(validated.vfsUrl.href).toBe(
    "https://kandelo.test/artifacts/candidate.vfs.zst",
  );
});

test("rejects a requested kernel that differs from the fetched kernel", () => {
  expect(() => validateHomebrewFlatVfsShippingProofRequest(
    request(),
    {
      locationHref: "https://kandelo.test/pages/homebrew-vfs-test/",
      actualKernelSha256: "4".repeat(64),
    },
  )).toThrow(/requested kernel SHA-256 does not match/);
});

test("rejects malformed image identity and cross-origin VFS input", () => {
  expect(() => validateHomebrewFlatVfsShippingProofRequest(
    { ...request(), expectedImageSha256: "A".repeat(64) },
    {
      locationHref: "https://kandelo.test/pages/homebrew-vfs-test/",
      actualKernelSha256: KERNEL_SHA256,
    },
  )).toThrow(/image SHA-256 is invalid/);
  expect(() => validateHomebrewFlatVfsShippingProofRequest(
    { ...request(), vfsUrl: "https://other.test/candidate.vfs.zst" },
    {
      locationHref: "https://kandelo.test/pages/homebrew-vfs-test/",
      actualKernelSha256: KERNEL_SHA256,
    },
  )).toThrow(/image URL is invalid/);
});
