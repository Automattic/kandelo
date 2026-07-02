import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { ABI_VERSION } from "../../../host/src/generated/abi";

const FIXTURE_BASE_PATH = "/__kandelo-homebrew-test";
const FIXTURE_ROOT = new URL("../public/__kandelo-homebrew-test/", import.meta.url);

type FixtureEntry = {
  id: string;
  title: string;
  browserCompatible: boolean;
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

async function writeHomebrewGalleryFixture(
  name: string,
  entries: FixtureEntry[],
): Promise<string> {
  const fixtureDir = new URL(`${name}/`, FIXTURE_ROOT);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(new URL("gallery.json", fixtureDir), JSON.stringify({
    source_id: "kandelo-homebrew",
    index_url: "index.toml",
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      description: "GNU hello poured from a Homebrew bottle.",
      packages: [{ name: packageNameForEntry(entry), version: "2.12.3" }],
    })),
  }), "utf8");
  await writeFile(new URL("index.toml", fixtureDir), `abi_version = ${ABI_VERSION}

${entries.map((entry) => `[[packages]]
name = "${packageNameForEntry(entry)}"
version = "2.12.3"

[packages.binary.wasm32]
status = "success"
archive_url = "${FIXTURE_BASE_PATH}/${name}/${packageNameForEntry(entry)}.tar.zst"
archive_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
cache_key_sha = "1111111111111111111111111111111111111111111111111111111111111111"
browser_compatible = ${entry.browserCompatible ? "true" : "false"}
`).join("\n")}
`, "utf8");
  return `${FIXTURE_BASE_PATH}/${name}/gallery.json`;
}

function packageNameForEntry(entry: FixtureEntry): string {
  return `hello-homebrew-${entry.id}`;
}

test.afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test("software gallery hides wasm32 entries without browser-compatible metadata", async ({ page }) => {
  const manifestPath = await writeHomebrewGalleryFixture("nonbrowser", [
    { id: "hello-vfs", title: "GNU hello Homebrew VFS", browserCompatible: false },
    { id: "hello-sentinel", title: "GNU hello Browser Sentinel", browserCompatible: true },
  ]);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(manifestPath)}`);
  await openGallery(page);

  await expect(page.locator(".kgal-card").filter({ hasText: "GNU hello Browser Sentinel" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.locator(".kgal-card").filter({ hasText: "GNU hello Homebrew VFS" })).toHaveCount(0);
});

test("browser-compatible gallery archive launch failures are visible", async ({ page }) => {
  const manifestPath = await writeHomebrewGalleryFixture("browser", [
    { id: "hello-vfs", title: "GNU hello Homebrew VFS", browserCompatible: true },
  ]);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(manifestPath)}`);
  await openGallery(page);

  const card = page.locator(".kgal-card").filter({ hasText: "GNU hello Homebrew VFS" });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await card.getByRole("button", { name: "Launch" }).click();

  await expect(page.getByText("Failed to boot GNU hello Homebrew VFS")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/404|artifact|archive/i).first()).toBeVisible();
  await expect(page.getByText(/third-party gallery entry/i)).toBeVisible();
});

test("Homebrew hello VFS image boots in browser and runs hello --version", async ({ page }) => {
  const vfsUrl = process.env.KANDELO_BROWSER_HELLO_VFS_URL;
  test.skip(!vfsUrl, "KANDELO_BROWSER_HELLO_VFS_URL is required for the published Homebrew hello smoke");
  test.setTimeout(360_000);

  await gotoOrSkip(page, `/?vfs=${encodeURIComponent(vfsUrl!)}`);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 240_000);

  await runTerminalCommand(
    page,
    "/home/linuxbrew/.linuxbrew/bin/hello --version",
    /hello \(GNU Hello\) 2\.12\.3/,
    180_000,
  );
});
