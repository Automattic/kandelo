import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";

const prefix = process.env.KANDELO_LARGE_CHECKED_BASE_PREFIX;
const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));

for (const policy of ["crc32c", "sha256"] as const) {
  describe(`${policy} checked image wider than wasm32 memory`, () => {
    it.skipIf(prefix === undefined)("reads high-word payloads and recovers guest tail overwrites within a 768 MiB kernel", async () => {
      const fixture = JSON.parse(readFileSync(`${prefix}-${policy}.img.json`, "utf8")) as {
        path: string; identitySha256: string; integrityPolicy: string; physicalLength: number;
        largeBytes: number; logicalOffset: number; marker: number[];
      };
      expect(fixture.integrityPolicy).toBe(policy);
      expect(fixture.identitySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.physicalLength).toBeGreaterThan(2 ** 32);
      expect(fixture.logicalOffset).toBeGreaterThan(2 ** 32);
      expect(statSync(fixture.path).size).toBe(fixture.physicalLength);
      expect(statSync(fixture.path).blocks * 512).toBeLessThanOrEqual(512 * 1024 * 1024);
      const directory = mkdtempSync(join(tmpdir(), "kandelo-large-checked-"));
      const marker = new Uint8Array(fixture.marker);
      const program = readFileSync(resolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm"));
      const tailOffset = fixture.largeBytes - 2 * 1024 * 1024 - 13;
      const tailMarker = Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff);
      const pages: number[] = [];
      const boot = async (existing: boolean) => {
        const host = new NodeKernelHost({ rootfsImageFile: fixture.path,
          rootfsPersistentImageBinding: { identitySha256: fixture.identitySha256, dataCachePages: 2, indexCachePages: 2 },
          experimentalResizablePersistencePath: join(directory, "journal"), requireExistingRootfsPersistence: existing,
          kernelMaxPages: 12288, maxPages: 1024, maxWorkers: 1 });
        try { await host.init(kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) as ArrayBuffer); }
        catch (error) { await host.destroy(); throw error; }
        return host;
      };
      try {
        const first = await boot(false);
        try {
          expect((await first.statVfsPath("/large"))?.size).toBe(fixture.largeBytes);
          expect(await first.readFileRangeFromVfs("/large", fixture.logicalOffset, marker.length)).toEqual(marker);
          expect(await first.readFileRangeFromVfs("/large", fixture.logicalOffset % (2 ** 32), marker.length)).not.toEqual(marker);
          await first.writeFileToVfs("/probe", program, 0o755);
          const written = await first.spawnFromVfs("/probe", ["persistence-overwrite", "large-tail"]);
          expect(await written.exit).toBe(0);
          expect(await first.readFileRangeFromVfs("/large", tailOffset, tailMarker.length)).toEqual(tailMarker);
          await first.writeFileToVfs("/proof", new TextEncoder().encode("namespace survived"), 0o640);
          pages.push(await first.getKernelMemoryPages());
        } finally { await first.destroy(); }
        expect(first.getPersistenceShutdownFailure()).toBeNull();
        const reopened = await boot(true);
        try {
          expect(await reopened.readFileRangeFromVfs("/large", fixture.logicalOffset, marker.length)).toEqual(marker);
          const verified = await reopened.spawnFromVfs("/probe", ["persistence-overwrite", "verify-large-tail"]);
          expect(await verified.exit).toBe(0);
          expect(await reopened.readFileRangeFromVfs("/large", tailOffset, tailMarker.length)).toEqual(tailMarker);
          expect(new TextDecoder().decode((await reopened.readFileFromVfs("/proof"))!)).toBe("namespace survived");
          pages.push(await reopened.getKernelMemoryPages());
        } finally { await reopened.destroy(); }
        expect(reopened.getPersistenceShutdownFailure()).toBeNull();
        expect(pages.every(count => count <= 12288)).toBe(true);
        console.log("large checked image kernel pages", JSON.stringify({ policy, physicalLength: fixture.physicalLength, pages }));
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 300_000);
  });
}
