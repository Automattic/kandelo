import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openVfsProductBuild } from "../../images/vfs/scripts/vfs-product-builder-contract";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const SNAPSHOT_SHA256 = "b".repeat(64);
const cleanupDirectories = new Set<string>();

afterEach(() => {
  for (const directory of cleanupDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe("VFS product builder contract", () => {
  it("exposes only declared typed inputs and reports every exact disposition", async () => {
    const fixture = await createFixture();
    const build = await openVfsProductBuild(
      fixture.inputsPath,
      fixture.reportPath,
    );

    expect(build.inputIds()).toEqual([
      "candidate-base",
      "package-runtime",
      "repository-config",
      "shell-bottle",
      "source-code",
      "toolchain-sdk",
    ]);
    expect(build.inputIds("homebrew-bottle")).toEqual(["shell-bottle"]);
    expect(build.inputIds("package-output")).toEqual(["package-runtime"]);
    expect(build.inputIds("repository-path")).toEqual(["repository-config"]);
    expect(build.inputIds()).toBe(build.inputIds());
    expect(build.source).toEqual({
      commit: "f".repeat(40),
      repository: "kandelo-dev/kandelo",
      tree: "1".repeat(40),
    });
    expect(Object.isFrozen(build.source)).toBe(true);

    expect(() => build.requireProductImage("missing")).toThrow(/not declared/);
    expect(() => build.requirePackageOutput("candidate-base")).toThrow(
      /declared as product-image/,
    );

    expect(build.requireProductImage("candidate-base")).toEqual({
      id: "candidate-base",
      sha256: fixture.lazySha256,
      bytes: 14,
      placement: "lazy-reference",
      reference: `ghcr.io/kandelo-dev/homebrew-tap-core-abi-7-candidates/products/base@sha256:${fixture.lazySha256}`,
    });
    expect(build.requireHomebrewBottle("shell-bottle")).toMatchObject({
      id: "shell-bottle",
      placement: "embedded",
      path: join(fixture.directory, "files/shell.bottle"),
      descriptor: {
        path: join(fixture.directory, "files/shell-bottle-metadata.json"),
        sha256: fixture.bottleMetadataSha256,
        bytes: fixture.bottleMetadataBytes,
      },
    });

    await expect(build.finish(fixture.outputPath)).rejects.toThrow(
      /unconsumed.*package-runtime.*repository-config.*source-code.*toolchain-sdk/s,
    );
    expect(existsSync(fixture.reportPath)).toBe(false);

    expect(build.requirePackageOutput("package-runtime")).toMatchObject({
      placement: "embedded",
      path: join(fixture.directory, "files/runtime.wasm"),
    });
    expect(build.requireRepositoryPath("repository-config")).toMatchObject({
      placement: "embedded",
      path: join(fixture.directory, "files/demo.json"),
    });
    expect(build.requireSourceArchive("source-code")).toMatchObject({
      placement: "build-only",
      path: join(fixture.directory, "files/source.tar"),
    });
    expect(build.requireToolchainOutput("toolchain-sdk")).toMatchObject({
      placement: "build-only",
      path: join(fixture.directory, "files/sdk"),
    });

    await build.finish(fixture.outputPath);

    const reportBytes = readFileSync(fixture.reportPath, "utf8");
    expect(reportBytes.endsWith("\n")).toBe(true);
    expect(reportBytes).not.toContain("\n ");
    const report = JSON.parse(reportBytes);
    expect(report.capture).toEqual({ complete: true, unreported_reads: [] });
    expect(report.inputs).toEqual([
      expect.objectContaining({
        id: "candidate-base",
        placement: "lazy-reference",
      }),
      expect.objectContaining({ id: "package-runtime", placement: "embedded" }),
      expect.objectContaining({ id: "repository-config", placement: "embedded" }),
      expect.objectContaining({ id: "shell-bottle", placement: "embedded" }),
      expect.objectContaining({ id: "source-code", placement: "build-only" }),
      expect.objectContaining({ id: "toolchain-sdk", placement: "build-only" }),
    ]);
    expect(report.output.abi).toEqual({
      version: 7,
      snapshot_sha256: SNAPSHOT_SHA256,
    });
    expect(report.output.name).toBe("mini-shell.vfs");
  });

  it("accepts a content-addressed Pages URL only for an embedded canonical product", async () => {
    const fixture = await createFixture();
    const inputs = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const product = inputs.inputs.find((input: any) => input.id === "candidate-base");
    const bottle = inputs.inputs.find((input: any) => input.id === "shell-bottle");
    const productBytes = "lazy candidate";
    writeFileSync(join(fixture.directory, "files/base.vfs"), productBytes);
    inputs.reference_class = "canonical";
    Object.assign(product, {
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      path: "files/base.vfs",
      reference:
        `https://automattic.github.io/kandelo/products/base/sha256-${fixture.lazySha256}/` +
        `base-7.vfs.zst?sha256=${fixture.lazySha256}&bytes=14`,
    });
    bottle.descriptor.reference = bottle.descriptor.reference.replace("-candidates/", "/");
    writeFileSync(fixture.inputsPath, canonicalJson(inputs));

    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);
    expect(build.requireProductImage("candidate-base")).toMatchObject({
      bytes: 14,
      path: join(fixture.directory, "files/base.vfs"),
      placement: "embedded",
      sha256: fixture.lazySha256,
    });

    const lazyFixture = await createFixture();
    const lazy = JSON.parse(readFileSync(lazyFixture.inputsPath, "utf8"));
    lazy.reference_class = "canonical";
    lazy.inputs[0].reference =
      `https://automattic.github.io/kandelo/products/base/sha256-${lazyFixture.lazySha256}/` +
      `base-7.vfs.zst?sha256=${lazyFixture.lazySha256}&bytes=14`;
    lazy.inputs.find((input: any) => input.id === "shell-bottle").descriptor.reference =
      lazy.inputs.find((input: any) => input.id === "shell-bottle").descriptor.reference
        .replace("-candidates/", "/");
    writeFileSync(lazyFixture.inputsPath, canonicalJson(lazy));
    await expect(
      openVfsProductBuild(lazyFixture.inputsPath, lazyFixture.reportPath),
    ).rejects.toThrow(/Pages product reference requires embedded placement/);

    const hostileFixture = await createFixture();
    const hostile = JSON.parse(readFileSync(hostileFixture.inputsPath, "utf8"));
    hostile.reference_class = "canonical";
    hostile.inputs[0].reference =
      `https://attacker.invalid/kandelo/products/base/sha256-${hostileFixture.lazySha256}/` +
      `base-7.vfs.zst?sha256=${hostileFixture.lazySha256}&bytes=14`;
    hostile.inputs.find((input: any) => input.id === "shell-bottle").descriptor.reference =
      hostile.inputs.find((input: any) => input.id === "shell-bottle").descriptor.reference
        .replace("-candidates/", "/");
    writeFileSync(hostileFixture.inputsPath, canonicalJson(hostile));
    await expect(
      openVfsProductBuild(hostileFixture.inputsPath, hostileFixture.reportPath),
    ).rejects.toThrow(/managed input does not use a versioned namespace/);
  });

  it("accepts an exact canonical Pages URL for a lazy package input", async () => {
    const fixture = await createFixture();
    const inputs = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const packageInput = inputs.inputs.find(
      (input: { id: string }) => input.id === "package-runtime",
    );
    inputs.reference_class = "canonical";
    packageInput.declared_materialization = "lazy";
    packageInput.effective_materialization = "lazy-reference";
    delete packageInput.path;
    packageInput.reference =
      `https://automattic.github.io/kandelo/products/inputs/${packageInput.id}/` +
      `sha256-${packageInput.sha256}/${packageInput.id}` +
      `?sha256=${packageInput.sha256}&bytes=${packageInput.bytes}`;
    inputs.inputs = [packageInput];
    writeFileSync(fixture.inputsPath, canonicalJson(inputs));

    const build = await openVfsProductBuild(fixture.inputsPath, fixture.reportPath);
    expect(build.requirePackageOutput("package-runtime")).toEqual({
      bytes: packageInput.bytes,
      id: "package-runtime",
      placement: "lazy-reference",
      reference: packageInput.reference,
      sha256: packageInput.sha256,
    });
  });

  it("does not read lazy bytes and refuses undeclared toolchain outputs", async () => {
    const fixture = await createFixture();
    const build = await openVfsProductBuild(
      fixture.inputsPath,
      fixture.reportPath,
    );

    expect(existsSync(join(fixture.directory, "files/candidate-base"))).toBe(false);
    expect(build.requireProductImage("candidate-base")).toMatchObject({
      placement: "lazy-reference",
      reference: expect.stringContaining("@sha256:"),
    });
    expect(() => build.requireToolchainOutput("ambient-sdk-cache")).toThrow(
      /not declared/,
    );
  });

  it("accepts toolchain outputs declared as embedded runtime bytes", async () => {
    const fixture = await createFixture();
    const inputs = JSON.parse(readFileSync(fixture.inputsPath, "utf8"));
    const toolchain = inputs.inputs.find(
      (input: { id: string }) => input.id === "toolchain-sdk",
    );
    toolchain.role = "runtime";
    toolchain.declared_materialization = "embedded";
    toolchain.effective_materialization = "embedded";
    writeFileSync(fixture.inputsPath, canonicalJson(inputs));

    const build = await openVfsProductBuild(
      fixture.inputsPath,
      fixture.reportPath,
    );
    expect(build.requireToolchainOutput("toolchain-sdk")).toMatchObject({
      placement: "embedded",
      path: join(fixture.directory, "files/sdk"),
    });
  });

  it("writes no report when output ABI validation fails", async () => {
    for (const [options, expected] of [
      [{ outputSnapshotSha256: "c".repeat(64) }, /ABI snapshot SHA-256/],
      [{ outputAbiVersion: 8 }, /kernel ABI 8.*target ABI 7/],
    ] as const) {
      const fixture = await createFixture(options);
      const build = await openVfsProductBuild(
        fixture.inputsPath,
        fixture.reportPath,
      );
      consumeAll(build);

      await expect(build.finish(fixture.outputPath)).rejects.toThrow(expected);
      expect(existsSync(fixture.reportPath)).toBe(false);
    }
  });

  it("rejects tampered local bytes before exposing any handle", async () => {
    const fixture = await createFixture();
    writeFileSync(join(fixture.directory, "files/sdk"), "tampered");

    await expect(
      openVfsProductBuild(fixture.inputsPath, fixture.reportPath),
    ).rejects.toThrow(/toolchain-sdk.*(byte count|SHA-256)/);
    expect(existsSync(fixture.reportPath)).toBe(false);
  });

  it("requires and authenticates bottle composition metadata", async () => {
    const missing = await createFixture();
    const missingInputs = JSON.parse(readFileSync(missing.inputsPath, "utf8"));
    delete missingInputs.inputs.find(
      (input: { id: string }) => input.id === "shell-bottle",
    ).descriptor;
    writeFileSync(missing.inputsPath, canonicalJson(missingInputs));
    await expect(
      openVfsProductBuild(missing.inputsPath, missing.reportPath),
    ).rejects.toThrow(/requires authenticated composition metadata/);

    const tampered = await createFixture();
    writeFileSync(
      join(tampered.directory, "files/shell-bottle-metadata.json"),
      '{"formula":"other"}\n',
    );
    await expect(
      openVfsProductBuild(tampered.inputsPath, tampered.reportPath),
    ).rejects.toThrow(/descriptor (byte count|SHA-256)/);
  });
});

function consumeAll(build: Awaited<ReturnType<typeof openVfsProductBuild>>): void {
  build.requireProductImage("candidate-base");
  build.requirePackageOutput("package-runtime");
  build.requireRepositoryPath("repository-config");
  build.requireHomebrewBottle("shell-bottle");
  build.requireSourceArchive("source-code");
  build.requireToolchainOutput("toolchain-sdk");
}

async function createFixture(
  options: {
    outputSnapshotSha256?: string;
    outputAbiVersion?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-vfs-builder-contract-"));
  cleanupDirectories.add(directory);
  const inputFiles = {
    "package-runtime": ["files/runtime.wasm", "runtime package"],
    "repository-config": ["files/demo.json", "demo config"],
    "shell-bottle": ["files/shell.bottle", "shell bottle"],
    "source-code": ["files/source.tar", "source archive"],
    "toolchain-sdk": ["files/sdk", "sdk output"],
  } as const;
  for (const [, [path, contents]] of Object.entries(inputFiles)) {
    const output = join(directory, path);
    const parent = output.slice(0, output.lastIndexOf("/"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(parent, { recursive: true });
    writeFileSync(output, contents);
  }
  const bottleMetadata = '{"formula":"shell-bottle"}\n';
  writeFileSync(
    join(directory, "files/shell-bottle-metadata.json"),
    bottleMetadata,
  );

  const lazySha256 = sha256("lazy candidate");
  const makeInput = (
    id: keyof typeof inputFiles,
    kind: string,
    role: "runtime" | "build",
    placement: "embedded" | "build-only",
  ) => {
    const [path, contents] = inputFiles[id];
    return {
      architecture: "wasm32",
      bytes: Buffer.byteLength(contents),
      declared_materialization: placement,
      effective_materialization: placement,
      id,
      kind,
      path,
      role,
      sha256: sha256(contents),
    };
  };
  const inputs = {
    build_environment: {
      dev_shell_lock_sha256: "d".repeat(64),
      policy_sha256: "e".repeat(64),
    },
    inputs: [
      {
        architecture: "wasm32",
        bytes: 14,
        declared_materialization: "lazy",
        effective_materialization: "lazy-reference",
        id: "candidate-base",
        kind: "product-image",
        reference: `ghcr.io/kandelo-dev/homebrew-tap-core-abi-7-candidates/products/base@sha256:${lazySha256}`,
        role: "runtime",
        sha256: lazySha256,
      },
      makeInput("package-runtime", "package-output", "runtime", "embedded"),
      makeInput("repository-config", "repository-path", "runtime", "embedded"),
      {
        ...makeInput("shell-bottle", "homebrew-bottle", "runtime", "embedded"),
        descriptor: {
          bytes: Buffer.byteLength(bottleMetadata),
          path: "files/shell-bottle-metadata.json",
          reference: `ghcr.io/kandelo-dev/homebrew-tap-core-abi-7-candidates/shell@sha256:${sha256(bottleMetadata)}`,
          sha256: sha256(bottleMetadata),
        },
      },
      makeInput("source-code", "source-archive", "build", "build-only"),
      makeInput("toolchain-sdk", "toolchain-output", "build", "build-only"),
    ],
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: "wasm32",
      id: "mini-shell",
      manifest_path: "images/vfs/products/mini-shell.toml",
      manifest_sha256: "a".repeat(64),
      output: "mini-shell.vfs",
    },
    reference_class: "candidate",
    schema: 1,
    source: {
      commit: "f".repeat(40),
      repository: "kandelo-dev/kandelo",
      tree: "1".repeat(40),
    },
    target_abi: { snapshot_sha256: SNAPSHOT_SHA256, version: 7 },
  };
  const inputsPath = join(directory, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJson(inputs));

  const vfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  const outputBytes = await vfs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: options.outputAbiVersion ?? 7,
      abiSnapshotSha256:
        options.outputSnapshotSha256 ?? SNAPSHOT_SHA256,
    },
  });
  const outputPath = join(directory, "mini-shell.vfs");
  writeFileSync(outputPath, outputBytes);
  return {
    directory,
    inputsPath,
    reportPath: join(directory, "builder-report.json"),
    outputPath,
    lazySha256,
    bottleMetadataSha256: sha256(bottleMetadata),
    bottleMetadataBytes: Buffer.byteLength(bottleMetadata),
  };
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
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
