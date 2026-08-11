import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { isShellVfsImageUrl } from "../lib/shell-vfs-image-url";
import { runTerminalCommand } from "./support/terminal-command";

const strict = process.env.KANDELO_CANONICAL_FLAT_SHELL_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_CANONICAL_FLAT_SHELL_SHA256;

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(".xterm-rows")
    .first()
    .evaluate((node) => node.textContent ?? "");
}

async function readLazyDownloadRows(page: Page): Promise<string[]> {
  const internals = page.getByRole("button", { name: "Internals" });
  if ((await internals.getAttribute("aria-pressed")) !== "true") {
    await internals.click();
  }
  await page.getByRole("tab", { name: "Lazy Load" }).click();
  const rows = await page
    .locator(".kdownload-table tbody tr")
    .evaluateAll((elements) =>
      elements.map(
        (element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      ),
    );
  await internals.click();
  return rows;
}

test("the canonical self-contained shell runs Homebrew without lazy downloads", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(!strict, "canonical flat-shell CI configures this acceptance test");
  test.skip(
    browserName !== "chromium",
    "the production proof targets Chromium",
  );
  if (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256)) {
    throw new Error(
      "KANDELO_CANONICAL_FLAT_SHELL_SHA256 must be the exact lowercase image digest",
    );
  }
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(360_000);

  const productBase = new URL(process.env.KANDELO_TEST_BASE_URL ?? baseURL);
  const shellResponses: Array<
    Promise<{ ok: boolean; sha256: string; url: string }>
  > = [];
  page.on("response", (response) => {
    if (!isShellVfsImageUrl(response.url())) return;
    shellResponses.push(
      response.body().then((bytes) => ({
        ok: response.ok(),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: response.url(),
      })),
    );
  });

  await page.goto(new URL("?demo=shell", productBase).href, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2_000);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), {
      timeout: 240_000,
    })
    .toContain("Ready");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() => shellResponses.length, { timeout: 180_000 })
    .toBeGreaterThan(0);
  const imageEvidence = await Promise.all(shellResponses);
  expect(
    imageEvidence.every(({ ok }) => ok),
    JSON.stringify(imageEvidence),
  ).toBe(true);
  expect(new Set(imageEvidence.map(({ sha256 }) => sha256))).toEqual(
    new Set([expectedImageSha256]),
  );

  const result = await runTerminalCommand(
    page,
    "/usr/bin/brew --version && " +
      "/opt/kandelo/homebrew/bin/ruby --version && " +
      "/opt/kandelo/homebrew/bin/bash -lc 'printf KANDELO_FLAT_SHELL_OK'",
    "KANDELO_FLAT_SHELL_OK",
    180_000,
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("KANDELO_FLAT_SHELL_OK");
  expect(await terminalText(page)).not.toMatch(/I\/O error/i);
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(
    /VFS[^\n]*I\/O error/i,
  );
  expect(await readLazyDownloadRows(page)).toEqual([]);
});
