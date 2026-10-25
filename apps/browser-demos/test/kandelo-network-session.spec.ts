import { expect, test, type Browser, type Page } from "@playwright/test";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodeSessionInvitation } from "../../../web-libs/kandelo-session/src/session-invitation";
import type { SessionOffer } from "../../../web-libs/kandelo-session/src/package-sessions";

// Network sessions in the normal Kandelo app: one computer hosts, others
// open its link and join, and real guest programs talk over the session.
// The dev server relays the real piplet, so this needs PHP (see
// vite/dev-signalling.ts). The local ICE fixture relies on Chromium's
// loopback-candidate flag and a test-only microphone permission grant.
// WHY: the flag permits loopback, but Chromium's candidate filtering omits
// that interface without the grant. Every context needs it, including the
// default page and computers opened from invite links. No media is captured.
const localIceContextOptions = { permissions: ["microphone"] };
test.beforeEach(async ({ context, browserName }) => {
  // Playwright's Firefox context does not accept the microphone permission.
  // Only Chromium's local-ICE fixture needs it; these pages never capture media.
  if (browserName === "chromium") await context.grantPermissions(["microphone"]);
});

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

test("package activity invitations reject incompatible procedures and do not launch after a failed join", async ({ page }) => {
  test.setTimeout(300_000);
  await gotoMachine(page, "shell"); await running(page);
  const url = new URL(page.url());
  url.searchParams.set("network", "abcdefghijklmnopqrstuvwxyz");
  const bytes = readFileSync(new URL("../../../packages/registry/termchat/sessions.json", import.meta.url));
  const offer: SessionOffer = { version: 1, package: "termchat", packageVersion: "1.3.1", manifestSha256: "f".repeat(64), offer: "chat", values: { name: "alice" } };
  url.hash = encodeSessionInvitation(offer);
  await page.goto(url.href); await running(page);
  await expect(page.getByRole("alert")).toContainText("requires a different installed package procedure");
  await expect(page.getByRole("form", { name: "Join activity" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Network session: not connected", exact: true })).toBeAttached();
  offer.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  url.hash = encodeSessionInvitation(offer);
  await page.goto(url.href); await running(page);
  await page.getByRole("form", { name: "Join activity" }).getByRole("button", { name: "Join and open chat", exact: true }).click();
  await expect(page.locator(".knetwork-status")).toHaveAttribute("data-phase", "error", { timeout: 60_000 });
  await expect(page.locator(".knetwork-error").first()).toBeVisible();
  await closePanel(page);
  expect((await runTerminalCommand(page, "ps -A")).output).not.toContain("termchat");
});

test("package activity invitations join before starting termchat in a fresh terminal", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  await gotoMachine(page, "shell");
  await running(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const offer = page.getByRole("form", { name: "Host activity" });
  await offer.getByLabel("Activity", { exact: true }).selectOption("termchat/chat");
  await offer.getByLabel("Your name").fill("alice");
  await offer.getByRole("button", { name: "Start and invite", exact: true }).click();
  await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 60_000 });
  const link = (await page.locator("[data-network-link]").getAttribute("data-network-link"))!;
  await closePanel(page);
  const screen = (target: Page) => target.locator(".kshell-host:visible .xterm-rows").innerText();
  await expect.poll(() => screen(page), { timeout: 60_000 }).toContain("LAN Room");
  const context = await browser.newContext(localIceContextOptions);
  const guest = await context.newPage();
  try {
    await guest.goto(link);
    await running(guest);
    expect(new URL(guest.url()).hash).toBe("");
    expect(new URL(guest.url()).searchParams.has("network")).toBe(false);
    await expect(guest.getByRole("button", { name: "Network session: not connected", exact: true })).toBeAttached();
    const join = guest.getByRole("form", { name: "Join activity" });
    await expect(join.getByLabel("Your name")).toHaveValue("guest");
    await join.getByLabel("Your name").fill("bob");
    await guest.screenshot({ path: "../../.context/package-session-chat-invitation.png", animations: "disabled" });
    await join.getByRole("button", { name: "Join and open chat", exact: true }).click();
    await expect.poll(() => screen(guest), { timeout: 90_000 }).toContain("alice is online");
    await expect.poll(() => screen(page), { timeout: 30_000 }).toContain("bob is online");
    await guest.locator(".kshell-host:visible").click();
    await guest.keyboard.insertText("joined via package declaration");
    await guest.keyboard.press("Enter");
    await expect.poll(() => screen(page)).toContain("joined via package declaration");
    await guest.screenshot({ path: "../../.context/package-session-chat-guest.png" });
    await page.screenshot({ path: "../../.context/package-session-chat-host.png" });
    await guest.keyboard.press("Escape");
    await expect.poll(() => screen(page)).toContain("bob is offline");
  } finally { await context.close(); }
});

test("an already-running termchat can be offered without restarting it", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  await gotoMachine(page, "shell");
  await running(page);
  await typeAtPrompt(page, "termchat -u alice; echo original_termchat_exit=$?");
  const screen = (target: Page) => target.locator(".kshell-host:visible .xterm-rows").innerText();
  await expect.poll(() => screen(page), { timeout: 60_000 }).toContain("LAN Room");
  await page.keyboard.insertText("before-invitation"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = page.getByRole("form", { name: "Host activity" });
  await form.getByLabel("Activity", { exact: true }).selectOption("termchat/chat");
  await form.getByLabel("Your name").fill("alice");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Share running activity", exact: true }).click();
  await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 60_000 });
  const link = (await page.locator("[data-network-link]").getAttribute("data-network-link"))!;
  await closePanel(page);
  await expect.poll(() => screen(page)).toContain("before-invitation");
  const context = await browser.newContext(localIceContextOptions);
  const guest = await context.newPage();
  try {
    await guest.goto(link); await running(guest);
    const join = guest.getByRole("form", { name: "Join activity" });
    await join.getByLabel("Your name").fill("bob");
    await join.getByRole("button", { name: "Join and open chat", exact: true }).click();
    await expect.poll(() => screen(guest), { timeout: 90_000 }).toContain("alice is online");
    await expect.poll(() => screen(page)).toContain("bob is online");
    // A participant can invite people to discovery-based chat while keeping
    // the room they joined; server-hosted activities still need the hub.
    await guest.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await guest.getByRole("button", { name: "Change activity", exact: true }).click();
    const reoffer = guest.getByRole("form", { name: "Host activity" });
    await reoffer.getByLabel("Activity", { exact: true }).selectOption("termchat/chat");
    await reoffer.getByLabel("Your name").fill("bob");
    await reoffer.getByRole("checkbox").check();
    await reoffer.getByRole("button", { name: "Share running activity", exact: true }).click();
    await expect(guest.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/);
    const reshared = new URL((await guest.locator("[data-network-link]").getAttribute("data-network-link"))!);
    expect(reshared.searchParams.get("network")).toBe(new URL(link).searchParams.get("network"));
    await closePanel(guest);
    expect(await screen(page)).toContain("before-invitation");
    await page.locator(".kshell-host:visible").click(); await page.keyboard.press("Escape");
    await expect.poll(() => screen(page)).toContain("original_termchat_exit=0");
  } finally { await context.close(); }
});

async function host(page: Page, name: string, profile = "shell"): Promise<string> {
  await gotoMachine(page, profile);
  await running(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  await page.getByLabel("Session name").fill(name);
  await page.getByRole("button", { name: "Create invite", exact: true }).click();
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

test("Doom's package offer acquires a WAD from bare shell and sends it to the player over WebRTC", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(480_000);
  await gotoMachine(page, "shell");
  await running(page);
  expect((await runTerminalCommand(page, "test ! -f /doom1.wad && test ! -f /tmp/kandelo-doom.wad")).exitCode).toBe(0);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = page.getByRole("form", { name: "Host activity" });
  await form.getByLabel("Activity", { exact: true }).selectOption("fbdoom/game");
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await form.getByLabel("Game type").selectOption("deathmatch");
  await form.getByLabel("Starting level", { exact: true }).selectOption("E1M2");
  await page.screenshot({ path: "../../.context/package-session-doom-offer.png", animations: "disabled" });
  await form.getByRole("button", { name: "Start and invite", exact: true }).click();
  await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 60_000 });
  const link = (await page.locator("[data-network-link]").getAttribute("data-network-link"))!;
  await closePanel(page);
  const context = await browser.newContext(localIceContextOptions);
  const guest = await context.newPage();
  let guestDownloads = 0;
  await guest.route("**/wads/doom1.wad", route => { guestDownloads++; return route.abort(); });
  const activeTerminal = async (target: Page) => {
    await target.getByRole("button", { name: "Terminal", exact: true }).click();
    return target.locator(".kshell-host:visible .xterm-rows").innerText();
  };
  try {
    await guest.goto(link); await running(guest);
    // Preparing the Doom image must not start its single-player auto-command.
    await closePanel(guest);
    await guest.getByRole("button", { name: "Terminal", exact: true }).click();
    expect((await runTerminalCommand(guest, "ps -A")).output).not.toContain("fbdoom");
    await guest.getByRole("button", { name: "Network session: not connected", exact: true }).click();
    const join = guest.getByRole("form", { name: "Join activity" });
    await expect(guest.locator(".knetwork-metadata")).toContainText("Deathmatch");
    await expect(guest.locator(".knetwork-metadata")).toContainText("E1M2");
    await guest.screenshot({ path: "../../.context/package-session-doom-invitation.png", animations: "disabled" });
    await join.getByRole("button", { name: "Join and play Doom", exact: true }).click();
    await expect.poll(() => activeTerminal(page), { timeout: 90_000 }).toContain("player 1 of 2 (2 nodes)");
    await expect.poll(() => activeTerminal(guest), { timeout: 60_000 }).toContain("player 2 of 2 (2 nodes)");
    await expect(page.getByRole("button", { name: "Demo", exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(guest.getByRole("button", { name: "Demo", exact: true })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole("button", { name: "Demo", exact: true }).click();
    await guest.getByRole("button", { name: "Demo", exact: true }).click();
    await expect(page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 30_000 });
    await expect(guest.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 30_000 });
    expect(guestDownloads).toBe(0);
    await pressKeys(page, ["Tab"]);
    await page.screenshot({ path: "../../.context/package-session-doom-level-automap.png", animations: "disabled" });
    await page.screenshot({ path: "../../.context/package-session-doom-host.png" });
    await guest.screenshot({ path: "../../.context/package-session-doom-guest.png" });
    await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await page.getByRole("button", { name: "Change activity", exact: true }).click();
    const another = page.getByRole("form", { name: "Host activity" });
    await another.getByLabel("Activity", { exact: true }).selectOption("fbdoom/game");
    await expect(another.getByRole("button", { name: "Start and invite", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Back to active session", exact: true }).click();
  } finally { await context.close(); }
});

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
  await expect(page.getByRole("button", { name: "Create invite", exact: true })).toBeVisible();
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


test("one invitation form creates a plain invite, preserves or replaces the room, and leaves", async ({ page }) => {
  test.setTimeout(300_000);
  await gotoMachine(page, "shell"); await running(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = page.getByRole("form", { name: "Host activity" });
  await expect(page.getByRole("button", { name: "Create session", exact: true })).toHaveCount(0);
  await expect(form.getByLabel("Activity", { exact: true })).toHaveValue("");
  await form.getByLabel("Session name").fill("First room");
  await form.getByRole("button", { name: "Create invite", exact: true }).click();
  const link = page.locator("[data-network-link]");
  await expect(link).toHaveAttribute("data-network-link", /networkName=First/);
  const first = (await link.getAttribute("data-network-link"))!;
  expect(new URL(first).hash).toBe("");
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await expect(form.getByLabel("Session", { exact: true })).toHaveValue("keep");
  await form.getByLabel("Activity", { exact: true }).selectOption("termchat/chat");
  await form.getByLabel("Your name").fill("host");
  await form.getByRole("button", { name: "Start and invite", exact: true }).click();
  await expect(link).toHaveAttribute("data-network-link", /#ks1=/);
  expect(new URL((await link.getAttribute("data-network-link"))!).searchParams.get("network")).toBe(new URL(first).searchParams.get("network"));
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await form.getByLabel("Activity", { exact: true }).selectOption("");
  await form.getByRole("button", { name: "Create invite", exact: true }).click();
  await expect(link).toHaveAttribute("data-network-link", first);
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await form.getByLabel("Session", { exact: true }).selectOption("replace");
  await form.getByLabel("Session name").fill("Replacement room");
  await form.getByLabel("Activity", { exact: true }).selectOption("termchat/chat");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Share running activity", exact: true }).click();
  await expect(link).toHaveAttribute("data-network-link", /networkName=Replacement/);
  expect(new URL((await link.getAttribute("data-network-link"))!).searchParams.get("network")).not.toBe(new URL(first).searchParams.get("network"));
  await page.getByRole("button", { name: "Leave session", exact: true }).click();
  await expect(page.locator(".knetwork-status")).toHaveAttribute("data-phase", "offline");
  await expect(link).toHaveCount(0);
  await form.getByLabel("Activity", { exact: true }).selectOption("");
  await expect(form.getByRole("button", { name: "Create invite", exact: true })).toBeEnabled();
  await page.screenshot({ path: "../../.context/invitation-ux-optional-activity.png", animations: "disabled" });
});


for (const dependencyMode of ["known hint", "uploaded hint", "uploaded peer"] as const) {
  test(`Doom invitations support ${dependencyMode} data with matching-file verification`, async ({ browser, page, browserName, request }) => {
    test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
    test.setTimeout(480_000);
    const manifest = JSON.parse(readFileSync(new URL("../../../packages/registry/fbdoom/sessions.json", import.meta.url), "utf8"));
    const source = manifest.dependencies[0].sources[0];
    const file = dependencyMode.startsWith("uploaded") ? await (await request.get(source.url)).body() : null;
    await gotoMachine(page, "shell"); await running(page);
    await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
    const form = page.getByRole("form", { name: "Host activity" });
    await form.getByLabel("Activity", { exact: true }).selectOption("fbdoom/game");
    if (file) {
      await form.getByLabel("Game WAD", { exact: true }).selectOption("file");
      await form.getByLabel("File for Game WAD", { exact: true }).setInputFiles({ name: "my-doom.wad", mimeType: "application/octet-stream", buffer: file });
    }
    await form.getByLabel("Guest data", { exact: true }).selectOption(dependencyMode.endsWith("peer") ? "peer" : "hint");
    await form.getByRole("button", { name: "Start and invite", exact: true }).click();
    await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 120_000 });
    const link = (await page.locator("[data-network-link]").getAttribute("data-network-link"))!;
    await closePanel(page);
    const context = await browser.newContext(localIceContextOptions);
    const guest = await context.newPage();
    try {
      await guest.goto(link); await running(guest);
      const join = guest.getByRole("form", { name: "Join activity" });
      const action = join.getByRole("button", { name: "Join and play Doom", exact: true });
      if (dependencyMode === "known hint") {
        await expect(join.getByRole("link", { name: "Get Doom shareware (Episode 1)" })).toHaveAttribute("href", source.url);
        await expect(join).toContainText("Get a matching copy");
      } else if (dependencyMode === "uploaded hint") {
        await expect(action).toBeDisabled();
        await join.getByLabel("File for Game WAD", { exact: true }).setInputFiles({ name: "wrong.wad", mimeType: "application/octet-stream", buffer: Buffer.from("wrong") });
        await action.click();
        await expect(guest.getByRole("alert")).toContainText("different size");
        await join.getByLabel("File for Game WAD", { exact: true }).setInputFiles({ name: "my-doom.wad", mimeType: "application/octet-stream", buffer: file! });
      } else {
        await expect(join).toContainText("Receive from host");
        await guest.route("**/wads/doom1.wad", route => route.abort());
      }
      await guest.screenshot({ path: `../../.context/invitation-ux-${dependencyMode.replaceAll(" ", "-")}.png`, animations: "disabled" });
      await action.click();
      const screen = async (target: Page) => {
        await target.getByRole("button", { name: "Terminal", exact: true }).click();
        return target.locator(".kshell-host:visible .xterm-rows").innerText();
      };
      await expect.poll(() => screen(page), { timeout: 90_000 }).toContain("player 1 of 2 (2 nodes)");
      await expect.poll(() => screen(guest), { timeout: 90_000 }).toContain("player 2 of 2 (2 nodes)");
      await expect(guest.locator(".knetwork")).toHaveCount(0);
    } finally { await context.close(); }
  });
}
