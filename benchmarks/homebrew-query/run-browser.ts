#!/usr/bin/env -S npx tsx

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer, type Plugin, type ViteDevServer } from "vite";

import { withRejectingTimeout } from "../timeout";
import { medianMetrics } from "./contracts";
import type {
  HomebrewQueryBenchmarkResult,
  HomebrewQueryFixtureManifest,
  HomebrewQueryScenarioResult,
} from "./contracts";

interface Options {
  fixturePath: string;
  rounds: number;
  outputPath?: string;
}

interface PageResult {
  fixture: HomebrewQueryFixtureManifest;
  rounds: HomebrewQueryScenarioResult[];
  median: Record<string, number>;
}

declare global {
  interface Window {
    __homebrewQueryBenchmarkReady: boolean;
    __runHomebrewQueryBenchmark(
      rounds: number,
      auditNetwork?: boolean,
    ): Promise<PageResult>;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const browserRoot = resolve(repoRoot, "apps/browser-demos");
const BENCHMARK_TIMEOUT_MS = 90 * 60_000;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const fixtureRoot = dirname(options.fixturePath);
  const fixtureRoute = "/__homebrew_query_fixture/manifest.json";
  let server: ViteDevServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = await createServer({
      root: browserRoot,
      configFile: resolve(browserRoot, "vite.config.ts"),
      logLevel: "warn",
      server: {
        port: 0,
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
      },
      optimizeDeps: {
        entries: [
          resolve(browserRoot, "pages/homebrew-benchmark/index.html"),
        ],
      },
      plugins: [fixturePlugin(fixtureRoot, options.fixturePath)],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Vite did not expose its benchmark port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    let browserVersion: string | undefined;
    let fixture: HomebrewQueryFixtureManifest | undefined;
    const rounds: HomebrewQueryScenarioResult[] = [];
    const externalRequests: string[] = [];
    for (let index = 0; index < options.rounds; index += 1) {
      process.stderr.write(
        `Homebrew query independent Chromium round ${index + 1}/${options.rounds}\n`,
      );
      browser = await chromium.launch();
      browserVersion ??= browser.version();
      const context = await browser.newContext();
      try {
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          if (
            url.startsWith(`${origin}/`) ||
            url.startsWith(`http://localhost:${address.port}/`)
          ) {
            await route.continue();
          } else {
            externalRequests.push(url);
            await route.abort("blockedbyclient");
          }
        });
        const page = await context.newPage();
        let rejectPageCrash!: (error: Error) => void;
        const pageCrash = new Promise<never>((_resolve, reject) => {
          rejectPageCrash = reject;
        });
        page.on("crash", () => {
          rejectPageCrash(new Error(
            "Chromium renderer crashed during the Homebrew query benchmark",
          ));
        });
        page.on("console", (message) => {
          if (["log", "info", "warning", "error"].includes(message.type())) {
            process.stderr.write(`[Chromium] ${message.text()}\n`);
          }
        });
        page.on("pageerror", (error) => {
          process.stderr.write(`[Chromium page error] ${error.stack ?? error.message}\n`);
        });
        await page.goto(
          `${origin}/pages/homebrew-benchmark/?fixture=${encodeURIComponent(fixtureRoute)}`,
          { waitUntil: "domcontentloaded", timeout: 30_000 },
        );
        await page.waitForFunction(
          () => window.__homebrewQueryBenchmarkReady === true,
          undefined,
          { timeout: 180_000 },
        );
        const pageResult = await withRejectingTimeout(
          Promise.race([
            page.evaluate(
              ({ auditNetwork }) => window.__runHomebrewQueryBenchmark(
                1,
                auditNetwork,
              ),
              { auditNetwork: index === 0 },
            ),
            pageCrash,
          ]),
          BENCHMARK_TIMEOUT_MS,
          `Chromium Homebrew query benchmark timed out after ${BENCHMARK_TIMEOUT_MS}ms`,
        );
        if (pageResult.rounds.length !== 1) {
          throw new Error("Chromium Homebrew query round returned invalid results");
        }
        fixture ??= pageResult.fixture;
        rounds.push(pageResult.rounds[0]!);
      } finally {
        try {
          await context.close();
        } finally {
          // WHY: each round must release its renderer, Realms, workers and
          // SABs. Keeping Chromium alive made independent rounds retain enough
          // opaque engine state to crash before a three-round run ended.
          await browser.close();
          browser = undefined;
        }
      }
    }
    if (externalRequests.length > 0) {
      throw new Error(
        "Chromium Homebrew query benchmark attempted external requests:\n" +
          [...new Set(externalRequests)].join("\n"),
      );
    }
    if (browserVersion === undefined || fixture === undefined) {
      throw new Error("Chromium Homebrew query benchmark produced no rounds");
    }
    const result: HomebrewQueryBenchmarkResult = {
      schema: 1,
      kind: "kandelo-homebrew-query-benchmark-result",
      host: "chromium",
      hostVersion: browserVersion,
      kandeloCommit: gitHead(),
      recordedAt: new Date().toISOString(),
      machine: {
        platform: `${platform()} ${release()}`,
        architecture: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
      },
      fixture,
      rounds,
      median: medianMetrics(rounds),
    };
    const encoded = `${JSON.stringify(result, null, 2)}\n`;
    if (options.outputPath) {
      mkdirSync(dirname(options.outputPath), { recursive: true });
      writeFileSync(options.outputPath, encoded);
      process.stderr.write(`Wrote ${options.outputPath}\n`);
    }
    process.stdout.write(encoded);
  } finally {
    await browser?.close();
    await server?.close();
  }
}

function fixturePlugin(fixtureRoot: string, manifestPath: string): Plugin {
  const root = resolve(fixtureRoot);
  return {
    name: "homebrew-query-fixture",
    configureServer(server) {
      server.middlewares.use("/__homebrew_query_fixture/", (request, response) => {
        const requestPath = decodeURIComponent(
          (request.url ?? "").split("?", 1)[0]!.replace(/^\/+/, ""),
        );
        const path = requestPath === "manifest.json"
          ? manifestPath
          : resolve(root, requestPath);
        const relativePath = relative(root, path);
        if (
          relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
          !existsSync(path) || !statSync(path).isFile()
        ) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("Content-Type", contentType(path));
        response.end(readFileSync(path));
      });
    },
  };
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".json": return "application/json";
    case ".wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function parseOptions(argv: string[]): Options {
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  let rounds = 3;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const [name, inline] = argument.split("=", 2);
    const value = inline ?? argv[++index];
    if (name === "--fixture") fixturePath = value;
    else if (name === "--output") outputPath = value;
    else if (name === "--rounds") rounds = Number(value);
    else usage(`Unknown argument: ${argument}`);
  }
  if (!fixturePath) usage("--fixture is required");
  if (!Number.isSafeInteger(rounds) || rounds <= 0) {
    usage("--rounds must be a positive integer");
  }
  return {
    fixturePath: resolve(fixturePath),
    rounds,
    ...(outputPath === undefined ? {} : { outputPath: resolve(outputPath) }),
  };
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: npx tsx benchmarks/homebrew-query/run-browser.ts " +
      "--fixture PATH [--rounds 3] [--output PATH]\n",
  );
  process.exit(2);
}

void main().catch((error) => {
  process.stderr.write(
    `homebrew-query Chromium failed: ${error instanceof Error ? error.stack : error}\n`,
  );
  process.exitCode = 1;
});
