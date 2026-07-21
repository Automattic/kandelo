import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const strict = process.env.KANDELO_HOMEBREW_MAIN_SHELL_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_HOMEBREW_MAIN_SHELL_SHA256;

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(
  page: Page,
  expected: string | RegExp,
  timeout = 180_000,
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
  timeout = 180_000,
) {
  const input = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await input.count()) {
    await input.focus();
  } else {
    await page.locator(".kshell-host").first().click();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

test("the current main shell boots the exact public-bottle closure", async ({ page }) => {
  test.skip(!strict, "exact Homebrew main-shell CI configures this acceptance test");
  if (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256)) {
    throw new Error(
      "KANDELO_HOMEBREW_MAIN_SHELL_SHA256 must be the exact lowercase image digest",
    );
  }
  test.setTimeout(420_000);

  const legacyArtifactDownloads: string[] = [];
  const shellImageDigests: Array<Promise<string>> = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      request.resourceType() === "fetch" &&
      (
        (/\.(?:wasm|zip)(?:\?|$)/.test(url) &&
          !/kernel[^/]*\.wasm(?:\?|$)/.test(url)) ||
        (/\.vfs(?:\.zst)?(?:\?|$)/.test(url) &&
          !/shell[^/]*\.vfs\.zst(?:\?|$)/.test(url))
      )
    ) {
      legacyArtifactDownloads.push(url);
    }
  });
  page.on("response", (response) => {
    if (/shell[^/]*\.vfs\.zst(?:\?|$)/.test(response.url())) {
      shellImageDigests.push(
        response.body().then((body) => createHash("sha256").update(body).digest("hex")),
      );
    }
  });

  await page.goto("/?demo=shell", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  const overlay = page.locator("vite-error-overlay");
  if (await overlay.count()) {
    const detail = await overlay.evaluate((element) =>
      element.shadowRoot?.querySelector(".message-body")?.textContent?.trim()
      || element.shadowRoot?.textContent?.trim()
      || element.textContent?.trim()
      || "unknown Vite import error"
    );
    throw new Error(`Homebrew main-shell smoke hit a Vite error overlay: ${detail}`);
  }

  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 240_000);
  await runTerminalCommand(
    page,
    "printf 'HOMEBREW_MAIN_SHELL_PATH:%s:%s\\n' \"$0\" \"${PATH%%:*}\"",
    "HOMEBREW_MAIN_SHELL_PATH:bash:/home/linuxbrew/.linuxbrew/bin",
  );
  await runTerminalCommand(
    page,
    "/bin/sh -c 'set -e; " +
      "for cmd in sh bash dash tput cat awk grep sed bc file m4 make find diff " +
      "ed more ex less tar curl nc wget git gzip bzip2 xz zstd zip unzip lsof " +
      "nano vim nethack fbdoom modeset; do command -v \"$cmd\" >/dev/null; done; " +
      "printf \"HOMEBREW_MAIN_SHELL_OK:%s\\n\" \"$(git --version)\"'",
    "HOMEBREW_MAIN_SHELL_OK:git version 2.47.1",
    240_000,
  );

  expect(legacyArtifactDownloads).toEqual([]);
  const fetchedImageDigests = await Promise.all(shellImageDigests);
  expect(fetchedImageDigests.length).toBeGreaterThan(0);
  expect(new Set(fetchedImageDigests)).toEqual(new Set([expectedImageSha256]));
});
