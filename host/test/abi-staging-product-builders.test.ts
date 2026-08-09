import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRepositoryPathBundle,
} from "../../images/vfs/scripts/staged-product-inputs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogPath = join(repoRoot, "images/vfs/products/generated/catalog.json");
const cleanupDirectories = new Set<string>();
const SOURCE = {
  repository: "kandelo-dev/kandelo",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const TARGET_ABI = {
  version: 7,
  snapshot_sha256: "c".repeat(64),
};

afterEach(() => {
  for (const directory of cleanupDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe("ABI staging product builders", () => {
  it("builds platform-rootfs only from its exact declared source and package inputs", () => {
    const fixture = platformRootfsFixture();
    const result = runBuilder(
      "packages/registry/rootfs/build-rootfs-package.sh",
      fixture,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(fixture.outputPath)).toBe(true);
    expect(existsSync(fixture.reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(fixture.reportPath, "utf8"));
    expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
    expect(report.inputs.map((input: { id: string }) => input.id)).toEqual(
      fixture.inputIds,
    );
    expect(report.output.abi).toEqual(TARGET_ABI);

    const bytes = new Uint8Array(readFileSync(fixture.outputPath));
    expect(MemoryFileSystem.readImageMetadata(bytes)).toMatchObject({
      kernelAbi: TARGET_ABI.version,
      abiSnapshotSha256: TARGET_ABI.snapshot_sha256,
    });
    const fs = MemoryFileSystem.fromImage(bytes);
    expect(fs.isPathDeferred("/usr/bin/dash")).toBe(true);
    expect(fs.getLazyEntry("/usr/bin/dash")?.url).toMatch(
      /^https:\/\/artifacts\.example\.test\/.+sha256=[0-9a-f]{64}$/,
    );
    expect(readVfsFile(fs, "/usr/share/misc/magic.mgc")).toBe(
      "embedded file-magic\n",
    );
    expect(readVfsFile(fs, "/etc/os-release")).toContain('NAME="kandelo"');
  }, 30_000);

  it("fails before output for an omitted repository input or undeclared package input", () => {
    const omitted = platformRootfsFixture();
    const omittedDocument = JSON.parse(
      readFileSync(omitted.inputsPath, "utf8"),
    );
    omittedDocument.inputs = omittedDocument.inputs.filter(
      (input: { id: string }) => input.id !== "repository-rootfs-source",
    );
    writeFileSync(omitted.inputsPath, canonicalJson(omittedDocument));
    const missingResult = runBuilder(
      "packages/registry/rootfs/build-rootfs-package.sh",
      omitted,
    );
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toMatch(/rootfs-source|not declared/);
    expect(existsSync(omitted.outputPath)).toBe(false);
    expect(existsSync(omitted.reportPath)).toBe(false);

    const extra = platformRootfsFixture();
    const extraDocument = JSON.parse(readFileSync(extra.inputsPath, "utf8"));
    const contents = "undeclared package bytes";
    const digest = sha256(contents);
    extraDocument.inputs.push({
      architecture: "wasm32",
      bytes: Buffer.byteLength(contents),
      declared_materialization: "lazy",
      effective_materialization: "lazy-reference",
      id: "package-undeclared-output-extra",
      kind: "package-output",
      reference: `https://artifacts.example.test/extra?sha256=${digest}`,
      role: "runtime",
      sha256: digest,
    });
    extraDocument.inputs.sort(
      (left: { id: string }, right: { id: string }) =>
        left.id.localeCompare(right.id),
    );
    writeFileSync(extra.inputsPath, canonicalJson(extraDocument));
    const extraResult = runBuilder(
      "packages/registry/rootfs/build-rootfs-package.sh",
      extra,
    );
    expect(extraResult.status).not.toBe(0);
    expect(extraResult.stderr).toContain("unconsumed resolved package output");
    expect(existsSync(extra.outputPath)).toBe(false);
    expect(existsSync(extra.reportPath)).toBe(false);
  }, 30_000);
});

interface BuilderFixture {
  directory: string;
  manifestPath: string;
  inputsPath: string;
  reportPath: string;
  outputPath: string;
  inputIds: string[];
}

function platformRootfsFixture(): BuilderFixture {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-platform-rootfs-stage-"));
  cleanupDirectories.add(directory);
  const files = join(directory, "files");
  const temporary = join(directory, "tmp");
  mkdirSync(files);
  mkdirSync(temporary);

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const product = catalog.products.find(
    (entry: { manifest: { id: string } }) =>
      entry.manifest.id === "platform-rootfs",
  );
  if (!product) throw new Error("platform-rootfs is missing from the product catalog");

  const repositoryBundle = join(files, "rootfs-source.json");
  createRepositoryPathBundle({
    repositoryRoot: repoRoot,
    paths: ["MANIFEST", "images/rootfs"],
    source: SOURCE,
    outputPath: repositoryBundle,
  });
  const repositoryBytes = readFileSync(repositoryBundle);
  const inputs: Array<Record<string, unknown>> = [
    {
      architecture: "wasm32",
      bytes: repositoryBytes.byteLength,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: "repository-rootfs-source",
      kind: "repository-path",
      path: relative(directory, repositoryBundle),
      role: "runtime",
      sha256: sha256(repositoryBytes),
    },
  ];

  for (const claim of product.manifest.software.package) {
    for (const output of claim.outputs) {
      const id = `package-${claim.name}-output-${output}`;
      const contents = output === "file-magic"
        ? "embedded file-magic\n"
        : `lazy bytes for ${id}\n`;
      const digest = sha256(contents);
      const common = {
        architecture: "wasm32",
        bytes: Buffer.byteLength(contents),
        declared_materialization: claim.materialization,
        id,
        kind: "package-output",
        role: "runtime",
        sha256: digest,
      };
      if (claim.materialization === "embedded") {
        const path = join(files, id);
        writeFileSync(path, contents);
        inputs.push({
          ...common,
          effective_materialization: "embedded",
          path: relative(directory, path),
        });
      } else {
        inputs.push({
          ...common,
          effective_materialization: "lazy-reference",
          reference: `https://artifacts.example.test/${id}?sha256=${digest}`,
        });
      }
    }
  }
  inputs.sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );
  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(
    inputsPath,
    canonicalJson({
      build_environment: {
        dev_shell_lock_sha256: "d".repeat(64),
        policy_sha256: "e".repeat(64),
      },
      inputs,
      kind: "kandelo-resolved-vfs-product-inputs",
      product: {
        architecture: "wasm32",
        id: "platform-rootfs",
        manifest_path: product.path,
        manifest_sha256: product.sha256,
        output: product.manifest.output,
      },
      reference_class: "candidate",
      schema: 1,
      source: SOURCE,
      target_abi: TARGET_ABI,
    }),
  );
  return {
    directory,
    manifestPath: join(repoRoot, product.path),
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath: join(directory, product.manifest.output),
    inputIds: inputs.map((input) => String(input.id)),
  };
}

function runBuilder(builder: string, fixture: BuilderFixture) {
  return spawnSync(
    "bash",
    [
      join(repoRoot, builder),
      "--vfs-product-manifest", fixture.manifestPath,
      "--vfs-product-inputs", fixture.inputsPath,
      "--vfs-product-report", fixture.reportPath,
      "--vfs-product-output", fixture.outputPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        CI: "true",
        HOME: fixture.directory,
        LANG: "C.UTF-8",
        PATH: process.env.PATH,
        SOURCE_DATE_EPOCH: "0",
        TMPDIR: join(fixture.directory, "tmp"),
        TZ: "UTC",
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function readVfsFile(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(size);
    expect(fs.read(fd, bytes, null, size)).toBe(size);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(fd);
  }
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
