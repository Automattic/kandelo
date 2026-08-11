import { expect, test, type Page } from "@playwright/test";
import { isNodeVfsImageUrl } from "../lib/shell-vfs-image-url";
import { runTerminalCommand } from "./support/terminal-command";

const strict = process.env.KANDELO_NODE_VFS_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_NODE_VFS_SHA256;

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(".xterm-rows")
    .first()
    .evaluate((node) => node.textContent ?? "");
}

async function waitForReady(page: Page, timeout = 180_000) {
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout })
    .toContain("Ready");
}

async function waitForPrompt(page: Page, timeout = 120_000) {
  await expect
    .poll(() => terminalText(page), { timeout })
    .toContain("spidermonkey-node$");
}

test("@slow Kandelo Node demo installs cowsay with npm", async ({
  page,
  baseURL,
}) => {
  if (
    strict &&
    (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256))
  ) {
    throw new Error(
      "KANDELO_NODE_VFS_SHA256 must be the exact lowercase image digest",
    );
  }
  if (!baseURL) throw new Error("Playwright baseURL is required");
  test.setTimeout(300_000);
  const runtimeErrors: string[] = [];
  const nodeResponses: Array<{ ok: boolean; url: string }> = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      msg.type() === "error" ||
      /Maximum call stack|Segmentation fault/i.test(text)
    ) {
      runtimeErrors.push(`${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) =>
    runtimeErrors.push(`pageerror: ${err.message}`),
  );
  page.on("response", (response) => {
    if (!isNodeVfsImageUrl(response.url())) return;
    nodeResponses.push({ ok: response.ok(), url: response.url() });
  });

  const productBase = new URL(process.env.KANDELO_TEST_BASE_URL ?? baseURL);
  await page.goto(new URL("?demo=node", productBase).href, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(2_000);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.waitForSelector("aside.kdemo", { timeout: 120_000 });
  await waitForReady(page, 240_000);
  await waitForPrompt(page);
  await expect
    .poll(() => nodeResponses.length, { timeout: 180_000 })
    .toBeGreaterThan(0);
  expect(
    nodeResponses.every(({ ok }) => ok),
    JSON.stringify(nodeResponses),
  ).toBe(true);
  if (strict) {
    const nodeUrls = [...new Set(nodeResponses.map(({ url }) => url))];
    const imageDigests = await Promise.all(
      nodeUrls.map((url) =>
        page.evaluate(async (imageUrl) => {
          // Hash a normal same-origin browser fetch. Large VFS responses can
          // be evicted from Chromium's inspector cache before body() reads it.
          const response = await fetch(imageUrl, { cache: "no-store" });
          if (!response.ok) {
            throw new Error(
              `could not fetch Node VFS image: ${response.status}`,
            );
          }
          const digest = await crypto.subtle.digest(
            "SHA-256",
            await response.arrayBuffer(),
          );
          return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        }, url),
      ),
    );
    expect(new Set(imageDigests)).toEqual(new Set([expectedImageSha256]));
  }

  const npmInstallCommand = [
    "rm -rf node_modules package-lock.json /tmp/.npm-cache /tmp/kandelo-npm.log /tmp/kandelo-cowsay.out",
    [
      "if npm install cowsay --verbose >/tmp/kandelo-npm.log 2>&1",
      "&& ./node_modules/.bin/cowsay Kandelo >/tmp/kandelo-cowsay.out 2>&1",
      "&& ! grep -E 'TAR_ENTRY_ERROR|EACCES' /tmp/kandelo-npm.log; then",
      "cat /tmp/kandelo-cowsay.out;",
      "printf 'KANDELO_NPM_OK\\n';",
      "else",
      "cat /tmp/kandelo-npm.log;",
      "cat /tmp/kandelo-cowsay.out 2>/dev/null;",
      "printf 'KANDELO_NPM_FAIL\\n';",
      "exit 1;",
      "fi",
    ].join(" "),
  ].join("; ");

  await runTerminalCommand(page, npmInstallCommand, "KANDELO_NPM_OK", 180_000);

  const text = await page.evaluate(() => document.body.innerText);
  expect(text).toContain("< Kandelo >");
  expect(text).not.toContain("KANDELO_NPM_FAIL");
  expect(text).not.toContain("Segmentation fault");
  expect(runtimeErrors).toEqual([]);
});
