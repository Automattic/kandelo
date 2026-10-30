import { expect } from "@playwright/test";
import { test } from "./support/persistent-page";
import { gotoMachine, machineUrl } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parsePackageSessions, sessionDefaults, sessionPresentation, type SessionOffer } from "../../../web-libs/kandelo-session/src/package-sessions";
import { encodeSessionInvitation } from "../../../web-libs/kandelo-session/src/session-invitation";

test.use({ actionTimeout: 30_000 });
const running = (page: import("@playwright/test").Page) => expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
const form = (page: import("@playwright/test").Page) => page.getByRole("form", { name: "Host activity" });
const link = (page: import("@playwright/test").Page) => page.locator("[data-network-link]");
async function terminalText(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  return page.locator(".kshell-host:visible .xterm-rows").innerText();
}
async function setup(page: import("@playwright/test").Page) {
  await gotoMachine(page, "shell"); await running(page);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
}

test("friendly names, alphabetical activities and inset arrows lead to a separate active session dialog", async ({ page, context, browserName }) => {
  test.setTimeout(300_000);
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  const host = form(page);
  const frame = await page.locator(".knetwork").boundingBox();
  for (const activity of ["fbdoom/game", "tyrquake/game", "termchat/chat", ""]) {
    await host.getByLabel("Activity", { exact: true }).selectOption(activity);
    expect(await page.locator(".knetwork").boundingBox()).toEqual(frame);
  }
  await expect(host.getByLabel("Session name")).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  const titles = (await host.getByLabel("Activity", { exact: true }).locator("option").allTextContents()).slice(1);
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
  expect(await host.getByLabel("Activity", { exact: true }).evaluate(el => getComputedStyle(el).backgroundPosition)).toContain("12px");
  await page.screenshot({ path: `../../.context/session-setup-${browserName}.png`, animations: "disabled" });
  await host.getByRole("button", { name: "Start network session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(host).toHaveCount(0);
  expect(await page.locator(".knetwork").boundingBox()).toEqual(frame);
  await expect(link(page)).toHaveAttribute("data-network-link", /network=/);
  const first = (await link(page).getAttribute("data-network-link"))!;
  if (browserName === "chromium") {
    await expect(page.getByText("Link copied.", { exact: false })).toBeVisible();
    await expect(page.locator('.knetwork-notice[data-tone="success"]')).toBeInViewport();
    expect(await page.locator(".knetwork-notice-message").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
    await page.evaluate(() => navigator.clipboard.writeText("replaced clipboard"));
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  }
  await page.screenshot({ path: `../../.context/session-active-${browserName}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator(".knetwork .kshare-actions").evaluate(footer => {
    const dialog = footer.closest(".knetwork")!.getBoundingClientRect();
    return [...footer.querySelectorAll("button")].every(button => {
      const box = button.getBoundingClientRect();
      return box.left >= dialog.left && box.right <= dialog.right;
    });
  })).toBe(true);
  await page.screenshot({ path: `../../.context/session-active-phone-${browserName}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  const activeFrame = await page.locator(".knetwork").boundingBox();
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  expect(await page.locator(".knetwork").boundingBox()).toEqual(activeFrame);
  await host.getByLabel("Session", { exact: true }).selectOption("replace");
  await host.getByLabel("Session name").fill("Cosmic Otters");
  page.once("dialog", dialog => dialog.dismiss());
  await host.getByRole("button", { name: "Start network session", exact: true }).click();
  await expect(host).toBeVisible();
  await expect(page.getByRole("button", { name: "Network session: connected", exact: true })).toBeVisible();
  await host.getByLabel("Session", { exact: true }).selectOption("keep");
  await host.getByRole("button", { name: "Show join link", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible();
  expect(new URL((await link(page).getAttribute("data-network-link"))!).searchParams.get("network")).toBe(new URL(first).searchParams.get("network"));
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await host.getByLabel("Session", { exact: true }).selectOption("replace");
  await host.getByLabel("Session name").fill("Cosmic Otters");
  page.once("dialog", dialog => dialog.accept());
  await host.getByRole("button", { name: "Start network session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 60_000 });
  const second = (await link(page).getAttribute("data-network-link"))!;
  expect(new URL(second).searchParams.get("network")).not.toBe(new URL(first).searchParams.get("network"));
  if (browserName === "chromium") expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(second);
  await page.getByRole("button", { name: "Leave session", exact: true }).click();
  await expect(host).toBeVisible(); await expect(link(page)).toHaveCount(0);
  expect(await page.locator(".knetwork").boundingBox()).toEqual(activeFrame);
  await page.setViewportSize({ width: 844, height: 390 });
  await host.getByLabel("Activity", { exact: true }).selectOption("fbdoom/game");
  await expect(host.locator("[data-activity-warning]")).toHaveCount(0);
  await expect(host.locator("p:visible")).toHaveCount(0);
  await host.getByLabel("Game WAD", { exact: true }).selectOption("freedm");
  await expect(host.locator("[data-activity-warning]")).toHaveText("Designed for deathmatch.");
  await host.getByLabel("Game WAD", { exact: true }).selectOption("shareware");
  await expect(host.locator("[data-activity-warning]")).toHaveCount(0);
  const shortFrame = (await page.locator(".knetwork").boundingBox())!;
  expect(shortFrame.y).toBeGreaterThanOrEqual(12);
  expect(shortFrame.y + shortFrame.height).toBeLessThanOrEqual(378);
  expect(await page.locator(".knetwork .kshare-body").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.locator(".knetwork .kshare-hd").getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  await expect(page.locator(".knetwork .kshare-actions").getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
});

test("clipboard denial preserves the active invitation and a manual copy route", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("Clipboard denied")) } }));
  await setup(page);
  await form(page).getByRole("button", { name: "Start network session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Couldn’t copy.", { exact: false })).toBeVisible();
  await expect(link(page)).toHaveAttribute("data-network-link", /network=/);
  await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled();
});

test("Doom and Quake levels follow the data source and uploaded WAD contents", async ({ page }) => {
  test.setTimeout(240_000);
  await setup(page);
  const host = form(page), level = host.getByLabel("Starting level", { exact: true });
  await host.getByLabel("Activity", { exact: true }).selectOption("fbdoom/game");
  await expect(level.locator("option")).toHaveCount(9); await level.selectOption("E1M3");
  await host.getByLabel("Game WAD", { exact: true }).selectOption("freedoom2");
  await expect(level.locator("option")).toHaveCount(32); await expect(level).toHaveValue("MAP01");
  await host.getByLabel("Game WAD", { exact: true }).selectOption("file");
  const names = ["E2M3", "THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES"];
  const bytes = Buffer.alloc(12 + names.length * 16); bytes.write("IWAD"); bytes.writeUInt32LE(names.length, 4); bytes.writeUInt32LE(12, 8);
  names.forEach((name, i) => bytes.write(name, 12 + i * 16 + 8));
  await host.getByLabel("File for Game WAD", { exact: true }).setInputFiles({ name: "custom.wad", mimeType: "application/octet-stream", buffer: bytes });
  await expect(level).toHaveValue("E2M3"); await expect(level.locator("option")).toHaveCount(1);
  await host.getByLabel("File for Game WAD", { exact: true }).setInputFiles({ name: "bad.wad", mimeType: "application/octet-stream", buffer: Buffer.from("invalid") });
  await expect(host.getByRole("alert")).toContainText("Invalid WAD");
  await expect(host.getByRole("button", { name: "Start activity", exact: true })).toBeDisabled();
  await host.getByLabel("Activity", { exact: true }).selectOption("tyrquake/game");
  await expect(level.locator("option")).toHaveCount(9);
  await host.getByLabel("Quake game data", { exact: true }).selectOption("openquartz");
  await expect(level.locator("option")).toHaveCount(14); await expect(level.locator("option[value=b_batt0]")).toHaveCount(0);
  await expect(host.locator("[data-activity-warning]")).toHaveText("Deathmatch maps only.");
  await host.getByLabel("Quake game data", { exact: true }).selectOption("shareware");
  await expect(host.locator("[data-activity-warning]")).toHaveCount(0);
  await level.selectOption("e1m2");
  await expect(host.locator("[data-activity-warning]")).toHaveCount(0);
  await host.getByLabel("Already running", { exact: true }).check();
  await expect(host.locator("[data-activity-warning]")).toHaveText("Choose the data and level your server is already running.");
  await host.getByLabel("Already running", { exact: true }).uncheck();
  await expect(host.locator("[data-activity-warning]")).toHaveCount(0);
  await page.screenshot({ path: `../../.context/session-levels-${test.info().project.name}.png`, animations: "disabled" });
});

test("invitation metadata is visible while the recipient's real computer is still booting", async ({ page, browser, browserName }) => {
  test.skip(browserName !== "chromium", "local WebRTC fixture uses Chromium loopback candidates");
  test.setTimeout(360_000);
  await page.context().grantPermissions(["microphone"]);
  await setup(page); await form(page).getByLabel("Session name").fill("Dancing Fireflies");
  await form(page).getByLabel("Activity", { exact: true }).selectOption("termchat/chat");
  await form(page).getByLabel("Your name").fill("alice");
  await form(page).getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(link(page)).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 90_000 });
  const invitation = (await link(page).getAttribute("data-network-link"))!;
  const context = await browser.newContext({ permissions: ["microphone"] });
  let releaseImport!: () => void;
  const importGate = new Promise<void>(resolve => { releaseImport = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await context.route("**/pages/kandelo/kernel-host/live-setup.ts*", async route => { await importGate; await route.continue(); });
    await context.route(url => /\.vfs(?:\.zst)?(?:$|\?)/.test(url.href), async route => {
      // Vite's ?url module is JavaScript, needed to mount the UI itself.
      // Delay only the actual machine image request, not its URL import.
      if (route.request().resourceType() !== "script") await gate;
      await route.continue();
    });
    const guest = await context.newPage();
    await guest.goto(invitation, { waitUntil: "domcontentloaded" });
    await expect(guest.getByRole("dialog", { name: "Session invitation", exact: true })).toBeVisible();
    await expect(guest.locator(".knetwork-status")).toContainText("Dancing Fireflies");
    await expect(guest.locator(".knetwork-metadata")).toContainText("Terminal chat");
    await expect(guest.locator(".knetwork-metadata")).toContainText(/Your name\s*alice/);
    await expect(guest.getByLabel("Your name", { exact: true })).toHaveValue("guest");
    await expect(guest.getByLabel("Your name", { exact: true })).toBeDisabled();
    await expect(guest.locator("[data-join-readiness]")).toContainText("Starting computer");
    await expect(guest.locator(".knetwork-notice")).toBeInViewport();
    const summary = (await guest.locator(".knetwork-summary").boundingBox())!;
    const notice = (await guest.locator(".knetwork-notice").boundingBox())!;
    const metadata = (await guest.locator(".knetwork-metadata").boundingBox())!;
    expect(notice.y - summary.y - summary.height).toBeGreaterThanOrEqual(16);
    expect(metadata.y - notice.y - notice.height).toBeGreaterThanOrEqual(16);
    expect(await guest.locator(".knetwork-notice-message").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
    await expect(guest.getByRole("button", { name: "Join and open chat", exact: true })).toBeDisabled();
    const waitingFrame = await guest.locator(".knetwork").boundingBox();
    releaseImport();
    await expect(guest.locator(".kdock-status-text")).toHaveAttribute("data-status", "booting");
    await expect(guest.getByLabel("Your name", { exact: true })).toBeDisabled();
    expect(await guest.locator(".knetwork").boundingBox()).toEqual(waitingFrame);
    await guest.screenshot({ path: "../../.context/session-invitation-waiting.png", animations: "disabled" });
    release(); await running(guest);
    await expect(guest.locator("[data-join-readiness]")).toContainText("Ready to join");
    expect(await guest.locator(".knetwork").boundingBox()).toEqual(waitingFrame);
    await guest.getByRole("button", { name: "Join and open chat", exact: true }).click();
    await expect.poll(() => guest.locator(".kshell-host:visible .xterm-rows").innerText(), { timeout: 90_000 }).toContain("alice is online");
  } finally { releaseImport(); release(); await context.close(); }
});

test("managed computer startup retains activity invitations and failed joins never claim readiness", async ({ page, browserName }) => {
  test.setTimeout(240_000);
  const bytes = readFileSync(new URL("../../../packages/registry/termchat/sessions.json", import.meta.url), "utf8");
  const manifest = parsePackageSessions(bytes), type = manifest.offers[0];
  const offer: SessionOffer = { version: 1, package: manifest.package, packageVersion: manifest.packageVersion,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"), offer: type.id, values: sessionDefaults(type.fields) };
  offer.presentation = sessionPresentation(manifest, type, offer);
  const url = new URL(await machineUrl(page, "shell"));
  url.searchParams.set("network", "abcdefghijklmnopqrstuvwx");
  url.searchParams.set("networkName", "Retained Fireflies");
  url.hash = encodeSessionInvitation(offer);
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname.endsWith("/__kandelo_signalling") && url.searchParams.get("room") === "abcdefghijklmnopqrstuvwx") {
        return Promise.resolve(new Response(JSON.stringify({ error: "Intentional signalling outage" }), { status: 503, headers: { "Content-Type": "application/json" } }));
      }
      return fetch(input, init);
    };
  });
  await page.goto(url.href);
  await running(page);
  expect(new URL(page.url()).searchParams.has("computer")).toBe(true);
  expect(new URL(page.url()).searchParams.has("network")).toBe(false);
  expect(new URL(page.url()).hash).toBe("");
  const invitation = page.getByRole("dialog", { name: "Session invitation", exact: true });
  await expect(invitation.locator(".knetwork-metadata")).toContainText("Terminal chat");
  await expect(invitation).not.toContainText("Shared network · no activity selected");
  const join = invitation.getByRole("button", { name: "Join and open chat", exact: true });
  await expect(join).toBeEnabled({ timeout: 60_000 });
  await join.click();
  await expect(invitation.locator('[data-join-readiness][data-tone="error"]')).toContainText("Couldn’t join. Try again.", { timeout: 60_000 });
  await expect(invitation.locator(".knetwork-error").filter({ hasText: "Intentional signalling outage" })).toBeVisible();
  await expect(invitation.locator("[data-join-readiness]")).not.toContainText("Ready to join");
  await expect(invitation.locator(".knetwork-metadata")).toContainText("Terminal chat");
  await expect(join).toBeEnabled();
  await page.screenshot({ path: `../../.context/activity-invitation-after-failed-join-${browserName}.png`, animations: "disabled" });
});

test("game invitations show host choices and acquisition details before host initialization, then reject mismatched display details", async ({ page }) => {
  test.setTimeout(240_000);
  const bytes = readFileSync(new URL("../../../packages/registry/fbdoom/sessions.json", import.meta.url), "utf8");
  const manifest = parsePackageSessions(bytes), type = manifest.offers[0], dependency = manifest.dependencies![0], source = dependency.sources[0];
  const offer: SessionOffer = { version: 1, package: manifest.package, packageVersion: manifest.packageVersion,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"), offer: type.id,
    values: { ...sessionDefaults(type.fields), mode: "deathmatch", level: "E1M2" },
    dependencies: [{ id: dependency.id, name: source.title.slice(0, 128), source: source.id, size: source.size, sha256: source.sha256, delivery: "hint" }] };
  offer.presentation = sessionPresentation(manifest, type, offer);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/pages/kandelo/kernel-host/live-setup.ts*", async route => { await gate; await route.continue(); });
  let releaseImage!: () => void;
  const imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
  await page.route(url => /\.vfs(?:\.zst)?(?:$|\?)/.test(url.href), async route => {
    if (route.request().resourceType() !== "script") await imageGate;
    await route.continue();
  });
  try {
    await page.goto(`/?profile=shell&network=${"a".repeat(24)}&networkName=Cosmic+Otters${encodeSessionInvitation(offer)}`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "Session invitation", exact: true });
    await expect(dialog).toBeVisible();
    const surface = await dialog.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(await page.locator("html").getAttribute("data-k-theme")).toBe("kandelo");
    await expect(dialog.locator(".knetwork-metadata")).toContainText("Deathmatch");
    await expect(dialog.locator(".knetwork-metadata")).toContainText("Starting level");
    await expect(dialog.locator(".knetwork-metadata")).toContainText("E1M2");
    const join = dialog.getByRole("form", { name: "Join activity" });
    await expect(join).not.toContainText(dependency.hint);
    await expect(join).toContainText(`Source: ${source.title}`);
    await expect(join.locator('input[type="file"]')).toBeDisabled();
    await expect(join.getByRole("button", { name: /^Join and/ })).toBeDisabled();
    const frame = await dialog.boundingBox();
    // Finish the held module request before asking the screenshot API to wait
    // for document fonts. Keep the real image request held during the capture.
    release();
    await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "booting");
    expect(await dialog.boundingBox()).toEqual(frame);
    await page.screenshot({ path: `../../.context/session-game-invitation-preboot-${test.info().project.name}.png`, animations: "disabled" });
    releaseImage(); await running(page);
    expect(await dialog.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(surface);
    await expect(join.getByRole("link", { name: `Get ${source.title}`, exact: true })).toHaveAttribute("href", source.url);
    await expect(join.getByRole("button", { name: /^Join and/ })).toBeEnabled();
    offer.presentation.title = "Misleading game";
    await page.goto(`/?profile=shell&network=${"a".repeat(24)}${encodeSessionInvitation(offer)}`);
    await running(page);
    await expect(dialog.locator('.knetwork-notice[data-tone="error"]')).toContainText("Cannot join this activity.");
    // One live alert announces the failure; the join form explains it.
    await expect(dialog.getByRole("alert")).toHaveCount(1);
    await expect(dialog.locator(".knetwork-note").filter({ hasText: "Package sessions:" })).toContainText("display details do not match");
    await expect(dialog.getByRole("button", { name: /^Join and/ })).toHaveCount(0);
  } finally { release(); releaseImage(); }
});

for (const action of ["Close", "Dismiss"]) test(`${action} during initialization stays closed when the computer becomes ready`, async ({ page }) => {
  test.setTimeout(240_000);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/pages/kandelo/kernel-host/live-setup.ts*", async route => { await gate; await route.continue(); });
  try {
    await page.goto(`/?profile=shell&network=${"b".repeat(24)}&networkName=Quiet+Geckos`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "Session invitation", exact: true });
    await expect(dialog).toBeVisible();
    if (action === "Close") await dialog.locator(".kshare-x").click();
    else await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    release(); await running(page);
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
    if (action === "Close") await expect(dialog).toBeVisible();
    else await expect(page.getByRole("form", { name: "Host activity" })).toBeVisible();
  } finally { release(); }
});

test("changing activity stops Kandelo's previous foreground program and launches the selected Quake map", async ({ page, browserName }) => {
  test.setTimeout(420_000);
  await setup(page);
  await page.locator(".knetwork .kshare-x").click();
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("kandelo$");
  expect((await runTerminalCommand(page, "sleep 600 & echo $! > /tmp/unrelated-activity-test.pid")).exitCode).toBe(0);
  await page.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  await form(page).getByLabel("Activity", { exact: true }).selectOption("tyrquake/game");
  await form(page).getByLabel("Starting level", { exact: true }).selectOption("e1m2");
  await form(page).getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(link(page)).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 120_000 });
  await expect(page.locator(".knetwork-metadata")).toContainText("e1m2");
  await page.locator(".knetwork .kshare-x").click();
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain("Using protocol");
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 60_000 });
  await page.screenshot({ path: `../../.context/session-quake-level-${browserName}.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await form(page).getByLabel("Activity", { exact: true }).selectOption("tyrquake/game");
  await form(page).getByLabel("Starting level", { exact: true }).selectOption("e1m3");
  await form(page).getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".knetwork-metadata")).toContainText("e1m3");
  await page.locator(".knetwork .kshare-x").click();
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain("Using protocol");
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 60_000 });
  await page.screenshot({ path: `../../.context/session-quake-replacement-${browserName}.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await form(page).getByLabel("Activity", { exact: true }).selectOption("php/server");
  await form(page).getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".knetwork-metadata")).toContainText("PHP web server");
  await page.locator(".knetwork .kshare-x").click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect.poll(() => page.locator(".kshell-host:visible .xterm-rows").innerText(), { timeout: 90_000 }).toContain("Development Server");
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("kandelo$");
  const processes = await runTerminalCommand(page, "kill -0 $(cat /tmp/unrelated-activity-test.pid) && echo unrelated-still-running; ps -A");
  expect(processes.output).toContain("unrelated-still-running");
  expect(processes.output).not.toMatch(/\/usr\/bin\/quake(?:\s|$)/);
  expect(processes.output).toContain("php");
});


test("replacing a Freeciv activity retires its server, client and KMS owner before launching Quake", async ({ page, browserName }) => {
  test.setTimeout(360_000);
  await setup(page);
  await form(page).getByLabel("Activity", { exact: true }).selectOption("freeciv-browser-bundle/game");
  await form(page).getByLabel("Your name", { exact: true }).fill("ActivityHost");
  await form(page).getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(link(page)).toHaveAttribute("data-network-link", /#ks1=/, { timeout: 120_000 });
  await page.locator(".knetwork .kshare-x").click();
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain("ActivityHost has connected");
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kmodeset-surface")).toHaveAttribute("data-kms-owner-pid", /^[1-9]\d*$/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Network session: connected", exact: true }).click();
  await page.getByRole("button", { name: "Change activity", exact: true }).click();
  await form(page).getByLabel("Activity", { exact: true }).selectOption("tyrquake/game");
  await form(page).getByRole("button", { name: "Start activity", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Active session", exact: true })).toBeVisible({ timeout: 90_000 });
  await page.locator(".knetwork .kshare-x").click();
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain("Using protocol");
  await page.getByRole("button", { name: "Graphics", exact: true }).click();
  await expect(page.locator(".kdemo-surface-title", { hasText: "/DEV/FB0" })).toContainText(/pid \d+/, { timeout: 60_000 });
  await page.screenshot({ path: `../../.context/session-kms-replacement-${browserName}.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("kandelo$");
  const result = await runTerminalCommand(page, "ps -A");
  expect(result.output).not.toMatch(/freeciv(?:-server| |$)/);
  expect(result.output).toContain("quake");
});
