import { expect, test } from "@playwright/test";

import type { HomebrewFlatVfsShippingProofResult } from
  "../../../homebrew/test/homebrew_flat_vfs_shipping_proof";

interface HomebrewFlatVfsShippingProofRequest {
  allowLiveNetwork: true;
  vfsUrl: string;
  shellPath: string;
  shellArgv0: string;
  tapRevision: string;
  timeoutMs: number;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewFlatVfsShippingProof: (
      request: HomebrewFlatVfsShippingProofRequest,
    ) => Promise<HomebrewFlatVfsShippingProofResult>;
  }
}

const LIVE_ENV = "KANDELO_HOMEBREW_FLAT_VFS_BROWSER_LIVE";
const VFS_URL_ENV = "KANDELO_HOMEBREW_FLAT_VFS_BROWSER_VFS_URL";
const TAP_REVISION_ENV = "KANDELO_HOMEBREW_FLAT_VFS_TAP_REVISION";
const SELECTION_SHA_ENV = "KANDELO_HOMEBREW_FLAT_VFS_SELECTION_SHA256";
const TIMEOUT_ENV = "KANDELO_HOMEBREW_FLAT_VFS_TIMEOUT_MS";

test(
  "Chromium rejects the flat-VFS proof without live-network opt-in",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the first flat-VFS shipping proof targets Chromium",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== new URL(baseURL).origin) {
        externalRequests.push(request.url());
      }
    });
    const message = await page.evaluate(async () => {
      try {
        await window.__runHomebrewFlatVfsShippingProof({
          allowLiveNetwork: false,
          vfsUrl: "https://example.test/candidate.vfs.zst",
          shellPath: "/bin/bash",
          shellArgv0: "bash",
          tapRevision: "1".repeat(40),
          timeoutMs: 1_000,
        } as unknown as HomebrewFlatVfsShippingProofRequest);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("flat-VFS request without live-network opt-in ran");
    });
    expect(message).toContain("explicit live-network opt-in");
    expect(externalRequests).toEqual([]);
  },
);

test(
  "the exact flat VFS installs and executes Bzip2 through stock Homebrew in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the first flat-VFS shipping proof targets Chromium",
    );
    const live = process.env[LIVE_ENV];
    const vfsUrl = process.env[VFS_URL_ENV];
    const tapRevision = process.env[TAP_REVISION_ENV];
    const selectionSha256 = process.env[SELECTION_SHA_ENV];
    const timeoutValue = process.env[TIMEOUT_ENV];
    const configured = [live, vfsUrl, tapRevision, selectionSha256, timeoutValue]
      .some((value) => value !== undefined);
    if (
      live !== "1" ||
      vfsUrl === undefined ||
      tapRevision === undefined ||
      selectionSha256 === undefined
    ) {
      if (configured) {
        throw new Error(
          `${LIVE_ENV}=1, ${VFS_URL_ENV}, ${TAP_REVISION_ENV}, and ` +
            `${SELECTION_SHA_ENV} are all required for the live proof`,
        );
      }
      test.skip(true, "the exact flat Homebrew VFS is not configured");
    }
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const timeoutMs = Number(timeoutValue ?? "900000");
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 30 * 60_000
    ) {
      throw new Error(`${TIMEOUT_ENV} must be an integer from 1000 to 1800000`);
    }
    test.setTimeout(timeoutMs + 180_000);

    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const result = await page.evaluate(
      (request) => window.__runHomebrewFlatVfsShippingProof(request),
      {
        allowLiveNetwork: true,
        vfsUrl: vfsUrl!,
        shellPath: "/bin/bash",
        shellArgv0: "bash",
        tapRevision: tapRevision!,
        timeoutMs,
      } satisfies HomebrewFlatVfsShippingProofRequest,
    );

    expect(result.tapRevision).toBe(tapRevision);
    expect(result.selectionSha256).toBe(selectionSha256);
    expect(result.lazyDownloads).toEqual([]);
  },
);
