import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HomebrewFlatLazyVfsReport } from "../src/homebrew-flat-lazy-vfs-composer";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("flat-selection lazy Homebrew VFS CLI", () => {
  it("is the canonical shell package path with its selected bootstrap companion", () => {
    const packageToml = readFileSync(
      join(repoRoot, "packages/registry/shell/package.toml"),
      "utf8",
    );
    const buildToml = readFileSync(
      join(repoRoot, "packages/registry/shell/build.toml"),
      "utf8",
    );
    const buildScript = readFileSync(
      join(repoRoot, "packages/registry/shell/build-shell.sh"),
      "utf8",
    );

    expect(packageToml).toContain(
      'depends_on = ["homebrew-bootstrap@6.0.12-153-gcf5bc21"]',
    );
    expect(buildToml).toMatch(/^revision\s*=\s*26$/m);
    for (const input of [
      "homebrew/main-shell-materialization-policy.json",
      "homebrew/main-shell-runtime-support-policy.json",
      "images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts",
      "host/src/homebrew-flat-lazy-vfs-composer.ts",
    ]) {
      expect(buildToml).toContain(`"${input}"`);
    }
    expect(buildScript).toContain(
      "WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR",
    );
    expect(buildScript).toContain("build-homebrew-flat-lazy-vfs-image.ts");
    expect(buildScript).toContain("--materialization-policy");
    expect(buildScript).toContain("--runtime-support-policy");
    expect(buildScript).toContain("--bootstrap-zip");
    expect(buildScript).toContain("--bootstrap-env");
    expect(buildScript).toContain("--mirror-repository");
    expect(buildScript).toContain("--mirror-out");
    expect(buildScript).toMatch(/-ge\s+10485760/);
    expect(buildScript).not.toMatch(
      /scripts\/build-homebrew-flat-vfs-image\.ts(?:"|\s)/,
    );
  });

  it("accepts the complete canonical input set without implicit authorities", async () => {
    const cliPath = join(
      repoRoot,
      "images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts",
    );
    expect(existsSync(cliPath), "canonical lazy CLI must exist").toBe(true);
    const cli = await import(cliPath);
    const args = [
      "--selection", "selection.json",
      "--materialization-policy", "materialization.json",
      "--runtime-support-policy", "runtime.json",
      "--base-image", "platform.vfs.zst",
      "--bootstrap-zip", "homebrew-bootstrap.zip",
      "--bootstrap-env", "homebrew-brew.env",
      "--bottle-cache", "bottles",
      "--mirror-repository", "kandelo-dev/homebrew-tap-core",
      "--mirror-out", "mirror",
      "--shell-config", "shell.json",
      "--demo-config", "demo.json",
      "--out", "shell.vfs.zst",
      "--report", "report.json",
    ];

    expect(cli.parseFlatHomebrewLazyVfsArgs(args)).toEqual({
      selection: "selection.json",
      materializationPolicy: "materialization.json",
      runtimeSupportPolicy: "runtime.json",
      baseImage: "platform.vfs.zst",
      bootstrapZip: "homebrew-bootstrap.zip",
      bootstrapEnv: "homebrew-brew.env",
      bottleCache: "bottles",
      mirrorRepository: "kandelo-dev/homebrew-tap-core",
      mirrorOut: "mirror",
      shellConfig: "shell.json",
      demoConfig: "demo.json",
      out: "shell.vfs.zst",
      report: "report.json",
    });
  });

  it("binds the source-built bootstrap companion to the selected support bytes", () => {
    const selection = JSON.parse(readFileSync(
      join(repoRoot, "homebrew/main-shell-flat-selection.json"),
      "utf8",
    ));
    const descriptor = selection.bottles.find(
      (bottle: { fullName?: string }) =>
        bottle.fullName === "kandelo-dev/tap-core/homebrew-bootstrap",
    );
    const outputs = new Map(
      descriptor.supportOutputs.map((output: { name: string }) => [
        output.name,
        output,
      ]),
    );
    const packageToml = readFileSync(
      join(repoRoot, "packages/registry/homebrew-bootstrap/package.toml"),
      "utf8",
    );
    const buildToml = readFileSync(
      join(repoRoot, "packages/registry/homebrew-bootstrap/build.toml"),
      "utf8",
    );
    const sourceLock = JSON.parse(readFileSync(
      join(repoRoot, "homebrew/homebrew-bootstrap-source-lock.json"),
      "utf8",
    ));

    expect(packageToml).toContain('version = "6.0.12-153-gcf5bc21"');
    expect(packageToml).toMatch(/^kernel_abi\s*=\s*42$/m);
    expect(buildToml).toMatch(/^revision\s*=\s*6$/m);
    expect(sourceLock.package.version).toBe("6.0.12-153-gcf5bc21");
    expect(sourceLock.source.revision).toBe(
      "cf5bc21c6b127e168ef7cfa982ba7db62874690e",
    );
    expect(sourceLock.outputs).toEqual({
      archive: {
        path: "homebrew-bootstrap.zip",
        sha256: outputs.get("homebrew-bootstrap").sha256,
        bytes: outputs.get("homebrew-bootstrap").bytes,
      },
      environment: {
        path: "homebrew-brew.env",
        sha256: outputs.get("homebrew-brew").sha256,
        bytes: outputs.get("homebrew-brew").bytes,
      },
    });
  });

  it("publishes a compressed artifact identity instead of raw VFS bytes", async () => {
    const cli = await import(join(
      repoRoot,
      "images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts",
    ));
    const maxByteLength = 8 * 1024 * 1024;
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(1024 * 1024, { maxByteLength }),
      maxByteLength,
    );
    const metadata = {
      version: 1 as const,
      kernelAbi: 42,
      createdBy: "compressed lazy CLI fixture",
    };
    const raw = await fs.saveImage({ metadata, normalizeTimestampsMs: 0 });
    const report = {
      metadata,
      selection: { requestedVfsFilename: "shell.vfs.zst" },
      image: {
        sha256: createHash("sha256").update(raw).digest("hex"),
        bytes: raw.byteLength,
        capacity: MemoryFileSystem.readImageCapacity(raw),
      },
    } as unknown as HomebrewFlatLazyVfsReport;

    const artifact = await cli.serializeFlatHomebrewLazyVfsArtifact(
      fs,
      report,
      0,
    );

    expect([...artifact.bytes.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(artifact.bytes.byteLength).toBeLessThan(raw.byteLength);
    expect(artifact.rawBytes).toBe(raw.byteLength);
    expect(artifact.report.image).toEqual({
      ...report.image,
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
      bytes: artifact.bytes.byteLength,
    });
    expect(MemoryFileSystem.readImageCapacity(artifact.bytes)).toEqual(
      report.image.capacity,
    );
  });
});
