import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { persistentBaseFixture, preparePersistentBaseFixtures } from "./fixtures/persistent-base-image";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { PersistentImageReadBinding } from "../src/vfs/image-integrity";
import { resolveBinary } from "../src/binary-resolver";

const kernelPath = resolveBinary("kernel.wasm");

beforeAll(() => preparePersistentBaseFixtures(), 180_000);

async function boot(path: string, binding: PersistentImageReadBinding, journal: string, requireExisting = false): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({
    rootfsImageFile: path, rootfsPersistentImageBinding: binding,
    experimentalResizablePersistencePath: journal,
    requireExistingRootfsPersistence: requireExisting,
  });
  try {
    const kernel = readFileSync(kernelPath);
    await host.init(kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength) as ArrayBuffer);
    return host;
  } catch (error) {
    await host.destroy();
    throw error;
  }
}

describe("Rust-verified persistent base through a real Node kernel worker", () => {
  it.each(["crc32c", "sha256"] as const)("boots and replays a resizable journal with %s checking", async policy => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-verified-base-"));
    try {
      const { path, binding, content } = await persistentBaseFixture(directory, policy);
      const journal = join(directory, "journal");
      const first = await boot(path, binding, journal);
      try {
        expect(new TextDecoder().decode((await first.readFileFromVfs("/link"))!)).toBe("original");
        expect(await first.readFileFromVfs("/large")).toEqual(content);
        await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640);
      } finally { await first.destroy(); }
      const second = await boot(path, binding, journal, true);
      try {
        expect(new TextDecoder().decode((await second.readFileFromVfs("/link"))!)).toBe("persisted");
        expect(await second.readFileFromVfs("/large")).toEqual(content);
      } finally { await second.destroy(); }
      const wrong = { ...binding, identitySha256: (binding.identitySha256[0] === "0" ? "1" : "0") + binding.identitySha256.slice(1) };
      const savedJournal = readFileSync(journal);
      await expect(boot(path, wrong, journal, true)).rejects.toThrow();
      expect(readFileSync(journal)).toEqual(savedJournal);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 180_000);
});
