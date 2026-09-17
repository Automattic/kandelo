import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

/**
 * REPLACES `node-kernel-init-seal.test.ts`, 2026-09-16.
 *
 * That test passed `new ArrayBuffer(0)` as the kernel deliberately, so that
 * "rootfs authentication must fail before kernel compilation is attempted".
 * The ordering it encoded is retired: the kernel authenticates the image now,
 * so it must exist to do it. The trade is recorded in the plan — it is not a
 * trust boundary, and what it changes is WHICH parser meets untrusted bytes
 * first. It used to be a TypeScript filesystem this lane is deleting; it is
 * now the Rust loader that already refuses mismatched ABIs, undescribed
 * archives and unverifiable set-ID bits.
 *
 * What survives is the property that mattered: an image the kernel refuses
 * fails init rather than booting a half-usable machine.
 */
const kernelPath = tryResolveBinary("kernel.wasm");
const haveKernel = kernelPath !== null;

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("NodeKernelHost refuses an image the kernel rejects", () => {
  it.skipIf(!haveKernel)(
    "fails init on an image declaring an ABI this kernel was not built for",
    async () => {
      const fs = KandeloImageFs.create();
      fs.mkdir("/etc", 0o755);
      fs.writeFile("/etc/hostname", new TextEncoder().encode("kandelo\n"), 0o644);
      // An ABI no build of this kernel carries. `check_declared_abi` answers
      // EPROTO, which is the truthful failure for a stale or foreign artifact
      // rather than a best-effort boot of one.
      const image = await fs.saveImage({ metadata: { version: 1, kernelAbi: 7 } });

      const host = new NodeKernelHost({ rootfsImage: image });
      try {
        await expect(
          host.init(asArrayBuffer(new Uint8Array(readFileSync(kernelPath!)))),
        ).rejects.toThrow();
      } finally {
        await host.destroy();
      }
    },
    30_000,
  );

  it.skipIf(!haveKernel)(
    "boots the same tree when the image declares nothing about the ABI",
    async () => {
      // THE NEGATIVE CONTROL. Without it the refusal above could be any
      // failure this fixture happens to produce — an empty `/etc`, a missing
      // init, a kernel that cannot boot a two-entry image — and the test would
      // read as a working gate either way.
      const fs = KandeloImageFs.create();
      fs.mkdir("/etc", 0o755);
      fs.writeFile("/etc/hostname", new TextEncoder().encode("kandelo\n"), 0o644);
      const image = await fs.saveImage();

      const host = new NodeKernelHost({ rootfsImage: image });
      try {
        await host.init(asArrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
        expect(await host.readFileFromVfs("/etc/hostname")).toEqual(
          new TextEncoder().encode("kandelo\n"),
        );
      } finally {
        await host.destroy();
      }
    },
    30_000,
  );
});
