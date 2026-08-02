import { expect, test } from "@playwright/test";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import type {
  HomebrewGuestShippingProofBrowserResult,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser";
import {
  projectRealInstallPreparedBottleDigests,
} from "../../../homebrew/test/homebrew_real_install_diagnostic_prepared";
import type {
  HomebrewGuestShippingBottleDigests,
} from "../../../homebrew/test/homebrew_guest_lifecycle_contract";

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewGuestShippingProofAcceptance: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
      scope: "core" | "canary",
      bottleDigests: HomebrewGuestShippingBottleDigests,
    ) => Promise<HomebrewGuestShippingProofBrowserResult>;
  }
}

const FIXTURE_ENV =
  "KANDELO_HOMEBREW_REAL_INSTALL_DIAGNOSTIC_FIXTURE_PATH";
const PREPARED_ENV =
  "KANDELO_HOMEBREW_REAL_INSTALL_DIAGNOSTIC_PREPARED_PATH";

test(
  "one exact diagnostic VFS installs core Bzip2 and independent M4",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the initial live in-guest Homebrew proof targets Chromium",
    );
    const fixturePath = process.env[FIXTURE_ENV];
    if (fixturePath === undefined) {
      test.skip(true, "exact real-install diagnostic fixture is not configured");
    }
    const preparedPath = process.env[PREPARED_ENV];
    if (preparedPath === undefined) {
      test.skip(true, "exact real-install diagnostic receipt is not configured");
    }
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const absoluteFixturePath = resolve(fixturePath!);
    const stat = lstatSync(absoluteFixturePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `${FIXTURE_ENV} must name a regular non-symlink JSON file`,
      );
    }
    const fixture = projectHomebrewGuestLifecycleBrowserFixture(
      JSON.parse(readFileSync(absoluteFixturePath, "utf8")),
    );
    const absolutePreparedPath = resolve(preparedPath!);
    const preparedStat = lstatSync(absolutePreparedPath);
    if (!preparedStat.isFile() || preparedStat.isSymbolicLink()) {
      throw new Error(
        `${PREPARED_ENV} must name a regular non-symlink JSON file`,
      );
    }
    const bottleDigests = projectRealInstallPreparedBottleDigests(
      JSON.parse(readFileSync(absolutePreparedPath, "utf8")),
    );
    test.setTimeout(fixture.timeoutMs * 2 + 180_000);

    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);

    // WHY: both scopes start from the same immutable VFS bytes. Separate
    // machines keep a successful core install from preparing the canary run.
    for (const scope of ["core", "canary"] as const) {
      const result = await page.evaluate(
        ([exactFixture, exactScope, exactBottleDigests]) =>
          window.__runHomebrewGuestShippingProofAcceptance(
            exactFixture,
            exactScope,
            exactBottleDigests,
          ),
        [fixture, scope, bottleDigests] as const,
      );
      expect(result.scope).toBe(scope);
      expect(result.coreRevision).toBe(fixture.revisions.coreRevision);
      expect(result.canaryRevision).toBe(fixture.revisions.canaryRevision);
      expect(result.completedUrls.length).toBeGreaterThan(0);
      expect(
        result.lazyDownloads.some((event) => event.status === "error"),
      ).toBe(false);
    }
  },
);
