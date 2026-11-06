import { createHash } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { machineUrl } from "../apps/browser-demos/test/support/kandelo-machine.ts";
import { clickDockTool } from "../apps/browser-demos/test/support/dock.ts";
import { writeVfsFile } from "../host/src/vfs/image-helpers.ts";
import {
  bootDinitServiceVfs,
  configureWordPressRuntime,
  readVfsText,
  resolveServiceVfsImage,
  waitForHttp,
} from "../packages/registry/service-vfs-demo.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = {
  relPath: "programs/wordpress.vfs.zst",
  publicFile: "wordpress.vfs.zst",
  buildHint: "cargo xtask bootstrap wordpress",
};
type Profile = "wordpress-sqlite" | "wordpress-frankenphp" | "wordpress-frankenphp-caddy";
type Host = "node" | "browser";

interface Options {
  host: Host | "both";
  rounds: number;
  warmups: number;
  samples: number;
  clients: number;
  concurrentSamples: number;
  port: number;
  browserBaseUrl: string;
  output: string;
  imagePath?: string;
  soakSeconds: number;
  profiles: readonly Profile[];
}

interface RoundResult {
  host: Host;
  profile: Profile;
  round: number;
  startupMs: number;
  latenciesMs: number[];
  throughputRequests: number;
  throughputDurationMs: number;
  nodeProcessId?: number;
  serviceLog: string;
  soak?: SoakResult;
}

interface SoakResult {
  requests: number;
  durationMs: number;
  memoryScope: string;
  samples: { elapsedMs: number; rssBytes: number }[];
}

// These samples follow the timed benchmark, so process inspection does not
// contaminate request-latency measurements. No forced collection or restart.
async function measureSoak(
  seconds: number,
  clients: number,
  batch: () => Promise<void>,
  memory: () => Promise<number>,
  memoryScope: string,
): Promise<SoakResult> {
  const began = performance.now();
  const samples: { elapsedMs: number; rssBytes: number }[] = [];
  let requests = 0;
  const sample = async () => {
    const rssBytes = await memory();
    const record = { elapsedMs: performance.now() - began, rssBytes };
    samples.push(record);
    console.log(`soak ${memoryScope}: ${JSON.stringify({ ...record, requests })}`);
  };
  await sample();
  while (performance.now() - began < seconds * 1000) {
    await batch();
    requests += clients;
    if (performance.now() - began - samples.at(-1)!.elapsedMs >= 15_000) await sample();
  }
  await sample();
  return { requests, durationMs: performance.now() - began, memoryScope, samples };
}

async function chromiumRss(browser: Browser): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const pids = processInfo.map(process => process.id);
    if (pids.length === 0) throw new Error("Chromium reported no processes for RSS measurement");
    const values = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
    const rssKiB = values.trim().split(/\s+/).map(Number);
    if (rssKiB.some(value => !Number.isFinite(value))) throw new Error("Invalid native RSS sample");
    // Sum of process RSS can count shared native pages more than once.
    return rssKiB.reduce((total, value) => total + value, 0) * 1024;
  } finally { await session.detach(); }
}

function parseOptions(): Options {
  const values = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Expected --name=value, received ${argument}`);
    values.set(match[1]!, match[2]!);
  }
  const integer = (name: string, fallback: number, minimum: number): number => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`--${name} must be an integer >= ${minimum}`);
    }
    return value;
  };
  const host = values.get("host") ?? "both";
  if (host !== "node" && host !== "browser" && host !== "both") {
    throw new Error("--host must be node, browser, or both");
  }
  const known = new Set(["host", "rounds", "warmups", "samples", "clients", "concurrent-samples", "port", "browser-base-url", "output", "alternative", "soak-seconds", "image-path"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  }
  const port = integer("port", 3101, 1);
  const rounds = integer("rounds", 2, 1);
  if (port + (rounds - 1) * 4 + 3 > 65535) {
    throw new Error("--port and --rounds exceed the available TCP port range");
  }
  const alternative = values.get("alternative") ?? "classic";
  if (alternative !== "classic" && alternative !== "caddy") {
    throw new Error("--alternative must be classic or caddy");
  }
  return {
    host,
    rounds,
    warmups: integer("warmups", 3, 0),
    samples: integer("samples", 12, 1),
    clients: integer("clients", 4, 1),
    concurrentSamples: integer("concurrent-samples", 4, 1),
    port,
    browserBaseUrl: values.get("browser-base-url") ?? "http://127.0.0.1:5401",
    output: resolve(values.get("output") ?? ".context/wordpress-stack-benchmark.json"),
    imagePath: values.has("image-path") ? resolve(values.get("image-path")!) : undefined,
    soakSeconds: integer("soak-seconds", 0, 0),
    profiles: ["wordpress-sqlite", alternative === "caddy" ? "wordpress-frankenphp-caddy" : "wordpress-frankenphp"],
  };
}

function orderForRound(round: number, profiles: readonly Profile[]): readonly Profile[] {
  return round % 2 === 0 ? profiles : [...profiles].reverse();
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Benchmark samples must be nonempty finite numbers");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

async function fetchWordPress(url: string): Promise<void> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  if (response.status !== 200 || !body.includes("WordPress on Kandelo") ||
      /<b>(?:Fatal error|Parse error|Warning)<\/b>:/.test(body)) {
    throw new Error(`Invalid WordPress response: HTTP ${response.status}, body=${body.slice(0, 200)}`);
  }
}

function serviceName(profile: Profile): string {
  return profile === "wordpress-sqlite" ? "nginx" :
    profile === "wordpress-frankenphp-caddy" ? "frankenphp-caddy" : "frankenphp-classic";
}

function validateServiceLog(profile: Profile, log: string): void {
  if (/^(?:panic:|fatal error:)/m.test(log)) {
    throw new Error(`${profile} crashed during the measurement:\n${log.slice(-4000)}`);
  }
  if (profile !== "wordpress-sqlite") {
    const marker = profile === "wordpress-frankenphp-caddy"
      ? "FrankenPHP started" : "FrankenPHP classic listening";
    const starts = log.split(marker).length - 1;
    // A supervisor can restore HTTP after a crash; that is not sustained uptime.
    if (starts !== 1) throw new Error(`${profile} expected one startup, found ${starts}:\n${log.slice(-4000)}`);
  }
}

async function readBrowserServiceLog(page: Page, profile: Profile): Promise<string> {
  await clickDockTool(page, "Internals", { timeout: 5000 });
  const inspector = page.getByRole("dialog", { name: "Internals" });
  await inspector.getByRole("tab", { name: "VFS" }).click({ timeout: 5000 });
  for (const segment of ["var", "log"]) {
    await inspector.locator(".ktable tr", {
      has: page.locator("td", { hasText: new RegExp(`^${segment}/$`) }),
    }).click({ timeout: 5000 });
  }
  await inspector.locator(".ktable tr", {
    has: page.locator("td", { hasText: `${serviceName(profile)}.log` }),
  }).click({ timeout: 5000 });
  const log = await inspector.locator(".kinternals-surface pre").last().textContent();
  if (log === null) throw new Error(`Missing ${profile} service log`);
  return log;
}

async function measureNode(profile: Profile, round: number, options: Options, imagePath: string): Promise<RoundResult> {
  const target = serviceName(profile);
  const port = options.port + round * 4 + (profile === "wordpress-sqlite" ? 0 : 2);
  const smtpPort = port + 1;
  const start = performance.now();
  const diagnostics: unknown[] = [];
  const { host, pid, exitPromise } = await bootDinitServiceVfs({
    image,
    imagePath,
    target,
    maxWorkers: 12,
    maxPages: profile === "wordpress-frankenphp-caddy" ? 16384 : 4096,
    configure: (fs) => {
      const serviceConfigPath = `/etc/dinit.d/${target}`;
      const serviceConfig = readVfsText(fs, serviceConfigPath);
      configureWordPressRuntime(fs, { port });
      // Preserve the shipped service log; the demo helper routes it to stdio.
      writeVfsFile(fs, serviceConfigPath, serviceConfig);
      const smtpScript = "/usr/local/bin/start-msmtpd";
      const originalScript = readVfsText(fs, smtpScript);
      if (!originalScript.includes("--port=1025")) throw new Error("SMTP startup port contract changed");
      writeVfsFile(fs, smtpScript, originalScript.replace("--port=1025", `--port=${smtpPort}`), 0o755);
      const mailPlugin = "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php";
      const originalPlugin = readVfsText(fs, mailPlugin);
      if (!originalPlugin.includes("$phpmailer->Port = 1025;")) {
        throw new Error("WordPress SMTP plugin port contract changed");
      }
      writeVfsFile(fs, mailPlugin, originalPlugin.replace(
        "$phpmailer->Port = 1025;",
        `$phpmailer->Port = ${smtpPort};`,
      ));
    },
    env: [
      "HOME=/root", "TERM=xterm-256color", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
      "WP_APP_PATH=/", "WP_PROTO=http", "FRANKENPHP_NUM_THREADS=6", `FRANKENPHP_LISTEN=:${port}`,
      `FRANKENPHP_PORT=${port}`,
    ],
    onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  let exited = false;
  void exitPromise.then(() => { exited = true; }, () => { exited = true; });
  try {
    const baseUrl = `http://127.0.0.1:${port}/`;
    await waitForHttp(baseUrl, 120_000, () => exited);
    // nginx shares its listener across workers; its selected PID can rotate.
    const listener = profile === "wordpress-sqlite" ? null : await host.pickListenerTarget(port);
    if (profile !== "wordpress-sqlite" && !listener) throw new Error(`${profile} has no HTTP listener after readiness`);
    await fetchWordPress(baseUrl);
    const startupMs = performance.now() - start;
    const latenciesMs: number[] = [];
    for (let index = 0; index < options.warmups + options.samples; index++) {
      const url = new URL(baseUrl);
      url.searchParams.set("kandelo_benchmark", `${round}-${index}`);
      const began = performance.now();
      await fetchWordPress(url.href);
      if (index >= options.warmups) latenciesMs.push(performance.now() - began);
    }
    const throughputStarted = performance.now();
    for (let index = 0; index < options.concurrentSamples; index++) {
      const requests: Promise<void>[] = [];
      for (let clientIndex = 0; clientIndex < options.clients; clientIndex++) {
        const url = new URL(baseUrl);
        url.searchParams.set("kandelo_benchmark", `${round}-concurrent-${clientIndex}-${index}`);
        requests.push(fetchWordPress(url.href));
      }
      await Promise.all(requests);
    }
    const throughputDurationMs = performance.now() - throughputStarted;
    const soak = options.soakSeconds > 0 ? await measureSoak(
      options.soakSeconds, options.clients,
      () => Promise.all(Array.from({ length: options.clients }, () =>
        fetchWordPress(`${baseUrl}?kandelo_soak=${performance.now()}`))).then(() => {}),
      async () => process.memoryUsage.rss(), "whole-node-process",
    ) : undefined;
    if (listener && (await host.pickListenerTarget(port))?.pid !== listener.pid) {
      throw new Error(`${profile} HTTP server restarted during the measurement`);
    }
    const logBytes = await host.readFileFromVfs(`/var/log/${target}.log`);
    if (!logBytes) throw new Error(`Missing ${profile} service log`);
    const serviceLog = new TextDecoder().decode(logBytes);
    validateServiceLog(profile, serviceLog);
    return {
      host: "node", profile, round, startupMs, latenciesMs,
      throughputRequests: options.clients * options.concurrentSamples,
      throughputDurationMs, soak, serviceLog,
      nodeProcessId: process.pid,
    };
  } finally {
    try {
      await host.signalProcess(pid, 15);
      await Promise.race([exitPromise.catch(() => -1), delay(5_000, -1, { ref: false })]);
    } finally {
      await host.destroy();
    }
    if (diagnostics.length > 0) throw new Error(`Node host diagnostics: ${JSON.stringify(diagnostics)}`);
  }
}

interface NodeMeasurement {
  profile: Profile;
  round: number;
  options: Options;
  imagePath: string;
}

// Each browser round already gets a fresh process. Do the same for Node:
// prior image staging, module caches, and allocator pages must not accumulate
// in a parent whose RSS is attributed to the next profile.
function measureNodeIsolated(measurement: NodeMeasurement): Promise<RoundResult> {
  return new Promise((resolveResult, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, KANDELO_WORDPRESS_STACK_WORKER: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let result: RoundResult | undefined;
    let failure: Error | undefined;
    const { options } = measurement;
    const limitMs = 240_000 + options.soakSeconds * 1000 +
      (options.warmups + options.samples + options.concurrentSamples + 1) * 30_000;
    const timer = setTimeout(() => {
      failure = new Error(`Node benchmark round exceeded ${limitMs} ms`);
      child.kill("SIGTERM");
    }, limitMs);
    child.on("message", message => { result = message as RoundResult; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!failure && code === 0 && result && result.nodeProcessId === child.pid) resolveResult(result);
      else reject(failure ?? new Error(`Node benchmark worker exited: ${code ?? signal}`));
    });
    child.send(measurement);
  });
}

async function browserImageDigest(page: Page, machine: string): Promise<string> {
  const imageUrl = new URL(machine).searchParams.get("vfs");
  if (!imageUrl) throw new Error("Browser machine URL has no VFS image");
  const response = await page.request.get(new URL(imageUrl, page.url()).href);
  if (!response.ok()) throw new Error(`Browser VFS image fetch failed: ${response.status()}`);
  return createHash("sha256").update(await response.body()).digest("hex");
}

async function measureBrowser(
  browser: Browser,
  page: Page,
  profile: Profile,
  round: number,
  options: Options,
  sharedMachineUrl: string,
): Promise<RoundResult> {
  const start = performance.now();
  const target = new URL(sharedMachineUrl);
  // The gallery can put the FPM shortcut in a different multi-image product.
  // Both measured profiles must use the one hash-verified WordPress image.
  target.searchParams.set("profile", profile);
  await page.goto(target.href);
  const title = profile === "wordpress-sqlite" ? "WordPress SQLite" :
    profile === "wordpress-frankenphp-caddy" ? "WordPress on FrankenPHP + Caddy" : "WordPress on FrankenPHP";
  const body = page.frameLocator(`iframe[title="${title}"]`).locator("body");
  await body.getByText("WordPress on Kandelo", { exact: false }).first().waitFor({ timeout: 180_000 });
  const startupMs = performance.now() - start;
  const measurements = await body.evaluate(async (_bodyElement, { round, warmups, samples, clients, concurrentSamples }) => {
    const values: number[] = [];
    for (let index = 0; index < warmups + samples; index++) {
      const url = new URL(location.href);
      url.searchParams.set("kandelo_benchmark", `${round}-${index}`);
      const began = performance.now();
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const html = await response.text();
      if (response.status !== 200 || !html.includes("WordPress on Kandelo") ||
          /<b>(?:Fatal error|Parse error|Warning)<\/b>:/.test(html)) {
        throw new Error(`Invalid WordPress response: HTTP ${response.status}, body=${html.slice(0, 200)}`);
      }
      if (index >= warmups) values.push(performance.now() - began);
    }
    const throughputStarted = performance.now();
    for (let index = 0; index < concurrentSamples; index++) {
      const requests: Promise<Response>[] = [];
      for (let clientIndex = 0; clientIndex < clients; clientIndex++) {
        const url = new URL(location.href);
        url.searchParams.set("kandelo_benchmark", `${round}-concurrent-${clientIndex}-${index}`);
        requests.push(fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) }));
      }
      const responses = await Promise.all(requests);
      const bodies: Promise<string>[] = [];
      for (const response of responses) bodies.push(response.text());
      const htmls = await Promise.all(bodies);
      for (let responseIndex = 0; responseIndex < responses.length; responseIndex++) {
        const response = responses[responseIndex]!;
        const html = htmls[responseIndex]!;
        if (response.status !== 200 || !html.includes("WordPress on Kandelo") ||
            /<b>(?:Fatal error|Parse error|Warning)<\/b>:/.test(html)) {
          throw new Error(`Invalid WordPress response: HTTP ${response.status}, body=${html.slice(0, 200)}`);
        }
      }
    }
    return { latenciesMs: values, throughputDurationMs: performance.now() - throughputStarted };
  }, {
    round, warmups: options.warmups, samples: options.samples,
    clients: options.clients, concurrentSamples: options.concurrentSamples,
  });
  if (measurements.latenciesMs.length !== options.samples) {
    throw new Error(`Browser measured ${measurements.latenciesMs.length} requests, expected ${options.samples}`);
  }
  const soak = options.soakSeconds > 0 ? await measureSoak(
    options.soakSeconds, options.clients,
    () => body.evaluate(async (_element, clients) => {
      await Promise.all(Array.from({ length: clients }, async () => {
        const url = new URL(location.href);
        url.searchParams.set("kandelo_soak", String(performance.now()));
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        const html = await response.text();
        if (response.status !== 200 || !html.includes("WordPress on Kandelo") ||
            /<b>(?:Fatal error|Parse error|Warning)<\/b>:/.test(html)) {
          throw new Error(`Invalid WordPress soak response: ${response.status}`);
        }
      }));
    }, options.clients),
    () => chromiumRss(browser), "chromium-process-rss-sum",
  ) : undefined;
  // Inspect only after the timed and RSS phases, through the ordinary app UI.
  const serviceLog = await readBrowserServiceLog(page, profile);
  validateServiceLog(profile, serviceLog);
  return {
    host: "browser", profile, round, startupMs,
    latenciesMs: measurements.latenciesMs,
    throughputRequests: options.clients * options.concurrentSamples,
    throughputDurationMs: measurements.throughputDurationMs,
    soak, serviceLog,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const imagePath = options.imagePath ?? resolveServiceVfsImage(image);
  const imageDigest = createHash("sha256").update(readFileSync(imagePath)).digest("hex");
  const results: RoundResult[] = [];

  if (options.host === "node" || options.host === "both") {
    for (let round = 0; round < options.rounds; round++) {
      for (const profile of orderForRound(round, options.profiles)) {
        const result = await measureNodeIsolated({ profile, round, options, imagePath });
        results.push(result);
        console.log(`node round ${round + 1} ${profile}: ${percentile(result.latenciesMs, 0.5).toFixed(1)} ms median`);
      }
    }
  }

  if (options.host === "browser" || options.host === "both") {
    let sharedMachineUrl: string;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL: options.browserBaseUrl });
      const probe = await context.newPage();
      try {
        await probe.goto(new URL("/trap-signal-test.html", options.browserBaseUrl).href);
        sharedMachineUrl = new URL(await machineUrl(probe, options.profiles[1]!), options.browserBaseUrl).href;
        const browserDigest = await browserImageDigest(probe, sharedMachineUrl);
        if (browserDigest !== imageDigest) {
          throw new Error(`Node/browser VFS image mismatch: ${imageDigest} != ${browserDigest}`);
        }
      } finally {
        await probe.close();
      }
    } finally {
      await browser.close();
    }
    for (let round = 0; round < options.rounds; round++) {
      for (const profile of orderForRound(round, options.profiles)) {
        const browser = await chromium.launch();
        try {
          const context = await browser.newContext({ baseURL: options.browserBaseUrl });
          const page = await context.newPage();
          const result = await measureBrowser(browser, page, profile, round, options, sharedMachineUrl);
          results.push(result);
          console.log(`browser round ${round + 1} ${profile}: ${percentile(result.latenciesMs, 0.5).toFixed(1)} ms median`);
        } finally {
          await browser.close();
        }
      }
    }
  }

  const summary = Object.fromEntries(
    (["node", "browser"] as const).flatMap((host) => options.profiles.flatMap((profile) => {
      const runs = results.filter((result) => result.host === host && result.profile === profile);
      if (runs.length === 0) return [];
      const samples = runs.flatMap((result) => result.latenciesMs);
      return [[`${host}.${profile}`, {
        sampleCount: samples.length,
        startupMedianMs: percentile(runs.map((result) => result.startupMs), 0.5),
        requestMedianMs: percentile(samples, 0.5),
        requestP90Ms: percentile(samples, 0.9),
        throughputMedianRps: percentile(runs.map((result) =>
          result.throughputRequests * 1_000 / result.throughputDurationMs), 0.5),
      }]];
    })),
  );
  const report = {
    version: 2,
    measuredAt: new Date().toISOString(),
    environment: { platform: platform(), architecture: arch(), cpus: cpus().length, node: process.version },
    image: { path: imagePath, sha256: imageDigest },
    options,
    summary,
    results,
  };
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Raw samples and provenance: ${options.output}`);
}

if (process.env.KANDELO_WORDPRESS_STACK_WORKER === "1") {
  if (!process.send || !process.disconnect) throw new Error("Node measurement worker requires IPC");
  const send = process.send.bind(process);
  const disconnect = process.disconnect.bind(process);
  process.once("message", async (measurement: NodeMeasurement) => {
    try {
      const result = await measureNode(measurement.profile, measurement.round,
        measurement.options, measurement.imagePath);
      send(result, disconnect);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      disconnect();
    }
  });
} else {
  await main();
}
