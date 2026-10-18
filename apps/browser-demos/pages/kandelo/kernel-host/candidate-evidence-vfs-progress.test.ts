// Progress reporting for the protected candidate (PR preview) VFS image.
//
// This image is fetched before the kernel exists, exactly like the shipped
// Pages product, so the boot screen needs the same incremental byte counts.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createProtectedCandidatePagesVfsPlacement,
  fetchProtectedCandidateVfs,
  type ProtectedCandidateVfsSource,
} from "./candidate-evidence-vfs.ts";

const image = new TextEncoder().encode("candidate vfs image bytes\n");
const digest = createHash("sha256").update(image).digest("hex");

function source(
  pagesLoad: "eager" | "lazy" | null = "lazy",
): ProtectedCandidateVfsSource {
  return {
    schema: 1,
    kind: "kandelo-protected-candidate-vfs",
    productId: "browser-shell",
    profile: "shell",
    pagesLoad,
    sourceKind: "protected-local-candidate-vfs",
    url: "http://127.0.0.1:4173/candidate/browser-shell/product.vfs.zst",
    sha256: digest,
    bytes: image.byteLength,
  };
}

/** A streaming response delivering `image` in fixed-size slices. */
function streamed(sliceBytes: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < image.byteLength; at += sliceBytes) {
        controller.enqueue(image.subarray(at, at + sliceBytes));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

test("reports cumulative candidate image progress against its declared size", async () => {
  const seen: Array<{ loadedBytes: number; totalBytes: number }> = [];

  const bytes = await fetchProtectedCandidateVfs(
    source(),
    async () => streamed(7),
    (loadedBytes, totalBytes) => seen.push({ loadedBytes, totalBytes }),
  );

  assert.deepEqual(new Uint8Array(bytes), image);
  assert.ok(seen.length > 1, "expected more than one progress report");
  assert.ok(seen.every((p) => p.totalBytes === image.byteLength));
  assert.equal(seen.at(-1)?.loadedBytes, image.byteLength);
});

test("still rejects a candidate image whose digest differs", async () => {
  await assert.rejects(
    fetchProtectedCandidateVfs({ ...source(), sha256: "0".repeat(64) },
      async () => streamed(7)),
    /digest differs/i,
  );
});

test("still rejects a candidate image whose length differs", async () => {
  await assert.rejects(
    fetchProtectedCandidateVfs({ ...source(), bytes: image.byteLength + 1 },
      async () => streamed(7)),
    /received length differs|byte count differs/i,
  );
});

test("replays the placement's progress to a late subscriber", async () => {
  // An eager candidate starts loading at construction, before the boot screen
  // has any chance to subscribe.
  const placement = createProtectedCandidatePagesVfsPlacement(
    source("eager"),
    async (_source, onProgress) => {
      onProgress?.(image.byteLength, image.byteLength);
      return image.slice().buffer;
    },
  );

  await placement.activate();
  const seen: Array<{ status: string; loadedBytes: number }> = [];
  placement.subscribeProgress((progress) =>
    seen.push({ status: progress.status, loadedBytes: progress.loadedBytes })
  );

  assert.deepEqual(seen, [
    { status: "complete", loadedBytes: image.byteLength },
  ]);
});

test("reports a failed candidate image load as an error record", async () => {
  const placement = createProtectedCandidatePagesVfsPlacement(
    source(),
    async () => {
      throw new Error("candidate VFS fetch failed with status 503");
    },
  );
  const seen: Array<{ status: string; error?: string }> = [];
  placement.subscribeProgress((progress) =>
    seen.push({ status: progress.status, error: progress.error })
  );

  await assert.rejects(placement.activate());

  assert.equal(seen.at(-1)?.status, "error");
  assert.match(seen.at(-1)?.error ?? "", /503/);
});
