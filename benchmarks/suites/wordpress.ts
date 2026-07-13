/**
 * Suite 2: WordPress
 *
 * Two clean-start measurements:
 *   cli_require_ms         — php -r "require 'wp-load.php';" (process start to exit)
 *   http_first_response_ms — Start PHP built-in server, time to first HTTP response
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import { NodeKernelHost } from "../../host/src/node-kernel-host.js";
import { tryResolveBinary } from "../../host/src/binary-resolver.js";
import { NodePlatformIO } from "../../host/src/platform/node.js";
import type { BenchmarkSuite } from "../types.js";
import {
  buildPhpOpcacheArgs,
  createWordPressOpcacheRunDirectory,
  removeWordPressOpcacheRunDirectory,
  resetWordPressMeasurementState,
} from "./wordpress-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  resolve(repoRoot, "packages/registry/php/php-src/sapi/cli/php");
const opcachePath = tryResolveBinary("programs/php/opcache.so");
const wpDir = resolve(repoRoot, "packages/registry/wordpress/wordpress");
const routerScript = resolve(repoRoot, "packages/registry/wordpress/demo/router.php");
const benchmarkResultsDir = resolve(repoRoot, "benchmarks/results");
const databaseDirectory = join(wpDir, "wp-content/database");
const debugLogPath = join(wpDir, "wp-content/debug.log");

function resetMeasurementState(opcacheCacheDirectory: string): void {
  resetWordPressMeasurementState({
    databaseDirectory,
    debugLogPath,
    opcacheCacheDirectory,
  });
}

/** Filesystem inputs selected by the Node WordPress benchmark. */
export function describeWordPressBenchmarkInputs(): {
  phpBinaryPath: string;
  phpResolverRequest: string;
  phpResolverSelectedPath: string | null;
  opcachePath: string | null;
  opcacheResolverRequest: string;
  opcacheUsed: boolean;
  wpDir: string;
  wpConfigPath: string;
  routerScript: string;
} {
  const phpResolverRequest = "programs/php/php.wasm";
  const opcacheResolverRequest = "programs/php/opcache.so";
  return {
    phpBinaryPath,
    phpResolverRequest,
    phpResolverSelectedPath: tryResolveBinary(phpResolverRequest),
    opcachePath,
    opcacheResolverRequest,
    opcacheUsed: process.env.NO_OPCACHE !== "1" && opcachePath !== null,
    wpDir,
    wpConfigPath: join(wpDir, "wp-config.php"),
    routerScript,
  };
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function missingPrereqsMessage(): string | null {
  if (!existsSync(phpBinaryPath)) {
    return "PHP benchmark binary is missing. Run: bash packages/registry/php/build-php.sh";
  }
  if (!existsSync(join(wpDir, "wp-settings.php"))) {
    return "WordPress source tree is missing. Run: bash packages/registry/wordpress/setup.sh";
  }
  return null;
}

async function measureCliRequire(opcacheCacheDirectory: string): Promise<number> {
  resetMeasurementState(opcacheCacheDirectory);
  try {
    const opcacheArgs = phpOpcacheArgs(opcacheCacheDirectory);
    const t0 = performance.now();
    const result = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", ...opcacheArgs, "-r", `chdir('${wpDir}'); require 'wp-load.php';`],
      env: ["HOME=/tmp", "TMPDIR=/tmp"],
      io: new NodePlatformIO(),
      timeout: 120_000,
    });
    const t1 = performance.now();
    if (result.exitCode !== 0) {
      throw new Error(`PHP wp-load.php failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return t1 - t0;
  } finally {
    resetMeasurementState(opcacheCacheDirectory);
  }
}

function phpOpcacheArgs(fileCachePath: string): string[] {
  if (process.env.NO_OPCACHE === "1" || !opcachePath) return [];
  return buildPhpOpcacheArgs(opcachePath, fileCachePath);
}

async function measureHttpFirstResponse(opcacheCacheDirectory: string): Promise<number> {
  resetMeasurementState(opcacheCacheDirectory);
  const port = 19400 + Math.floor(Math.random() * 100);
  const programBytes = loadBytes(phpBinaryPath);

  let serverStarted = false;
  let stderr = "";
  let serverOutcome:
    | { exitCode: number }
    | { error: unknown }
    | undefined;

  const host = new NodeKernelHost({
    maxWorkers: 4,
    onStdout: () => {},
    onStderr: (_pid, data) => {
      stderr += new TextDecoder().decode(data);
      if (stderr.includes("Development Server")) serverStarted = true;
    },
  });

  const throwIfServerExited = (): void => {
    if (!serverOutcome) return;
    if ("error" in serverOutcome) {
      throw new Error(
        `PHP server failed before the WordPress response: ${String(serverOutcome.error)}\n${stderr}`,
      );
    }
    throw new Error(
      `PHP server exited with status ${serverOutcome.exitCode} before the WordPress response:\n${stderr}`,
    );
  };

  try {
    await host.init();

    const t0 = performance.now();
    const opcacheArgs = phpOpcacheArgs(opcacheCacheDirectory);

    const exitPromise = host.spawn(programBytes, [
      "php", ...opcacheArgs, "-S", `0.0.0.0:${port}`, "-t", wpDir, routerScript,
    ], {
      env: ["HOME=/tmp", "TMPDIR=/tmp"],
      cwd: wpDir,
    });
    void exitPromise.then(
      (exitCode) => { serverOutcome = { exitCode }; },
      (error) => { serverOutcome = { error }; },
    );

    // Wait for server startup (PHP prints "Development Server started" to stderr)
    const startDeadline = Date.now() + 60_000;
    while (!serverStarted && Date.now() < startDeadline) {
      throwIfServerExited();
      await new Promise((r) => setTimeout(r, 200));
    }
    throwIfServerExited();
    if (!serverStarted) {
      throw new Error(`PHP server did not start within 60s:\n${stderr}`);
    }

    // Poll for the first complete, successful WordPress response.
    let lastFetchError: unknown;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      throwIfServerExited();

      let resp: Response;
      try {
        resp = await fetch(`http://localhost:${port}/`, {
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        lastFetchError = error;
        throwIfServerExited();
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const body = await resp.text();
      if (!resp.ok) {
        throw new Error(
          `WordPress returned HTTP ${resp.status}: ${body.replace(/\s+/g, " ").slice(0, 240)}`,
        );
      }
      if (!/wordpress/i.test(body)) {
        throw new Error("WordPress benchmark received a successful response without WordPress content");
      }
      return performance.now() - t0;
    }

    throw new Error(
      `Timed out waiting for WordPress HTTP response: ${String(lastFetchError ?? "no response")}`,
    );
  } finally {
    await host.destroy().catch(() => {});
    resetMeasurementState(opcacheCacheDirectory);
  }
}

const suite: BenchmarkSuite = {
  name: "wordpress",

  async run(): Promise<Record<string, number>> {
    const missing = missingPrereqsMessage();
    if (missing) {
      throw new Error(`WordPress benchmark prerequisites are missing. ${missing}`);
    }

    const opcacheRunDirectory = createWordPressOpcacheRunDirectory(benchmarkResultsDir);
    try {
      const results: Record<string, number> = {};
      results.cli_require_ms = await measureCliRequire(join(opcacheRunDirectory, "cli"));
      results.http_first_response_ms = await measureHttpFirstResponse(
        join(opcacheRunDirectory, "http"),
      );
      return results;
    } finally {
      removeWordPressOpcacheRunDirectory(opcacheRunDirectory);
    }
  },
};

export default suite;
