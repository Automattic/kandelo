import { describe, expect, it, vi } from "vitest";
import { ABI_VERSION } from "../src/generated/abi";
import {
  encodeHomebrewBottleDescriptor,
  HomebrewBottleDescriptorError,
  projectHomebrewBottleDescriptor,
} from "../src/homebrew-bottle-descriptor";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    name: "bzip2",
    fullName: "kandelo-dev/tap-core/bzip2",
    version: "1.0.8",
    revision: 0,
    bottleRebuild: 0,
    arch: "wasm32",
    kandeloAbi: ABI_VERSION,
    bottleTag: "wasm32_kandelo",
    layout: "kandelo-homebrew-v1",
    materialization: "keg",
    prefix: "/opt/kandelo/homebrew",
    cellar: "/opt/kandelo/homebrew/Cellar",
    keg: "/opt/kandelo/homebrew/Cellar/bzip2/1.0.8",
    payloadRoot: "bzip2/1.0.8",
    receipts: [
      "Cellar/bzip2/1.0.8/.brew/bzip2.rb",
      "Cellar/bzip2/1.0.8/INSTALL_RECEIPT.json",
    ],
    links: [{
      type: "symlink",
      source: "Cellar/bzip2/1.0.8/bin/bzip2",
      target: "bin/bzip2",
    }],
    pathPrepend: ["bin"],
    supportOutputs: [],
    dependencies: [{
      fullName: "kandelo-dev/tap-core/zlib",
      version: "1.3.1",
      revision: 0,
      bottleRebuild: 1,
      bottleSha256: SHA_B,
    }],
    url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/blobs/sha256:${SHA_A}`,
    sha256: SHA_A,
    bytes: 123,
    compression: "gzip",
    ...overrides,
  };
}

function bootstrapDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return descriptor({
    name: "homebrew-bootstrap",
    fullName: "kandelo-dev/tap-core/homebrew-bootstrap",
    version: "4.0.5_1",
    keg: "/opt/kandelo/homebrew/Cellar/homebrew-bootstrap/4.0.5_1",
    payloadRoot: "homebrew-bootstrap/4.0.5_1",
    receipts: [
      "Cellar/homebrew-bootstrap/4.0.5_1/.brew/homebrew-bootstrap.rb",
      "Cellar/homebrew-bootstrap/4.0.5_1/INSTALL_RECEIPT.json",
    ],
    links: [],
    pathPrepend: [],
    materialization: "homebrew-runtime-support-v1",
    supportOutputs: [
      {
        name: "homebrew-bootstrap",
        kegRelativePath: "libexec/homebrew-bootstrap.zip",
        sha256: SHA_B,
        bytes: 456,
      },
      {
        name: "homebrew-brew",
        kegRelativePath: "libexec/homebrew-brew.env",
        sha256: SHA_C,
        bytes: 78,
      },
    ],
    dependencies: [],
    ...overrides,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectRejected(value: unknown): void {
  expect(() => projectHomebrewBottleDescriptor(value)).toThrow(
    HomebrewBottleDescriptorError,
  );
}

describe("Homebrew bottle descriptor", () => {
  it("projects one canonical, provenance-free keg descriptor", () => {
    const projected = projectHomebrewBottleDescriptor(descriptor());

    expect(projected).toEqual(descriptor());
    expect(projected).not.toHaveProperty("tapCommit");
  });

  it("requires exact object keys at every descriptor boundary", () => {
    const extra = descriptor({ campaign: "retired" });
    const missing = descriptor();
    delete missing.url;
    const nestedExtra = descriptor();
    (nestedExtra.dependencies as Array<Record<string, unknown>>)[0]!.tapCommit = "0".repeat(40);

    expectRejected(extra);
    expectRejected(missing);
    expectRejected(nestedExtra);
  });

  it("rejects every campaign or provenance spelling", () => {
    for (const key of [
      "tapCommit", "kandeloCommit", "builtFrom", "builtBy", "generatedAt",
      "releaseTag", "workflow", "campaign", "provenance", "signature", "promotion",
      "tap_commit", "kandelo_commit", "built_from", "built_by", "generated_at",
      "release_tag",
    ]) {
      expectRejected(descriptor({ [key]: "forbidden" }));
    }
  });

  it("rejects noncanonical content digests and byte counts", () => {
    for (const value of [SHA_A.toUpperCase(), "a".repeat(63), "g".repeat(64)]) {
      expectRejected(descriptor({ sha256: value }));
    }
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectRejected(descriptor({ bytes: value }));
    }
    expectRejected(descriptor({
      dependencies: [{
        fullName: "kandelo-dev/tap-core/zlib",
        version: "1.3.1",
        revision: 0,
        bottleRebuild: 1,
        bottleSha256: SHA_B.toUpperCase(),
      }],
    }));
  });

  it("accepts only closed public GHCR digest and release-asset URLs", () => {
    const release = descriptor({
      url: "https://github.com/kandelo-dev/homebrew-tap-core/releases/download/bottles-abi-v42/bzip2-1.0.8.tar.gz",
    });
    expect(projectHomebrewBottleDescriptor(release).url).toBe(release.url);

    for (const url of [
      "http://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/blobs/sha256:" + SHA_A,
      "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/blobs/sha256:" + SHA_B,
      "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/manifests/latest",
      "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/blobs/sha256:" + SHA_A + "?token=x",
      "https://github.com/kandelo-dev/homebrew-tap-core/releases/download/tag/asset.tar.gz#fragment",
      "https://github.com/kandelo-dev/homebrew-tap-core/releases/latest/download/asset.tar.gz",
      "https://example.test/bzip2.tar.gz",
    ]) expectRejected(descriptor({ url }));
  });

  it("derives every guest path from the canonical layout and keg identity", () => {
    for (const [key, value] of [
      ["prefix", "/usr/local"],
      ["cellar", "/opt/kandelo/homebrew/not-Cellar"],
      ["keg", "/opt/kandelo/homebrew/Cellar/bzip2/not-1.0.8"],
      ["payloadRoot", "elsewhere/1.0.8"],
      ["receipts", ["etc/shadow"]],
      ["links", [{ type: "symlink", source: "Cellar/bzip2/1.0.8/bin/bzip2", target: "../bin/bzip2" }]],
      ["pathPrepend", ["suspicious/bin"]],
    ] as const) expectRejected(descriptor({ [key]: value }));
  });

  it("accepts valid POSIX Homebrew basenames in canonical relative paths", () => {
    for (const { source, target } of [
      { source: "bin/[", target: "bin/[" },
      { source: "bin/_ld", target: "bin/_ld" },
      { source: ".editorconfig", target: "share/.editorconfig" },
    ]) {
      const value = descriptor({
        links: [{
          type: "symlink",
          source: `Cellar/bzip2/1.0.8/${source}`,
          target,
        }],
      });
      expect(projectHomebrewBottleDescriptor(value).links[0]).toEqual({
        type: "symlink",
        source: `Cellar/bzip2/1.0.8/${source}`,
        target,
      });
    }
  });

  it("rejects unsafe or noncanonical relative path boundaries", () => {
    for (const path of [
      "/bin/tool", "bin//tool", "bin/./tool", "bin/../tool",
      "bin/\0tool", "bin/\u001ftool", "bin/\u007ftool", "bin/\u0085tool", "bin/\ud800tool",
    ]) {
      expectRejected(descriptor({
        links: [{
          type: "symlink",
          source: "Cellar/bzip2/1.0.8/bin/bzip2",
          target: path,
        }],
      }));
    }
  });

  it("derives receipt and link-source roots from the authoritative cellar", async () => {
    vi.resetModules();
    vi.doMock("../src/homebrew-guest-layout", () => ({
      KANDELO_HOMEBREW_GUEST_LAYOUT: Object.freeze({
        prefix: "/srv/kandelo/brew",
        cellar: "/srv/kandelo/brew/Store",
        repository: "/srv/kandelo/brew",
        stableEntrypoint: "/usr/bin/brew",
      }),
    }));
    try {
      const { projectHomebrewBottleDescriptor: project } = await import(
        "../src/homebrew-bottle-descriptor"
      );
      const shifted = descriptor({
        prefix: "/srv/kandelo/brew",
        cellar: "/srv/kandelo/brew/Store",
        keg: "/srv/kandelo/brew/Store/bzip2/1.0.8",
        receipts: [
          "Store/bzip2/1.0.8/.brew/bzip2.rb",
          "Store/bzip2/1.0.8/INSTALL_RECEIPT.json",
        ],
        links: [{
          type: "symlink",
          source: "Store/bzip2/1.0.8/bin/bzip2",
          target: "bin/bzip2",
        }],
      });

      expect(project(shifted)).toEqual(shifted);
    } finally {
      vi.doUnmock("../src/homebrew-guest-layout");
      vi.resetModules();
    }
  });

  it("rejects duplicate materialization identities", () => {
    const dependency = (descriptor().dependencies as unknown[])[0]!;
    expectRejected(descriptor({ dependencies: [dependency, dependency] }));
    expectRejected(descriptor({ receipts: [
      "Cellar/bzip2/1.0.8/.brew/bzip2.rb",
      "Cellar/bzip2/1.0.8/.brew/bzip2.rb",
    ] }));
    expectRejected(descriptor({ links: [
      { type: "symlink", source: "Cellar/bzip2/1.0.8/bin/bzip2", target: "bin/bzip2" },
      { type: "symlink", source: "Cellar/bzip2/1.0.8/bin/bzcat", target: "bin/bzip2" },
    ] }));
    expectRejected(bootstrapDescriptor({ supportOutputs: [
      { name: "homebrew-bootstrap", kegRelativePath: "libexec/homebrew-bootstrap.zip", sha256: SHA_B, bytes: 456 },
      { name: "homebrew-bootstrap", kegRelativePath: "libexec/homebrew-brew.env", sha256: SHA_C, bytes: 78 },
    ] }));
  });

  it("reserves support data for the single bootstrap identity and exact outputs", () => {
    expectRejected(descriptor({ supportOutputs: [{
      name: "homebrew-bootstrap",
      kegRelativePath: "libexec/homebrew-bootstrap.zip",
      sha256: SHA_B,
      bytes: 456,
    }] }));
    expectRejected(descriptor({ materialization: "homebrew-runtime-support-v1" }));
    expectRejected(bootstrapDescriptor({ materialization: "keg", supportOutputs: [] }));
    expectRejected(bootstrapDescriptor({ supportOutputs: [{
      name: "homebrew-bootstrap",
      kegRelativePath: "libexec/not-bootstrap.zip",
      sha256: SHA_B,
      bytes: 456,
    }] }));
    expect(projectHomebrewBottleDescriptor(bootstrapDescriptor()).supportOutputs).toHaveLength(2);
  });

  it("encodes a validated descriptor as deterministic canonical JSON with one newline", () => {
    const first = projectHomebrewBottleDescriptor(descriptor());
    const second = projectHomebrewBottleDescriptor(clone(descriptor()));
    const firstBytes = encodeHomebrewBottleDescriptor(first);
    const secondBytes = encodeHomebrewBottleDescriptor(second);
    const firstText = new TextDecoder().decode(firstBytes);

    expect(firstBytes).toEqual(secondBytes);
    expect(firstText).toBe(
      `{"arch":"wasm32","bottleRebuild":0,"bottleTag":"wasm32_kandelo",` +
        `"bytes":123,"cellar":"/opt/kandelo/homebrew/Cellar","compression":"gzip",` +
        `"dependencies":[{"bottleRebuild":1,"bottleSha256":"${SHA_B}",` +
        `"fullName":"kandelo-dev/tap-core/zlib","revision":0,"version":"1.3.1"}],` +
        `"fullName":"kandelo-dev/tap-core/bzip2","kandeloAbi":${ABI_VERSION},` +
        `"keg":"/opt/kandelo/homebrew/Cellar/bzip2/1.0.8",` +
        `"layout":"kandelo-homebrew-v1","links":[{"source":` +
        `"Cellar/bzip2/1.0.8/bin/bzip2","target":"bin/bzip2","type":"symlink"}],` +
        `"materialization":"keg","name":"bzip2","pathPrepend":["bin"],` +
        `"payloadRoot":"bzip2/1.0.8","prefix":"/opt/kandelo/homebrew",` +
        `"receipts":["Cellar/bzip2/1.0.8/.brew/bzip2.rb",` +
        `"Cellar/bzip2/1.0.8/INSTALL_RECEIPT.json"],"revision":0,"schema":1,` +
        `"sha256":"${SHA_A}","supportOutputs":[],` +
        `"url":"https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/bzip2/blobs/sha256:${SHA_A}",` +
        `"version":"1.0.8"}\n`,
    );
    expect(firstText.endsWith("\n")).toBe(true);
    expect(firstText.endsWith("\n\n")).toBe(false);
    expect(JSON.parse(firstText)).toEqual(first);
  });
});
