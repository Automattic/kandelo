import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { machineUrl } from "../apps/browser-demos/test/support/kandelo-machine.ts";
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
const profiles = ["wordpress-sqlite", "wordpress-frankenphp"] as const;
type Profile = typeof profiles[number];
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
}

interface RoundResult {
  host: Host;
  profile: Profile;
  round: number;
  startupMs: number;
  latenciesMs: number[];
  throughputRequests: number;
  throughputDurationMs: number;
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
  const known = new Set(["host", "rounds", "warmups", "samples", "clients", "concurrent-samples", "port", "browser-base-url", "output"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  }
  const port = integer("port", 3101, 1);
  const rounds = integer("rounds", 2, 1);
  if (port + (rounds - 1) * 4 + 3 > 65535) {
    throw new Error("--port and --rounds exceed the available TCP port range");
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
  };
}

function orderForRound(round: number): readonly Profile[] {
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

async function measureNode(profile: Profile, round: number, options: Options, imagePath: string): Promise<RoundResult> {
  const target = profile === "wordpress-sqlite" ? "nginx" : "frankenphp-classic";
  const port = options.port + round * 4 + (profile === "wordpress-sqlite" ? 0 : 2);
  const smtpPort = port + 1;
  const start = performance.now();
  const diagnostics: unknown[] = [];
  const { host, pid, exitPromise } = await bootDinitServiceVfs({
    image,
    imagePath,
    target,
    maxWorkers: 12,
    maxPages: 4096,
    configure: (fs) => {
      configureWordPressRuntime(fs, { port });
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
      "WP_APP_PATH=/", "WP_PROTO=http", `FRANKENPHP_LISTEN=:${port}`,
    ],
    onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  let exited = false;
  void exitPromise.then(() => { exited = true; }, () => { exited = true; });
  try {
    const baseUrl = `http://127.0.0.1:${port}/`;
    await waitForHttp(baseUrl, 120_000, () => exited);
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
    return {
      host: "node", profile, round, startupMs, latenciesMs,
      throughputRequests: options.clients * options.concurrentSamples,
      throughputDurationMs: performance.now() - throughputStarted,
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

async function browserImageDigest(page: Page): Promise<string> {
  const imageUrls = await Promise.all(profiles.map(async (profile) => {
    const url = new URL(await machineUrl(page, profile), "http://kandelo.invalid");
    return url.searchParams.get("vfs");
  }));
  const imageUrl = imageUrls[0];
  if (!imageUrl || imageUrls[1] !== imageUrl) {
    throw new Error("Browser profiles do not select the same VFS image");
  }
  const response = await page.request.get(new URL(imageUrl, page.url()).href);
  if (!response.ok()) throw new Error(`Browser VFS image fetch failed: ${response.status()}`);
  return createHash("sha256").update(await response.body()).digest("hex");
}

async function measureBrowser(
  page: Page,
  profile: Profile,
  round: number,
  options: Options,
): Promise<RoundResult> {
  const start = performance.now();
  await page.goto(await machineUrl(page, profile));
  const title = profile === "wordpress-sqlite" ? "WordPress SQLite" : "WordPress on FrankenPHP";
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
  return {
    host: "browser", profile, round, startupMs,
    latenciesMs: measurements.latenciesMs,
    throughputRequests: options.clients * options.concurrentSamples,
    throughputDurationMs: measurements.throughputDurationMs,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const imagePath = resolveServiceVfsImage(image);
  const imageDigest = createHash("sha256").update(readFileSync(imagePath)).digest("hex");
  const results: RoundResult[] = [];

  if (options.host === "node" || options.host === "both") {
    for (let round = 0; round < options.rounds; round++) {
      for (const profile of orderForRound(round)) {
        const result = await measureNode(profile, round, options, imagePath);
        results.push(result);
        console.log(`node round ${round + 1} ${profile}: ${percentile(result.latenciesMs, 0.5).toFixed(1)} ms median`);
      }
    }
  }

  if (options.host === "browser" || options.host === "both") {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL: options.browserBaseUrl });
      const probe = await context.newPage();
      try {
        await probe.goto(new URL("/trap-signal-test.html", options.browserBaseUrl).href);
        const browserDigest = await browserImageDigest(probe);
        if (browserDigest !== imageDigest) {
          throw new Error(`Node/browser VFS image mismatch: ${imageDigest} != ${browserDigest}`);
        }
      } finally {
        await probe.close();
      }
      for (let round = 0; round < options.rounds; round++) {
        for (const profile of orderForRound(round)) {
          const page = await context.newPage();
          try {
            const result = await measureBrowser(page, profile, round, options);
            results.push(result);
            console.log(`browser round ${round + 1} ${profile}: ${percentile(result.latenciesMs, 0.5).toFixed(1)} ms median`);
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }

  const summary = Object.fromEntries(
    (["node", "browser"] as const).flatMap((host) => profiles.flatMap((profile) => {
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

await main();
