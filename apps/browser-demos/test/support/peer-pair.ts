/**
 * Two Kandelo computers, connected in one browser.
 *
 * Two isolated contexts share no `BroadcastChannel`, so everything that
 * crosses between them travels a real WebRTC link exactly as it would between
 * two real computers. Connecting them is the same network session in every
 * spec that needs a pair — one hosts, the other opens the invite link and
 * joins — so the steps live here rather than in each spec. The dev server
 * relays the real piplet, so this needs PHP (see vite/dev-signalling.ts).
 *
 * Chromium only: only headless Chromium forms a loopback ICE pair.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

/** The dock's network session button, which names the session's phase. */
export function networkButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Network session: / });
}

/** The network session panel, a dialog over the page while it is open. */
function networkPanel(page: Page): Locator {
  return page.getByRole("dialog", { name: "Network session" });
}

/** Show the network session panel, whatever state it is in. */
export async function openNetworkPanel(page: Page): Promise<void> {
  if (await networkPanel(page).isVisible()) return;
  await networkButton(page).click();
  await expect(networkPanel(page)).toBeVisible();
}

/** What the panel says about the machine shared with the partner. */
function sharingStatus(page: Page): Locator {
  return page.locator(".ksharing-status");
}

const ICE_BOUNDARY = "no direct route";

/**
 * Host a session on `sharer`, join it from `viewer`, and leave `viewer`
 * watching the sharer's machine, as an empty viewer did before sessions.
 *
 * The invite link boots the session's machine on the viewer, so "Watch" gives
 * that copy up. Skips the test at the ICE boundary — no direct route between
 * two local contexts is a network limit, not a transport defect — and fails
 * on anything else.
 */
export async function connectPeers(
  sharer: Page,
  viewer: Page,
  skip: (reason: string) => void,
  { watch = true }: { watch?: boolean } = {},
): Promise<void> {
  await expect(sharer.locator(".kdock-status-text"))
    .toHaveAttribute("data-status", "running", { timeout: 300_000 });
  await openNetworkPanel(sharer);
  await sharer.getByLabel("Session name").fill("Pair");
  await sharer.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(networkButton(sharer)).toHaveAccessibleName("Network session: connected", { timeout: 30_000 });
  const link = await sharer.locator("[data-network-link]").getAttribute("data-network-link");
  expect(link).toBeTruthy();

  await viewer.goto(link!, { waitUntil: "domcontentloaded" });
  await expect(viewer.locator(".kdock-status-text"))
    .toHaveAttribute("data-status", "running", { timeout: 300_000 });
  await openNetworkPanel(viewer);
  await viewer.getByRole("button", { name: "Join session", exact: true }).click();
  await expectLinked(viewer, skip);
  await openNetworkPanel(sharer);
  await expect(sharingStatus(sharer)).toBeVisible({ timeout: 30_000 });
  if (watch) await watchSharer(viewer);
  await closeNetworkPanels([sharer, viewer]);
}

/**
 * Wait for this joiner's sharing link, or skip at the ICE boundary. Two shapes
 * of that boundary, neither a transport defect: the "no direct route" report,
 * and the silent hang where nothing ever settles — headless Chromium refuses a
 * second loopback pair this way after any pair was torn down. Every signalling
 * or codec bug fails differently, with its own reason.
 */
async function expectLinked(viewer: Page, skip: (reason: string) => void): Promise<void> {
  const joined = await Promise.race([
    sharingStatus(viewer).waitFor({ timeout: 90_000 }).then(() => "joined"),
    viewer.locator(".knetwork-error").waitFor({ timeout: 90_000 }).then(() => "failed"),
  ]).catch(() => "silent");
  if (joined === "joined") return;
  if (joined === "failed") {
    const failure = await viewer.locator(".knetwork-error").innerText();
    expect(failure, `the session failed outside the ICE boundary: ${failure}`)
      .toContain(ICE_BOUNDARY);
  }
  skip(
    "no ICE route between two local contexts — on macOS, grant the "
    + "Playwright browser Local Network permission to run this spec",
  );
}

/** Connect the joiner's sharing link to the host again, keeping its page. */
export async function reconnectPeers(viewer: Page, skip: (reason: string) => void): Promise<void> {
  await openNetworkPanel(viewer);
  await viewer.getByRole("button", { name: "Connect to host again", exact: true }).click();
  await expectLinked(viewer, skip);
  await closeNetworkPanels([viewer]);
}

/** Whether this computer has a sharing partner, read from the panel. */
export async function expectPaired(page: Page, paired: boolean, timeout = 30_000): Promise<void> {
  await openNetworkPanel(page);
  await expect(sharingStatus(page)).toHaveCount(paired ? 1 : 0, { timeout });
}

/**
 * Give the viewer's copy of the session's machine up to watch the host's.
 *
 * Under a join grant the released page starts its replica at once, so its
 * idle state can pass between two polls. The idle page and the replica both
 * hold the viewer role.
 */
export async function watchSharer(viewer: Page): Promise<void> {
  await openNetworkPanel(viewer);
  await viewer.getByRole("button", { name: "Watch host's machine", exact: true }).click();
  await expect(viewer.locator(".kdock-status"))
    .toHaveAttribute("data-role", "viewer", { timeout: 60_000 });
}

/** Close the network session panel, which covers the page while open. */
async function closeNetworkPanels(pages: Page[]): Promise<void> {
  for (const page of pages) {
    if (!(await networkPanel(page).isVisible())) continue;
    await networkPanel(page).getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(networkPanel(page)).toHaveCount(0);
  }
}

/**
 * Hide everything that would swallow a click meant for a terminal: the
 * network session panel, and the dock's guide popover.
 *
 * An open popover lays a dismiss layer across the page (`Dock.tsx`,
 * `kdock-popover-dismiss-layer`), and that layer takes the pointer-down: the
 * click closes the popover instead of focusing the terminal under it. A person
 * clicks again and gets on with it; a test clicks once, so it has to clear the
 * popovers first.
 *
 * The guide is here because adopting a machine opens it: the taker is running
 * a demo it did not launch, so the page shows that demo's guide over the
 * terminal the machine arrived with.
 *
 * Neither is tied to the link, so closing them changes nothing about what is
 * shared.
 */
export async function closeDockPopovers(pages: Page[]): Promise<void> {
  await closeNetworkPanels(pages);
  for (const page of pages) {
    const button = page.getByRole("button", { name: "Guide", exact: true });
    // The guide button is absent on a machine with no guide at all.
    if ((await button.count()) === 0) continue;
    if ((await button.getAttribute("aria-expanded")) === "true") {
      await button.click();
    }
    await expect(button).toHaveAttribute("aria-expanded", "false");
  }
}

/** The take-over control, offered only to a computer that may use it. */
export function takeOverButton(page: Page): Locator {
  return page.getByRole("button", { name: "Take over this machine" });
}

/**
 * Wait until this page is running a replica of the other computer's machine.
 *
 * Read from the dock rather than from a terminal on the page: the mirrored
 * terminal a viewer watches and the terminal of a machine it holds are the
 * same emulator in the same `.kshell-host`, so their presence says nothing
 * about which of the two this is. The dock says both halves — a machine is
 * running here, and this computer is still the viewer — and no shared surface
 * is left to watch.
 */
export async function expectReplica(page: Page): Promise<void> {
  await expect(page.locator(".kdock-status-text"))
    .toHaveAttribute("data-status", "running", { timeout: 300_000 });
  await expect(page.locator(".kdock-status"))
    .toHaveAttribute("data-role", "viewer");
  await expect(page.locator(".kshared-machine")).toHaveCount(0);
}

export async function terminalText(
  page: Page,
  selector: string,
): Promise<string> {
  return page
    .locator(`${selector} .xterm-rows`)
    .first()
    .evaluate((node) => node.textContent ?? "");
}

/**
 * Type into a terminal on a machine that has just arrived by handover.
 *
 * Waits for the machine's own terminal, not the held screen. While a machine
 * is moving, `SharedTerminal` keeps the last-watched screen up, dimmed, under
 * the same `.kshell-host` — a picture that refuses the keyboard
 * (`disableStdin`), because the machine is not running here yet. The dock
 * flips to `user` before the arriving machine's Shell mounts, so a test that
 * types on that signal alone types into the picture. A person reads the
 * dimming and waits for the prompt to come back; the wait below is that.
 *
 * Focuses the emulator's input directly instead of clicking the terminal. A
 * taker settles its boot descriptor and then loads the arriving image's demo
 * guide, and `App.tsx` opens that guide once per descriptor and title, so it
 * can open after a test has already cleared the popovers. An open popover lays
 * a dismiss layer over the page (`Dock.tsx`, `kdock-popover-dismiss-layer`)
 * that takes the pointer-down: the click closes the guide and focuses nothing,
 * and every keystroke after it goes to the page instead of the shell. A person
 * sees the guide and clicks again; a test cannot win that race.
 */
export async function typeIntoTerminal(
  page: Page,
  selector: string,
  line: string,
): Promise<void> {
  const live = page.locator(`${selector}:not(.kshared-terminal-host)`).first();
  await expect(live).toBeVisible({ timeout: 120_000 });
  await live.locator(".xterm-helper-textarea").first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}
