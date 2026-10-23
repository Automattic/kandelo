import { expect, test, type Browser, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

// Network sessions in the normal Kandelo app: one computer hosts, others
// open its link and join, and real guest programs talk over the session.
// The dev server relays the real piplet, so this needs PHP (see
// vite/dev-signalling.ts). The local ICE fixture relies on Chromium's
// loopback-candidate flag and a test-only microphone permission grant.
// WHY: the flag permits loopback, but Chromium's candidate filtering omits
// that interface without the grant. Every context needs it, including the
// default page and computers opened from invite links. No media is captured.
const localIceContextOptions = { permissions: ["microphone"] };
test.use(localIceContextOptions);

const running = (page: Page) =>
  expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
const closePanel = (page: Page) => page.locator(".knetwork .kshare-x").click();
/** The last game Doom started, as it reports it on its terminal. */
async function doomGame(page: Page): Promise<string> {
  const games = (await terminalLines(page)).match(/player \d+ of \d+ \(\d+ nodes\)/g) ?? [];
  return games.at(-1) ?? "";
}
const pickLanEntry = async (page: Page, entry: string) => {
  await page.getByTestId("fb-dock-action-lan").click();
  await page.getByTestId(`fb-dock-menu-entry-${entry}`).click();
};
/** Key presses into the display, as a player at the keyboard makes them. */
async function pressKeys(page: Page, keys: string[]) {
  await page.locator("canvas.kframebuffer-canvas").first().focus();
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(700);
  }
}
/** The terminal's visible lines, for what a game prints. */
async function terminalLines(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const text = await page.locator(".xterm-rows").first().evaluate((node) => [...node.children].map((row) => row.textContent).join("\n"));
  // With no program on the display the Demo view is unavailable.
  const demo = page.getByRole("button", { name: "Demo", exact: true });
  if (await demo.isEnabled()) await demo.click();
  return text;
}
/** Type a command at the machine's shell prompt, as a person would. */
async function typeAtPrompt(page: Page, command: string) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.locator(".kshell-host").first().click();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}
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
  const context = await browser.newContext(localIceContextOptions);
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

test("termchat discovers and chats between session joiners through the normal shell", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  const errors: string[] = [];
  const link = await host(page, "termchat room");
  const alice = await join(browser, link, "10.89.0.2");
  const bob = await join(browser, link, "10.89.0.3");
  const screen = (target: Page) => target.locator(".xterm-rows").first().innerText();
  try {
    for (const target of [page, alice.page, bob.page]) {
      target.on("pageerror", error => errors.push(error.message));
      await closePanel(target);
    }
    expect((await runTerminalCommand(alice.page, "printf 'termchat RTC file\\n' > /tmp/rtc.txt")).exitCode).toBe(0);
    await typeAtPrompt(alice.page, "termchat -u alice; echo termchat_exit=$?");
    await expect.poll(() => screen(alice.page), { timeout: 60_000 }).toContain("LAN Room");
    await typeAtPrompt(bob.page, "termchat -u bob; echo termchat_exit=$?");
    await expect.poll(() => screen(alice.page), { timeout: 60_000 }).toContain("bob is online");
    await expect.poll(() => screen(bob.page), { timeout: 60_000 }).toContain("alice is online");
    await typeAtPrompt(alice.page, "hello from alice over WebRTC");
    await expect.poll(() => screen(bob.page)).toContain("hello from alice over WebRTC");
    await typeAtPrompt(bob.page, "hello from bob over WebRTC");
    await expect.poll(() => screen(alice.page)).toContain("hello from bob over WebRTC");
    await typeAtPrompt(alice.page, "?send /tmp/rtc.txt");
    await expect.poll(() => screen(bob.page), { timeout: 30_000 }).toContain("Successfully received file");
    await alice.page.screenshot({ path: "../../.context/termchat-session-alice.png" });
    await bob.page.screenshot({ path: "../../.context/termchat-session-bob.png" });
    for (const target of [bob.page, alice.page]) {
      await target.locator(".kshell-host").first().click();
      await target.keyboard.press("Escape");
      await expect.poll(() => screen(target)).toContain("termchat_exit=0");
    }
    const received = await runTerminalCommand(bob.page, "cat /tmp/termchat/alice/rtc.txt");
    expect(received.exitCode).toBe(0);
    expect(received.output).toContain("termchat RTC file");
    expect(errors).toEqual([]);
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

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
  const context = await browser.newContext(localIceContextOptions);
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

test("a Doom host starts a LAN game before every player has joined", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  const link = await host(page, "Doom night", "doom");
  await closePanel(page);
  // Room for four; only one other computer comes.
  await pickLanEntry(page, "coop-4");
  const { page: joiner, context } = await join(browser, link, "10.89.0.2");
  try {
    await closePanel(joiner);
    await pickLanEntry(joiner, "join");
    await expect.poll(() => terminalLines(page), { timeout: 90_000 }).toContain("2 of 4 players have joined");
    await page.screenshot({ path: "../../.context/doom-lan-waiting-room.png" });
    // Esc leaves the waiting room; the host's room sees the player go.
    await pressKeys(joiner, ["Escape"]);
    await expect.poll(() => terminalLines(joiner), { timeout: 30_000 }).toContain("NET_WaitForLaunch: cancelled.");
    await expect.poll(() => terminalLines(page), { timeout: 60_000 }).toMatch(/1 of 4 players have joined\.\s*$/);
    // Quitting Doom leaves the shell; the player starts it again there.
    await typeAtPrompt(joiner, "/usr/local/bin/fbdoom -iwad /doom1.wad -autojoin");
    await expect.poll(() => terminalLines(page), { timeout: 90_000 }).toMatch(/2 of 4 players have joined\.\s*$/);
    // The waiting room starts the game with Space, as chocolate-doom's does.
    await pressKeys(page, ["Space"]);
    await expect.poll(() => doomGame(page), { timeout: 60_000 }).toBe("player 1 of 2 (2 nodes)");
    await expect.poll(() => doomGame(joiner), { timeout: 30_000 }).toBe("player 2 of 2 (2 nodes)");
  } finally {
    await context.close();
  }
});

test("Quake's own multiplayer menu hosts a game another computer finds and joins", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  // Quake is already running its demo loop when the session starts; nobody
  // restarts it.
  const link = await host(page, "Quake night", "quake");
  await closePanel(page);
  await expect.poll(() => terminalLines(page), { timeout: 120_000 }).toContain("Playing demo");
  // Main menu → Multiplayer → New Game → OK → Begin game.
  await pressKeys(page, ["Escape", "ArrowDown", "Enter", "ArrowDown", "Enter", "Enter", "Enter"]);
  await expect.poll(() => terminalLines(page), { timeout: 60_000 }).toMatch(/entered the game/);

  const { page: joiner, context } = await join(browser, link, "10.89.0.2");
  try {
    await closePanel(joiner);
    await expect.poll(() => terminalLines(joiner), { timeout: 120_000 }).toContain("Playing demo");
    // Main menu → Multiplayer → Join a Game → Search for local games.
    await pressKeys(joiner, ["Escape", "ArrowDown", "Enter", "Enter", "ArrowUp", "Enter"]);
    await joiner.waitForTimeout(5_000);
    await joiner.screenshot({ path: "../../.context/quake-lan-search.png" });
    // The list shows the hosting computer's game; Enter joins it.
    await pressKeys(joiner, ["Enter"]);
    await expect.poll(async () => ((await terminalLines(page)).match(/entered the game/g) ?? []).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: "../../.context/quake-lan-host.png" });
    await joiner.screenshot({ path: "../../.context/quake-lan-joiner.png" });
  } finally {
    await context.close();
  }
});
