import { expect, test } from "@playwright/test";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("@slow Kandelo network lab runs UDP, TCP, and curl across local machines", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") runtimeErrors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => runtimeErrors.push(`pageerror: ${err.message}`));

  await page.goto(appUrl("/pages/network/"), { waitUntil: "domcontentloaded" });
  await page.locator("#run").click();

  await expect(page.locator("#overall-status")).toHaveText("complete", {
    timeout: 120_000,
  });
  await expect(page.locator("#result-count")).toHaveText("3/3");
  await expect(page.locator("#results")).toContainText("UDP datagram");
  await expect(page.locator("#results")).toContainText("TCP stream");
  await expect(page.locator("#results")).toContainText("curl over TCP");
  await expect(page.locator("#transcript")).toContainText("hello from beta over udp");
  await expect(page.locator("#transcript")).toContainText("hello from beta over tcp");
  await expect(page.locator("#transcript")).toContainText("Virtual addresses: alpha=10.88.0.2 beta=10.88.0.3 gamma=10.88.0.4");
  await expect(page.locator("#transcript")).toContainText("[beta:stdin] hello from beta over udp");
  await expect(page.locator("#transcript")).toContainText("[beta:stdin] hello from beta over tcp");
  await expect(page.locator("#transcript")).toContainText("[alpha:stdin] HTTP/1.0 200 OK");
  await expect(page.locator("#transcript")).toContainText("hello from alpha via curl");
  expect(runtimeErrors).toEqual([]);
});
