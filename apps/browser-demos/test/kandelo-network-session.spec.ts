import { expect, test, type Browser, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

// Network sessions in the normal Kandelo app: one computer hosts, others
// open its link and join, and real guest programs talk over the session.
// The dev server relays the real piplet, so this needs PHP (see
// vite/dev-signalling.ts). The local ICE fixture relies on Chromium's
// loopback-candidate flag.

const running = (page: Page) =>
  expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
const closePanel = (page: Page) => page.locator(".knetwork .kshare-x").click();
const members = (page: Page) => page.getByRole("list", { name: "Computers in this session" }).getByRole("listitem");

async function host(page: Page, name: string): Promise<string> {
  await gotoMachine(page, "shell");
  await running(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  await page.getByLabel("Session name").fill(name);
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.getByRole("button", { name: "Network session: connected", exact: true })).toBeAttached({ timeout: 30_000 });
  const link = await page.locator("[data-network-link]").getAttribute("data-network-link");
  expect(link).toBeTruthy();
  return link!;
}

async function join(browser: Browser, link: string, expected: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await running(page);
  // The link opens the panel but never joins on its own.
  await expect(page.getByRole("button", { name: "Network session: not connected", exact: true })).toBeAttached();
  await page.getByRole("button", { name: "Join session", exact: true }).click();
  await expect(page.locator(".knetwork-status")).toContainText(`this computer is ${expected}`, { timeout: 90_000 });
  return { page, context };
}

test("computers join one hosted session from its link and talk over guest TCP", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  const link = await host(page, "LAN party");
  const shared = new URL(link);
  expect([...shared.searchParams.keys()].sort()).toEqual(["network", "networkName"]);
  expect(shared.searchParams.get("networkName")).toBe("LAN party");
  expect(shared.hash).toBe("");

  const first = await join(browser, link, "10.89.0.2");
  const second = await join(browser, link, "10.89.0.3");
  try {
    await expect(members(page)).toHaveCount(3);
    await expect(members(first.page)).toHaveCount(3);
    await page.screenshot({ path: "../../.context/network-session-host.png" });
    await second.page.screenshot({ path: "../../.context/network-session-joiner.png" });
    for (const each of [page, first.page, second.page]) await closePanel(each);

    // Joiner to joiner crosses the hosting computer's forwarding.
    await runTerminalCommand(second.page, "nc -n -l -p 7000 > /tmp/session.txt 2>&1 &");
    await expect.poll(async () => {
      const sent = await runTerminalCommand(first.page, "printf 'hello across the session\\n' | nc -c peer-3 7000; echo sent=$?");
      if (!sent.output.includes("sent=0")) return sent.output;
      return (await runTerminalCommand(second.page, "cat /tmp/session.txt")).output;
    }, { timeout: 60_000 }).toContain("hello across the session");

    // Leaving drops one member everywhere; the host ending ends it for all.
    await first.page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await first.page.getByRole("button", { name: "Leave session", exact: true }).click();
    await expect(first.page.getByRole("button", { name: "Network session: not connected", exact: true })).toBeAttached();
    await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await expect(members(page)).toHaveCount(2, { timeout: 15_000 });
    await page.getByRole("button", { name: "Leave session", exact: true }).click();
    await second.page.getByRole("button", { name: /^Network session:/ }).click();
    await expect(second.page.locator(".knetwork-error")).toContainText("The network session ended", { timeout: 15_000 });
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("a link to a session that does not exist fails visibly", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?network=abcdefghijklmnopqrstuvwxyz&networkName=Gone", { waitUntil: "domcontentloaded" });
  await running(page);
  await page.getByRole("button", { name: "Join session", exact: true }).click();
  await expect(page.locator(".knetwork-error")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Network session: failed", exact: true })).toBeAttached();
});
