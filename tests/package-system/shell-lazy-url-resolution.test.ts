import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveImageOwnedLazyAsset } from "../../host/src/vfs/vfs-asset-group-reference";
import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../images/vfs/lib/init/shell-binaries";
import { SHELL_LAZY_ARCHIVE_SPECS, SHELL_LAZY_DATA_ARCHIVE_SPECS } from "../../images/vfs/scripts/shell-lazy-archives";

/**
 * Lazy deployment URL closure: every address the rootfs and shell images can
 * DECLARE is one a deployment can SERVE.
 *
 * The deployment does not rewrite the image's lazy addresses, and it keeps no
 * table of them: the kernel worker resolves each address to its package
 * member under the deployment's lazy-asset directory (an asset group in
 * production, the dev server's route in development). So the closure is a
 * property of that rule, checked here for every declared address, with no
 * filesystem.
 */
const DIRECTORY = "https://demo.invalid/a/assets-group/";

/** The package-mirror path a resolver path names; `programs/x` is wasm32. */
function member(resolverPath: string): string {
  return resolverPath.replace(/^programs\/(?!wasm32\/|wasm64\/)/, "programs/wasm32/");
}

function rootfsLazyAddresses(): string[] {
  // Every rootfs output is lazy except those marked eager; each lazy one is
  // recorded as `binaries/<binary>` (images/rootfs/PACKAGES.toml
  // `lazy_url_prefix`).
  const mapping = readFileSync(new URL("../../images/rootfs/PACKAGES.toml", import.meta.url), "utf8");
  const addresses: string[] = [];
  for (const block of mapping.split(/^\[\[packages\]\]$/m).slice(1)) {
    if (/^install\s*=\s*"eager"/m.test(block.split(/^\[\[packages\.outputs\]\]$/m)[0]!)) continue;
    for (const match of block.matchAll(/^\s*binary\s*=\s*"([^"]+)"/gm)) {
      addresses.push(`binaries/${match[1]!}`);
    }
  }
  return addresses;
}

describe("lazy deployment URL closure", () => {
  it("serves every shell lazy file at its package member", () => {
    for (const spec of SHELL_LAZY_BINARY_SPECS) {
      expect(
        resolveImageOwnedLazyAsset(DIRECTORY, shellLazyPlaceholderUrl(spec)),
        `${spec.id} declares ${shellLazyPlaceholderUrl(spec)}`,
      ).toBe(`${DIRECTORY}assets/${member(spec.resolverPath)}`);
    }
  });

  it("serves every shell lazy archive at its package member", () => {
    for (const spec of [...SHELL_LAZY_ARCHIVE_SPECS, ...SHELL_LAZY_DATA_ARCHIVE_SPECS]) {
      expect(
        resolveImageOwnedLazyAsset(DIRECTORY, spec.archiveUrl),
        `${spec.id} declares ${spec.archiveUrl}`,
      ).toBe(`${DIRECTORY}assets/${member(spec.resolverPath)}`);
    }
  });

  it("serves every rootfs lazy output at its package member", () => {
    const addresses = rootfsLazyAddresses();
    expect(addresses).toContain("binaries/programs/wasm32/bash.wasm");
    expect(addresses).not.toContain("binaries/programs/wasm32/login.wasm");
    for (const address of addresses) {
      expect(resolveImageOwnedLazyAsset(DIRECTORY, address), address).toBe(
        `${DIRECTORY}assets/${address.slice("binaries/".length)}`,
      );
    }
  });

  it("leaves addresses outside the grammar to the deployment's base URL", () => {
    for (const unknown of [
      "binaries/programs/wasm32/../escape.wasm",
      "kandelo-lazy:programs/../escape.wasm",
      "not-a-known-archive.zip",
      "vim.zip",
      "kandelo-lazy:programs/wasm32",
      "https://elsewhere.invalid/grep.wasm",
      "",
    ]) {
      expect(resolveImageOwnedLazyAsset(DIRECTORY, unknown), JSON.stringify(unknown))
        .toBeNull();
    }
  });

  it("refuses a directory that is not a plain directory URL", () => {
    for (const directory of [
      "https://demo.invalid/a/assets-group",
      "https://demo.invalid/a/assets-group/?x=1",
      "https://demo.invalid/a/assets-group/#part",
    ]) {
      expect(() => resolveImageOwnedLazyAsset(directory, "kandelo-lazy:programs/vim.zip"), directory)
        .toThrow(/directory is invalid/);
    }
  });
});
