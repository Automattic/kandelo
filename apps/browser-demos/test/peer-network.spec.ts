import { expect, test, type Browser, type Page } from "../playwright-test";
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
async function binding(page: Page, port: number) {
  await expect.poll(() => page.evaluate((port) => (window as any).__peerNetwork.snapshot()?.bindings.some((binding: any) => binding.port === port), port)).toBe(true);
}

async function diagnostics(pages: Page[], label: string) {
  const state = await Promise.allSettled(pages.map((page) => page.evaluate(() => ({
    status: document.getElementById("status")?.textContent,
    output: document.getElementById("output")?.textContent,
    directory: (window as any).__peerNetwork.snapshot(),
    processes: (window as any).__peerNetwork.processes(),
  }))));
  writeFileSync(`../../.scratch/phase2-${label}-diagnostics.json`, JSON.stringify(state.map((entry) => entry.status === "fulfilled" ? entry.value : { error: String(entry.reason) }), null, 2));
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
    await host.screenshot({ path: "../../.scratch/phase2-guest-udp-host.png", fullPage: true });
    await joiner.screenshot({ path: "../../.scratch/phase2-guest-udp-joiner.png", fullPage: true });
    await joiner.click("#disconnect");
    await expect.poll(() => host.evaluate(() => (window as any).__peerNetwork.snapshot()?.members.length), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => host.evaluate(() => (window as any).__peerNetwork.snapshot()?.bindings.length)).toBe(0);
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
    await host.screenshot({ path: "../../.scratch/phase2-guest-udp-star.png", fullPage: true });
  } finally { await thirdContext.close(); await close(); }
});

test("one browser guest serves HTTP and another fetches it with packaged curl", async ({browser,baseURL,browserName}) => {
  test.skip(browserName !== "chromium", "the local ICE fixture uses Chromium's loopback candidate flag");
  test.setTimeout(180_000);
  const {host,joiner,close} = await pair(browser,baseURL!);
  try {
    const serverPid = await host.evaluate(() => (window as any).__peerNetwork.startHttp(18085));
    await expect.poll(() => joiner.evaluate(() => (window as any).__peerNetwork.snapshot()?.tcpListeners.some((l:any)=>l.address==="10.89.0.1"&&l.port===18085)),{timeout:60000}).toBe(true);
    const result = await joiner.evaluate(() => (window as any).__peerNetwork.fetchHttp("http://host:18085/"));
    expect(result.exit).toBe(0);
    expect(await joiner.evaluate(pid=>(window as any).__peerNetwork.processes()[pid].stdout,result.pid)).toBe("HTTP from Kandelo; client=10.89.0.2\n");
    expect(await host.evaluate(pid=>(window as any).__peerNetwork.processes()[pid].exit,serverPid)).toBeNull();
    await expect.poll(() => host.evaluate(pid=>(window as any).__peerNetwork.processes()[pid].stderr,serverPid)).toContain("[200]");
    await host.screenshot({path:"../../.scratch/phase3-http-server.png",fullPage:true});
    await joiner.screenshot({path:"../../.scratch/phase3-http-curl.png",fullPage:true});
    await host.evaluate(() => (window as any).__peerNetwork.stopHttp());
    await expect.poll(() => joiner.evaluate(() => (window as any).__peerNetwork.snapshot()?.tcpListeners.length)).toBe(0);
    const refused = await joiner.evaluate(() => (window as any).__peerNetwork.fetchHttp("http://host:18085/"));
    expect(refused.exit).toBe(7);
  } finally {await close();}
});
