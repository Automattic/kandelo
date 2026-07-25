import { expect, test } from "@playwright/test";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import type {
  HomebrewGuestLifecycleBrowserResult,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser";

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewGuestLifecycleAcceptance: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<HomebrewGuestLifecycleBrowserResult>;
  }
}

const LIVE_ENV = "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE";
const FIXTURE_ENV =
  "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH";

test(
  "Chromium rejects a guest lifecycle fixture without live-network opt-in",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the stock Homebrew lifecycle initially targets Chromium",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);

    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL).origin) {
        externalRequests.push(url.href);
      }
    });
    const message = await page.evaluate(async () => {
      const fixture = {
        schema: 1,
        allowLiveNetwork: false,
        transportMode: "public",
        image: {
          url: "https://example.test/main-shell.vfs.zst",
          sha256: "1".repeat(64),
          bytes: 1,
        },
        bootstrap: {
          spec: {
            url: "https://example.test/main-shell-brew-package-tree.json",
            sha256: "2".repeat(64),
            bytes: 1,
          },
          archive: {
            url: "https://example.test/homebrew-bootstrap.zip",
            sha256: "3".repeat(64),
            bytes: 1,
          },
          environment: {
            url: "https://example.test/homebrew-brew.env",
            sha256: "4".repeat(64),
            bytes: 1,
          },
        },
        bottleMirror: {
          plan: {
            url:
              "https://example.test/kandelo-homebrew-bottle-mirror-plan.json",
            sha256: "7".repeat(64),
            bytes: 1,
          },
        },
        revisions: {
          coreRevision: "5".repeat(40),
          canaryRevision: "6".repeat(40),
        },
        timeoutMs: 1_000,
      };
      try {
        await window.__runHomebrewGuestLifecycleAcceptance(
          fixture as unknown as HomebrewGuestLifecycleBrowserFixture,
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("fixture without live-network opt-in unexpectedly ran");
    });
    expect(message).toContain("explicit live-network opt-in");
    expect(externalRequests).toEqual([]);
  },
);

test(
  "the exact stock Homebrew lifecycle survives a Chromium rootfs reboot",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the stock Homebrew lifecycle initially targets Chromium",
    );
    const liveValue = process.env[LIVE_ENV];
    const fixturePath = process.env[FIXTURE_ENV];
    const partiallyConfigured =
      liveValue !== undefined || fixturePath !== undefined;
    if (liveValue !== "1" || fixturePath === undefined) {
      if (partiallyConfigured) {
        throw new Error(
          `${LIVE_ENV}=1 and ${FIXTURE_ENV} are both required for the live proof`,
        );
      }
      test.skip(
        true,
        "exact published Homebrew lifecycle fixture is not configured",
      );
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
    test.setTimeout(fixture.timeoutMs + 180_000);

    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const result = await page.evaluate(
      (exactFixture) =>
        window.__runHomebrewGuestLifecycleAcceptance(exactFixture),
      fixture,
    );

    expect(result.coreRevision).toBe(fixture.revisions.coreRevision);
    expect(result.canaryRevision).toBe(fixture.revisions.canaryRevision);
    expect(result.exportedImageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.exportedImageBytes).toBeGreaterThan(0);
    expect(result.phaseOneCompletedUrls.length).toBeGreaterThan(0);
    expect(
      result.phaseOneLazyDownloads.some(
        (event) => event.status === "error",
      ),
    ).toBe(false);
    expect(
      result.phaseTwoLazyDownloads.some(
        (event) => event.status === "error",
      ),
    ).toBe(false);
  },
);
