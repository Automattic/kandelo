import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

interface RootfsExportAcceptanceResult {
  persistedText: string;
  firstExportSha256: string;
  secondExportSha256: string;
  firstExportBytes: number;
  secondExportBytes: number;
  liveProcessExitCode: number;
  liveProcessExportError: string;
  teardownProcessExitCode: number;
  teardownExportError: string;
  overlappingExportError: string;
  overlappingWriteError: string;
  lazyReadText: string;
  lateWritePresentInExport: boolean;
  writeAfterExportText: string;
  diagnostics: Array<{ source: string; message: string }>;
  lazyEntries: Array<{ path: string; url: string; size: number }>;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runRootfsExportAcceptance: (request: {
      vfsUrl: string;
      writePath: string;
      writeText: string;
      liveProcessUrl: string;
      teardownProcessUrl: string;
      lazyReadPath: string;
      lazyReadUrl: string;
      lazyReadText: string;
      lateWritePath: string;
      lateWriteText: string;
    }) => Promise<RootfsExportAcceptanceResult>;
    __releaseRootfsExportLazyResponse: () => Promise<void>;
  }
}

const fixtureRoot = new URL(
  "../public/__kandelo-acceptance/rootfs-export/",
  import.meta.url,
);
const liveProcessPath = fileURLToPath(
  new URL("../../../examples/block-forever.wasm", import.meta.url),
);
const teardownProcessPath = fileURLToPath(
  new URL("../../../examples/thread-exit-group.wasm", import.meta.url),
);
const lazyRaceUrl =
  "https://rootfs-export-race.invalid/lazy-read-payload";
const lazyRacePath = "/opt/lazy-export-race";
const lazyRaceText = "lazy mutation completed before export\n";
const lazyRaceBytes = new TextEncoder().encode(lazyRaceText);
const lateWritePath = "/state/rejected-during-export.txt";
const lateWriteText = "write succeeds only after export\n";

function projectFixtureDir(projectName: string): URL {
  if (!/^[a-z0-9-]+$/.test(projectName)) {
    throw new Error(`unsafe Playwright project name: ${projectName}`);
  }
  return new URL(`${projectName}/`, fixtureRoot);
}

test.beforeAll(async ({}, testInfo) => {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
  fs.mkdir("/state", 0o755);
  fs.registerLazyFile(
    "/opt/lazy-export-sentinel",
    "https://packages.example.test/lazy-export-sentinel.wasm",
    123_456,
    0o755,
  );
  fs.registerLazyFile(
    lazyRacePath,
    lazyRaceUrl,
    lazyRaceBytes.byteLength,
    0o644,
  );
  const fixtureDir = projectFixtureDir(testInfo.project.name);
  const fixture = new URL("rootfs-export.vfs", fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixture, await fs.saveImage());
});

test.afterAll(async ({}, testInfo) => {
  const fixtureDir = projectFixtureDir(testInfo.project.name);
  await rm(fixtureDir, { recursive: true, force: true });
});

test("browser rootfs export rejects unsafe races and reboots its snapshot", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");

  let releaseLazyResponse!: () => void;
  const lazyResponseReleased = new Promise<void>((resolve) => {
    releaseLazyResponse = resolve;
  });
  let lazyRequestCount = 0;
  let releaseCallCount = 0;
  // WHY: holding the real fetch keeps one VFS mutation active long enough to
  // prove that export waits for it while excluding later export and writes.
  await page.route(lazyRaceUrl, async (route) => {
    lazyRequestCount += 1;
    await lazyResponseReleased;
    await route.fulfill({
      status: 200,
      body: Buffer.from(lazyRaceBytes),
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  });
  await page.exposeFunction("__releaseRootfsExportLazyResponse", () => {
    releaseCallCount += 1;
    releaseLazyResponse();
  });

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect
    .poll(() => page.evaluate(() => window.__homebrewVfsTestReady), {
      timeout: 120_000,
    })
    .toBe(true);

  const projectName = testInfo.project.name;
  const request = {
    vfsUrl: new URL(
      `/__kandelo-acceptance/rootfs-export/${projectName}/rootfs-export.vfs`,
      baseURL,
    ).href,
    writePath: "/state/persisted.txt",
    writeText: "browser rootfs state survives reboot\n",
    liveProcessUrl: new URL(`/@fs/${liveProcessPath}`, baseURL).href,
    teardownProcessUrl: new URL(`/@fs/${teardownProcessPath}`, baseURL).href,
    lazyReadPath: lazyRacePath,
    lazyReadUrl: lazyRaceUrl,
    lazyReadText: lazyRaceText,
    lateWritePath,
    lateWriteText,
  };
  const result = await page.evaluate((acceptanceRequest) =>
    window.__runRootfsExportAcceptance(acceptanceRequest), request);

  expect(result.persistedText).toBe(
    "browser rootfs state survives reboot\n",
  );
  expect(result.firstExportBytes).toBeGreaterThan(0);
  expect(result.secondExportBytes).toBeGreaterThan(0);
  expect(result.firstExportSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.secondExportSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.liveProcessExitCode).toBe(143);
  expect(result.liveProcessExportError).toContain(
    "no live or tearing-down processes",
  );
  expect(result.teardownProcessExitCode).toBe(0);
  expect(result.teardownExportError).toContain(
    "no live or tearing-down processes",
  );
  expect(result.overlappingExportError).toContain(
    "rootfs export is already in progress",
  );
  expect(result.overlappingWriteError).toContain(
    "rootfs export is in progress; cannot write a rootfs file",
  );
  expect(result.lazyReadText).toBe(lazyRaceText);
  expect(result.lateWritePresentInExport).toBe(false);
  expect(result.writeAfterExportText).toBe(lateWriteText);
  expect(result.diagnostics).toEqual([]);
  expect(lazyRequestCount).toBe(1);
  expect(releaseCallCount).toBe(1);
  expect(result.lazyEntries).toEqual([{
    path: "/opt/lazy-export-sentinel",
    url: "https://packages.example.test/lazy-export-sentinel.wasm",
    size: 123_456,
  }]);
});
