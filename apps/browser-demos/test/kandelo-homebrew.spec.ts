import { expect, test, type Page } from "@playwright/test";
import { ABI_VERSION } from "../../../host/src/generated/abi";

const MANIFEST_URL = "https://example.test/homebrew/gallery.json";
const INDEX_URL = "https://example.test/homebrew/index.toml";
const ARCHIVE_URL = "https://example.test/homebrew/hello-homebrew-vfs.tar.zst";

type RouteHits = {
  manifest: number;
  index: number;
  archive: number;
};

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function gotoOrSkip(page: Page, path: string) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }
}

async function openGallery(page: Page) {
  await page.getByRole("button", { name: "Gallery" }).click();
  await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible();
  await expect(page.locator(".kgal-card").filter({ hasText: "Bare shell" })).toBeVisible({
    timeout: 90_000,
  });
}

async function waitForReady(page: Page, timeout = 180_000) {
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(
  page: Page,
  expected: string | RegExp,
  timeout = 120_000,
) {
  const assertion = expect.poll(() => terminalText(page), { timeout });
  if (typeof expected === "string") {
    await assertion.toContain(expected);
  } else {
    await assertion.toMatch(expected);
  }
}

async function runTerminalCommand(
  page: Page,
  command: string,
  expected: string | RegExp,
  timeout = 120_000,
) {
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

async function routeHomebrewGallery(page: Page, browserCompatible: boolean): Promise<RouteHits> {
  const hits: RouteHits = { manifest: 0, index: 0, archive: 0 };
  await page.route(MANIFEST_URL, async (route) => {
    hits.manifest += 1;
    await route.fulfill({
      contentType: "application/json",
      headers: corsHeaders(),
      body: JSON.stringify({
        source_id: "kandelo-homebrew",
        index_url: INDEX_URL,
        entries: [{
          id: "hello-homebrew-vfs",
          title: "GNU hello Homebrew VFS",
          description: "GNU hello poured from a Homebrew bottle.",
          packages: [{ name: "hello-homebrew-vfs", version: "2.12.3" }],
        }],
      }),
    });
  });
  await page.route(INDEX_URL, async (route) => {
    hits.index += 1;
    await route.fulfill({
      contentType: "text/plain",
      headers: corsHeaders(),
      body: `abi_version = ${ABI_VERSION}

[[packages]]
name = "hello-homebrew-vfs"
version = "2.12.3"

[packages.binary.wasm32]
status = "success"
archive_url = "${ARCHIVE_URL}"
archive_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
cache_key_sha = "1111111111111111111111111111111111111111111111111111111111111111"
browser_compatible = ${browserCompatible ? "true" : "false"}
`,
    });
  });
  await page.route(ARCHIVE_URL, async (route) => {
    hits.archive += 1;
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      headers: corsHeaders(),
      body: "archive intentionally absent",
    });
  });
  return hits;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
  };
}

test("software gallery hides wasm32 entries without browser-compatible metadata", async ({ page }) => {
  const hits = await routeHomebrewGallery(page, false);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(MANIFEST_URL)}`);
  await expect.poll(() => hits.index, { timeout: 90_000 }).toBeGreaterThan(0);
  await openGallery(page);

  await expect(page.locator(".kgal-card").filter({ hasText: "GNU hello Homebrew VFS" })).toHaveCount(0);
});

test("browser-compatible gallery archive launch failures are visible", async ({ page }) => {
  const hits = await routeHomebrewGallery(page, true);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(MANIFEST_URL)}`);
  await expect.poll(() => hits.index, { timeout: 90_000 }).toBeGreaterThan(0);
  await openGallery(page);

  const card = page.locator(".kgal-card").filter({ hasText: "GNU hello Homebrew VFS" });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await card.getByRole("button", { name: "Launch" }).click();

  await expect(page.getByText("Failed to boot GNU hello Homebrew VFS")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/404|artifact|archive/i).first()).toBeVisible();
  await expect(page.getByText(/third-party gallery entry/i)).toBeVisible();
  expect(hits.archive).toBeGreaterThan(0);
});

test("Homebrew hello VFS image boots in browser and runs hello --version", async ({ page }) => {
  const vfsUrl = process.env.KANDELO_BROWSER_HELLO_VFS_URL;
  test.skip(!vfsUrl, "KANDELO_BROWSER_HELLO_VFS_URL is required for the published Homebrew hello smoke");
  test.setTimeout(360_000);

  await gotoOrSkip(page, `/?vfs=${encodeURIComponent(vfsUrl!)}`);
  await waitForReady(page, 240_000);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });

  await runTerminalCommand(
    page,
    "/home/linuxbrew/.linuxbrew/bin/hello --version",
    /hello \(GNU Hello\) 2\.12\.3/,
    180_000,
  );
});
