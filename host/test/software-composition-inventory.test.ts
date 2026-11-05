import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { INSTALLED_SOFTWARE, softwarePaths } from "../../images/vfs/scripts/software-inventory";
import { resolveBinary } from "../src/binary-resolver";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../src/constants";
import { ABI_VERSION } from "../src/generated/abi";
import type { BootDescriptor } from "../../web-libs/kandelo-session/src/kernel-host";

vi.mock("../../apps/browser-demos/lib/kernel-owned-boot", async () => ({
  loadPositionedImageWriterModuleBytes: async () => new Uint8Array(readFileSync(new URL("../../local-binaries/kandelo_image_module_positioned32.wasm", import.meta.url))),
}));

import { composeKandeloImage } from "../../apps/browser-demos/pages/kandelo/kernel-host/image-composer";

describe("pristine software ownership through computer composition", () => {
  it("preserves WordPress package ownership while preparing computer-specific settings", async () => {
    const bytes = new Uint8Array(readFileSync(resolveBinary("programs/wasm32/wordpress-family-vfs.vfs.zst")));
    const original = KandeloImageFs.create();
    original.loadImage(bytes);
    const inventory = original.readFile(INSTALLED_SOFTWARE);
    const paths = softwarePaths(original, "wordpress-family");
    const owned = new Set(paths);
    const written = new Set<string>();
    const write = KandeloImageFs.prototype.writeFile;
    const writes = vi.spyOn(KandeloImageFs.prototype, "writeFile").mockImplementation(function (this: KandeloImageFs, path, bytes, mode) {
      if (owned.has(path)) written.add(path);
      return write.call(this, path, bytes, mode);
    });
    const kernel = readFileSync(resolveBinary("kernel.wasm"));
    const programDigest = Buffer.from(readWasmCustomSectionPayload(kernel, ABI_CONTRACT_SECTION)!).toString("hex");
    const create = KandeloImageFs.createPositioned.bind(KandeloImageFs);
    let composed: KandeloImageFs | undefined;
    const spy = vi.spyOn(KandeloImageFs, "createPositioned").mockImplementation((...args) => {
      composed = create(...args);
      return composed;
    });
    const descriptor: BootDescriptor = { version: 1, id: "wordpress-mariadb", title: "WordPress", base: "kandelo:test",
      runtime: { arch: "wasm32", kernel: "kernel@current", memoryPages: 4096, features: [], time: "real" }, packages: [], mounts: [], boot: { argv: ["/bin/sh"] } };
    try {
      await composeKandeloImage({ imageBytes: bytes, maxVfsByteLength: 20 * 1024 ** 3, imageLabel: "WordPress family",
        requestedProfileId: "wordpress-mariadb", requestedProfileSource: "test", hasCandidateEvidence: false, descriptor,
        appPath: "/computer/composition-test/", proto: "https",
        persistentImage: { name: "composition-test", identity: "test", integrityPolicy: "crc32c" } }, () => {}, async chunks => {
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(65536);
      });
      if (!composed) throw new Error("Composer did not create its native image filesystem");
      const actual = composed.buildPackageInventory({ name: "kandelo-wordpress-family", version: "1", programAbi: ABI_VERSION,
        programDigest, paths, parentInventory: inventory });
      const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const changed = [...written].filter(path => digest(original.readFile(path)) !== digest(composed!.readFile(path))).sort();
      expect(changed).toEqual([]);
      expect(digest(actual)).toBe(digest(inventory));
    } finally { spy.mockRestore(); writes.mockRestore(); }
  }, 180_000);
});
