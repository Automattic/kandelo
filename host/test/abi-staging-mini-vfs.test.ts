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
import { afterEach, describe, expect, it } from "vitest";
import { buildAbiStagingMiniVfs } from "../../images/vfs/scripts/build-abi-staging-mini-vfs";
import { openVfsProductBuild } from "../../images/vfs/scripts/vfs-product-builder-contract";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const cleanup = new Set<string>();
const SNAPSHOT = "b".repeat(64);

afterEach(() => {
  for (const directory of cleanup) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanup.clear();
});

describe("ABI staging miniature VFS", () => {
  it("embeds one layer, retains one lazy layer, and recomposes references", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-abi-mini-vfs-"));
    cleanup.add(root);
    const candidate = fixture(root, "candidate");
    await buildAbiStagingMiniVfs(candidate);

    const candidateBytes = readFileSync(candidate.outputPath);
    expect(MemoryFileSystem.readImageMetadata(candidateBytes)).toEqual({
      abiSnapshotSha256: SNAPSHOT,
      kernelAbi: 8,
      version: 1,
    });
    const restored = MemoryFileSystem.fromImage(candidateBytes);
    await restored.verifyImportedLazyAtomicGroupSeals();
    expect(readVfsFile(restored, "/usr/bin/base")).toEqual(
      new TextEncoder().encode("base bottle\n"),
    );
    expect(restored.getLazyEntry("/usr/bin/tool")).toMatchObject({
      size: 12,
      url: expect.stringContaining("namespace=candidate"),
    });
    expect(readFileSync(candidate.reportPath, "utf8").endsWith("\n")).toBe(true);

    const canonical = fixture(root, "canonical");
    await buildAbiStagingMiniVfs(canonical);
    const canonicalBytes = readFileSync(canonical.outputPath);
    expect(sha256(canonicalBytes)).not.toBe(sha256(candidateBytes));
    const canonicalRestored = MemoryFileSystem.fromImage(canonicalBytes);
    await canonicalRestored.verifyImportedLazyAtomicGroupSeals();
    expect(canonicalRestored.getLazyEntry("/usr/bin/tool")).toMatchObject({
      size: 12,
      url: expect.stringContaining("namespace=canonical"),
    });

    const candidateReport = JSON.parse(readFileSync(candidate.reportPath, "utf8"));
    const canonicalReport = JSON.parse(readFileSync(canonical.reportPath, "utf8"));
    expect(candidateReport.inputs.map(inputIdentity)).toEqual(
      canonicalReport.inputs.map(inputIdentity),
    );
    expect(candidateReport.inputs).toEqual([
      expect.objectContaining({ id: "base-bottle", placement: "embedded" }),
      expect.objectContaining({ id: "tool-bottle", placement: "lazy-reference" }),
    ]);
  });

  it("keeps local-fixture references outside the ordinary builder API", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-abi-mini-vfs-"));
    cleanup.add(root);
    const options = fixture(root, "candidate");
    await expect(
      openVfsProductBuild(options.inputsPath, options.reportPath),
    ).rejects.toThrow(/local-fixture.*miniature/);
  });

  it("rejects local references whose byte identity does not match", async () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-abi-mini-vfs-"));
    cleanup.add(root);
    const options = fixture(root, "candidate");
    const inputs = JSON.parse(readFileSync(options.inputsPath, "utf8"));
    inputs.inputs[1].reference = inputs.inputs[1].reference.replace(
      /&bytes=[0-9]+$/,
      "&bytes=1",
    );
    writeFileSync(options.inputsPath, canonicalJson(inputs));

    await expect(buildAbiStagingMiniVfs(options)).rejects.toThrow(
      /local-fixture reference does not bind exact namespace and bytes/,
    );
  });
});

function fixture(root: string, namespace: "candidate" | "canonical") {
  const directory = join(root, namespace);
  mkdirSync(join(directory, "inputs"), { recursive: true });
  const base = new TextEncoder().encode("base bottle\n");
  const tool = new TextEncoder().encode("tool bottle\n");
  writeFileSync(join(directory, "inputs/base.bottle"), base);
  const manifestPath = join(directory, "mini-shell.toml");
  writeFileSync(
    manifestPath,
    'schema = 1\nid = "mini-shell"\narchitecture = "wasm32"\noutput = "mini-shell.vfs"\nbuilder = "images/vfs/scripts/build-abi-staging-mini-vfs.ts"\n',
  );
  const inputDocument = {
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs: [
      {
        architecture: "wasm32",
        bytes: base.byteLength,
        declared_materialization: "embedded",
        effective_materialization: "embedded",
        id: "base-bottle",
        kind: "homebrew-bottle",
        path: "inputs/base.bottle",
        reference: localReference(base, namespace),
        role: "runtime",
        sha256: sha256(base),
      },
      {
        architecture: "wasm32",
        bytes: tool.byteLength,
        declared_materialization: "lazy",
        effective_materialization: "lazy-reference",
        id: "tool-bottle",
        kind: "homebrew-bottle",
        reference: localReference(tool, namespace),
        role: "runtime",
        sha256: sha256(tool),
      },
    ],
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: "wasm32",
      id: "mini-shell",
      manifest_path: "fixture/products/mini-shell.toml",
      manifest_sha256: "a".repeat(64),
      output: "mini-shell.vfs",
    },
    reference_class: "local-fixture",
    schema: 1,
    source: {
      commit: "1".repeat(40),
      repository: "Automattic/kandelo",
      tree: "2".repeat(40),
    },
    target_abi: { snapshot_sha256: SNAPSHOT, version: 8 },
  };
  const inputsPath = join(directory, "inputs.json");
  writeFileSync(inputsPath, canonicalJson(inputDocument));
  return {
    inputsPath,
    manifestPath,
    outputPath: join(directory, "mini-shell.vfs"),
    reportPath: join(directory, "report.json"),
  };
}

function localReference(
  bytes: Uint8Array,
  namespace: "candidate" | "canonical",
): string {
  return `local-fixture:sha256:${sha256(bytes)}?namespace=${namespace}&bytes=${bytes.byteLength}`;
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const descriptor = fs.open(path, 0, 0);
  const bytes = new Uint8Array(size);
  const read = fs.read(descriptor, bytes, null, bytes.byteLength);
  fs.close(descriptor);
  return bytes.subarray(0, read);
}

function inputIdentity(input: Record<string, unknown>): unknown {
  return {
    bytes: input.bytes,
    id: input.id,
    kind: input.kind,
    placement: input.placement,
    role: input.role,
    sha256: input.sha256,
  };
}

function sha256(value: Uint8Array): string {
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
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
