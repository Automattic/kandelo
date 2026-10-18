import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { imageOwnedRuntimeUrlTable } from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { tryResolveRootfsArtifact } from "./support/rootfs-artifact";

// The default rootfs as the resolver finds it -- the same image the host
// boots for `rootfsImage: "default"`, not a path of this file's own.
const rootfsImage = tryResolveRootfsArtifact()?.selectedPath;

/**
 * Every address the SHIPPED image records is one this deployment can serve.
 *
 * Nothing rewrites the image: it keeps its canonical addresses and the
 * deployment maps them when it fetches.
 *
 * The product question is the one worth
 * asking: does every canonical rootfs executable actually resolve? The shell,
 * `ps` and `pgrep` are named here because a PHP test harness needs them, and
 * they are still named here for the same reason. The shell is bash: it
 * replaced dash as the only shell, including /bin/sh (#1403), so
 * /usr/bin/dash is no longer a rootfs lazy entry. The two set-user-ID
 * programs are named too, because a deferred file that runs as root is the
 * one whose address most needs to resolve.
 *
 * The image is read with `KandeloImageFs`, the reader that sees an `SDEF`
 * image's deferred half, so the assertions are about real deferred entries.
 */
describe.skipIf(rootfsImage === undefined)("rootfs lazy assets resolve", () => {
  const deferredAddresses = (): string[] => {
    const fs = KandeloImageFs.create();
    fs.loadImage(new Uint8Array(readFileSync(rootfsImage!)));
    const { files } = fs.lazyEntries() as { files: { path: string; uri: string }[] };
    return files.map((f) => f.uri);
  };

  it("maps every address the image records, bash, ps and pgrep included", () => {
    const table = imageOwnedRuntimeUrlTable();
    const addresses = deferredAddresses();
    expect(addresses.length, "the image must carry deferred files").toBeGreaterThan(0);

    const unmapped = addresses.filter((uri) => table[uri] === undefined);
    expect(
      unmapped,
      "every address the image records must be one this deployment serves; "
        + "an address no deployment can serve is a BUILD-time defect",
    ).toEqual([]);

    // Named by path rather than by count, so a rootfs that grows does not
    // quietly stop checking them.
    const fs = KandeloImageFs.create();
    fs.loadImage(new Uint8Array(readFileSync(rootfsImage!)));
    const { files } = fs.lazyEntries() as { files: { path: string; uri: string }[] };
    for (const path of [
      "/usr/bin/bash",
      "/usr/bin/ps",
      "/usr/bin/pgrep",
      "/usr/bin/sudo-lite",
      "/usr/bin/sudo",
    ]) {
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
