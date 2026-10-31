import { expect, type Browser, type Page } from "@playwright/test";
import { test } from "./support/persistent-page";
import { gotoMachine } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

test.use({ actionTimeout: 30_000 });
const running = async (p: Page) => {
  await expect(p.locator(".kdock-status-text")).toHaveAttribute("data-status", /^(running|error)$/, { timeout: 180_000 });
  if (await p.locator(".kdock-status-text").getAttribute("data-status") === "error") {
    console.error("Activity boot failure", p.url(), await p.locator("body").innerText());
    throw new Error("Activity computer failed to boot; see its native diagnostics above");
  }
};
const close = (p: Page) => p.locator(".knetwork .kshare-x").click();
const terminal = async (p: Page) => {
  await p.getByRole("button", { name: "Terminal", exact: true }).click();
  return p.locator(".kshell-host:visible .xterm-rows").innerText();
};
test.beforeEach(async ({ context, browserName, page }) => {
  page.on("pageerror", error => console.error("Activity page error:", error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Activity browser error:", message.text()); });
  if (browserName === "chromium") await context.grantPermissions(["microphone"]);
});
async function offer(p: Page, activity: string, configure?: (form: ReturnType<Page["getByRole"]>) => Promise<void>) {
  await gotoMachine(p, "shell"); await running(p);
  await p.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = p.getByRole("form", { name: "Host activity" });
  await form.getByLabel("Activity", { exact: true }).selectOption(activity);
  await configure?.(form);
  await form.getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(p.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 120_000 });
  const link = (await p.locator("[data-network-link]").getAttribute("data-network-link"))!;
  await close(p);
  return link;
}
async function guest(browser: Browser, link: string, title: string, deviceScaleFactor = 1, whileJoining?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ permissions: ["microphone"], deviceScaleFactor, ...(deviceScaleFactor === 1 ? {} : { viewport: { width: 1600, height: 1100 } }) });
  const page = await context.newPage();
  try {
    await page.goto(link); await running(page);
    const form = page.getByRole("form", { name: "Join activity" });
    await form.getByRole("button", { name: title, exact: true }).click();
    await whileJoining?.(page);
    return { page, context };
  } catch (error) { await context.close(); throw error; }
}

async function readableKms(page: Page) {
  const badge = page.locator(".kdemo-surface-badge-text").filter({ hasText: /^\d+×\d+ ·/ });
  await expect.poll(async () => {
    const match = (await badge.innerText()).match(/^(\d+)×(\d+)/);
    const box = await page.locator(".kmodeset-canvas").boundingBox();
    if (!match || !box) return false;
    return Math.abs(box.width / Number(match[1]) - 1.5) < 0.03 && Math.abs(box.height / Number(match[2]) - 1.5) < 0.03;
  }, { timeout: 90_000 }).toBe(true);
}
async function openQuakeConsole(page: Page) {
  await page.bringToFront();
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 30_000 });
  await page.locator("canvas.kframebuffer-canvas").first().focus();
  // Escape leaves chat/console for game/menu. TyrQuake's hard-coded
  // Shift+Escape then opens the console from either, independent of binds.
  for (const key of ["Escape", "Shift+Escape"]) {
    await page.keyboard.press(key, { delay: 150 });
    await page.waitForTimeout(700);
  }
}
for (const source of ["freedoom1", "freedoom2", "freedm"]) {
  test(`${source} data is acquired, prepared with its notices and played over an activity invitation`, async ({ browser, page, browserName }) => {
    test.skip(browserName !== "chromium", "local WebRTC requires Chromium loopback candidates");
    test.setTimeout(420_000);
    if (source === "freedoom1") await page.addInitScript(() => {
      const send = RTCDataChannel.prototype.send;
      let sent = 0, held: (() => void) | null = null, released = false;
      (window as any).releaseActivityTransfer = () => { released = true; held?.(); held = null; };
      RTCDataChannel.prototype.send = function(data: any) {
        if (this.label === "activity-data-v1" && data instanceof ArrayBuffer) {
          sent += data.byteLength;
          if (!released && sent > 512 * 1024) { held = () => send.call(this, data); return; }
        }
        send.call(this, data);
      };
    });
    const link = await offer(page, "fbdoom/game", async form => {
      await form.getByLabel("Game WAD", { exact: true }).selectOption(source);
      await form.getByLabel("Game type").selectOption("deathmatch");
    });
    const other = await guest(browser, link, "Join and play Doom", 1, source !== "freedoom1" ? undefined : async recipient => {
      const notice = recipient.locator(".knetwork-notice");
      await expect(notice).toContainText("Receiving Game WAD");
      await expect(notice.getByRole("progressbar")).toHaveAttribute("value", String(512 * 1024));
      await expect(notice).toBeInViewport();
      expect(await notice.locator(".knetwork-notice-message").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
      await recipient.screenshot({ path: "../../.context/session-transfer-progress.png" });
      await page.evaluate(() => (window as any).releaseActivityTransfer());
    });
    try {
      await expect.poll(() => terminal(page), { timeout: 120_000 }).toContain("player 1 of 2 (2 nodes)");
      await expect.poll(() => terminal(other.page), { timeout: 120_000 }).toContain("player 2 of 2 (2 nodes)");
      for (const p of [page, other.page]) {
        await p.getByRole("button", { name: "Graphics", exact: true }).click();
        await expect(p.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 30_000 });
      }
      // A separate command terminal observes the real installed license file.
      await terminal(other.page);
      await other.page.getByRole("button", { name: "New terminal", exact: true }).click();
      await expect.poll(() => terminal(other.page)).toContain("kandelo$");
      const prepared = await runTerminalCommand(other.page, "test -s /tmp/kandelo-doom-data.bin && head -c 4 /tmp/kandelo-doom.wad && head -1 /tmp/kandelo-doom-notices/COPYING.txt");
      expect(prepared.output).toContain("IWAD");
      expect(prepared.output).toContain("Copyright");
      await page.screenshot({ path: `../../.context/activity-${source}-host.png` });
    } finally { await other.context.close(); }
  });
}
for (const source of ["shareware", "librequake", "openquartz"]) {
  test(`Quake ${source} starts and joins from a bare-shell activity invitation`, async ({ browser, page, browserName }) => {
    test.skip(browserName !== "chromium", "local WebRTC requires Chromium loopback candidates");
    test.setTimeout(480_000);
    const link = await offer(page, "tyrquake/game", async form => {
      await form.getByLabel("Quake game data", { exact: true }).selectOption(source);
    });
    const other = await guest(browser, link, "Join and play Quake");
    try {
      // QuakeC mods choose their own connection messages. Ask the engine's
      // native status command for its actual client count instead.
      await expect.poll(() => terminal(page), { timeout: 120_000 }).toContain("Using protocol");
      await expect.poll(async () => {
        await openQuakeConsole(page);
        await page.keyboard.type("status", { delay: 75 });
        await page.keyboard.press("Enter", { delay: 100 });
        await page.waitForTimeout(700);
        await page.keyboard.press("Escape", { delay: 150 });
        const output = await terminal(page);
        const status = [...output.matchAll(/players\s*:\s*(\d+) active/g)].at(-1);
        return status ? Number(status[1]) : 0;
      }, { timeout: 150_000, intervals: [1000, 2000] }).toBe(2);
      await expect.poll(() => terminal(other.page), { timeout: 120_000 }).toContain("Using protocol");
      if (source === "shareware") {
        await other.page.getByRole("button", { name: "Network session: connected", exact: true }).click();
        const active = other.page.getByRole("dialog", { name: "Active session", exact: true });
        await expect(active.locator(".knetwork-metadata")).toContainText("Quake game");
        await expect(active.getByRole("button", { name: "New session", exact: true })).toBeVisible();
        await expect(active.getByRole("button", { name: "Change activity", exact: true })).toHaveCount(0);
        await other.page.screenshot({ path: "../../.context/session-quake-guest-actions.png", animations: "disabled" });
        await close(other.page);
      }
      await expect.poll(async () => {
        await openQuakeConsole(page);
        await page.keyboard.type("say activity-host-ready", { delay: 50 });
        await page.keyboard.press("Enter", { delay: 100 });
        await page.keyboard.press("Escape", { delay: 150 });
        return await terminal(other.page);
      }, { timeout: 90_000, intervals: [1000, 2000] }).toContain("host: activity-host-ready");
      await openQuakeConsole(other.page);
      await other.page.keyboard.type("say activity-guest-ready", { delay: 50 });
      await other.page.keyboard.press("Enter", { delay: 100 });
      await other.page.keyboard.press("Escape", { delay: 150 });
      await expect.poll(() => terminal(page), { timeout: 60_000 }).toContain("guest: activity-guest-ready");
      for (const p of [page, other.page]) {
        await expect(p.getByRole("button", { name: "Graphics", exact: true })).toBeEnabled({ timeout: 30_000 });
        await p.getByRole("button", { name: "Graphics", exact: true }).click();
        await expect(p.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 30_000 });
      }
      await page.screenshot({ path: `../../.context/activity-quake-${source}-host.png` });
      await other.page.screenshot({ path: `../../.context/activity-quake-${source}-guest.png` });
    } finally { await other.context.close(); }
  });
}
test("Freeciv activity prepares the shell's KMS display and connects two named players", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "local WebRTC requires Chromium loopback candidates");
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  const link = await offer(page, "freeciv-browser-bundle/game", async form => {
    await form.getByLabel("Your name", { exact: true }).fill("Alice");
  });
  console.log("Freeciv host invitation ready");
  const other = await guest(browser, link, "Join and play Freeciv", 2);
  console.log("Freeciv guest launch dispatched");
  try {
    await expect.poll(() => terminal(page), { timeout: 180_000 }).toMatch(/guest has connected from 10\.89\.0\.2/);
    for (const p of [page, other.page]) {
      await expect(p.getByRole("button", { name: "Graphics", exact: true })).toBeEnabled({ timeout: 90_000 });
      await p.getByRole("button", { name: "Graphics", exact: true }).click();
      await expect(p.locator(".kmodeset-canvas")).toBeVisible();
      // Exercise absolute game UI, using the same real lock release as the
      // existing Freeciv UI tests; never replace requestPointerLock.
      await p.evaluate(() => {
        const release = () => { if (document.pointerLockElement) document.exitPointerLock(); };
        document.addEventListener("pointerlockchange", release); release();
      });
      await expect(p.locator(".kmodeset-surface")).toHaveAttribute("data-kms-owner-pid", /^[1-9]\d*$/, { timeout: 90_000 });
      await readableKms(p);
    }
    console.log("Freeciv both players connected and KMS owners visible");
    const clips = [];
    for (const p of [page, other.page]) {
      const box = (await p.locator(".kmodeset-canvas").boundingBox())!;
      const clip = { x: box.x + box.width * 0.28, y: box.y + 5, width: box.width * 0.44, height: 8 };
      clips.push({ p, clip, lobby: await p.screenshot({ clip }) });
    }
    console.log("Freeciv measured both native displays");
    // Both native clients press Start. This also exercises the activity's
    // pointer input after a shell-only boot, rather than only observing a PID.
    for (const p of [page, other.page]) {
      const canvas = p.locator(".kmodeset-canvas");
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      await canvas.click({ position: { x: box!.width * 0.965, y: box!.height * 0.965 } });
    }
    for (const { p, clip, lobby } of clips) {
      await expect.poll(async () => Buffer.compare(lobby, await p.screenshot({ clip })), { timeout: 90_000 }).not.toBe(0);
    }
    console.log("Freeciv native lobby changed after both Start clicks");
    // Wait for a stable native information strip, excluding the canvas
    // focus outline and pointer-lock toast, before asking either player to
    // end a turn. Early world setup repaints are not evidence of a turn.
    const headers = [];
    for (const item of clips) {
      await item.p.bringToFront();
      await item.p.locator(".kmodeset-canvas").focus();
      let before = await item.p.screenshot({ clip: item.clip });
      let same = 0;
      await expect.poll(async () => {
        const now = await item.p.screenshot({ clip: item.clip });
        same = Buffer.compare(before, now) === 0 ? same + 1 : 0;
        before = now; return same;
      }, { timeout: 30_000, intervals: [250] }).toBeGreaterThanOrEqual(4);
      headers.push({ ...item, before });
    }
    await expect.poll(async () => {
      for (const p of [page, other.page]) {
        await p.bringToFront();
        await p.locator(".kmodeset-canvas").focus();
        await p.keyboard.press("Shift+Enter", { delay: 100 });
      }
      const changed = await Promise.all(headers.map(async ({ p, clip, before }) => Buffer.compare(before, await p.screenshot({ clip })) !== 0));
      return changed.every(Boolean);
    }, { timeout: 60_000, intervals: [1000, 2000] }).toBe(true);
    await page.screenshot({ path: "../../.context/activity-freeciv-host.png" });
    await other.page.screenshot({ path: "../../.context/activity-freeciv-guest.png" });
  } finally { await other.context.close(); }
});

for (const density of [1, 2]) test.describe(`Freeciv activity density ${density}`, () => {
  test.use({ deviceScaleFactor: density, viewport: { width: 1600, height: 1100 } });
  test("uses the demo's readable monitor for fresh and repeated launches", async ({ page, browserName }) => {
    test.setTimeout(300_000);
    await offer(page, "freeciv-browser-bundle/game");
    await page.getByRole("button", { name: "Graphics", exact: true }).click();
    await expect(page.locator(".kmodeset-surface")).toHaveAttribute("data-kms-owner-pid", /^[1-9]\d*$/, { timeout: 90_000 });
    await readableKms(page);
    const firstOwner = await page.locator(".kmodeset-surface").getAttribute("data-kms-owner-pid");
    await page.screenshot({ path: `../../.context/freeciv-activity-readable-${browserName}-${density}.png`, scale: "css" });
    await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await page.getByRole("button", { name: "Change activity", exact: true }).click();
    const form = page.getByRole("form", { name: "Host activity" });
    await form.getByLabel("Activity", { exact: true }).selectOption("freeciv-browser-bundle/game");
    await form.getByRole("button", { name: "Start activity", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 90_000 });
    await close(page);
    await page.getByRole("button", { name: "Graphics", exact: true }).click();
    await expect.poll(() => page.locator(".kmodeset-surface").getAttribute("data-kms-owner-pid"), { timeout: 90_000 }).not.toBe(firstOwner);
    await expect(page.locator(".kmodeset-surface")).toHaveAttribute("data-kms-owner-pid", /^[1-9]\d*$/);
    await readableKms(page);
  });
});
for (const pkg of ["python-browser-bundle", "php"]) {
  test(`${pkg} shares a directory over the invited guest network`, async ({ browser, page, browserName }) => {
    test.skip(browserName !== "chromium", "local WebRTC requires Chromium loopback candidates");
    test.setTimeout(360_000);
    await gotoMachine(page, "shell"); await running(page);
    expect((await runTerminalCommand(page, "mkdir -p /tmp/activity-www && echo invitation-file > /tmp/activity-www/index.html")).exitCode).toBe(0);
    await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
    const form = page.getByRole("form", { name: "Host activity" });
    await form.getByLabel("Activity", { exact: true }).selectOption(`${pkg}/server`);
    await form.getByLabel("Directory to serve").fill("/tmp/activity-www");
    await form.getByRole("button", { name: "Start activity", exact: true }).click();
    await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 90_000 });
    const link = (await page.locator("[data-network-link]").getAttribute("data-network-link"))!;
    const title = pkg === "php" ? "Join and open PHP web server" : "Join and open Python file server";
    const other = await guest(browser, link, title);
    try {
      await expect(other.page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("invitation-file", { timeout: 120_000 });
      if (pkg === "python-browser-bundle") {
        // The same pane can switch between its own guest server and the peer.
        await terminal(other.page);
        const local = await runTerminalCommand(other.page, "mkdir -p /tmp/local-www && echo local-preview-file > /tmp/local-www/index.html");
        expect(local.exitCode).toBe(0);
        await other.page.getByRole("button", { name: "New terminal", exact: true }).click();
        await expect.poll(() => terminal(other.page)).toContain("kandelo$");
        await other.page.locator(".kshell-host:visible .xterm-helper-textarea").focus();
        await other.page.keyboard.type("php -S 0.0.0.0:8081 -t /tmp/local-www");
        await other.page.keyboard.press("Enter");
        await expect.poll(() => terminal(other.page), { timeout: 60_000 }).toContain("Development Server");
        await other.page.getByRole("button", { name: "Web", exact: true }).click();
        const address = other.page.getByRole("textbox", { name: "Preview URL path" });
        await address.fill("http://localhost:8081/"); await address.press("Enter");
        await expect(other.page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("local-preview-file", { timeout: 60_000 });
        await address.fill("http://host:8080/"); await address.press("Enter");
        await expect(other.page.frameLocator("iframe.kweb-frame").locator("body")).toContainText("invitation-file", { timeout: 60_000 });
        await other.page.getByRole("button", { name: "Network session: connected", exact: true }).click();
        await other.page.getByRole("button", { name: "Leave session", exact: true }).click();
        await expect(other.page.locator("iframe.kweb-frame")).toHaveCount(0);
      }
    }
    finally { await other.context.close(); }
  });
}


test("a connected client discovers a newly advertised Netcat activity and joins on its existing network", async ({ browser, page, browserName }) => {
  test.skip(browserName !== "chromium", "local WebRTC requires Chromium loopback candidates");
  test.setTimeout(300_000);
  await gotoMachine(page, "shell"); await running(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  await page.getByRole("button", { name: "Start network session", exact: true }).click();
  const hostLink = page.locator("[data-network-link]");
  await expect(hostLink).toHaveAttribute("data-network-link", /network=/, { timeout: 60_000 });
  const roomLink = (await hostLink.getAttribute("data-network-link"))!;
  const context = await browser.newContext({ permissions: ["microphone"] });
  const other = { context, page: await context.newPage() };
  try {
    await other.page.goto(roomLink); await running(other.page);
    await other.page.getByRole("button", { name: "Join session", exact: true }).click();
    await expect(other.page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible();
    await expect(other.page.getByRole("button", { name: "Change activity", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Change activity", exact: true }).click();
    const form = page.getByRole("form", { name: "Host activity" });
    await form.getByLabel("Activity", { exact: true }).selectOption("netcat/server");
    await form.getByLabel("Port", { exact: true }).fill("7788");
    await form.getByRole("button", { name: "Start activity", exact: true }).click();
    await expect(hostLink).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 60_000 });
    expect(new URL((await hostLink.getAttribute("data-network-link"))!).searchParams.get("network")).toBe(new URL(roomLink).searchParams.get("network"));
    await other.page.getByRole("button", { name: "Change activity", exact: true }).click();
    const activities = other.page.getByLabel("Activity", { exact: true });
    await expect(activities.locator("option")).toHaveText(["No activity — stay on the network", "Netcat text connection"]);
    await activities.selectOption("netcat/server");
    await expect(other.page.locator(".knetwork-metadata")).toContainText("7788");
    await other.page.getByRole("button", { name: "Join and open Netcat text connection", exact: true }).click();
    await close(page);
    for (const [p, text] of [[page, "hello-from-host"], [other.page, "hello-from-guest"]] as const) {
      await terminal(p);
      await p.locator(".kshell-host:visible .xterm-helper-textarea").focus();
      await p.keyboard.type(text); await p.keyboard.press("Enter");
    }
    await expect.poll(() => terminal(page)).toContain("hello-from-guest");
    await expect.poll(() => terminal(other.page)).toContain("hello-from-host");
    await other.page.getByRole("button", { name: "Network session: connected", exact: true }).click();
    await expect(other.page.getByRole("button", { name: "Change activity", exact: true })).toHaveCount(0);
    await other.page.getByRole("button", { name: "New session", exact: true }).click();
    await expect(other.page.getByLabel("Activity", { exact: true }).locator('option[value="fbdoom/game"]')).toHaveCount(1);
    await other.page.getByLabel("Session name").fill("Solar Whales");
    await other.page.getByRole("button", { name: "Start network session", exact: true }).click();
    await expect(other.page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible();
    const newLink = (await other.page.locator("[data-network-link]").getAttribute("data-network-link"))!;
    expect(new URL(newLink).searchParams.get("network")).not.toBe(new URL(roomLink).searchParams.get("network"));
    await expect(page.getByRole("button", { name: "Network session: connected", exact: true })).toBeVisible();
  } finally { await other.context.close(); }
});

test("a Freeciv activity opens a measured, owned KMS display after a terminal-only boot", async ({ page }) => {
  test.setTimeout(240_000);
  await offer(page, "freeciv-browser-bundle/game", async form => {
    await form.getByLabel("Your name", { exact: true }).fill("SoloHost");
  });
  await expect.poll(() => terminal(page), { timeout: 150_000 }).toMatch(/SoloHost has connected from (?:localhost|127\.0\.0\.1)/);
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kmodeset-canvas")).toBeVisible();
  await expect(page.locator(".kmodeset-surface")).toHaveAttribute("data-kms-owner-pid", /^[1-9]\d*$/, { timeout: 60_000 });
  await page.screenshot({ path: `../../.context/activity-freeciv-shell-${test.info().project.name}.png` });
  // Sharing an already-hosted game must leave its real server and client alive.
  await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  const form = page.getByRole("form", { name: "Host activity" });
  await form.getByLabel("Activity", { exact: true }).selectOption("freeciv-browser-bundle/game");
  await form.getByLabel("Already running").check();
  await form.getByRole("button", { name: "Show join link", exact: true }).click();
  await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/);
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await form.getByLabel("Activity", { exact: true }).selectOption("fbdoom/game");
  await expect(form.getByRole("button", { name: "Start activity", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back to active session", exact: true }).click();
});


test("a running website survives opening and quitting a Quake activity", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoMachine(page, "nginx"); await running(page);
  await expect(page.frameLocator("iframe.kweb-frame").getByRole("heading", { name: "Hello from nginx on WebAssembly!" })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  const form = page.getByRole("form", { name: "Host activity" });
  await form.getByLabel("Activity", { exact: true }).selectOption("tyrquake/game");
  await form.getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(page.locator("[data-network-link]")).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 120_000 });
  await close(page);
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 90_000 });
  await expect.poll(() => terminal(page), { timeout: 120_000 }).toContain("Using protocol");
  await openQuakeConsole(page);
  await page.keyboard.type("quit", { delay: 100 });
  await page.keyboard.press("Enter", { delay: 100 });
  await expect(page.frameLocator("iframe.kweb-frame").getByRole("heading", { name: "Hello from nginx on WebAssembly!" })).toBeVisible({ timeout: 60_000 });
});

test("a working local website stays visible when a new preview destination fails", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoMachine(page, "nginx"); await running(page);
  const frame = page.frameLocator("iframe.kweb-frame");
  await expect(frame.getByRole("heading", { name: "Hello from nginx on WebAssembly!" })).toBeVisible({ timeout: 120_000 });
  const address = page.getByRole("textbox", { name: "Preview URL path" });
  await address.fill("http://localhost:59999/"); await address.press("Enter");
  await expect(page.getByRole("alert")).toContainText("No in-kernel listener");
  await expect(frame.getByRole("heading", { name: "Hello from nginx on WebAssembly!" })).toBeVisible();
  await address.fill("http://outside.example/"); await address.press("Enter");
  await expect(page.getByRole("alert")).toContainText("connected Kandelo peer");
  await expect(frame.getByRole("heading", { name: "Hello from nginx on WebAssembly!" })).toBeVisible();
});
