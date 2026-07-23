import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../../host/src/vfs/memory-fs";
import { ABI_VERSION } from "../../host/src/generated/abi";

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

function vfsWithMalformedMetadata(): Uint8Array {
  const image = Buffer.alloc(25);
  image.writeUInt32LE(0x56465349, 0); // VFSI
  image.writeUInt32LE(1, 4); // image version
  image.writeUInt32LE(1 << 2, 8); // metadata present
  image.writeUInt32LE(0, 12); // empty filesystem snapshot
  image.writeUInt32LE(0, 16); // empty lazy-file section
  image.writeUInt32LE(1, 20); // one byte of metadata
  image[24] = "{".charCodeAt(0); // invalid JSON
  return image;
}

async function vfsImage(
  metadata: VfsImageMetadata | null | undefined,
  compressed: boolean,
): Promise<Uint8Array> {
  const mfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
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
    writeFileSync(join(sourceRoot, "scripts", "dev-shell.sh"), "#!/bin/sh\n");
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
            KANDELO_DEV_SHELL_TOOL_PATH: "test",
            WASM_POSIX_BINARY_RESOLVER_REPO_ROOT: sourceRoot,
            CHECKER_BUILD_RECORD: buildRecord,
            WASM_POSIX_XTASK_BIN: "",
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(xtaskPath);
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

  it("falls back from a stale compressed VFS image to an ABI-matching candidate", async () => {
    const relPath = "programs/wasm32/__resolve_binary_test__/image.vfs.zst";
    writeCandidate(
      "local-binaries",
      relPath,
      await vfsImage({ version: 1, kernelAbi: ABI_VERSION - 1 }, true),
    );
    const fetchedPath = writeCandidate(
      "binaries",
      relPath,
      await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true),
    );

    const result = resolveBinary(relPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(fetchedPath);
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

  it.each([
    [
      "corrupt zstd compression",
      new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00]),
    ],
    ["malformed metadata", vfsWithMalformedMetadata()],
  ])("keeps a VFS image with %s fail-closed", (_description, bytes) => {
    const relPath = "programs/wasm32/__resolve_binary_test__/broken.vfs.zst";
    writeCandidate("local-binaries", relPath, bytes);

    const result = resolveBinary(relPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exists but was rejected by artifact policy");
  });

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

  it("falls back from an uninspectable local .wasm to a valid fetched candidate", () => {
    const relPath = "programs/wasm32/__resolve_binary_test__/fallback.wasm";
    writeCandidate(
      "local-binaries",
      relPath,
      new TextEncoder().encode("not a wasm module"),
    );
    const fetchedPath = writeCandidate(
      "binaries",
      relPath,
      executableWasmWithAbi(ABI_VERSION),
    );

    const result = resolveBinary(relPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(fetchedPath);
  });
});
