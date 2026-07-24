import { mkdir, rm, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

interface RootfsExportAcceptanceResult {
  persistedText: string;
  firstExportSha256: string;
  secondExportSha256: string;
  firstExportBytes: number;
  secondExportBytes: number;
  lazyEntries: Array<{ path: string; url: string; size: number }>;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runRootfsExportAcceptance: (request: {
      vfsUrl: string;
      writePath: string;
      writeText: string;
    }) => Promise<RootfsExportAcceptanceResult>;
  }
}

const fixtureRoot = new URL(
  "../public/__kandelo-acceptance/rootfs-export/",
  import.meta.url,
);

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
  const fixtureDir = projectFixtureDir(testInfo.project.name);
  const fixture = new URL("rootfs-export.vfs", fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixture, await fs.saveImage());
});

test.afterAll(async ({}, testInfo) => {
  const fixtureDir = projectFixtureDir(testInfo.project.name);
  await rm(fixtureDir, { recursive: true, force: true });
});

test("browser rootfs export transfers bytes, preserves lazy state, and reboots", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect
    .poll(() => page.evaluate(() => window.__homebrewVfsTestReady), {
      timeout: 120_000,
    })
    .toBe(true);

  const projectName = testInfo.project.name;
  const result = await page.evaluate((vfsUrl) =>
    window.__runRootfsExportAcceptance({
      vfsUrl,
      writePath: "/state/persisted.txt",
      writeText: "browser rootfs state survives reboot\n",
    }), new URL(
      `/__kandelo-acceptance/rootfs-export/${projectName}/rootfs-export.vfs`,
      baseURL,
    ).href);

  expect(result.persistedText).toBe(
    "browser rootfs state survives reboot\n",
  );
  expect(result.firstExportBytes).toBeGreaterThan(0);
  expect(result.secondExportBytes).toBeGreaterThan(0);
  expect(result.firstExportSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.secondExportSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.lazyEntries).toEqual([{
    path: "/opt/lazy-export-sentinel",
    url: "https://packages.example.test/lazy-export-sentinel.wasm",
    size: 123_456,
  }]);
});
