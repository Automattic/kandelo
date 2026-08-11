import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runFlatHomebrewVfsImageBuilder,
} from "../../images/vfs/scripts/build-homebrew-flat-vfs-image";
import type { HomebrewBottleDependencyIdentity } from "../src/homebrew-bottle-descriptor";
import { resolveHomebrewVfsResourcePolicy } from "../src/homebrew-vfs-resource-policy";
import { ensureDirRecursive, writeVfsFile } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  homebrewTestBootstrapFixture,
  homebrewTestBottleDescriptor,
  homebrewTestBottleEntry,
  homebrewTestBottleTar,
  homebrewTestReceipt,
  homebrewTestRuntimeZip,
  homebrewTestSelectionBytes,
} from "./fixtures/homebrew-flat-vfs";

const OUTPUT_FILENAME =
  "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst";
const SHELL_CONFIG = fileURLToPath(
  new URL("../../homebrew/main-shell-default.json", import.meta.url),
);
const DEMO_CONFIG = fileURLToPath(
  new URL("../../homebrew/main-shell-demo.json", import.meta.url),
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("flat Homebrew VFS CLI", () => {
  it("fetches an independent closure once, reuses its exact cache, and emits a deterministic eager image", async () => {
    const fixture = await createFixture();
    const firstDirectory = temporaryDirectory("flat-vfs-first-");
    const secondDirectory = temporaryDirectory("flat-vfs-second-");
    const cache = temporaryDirectory("flat-vfs-cache-");
    const first = outputPaths(firstDirectory);
    const second = outputPaths(secondDirectory);
    const originalSelection = readFileSync(fixture.selection);
    const fetched: string[] = [];

    const firstResult = await runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, first),
      {
        async fetchBottleBytes(url, options) {
          fetched.push(url);
          const bytes = fixture.bottlesByUrl.get(url);
          if (bytes === undefined) throw new Error(`unexpected bottle URL: ${url}`);
          expect(options.expectedBytes).toBe(bytes.byteLength);
          return Uint8Array.from(bytes);
        },
      },
    );

    expect(fetched).toEqual(fixture.descriptors.map((item) => item.url));
    expect(firstResult.cleanupWarnings).toEqual([]);
    expect(readFileSync(fixture.selection)).toEqual(originalSelection);

    for (const descriptor of fixture.descriptors) {
      const cached = join(cache, `${descriptor.sha256}.tar.gz`);
      expect(Uint8Array.from(readFileSync(cached))).toEqual(
        fixture.bottlesByUrl.get(descriptor.url),
      );
      expect(lstatSync(cached).mode & 0o777).toBe(0o600);
    }

    const secondResult = await runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, second),
      {
        fetchBottleBytes: vi.fn(async () => {
          throw new Error("a complete exact cache must not fetch");
        }),
      },
    );

    expect(secondResult.cleanupWarnings).toEqual([]);
    expect(readFileSync(second.image)).toEqual(readFileSync(first.image));
    expect(readFileSync(second.report)).toEqual(readFileSync(first.report));
    expect(lstatSync(first.image).mode & 0o777).toBe(0o600);
    expect(lstatSync(first.report).mode & 0o777).toBe(0o600);

    const imageBytes = Uint8Array.from(readFileSync(first.image));
    const restored = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
    await restored.verifyImportedLazyAtomicGroupSeals();
    expect(restored.getImageMetadata()).toMatchObject({
      version: 1,
      kernelAbi: 42,
      createdBy: "images/vfs/scripts/build-homebrew-flat-vfs-image.ts",
      homebrewFlat: {
        selectionSha256: sha(originalSelection),
        requestedVfsFilename: OUTPUT_FILENAME,
      },
    });
    expect(restored.getImageMetadata()).not.toHaveProperty("demoConfig");
    expect(MemoryFileSystem.readImageCapacity(imageBytes).maxByteLength).toBe(
      resolveHomebrewVfsResourcePolicy(
        "kandelo-homebrew-vfs-generous-v1",
      ).vfs.maxByteLength,
    );
    expect(restored.exportLazyEntries()).toEqual([]);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
    expect(restored.readlink("/usr/bin/brew")).toBe(
      "/opt/kandelo/homebrew/bin/brew",
    );
    expect(restored.readlink("/opt/kandelo/homebrew/bin/hello")).toBe(
      fixture.hello.keg + "/bin/hello",
    );
    expect(readVfsText(restored, "/etc/kandelo/shell.json")).toBe(
      readFileSync(SHELL_CONFIG, "utf8"),
    );
    expect(restored.stat("/opt/kandelo/homebrew/bin/bash").mode & 0o111)
      .not.toBe(0);
    expect(JSON.parse(readVfsText(
      restored,
      "/etc/kandelo/homebrew-vfs.json",
    ))).toMatchObject({
      selection_sha256: sha(originalSelection),
      packages: [
        { full_name: fixture.bootstrap.fullName },
        { full_name: fixture.hello.fullName },
      ],
    });

    const report = JSON.parse(readFileSync(first.report, "utf8"));
    expect(report).toMatchObject({
      schema: 1,
      selection: {
        sha256: sha(originalSelection),
        bytes: originalSelection.byteLength,
      },
      image: {
        filename: OUTPUT_FILENAME,
        sha256: sha(imageBytes),
        bytes: imageBytes.byteLength,
      },
      build_report: {
        selection_sha256: sha(originalSelection),
      },
    });
    expect(report).not.toHaveProperty("demo_config");
    expect(JSON.stringify(report)).not.toMatch(
      /campaign|handoff|provenance|promotion|signature|trust/i,
    );
  }, 30_000);

  it("installs and binds the exact optional browser demo configuration", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-demo-cache-");
    const output = outputPaths(temporaryDirectory("flat-vfs-demo-output-"));
    const demoBytes = Uint8Array.from(readFileSync(DEMO_CONFIG));

    const result = await runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, output, DEMO_CONFIG),
      {
        fetchBottleBytes: async (url) =>
          Uint8Array.from(fixture.bottlesByUrl.get(url)!),
      },
    );

    const restored = MemoryFileSystem.fromImagePreservingCapacity(
      Uint8Array.from(readFileSync(output.image)),
    );
    const expectedBinding = {
      path: "/etc/kandelo/demo.json",
      sha256: sha(demoBytes),
      bytes: demoBytes.byteLength,
    };
    expect(readVfsText(restored, "/etc/kandelo/demo.json")).toBe(
      readFileSync(DEMO_CONFIG, "utf8"),
    );
    expect(restored.getImageMetadata()?.demoConfig).toEqual(expectedBinding);
    expect(result.report.demo_config).toEqual(expectedBinding);
    expect(JSON.parse(readFileSync(output.report, "utf8")).demo_config)
      .toEqual(expectedBinding);
  }, 30_000);

  it("rejects malformed demo JSON before fetching bottles", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-bad-demo-cache-");
    const fetchBottleBytes = vi.fn(fixtureFetcher(fixture));
    const malformed = join(temporaryDirectory("flat-vfs-bad-demo-"), "demo.json");
    writeFileSync(malformed, "{not-json\n");
    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(
        fixture,
        cache,
        outputPaths(temporaryDirectory("flat-vfs-bad-demo-output-")),
        malformed,
      ),
      { fetchBottleBytes },
    )).rejects.toThrow(/demo config.*valid JSON/i);
    expect(fetchBottleBytes).not.toHaveBeenCalled();
  });

  it("rejects a symlinked demo input before fetching bottles", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-demo-link-cache-");
    const fetchBottleBytes = vi.fn(fixtureFetcher(fixture));
    const demoLink = join(temporaryDirectory("flat-vfs-demo-link-"), "demo.json");
    symlinkSync(DEMO_CONFIG, demoLink);
    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(
        fixture,
        cache,
        outputPaths(temporaryDirectory("flat-vfs-demo-link-output-")),
        demoLink,
      ),
      { fetchBottleBytes },
    )).rejects.toThrow(/demo config.*regular non-symlink/i);
    expect(fetchBottleBytes).not.toHaveBeenCalled();
  });

  it("refuses to replace a demo configuration already owned by the base", async () => {
    const fixture = await createFixture({ existingDemoConfig: true });
    const cache = temporaryDirectory("flat-vfs-existing-demo-cache-");
    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(
        fixture,
        cache,
        outputPaths(temporaryDirectory("flat-vfs-existing-demo-output-")),
        DEMO_CONFIG,
      ),
      { fetchBottleBytes: fixtureFetcher(fixture) },
    )).rejects.toThrow(/refusing to overwrite existing demo config/i);
  }, 30_000);

  it("rejects a base with pending lazy backing before any bottle fetch", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-cache-");
    const output = outputPaths(temporaryDirectory("flat-vfs-output-"));
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    baseFs.registerLazyFile(
      "/usr/bin/deferred",
      "https://example.invalid/deferred.wasm",
      100,
      0o755,
    );
    writeFileSync(fixture.base, await baseFs.saveImage({
      metadata: { version: 1, kernelAbi: 42, createdBy: "lazy-base-test" },
      normalizeTimestampsMs: 0,
    }));
    const fetchBottleBytes = vi.fn(async () => new Uint8Array());

    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, output),
      { fetchBottleBytes },
    )).rejects.toThrow(/base image must be self-contained.*pending lazy backing/s);
    expect(fetchBottleBytes).not.toHaveBeenCalled();
    expect(existsSync(output.image)).toBe(false);
    expect(existsSync(output.report)).toBe(false);
  });

  it("does not fetch past a malformed existing digest cache entry", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-cache-");
    const output = outputPaths(temporaryDirectory("flat-vfs-output-"));
    const first = fixture.descriptors[0]!;
    writeFileSync(join(cache, `${first.sha256}.tar.gz`), "not the bottle");
    const fetchBottleBytes = vi.fn(async () => new Uint8Array());

    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, output),
      { fetchBottleBytes },
    )).rejects.toThrow(/cache entry.*expected.*bytes/s);
    expect(fetchBottleBytes).not.toHaveBeenCalled();
    expect(existsSync(output.image)).toBe(false);
    expect(existsSync(output.report)).toBe(false);
  });

  it("reads the shell descriptor only through the bounded no-follow input", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-cache-");
    const output = outputPaths(temporaryDirectory("flat-vfs-output-"));
    const shellLink = join(temporaryDirectory("flat-vfs-shell-"), "shell.json");
    symlinkSync(SHELL_CONFIG, shellLink);
    fixture.shellConfig = shellLink;
    const fetchBottleBytes = vi.fn(async () => new Uint8Array());

    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, output),
      { fetchBottleBytes },
    )).rejects.toThrow(/shell config.*regular non-symlink/s);
    expect(fetchBottleBytes).not.toHaveBeenCalled();
  });

  it("rejects same-size fetched bytes with the wrong digest before caching", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-cache-");
    const output = outputPaths(temporaryDirectory("flat-vfs-output-"));
    const first = fixture.descriptors[0]!;
    const corrupt = Uint8Array.from(fixture.bottlesByUrl.get(first.url)!);
    corrupt[corrupt.byteLength - 1] ^= 1;

    await expect(runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, output),
      { fetchBottleBytes: async () => corrupt },
    )).rejects.toThrow(/fetched bottle.*expected.*got/s);
    expect(existsSync(join(cache, `${first.sha256}.tar.gz`))).toBe(false);
    expect(existsSync(output.image)).toBe(false);
    expect(existsSync(output.report)).toBe(false);
  });

  it("returns post-publication cleanup warnings without embedding them in the report", async () => {
    const fixture = await createFixture();
    const cache = temporaryDirectory("flat-vfs-cache-");
    const output = outputPaths(temporaryDirectory("flat-vfs-output-"));
    let reportBytes: Uint8Array | undefined;

    const result = await runFlatHomebrewVfsImageBuilder(
      cliArgs(fixture, cache, output),
      {
        fetchBottleBytes: async (url) =>
          Uint8Array.from(fixture.bottlesByUrl.get(url)!),
        publishOutputs(outputs) {
          reportBytes = Uint8Array.from(outputs[1]!.bytes);
          return { cleanupWarnings: ["injected post-publication cleanup warning"] };
        },
      },
    );

    expect(result.cleanupWarnings).toContain(
      "injected post-publication cleanup warning",
    );
    expect(new TextDecoder().decode(reportBytes)).not.toContain(
      "cleanup warning",
    );
    expect(JSON.stringify(result.report)).not.toContain("cleanup warning");
  });
});

async function createFixture(
  options: { existingDemoConfig?: boolean } = {},
) {
  const directory = temporaryDirectory("flat-vfs-input-");
  const runtimeZip = homebrewTestRuntimeZip({
    "bin/bash": {
      data: "#!/bin/sh\nexec /bin/sh \"$@\"\n",
      mode: 0o100755,
    },
  });
  const bootstrapFixture = homebrewTestBootstrapFixture({ zip: runtimeZip });
  const bootstrap = bootstrapFixture.descriptor;
  const dependency: HomebrewBottleDependencyIdentity = {
    fullName: bootstrap.fullName,
    version: bootstrap.version,
    revision: bootstrap.revision,
    bottleRebuild: bootstrap.bottleRebuild,
    bottleSha256: bootstrap.sha256,
  };
  const helloBottle = homebrewTestBottleTar([
    homebrewTestBottleEntry(
      "hello",
      "2.12.1",
      ".brew/hello.rb",
      "class Hello < Formula\nend\n",
    ),
    homebrewTestBottleEntry(
      "hello",
      "2.12.1",
      "INSTALL_RECEIPT.json",
      homebrewTestReceipt([{
        full_name: bootstrap.fullName,
        version: bootstrap.version,
        pkg_version: bootstrap.version,
        revision: bootstrap.revision,
        declared_directly: true,
      }]),
    ),
    homebrewTestBottleEntry(
      "hello",
      "2.12.1",
      "bin/hello",
      "#!/bin/sh\necho hello\n",
      0o755,
    ),
  ]);
  const hello = homebrewTestBottleDescriptor({
    name: "hello",
    version: "2.12.1",
    bottle: helloBottle,
    dependencies: [dependency],
    links: [{
      type: "symlink",
      source: "Cellar/hello/2.12.1/bin/hello",
      target: "bin/hello",
    }],
    pathPrepend: ["bin"],
  });
  const selectionBytes = homebrewTestSelectionBytes([bootstrap, hello]);
  const selection = join(directory, "selection.json");
  writeFileSync(selection, selectionBytes);

  const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  writeVfsFile(baseFs, "/base-marker", "eager base\n", 0o644);
  if (options.existingDemoConfig) {
    ensureDirRecursive(baseFs, "/etc/kandelo");
    writeVfsFile(baseFs, "/etc/kandelo/demo.json", "{}\n", 0o644);
  }
  const base = join(directory, "base.vfs");
  writeFileSync(base, await baseFs.saveImage({
    metadata: { version: 1, kernelAbi: 42, createdBy: "flat-cli-test" },
    normalizeTimestampsMs: 0,
  }));

  const descriptors = [bootstrap, hello];
  return {
    selection,
    base,
    shellConfig: SHELL_CONFIG,
    descriptors,
    bootstrap,
    hello,
    bottlesByUrl: new Map<string, Uint8Array>([
      [bootstrap.url, bootstrapFixture.bottle],
      [hello.url, helloBottle],
    ]),
  };
}

function outputPaths(directory: string) {
  return {
    image: join(directory, OUTPUT_FILENAME),
    report: join(directory, "build-report.json"),
  };
}

function cliArgs(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  cache: string,
  output: ReturnType<typeof outputPaths>,
  demoConfig?: string,
): string[] {
  return [
    "--selection", fixture.selection,
    "--base-image", fixture.base,
    "--bottle-cache", cache,
    "--shell-config", fixture.shellConfig,
    ...(demoConfig === undefined ? [] : ["--demo-config", demoConfig]),
    "--out", output.image,
    "--report", output.report,
  ];
}

function fixtureFetcher(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): (url: string) => Promise<Uint8Array> {
  return async (url) => {
    const bytes = fixture.bottlesByUrl.get(url);
    if (bytes === undefined) throw new Error(`unexpected bottle URL: ${url}`);
    return Uint8Array.from(bytes);
  };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const descriptor = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        descriptor,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) throw new Error(`short VFS read: ${path}`);
      offset += count;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(descriptor);
  }
}
