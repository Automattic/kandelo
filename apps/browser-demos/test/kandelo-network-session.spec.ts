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
const terminalText = (page: Page) => page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
/** The last game Doom started, as it reports it on its terminal. */
async function doomGame(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const games = (await terminalText(page)).match(/player \d+ of \d+ \(\d+ nodes\)/g) ?? [];
  await page.getByRole("button", { name: "Demo", exact: true }).click();
  return games.at(-1) ?? "";
}
const pickLanEntry = async (page: Page, entry: string) => {
  await page.getByTestId("fb-dock-action-lan").click();
  await page.getByTestId(`fb-dock-menu-entry-${entry}`).click();
};
const members = (page: Page) => page.getByRole("list", { name: "Computers in this session" }).getByRole("listitem");

async function host(page: Page, name: string, profile = "shell"): Promise<string> {
  await gotoMachine(page, profile);
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
  // The room token is read into memory and kept out of the address bar, so
  // Share links and machine switches cannot carry it on.
  expect(new URL(page.url()).searchParams.has("network")).toBe(false);
  expect(new URL(page.url()).searchParams.get("profile")).toBe(new URL(link).searchParams.get("profile"));
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
  // The invitation opens the host's machine, and carries no script.
  expect([...shared.searchParams.keys()].sort()).toEqual(["network", "networkName", "profile", "vfs"]);
  expect(shared.searchParams.get("profile")).toBe("shell");
  expect(shared.searchParams.get("vfs")).toBe(new URL(page.url()).searchParams.get("vfs"));
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

    // LAN discovery is a broadcast: Doom's search on a joiner finds a
    // dedicated server on the hosting computer through the session. The
    // server is LAN-only: a browser cannot send UDP to Doom's internet
    // master server, and fbdoom exits when that registration send fails.
    await runTerminalCommand(page, "fbdoom -dedicated -privateserver > /tmp/doom-server.log 2>&1 &");
    await expect.poll(async () => (await runTerminalCommand(first.page, "fbdoom -localsearch 2>&1")).output, { timeout: 60_000 })
      .toMatch(/10\.89\.0\.1 .*Unnamed server[\s\S]*1 server\(s\) found\./);

    // Leaving drops one member everywhere; the host ending ends it for all.
    await first.page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await first.page.getByRole("button", { name: "Leave session", exact: true }).click();
    await expect(first.page.getByRole("button", { name: "Network session: not connected", exact: true })).toBeAttached();
    await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await expect(members(page)).toHaveCount(2, { timeout: 15_000 });
    await page.getByRole("button", { name: "Leave session", exact: true }).click();
    await second.page.getByRole("button", { name: /^Network session:/ }).click();
    await expect(second.page.locator(".knetwork-error")).toContainText("The network session ended", { timeout: 15_000 });
    // The host's room closed with it, so its invitation is not offered again.
    await expect(second.page.getByRole("button", { name: "Join session", exact: true })).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "Join session", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Network session: failed", exact: true })).toBeAttached();
});

test("a joiner can pick a different computer before joining", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  const link = await host(page, "Mixed machines");
  const context = await browser.newContext();
  const joiner = await context.newPage();
  try {
    await joiner.goto(link, { waitUntil: "domcontentloaded" });
    await running(joiner);
    await closePanel(joiner);
    // Launch another computer from the gallery; the unjoined invitation stays.
    await joiner.getByRole("button", { name: "New", exact: true }).click();
    await joiner.locator(".kgal-row", { has: joiner.locator(".kgal-machine-title", { hasText: /^Node\.js$/ }) })
      .getByRole("button", { name: "Launch" }).click();
    await expect.poll(() => new URL(joiner.url()).searchParams.get("profile"), { timeout: 120_000 }).toBe("node");
    await running(joiner);
    await joiner.getByRole("button", { name: "Network session: not connected", exact: true }).click();
    await joiner.getByRole("button", { name: "Join session", exact: true }).click();
    await expect(joiner.locator(".knetwork-status")).toContainText("this computer is 10.89.0.2", { timeout: 90_000 });
    await expect(members(page)).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test("an invitation can be dismissed without joining", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/?network=abcdefghijklmnopqrstuvwxyz&networkName=Party", { waitUntil: "domcontentloaded" });
  await running(page);
  expect(new URL(page.url()).searchParams.has("network")).toBe(false);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByRole("button", { name: "Join session", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create session", exact: true })).toBeVisible();
});

test("the Doom machine's LAN menu starts a two-player game across the session", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  const link = await host(page, "Doom night", "doom");
  await closePanel(page);
  // The host's game waits for its second player before it starts.
  await pickLanEntry(page, "coop-2");
  const { page: joiner, context } = await join(browser, link, "10.89.0.2");
  try {
    await closePanel(joiner);
    // fbDOOM reads a raw-mode terminal, so Ctrl+C would not end it; the
    // pane ends the display's owner and starts the joining game.
    await pickLanEntry(joiner, "join");
    await expect.poll(() => doomGame(page), { timeout: 90_000 }).toBe("player 1 of 2 (2 nodes)");
    await expect.poll(() => doomGame(joiner), { timeout: 30_000 }).toBe("player 2 of 2 (2 nodes)");
    await page.screenshot({ path: "../../.context/doom-lan-host.png" });
    await joiner.screenshot({ path: "../../.context/doom-lan-joiner.png" });

    // Single player still works on a computer that stays in the session.
    await pickLanEntry(joiner, "single");
    await expect.poll(() => doomGame(joiner), { timeout: 60_000 }).toBe("player 1 of 1 (1 nodes)");
    await expect(joiner.getByRole("button", { name: "Network session: connected", exact: true })).toBeAttached();
  } finally {
    await context.close();
  }
});
