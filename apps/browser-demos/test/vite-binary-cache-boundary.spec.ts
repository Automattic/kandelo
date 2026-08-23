import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  build as viteBuild,
  createServer,
  normalizePath,
  type ViteDevServer,
} from "vite";
import { binaryProgramCacheRoot } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { createBinaryDevAccess } from "../binary-dev-access";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
let cachedRustHostTarget: string | null = null;

function fsUrl(origin: string, file: string): string {
  const normalized = normalizePath(file).replace(/^\//, "");
  return `${origin}/@fs/${encodeURI(normalized)}`;
}

function generatedEntryDirectory(namespace: string): string {
  // Keep generated imports under the ignored build tree. If a browser worker
  // crashes before `finally`, the next source scan must not mistake a leftover
  // concrete fixture import for authored browser-package policy.
  return join(repoRoot, "target", "browser-test-runs", namespace);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uleb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function wasmSection(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function wasmName(name: string): number[] {
  const encoded = new TextEncoder().encode(name);
  return [...uleb128(encoded.length), ...encoded];
}

function executableWasmWithAbi(abi: number): Buffer {
  const body = (immediate: number) => [0x04, 0x00, 0x41, immediate, 0x0b];
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, [0x01, 0x60, 0x00, 0x01, 0x7f]),
    ...wasmSection(3, [0x02, 0x00, 0x00]),
    ...wasmSection(7, [
      0x02,
      ...wasmName("__abi_version"), 0x00, 0x00,
      ...wasmName("_start"), 0x00, 0x01,
    ]),
    ...wasmSection(10, [0x02, ...body(abi), ...body(0)]),
  ]);
}

function writeSourceOnlyViteFixture(
  root: string,
  packageName: string,
): { artifact: string; bytes: Buffer; relPath: string } {
  const sourceArtifact = `${packageName}.wasm`;
  const relPath = `programs/wasm32/${sourceArtifact}`;
  const artifact = join(root, relPath);
  const bytes = executableWasmWithAbi(ABI_VERSION);
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, bytes, { mode: 0o755 });
  chmodSync(artifact, 0o755);

  const manifestSha256 = "1".repeat(64);
  const cacheKeySha256 = "2".repeat(64);
  const authority = {
    format: "kandelo-source-only-program-projection-v1",
    projection: {
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
          members: [{
            kind: "output",
            sourceArtifact,
            mirrorPath: sourceArtifact,
            outputName: packageName,
            forkInstrumentation: "disabled",
          }],
        },
      },
    },
    graphAuthoritySha256: "4".repeat(64),
    nodes: [{
      node: { kind: "package", name: packageName, targetArch: "wasm32" },
      manifestSha256,
      cacheKeySha256,
      cacheReceiptSha256: "5".repeat(64),
      members: [{
        sourceArtifact,
        mirrorPath: relPath,
        mode: 0o755,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      }],
    }],
  };
  const metadataRoot = join(root, ".kandelo");
  mkdirSync(metadataRoot, { recursive: true });
  const projectionPath = join(
    metadataRoot,
    "source-only-program-projection-v1.json",
  );
  writeFileSync(projectionPath, `${JSON.stringify(authority)}\n`, {
    mode: 0o644,
  });
  chmodSync(projectionPath, 0o644);
  return { artifact, bytes, relPath };
}

function registryStackWithFixture(fixtureRegistryRoot: string): string {
  // The Vite config resolves the complete authored browser graph, not only
  // this test's generated import. Keep the real registry behind the synthetic
  // fixture so unrelated mirrors remain package-owned and cannot fall through
  // to scalar resolution merely because the test replaced their projection.
  return [
    fixtureRegistryRoot,
    join(repoRoot, "packages", "registry"),
  ].join(":");
}

function rustHostTarget(): string {
  if (cachedRustHostTarget !== null) return cachedRustHostTarget;
  const output =
    process.env.KANDELO_DEV_SHELL_TOOL_PATH !== undefined
      ? execFileSync("rustc", ["-vV"], {
          cwd: repoRoot,
          encoding: "utf8",
        })
      : execFileSync(
          "bash",
          [join(repoRoot, "scripts", "dev-shell.sh"), "rustc", "-vV"],
          {
            cwd: repoRoot,
            encoding: "utf8",
          },
        );
  cachedRustHostTarget =
    output
      .split(/\r?\n/)
      .find((line) => line.startsWith("host: "))
      ?.slice("host: ".length)
      .trim() ?? null;
  if (cachedRustHostTarget === null) {
    throw new Error("could not determine the Rust host target");
  }
  return cachedRustHostTarget;
}

function writeProgramProjection(
  registryRoot: string,
  packageName: string,
): string {
  const manifest = [
    'kind = "program"',
    `name = ${JSON.stringify(packageName)}`,
    'version = "1.0.0"',
    'arches = ["wasm32"]',
    "depends_on = []",
    "",
    "[source]",
    'url = "https://example.invalid/vite-cache-boundary.tar.gz"',
    `sha256 = "${"a".repeat(64)}"`,
    "",
    "[license]",
    'spdx = "MIT"',
    "",
    "[[outputs]]",
    'name = "artifact"',
    'wasm = "artifact.dat"',
    'fork_instrumentation = "disabled"',
    "",
    "[[outputs]]",
    'name = "sidecar"',
    'wasm = "sidecar.dat"',
    'fork_instrumentation = "disabled"',
    "",
  ].join("\n");
  const packageRoot = join(registryRoot, packageName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.toml"), manifest);
  const indexPath = join(registryRoot, "program-packages.json");
  const indexArgs = [
    "build-deps",
    "program-index",
    registryRoot,
    indexPath,
  ];
  const registryStack = registryStackWithFixture(registryRoot);
  const environment = {
    ...process.env,
    WASM_POSIX_DEPS_REGISTRY: registryStack,
  };
  // The source checkout deliberately rejects hand-authored cache identities.
  // Generate this synthetic registry through the same Rust manifest parser and
  // cache-key implementation that Vite rechecks before serving package bytes.
  const preparedXtask = process.env.WASM_POSIX_XTASK_BIN;
  if (preparedXtask !== undefined) {
    // WHY: Portable CI workspaces carry the exact release checker but omit
    // Cargo fingerprints. Rebuilding it inside this 120-second browser test
    // would relink the same checker and spend the assertion budget on setup.
    // If the transported path is invalid, fail instead of silently rebuilding
    // a checker that might not match the workspace under test.
    execFileSync(preparedXtask, indexArgs, {
      cwd: repoRoot,
      env: environment,
      stdio: "pipe",
    });
  } else {
    const cargoArgs = [
      "run",
      "--release",
      "--quiet",
      "-p",
      "xtask",
      "--target",
      rustHostTarget(),
      "--",
      ...indexArgs,
    ];
    if (process.env.KANDELO_DEV_SHELL_TOOL_PATH !== undefined) {
      execFileSync("cargo", cargoArgs, {
        cwd: repoRoot,
        env: environment,
        stdio: "pipe",
      });
    } else {
      execFileSync(
        "bash",
        [
          join(repoRoot, "scripts", "dev-shell.sh"),
          "env",
          `WASM_POSIX_DEPS_REGISTRY=${registryStack}`,
          "cargo",
          ...cargoArgs,
        ],
        {
          cwd: repoRoot,
          env: process.env,
          stdio: "pipe",
        },
      );
    }
  }
  const projection = JSON.parse(readFileSync(indexPath, "utf8")) as {
    packages?: Record<string, { cacheKeys?: { wasm32?: unknown } }>;
  };
  const cacheKey = projection.packages?.[packageName]?.cacheKeys?.wasm32;
  if (typeof cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(cacheKey)) {
    throw new Error(
      `canonical program projection omitted the wasm32 cache key for ${packageName}`,
    );
  }
  return cacheKey;
}

test("synthetic projections reuse an explicitly prepared checker and fail closed", () => {
  const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
  const testRoot = mkdtempSync(join(tmpdir(), "kandelo-vite-projection-"));
  const checker = join(testRoot, "prepared-xtask");
  const marker = join(testRoot, "checker-args.json");
  const registryRoot = join(testRoot, "registry");
  const packageName = "prepared-checker-fixture";
  const cacheKey = "b".repeat(64);

  try {
    writeFileSync(
      checker,
      [
        "#!/usr/bin/env node",
        'const { writeFileSync } = require("node:fs");',
        `const expected = ${JSON.stringify([
          "build-deps",
          "program-index",
          registryRoot,
          join(registryRoot, "program-packages.json"),
        ])};`,
        "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(93);",
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
        `writeFileSync(expected[3], ${JSON.stringify(
          JSON.stringify({
            packages: {
              [packageName]: { cacheKeys: { wasm32: cacheKey } },
            },
          }),
        )});`,
        "",
      ].join("\n"),
    );
    chmodSync(checker, 0o755);
    process.env.WASM_POSIX_XTASK_BIN = checker;

    expect(writeProgramProjection(registryRoot, packageName)).toBe(cacheKey);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual([
      "build-deps",
      "program-index",
      registryRoot,
      join(registryRoot, "program-packages.json"),
    ]);

    writeFileSync(
      checker,
      ["#!/usr/bin/env node", "process.exit(97);", ""].join("\n"),
    );
    expect(() =>
      writeProgramProjection(
        join(testRoot, "failed-registry"),
        "failed-prepared-checker",
      ),
    ).toThrow();
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
    if (savedXtask === undefined) {
      delete process.env.WASM_POSIX_XTASK_BIN;
    } else {
      process.env.WASM_POSIX_XTASK_BIN = savedXtask;
    }
  }
});

test("Vite dependency scanning does not require the package checker", async () => {
  const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const testRoot = mkdtempSync(join(tmpdir(), "kandelo-vite-no-packages-"));
  const checker = join(testRoot, "unexpected-xtask");
  const marker = join(testRoot, "checker-was-invoked");
  let server: ViteDevServer | null = null;

  try {
    writeFileSync(
      checker,
      [
        "#!/bin/sh",
        `printf invoked > ${JSON.stringify(marker)}`,
        "exit 97",
        "",
      ].join("\n"),
    );
    chmodSync(checker, 0o755);
    process.env.WASM_POSIX_XTASK_BIN = checker;
    process.env.KANDELO_BROWSER_TEST_NO_HMR = "1";

    server = await createServer({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    await server.listen();
    await server.environments.client.depsOptimizer?.scanProcessing;

    expect(existsSync(marker)).toBe(false);
  } finally {
    await server?.close();
    rmSync(testRoot, { recursive: true, force: true });
    if (savedXtask === undefined) {
      delete process.env.WASM_POSIX_XTASK_BIN;
    } else {
      process.env.WASM_POSIX_XTASK_BIN = savedXtask;
    }
    if (savedNoHmr === undefined) {
      delete process.env.KANDELO_BROWSER_TEST_NO_HMR;
    } else {
      process.env.KANDELO_BROWSER_TEST_NO_HMR = savedNoHmr;
    }
  }
});

test("SourceOnly Vite serves a verified snapshot after same-path replacement", async () => {
  const savedPolicy = process.env.WASM_POSIX_RESOLUTION_POLICY;
  const savedSourceOnlyRoot =
    process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const sourceOnlyRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "kandelo-vite-source-only-")),
  );
  const namespace = `vite-source-only-${randomUUID()}`;
  const fixture = writeSourceOnlyViteFixture(sourceOnlyRoot, namespace);
  const entryDirectory = generatedEntryDirectory(namespace);
  const entry = join(entryDirectory, "entry.ts");
  const absentDefaultMirror = join(
    repoRoot,
    "local-binaries",
    fixture.relPath,
  );
  const relativeOptional = normalizePath(
    relative(entryDirectory, absentDefaultMirror),
  );
  const optionalSpecifier = relativeOptional.startsWith(".")
    ? relativeOptional
    : `./${relativeOptional}`;
  const poisonedPublicFallback = join(
    appRoot,
    "public",
    `${namespace}.data.json`,
  );
  const relativePoisonedFallback = normalizePath(
    relative(entryDirectory, poisonedPublicFallback),
  );
  const poisonedFallbackSpecifier = relativePoisonedFallback.startsWith(".")
    ? relativePoisonedFallback
    : `./${relativePoisonedFallback}`;
  const productionOutput = mkdtempSync(
    join(tmpdir(), "kandelo-vite-source-only-dist-"),
  );
  let server: ViteDevServer | null = null;

  try {
    mkdirSync(entryDirectory, { recursive: true });
    writeFileSync(poisonedPublicFallback, "poisoned public fallback\n");
    writeFileSync(
      entry,
      `import artifactUrl from "@binaries/${fixture.relPath}?url";\n` +
        "export default artifactUrl;\n" +
        `export const optional = import.meta.glob(${JSON.stringify(optionalSpecifier)}, ` +
        `{ query: "?url", import: "default" });\n` +
        `export const poisoned = import.meta.glob(${JSON.stringify(poisonedFallbackSpecifier)}, ` +
        `{ query: "?url", import: "default" });\n`,
    );
    expect(existsSync(absentDefaultMirror)).toBe(false);
    process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
    process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = sourceOnlyRoot;
    process.env.KANDELO_BROWSER_TEST_NO_HMR = "1";

    server = await createServer({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    expect(
      (await fetch(new URL(`/${namespace}.data.json`, origin))).status,
    ).toBe(404);
    await viteBuild({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      build: {
        outDir: productionOutput,
        emptyOutDir: true,
        rollupOptions: { input: entry },
      },
    });
    expect(existsSync(join(productionOutput, "service-worker.js"))).toBe(true);
    expect(existsSync(join(productionOutput, `${namespace}.data.json`))).toBe(false);

    expect((await fetch(fsUrl(origin, fixture.artifact))).status).toBe(403);
    const transformedEntry = await fetch(fsUrl(origin, entry));
    const transformedSource = await transformedEntry.text();
    expect(transformedEntry.status, transformedSource).toBe(200);
    expect(transformedSource).toContain(optionalSpecifier);
    expect(transformedSource).toContain("kandelo-source-only-asset");
    expect(transformedSource).not.toContain("const optional = {};");
    expect(transformedSource).not.toContain(poisonedFallbackSpecifier);
    const modulePath = transformedSource.match(
      /from\s+("[^"\n]+")/,
    )?.[1];
    expect(modulePath, transformedSource).toBeDefined();

    const replacement = `${fixture.artifact}.replacement`;
    const replacementBytes = Buffer.from(
      "poisoned same-path browser bytes\n".repeat(256),
    );
    writeFileSync(replacement, replacementBytes, { mode: 0o755 });
    chmodSync(replacement, 0o755);
    renameSync(replacement, fixture.artifact);

    const assetModule = await fetch(new URL(JSON.parse(modulePath!), origin));
    const assetModuleSource = await assetModule.text();
    expect(assetModule.status, assetModuleSource).toBe(200);
    const assetPath = assetModuleSource.match(
      /export default ("[^"\n]+")\s*;?/,
    )?.[1];
    expect(assetPath, assetModuleSource).toBeDefined();
    const importedAsset = await fetch(
      new URL(JSON.parse(assetPath!), origin),
    );
    expect(importedAsset.status).toBe(200);
    expect(Buffer.from(await importedAsset.arrayBuffer())).toEqual(
      fixture.bytes,
    );
    expect((await fetch(fsUrl(origin, fixture.artifact))).status).toBe(403);
  } finally {
    await server?.close();
    rmSync(entryDirectory, { recursive: true, force: true });
    rmSync(poisonedPublicFallback, { force: true });
    rmSync(productionOutput, { recursive: true, force: true });
    rmSync(sourceOnlyRoot, { recursive: true, force: true });
    if (savedPolicy === undefined) {
      delete process.env.WASM_POSIX_RESOLUTION_POLICY;
    } else {
      process.env.WASM_POSIX_RESOLUTION_POLICY = savedPolicy;
    }
    if (savedSourceOnlyRoot === undefined) {
      delete process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
    } else {
      process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = savedSourceOnlyRoot;
    }
    if (savedNoHmr === undefined) {
      delete process.env.KANDELO_BROWSER_TEST_NO_HMR;
    } else {
      process.env.KANDELO_BROWSER_TEST_NO_HMR = savedNoHmr;
    }
  }
});

test("SourceOnly Vite does not fall back when an owned member is missing", async () => {
  const savedPolicy = process.env.WASM_POSIX_RESOLUTION_POLICY;
  const savedSourceOnlyRoot =
    process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const sourceOnlyRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "kandelo-vite-source-only-missing-")),
  );
  const namespace = `vite-source-only-missing-${randomUUID()}`;
  const fixture = writeSourceOnlyViteFixture(sourceOnlyRoot, namespace);
  const entryDirectory = generatedEntryDirectory(namespace);
  const entry = join(entryDirectory, "entry.ts");
  const defaultMirror = join(repoRoot, "local-binaries", fixture.relPath);
  let server: ViteDevServer | null = null;

  try {
    mkdirSync(entryDirectory, { recursive: true });
    mkdirSync(dirname(defaultMirror), { recursive: true });
    writeFileSync(defaultMirror, fixture.bytes, {
      mode: 0o755,
    });
    chmodSync(defaultMirror, 0o755);
    writeFileSync(
      entry,
      `import artifactUrl from "@binaries/${fixture.relPath}?url";\n` +
        "export default artifactUrl;\n",
    );
    rmSync(fixture.artifact);
    process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
    process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = sourceOnlyRoot;
    process.env.KANDELO_BROWSER_TEST_NO_HMR = "1";

    server = await createServer({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(fsUrl(origin, entry));
    const body = await response.text();
    expect(response.status, body).toBe(500);
    expect(body).toContain("Source-only package member");
    expect(body).not.toContain(Buffer.from(fixture.bytes).toString("base64"));
  } finally {
    await server?.close();
    rmSync(entryDirectory, { recursive: true, force: true });
    rmSync(defaultMirror, { force: true });
    rmSync(sourceOnlyRoot, { recursive: true, force: true });
    if (savedPolicy === undefined) {
      delete process.env.WASM_POSIX_RESOLUTION_POLICY;
    } else {
      process.env.WASM_POSIX_RESOLUTION_POLICY = savedPolicy;
    }
    if (savedSourceOnlyRoot === undefined) {
      delete process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
    } else {
      process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = savedSourceOnlyRoot;
    }
    if (savedNoHmr === undefined) {
      delete process.env.KANDELO_BROWSER_TEST_NO_HMR;
    } else {
      process.env.KANDELO_BROWSER_TEST_NO_HMR = savedNoHmr;
    }
  }
});

test("Vite serves an approved bottle member without exposing its cache", async () => {
  const savedRegistry = process.env.WASM_POSIX_DEPS_REGISTRY;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const testRoot = mkdtempSync(join(tmpdir(), "kandelo-vite-cache-boundary-"));
  const namespace = `vite-cache-boundary-${randomUUID()}`;
  const programCacheRoot = binaryProgramCacheRoot();
  const registryRoot = join(testRoot, "registry");
  // WHY: Prepared CI workspaces relocate the program cache inside the checkout.
  // A control file beside that cache would then be Vite-servable through the
  // allowed repository root, so keep it under the external test root.
  const privateSource = join(testRoot, "private-source", "private.dat");
  const cacheEscapeName = `${namespace}-escape.dat`;
  const cacheEscape = join(programCacheRoot, cacheEscapeName);
  const mirror = join(
    repoRoot,
    "binaries",
    "programs",
    "wasm32",
    namespace,
    "artifact.dat",
  );
  const sidecarMirror = join(
    repoRoot,
    "binaries",
    "programs",
    "wasm32",
    namespace,
    "sidecar.dat",
  );
  const entryDirectory = generatedEntryDirectory(namespace);
  const artifactEntry = join(entryDirectory, "artifact-entry.ts");
  const sidecarEntry = join(entryDirectory, "sidecar-entry.ts");
  const artifactBytes = "approved bottle member\n".repeat(512);
  const sidecarBytes = "package sidecar\n";
  let server: ViteDevServer | null = null;
  let generation: string | null = null;

  try {
    const cacheKey = writeProgramProjection(registryRoot, namespace);
    generation = join(
      programCacheRoot,
      `${namespace}-1.0.0-rev1-wasm32-${cacheKey}`,
    );
    const artifact = join(generation, "artifact.dat");
    const sidecar = join(generation, "sidecar.dat");
    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(dirname(privateSource), { recursive: true });
    mkdirSync(dirname(mirror), { recursive: true });
    mkdirSync(entryDirectory, { recursive: true });
    writeFileSync(artifact, artifactBytes);
    writeFileSync(sidecar, sidecarBytes);
    writeFileSync(privateSource, "private source bytes\n");
    symlinkSync(privateSource, cacheEscape);
    symlinkSync(artifact, mirror);
    symlinkSync(sidecar, sidecarMirror);
    // Assemble this runtime-only fixture in pieces so the repository scanner
    // does not mistake its `${namespace}` placeholder for a real static import.
    const fixtureImport = [
      "@binaries",
      "programs",
      "wasm32",
      namespace,
      "artifact.dat?url",
    ].join("/");
    const relativeSidecar = normalizePath(
      relative(entryDirectory, sidecarMirror),
    );
    const relativeSidecarImport = relativeSidecar.startsWith(".")
      ? relativeSidecar
      : `./${relativeSidecar}`;
    writeFileSync(
      artifactEntry,
      [
        `import artifactUrl from "${fixtureImport}";`,
        "export default artifactUrl;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      sidecarEntry,
      [
        `export const sidecars = import.meta.glob(${JSON.stringify(relativeSidecarImport)}, { query: "?url", import: "default" });`,
        "",
      ].join("\n"),
    );

    process.env.WASM_POSIX_DEPS_REGISTRY =
      registryStackWithFixture(registryRoot);
    process.env.KANDELO_BROWSER_TEST_NO_HMR = "1";
    server = await createServer({
      configFile: join(appRoot, "vite.config.ts"),
      root: appRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const canonicalArtifact = realpathSync(artifact);
    const canonicalSidecar = realpathSync(sidecar);
    const canonicalProgramRoot = realpathSync(programCacheRoot);

    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(403);
    expect((await fetch(fsUrl(origin, canonicalSidecar))).status).toBe(403);
    const transformedEntry = await fetch(fsUrl(origin, artifactEntry));
    const transformedSource = await transformedEntry.text();
    expect(transformedEntry.status, transformedSource).toBe(200);
    expect(transformedSource).toContain("artifact.dat");
    expect(transformedSource).not.toContain("sidecar.dat");
    expect((await fetch(fsUrl(origin, canonicalSidecar))).status).toBe(403);

    const modulePath = transformedSource.match(
      /from\s+("\/@fs\/[^"\n]+artifact\.dat\?import&url")/,
    )?.[1];
    expect(modulePath).toBeDefined();
    const assetModule = await fetch(new URL(JSON.parse(modulePath!), origin));
    const assetModuleSource = await assetModule.text();
    expect(assetModule.status, assetModuleSource).toBe(200);
    const assetPath = assetModuleSource.match(
      /export default ("[^"\n]+")\s*;?/,
    )?.[1];
    expect(assetPath, assetModuleSource).toBeDefined();
    const importedAsset = await fetch(new URL(JSON.parse(assetPath!), origin));
    expect(importedAsset.status).toBe(200);
    expect(await importedAsset.text()).toBe(artifactBytes);

    const transformedSidecarEntry = await fetch(fsUrl(origin, sidecarEntry));
    const transformedSidecarSource = await transformedSidecarEntry.text();
    expect(
      transformedSidecarEntry.status,
      transformedSidecarSource,
    ).toBe(200);
    expect(transformedSidecarSource).toContain("sidecar.dat");
    const sidecarModulePath = transformedSidecarSource.match(
      /import\(("\/@fs\/[^"\n]+sidecar\.dat\?[^"\n]*url[^"\n]*")\)/,
    )?.[1];
    expect(sidecarModulePath, transformedSidecarSource).toBeDefined();
    const sidecarModule = await fetch(
      new URL(JSON.parse(sidecarModulePath!), origin),
    );
    const sidecarModuleSource = await sidecarModule.text();
    expect(sidecarModule.status, sidecarModuleSource).toBe(200);
    const sidecarAssetPath = sidecarModuleSource.match(
      /export default ("[^"\n]+")\s*;?/,
    )?.[1];
    expect(sidecarAssetPath, sidecarModuleSource).toBeDefined();
    const importedSidecar = await fetch(
      new URL(JSON.parse(sidecarAssetPath!), origin),
    );
    expect(importedSidecar.status).toBe(200);
    expect(await importedSidecar.text()).toBe(sidecarBytes);

    const approvedResponse = await fetch(fsUrl(origin, canonicalArtifact));
    const approvedBody = await approvedResponse.text();
    expect(
      approvedResponse.status,
      JSON.stringify(
        {
          approvedBody,
          transformedSource,
          allow: server.config.server.fs.allow,
        },
        null,
        2,
      ),
    ).toBe(200);
    expect(approvedBody).toBe(artifactBytes);
    expect((await fetch(fsUrl(origin, canonicalSidecar))).status).toBe(200);
    expect(
      (await fetch(fsUrl(origin, realpathSync(privateSource)))).status,
    ).toBe(403);
    expect(
      (await fetch(fsUrl(origin, join(canonicalProgramRoot, cacheEscapeName))))
        .status,
    ).toBe(403);
    const caseVariant = canonicalArtifact.replace(
      namespace,
      namespace.toUpperCase(),
    );
    if (caseVariant !== canonicalArtifact && existsSync(caseVariant)) {
      expect((await fetch(fsUrl(origin, caseVariant))).status).toBe(403);
    }
    expect((await fetch(`${origin}/@fs/%E0%A4%A`)).status).toBe(403);

    rmSync(artifact);
    mkdirSync(artifact);
    const descendant = join(artifact, "private.dat");
    writeFileSync(descendant, "replacement directory bytes\n");
    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(403);
    expect(
      (await fetch(fsUrl(origin, join(canonicalArtifact, "private.dat"))))
        .status,
    ).toBe(403);
  } finally {
    await server?.close();
    rmSync(join(repoRoot, "binaries", "programs", "wasm32", namespace), {
      recursive: true,
      force: true,
    });
    rmSync(entryDirectory, { recursive: true, force: true });
    if (generation !== null) {
      rmSync(generation, { recursive: true, force: true });
    }
    rmSync(cacheEscape, { force: true });
    rmSync(dirname(privateSource), { recursive: true, force: true });
    rmSync(testRoot, { recursive: true, force: true });
    if (savedRegistry === undefined) {
      delete process.env.WASM_POSIX_DEPS_REGISTRY;
    } else {
      process.env.WASM_POSIX_DEPS_REGISTRY = savedRegistry;
    }
    if (savedNoHmr === undefined) {
      delete process.env.KANDELO_BROWSER_TEST_NO_HMR;
    } else {
      process.env.KANDELO_BROWSER_TEST_NO_HMR = savedNoHmr;
    }
  }
});

test("Vite approves an explicit program cache that overlaps the checkout", async () => {
  const namespace = `vite-overlap-${randomUUID()}`;
  const cacheRoot = join(repoRoot, `.vite-overlap-cache-${namespace}`);
  const programCacheRoot = join(cacheRoot, "programs");
  const artifact = join(programCacheRoot, namespace, "artifact.dat");
  const entryDirectory = generatedEntryDirectory(namespace);
  const entry = join(entryDirectory, "entry.ts");
  const fixtureImport = `virtual:${namespace}`;
  let server: ViteDevServer | null = null;

  try {
    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(entryDirectory, { recursive: true });
    writeFileSync(artifact, "repo-overlap bottle member\n");
    writeFileSync(
      entry,
      `import artifactUrl from "${fixtureImport}";\nexport default artifactUrl;\n`,
    );

    const access = createBinaryDevAccess({
      repoRoot: realpathSync(repoRoot),
      programCacheRoot: realpathSync(programCacheRoot),
      caseInsensitivePaths: false,
    });

    server = await createServer({
      // This test owns only the exact-file middleware boundary. A minimal
      // server keeps unrelated authored package mirrors out of the fixture,
      // while using the same production access implementation and Vite
      // transport allow-list shape.
      configFile: false,
      root: appRoot,
      logLevel: "silent",
      plugins: [{
        name: "resolve-overlapping-cache-fixture",
        enforce: "pre",
        resolveId(source) {
          return source === fixtureImport
            ? `${access.approve(artifact)}?url`
            : null;
        },
        configureServer(nextServer) {
          access.attachServer(nextServer);
        },
      }],
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        fs: {
          allow: [repoRoot, realpathSync(programCacheRoot)],
        },
      },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const canonicalArtifact = realpathSync(artifact);
    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(403);

    const transformedEntry = await fetch(fsUrl(origin, entry));
    const transformedSource = await transformedEntry.text();
    expect(transformedEntry.status, transformedSource).toBe(200);
    expect(transformedSource).toContain("artifact.dat");
    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(200);
  } finally {
    await server?.close();
    rmSync(entryDirectory, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
