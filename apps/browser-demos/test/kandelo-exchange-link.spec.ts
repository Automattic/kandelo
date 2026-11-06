// A link the machine asks to open: `xdg-open URI` in the guest publishes a
// text/uri-list output, the app shows the URI in full, and only a click on
// Open opens it in a new tab. Dismiss releases the output without opening.

import { expect, test } from "@playwright/test";
import { gotoMachineOrSkip } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test("xdg-open in the guest asks the page, and Open opens the link in a new tab", async ({ page }) => {
  test.setTimeout(240_000);
  await page.context().route("https://example.com/**", (route) => route.fulfill({ body: "foo" }));
  await gotoMachineOrSkip(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toContain("kandelo$");

  expect((await runTerminalCommand(page, "xdg-open https://example.com/foo", undefined, 60_000)).exitCode).toBe(0);
  const link = page.getByTestId("exchange-link");
  await expect(link).toHaveCount(1);
  await expect(link.getByTestId("exchange-link-uri")).toHaveText("https://example.com/foo");

  const popup = page.waitForEvent("popup");
  await link.getByTestId("exchange-link-open").click();
  await (await popup).waitForURL("https://example.com/foo");
  await expect(link).toHaveCount(0);

  expect((await runTerminalCommand(page, "xdg-open https://example.com/bar", undefined, 60_000)).exitCode).toBe(0);
  await expect(link.getByTestId("exchange-link-uri")).toHaveText("https://example.com/bar");
  await link.getByTestId("exchange-link-dismiss").click();
  await expect(link).toHaveCount(0);
});

test("a published URI list skips comments and opens only http, https and mailto links", async ({ page }) => {
  test.setTimeout(240_000);
  await page.context().route("https://example.com/**", (route) => route.fulfill({ body: "foo" }));
  await gotoMachineOrSkip(page, "shell");
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toContain("kandelo$");

  const list = "# foo\\r\\nhttps://example.com/baz\\r\\nfile:///etc/passwd\\r\\nhttps://example.com/qux\\r\\n";
  expect((await runTerminalCommand(page,
    `printf '${list}' > links.uri && kandelo-publish --mime text/uri-list links.uri`, undefined, 60_000)).exitCode).toBe(0);
  const link = page.getByTestId("exchange-link");
  await expect(link).toContainText("wants to open links");
  await expect(link.getByTestId("exchange-link-uri")).toHaveText([
    "https://example.com/baz", "file:///etc/passwd", "https://example.com/qux",
  ]);
  await expect(link).toContainText("Only http, https and mailto links open.");

  const opened: string[] = [];
  page.context().on("page", (popup) => opened.push(popup.url()));
  await link.getByTestId("exchange-link-open").click();
  await expect(link).toHaveCount(0);
  await expect.poll(() => opened.length).toBe(2);

  // Past 8 KiB a URI list is an ordinary output to save, not a link.
  expect((await runTerminalCommand(page,
    "printf '%09000d' 0 > big.uri && kandelo-publish --mime text/uri-list big.uri", undefined, 60_000)).exitCode).toBe(0);
  const output = page.locator('[data-testid="exchange-output"][data-output-name="big.uri"]');
  await expect(output).toHaveCount(1);
  await expect(link).toHaveCount(0);
  await output.getByTestId("exchange-output-dismiss").click();
  await expect(output).toHaveCount(0);
});
