import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  KANDELO_SHELL_CONFIG_PATH,
} from "../../../web-libs/kandelo-session/src/shell-config";

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

async function gotoOrSkip(page: Page, path: string, allowMissingBinary = true) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  await handleViteOverlay(page, allowMissingBinary);
}

async function handleViteOverlay(page: Page, allowMissingBinary: boolean) {
  const overlay = page.locator("vite-error-overlay");
  if (!await overlay.count()) return;
  if (!allowMissingBinary) {
    const detail = await overlay.evaluate((element) =>
      element.shadowRoot?.querySelector(".message-body")?.textContent?.trim()
      || element.shadowRoot?.textContent?.trim()
      || element.textContent?.trim()
      || "unknown Vite import error"
    );
    throw new Error(`Published Homebrew browser smoke hit a Vite error overlay: ${detail}`);
  }
  test.skip(true, "Required binary not built - Vite import error");
}

async function openNewMachineLauncher(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch New Machine" })).toBeVisible();
  await expect(galleryRowByTitle(page, /^Bare shell$/)).toBeVisible({
    timeout: 90_000,
  });
}

function galleryRowByTitle(page: Page, title: string | RegExp) {
  return page.locator(".kgal-row", {
    has: page.locator(".kgal-machine-title", { hasText: title }),
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
      description: "A sample package poured from a Homebrew bottle.",
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
  return `sample-homebrew-${entry.id}`;
}

async function writeHomebrewDefaultShellFixture(): Promise<string> {
  const rootfsPath = tryResolveBinary("rootfs.vfs")
    ?? tryResolveBinary("programs/rootfs.vfs");
  const dashPath = tryResolveBinary("programs/dash.wasm");
  if (!rootfsPath || !dashPath) {
    throw new Error("Homebrew default-shell smoke requires rootfs.vfs and dash.wasm");
  }

  const rootfsBytes = new Uint8Array(await readFile(rootfsPath));
  const dashBytes = new Uint8Array(await readFile(dashPath));
  const profile = await readFile(
    new URL("../../../images/rootfs/etc/profile", import.meta.url),
    "utf8",
  );
  const fs = MemoryFileSystem.fromImage(rootfsBytes);
  const shellPath = "/home/linuxbrew/.linuxbrew/bin/dash";
  ensureDirRecursive(fs, "/home/linuxbrew/.linuxbrew/bin");
  writeVfsBinary(fs, shellPath, dashBytes, 0o755);
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(fs, "/etc/profile", profile, 0o644);
  writeVfsFile(
    fs,
    "/etc/profile.d/kandelo-homebrew.sh",
    'PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"\nexport PATH\n',
    0o644,
  );
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(fs, KANDELO_SHELL_CONFIG_PATH, JSON.stringify({
    version: 1,
    path: shellPath,
    argv: ["dash", "-l", "-i"],
  }), 0o644);

  const fixtureDir = new URL("default-shell/", FIXTURE_ROOT);
  const fixtureName = "homebrew-default-shell.vfs";
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(new URL(fixtureName, fixtureDir), await fs.saveImage());
  return `${FIXTURE_BASE_PATH}/default-shell/${fixtureName}`;
}

test.afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test("strict Homebrew publisher smoke reads Vite shadow-root errors", async ({ page }) => {
  await page.setContent("<vite-error-overlay></vite-error-overlay>");
  await page.locator("vite-error-overlay").evaluate((element) => {
    const root = element.attachShadow({ mode: "open" });
    const message = document.createElement("span");
    message.className = "message-body";
    message.textContent = "missing ABI node.wasm";
    root.append(message);
  });
  await expect(handleViteOverlay(page, false)).rejects.toThrow(/missing ABI node\.wasm/);
});

test("software gallery hides wasm32 entries without browser-compatible metadata", async ({ page }) => {
  const manifestPath = await writeHomebrewGalleryFixture("nonbrowser", [
    { id: "sample-vfs", title: "Sample Homebrew VFS", browserCompatible: false },
    { id: "sample-sentinel", title: "Sample Browser Sentinel", browserCompatible: true },
  ]);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(manifestPath)}`);
  await openNewMachineLauncher(page);

  await expect(galleryRowByTitle(page, /^Sample Browser Sentinel$/)).toBeVisible({
    timeout: 90_000,
  });
  await expect(galleryRowByTitle(page, /^Sample Homebrew VFS$/)).toHaveCount(0);
});

test("browser-compatible gallery archive launch failures are visible", async ({ page }) => {
  const manifestPath = await writeHomebrewGalleryFixture("browser", [
    { id: "sample-vfs", title: "Sample Homebrew VFS", browserCompatible: true },
  ]);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(manifestPath)}`);
  await openNewMachineLauncher(page);

  const row = galleryRowByTitle(page, /^Sample Homebrew VFS$/);
  await expect(row).toBeVisible({ timeout: 90_000 });
  await row.getByRole("button", { name: "Launch" }).click();

  await expect(page.getByText("Failed to boot Sample Homebrew VFS")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/404|artifact|archive/i).first()).toBeVisible();
  await expect(page.getByText(/third-party gallery entry/i)).toBeVisible();
});

test("Homebrew file-formula VFS image boots in browser and runs file --version", async ({ page }) => {
  const vfsUrl = process.env.KANDELO_BROWSER_FILE_FORMULA_VFS_URL;
  if (!vfsUrl && process.env.KANDELO_HOMEBREW_STRICT_PUBLISHER_SMOKE === "1") {
    throw new Error("KANDELO_BROWSER_FILE_FORMULA_VFS_URL is required for the strict publisher smoke");
  }
  test.skip(
    !vfsUrl,
    "KANDELO_BROWSER_FILE_FORMULA_VFS_URL is required for the published Homebrew file-formula smoke",
  );
  test.setTimeout(360_000);

  await gotoOrSkip(page, `/?vfs=${encodeURIComponent(vfsUrl!)}`, false);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 240_000);

  await runTerminalCommand(
    page,
    "/home/linuxbrew/.linuxbrew/bin/file --version",
    /^file(?:\.wasm)?-5\.45$/m,
    180_000,
  );
});

test("an image-owned Homebrew shell boots without legacy shell downloads", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const configuredVfsUrl = process.env.KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL;
  const configuredShellPath = process.env.KANDELO_HOMEBREW_DEFAULT_SHELL_PATH;
  const configuredShellArgv0 = process.env.KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0;
  const configured = [
    configuredVfsUrl,
    configuredShellPath,
    configuredShellArgv0,
  ].some((value) => value !== undefined);
  if (configured && (!configuredVfsUrl || !configuredShellPath || !configuredShellArgv0)) {
    throw new Error(
      "KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL, " +
      "KANDELO_HOMEBREW_DEFAULT_SHELL_PATH, and " +
      "KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0 must be configured together",
    );
  }
  const shellPath = configuredShellPath ?? "/home/linuxbrew/.linuxbrew/bin/dash";
  const shellArgv0 = configuredShellArgv0 ?? "dash";
  const fixturePath = configuredVfsUrl ? undefined : await writeHomebrewDefaultShellFixture();
  const vfsUrl = configuredVfsUrl ?? new URL(fixturePath!, baseURL).href;
  const legacyShellFetches: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      request.resourceType() === "fetch"
      && /\/(?:bash|dash)\.wasm(?:\?|$)/.test(url)
      && !url.includes("?import&url")
    ) {
      legacyShellFetches.push(url);
    }
  });

  await gotoOrSkip(page, `/?vfs=${encodeURIComponent(vfsUrl)}`, false);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 180_000);
  await runTerminalCommand(
    page,
    "printf 'HOMEBREW_DEFAULT_SHELL:%s:%s:%s\\n' \"$0\" \"$(command -v \"$0\")\" \"${PATH%%:*}\"",
    `HOMEBREW_DEFAULT_SHELL:${shellArgv0}:${shellPath}:/home/linuxbrew/.linuxbrew/bin`,
    120_000,
  );

  expect(legacyShellFetches).toEqual([]);
});
