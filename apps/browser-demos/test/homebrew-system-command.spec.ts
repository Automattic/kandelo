import { expect, test } from "@playwright/test";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewSystemCommandProof: (request: {
      vfsUrl: string;
      lazyUrlBase: string;
      bootstrapArchiveUrl: string;
      bootstrapArchiveBytes: number;
      timeoutMs: number;
    }) => Promise<{
      stdout: string;
      stderr: string;
      processEvents: Array<{
        kind: "spawn" | "exec" | "exit";
        pid: number;
        ppid?: number;
        exitStatus?: number;
      }>;
      forkCountSamples: Array<{
        parentPid: number;
        childPid: number;
        count: string;
      }>;
      remainingObservedPids: number[];
    }>;
  }
}

const IMAGE_ENV = "KANDELO_HOMEBREW_SYSTEM_COMMAND_IMAGE";
const ARCHIVE_ENV = "KANDELO_HOMEBREW_SYSTEM_COMMAND_ARCHIVE";
const LAZY_ROOT_ENV = "KANDELO_HOMEBREW_SYSTEM_COMMAND_LAZY_ROOT";

test(
  "real Homebrew SystemCommand uses spawn and preserves its fork fallback",
  async ({ page, baseURL, browserName }) => {
    test.skip(browserName !== "chromium", "the initial product gate is Chromium");
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const configured = [IMAGE_ENV, ARCHIVE_ENV, LAZY_ROOT_ENV]
      .map((name) => process.env[name]);
    if (configured.every((value) => value === undefined)) {
      test.skip(true, "exact Homebrew SystemCommand fixture is not configured");
    }
    if (configured.some((value) => value === undefined)) {
      throw new Error(
        `${IMAGE_ENV}, ${ARCHIVE_ENV}, and ${LAZY_ROOT_ENV} are all required`,
      );
    }

    const image = regularFile(configured[0]!, "SystemCommand VFS image");
    const archive = regularFile(
      configured[1]!,
      "SystemCommand Homebrew archive",
    );
    const lazyRoot = regularDirectory(
      configured[2]!,
      "SystemCommand lazy root",
    );
    test.setTimeout(5 * 60_000 + 60_000);

    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const result = await page.evaluate(
      (request) => window.__runHomebrewSystemCommandProof(request),
      {
        vfsUrl: viteFileUrl(baseURL, image.path),
        lazyUrlBase: viteDirectoryUrl(baseURL, lazyRoot.path),
        bootstrapArchiveUrl: viteFileUrl(baseURL, archive.path),
        bootstrapArchiveBytes: archive.bytes,
        timeoutMs: 5 * 60_000,
      },
    );

    expect(result.stdout.split(/\r?\n/)).toContain(
      "HOMEBREW_SYSTEM_COMMAND_SPAWN_PROOF_OK",
    );
    expect(result.remainingObservedPids).toEqual([]);
    expect(result.forkCountSamples.length).toBeGreaterThan(0);
  },
);

function regularFile(
  value: string,
  label: string,
): { path: string; bytes: number } {
  const path = resolve(value);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
  }
  return { path, bytes: stat.size };
}

function regularDirectory(value: string, label: string): { path: string } {
  const path = resolve(value);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  return { path };
}

function viteFileUrl(baseURL: string, path: string): string {
  return new URL(`/@fs${path}`, baseURL).href;
}

function viteDirectoryUrl(baseURL: string, path: string): string {
  return new URL(`/@fs${path}/`, baseURL).href;
}
