import { expect, test, type Browser, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { startPiplet } from "./support/piplet";

async function pair(browser: Browser, baseURL: string) {
  const piplet = await startPiplet();
  const contexts = await Promise.all([browser.newContext({ permissions: ["microphone"] }), browser.newContext({ permissions: ["microphone"] })]);
  const close = async () => { await Promise.all(contexts.map((context) => context.close())); await piplet.close(); };
  try {
    const pages = await Promise.all(contexts.map(async (context) => {
      const page = await context.newPage();
      await page.goto(`${baseURL}/pages/peer-network/?signalling=${encodeURIComponent(piplet.url)}`);
      await page.fill("#session", "guest-network"); return page;
    }));
    await pages[0].click("#host");
    await expect(pages[0].locator("#status")).toContainText('Hosting "guest-network"', { timeout: 90_000 });
    await pages[1].click("#join");
    await expect(pages[0].locator("#status")).toContainText("Connected as 10.89.0.1", { timeout: 60_000 });
    await expect(pages[1].locator("#status")).toContainText("Connected as 10.89.0.2", { timeout: 60_000 });
    return { host: pages[0], joiner: pages[1], close };
  } catch (error) { await close(); throw error; }
}
/** Both game guests are joiners, so every game packet crosses the forwarding host. */
async function forwardedGamePair(browser: Browser, baseURL: string) {
  const connected = await pair(browser, baseURL);
  const thirdContext = await browser.newContext({ permissions: ["microphone"] });
  try {
    const joiner = await thirdContext.newPage();
    const signalling = await connected.host.inputValue("#server");
    await joiner.goto(`${baseURL}/pages/peer-network/?signalling=${encodeURIComponent(signalling)}`);
    await connected.host.fill("#session", "forwarded-game");
    await joiner.fill("#session", "forwarded-game");
    await connected.host.click("#host");
    await expect(connected.host.locator("#status")).toContainText('Hosting "forwarded-game"');
    await joiner.click("#join");
    await expect(joiner.locator("#status")).toContainText("Connected as 10.89.0.3", { timeout: 60_000 });
    await expect.poll(() => connected.joiner.evaluate(() => (window as any).__peerNetwork.snapshot()?.members.length)).toBe(3);
    await joiner.fill("#destination", "peer-2");
    return { host: connected.joiner, joiner, router: connected.host,
      close: async () => { await thirdContext.close(); await connected.close(); } };
  } catch (error) { await thirdContext.close(); await connected.close(); throw error; }
}
async function binding(page: Page, port: number) {
  await expect.poll(() => page.evaluate((port) => (window as any).__peerNetwork.snapshot()?.bindings.some((binding: any) => binding.port === port), port)).toBe(true);
}
const gameOutput = (page: Page) => page.evaluate(() => {
  const demo = (window as any).__peerNetwork;
  const process = demo.processes()[demo.gamePid()];
  return process ? process.stdout + process.stderr + process.terminal : document.getElementById("status")!.textContent;
});

async function diagnostics(pages: Page[], game: string) {
  const state = await Promise.allSettled(pages.map((page) => page.evaluate(() => ({
    status: document.getElementById("status")?.textContent,
    output: document.getElementById("output")?.textContent,
    directory: (window as any).__peerNetwork.snapshot(),
    gamePid: (window as any).__peerNetwork.gamePid(),
    processes: (window as any).__peerNetwork.processes(),
  }))));
  writeFileSync(`../../.context/phase2-${game}-diagnostics.json`, JSON.stringify(state.map((entry) => entry.status === "fulfilled" ? entry.value : { error: String(entry.reason) }), null, 2));
}

test("two browsers exchange actual guest nc UDP datagrams through a named piplet", async ({ browser, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(240_000);
  const { host, joiner, close } = await pair(browser, baseURL!);
  try {
    const receiver = await joiner.evaluate(async () => { const child = await (window as any).__peerNetwork.listen(9100); return child.pid; });
    await binding(host, 9100);
    expect(await host.evaluate(() => (window as any).__peerNetwork.send("peer-2", 9100, "host-to-joiner"))).toBe(0);
    await expect.poll(() => joiner.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.stdout, receiver)).toContain("host-to-joiner");
    const replyReceiver = await host.evaluate(async () => { const child = await (window as any).__peerNetwork.listen(9200); return child.pid; });
    await binding(joiner, 9200);
    expect(await joiner.evaluate(() => (window as any).__peerNetwork.send("host", 9200, "joiner-to-host"))).toBe(0);
    await expect.poll(() => host.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.stdout, replyReceiver)).toContain("joiner-to-host");
    await expect.poll(() => joiner.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.exit, receiver)).toBe(0);
    await expect.poll(() => host.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.exit, replyReceiver)).toBe(0);
    await host.screenshot({ path: "../../.context/phase2-guest-udp-host.png", fullPage: true });
    await joiner.screenshot({ path: "../../.context/phase2-guest-udp-joiner.png", fullPage: true });
  } finally { try { await diagnostics([host, joiner], "nc"); } finally { await close(); } }
});

test("the forwarding host carries actual guest datagrams between two browser joiners", async ({ browser, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(240_000);
  const { host, joiner, close } = await pair(browser, baseURL!);
  const thirdContext = await browser.newContext({ permissions: ["microphone"] });
  try {
    const third = await thirdContext.newPage();
    const signalling = await host.inputValue("#server");
    await third.goto(`${baseURL}/pages/peer-network/?signalling=${encodeURIComponent(signalling)}`);
    await host.fill("#session", "guest-forwarding");
    await third.fill("#session", "guest-forwarding");
    await host.click("#host");
    await expect(host.locator("#status")).toContainText('Hosting "guest-forwarding"');
    await third.click("#join");
    await expect(third.locator("#status")).toContainText("Connected as 10.89.0.3", { timeout: 60_000 });
    await expect.poll(() => joiner.evaluate(() => (window as any).__peerNetwork.snapshot()?.members.length)).toBe(3);
    const receiver = await third.evaluate(async () => (await (window as any).__peerNetwork.listen(9400)).pid);
    await binding(joiner, 9400);
    expect(await joiner.evaluate(() => (window as any).__peerNetwork.send("peer-3", 9400, "forwarded-peer-two"))).toBe(0);
    await expect.poll(() => third.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.stdout, receiver)).toContain("forwarded-peer-two");
    const replyReceiver = await joiner.evaluate(async () => (await (window as any).__peerNetwork.listen(9500)).pid);
    await binding(third, 9500);
    expect(await third.evaluate(() => (window as any).__peerNetwork.send("peer-2", 9500, "forwarded-peer-three"))).toBe(0);
    await expect.poll(() => joiner.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.stdout, replyReceiver)).toContain("forwarded-peer-three");
    await expect.poll(() => third.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.exit, receiver)).toBe(0);
    await expect.poll(() => joiner.evaluate((pid) => (window as any).__peerNetwork.processes()[pid]?.exit, replyReceiver)).toBe(0);
    await diagnostics([host, joiner, third], "nc-star");
    await host.screenshot({ path: "../../.context/phase2-guest-udp-star.png", fullPage: true });
  } finally { await thirdContext.close(); await close(); }
});

test("two browser guests play Doom through a separate forwarding host", async ({ browser, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(300_000);
  const { host, joiner, router, close } = await forwardedGamePair(browser, baseURL!);
  try {
    await host.click("#doom-host");
    await expect.poll(() => gameOutput(host), { timeout: 90_000 }).toContain("waiting for server");
    await binding(joiner, 2342);
    await joiner.click("#doom-join");
    for (const page of [host, joiner]) {
      await expect.poll(() => gameOutput(page), { timeout: 90_000 }).toContain("game starting");
      await expect.poll(() => page.evaluate(() => (window as any).__peerNetwork.screen()), { timeout: 60_000 }).toBeGreaterThan(100_000);
      expect(await page.evaluate(() => (window as any).__peerNetwork.processes()[(window as any).__peerNetwork.gamePid()].exit)).toBeNull();
    }
    await expect.poll(() => gameOutput(host)).toMatch(/player 1 of 2/i);
    await expect.poll(() => gameOutput(joiner)).toMatch(/player 2 of 2/i);
    await joiner.locator("#screen").click();
    const before = await joiner.evaluate(() => (window as any).__peerNetwork.screen());
    await joiner.keyboard.down("ArrowUp");
    await expect.poll(() => joiner.evaluate(() => (window as any).__peerNetwork.screen()), { timeout: 15_000 }).not.toBe(before);
    await joiner.keyboard.up("ArrowUp");
    await host.screenshot({ path: "../../.context/phase2-doom-host.png", fullPage: true });
    await joiner.screenshot({ path: "../../.context/phase2-doom-joiner.png", fullPage: true });
    await joiner.locator("#screen").screenshot({ path: "../../.context/phase2-doom-game.png" });
  } finally { try { await diagnostics([host, joiner, router], "doom"); } finally { await close(); } }
});

test("two browser guests play TyrQuake through a separate forwarding host", async ({ browser, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(360_000);
  const { host, joiner, router, close } = await forwardedGamePair(browser, baseURL!);
  try {
    await host.click("#quake-host");
    await expect.poll(() => host.evaluate(() => (window as any).__peerNetwork.gamePid()), { timeout: 120_000 }).toBeGreaterThan(0);
    await binding(joiner, 26000);
    await joiner.click("#quake-join");
    await expect.poll(() => gameOutput(host), { timeout: 120_000 }).toMatch(/client 10\.89\.0\.3.*connected/i);
    await expect.poll(() => gameOutput(joiner), { timeout: 90_000 }).toContain("CL_SignonReply: 4");
    for (const page of [host, joiner]) {
      await expect.poll(() => page.evaluate(() => (window as any).__peerNetwork.screen()), { timeout: 60_000 }).toBeGreaterThan(100_000);
      expect(await page.evaluate(() => (window as any).__peerNetwork.processes()[(window as any).__peerNetwork.gamePid()].exit)).toBeNull();
    }
    await joiner.locator("#screen").click();
    const before = await joiner.evaluate(() => (window as any).__peerNetwork.screen());
    await joiner.keyboard.down("ArrowUp");
    await expect.poll(() => joiner.evaluate(() => (window as any).__peerNetwork.screen()), { timeout: 15_000 }).not.toBe(before);
    await joiner.keyboard.up("ArrowUp");
    await host.screenshot({ path: "../../.context/phase2-quake-host.png", fullPage: true });
    await joiner.screenshot({ path: "../../.context/phase2-quake-joiner.png", fullPage: true });
    await joiner.locator("#screen").screenshot({ path: "../../.context/phase2-quake-game.png" });
  } finally { try { await diagnostics([host, joiner, router], "quake"); } finally { await close(); } }
});
