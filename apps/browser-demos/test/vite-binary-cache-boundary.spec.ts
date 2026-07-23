import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath, type ViteDevServer } from "vite";

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
  const cargoArgs = [
    "run",
    "--release",
    "--quiet",
    "-p",
    "xtask",
    "--target",
    rustHostTarget(),
    "--",
    "build-deps",
    "program-index",
    registryRoot,
    indexPath,
  ];
  const environment = {
    ...process.env,
    WASM_POSIX_DEPS_REGISTRY: registryRoot,
  };
  // The source checkout deliberately rejects hand-authored cache identities.
  // Generate this synthetic registry through the same Rust manifest parser and
  // cache-key implementation that Vite rechecks before serving package bytes.
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
        `WASM_POSIX_DEPS_REGISTRY=${registryRoot}`,
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

test("Vite serves an approved bottle member without exposing its cache", async () => {
  const savedXdgCacheHome = process.env.XDG_CACHE_HOME;
  const savedBinaryCacheRoot = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  const savedRegistry = process.env.WASM_POSIX_DEPS_REGISTRY;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const testRoot = mkdtempSync(join(tmpdir(), "kandelo-vite-cache-boundary-"));
  const namespace = `vite-cache-boundary-${randomUUID()}`;
  const cacheRoot = join(testRoot, "kandelo");
  const registryRoot = join(testRoot, "registry");
  const privateSource = join(cacheRoot, "sources", "private.dat");
  const cacheEscape = join(cacheRoot, "programs", "escape.dat");
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

  try {
    const cacheKey = writeProgramProjection(registryRoot, namespace);
    const generation = join(
      cacheRoot,
      "programs",
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

    process.env.XDG_CACHE_HOME = testRoot;
    delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
    process.env.WASM_POSIX_DEPS_REGISTRY = registryRoot;
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
    const canonicalProgramRoot = realpathSync(join(cacheRoot, "programs"));

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
      (await fetch(fsUrl(origin, join(canonicalProgramRoot, "escape.dat"))))
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
    rmSync(testRoot, { recursive: true, force: true });
    if (savedXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedXdgCacheHome;
    }
    if (savedBinaryCacheRoot === undefined) {
      delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
    } else {
      process.env.WASM_POSIX_BINARY_CACHE_ROOT = savedBinaryCacheRoot;
    }
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
  const savedBinaryCacheRoot = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  const savedRegistry = process.env.WASM_POSIX_DEPS_REGISTRY;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const namespace = `vite-overlap-${randomUUID()}`;
  const cacheRoot = join(repoRoot, `.vite-overlap-cache-${namespace}`);
  const registryRoot = join(cacheRoot, "registry");
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
  const entry = join(entryDirectory, "entry.ts");
  let server: ViteDevServer | null = null;

  try {
    const cacheKey = writeProgramProjection(registryRoot, namespace);
    const generation = join(
      cacheRoot,
      "programs",
      `${namespace}-1.0.0-rev1-wasm32-${cacheKey}`,
    );
    const artifact = join(generation, "artifact.dat");
    const sidecar = join(generation, "sidecar.dat");
    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(dirname(mirror), { recursive: true });
    mkdirSync(entryDirectory, { recursive: true });
    writeFileSync(artifact, "repo-overlap bottle member\n");
    writeFileSync(sidecar, "package sidecar\n");
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
    writeFileSync(
      entry,
      `import artifactUrl from "${fixtureImport}";\nexport default artifactUrl;\n`,
    );
    process.env.WASM_POSIX_BINARY_CACHE_ROOT = cacheRoot;
    process.env.WASM_POSIX_DEPS_REGISTRY = registryRoot;
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
    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(403);

    const transformedEntry = await fetch(fsUrl(origin, entry));
    const transformedSource = await transformedEntry.text();
    expect(transformedEntry.status, transformedSource).toBe(200);
    expect(transformedSource).toContain("artifact.dat");
    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(200);
  } finally {
    await server?.close();
    rmSync(join(repoRoot, "binaries", "programs", "wasm32", namespace), {
      recursive: true,
      force: true,
    });
    rmSync(entryDirectory, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    if (savedBinaryCacheRoot === undefined) {
      delete process.env.WASM_POSIX_BINARY_CACHE_ROOT;
    } else {
      process.env.WASM_POSIX_BINARY_CACHE_ROOT = savedBinaryCacheRoot;
    }
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
