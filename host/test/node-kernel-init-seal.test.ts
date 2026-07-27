import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
  type LazyAtomicSealForgery,
} from "./lazy-atomic-seal-fixture";

async function forgedRootfs(
  forgery: LazyAtomicSealForgery,
): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  await addSealedLazyAtomicTestTree(fs, {
    groupId: `node-init:${forgery}`,
    member: forgery,
    root: `/sealed-${forgery}`,
  });
  return forgeLazyAtomicSeal(await fs.saveImage(), forgery);
}

describe("NodeKernelHost imported VFS seal boundary", () => {
  it.each(["member", "cohort"] as const)(
    "reports a forged %s seal as init_error before ready",
    async (forgery) => {
      const host = new NodeKernelHost({
        rootfsImage: await forgedRootfs(forgery),
      });
      try {
        // Invalid kernel bytes are deliberate: rootfs authentication must fail
        // before kernel compilation is attempted or readiness can be posted.
        await expect(host.init(new ArrayBuffer(0))).rejects.toThrow(
          /Kernel worker init failed: Lazy atomic activation (member|group)/,
        );
      } finally {
        await host.destroy();
      }
    },
  );
});
