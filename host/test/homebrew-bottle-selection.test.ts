import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  HomebrewBottleDependencyIdentity,
  HomebrewBottleDescriptor,
} from "../src/homebrew-bottle-descriptor";
import {
  encodeHomebrewBottleSelection,
  homebrewBottleSelectionSha256,
  parseCanonicalHomebrewBottleSelection,
  projectHomebrewBottleSelection,
} from "../src/homebrew-bottle-selection";
import { resolveHomebrewVfsResourcePolicy } from "../src/homebrew-vfs-resource-policy";

const PREFIX = "/opt/kandelo/homebrew";
const BOOTSTRAP = "kandelo-dev/tap-core/homebrew-bootstrap";

describe("flat Homebrew bottle selection", () => {
  it("projects one dependency-first ABI-specific bottle closure", () => {
    const selection = projectHomebrewBottleSelection(selectionFixture(), { expectedAbi: 42 });

    expect(selection).toMatchObject({
      schema: 1,
      name: "experimental-abi42-fixture",
      arch: "wasm32",
      kandeloAbi: 42,
      requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      resourcePolicy: "kandelo-homebrew-vfs-generous-v1",
      linkPolicy: "kandelo-homebrew-link-ownership-v1",
      runtimeSupport: "kandelo-homebrew-bootstrap-v1",
    });
    expect(selection.bottles.map(({ name }) => name)).toEqual([
      "homebrew-bootstrap",
      "zlib",
      "ruby",
    ]);
    expect(() => projectHomebrewBottleSelection(selectionFixture(), { expectedAbi: 43 }))
      .toThrow(/expected ABI 43/);
  });

  it("rejects unknown root keys so numeric policy overrides cannot enter the selection", () => {
    for (const override of [
      { maxBottleBytes: 1 },
      { resourceLimits: { maxEntries: 1 } },
      { vfsCapacity: 1 },
    ]) {
      expect(() => projectHomebrewBottleSelection({ ...selectionFixture(), ...override }))
        .toThrow(/unknown or missing fields/);
    }
  });

  it("requires the versioned functional link-ownership policy", () => {
    expect(() => projectHomebrewBottleSelection({
      ...selectionFixture(),
      linkPolicy: "first-selected-wins",
    })).toThrow(/linkPolicy/);
  });

  it("rejects duplicate Formula identities and duplicate Cellar keg paths", () => {
    const fixture = selectionFixture();
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [...fixture.bottles, structuredClone(fixture.bottles[1])],
    })).toThrow(/duplicate Formula identity/);

    const kegCollision = descriptor("zlib", "1.3.1", [], {
      fullName: "another-tap/core/zlib",
      sha256: "4".repeat(64),
    });
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [fixture.bottles[0], fixture.bottles[1], kegCollision, fixture.bottles[2]],
    })).toThrow(/duplicate Cellar keg path/);
  });

  it("rejects mixed architecture, ABI, bottle tag, and layout", () => {
    const fixture = selectionFixture();
    for (const [field, value] of [
      ["arch", "wasm64"],
      ["kandeloAbi", 43],
      ["bottleTag", "wasm64_kandelo"],
      ["layout", "other-layout"],
    ] as const) {
      const changed = structuredClone(fixture);
      (changed.bottles[1] as unknown as Record<string, unknown>)[field] = value;
      if (field === "arch") changed.bottles[1].bottleTag = "wasm64_kandelo";
      expect(() => projectHomebrewBottleSelection(changed)).toThrow();
    }
  });

  it("rejects missing dependency nodes and every form of dependency identity drift", () => {
    const fixture = selectionFixture();
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [fixture.bottles[0], fixture.bottles[2]],
    })).toThrow(/missing dependency/);

    for (const [field, value] of [
      ["fullName", "kandelo-dev/tap-core/missing"],
      ["version", "1.3.2"],
      ["revision", 1],
      ["bottleRebuild", 2],
      ["bottleSha256", "f".repeat(64)],
    ] as const) {
      const changed = structuredClone(fixture);
      (changed.bottles[2].dependencies[0] as unknown as Record<string, unknown>)[field] = value;
      expect(() => projectHomebrewBottleSelection(changed)).toThrow(
        field === "fullName" ? /missing dependency/ : /identity does not match/,
      );
    }
  });

  it("rejects dependency cycles and dependencies listed after their consumer", () => {
    const fixture = selectionFixture();
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [fixture.bottles[0], fixture.bottles[2], fixture.bottles[1]],
    })).toThrow(/listed after its consumer/);

    const alpha = descriptor("alpha", "1.0", [], { sha256: "a".repeat(64) });
    const beta = descriptor("beta", "1.0", [dependency(alpha)], { sha256: "b".repeat(64) });
    alpha.dependencies = [dependency(beta)];
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [fixture.bottles[0], alpha, beta],
    })).toThrow(/dependency cycle/);
  });

  it("rejects dependency arrays not sorted by canonical full name", () => {
    const fixture = selectionFixture();
    const alpha = descriptor("alpha", "1.0", [], { sha256: "a".repeat(64) });
    const zulu = descriptor("zulu", "1.0", [], { sha256: "b".repeat(64) });
    const consumer = descriptor("consumer", "1.0", [dependency(zulu), dependency(alpha)], {
      sha256: "c".repeat(64),
    });

    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [fixture.bottles[0], alpha, zulu, consumer],
    })).toThrow(/dependencies must be sorted/);
  });

  it("requires exactly one canonical Homebrew bootstrap runtime descriptor", () => {
    const fixture = selectionFixture();
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: fixture.bottles.slice(1),
    })).toThrow(/exactly one Homebrew bootstrap/);
    expect(() => projectHomebrewBottleSelection({
      ...fixture,
      bottles: [fixture.bottles[0], structuredClone(fixture.bottles[0]), ...fixture.bottles.slice(1)],
    })).toThrow(/exactly one Homebrew bootstrap/);
  });

  it("requires a safe output basename containing experimental and abi42", () => {
    const fixture = selectionFixture();
    for (const requestedVfsFilename of [
      "kandelo-homebrew-abi42-wasm32.vfs.zst",
      "kandelo-homebrew-experimental-wasm32.vfs.zst",
      "../kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      "subdir/kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
      "kandelo-homebrew-experimental-abi42-wasm32.vfs",
    ]) {
      expect(() => projectHomebrewBottleSelection({ ...fixture, requestedVfsFilename }))
        .toThrow(/requestedVfsFilename/);
    }
  });

  it("preserves bottle order in stable canonical encoding and rejects noncanonical bytes", () => {
    const fixture = selectionFixture();
    const reversed = { ...fixture, bottles: [...fixture.bottles].reverse() };
    expect(() => projectHomebrewBottleSelection(reversed)).toThrow(/listed after its consumer/);

    const selection = projectHomebrewBottleSelection(fixture);
    const encoded = encodeHomebrewBottleSelection(selection);
    const text = new TextDecoder().decode(encoded);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"name":"homebrew-bootstrap"')).toBeLessThan(
      text.indexOf('"name":"zlib"'),
    );
    expect(text.indexOf('"name":"zlib"')).toBeLessThan(text.indexOf('"name":"ruby"'));
    expect(parseCanonicalHomebrewBottleSelection(encoded, { expectedAbi: 42 })).toEqual(selection);
    expect(homebrewBottleSelectionSha256(encoded)).toBe(
      createHash("sha256").update(encoded).digest("hex"),
    );

    for (const changed of [
      new TextEncoder().encode(JSON.stringify(selection)),
      new TextEncoder().encode(`${JSON.stringify(selection, null, 2)}\n`),
      encoded.subarray(0, encoded.byteLength - 1),
      Uint8Array.from([0xff]),
    ]) {
      expect(() => parseCanonicalHomebrewBottleSelection(changed)).toThrow(/canonical|UTF-8|JSON/);
    }
  });

  it("resolves the provisional generic resource policy and rejects unknown IDs", () => {
    expect(resolveHomebrewVfsResourcePolicy("kandelo-homebrew-vfs-generous-v1"))
      .toEqual({
        id: "kandelo-homebrew-vfs-generous-v1",
        bottle: {
          maxCompressedBytes: 256 * 1024 * 1024,
          maxExpandedBytes: 256 * 1024 * 1024,
          maxEntries: 100_000,
          maxPathBytes: 4096,
          maxLinkBytes: 65_536,
        },
        aggregate: {
          maxCompressedBytes: 512 * 1024 * 1024,
          maxExpandedBytes: 512 * 1024 * 1024,
          maxEntries: 100_000,
        },
        supportZip: {
          maxCompressedBytes: 256 * 1024 * 1024,
          maxExpandedBytes: 256 * 1024 * 1024,
          maxEntries: 65_535,
        },
        vfs: { maxByteLength: 768 * 1024 * 1024 },
      });
    expect(() => resolveHomebrewVfsResourcePolicy("ruby-exception"))
      .toThrow(/unknown Homebrew VFS resource policy/);
  });

  it("enforces per-bottle and aggregate compressed-byte policy from descriptors", () => {
    const oversizedBottle = selectionFixture();
    oversizedBottle.bottles[1].bytes = 256 * 1024 * 1024 + 1;
    expect(() => projectHomebrewBottleSelection(oversizedBottle))
      .toThrow(/zlib.*compressed-byte cap/);

    const oversizedAggregate = selectionFixture();
    for (const bottle of oversizedAggregate.bottles) bottle.bytes = 200 * 1024 * 1024;
    expect(() => projectHomebrewBottleSelection(oversizedAggregate))
      .toThrow(/aggregate compressed-byte cap/);
  });

  it("enforces the descriptor-known bootstrap support ZIP byte policy", () => {
    const boundary = selectionFixture();
    boundary.bottles[0].supportOutputs[0]!.bytes = 256 * 1024 * 1024;
    expect(() => projectHomebrewBottleSelection(boundary)).not.toThrow();

    const oversized = selectionFixture();
    oversized.bottles[0].supportOutputs[0]!.bytes = 256 * 1024 * 1024 + 1;
    expect(() => projectHomebrewBottleSelection(oversized))
      .toThrow(/bootstrap support ZIP.*compressed-byte cap/);
  });
});

export function selectionFixture() {
  const bootstrap = descriptor("homebrew-bootstrap", "6.0.12_1", [], {
    fullName: BOOTSTRAP,
    sha256: "1".repeat(64),
    materialization: "homebrew-runtime-support-v1",
  });
  const zlib = descriptor("zlib", "1.3.1", [], { sha256: "2".repeat(64) });
  const ruby = descriptor("ruby", "3.3.6_2", [dependency(zlib)], { sha256: "3".repeat(64) });
  return {
    schema: 1 as const,
    name: "experimental-abi42-fixture",
    arch: "wasm32" as const,
    kandeloAbi: 42,
    bottles: [bootstrap, zlib, ruby],
    requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    resourcePolicy: "kandelo-homebrew-vfs-generous-v1" as const,
    linkPolicy: "kandelo-homebrew-link-ownership-v1" as const,
    runtimeSupport: "kandelo-homebrew-bootstrap-v1" as const,
  };
}

function descriptor(
  name: string,
  version: string,
  dependencies: HomebrewBottleDependencyIdentity[],
  options: {
    fullName?: string;
    sha256: string;
    materialization?: HomebrewBottleDescriptor["materialization"];
  },
): HomebrewBottleDescriptor {
  const fullName = options.fullName ?? `kandelo-dev/tap-core/${name}`;
  const materialization = options.materialization ?? "keg";
  const supportOutputs = materialization === "homebrew-runtime-support-v1"
    ? [
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
    ]
    : [];
  return {
    schema: 1,
    name,
    fullName,
    version,
    revision: 0,
    bottleRebuild: 1,
    arch: "wasm32",
    kandeloAbi: 42,
    bottleTag: "wasm32_kandelo",
    layout: "kandelo-homebrew-v1",
    materialization,
    prefix: PREFIX,
    cellar: `${PREFIX}/Cellar`,
    keg: `${PREFIX}/Cellar/${name}/${version}`,
    payloadRoot: `${name}/${version}`,
    receipts: [
      `Cellar/${name}/${version}/.brew/${name}.rb`,
      `Cellar/${name}/${version}/INSTALL_RECEIPT.json`,
    ],
    links: [],
    pathPrepend: [],
    supportOutputs,
    dependencies,
    url: `https://ghcr.io/v2/kandelo-dev/homebrew/blobs/sha256:${options.sha256}`,
    sha256: options.sha256,
    bytes: 100,
    compression: "gzip",
  };
}

function dependency(descriptor: HomebrewBottleDescriptor): HomebrewBottleDependencyIdentity {
  return {
    fullName: descriptor.fullName,
    version: descriptor.version,
    revision: descriptor.revision,
    bottleRebuild: descriptor.bottleRebuild,
    bottleSha256: descriptor.sha256,
  };
}
