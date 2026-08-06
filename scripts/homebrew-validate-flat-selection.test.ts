import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  encodeHomebrewBottleSelection,
  projectHomebrewBottleSelection,
} from "../host/src/homebrew-bottle-selection";
import { runHomebrewFlatSelectionValidator } from "./homebrew-validate-flat-selection";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("flat Homebrew selection validator CLI", () => {
  it("reports the canonical selection digest, compressed-byte sum, and count without rewriting", () => {
    const root = temporaryRoot();
    const path = join(root, "selection.json");
    const bytes = encodeHomebrewBottleSelection(projectHomebrewBottleSelection(selectionFixture()));
    writeFileSync(path, bytes);
    const output: string[] = [];

    runHomebrewFlatSelectionValidator(
      ["--selection", path, "--expected-abi", "42"],
      (line) => output.push(line),
    );

    expect(output).toEqual([JSON.stringify({
      selectionSha256: createHash("sha256").update(bytes).digest("hex"),
      compressedBytes: 100,
      descriptorCount: 1,
    })]);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  });

  it("rejects noncanonical selections and an expected ABI mismatch", () => {
    const root = temporaryRoot();
    const path = join(root, "selection.json");
    const selection = projectHomebrewBottleSelection(selectionFixture());
    writeFileSync(path, `${JSON.stringify(selection, null, 2)}\n`);
    expect(() => runHomebrewFlatSelectionValidator(["--selection", path], () => {}))
      .toThrow(/canonical/);

    writeFileSync(path, encodeHomebrewBottleSelection(selection));
    expect(() => runHomebrewFlatSelectionValidator(
      ["--selection", path, "--expected-abi", "43"],
      () => {},
    )).toThrow(/expected ABI 43/);
  });

  it("reads only one bounded nonempty regular selection file", () => {
    const root = temporaryRoot();
    const real = join(root, "real.json");
    const link = join(root, "link.json");
    writeFileSync(real, encodeHomebrewBottleSelection(
      projectHomebrewBottleSelection(selectionFixture()),
    ));
    symlinkSync(real, link);
    expect(() => runHomebrewFlatSelectionValidator(["--selection", link], () => {}))
      .toThrow(/bounded nonempty regular file/);
    expect(() => runHomebrewFlatSelectionValidator(["--selection", root], () => {}))
      .toThrow(/bounded nonempty regular file/);

    const empty = join(root, "empty.json");
    writeFileSync(empty, "");
    expect(() => runHomebrewFlatSelectionValidator(["--selection", empty], () => {}))
      .toThrow(/bounded nonempty regular file/);

    const large = join(root, "large.json");
    writeFileSync(large, "x");
    truncateSync(large, 16 * 1024 * 1024 + 1);
    expect(lstatSync(large).size).toBe(16 * 1024 * 1024 + 1);
    expect(() => runHomebrewFlatSelectionValidator(["--selection", large], () => {}))
      .toThrow(/bounded nonempty regular file/);
  });

  it("rejects missing, duplicate, unknown, and malformed arguments", () => {
    for (const args of [
      [],
      ["--selection", "one", "--selection", "two"],
      ["--selection", "one", "--unknown", "value"],
      ["--selection", "one", "--expected-abi", "0"],
      ["--selection", "one", "--expected-abi", "42.5"],
    ]) {
      expect(() => runHomebrewFlatSelectionValidator(args, () => {})).toThrow(/usage/);
    }
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "homebrew-flat-selection-"));
  roots.push(root);
  return root;
}

function selectionFixture() {
  const prefix = "/opt/kandelo/homebrew";
  const name = "homebrew-bootstrap";
  const version = "6.0.12_1";
  const sha256 = "1".repeat(64);
  return {
    schema: 1 as const,
    name: "experimental-abi42-fixture",
    arch: "wasm32" as const,
    kandeloAbi: 42,
    bottles: [{
      schema: 1 as const,
      name,
      fullName: "kandelo-dev/tap-core/homebrew-bootstrap",
      version,
      revision: 0,
      bottleRebuild: 1,
      arch: "wasm32" as const,
      kandeloAbi: 42,
      bottleTag: "wasm32_kandelo",
      layout: "kandelo-homebrew-v1" as const,
      materialization: "homebrew-runtime-support-v1" as const,
      prefix,
      cellar: `${prefix}/Cellar`,
      keg: `${prefix}/Cellar/${name}/${version}`,
      payloadRoot: `${name}/${version}`,
      receipts: [
        `Cellar/${name}/${version}/.brew/${name}.rb`,
        `Cellar/${name}/${version}/INSTALL_RECEIPT.json`,
      ],
      links: [],
      pathPrepend: [],
      supportOutputs: [
        {
          name: "homebrew-bootstrap",
          kegRelativePath: "libexec/homebrew-bootstrap.zip",
          sha256: "d".repeat(64),
          bytes: 10,
        },
        {
          name: "homebrew-brew",
          kegRelativePath: "libexec/homebrew-brew.env",
          sha256: "e".repeat(64),
          bytes: 20,
        },
      ],
      dependencies: [],
      url: `https://ghcr.io/v2/kandelo-dev/homebrew/blobs/sha256:${sha256}`,
      sha256,
      bytes: 100,
      compression: "gzip" as const,
    }],
    requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    resourcePolicy: "kandelo-homebrew-vfs-generous-v1" as const,
    runtimeSupport: "kandelo-homebrew-bootstrap-v1" as const,
  };
}
