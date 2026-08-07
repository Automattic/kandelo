import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";

import {
  projectVerifiedHomebrewBottle,
  runHomebrewBottleDescriptorProjector,
} from "./homebrew-project-bottle-descriptor";
import {
  type HomebrewBottleDescriptor,
  encodeHomebrewBottleDescriptor,
} from "../host/src/homebrew-bottle-descriptor";

const encoder = new TextEncoder();
const BLOCK = 512;
const PREFIX = "/opt/kandelo/homebrew";

describe("verified Homebrew bottle descriptor projection", () => {
  it("projects an ordinary bottle without publisher provenance", () => {
    const fixture = bottleFixture({ name: "bzip2", version: "1.0.8_2" });
    const descriptor = projectVerifiedHomebrewBottle({
      sidecarsInput: fixture.sidecarsInput,
      packageEntry: fixture.packageEntry,
      arch: "wasm32",
      bottle: fixture.bottle,
      publicUrl: fixture.publicUrl,
      dependencyDescriptors: [],
    });

    expect(descriptor).toMatchObject({
      schema: 1,
      name: "bzip2",
      fullName: "kandelo-dev/tap-core/bzip2",
      version: "1.0.8_2",
      revision: 2,
      bottleRebuild: 4,
      arch: "wasm32",
      kandeloAbi: 42,
      bottleTag: "wasm32_kandelo",
      materialization: "keg",
      payloadRoot: "bzip2/1.0.8_2",
      keg: `${PREFIX}/Cellar/bzip2/1.0.8_2`,
      receipts: [
        "Cellar/bzip2/1.0.8_2/.brew/bzip2.rb",
        "Cellar/bzip2/1.0.8_2/INSTALL_RECEIPT.json",
      ],
      links: [{
        type: "symlink",
        source: "Cellar/bzip2/1.0.8_2/bin/bzip2",
        target: "bin/bzip2",
      }],
      pathPrepend: ["bin"],
      supportOutputs: [],
      dependencies: [],
      sha256: sha256(fixture.bottle),
      bytes: fixture.bottle.byteLength,
      url: fixture.publicUrl,
      compression: "gzip",
    });
    expect(JSON.stringify(descriptor)).not.toMatch(
      /tapCommit|kandeloCommit|builtFrom|builtBy|generatedAt|releaseTag|workflow|campaign|provenance|signature|promotion|tap_commit|kandelo_commit|built_from|built_by|generated_at|release_tag/,
    );
  });

  it("projects verified links with POSIX bracket, underscore, and dotfile basenames", () => {
    for (const { source, target } of [
      { source: "bin/[", target: "bin/[" },
      { source: "bin/_ld", target: "bin/_ld" },
      { source: ".editorconfig", target: "share/.editorconfig" },
    ]) {
      const fixture = bottleFixture({
        name: "coreutils",
        version: "9.6",
        link: { source, target },
      });
      expect(projectVerifiedHomebrewBottle({
        sidecarsInput: fixture.sidecarsInput,
        packageEntry: fixture.packageEntry,
        arch: "wasm32",
        bottle: fixture.bottle,
        publicUrl: fixture.publicUrl,
        dependencyDescriptors: [],
      }).links).toEqual([{
        type: "symlink",
        source: `Cellar/coreutils/9.6/${source}`,
        target,
      }]);
    }
  });

  it("derives the closed bootstrap support output list from bottle members", () => {
    const fixture = bottleFixture({
      name: "homebrew-bootstrap",
      version: "6.0.12_1",
      supportData: true,
    });
    const descriptor = projectVerifiedHomebrewBottle({
      sidecarsInput: fixture.sidecarsInput,
      packageEntry: fixture.packageEntry,
      arch: "wasm32",
      bottle: fixture.bottle,
      publicUrl: fixture.publicUrl,
      dependencyDescriptors: [],
    });

    expect(descriptor.materialization).toBe("homebrew-runtime-support-v1");
    expect(descriptor.links).toEqual([]);
    expect(descriptor.pathPrepend).toEqual([]);
    expect(descriptor.dependencies).toEqual([]);
    expect(descriptor.supportOutputs).toEqual([
      {
        name: "homebrew-bootstrap",
        kegRelativePath: "libexec/homebrew-bootstrap.zip",
        sha256: sha256(encoder.encode("bootstrap zip")),
        bytes: 13,
      },
      {
        name: "homebrew-brew",
        kegRelativePath: "libexec/homebrew-brew.env",
        sha256: sha256(encoder.encode("HOMEBREW_PREFIX=/opt/kandelo/homebrew\n")),
        bytes: 38,
      },
    ]);
  });

  it("uses canonical direct dependency descriptors and ignores receipt transitives", () => {
    const fixture = bottleFixture({
      name: "ruby",
      version: "3.3.6",
      dependencies: [
        { fullName: "kandelo-dev/tap-core/zlib", version: "1.3.1", revision: 0 },
        { fullName: "kandelo-dev/tap-core/libyaml", version: "0.2.5", revision: 1 },
      ],
      transitiveDependencies: [
        { fullName: "kandelo-dev/tap-core/libcxx", version: "21.1.7", revision: 1 },
      ],
    });
    const zlib = dependencyDescriptor("zlib", "1.3.1", 0, 3, "1");
    const libyaml = dependencyDescriptor("libyaml", "0.2.5", 1, 7, "2");

    const descriptor = projectVerifiedHomebrewBottle({
      sidecarsInput: fixture.sidecarsInput,
      packageEntry: fixture.packageEntry,
      arch: "wasm32",
      bottle: fixture.bottle,
      publicUrl: fixture.publicUrl,
      dependencyDescriptors: [zlib, libyaml],
    });

    expect(descriptor.dependencies).toEqual([
      {
        fullName: "kandelo-dev/tap-core/libyaml",
        version: "0.2.5",
        revision: 1,
        bottleRebuild: 7,
        bottleSha256: "2".repeat(64),
      },
      {
        fullName: "kandelo-dev/tap-core/zlib",
        version: "1.3.1",
        revision: 0,
        bottleRebuild: 3,
        bottleSha256: "1".repeat(64),
      },
    ]);
  });

  it("rejects disagreement and incomplete direct dependency descriptor sets", () => {
    const fixture = bottleFixture({
      name: "ruby",
      version: "3.3.6",
      dependencies: [
        { fullName: "kandelo-dev/tap-core/zlib", version: "1.3.1", revision: 0 },
      ],
    });
    const zlib = dependencyDescriptor("zlib", "1.3.1", 0, 3, "1");
    const unused = dependencyDescriptor("unused", "1.0", 0, 0, "2");
    const sidecarMismatch = structuredClone(fixture.packageEntry);
    ((sidecarMismatch.dependencies as Array<Record<string, unknown>>)[0]!).version = "1.3.2";
    const sidecarMismatchInput = structuredClone(fixture.sidecarsInput);
    (sidecarMismatchInput.packages as unknown[]) = [sidecarMismatch];
    const descriptorMismatch = dependencyDescriptor("zlib", "1.3.2", 0, 3, "1");

    const options = (dependencyDescriptors: HomebrewBottleDescriptor[]) => ({
      sidecarsInput: fixture.sidecarsInput,
      packageEntry: fixture.packageEntry,
      arch: "wasm32" as const,
      bottle: fixture.bottle,
      publicUrl: fixture.publicUrl,
      dependencyDescriptors,
    });

    expect(() => projectVerifiedHomebrewBottle(options([]))).toThrow(/missing dependency descriptor/);
    expect(() => projectVerifiedHomebrewBottle(options([zlib, zlib]))).toThrow(/duplicate dependency descriptor/);
    expect(() => projectVerifiedHomebrewBottle(options([zlib, unused]))).toThrow(/unused dependency descriptor/);
    expect(() => projectVerifiedHomebrewBottle({
      ...options([zlib]),
      sidecarsInput: sidecarMismatchInput,
      packageEntry: sidecarMismatch,
    })).toThrow(/sidecar dependencies disagree with receipt/);
    expect(() => projectVerifiedHomebrewBottle(options([descriptorMismatch]))).toThrow(/dependency descriptor disagrees/);
  });

  it("rejects a bottle whose recomputed digest disagrees with the sidecar", () => {
    const fixture = bottleFixture({ name: "bzip2", version: "1.0.8_2" });
    const changed = structuredClone(fixture.packageEntry);
    (((changed.bottles as Array<Record<string, unknown>>)[0])!).cache_key_sha = "0".repeat(64);

    expect(() => projectVerifiedHomebrewBottle({
      sidecarsInput: fixture.sidecarsInput,
      packageEntry: changed,
      arch: "wasm32",
      bottle: fixture.bottle,
      publicUrl: fixture.publicUrl,
      dependencyDescriptors: [],
    })).toThrow(/SHA-256 does not match/);
  });

  it("rejects duplicate, missing, and unexpected sidecar receipt sets", () => {
    const fixture = bottleFixture({ name: "bzip2", version: "1.0.8_2" });
    for (const receipts of [
      [".brew/bzip2.rb", ".brew/bzip2.rb"],
      [".brew/bzip2.rb"],
      [".brew/bzip2.rb", "unexpected.json"],
    ]) {
      const pkg = structuredClone(fixture.packageEntry);
      ((pkg.bottles as Array<Record<string, unknown>>)[0]!).receipts = receipts;
      expect(() => projectVerifiedHomebrewBottle({
        sidecarsInput: fixture.sidecarsInput,
        packageEntry: pkg,
        arch: "wasm32",
        bottle: fixture.bottle,
        publicUrl: fixture.publicUrl,
        dependencyDescriptors: [],
      })).toThrow(/receipts are not canonical/);
    }
  });

  it("refuses existing outputs and leaves no output when CLI projection fails", async () => {
    const fixture = bottleFixture({ name: "bzip2", version: "1.0.8_2" });
    const root = mkdtempSync(join(tmpdir(), "kandelo-projector-"));
    try {
      const sidecars = join(root, "sidecars.json");
      const bottle = join(root, "bottle.tar.gz");
      const out = join(root, "descriptor.json");
      writeFileSync(sidecars, JSON.stringify(fixture.sidecarsInput));
      writeFileSync(bottle, fixture.bottle);
      writeFileSync(out, "existing\n");
      const args = [
        "--sidecars-input", sidecars, "--formula", "bzip2", "--arch", "wasm32",
        "--bottle", bottle, "--public-url", fixture.publicUrl, "--out", out,
      ];
      await expect(runHomebrewBottleDescriptorProjector(args)).rejects.toThrow(/already exists/);

      rmSync(out);
      writeFileSync(bottle, fixture.bottle.subarray(0, fixture.bottle.byteLength - 1));
      await expect(runHomebrewBottleDescriptorProjector(args)).rejects.toThrow();
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects parseable but noncanonical dependency descriptor files", async () => {
    const fixture = bottleFixture({
      name: "ruby", version: "3.3.6",
      dependencies: [{ fullName: "kandelo-dev/tap-core/zlib", version: "1.3.1", revision: 0 }],
    });
    const root = mkdtempSync(join(tmpdir(), "kandelo-projector-canonical-"));
    try {
      const sidecars = join(root, "sidecars.json");
      const bottle = join(root, "bottle.tar.gz");
      const dependency = join(root, "zlib.json");
      const out = join(root, "descriptor.json");
      writeFileSync(sidecars, JSON.stringify(fixture.sidecarsInput));
      writeFileSync(bottle, fixture.bottle);
      writeFileSync(dependency, JSON.stringify(dependencyDescriptor("zlib", "1.3.1", 0, 3, "1")));
      await expect(runHomebrewBottleDescriptorProjector([
        "--sidecars-input", sidecars, "--formula", "ruby", "--arch", "wasm32",
        "--bottle", bottle, "--public-url", fixture.publicUrl,
        "--dependency-descriptor", dependency, "--out", out,
      ])).rejects.toThrow(/not canonical/);
      expect(existsSync(out)).toBe(false);

      writeFileSync(dependency, encodeHomebrewBottleDescriptor(dependencyDescriptor("zlib", "1.3.1", 0, 3, "1")));
      await runHomebrewBottleDescriptorProjector([
        "--sidecars-input", sidecars, "--formula", "ruby", "--arch", "wasm32",
        "--bottle", bottle, "--public-url", fixture.publicUrl,
        "--dependency-descriptor", dependency, "--out", out,
      ]);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface DependencyInput {
  fullName: string;
  version: string;
  revision: number;
}

function bottleFixture(options: {
  name: string;
  version: string;
  supportData?: boolean;
  link?: { source: string; target: string };
  dependencies?: DependencyInput[];
  transitiveDependencies?: DependencyInput[];
}): {
  bottle: Uint8Array;
  packageEntry: Record<string, unknown>;
  sidecarsInput: Record<string, unknown>;
  publicUrl: string;
} {
  const payloadRoot = `${options.name}/${options.version}`;
  const runtimeDependencies = [
    ...(options.transitiveDependencies ?? []).map((dependency) => ({
      full_name: dependency.fullName,
      version: dependency.version,
      pkg_version: dependency.version,
      revision: dependency.revision,
      declared_directly: false,
    })),
    ...(options.dependencies ?? []).map((dependency) => ({
      full_name: dependency.fullName,
      version: dependency.version,
      pkg_version: dependency.version,
      revision: dependency.revision,
      declared_directly: true,
    })),
  ];
  const members: TarSpec[] = [
    { path: `${payloadRoot}/`, type: "directory" },
    { path: `${payloadRoot}/.brew/`, type: "directory" },
    { path: `${payloadRoot}/.brew/${options.name}.rb`, data: "class Fixture < Formula\nend\n" },
    { path: `${payloadRoot}/INSTALL_RECEIPT.json`, data: JSON.stringify({ runtime_dependencies: runtimeDependencies }) },
    { path: `${payloadRoot}/sbom.spdx.json`, data: "{}\n" },
  ];
  if (options.supportData) {
    members.push(
      { path: `${payloadRoot}/libexec/`, type: "directory" },
      { path: `${payloadRoot}/libexec/homebrew-bootstrap.zip`, data: "bootstrap zip" },
      { path: `${payloadRoot}/libexec/homebrew-brew.env`, data: "HOMEBREW_PREFIX=/opt/kandelo/homebrew\n" },
    );
  } else {
    const link = options.link ?? { source: `bin/${options.name}`, target: `bin/${options.name}` };
    members.push(
      { path: `${payloadRoot}/bin/`, type: "directory" },
      { path: `${payloadRoot}/${link.source}`, data: "#!/bin/sh\n" },
    );
  }
  const bottle = gzipSync(tarBytes(members));
  const bottleSha = sha256(bottle);
  const publicUrl = `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/${options.name}/blobs/sha256:${bottleSha}`;
  const packageEntry: Record<string, unknown> = {
    name: options.name,
    full_name: `kandelo-dev/tap-core/${options.name}`,
    version: options.version,
    formula_revision: 2,
    bottle_rebuild: 4,
    dependencies: (options.dependencies ?? []).map(({ fullName, version }) => ({
      name: fullName.split("/").at(-1), full_name: fullName, version,
    })),
    bottles: [{
      arch: "wasm32",
      bottle_tag: "wasm32_kandelo",
      prefix: PREFIX,
      cellar: `${PREFIX}/Cellar`,
      keg: `${PREFIX}/Cellar/${payloadRoot}`,
      payload_root: payloadRoot,
      cache_key_sha: bottleSha,
      receipts: [`.brew/${options.name}.rb`, "INSTALL_RECEIPT.json"],
      links: options.supportData ? [] : [{ type: "symlink", ...(options.link ?? { source: `bin/${options.name}`, target: `bin/${options.name}` }) }],
      env: options.supportData ? {} : { PATH_prepend: ["bin"] },
      url: "https://campaign.example.invalid/publisher-provenance",
      built_from: { tap_commit: "a".repeat(40), kandelo_commit: "b".repeat(40) },
      validation: { campaign: "publisher-only" },
    }],
    generated_at: "2026-08-06T00:00:00Z",
  };
  return {
    bottle,
    packageEntry,
    sidecarsInput: {
      schema: 1,
      kandelo_abi: 42,
      generated_at: "2026-08-06T00:00:00Z",
      tap_commit: "a".repeat(40),
      packages: [packageEntry],
    },
    publicUrl,
  };
}

function dependencyDescriptor(
  name: string,
  version: string,
  revision: number,
  bottleRebuild: number,
  shaCharacter: string,
): HomebrewBottleDescriptor {
  return {
    schema: 1,
    name,
    fullName: `kandelo-dev/tap-core/${name}`,
    version,
    revision,
    bottleRebuild,
    arch: "wasm32",
    kandeloAbi: 42,
    bottleTag: "wasm32_kandelo",
    layout: "kandelo-homebrew-v1",
    materialization: "keg",
    prefix: PREFIX,
    cellar: `${PREFIX}/Cellar`,
    keg: `${PREFIX}/Cellar/${name}/${version}`,
    payloadRoot: `${name}/${version}`,
    receipts: [`Cellar/${name}/${version}/.brew/${name}.rb`, `Cellar/${name}/${version}/INSTALL_RECEIPT.json`],
    links: [], pathPrepend: [], supportOutputs: [], dependencies: [],
    url: `https://ghcr.io/v2/kandelo-dev/tap-core/${name}/blobs/sha256:${shaCharacter.repeat(64)}`,
    sha256: shaCharacter.repeat(64), bytes: 1, compression: "gzip",
  };
}

interface TarSpec {
  path: string;
  type?: "file" | "directory";
  data?: string;
}

function tarBytes(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = BLOCK * 2;
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "");
    const payload = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK);
    payload.set(data);
    const header = tarHeader(entry, data.byteLength);
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function tarHeader(entry: TarSpec, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
  writeOctal(header, 124, 12, size);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type === "directory" ? "5" : "0").charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error(`fixture TAR field too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeString(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
