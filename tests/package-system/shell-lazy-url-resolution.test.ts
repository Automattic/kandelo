import { describe, expect, it } from "vitest";
import {
  imageOwnedRuntimeUrlMapper,
  imageOwnedRuntimeUrlTable,
} from "../../apps/browser-demos/lib/init/image-owned-runtime-urls";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../images/vfs/lib/init/shell-binaries";
import { SHELL_LAZY_ARCHIVE_SPECS } from "../../images/vfs/scripts/shell-lazy-archives";

/**
 * Shell lazy deployment URL closure: every token the shell image can DECLARE is
 * one a deployment can SERVE.
 *
 * The deployment does not rewrite the image's lazy URLs: a build-time address
 * in the image is the canonical address, and the deployment maps it when it
 * fetches (the image's deferred half belongs to the kernel, so the host does
 * not write it). The closure is therefore asked of the MAPPING, which needs no
 * filesystem and covers every declared token rather than the ones a fixture
 * happened to register.
 */
describe("shell lazy deployment URL closure", () => {
  const AUTHORITY = {
    deploymentBase: "/a/",
    directoryUrl: "https://demo.invalid/a/assets-group/",
    manifestUrl: "https://demo.invalid/a/assets-group/manifest.json",
  };

  it("maps every declared shell token before product boot", () => {
    const table = imageOwnedRuntimeUrlTable();
    for (const spec of SHELL_LAZY_BINARY_SPECS) {
      const token = shellLazyPlaceholderUrl(spec);
      expect(table[token], `${spec.id} declares ${token}, which nothing serves`)
        .toBeTruthy();
    }
    for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
      expect(
        table[spec.archiveUrl],
        `${spec.id} declares ${spec.archiveUrl}, which nothing serves`,
      ).toBeTruthy();
    }
  });

  it("maps them under an asset-group deployment too", () => {
    // The other deployment shape: resolved against a manifest directory rather
    // than read from a build-time table. Both must cover the same tokens, or a
    // demo works in one deployment and not the other.
    const map = imageOwnedRuntimeUrlMapper(AUTHORITY);
    for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
      const member = spec.resolverPath.replace(
        /^programs\/(?!wasm32\/)/,
        "programs/wasm32/",
      );
      expect(map(spec.archiveUrl)).toBe(
        `https://demo.invalid/a/assets-group/assets/${member}`,
      );
    }
  });

  it("rejects unknown build-time file and archive tokens", () => {
    const map = imageOwnedRuntimeUrlMapper(AUTHORITY);
    for (const unknown of [
      "binaries/programs/wasm32/../escape.wasm",
      "kandelo-lazy:programs/../escape.wasm",
      "not-a-known-archive.zip",
      "https://elsewhere.invalid/grep.wasm",
      "",
    ]) {
      expect(() => map(unknown), `${JSON.stringify(unknown)} must be refused`)
        .toThrow();
    }
  });
});
