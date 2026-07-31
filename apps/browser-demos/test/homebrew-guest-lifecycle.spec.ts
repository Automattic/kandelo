import { expect, test, type Page } from "@playwright/test";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";
import type {
  HomebrewGuestLifecycleBrowserResult,
  HomebrewGuestShippingProofBrowserResult,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser";
import type {
  HomebrewGuestShippingProofScope,
} from "../../../homebrew/test/homebrew_guest_lifecycle_contract";
import {
  BROWSER_PROGRESS_PREFIX,
} from "../../../homebrew/test/homebrew_guest_lifecycle_progress";

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewGuestLifecycleAcceptance: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<HomebrewGuestLifecycleBrowserResult>;
    __runHomebrewGuestShippingProofAcceptance: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
      scope: HomebrewGuestShippingProofScope,
    ) => Promise<HomebrewGuestShippingProofBrowserResult>;
  }
}

const LIVE_ENV = "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_LIVE";
const FIXTURE_ENV =
  "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH";
const SHIPPING_SCOPE_ENV =
  "KANDELO_HOMEBREW_GUEST_BROWSER_SHIPPING_SCOPE";

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
    test.skip(
      process.env[SHIPPING_SCOPE_ENV] !== undefined,
      "a bounded browser shipping scope was selected",
    );
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

    const fixture = readLiveFixture(fixturePath!);
    test.setTimeout(fixture.timeoutMs + 180_000);

    forwardHomebrewProgress(page);
    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const result = await evaluateWhilePageLives(
      page,
      "comprehensive Homebrew lifecycle",
      () =>
        page.evaluate(
          (exactFixture) =>
            window.__runHomebrewGuestLifecycleAcceptance(exactFixture),
          fixture,
        ),
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

test(
  "the selected stock Homebrew shipping scope installs in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the stock Homebrew lifecycle initially targets Chromium",
    );
    const scopeValue = process.env[SHIPPING_SCOPE_ENV];
    if (scopeValue === undefined) {
      test.skip(true, "a bounded browser shipping scope was not selected");
    }
    if (scopeValue !== "core" && scopeValue !== "canary") {
      throw new Error(
        `${SHIPPING_SCOPE_ENV} must be core or canary`,
      );
    }
    const liveValue = process.env[LIVE_ENV];
    const fixturePath = process.env[FIXTURE_ENV];
    if (liveValue !== "1" || fixturePath === undefined) {
      throw new Error(
        `${LIVE_ENV}=1 and ${FIXTURE_ENV} are required for a shipping proof`,
      );
    }
    if (!baseURL) throw new Error("Playwright baseURL is required");

    const fixture = readLiveFixture(fixturePath);
    test.setTimeout(fixture.timeoutMs + 180_000);
    forwardHomebrewProgress(page);
    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);

    const result = await evaluateWhilePageLives(
      page,
      `Homebrew ${scopeValue} shipping proof`,
      () =>
        page.evaluate(
          ({ exactFixture, scope }) =>
            window.__runHomebrewGuestShippingProofAcceptance(
              exactFixture,
              scope,
            ),
          {
            exactFixture: fixture,
            scope: scopeValue,
          },
        ),
    );

    expect(result.scope).toBe(scopeValue);
    expect(result.coreRevision).toBe(fixture.revisions.coreRevision);
    expect(result.canaryRevision).toBe(fixture.revisions.canaryRevision);
    expect(result.completedUrls.length).toBeGreaterThan(0);
    expect(
      result.lazyDownloads.some((event) => event.status === "error"),
    ).toBe(false);
  },
);

function readLiveFixture(
  fixturePath: string,
): HomebrewGuestLifecycleBrowserFixture {
  const absoluteFixturePath = resolve(fixturePath);
  const stat = lstatSync(absoluteFixturePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `${FIXTURE_ENV} must name a regular non-symlink JSON file`,
    );
  }
  return projectHomebrewGuestLifecycleBrowserFixture(
    JSON.parse(readFileSync(absoluteFixturePath, "utf8")),
  );
}

function forwardHomebrewProgress(page: Page): void {
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith(BROWSER_PROGRESS_PREFIX)) {
      process.stdout.write(`${text}\n`);
    }
  });
}

async function evaluateWhilePageLives<T>(
  page: Page,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let rejectPageLoss!: (error: Error) => void;
  const pageLoss = new Promise<never>((_resolve, reject) => {
    rejectPageLoss = reject;
  });
  const rejectCrash = () => {
    rejectPageLoss(new Error(`${label}: Chromium renderer crashed`));
  };
  const rejectClose = () => {
    rejectPageLoss(new Error(`${label}: browser page closed unexpectedly`));
  };
  const rejectDisconnect = () => {
    rejectPageLoss(new Error(`${label}: Chromium process disconnected`));
  };
  const browser = page.context().browser();
  page.once("crash", rejectCrash);
  page.once("close", rejectClose);
  browser?.once("disconnected", rejectDisconnect);
  try {
    // WHY: Playwright can leave an in-flight page.evaluate waiting until the
    // test timeout after Chromium has already discarded the renderer. Race
    // the browser lifecycle against target loss so CI reports the real event
    // immediately and preserves nearby memory telemetry.
    return await Promise.race([operation(), pageLoss]);
  } finally {
    page.off("crash", rejectCrash);
    page.off("close", rejectClose);
    browser?.off("disconnected", rejectDisconnect);
  }
}
