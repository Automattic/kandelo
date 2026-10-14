import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { runTerminalCommand } from "./support/terminal-command";

// Two computers on separate networks join one session. Each browser runs in
// its own home network behind its own NAT, in the Linux lab that
// test/network-lab/lab.sh builds; the only route between them is through
// both NATs, and their only ICE server is the lab's STUN server. Run it with
// test/network-lab/run.sh, which starts a dev server configured for the lab.

const LAB_DIR = join(dirname(fileURLToPath(import.meta.url)), "network-lab");
const LAB_STUN = '[{"urls":"stun:203.0.113.1:3478"}]';
const ROUTER = { a: "203.0.113.10", b: "203.0.113.20" } as const;
const port = Number(process.env.KANDELO_PLAYWRIGHT_PORT ?? 5401);
const origin = `http://203.0.113.1:${port}`;
// One lab per worker: parallel workers each build their own topology.
const container = `kandelo-network-lab-${port}-${process.pid}`;

// run.sh passes the host's Docker CLI; the dev shell's PATH has none.
const docker = (...args: string[]) => execFileSync(process.env.KANDELO_DOCKER ?? "docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let homes: { a: Browser; b: Browser } | null = null;
let hostForwarder: Server | null = null;

/**
 * The lab reaches the dev server as host.docker.internal. Docker Desktop
 * (macOS, Windows) forwards that name to the host's loopback, where the dev
 * server listens. Docker Engine on Linux maps it to the bridge network's
 * gateway address instead, which a loopback-bound server does not answer, so
 * on Linux the test listens on that gateway address and relays to loopback.
 */
async function reachDevServerFromDocker(): Promise<Server | null> {
  if (process.platform !== "linux") return null;
  const gateway = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}");
  const relay = createServer((inbound) => {
    const outbound = createConnection({ host: "127.0.0.1", port });
    inbound.pipe(outbound).pipe(inbound);
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(port, gateway, () => resolve());
  });
  return relay;
}
const transcript: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(600_000);
  if (process.env.KANDELO_NETWORK_LAB !== "1" || process.env.VITE_KANDELO_ICE_SERVERS !== LAB_STUN) {
    throw new Error("run this spec with test/network-lab/run.sh: the dev server needs the lab's STUN server");
  }
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch (error) {
    throw new Error(`the network lab needs a running Docker: ${(error as Error).message}`);
  }
  docker("build", "--quiet", "--tag", "kandelo-network-lab", LAB_DIR);
  hostForwarder = await reachDevServerFromDocker();
  docker("run", "--detach", "--name", container, "--privileged", "--shm-size=1g",
    "--add-host=host.docker.internal:host-gateway",
    "--publish", "127.0.0.1::9101", "--publish", "127.0.0.1::9102",
    "kandelo-network-lab", String(port));
  await expect.poll(() => docker("logs", container), { timeout: 60_000 }).toContain("LAB ready");
  const endpoint = (wsPort: number, name: string) =>
    `ws://${docker("port", container, `${wsPort}/tcp`).split("\n")[0]}/home-${name}`;
  homes = {
    a: await chromium.connect(endpoint(9101, "a")),
    b: await chromium.connect(endpoint(9102, "b")),
  };
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    // Files, not inline bodies: the line reporter truncates long attachments.
    const browsers = testInfo.outputPath("lab-browsers.txt");
    writeFileSync(browsers, transcript.join("\n"));
    await testInfo.attach("lab-browsers.txt", { path: browsers, contentType: "text/plain" });
    const netlink = testInfo.outputPath("lab-netlink.txt");
    writeFileSync(netlink, ["router-a", "home-a", "router-b", "home-b"]
      .map((ns) => `== ${ns}\n${docker("exec", container, "cat", `/lab/netlink-${ns}.log`)}`).join("\n"));
    await testInfo.attach("lab-netlink.txt", { path: netlink, contentType: "text/plain" });
  }
});

test.afterAll(async () => {
  await homes?.a.close();
  await homes?.b.close();
  try { docker("rm", "--force", container); } catch { /* already gone */ }
  await new Promise<void>((resolve) => (hostForwarder ? hostForwarder.close(() => resolve()) : resolve()));
});

const running = (page: Page) =>
  expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 240_000 });
const closePanel = (page: Page) => page.locator(".knetwork .kshare-x").click();

/** Every peer connection the page makes, so the test can read its route. */
async function recordPeerConnections(page: Page) {
  await page.addInitScript(() => {
    const Native = RTCPeerConnection;
    const made: RTCPeerConnection[] = [];
    (globalThis as { __kandeloPeerConnections?: RTCPeerConnection[] }).__kandeloPeerConnections = made;
    globalThis.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args);
        made.push(this);
      }
    } as typeof RTCPeerConnection;
  });
}

/** The candidates of each connected link's selected pair. */
function selectedRoutes(page: Page) {
  return page.evaluate(async () => {
    const made = (globalThis as { __kandeloPeerConnections?: RTCPeerConnection[] }).__kandeloPeerConnections ?? [];
    const routes: { local: string; remote: string; address: string }[] = [];
    for (const connection of made) {
      if (connection.connectionState !== "connected") continue;
      const stats = new Map<string, Record<string, unknown>>();
      (await connection.getStats()).forEach((entry: Record<string, unknown>) => stats.set(entry.id as string, entry));
      for (const entry of stats.values()) {
        if (entry.type !== "candidate-pair" || entry.state !== "succeeded" || !entry.nominated) continue;
        const local = stats.get(entry.localCandidateId as string)!;
        const remote = stats.get(entry.remoteCandidateId as string)!;
        routes.push({ local: String(local.candidateType), remote: String(remote.candidateType), address: String(remote.address) });
      }
    }
    return routes;
  });
}

test("a computer on another network joins through both NATs with STUN only", async () => {
  test.setTimeout(600_000);
  const host = await homes!.a.newPage();
  const joiner = await homes!.b.newPage();
  // The browsers run in the lab, out of the report's reach; keep what they
  // say so a failure explains itself.
  transcript.length = 0;
  for (const [name, page] of [["host", host], ["joiner", joiner]] as const) {
    const note = (line: string) => transcript.push(`[${new Date().toISOString()}] ${name} ${line}`);
    page.on("console", (message) => note(`console.${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => note(`page error: ${error.message}`));
    page.on("crash", () => note("renderer crashed"));
    page.on("requestfailed", (request) => note(`request failed: ${request.url()} ${request.failure()?.errorText}`));
  }
  await recordPeerConnections(host);
  await recordPeerConnections(joiner);

  await host.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await running(host);
  await host.getByRole("button", { name: "Network session: not connected", exact: true }).click();
  await host.getByLabel("Session name").fill("Across town");
  await host.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(host.getByRole("button", { name: "Network session: connected", exact: true })).toBeAttached({ timeout: 60_000 });
  const link = (await host.locator("[data-network-link]").getAttribute("data-network-link"))!;
  expect(new URL(link).origin).toBe(origin);

  await joiner.goto(link, { waitUntil: "domcontentloaded" });
  await running(joiner);
  await joiner.getByRole("button", { name: "Join session", exact: true }).click();
  await expect(joiner.locator(".knetwork-status")).toContainText("this computer is 10.89.0.2", { timeout: 90_000 });
  await closePanel(host);
  await closePanel(joiner);

  // The link crosses both NATs: each side reaches the other at its router's
  // public address, learned through STUN, and nothing is relayed.
  const hostRoutes = await selectedRoutes(host);
  const joinerRoutes = await selectedRoutes(joiner);
  expect(hostRoutes.length).toBeGreaterThan(0);
  expect(joinerRoutes.length).toBeGreaterThan(0);
  for (const route of hostRoutes) expect(route.address).toBe(ROUTER.b);
  for (const route of joinerRoutes) expect(route.address).toBe(ROUTER.a);
  for (const route of [...hostRoutes, ...joinerRoutes]) {
    expect(route.local).not.toBe("relay");
    expect(route.remote).not.toBe("relay");
  }

  // Guest programs talk over it: a TCP stream from the host to the joiner.
  await runTerminalCommand(joiner, "nc -n -l -p 7000 > /tmp/across.txt 2>&1 &");
  await expect.poll(async () => {
    const sent = await runTerminalCommand(host, "printf 'hello from another network\\n' | nc -c peer-2 7000; echo sent=$?");
    if (!sent.output.includes("sent=0")) return sent.output;
    return (await runTerminalCommand(joiner, "cat /tmp/across.txt")).output;
  }, { timeout: 60_000 }).toContain("hello from another network");
  await host.screenshot({ path: "../../.context/network-lab-host.png" });
  await joiner.screenshot({ path: "../../.context/network-lab-joiner.png" });
});
