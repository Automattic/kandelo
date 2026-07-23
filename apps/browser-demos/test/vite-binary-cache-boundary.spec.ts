import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, normalizePath, type ViteDevServer } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");

function fsUrl(origin: string, file: string): string {
  const normalized = normalizePath(file).replace(/^\//, "");
  return `${origin}/@fs/${encodeURI(normalized)}`;
}

test("Vite serves an approved bottle member without exposing its cache", async () => {
  const savedXdgCacheHome = process.env.XDG_CACHE_HOME;
  const savedNoHmr = process.env.KANDELO_BROWSER_TEST_NO_HMR;
  const testRoot = mkdtempSync(join(tmpdir(), "kandelo-vite-cache-boundary-"));
  const namespace = `vite-cache-boundary-${randomUUID()}`;
  const cacheRoot = join(testRoot, "kandelo");
  const generation = join(
    cacheRoot,
    "programs",
    `${namespace}-1.0.0-rev1-wasm32-${"a".repeat(64)}`,
  );
  const artifact = join(generation, "artifact.dat");
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
  const entryDirectory = join(appRoot, "test-runs", namespace);
  const entry = join(entryDirectory, "entry.ts");
  const artifactBytes = "approved bottle member\n".repeat(512);
  let server: ViteDevServer | null = null;

  try {
    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(dirname(privateSource), { recursive: true });
    mkdirSync(dirname(mirror), { recursive: true });
    mkdirSync(entryDirectory, { recursive: true });
    writeFileSync(artifact, artifactBytes);
    writeFileSync(privateSource, "private source bytes\n");
    symlinkSync(privateSource, cacheEscape);
    symlinkSync(artifact, mirror);
    writeFileSync(
      entry,
      `import artifactUrl from "@binaries/programs/wasm32/${namespace}/artifact.dat?url";\nexport default artifactUrl;\n`,
    );

    process.env.XDG_CACHE_HOME = testRoot;
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
    const canonicalProgramRoot = realpathSync(join(cacheRoot, "programs"));

    expect((await fetch(fsUrl(origin, canonicalArtifact))).status).toBe(403);
    const transformedEntry = await fetch(fsUrl(origin, entry));
    const transformedSource = await transformedEntry.text();
    expect(transformedEntry.status, transformedSource).toBe(200);
    expect(transformedSource).toContain("artifact.dat");

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

    const approvedResponse = await fetch(fsUrl(origin, canonicalArtifact));
    const approvedBody = await approvedResponse.text();
    expect(
      approvedResponse.status,
      JSON.stringify({
        approvedBody,
        transformedSource,
        allow: server.config.server.fs.allow,
      }, null, 2),
    ).toBe(200);
    expect(approvedBody).toBe(artifactBytes);
    expect((await fetch(fsUrl(origin, realpathSync(privateSource)))).status).toBe(403);
    expect((await fetch(
      fsUrl(origin, join(canonicalProgramRoot, "escape.dat")),
    )).status).toBe(403);
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
    expect((await fetch(fsUrl(
      origin,
      join(canonicalArtifact, "private.dat"),
    ))).status).toBe(403);
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
    if (savedNoHmr === undefined) {
      delete process.env.KANDELO_BROWSER_TEST_NO_HMR;
    } else {
      process.env.KANDELO_BROWSER_TEST_NO_HMR = savedNoHmr;
    }
  }
});
