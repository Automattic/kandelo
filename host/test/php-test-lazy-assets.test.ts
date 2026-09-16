import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { imageOwnedRuntimeUrlTable } from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";
import { SffsImageFs } from "../../images/vfs/lib/sffs-image-fs";

const repoRoot = resolve(import.meta.dirname, "../..");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs");

/**
 * Every address the SHIPPED image records is one this deployment can serve.
 *
 * This used to ask a different question: it loaded the image, read the lazy
 * URLs out of it, rewrote them, and checked none still began with `binaries/`.
 * That question died with the rewriting — the image keeps its canonical
 * addresses now and the deployment maps them when it fetches (defect B45: the
 * rewriting was a host-side write to the image's deferred half, which the
 * legacy writer silently erased).
 *
 * The product question underneath it did NOT die, and it is the one worth
 * asking: does every canonical rootfs executable actually resolve? `dash`, `ps`
 * and `pgrep` were named here because a PHP test harness needs them, and they
 * are still named here for the same reason.
 *
 * It is also a better test than the one it replaces, because it reads the image
 * with the reader that can SEE its deferred half. The old one used
 * `MemoryFileSystem`, which reports zero deferred files for an `SDEF` image —
 * so after the migration it was asserting against an empty list and could only
 * fail, never catch anything.
 */
describe.skipIf(!existsSync(rootfsImage))("rootfs lazy assets resolve", () => {
  const deferredAddresses = (): string[] => {
    const fs = SffsImageFs.create();
    fs.loadImage(new Uint8Array(readFileSync(rootfsImage)));
    const { files } = fs.lazyEntries() as { files: { path: string; uri: string }[] };
    return files.map((f) => f.uri);
  };

  it("maps every address the image records, dash, ps and pgrep included", () => {
    const table = imageOwnedRuntimeUrlTable();
    const addresses = deferredAddresses();
    expect(addresses.length, "the image must carry deferred files").toBeGreaterThan(0);

    const unmapped = addresses.filter((uri) => table[uri] === undefined);
    expect(
      unmapped,
      "every address the image records must be one this deployment serves; "
        + "an address no deployment can serve is a BUILD-time defect",
    ).toEqual([]);

    // The three this file has always named, by path rather than by count, so a
    // rootfs that grows does not quietly stop checking them.
    const fs = SffsImageFs.create();
    fs.loadImage(new Uint8Array(readFileSync(rootfsImage)));
    const { files } = fs.lazyEntries() as { files: { path: string; uri: string }[] };
    for (const path of ["/usr/bin/dash", "/usr/bin/ps", "/usr/bin/pgrep"]) {
      const entry = files.find((f) => f.path === path);
      expect(entry, `${path} must be a deferred file in the shipped image`).toBeDefined();
      expect(table[entry!.uri], `${path} must resolve for this deployment`).toBeTruthy();
    }
  });

  it("maps to somewhere other than the address itself, or nothing was deployed", () => {
    const table = imageOwnedRuntimeUrlTable();
    for (const uri of deferredAddresses()) {
      // The whole point of the table is that a build-time reference becomes a
      // served asset URL. A mapping to the identical string would pass the
      // check above while serving nothing.
      expect(table[uri], `${uri} maps to itself`).not.toBe(uri);
    }
  });
});
