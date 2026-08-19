import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHomebrewProductInputs,
} from "../../images/vfs/scripts/homebrew-product-inputs";
import {
  openVfsProductBuild,
} from "../../images/vfs/scripts/vfs-product-builder-contract";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const TARGET_ABI = 7;
const cleanupDirectories = new Set<string>();

afterEach(() => {
  for (const directory of cleanupDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  cleanupDirectories.clear();
});

describe("Homebrew product inputs", () => {
  it("materializes embedded bottles and preserves lazy bottle trees", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "nginx", placement: "embedded" },
      { formula: "dinit", directory: "sbin", command: "dinit", placement: "lazy" },
    ]);
    const build = await openVfsProductBuild(
      fixture.inputsPath,
      fixture.reportPath,
    );
    const fs = MemoryFileSystem.createFresh(16 * 1024 * 1024);
    fs.mkdir("/opt", 0o755);
    fs.mkdir("/opt/kandelo", 0o755);

    const installed = await applyHomebrewProductInputs(
      fs,
      build,
      new Set(["nginx", "dinit"]),
    );

    expect(installed.get("nginx")?.bin("nginx")).toBe(
      "/opt/kandelo/homebrew/bin/nginx",
    );
    expect(installed.get("dinit")?.sbin("dinit")).toBe(
      "/opt/kandelo/homebrew/sbin/dinit",
    );
    expect(fs.isPathDeferred("/opt/kandelo/homebrew/bin/nginx")).toBe(false);
    expect(fs.isPathDeferred("/opt/kandelo/homebrew/sbin/dinit")).toBe(true);
  });

  it("rejects Formulae outside the product's direct roots", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "nginx", placement: "embedded" },
      { formula: "dinit", directory: "sbin", command: "dinit", placement: "embedded" },
    ]);
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);

    await expect(applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx"]),
    )).rejects.toThrow(/roots are not product-declared/);
  });

  it("rejects duplicate Formula descriptors", async () => {
    const fixture = productInputFixture([
      {
        inputId: "homebrew-nginx-first",
        formula: "nginx",
        directory: "bin",
        command: "nginx",
        placement: "embedded",
      },
      {
        inputId: "homebrew-nginx-second",
        formula: "nginx",
        directory: "bin",
        command: "nginx",
        placement: "embedded",
      },
    ]);
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);

    await expect(applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx"]),
    )).rejects.toThrow(/duplicates Homebrew Formula nginx/);
  });

  it("rejects a bottle transport outside the exact ABI namespace", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "nginx", placement: "embedded" },
    ]);
    rewriteDescriptor(fixture, "homebrew-nginx", (descriptor) => {
      descriptor.tree.transports[0].url = descriptor.tree.transports[0].url
        .replace("abi-7-candidates", "abi-8-candidates");
    });
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);

    await expect(applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx"]),
    )).rejects.toThrow(/leaves its exact target ABI namespace/);
  });

  it("rejects conflicting public bottle links", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "server", placement: "embedded" },
      { formula: "dinit", directory: "bin", command: "server", placement: "embedded" },
    ]);
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);

    await expect(applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx", "dinit"]),
    )).rejects.toThrow(/conflict|collid/i);
  });

  it("rejects a descriptor whose bottle identity differs from its input", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "nginx", placement: "embedded" },
    ]);
    rewriteDescriptor(fixture, "homebrew-nginx", (descriptor) => {
      descriptor.tree.content.sha256 = "9".repeat(64);
    });
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);

    await expect(applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx"]),
    )).rejects.toThrow(/differs from its exact bottle input/);
  });

  it("rejects a candidate transport in a canonical product", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "nginx", placement: "embedded" },
    ], "canonical");
    rewriteDescriptor(fixture, "homebrew-nginx", (descriptor) => {
      descriptor.tree.transports[0].url = descriptor.tree.transports[0].url
        .replace("abi-7/nginx", "abi-7-candidates/nginx");
    });
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);

    await expect(applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx"]),
    )).rejects.toThrow(/leaves its exact target ABI namespace/);
  });

  it("rejects an executable absent from the descriptor inventory", async () => {
    const fixture = productInputFixture([
      { formula: "nginx", directory: "bin", command: "nginx", placement: "embedded" },
    ]);
    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);
    const installed = await applyHomebrewProductInputs(
      productFs(),
      build,
      new Set(["nginx"]),
    );

    expect(() => installed.get("nginx")!.bin("missing")).toThrow(
      /has no executable/,
    );
  });
});

interface BottleSpec {
  inputId?: string;
  formula: string;
  directory: "bin" | "sbin";
  command: string;
  placement: "embedded" | "lazy";
}

function productInputFixture(
  specs: readonly BottleSpec[],
  referenceClass: "candidate" | "canonical" = "candidate",
) {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-homebrew-product-inputs-"));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  mkdirSync(files);
  const inputs: Array<Record<string, unknown>> = [];

  for (const spec of specs) {
    const inputId = spec.inputId ?? `homebrew-${spec.formula}`;
    const payload = new TextEncoder().encode(`#!/bin/sh\necho ${spec.formula}\n`);
    const archive = bottleArchive(spec, payload);
    const archiveSha256 = sha256(archive.bytes);
    const namespace = `homebrew-tap-core-abi-${TARGET_ABI}` +
      (referenceClass === "candidate" ? "-candidates" : "");
    const reference =
      `ghcr.io/kandelo-dev/${namespace}/` +
      `${spec.formula}@sha256:${archiveSha256}`;
    const descriptor = bottleDescriptor(
      spec,
      payload,
      archive,
      archiveSha256,
      `https://ghcr.io/v2/kandelo-dev/${namespace}/` +
        `${spec.formula}/blobs/sha256:${archiveSha256}`,
    );
    const descriptorBytes = new TextEncoder().encode(canonicalJson(descriptor));
    const descriptorSha256 = sha256(descriptorBytes);
    const descriptorFile = `${inputId}.descriptor.json`;
    const descriptorPath = join(files, descriptorFile);
    writeFileSync(descriptorPath, descriptorBytes);
    const input: Record<string, unknown> = {
      architecture: "wasm32",
      bytes: archive.bytes.byteLength,
      declared_materialization: spec.placement,
      descriptor: {
        bytes: descriptorBytes.byteLength,
        path: `files/${descriptorFile}`,
        reference:
          `ghcr.io/kandelo-dev/${namespace}/` +
          `${inputId}-descriptor@sha256:${descriptorSha256}`,
        sha256: descriptorSha256,
      },
      effective_materialization:
        spec.placement === "embedded" ? "embedded" : "lazy-reference",
      id: inputId,
      kind: "homebrew-bottle",
      reference,
      role: "runtime",
      sha256: archiveSha256,
    };
    if (spec.placement === "embedded") {
      const path = join(files, `${inputId}.tar.gz`);
      writeFileSync(path, archive.bytes);
      input.path = `files/${inputId}.tar.gz`;
    }
    inputs.push(input);
  }
  inputs.sort((left, right) => String(left.id).localeCompare(String(right.id)));

  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJson({
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: "wasm32",
      id: "mini-homebrew-product",
      manifest_path: "images/vfs/products/mini-homebrew-product.toml",
      manifest_sha256: "a".repeat(64),
      output: "mini-homebrew-product.vfs",
    },
    reference_class: referenceClass,
    schema: 1,
    source: {
      commit: "f".repeat(40),
      repository: "kandelo-dev/kandelo",
      tree: "1".repeat(40),
    },
    target_abi: {
      snapshot_sha256: "b".repeat(64),
      version: TARGET_ABI,
    },
  }));
  return {
    directory,
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
  };
}

function productFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.createFresh(16 * 1024 * 1024);
  fs.mkdir("/opt", 0o755);
  fs.mkdir("/opt/kandelo", 0o755);
  return fs;
}

function rewriteDescriptor(
  fixture: ReturnType<typeof productInputFixture>,
  inputId: string,
  mutate: (descriptor: any) => void,
): void {
  const inputs = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
  const input = inputs.inputs.find((candidate: { id: string }) => candidate.id === inputId);
  if (input === undefined) throw new Error(`missing fixture input ${inputId}`);
  const descriptorPath = join(fixture.directory, input.descriptor.path);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  mutate(descriptor);
  const bytes = new TextEncoder().encode(canonicalJson(descriptor));
  const digest = sha256(bytes);
  writeFileSync(descriptorPath, bytes);
  input.descriptor.bytes = bytes.byteLength;
  input.descriptor.sha256 = digest;
  input.descriptor.reference = input.descriptor.reference.replace(
    /sha256:[0-9a-f]{64}$/,
    `sha256:${digest}`,
  );
  writeFileSync(fixture.inputsPath, canonicalJson(inputs));
}

function bottleDescriptor(
  spec: BottleSpec,
  payload: Uint8Array,
  archive: { bytes: Uint8Array; expandedBytes: number; sourcePath: string },
  archiveSha256: string,
  transport: string,
) {
  const keg = `opt/kandelo/homebrew/Cellar/${spec.formula}/1.0`;
  const entries = [
    bottleDirectory("opt/kandelo/homebrew", `${spec.formula}-prefix`, "mergeable-directory"),
    bottleDirectory("opt/kandelo/homebrew/Cellar", `${spec.formula}-cellar`, "mergeable-directory"),
    bottleDirectory(
      `opt/kandelo/homebrew/Cellar/${spec.formula}`,
      `${spec.formula}-formula`,
      "mergeable-directory",
    ),
    bottleDirectory(keg, `${spec.formula}-keg`, "layer"),
    bottleDirectory(`${keg}/${spec.directory}`, `${spec.formula}-programs`, "layer"),
    {
      inode_group: `${spec.formula}-command`,
      materialization: "archive",
      mode: 0o755,
      ownership: "layer",
      path: `${keg}/${spec.directory}/${spec.command}`,
      size: payload.byteLength,
      source_path: archive.sourcePath,
      type: "file",
    },
    bottleDirectory(
      `opt/kandelo/homebrew/${spec.directory}`,
      `${spec.formula}-public-programs`,
      "mergeable-directory",
    ),
    {
      materialization: "descriptor",
      mode: 0o777,
      ownership: "layer",
      path: `opt/kandelo/homebrew/${spec.directory}/${spec.command}`,
      size: new TextEncoder().encode(
        `../Cellar/${spec.formula}/1.0/${spec.directory}/${spec.command}`,
      ).byteLength,
      source_path: `${spec.formula}-public-command`,
      target: `../Cellar/${spec.formula}/1.0/${spec.directory}/${spec.command}`,
      type: "symlink",
    },
    bottleDirectory(
      "opt/kandelo/homebrew/opt",
      `${spec.formula}-opt-directory`,
      "mergeable-directory",
    ),
    {
      materialization: "descriptor",
      mode: 0o777,
      ownership: "layer",
      path: `opt/kandelo/homebrew/opt/${spec.formula}`,
      size: new TextEncoder().encode(`../Cellar/${spec.formula}/1.0`).byteLength,
      source_path: `${spec.formula}-opt-link`,
      target: `../Cellar/${spec.formula}/1.0`,
      type: "symlink",
    },
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    architecture: "wasm32",
    formula: spec.formula,
    kind: "kandelo-homebrew-original-bottle-tree",
    required_by: [spec.formula],
    schema: 1,
    tap: "kandelo-dev/homebrew-tap-core",
    tree: {
      activation: {
        capabilities: [`homebrew-bottle:${spec.formula}`],
        mode: "first-use",
        roots: [`/${keg}`],
      },
      content: {
        bytes: archive.bytes.byteLength,
        decoder: "homebrew-bottle-tar-gzip-v1",
        media_type: "application/vnd.oci.image.layer.v1.tar+gzip",
        sha256: archiveSha256,
      },
      id: spec.formula,
      inventory: {
        entries,
        entry_count: entries.length,
        expanded_bytes: archive.expandedBytes,
        layer_entry_count: entries.filter((entry) => entry.ownership === "layer").length,
        mergeable_directory_count: entries.filter(
          (entry) => entry.ownership === "mergeable-directory",
        ).length,
        payload_bytes: payload.byteLength,
        regular_inode_count: 1,
        source: {
          entries: [{
            mode: 0o755,
            path: archive.sourcePath,
            size: payload.byteLength,
            type: "file",
          }],
          kind: "homebrew-bottle-tar-gzip-v1",
          schema: 1,
        },
        source_entry_count: 1,
      },
      package: `kandelo-dev/tap-core/${spec.formula}`,
      transports: [{ kind: "external-https", url: transport }],
    },
  };
}

function bottleDirectory(
  path: string,
  sourcePath: string,
  ownership: "layer" | "mergeable-directory",
) {
  return {
    materialization: "descriptor",
    mode: 0o755,
    ownership,
    path,
    size: 0,
    source_path: sourcePath,
    type: "directory",
  };
}

function bottleArchive(spec: BottleSpec, payload: Uint8Array) {
  const sourcePath = `${spec.formula}/1.0/${spec.directory}/${spec.command}`;
  const tar = tarBytes(sourcePath, payload, 0o755);
  return {
    bytes: gzipSync(tar),
    expandedBytes: tar.byteLength,
    sourcePath,
  };
}

function tarBytes(path: string, contents: Uint8Array, mode: number): Uint8Array {
  const header = new Uint8Array(512);
  writeTarText(header, 0, 100, path);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, contents.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar");
  writeTarText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = new Uint8Array(Math.ceil(contents.byteLength / 512) * 512);
  padded.set(contents);
  const output = new Uint8Array(512 + padded.byteLength + 1024);
  output.set(header);
  output.set(padded, 512);
  return output;
}

function writeTarText(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeTarText(target, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
