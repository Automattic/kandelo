import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import type { VfsImageMetadata } from "../../host/src/vfs/vfs-image-filesystem";
import { ABI_VERSION } from "../../host/src/generated/abi";
import {
  createSourceOnlyBinarySnapshotSession,
  programOriginalWasmArtifact,
  programWasmArtifactPolicy,
  resolveProgramOriginalWasmArtifact,
} from "../../host/src/binary-resolver";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let fakeRepoRoot: string;

function uleb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function sleb128I32(n: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    let byte = n & 0x7f;
    n >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(name: string): number[] {
  const encoded = new TextEncoder().encode(name);
  return [...uleb128(encoded.length), ...encoded];
}

function functionBody(instructions: number[]): number[] {
  const body = [0x00, ...instructions, 0x0b];
  return [...uleb128(body.length), ...body];
}

function executableWasmWithAbi(abi: number): Uint8Array {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ];
  bytes.push(...section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]));
  bytes.push(...section(3, [0x02, 0x00, 0x00]));
  bytes.push(...section(7, [
    0x02,
    ...nameBytes("__abi_version"), 0x00, 0x00,
    ...nameBytes("_start"), 0x00, 0x01,
  ]));
  bytes.push(...section(10, [
    0x02,
    ...functionBody([0x41, ...sleb128I32(abi)]),
    ...functionBody([0x41, 0x00]),
  ]));
  return new Uint8Array(bytes);
}

async function vfsImage(
  metadata: VfsImageMetadata | null | undefined,
  compressed: boolean,
): Promise<Uint8Array> {
  // Written by the producer that writes every shipped image: these cases are
  // about what the RESOLVER does with an image's declared metadata, so the
  // fixture must be the kind of image a resolver will meet.
  const mfs = KandeloImageFs.create();
  const image = await mfs.saveImage(
    metadata === undefined ? undefined : { metadata },
  );
  return compressed ? new Uint8Array(zstdCompressSync(image)) : image;
}

function candidatePath(tier: "local-binaries" | "binaries", relPath: string): string {
  return join(fakeRepoRoot, tier, relPath);
}

function writeCandidate(
  tier: "local-binaries" | "binaries",
  relPath: string,
  bytes: Uint8Array,
): string {
  const path = candidatePath(tier, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function resolveBinary(relPath: string) {
  const env = {
    ...process.env,
    WASM_POSIX_BINARY_RESOLVER_REPO_ROOT: fakeRepoRoot,
  };
  delete env.WASM_POSIX_DEPS_REGISTRY;
  return spawnSync("bash", [join(repoRoot, "scripts", "resolve-binary.sh"), relPath], {
    cwd: fakeRepoRoot,
    encoding: "utf8",
    env,
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeSourceOnlyFixture(root: string): {
  artifact: string;
  artifactBytes: Uint8Array;
  relPath: string;
  sibling: string;
  projectionPath: string;
} {
  const packageName = "source-only-fixture";
  const sourceArtifact = "artifact.wasm";
  const mirrorPath = `${packageName}/${sourceArtifact}`;
  const relPath = `programs/wasm32/${mirrorPath}`;
  const artifact = join(root, relPath);
  const artifactBytes = executableWasmWithAbi(ABI_VERSION);
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, artifactBytes, { mode: 0o755 });
  chmodSync(artifact, 0o755);
  const siblingSourceArtifact = "sidecar.dat";
  const siblingMirrorPath = `${packageName}/${siblingSourceArtifact}`;
  const siblingRelPath = `programs/wasm32/${siblingMirrorPath}`;
  const sibling = join(root, siblingRelPath);
  const siblingBytes = Buffer.from("source-only closure sidecar\n");
  writeFileSync(sibling, siblingBytes, { mode: 0o644 });
  chmodSync(sibling, 0o644);
  const kernelBytes = Buffer.from("unrequested root boot fixture\n");
  const kernel = join(root, "kernel.wasm");
  writeFileSync(kernel, kernelBytes, { mode: 0o755 });
  chmodSync(kernel, 0o755);

  const manifestSha256 = "1".repeat(64);
  const cacheKeySha256 = "2".repeat(64);
  const projection = {
    format: "kandelo-program-packages-v2",
    identities: {
      [packageName]: {
        manifestSha256,
        cacheKeys: {
          wasm32: cacheKeySha256,
          wasm64: "3".repeat(64),
        },
      },
    },
    packages: {
      [packageName]: {
        manifestSha256,
        arches: ["wasm32"],
        cacheKeys: { wasm32: cacheKeySha256 },
        dependencyClosures: { wasm32: [] },
        members: [
          {
            kind: "output",
            sourceArtifact,
            mirrorPath,
            outputName: "artifact",
            forkInstrumentation: "disabled",
          },
          {
            kind: "runtime-file",
            sourceArtifact: siblingSourceArtifact,
            mirrorPath: siblingMirrorPath,
            guestPath: "/usr/share/source-only-fixture/sidecar.dat",
            mode: 0o644,
          },
        ],
      },
    },
  };
  const authority = {
    format: "kandelo-source-only-program-projection-v1",
    projection,
    graphAuthoritySha256: "4".repeat(64),
    nodes: [
      {
        node: { kind: "package", name: "kernel", targetArch: "wasm32" },
        manifestSha256: "6".repeat(64),
        cacheKeySha256: "7".repeat(64),
        cacheReceiptSha256: "8".repeat(64),
        members: [{
          sourceArtifact: "kandelo-kernel.wasm",
          mirrorPath: "kernel.wasm",
          mode: 0o755,
          size: kernelBytes.byteLength,
          sha256: sha256(kernelBytes),
        }],
      },
      {
        node: { kind: "package", name: packageName, targetArch: "wasm32" },
        manifestSha256,
        cacheKeySha256,
        cacheReceiptSha256: "5".repeat(64),
        members: [
          {
            sourceArtifact,
            mirrorPath: relPath,
            mode: 0o755,
            size: artifactBytes.byteLength,
            sha256: sha256(artifactBytes),
          },
          {
            sourceArtifact: siblingSourceArtifact,
            mirrorPath: siblingRelPath,
            mode: 0o644,
            size: siblingBytes.byteLength,
            sha256: sha256(siblingBytes),
          },
        ],
      },
    ],
  };
  const metadataRoot = join(root, ".kandelo");
  mkdirSync(metadataRoot, { recursive: true });
  const projectionPath = join(
    metadataRoot,
    "source-only-program-projection-v1.json",
  );
  writeFileSync(
    projectionPath,
    `${JSON.stringify(authority)}\n`,
    { mode: 0o644 },
  );
  return { artifact, artifactBytes, relPath, sibling, projectionPath };
}

function writeOriginalSourceOnlyFixture(root: string, originalBytes = Buffer.from("\0asm\x01\0\0\0")) {
  const fixture = writeSourceOnlyFixture(root);
  const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
  const packageName = "source-only-fixture";
  const projected = authority.projection.packages[packageName];
  const output = projected.members[0];
  output.mirrorPath = output.sourceArtifact;
  output.originalWasm = "originals/artifact.wasm";
  projected.members = [output];
  const node = authority.nodes.find((entry: { node: { name: string } }) => entry.node.name === packageName);
  const relPath = `programs/wasm32/${output.mirrorPath}`;
  const artifact = join(root, relPath);
  copyFileSync(fixture.artifact, artifact);
  chmodSync(artifact, 0o755);
  const originalRelPath = `programs/wasm32/.originals/${packageName}/${node.cacheKeySha256}/${output.originalWasm}`;
  const original = join(root, originalRelPath);
  mkdirSync(dirname(original), { recursive: true });
  writeFileSync(original, originalBytes, { mode: 0o444 });
  chmodSync(original, 0o444);
  node.members = [
    { ...node.members[0], mirrorPath: relPath },
    { sourceArtifact: output.originalWasm, mirrorPath: originalRelPath, mode: 0o444,
      size: originalBytes.length, sha256: sha256(originalBytes) },
  ].sort((left, right) => left.mirrorPath < right.mirrorPath ? -1 : 1);
  writeFileSync(fixture.projectionPath, JSON.stringify(authority));
  return { ...fixture, artifact, relPath, original, originalRelPath, originalBytes };
}

function resolveSourceOnlyBinary(
  relPath: string,
  sourceOnlyRoot: string,
  options: {
    bundlePath?: string;
    binaryCacheRoot?: string;
  } = {},
) {
  const env = {
    ...process.env,
    WASM_POSIX_BINARY_RESOLVER_REPO_ROOT: fakeRepoRoot,
    WASM_POSIX_RESOLUTION_POLICY: "source-only-v1",
    WASM_POSIX_SOURCE_ONLY_BINARY_ROOT: sourceOnlyRoot,
    ...(options.binaryCacheRoot === undefined
      ? {}
      : { WASM_POSIX_BINARY_CACHE_ROOT: options.binaryCacheRoot }),
  };
  delete env.WASM_POSIX_DEPS_REGISTRY;
  const command = options.bundlePath === undefined ? "bash" : "node";
  const commandPath = options.bundlePath
    ?? join(repoRoot, "scripts", "resolve-binary.sh");
  return spawnSync(
    command,
    [commandPath, relPath],
    { cwd: fakeRepoRoot, encoding: "utf8", env },
  );
}

beforeAll(() => {
  fakeRepoRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "kandelo-resolve-binary-")),
  );
  mkdirSync(join(fakeRepoRoot, "packages", "registry"), { recursive: true });
  writeFileSync(join(fakeRepoRoot, "Cargo.toml"), "[workspace]\nmembers = []\n");
  writeFileSync(
    join(fakeRepoRoot, "package.json"),
    "{\"name\":\"kandelo\",\"private\":true}\n",
  );
  writeFileSync(
    join(fakeRepoRoot, "packages", "registry", "program-packages.json"),
    '{"format":"kandelo-program-packages-v2","identities":{},"packages":{}}\n',
  );
});

afterAll(() => {
  rmSync(fakeRepoRoot, { recursive: true, force: true });
});

describe("source-only binary resolver boundary", () => {
  it("keeps executable paths flat and admits associated originals only as data", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-original-projection-")));
    const fixture = writeOriginalSourceOnlyFixture(root);
    try {
      const result = resolveSourceOnlyBinary(fixture.relPath, root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(fixture.artifact);
      const raw = resolveSourceOnlyBinary(fixture.originalRelPath, root);
      expect(raw.status, raw.stderr).toBe(0);
      expect(raw.stdout.trim()).toBe(fixture.original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["missing", "corrupt", "executable", "writable", "symlink"])("refuses an executable whose associated original is %s", (mutation) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-original-projection-")));
    const fixture = writeOriginalSourceOnlyFixture(root);
    try {
      if (mutation === "missing" || mutation === "symlink") rmSync(fixture.original);
      if (mutation === "symlink") symlinkSync(fixture.artifact, fixture.original);
      if (mutation === "corrupt") {
        chmodSync(fixture.original, 0o644);
        writeFileSync(fixture.original, Buffer.alloc(fixture.originalBytes.length));
        chmodSync(fixture.original, 0o444);
      }
      if (mutation === "executable") chmodSync(fixture.original, 0o555);
      if (mutation === "writable") chmodSync(fixture.original, 0o644);
      const result = resolveSourceOnlyBinary(fixture.relPath, root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/originals|mode/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["arch", "cache-key", "extra", "caller-role", "artifact-collision"])("rejects %s changes to original companion ownership", (mutation) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-original-projection-")));
    const fixture = writeOriginalSourceOnlyFixture(root);
    try {
      const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
      const node = authority.nodes.find((entry: { node: { name: string } }) => entry.node.name === "source-only-fixture");
      const original = node.members.find((member: { mirrorPath: string }) => member.mirrorPath === fixture.originalRelPath);
      if (mutation === "arch") original.mirrorPath = original.mirrorPath.replace("/wasm32/", "/wasm64/");
      if (mutation === "cache-key") original.mirrorPath = original.mirrorPath.replace("2".repeat(64), "9".repeat(64));
      if (mutation === "extra") node.members.push({ ...original, mirrorPath: `${original.mirrorPath}.extra` });
      if (mutation === "caller-role") original.associatedOriginal = true;
      if (mutation === "artifact-collision") authority.projection.packages["source-only-fixture"].members[0].originalWasm = "artifact.wasm";
      node.members.sort((left: { mirrorPath: string }, right: { mirrorPath: string }) => left.mirrorPath < right.mirrorPath ? -1 : 1);
      writeFileSync(fixture.projectionPath, JSON.stringify(authority));
      const result = resolveSourceOnlyBinary(fixture.relPath, root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/projection|originalWasm/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins original ownership and streams uncaptured originals within snapshot budgets", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-original-projection-")));
    const payload = Buffer.concat([Buffer.from(nameBytes("padding")), Buffer.alloc(2 * 1024 * 1024)]);
    const originalBytes = Buffer.concat([Buffer.from("\0asm\x01\0\0\0"), Buffer.from([0, ...uleb128(payload.length)]), payload]);
    const fixture = writeOriginalSourceOnlyFixture(root, originalBytes);
    const previousPolicy = process.env.WASM_POSIX_RESOLUTION_POLICY;
    const previousRoot = process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
    process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
    process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = root;
    const allocation = vi.spyOn(Buffer, "alloc");
    try {
      expect(programOriginalWasmArtifact(fixture.relPath)).toMatchObject({
        relPath: fixture.originalRelPath, size: originalBytes.length, sha256: sha256(originalBytes), mode: 0o444,
      });
      expect(resolveProgramOriginalWasmArtifact(fixture.relPath, "source-only-fixture", fixture.artifact)).toMatchObject({
        path: fixture.original, relPath: fixture.originalRelPath, sha256: sha256(originalBytes), size: originalBytes.length,
      });
      expect(() => resolveProgramOriginalWasmArtifact(fixture.relPath, "unrelated", fixture.artifact)).toThrow(/does not own/);
      const staleExecutable = join(root, "stale.wasm");
      writeFileSync(staleExecutable, Buffer.from("stale program"));
      expect(() => resolveProgramOriginalWasmArtifact(fixture.relPath, "source-only-fixture", staleExecutable)).toThrow(/differs from its selected package receipt/);
      expect(() => programWasmArtifactPolicy(fixture.originalRelPath)).toThrow(/not a declared executable/);
      const session = createSourceOnlyBinarySnapshotSession();
      const executable = session.snapshots([fixture.relPath], fixture.artifactBytes.length);
      expect(Buffer.from(executable[0]!.bytes)).toEqual(Buffer.from(fixture.artifactBytes));
      expect(allocation.mock.calls.every(([size]) => size < originalBytes.length)).toBe(true);
      expect(() => session.snapshots([fixture.originalRelPath], originalBytes.length - 1)).toThrow(/limit|exceed/i);
      const captured = session.snapshots([fixture.originalRelPath], originalBytes.length);
      expect(Buffer.from(captured[0]!.bytes)).toEqual(originalBytes);
    } finally {
      allocation.mockRestore();
      if (previousPolicy === undefined) delete process.env.WASM_POSIX_RESOLUTION_POLICY;
      else process.env.WASM_POSIX_RESOLUTION_POLICY = previousPolicy;
      if (previousRoot === undefined) delete process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
      else process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects the aggregate instead of mirror, compiled-cache, and installed poison", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const poison = executableWasmWithAbi(ABI_VERSION);
    poison[poison.length - 2] = 1;
    writeCandidate("local-binaries", fixture.relPath, poison);
    const binaryCacheRoot = mkdtempSync(
      join(tmpdir(), "kandelo-source-only-compiled-poison-"),
    );
    const compiledPoison = join(
      binaryCacheRoot,
      "compiled",
      fixture.relPath,
    );
    mkdirSync(dirname(compiledPoison), { recursive: true });
    writeFileSync(compiledPoison, poison);
    const fetchedPoison = candidatePath("binaries", fixture.relPath);
    mkdirSync(dirname(fetchedPoison), { recursive: true });
    symlinkSync(compiledPoison, fetchedPoison);
    const installedRoot = mkdtempSync(
      join(tmpdir(), "kandelo-source-only-installed-poison-"),
    );
    const installedBundle = join(
      installedRoot,
      "scripts",
      "resolve-binary.bundle.mjs",
    );
    const installedPoison = join(installedRoot, "wasm", fixture.relPath);
    mkdirSync(dirname(installedBundle), { recursive: true });
    mkdirSync(dirname(installedPoison), { recursive: true });
    copyFileSync(
      join(repoRoot, "scripts", "resolve-binary.bundle.mjs"),
      installedBundle,
    );
    writeFileSync(installedPoison, poison);

    try {
      const result = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
        { bundlePath: installedBundle, binaryCacheRoot },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(fixture.artifact);
      expect(readFileSync(result.stdout.trim())).toEqual(
        Buffer.from(fixture.artifactBytes),
      );

      rmSync(fixture.artifact);
      const missingSource = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
        { bundlePath: installedBundle, binaryCacheRoot },
      );
      expect(missingSource.status).not.toBe(0);
      expect(missingSource.stderr).toContain("Source-only package member");
      expect(missingSource.stdout).toBe("");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
      rmSync(binaryCacheRoot, { recursive: true, force: true });
      rmSync(installedRoot, { recursive: true, force: true });
    }
  });

  it("does not fall back to poisoned ordinary tiers for an unowned path", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    writeSourceOnlyFixture(sourceOnlyRoot);
    const relPath = "programs/wasm32/ordinary-only.wasm";
    const poison = executableWasmWithAbi(ABI_VERSION);
    writeCandidate("local-binaries", relPath, poison);
    writeCandidate("binaries", relPath, poison);

    try {
      const result = resolveSourceOnlyBinary(relPath, sourceOnlyRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Package artifacts not found");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("validates the complete owning closure before returning one member", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const siblingBytes = readFileSync(fixture.sibling);
    siblingBytes[0] ^= 1;
    writeFileSync(fixture.sibling, siblingBytes, { mode: 0o644 });
    chmodSync(fixture.sibling, 0o644);

    try {
      const result = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("sidecar.dat");
      expect(result.stderr).toContain("sha256");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("rejects relative and symlinked source-only roots", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    writeSourceOnlyFixture(sourceOnlyRoot);
    const linkRoot = `${sourceOnlyRoot}-link`;
    symlinkSync(sourceOnlyRoot, linkRoot);

    try {
      const relative = resolveSourceOnlyBinary("kernel.wasm", "relative-root");
      expect(relative.status).not.toBe(0);
      expect(relative.stderr).toContain("must be absolute");

      const symlinked = resolveSourceOnlyBinary("kernel.wasm", linkRoot);
      expect(symlinked.status).not.toBe(0);
      expect(symlinked.stderr).toContain("root is not a real directory");
    } finally {
      rmSync(linkRoot, { force: true });
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("rejects aggregate ownership that diverges from the embedded v2 projection", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    authority.nodes.find(
      (entry: { node: { name: string } }) =>
        entry.node.name === "source-only-fixture",
    ).members[0].sourceArtifact = "different.wasm";
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a 1:1 materialization");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("rejects an undeclared-arch node masquerading as a root mirror", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    const rogueBytes = Buffer.from("undeclared root mirror\n");
    const roguePath = join(sourceOnlyRoot, "rogue-root.dat");
    writeFileSync(roguePath, rogueBytes, { mode: 0o644 });
    chmodSync(roguePath, 0o644);
    authority.nodes.push({
      node: {
        kind: "package",
        name: "source-only-fixture",
        targetArch: "wasm64",
      },
      manifestSha256: "1".repeat(64),
      cacheKeySha256: "3".repeat(64),
      cacheReceiptSha256: "9".repeat(64),
      members: [{
        sourceArtifact: "rogue-root.dat",
        mirrorPath: "rogue-root.dat",
        mode: 0o644,
        size: rogueBytes.byteLength,
        sha256: sha256(rogueBytes),
      }],
    });
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "is neither an exact v2 program node nor a root-mirror package",
      );
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("bounds member allocation before inspecting the materialized file", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    authority.nodes.find(
      (entry: { node: { name: string } }) =>
        entry.node.name === "source-only-fixture",
    ).members[0].size = 512 * 1024 * 1024 + 1;
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(fixture.relPath, sourceOnlyRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("artifact limit");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("matches producer special mode bits and keeps authority mode exact", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    authority.nodes.find(
      (entry: { node: { name: string } }) =>
        entry.node.name === "source-only-fixture",
    ).members[0].mode = 0o4755;
    chmodSync(fixture.artifact, 0o4755);
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const accepted = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
      );
      expect(accepted.status, accepted.stderr).toBe(0);

      chmodSync(fixture.projectionPath, 0o4644);
      const rejected = resolveSourceOnlyBinary(
        fixture.relPath,
        sourceOnlyRoot,
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("authority mode is 4644, expected 644");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("requires producer-canonical architecture ordering", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    const projected =
      authority.projection.packages["source-only-fixture"];
    projected.arches = ["wasm64", "wasm32"];
    projected.cacheKeys = {
      wasm64: "3".repeat(64),
      wasm32: "2".repeat(64),
    };
    projected.dependencyClosures = { wasm64: [], wasm32: [] };
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(fixture.relPath, sourceOnlyRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("architectures are not canonically sorted");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("rejects ill-formed Unicode authority path strings", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    authority.nodes.find(
      (entry: { node: { name: string } }) =>
        entry.node.name === "source-only-fixture",
    ).members[0].sourceArtifact = "artifact-\ud800.wasm";
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(fixture.relPath, sourceOnlyRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("well-formed Unicode");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed UTF-8 authority bytes before JSON parsing", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    authority.projection.packages["source-only-fixture"]
      .members[0].outputName = "\ufffd";
    const encoded = Buffer.from(`${JSON.stringify(authority)}\n`, "utf8");
    const replacement = Buffer.from("\ufffd", "utf8");
    const replacementOffset = encoded.indexOf(replacement);
    expect(replacementOffset).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.concat([
      encoded.subarray(0, replacementOffset),
      Buffer.from([0xff]),
      encoded.subarray(replacementOffset + replacement.byteLength),
    ]);
    writeFileSync(fixture.projectionPath, malformed, { mode: 0o644 });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(fixture.relPath, sourceOnlyRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("authority is not valid UTF-8");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });

  it("rejects an unreferenced extra projection identity", () => {
    const sourceOnlyRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "kandelo-source-only-binaries-")),
    );
    const fixture = writeSourceOnlyFixture(sourceOnlyRoot);
    const authority = JSON.parse(readFileSync(fixture.projectionPath, "utf8"));
    authority.projection.identities.unreferenced = {
      manifestSha256: "a".repeat(64),
      cacheKeys: {
        wasm32: "b".repeat(64),
        wasm64: "c".repeat(64),
      },
    };
    writeFileSync(fixture.projectionPath, `${JSON.stringify(authority)}\n`, {
      mode: 0o644,
    });
    chmodSync(fixture.projectionPath, 0o644);

    try {
      const result = resolveSourceOnlyBinary(fixture.relPath, sourceOnlyRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exact package/dependency identity set");
    } finally {
      rmSync(sourceOnlyRoot, { recursive: true, force: true });
    }
  });
});

describe("shell binary resolver artifact policy", () => {
  it("incrementally rebuilds an existing source checker before exporting it", () => {
    const sourceRoot = mkdtempSync(
      join(tmpdir(), "kandelo-resolve-binary-checker-source-"),
    );
    const toolBin = join(sourceRoot, "test-tools");
    const hostTarget = "test-checker-host";
    const xtaskPath = join(
      sourceRoot,
      "target",
      hostTarget,
      "release",
      "xtask",
    );
    const buildRecord = join(sourceRoot, "cargo-build-record");
    mkdirSync(join(sourceRoot, "tools", "xtask"), { recursive: true });
    mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
    mkdirSync(dirname(xtaskPath), { recursive: true });
    mkdirSync(toolBin, { recursive: true });
    writeFileSync(join(sourceRoot, "tools", "xtask", "Cargo.toml"), "");
    writeFileSync(
      join(sourceRoot, "scripts", "dev-shell.sh"),
      `#!/bin/sh
printf '%s\\n' 'dev-shell setup chatter'
exec "$@"
`,
    );
    writeFileSync(xtaskPath, "#!/bin/sh\nexit 99\n");
    chmodSync(xtaskPath, 0o755);
    writeFileSync(
      join(toolBin, "rustc"),
      `#!/bin/sh
printf 'rustc 1.0\\nhost: ${hostTarget}\\n'
`,
    );
    writeFileSync(
      join(toolBin, "cargo"),
      `#!/bin/sh
printf '%s\\n' "$*" > "$CHECKER_BUILD_RECORD"
`,
    );
    writeFileSync(
      join(toolBin, "node"),
      `#!/bin/sh
printf '%s\\n' "$WASM_POSIX_XTASK_BIN"
`,
    );
    for (const tool of ["rustc", "cargo", "node"]) {
      chmodSync(join(toolBin, tool), 0o755);
    }

    try {
      const result = spawnSync(
        "bash",
        [
          join(repoRoot, "scripts", "resolve-binary.sh"),
          "programs/wasm32/checker/checker.wasm",
        ],
        {
          cwd: sourceRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${toolBin}:${process.env.PATH ?? ""}`,
            KANDELO_DEV_SHELL_TOOL_PATH: "",
            WASM_POSIX_BINARY_RESOLVER_REPO_ROOT: sourceRoot,
            CHECKER_BUILD_RECORD: buildRecord,
            WASM_POSIX_XTASK_BIN: "",
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(xtaskPath);
      expect(result.stderr).toContain("dev-shell setup chatter");
      expect(readFileSync(buildRecord, "utf8").trim()).toBe(
        `build --release -p xtask --target ${hostTarget} --quiet`,
      );
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("ships a standalone resolver bundle generated from the shared TypeScript source", () => {
    const result = spawnSync(
      "bash",
      [join(repoRoot, "scripts", "test-resolve-binary-bundle.sh")],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("resolves a ZIP archive without applying Wasm policy", () => {
    const relPath = "programs/wasm32/__resolve_binary_test__/runtime.zip";
    const localPath = writeCandidate(
      "local-binaries",
      relPath,
      new TextEncoder().encode("not a wasm module"),
    );

    const result = resolveBinary(relPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(localPath);
  });

  it("resolves a Wasm side module without applying executable Wasm policy", () => {
    const relPath = "programs/wasm32/__resolve_binary_test__/extension.so";
    const localPath = writeCandidate(
      "local-binaries",
      relPath,
      // A deliberately truncated Wasm header proves extension dispatch does
      // not run executable ABI/export decoding for package side modules.
      new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    );

    const result = resolveBinary(relPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(localPath);
  });

  it("accepts an uncompressed VFS image without a kernel ABI declaration", async () => {
    const relPath = "programs/wasm32/__resolve_binary_test__/data.vfs";
    const localPath = writeCandidate(
      "local-binaries",
      relPath,
      await vfsImage({ version: 1 }, false),
    );

    const result = resolveBinary(relPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(localPath);
  });

  // No malformed-VFS-image cases: the resolver chooses files and no longer
  // parses image headers. A mismatched or malformed image is refused by the
  // kernel when it loads the image (EPROTO for a different declared ABI).
  it("keeps an uninspectable .wasm artifact fail-closed", () => {
    const relPath = "programs/wasm32/__resolve_binary_test__/broken.wasm";
    writeCandidate(
      "local-binaries",
      relPath,
      new TextEncoder().encode("not a wasm module"),
    );

    const result = resolveBinary(relPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exists but was rejected by artifact policy");
  });
});
