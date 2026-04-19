/**
 * Suite 2: WordPress
 *
 * Two measurements:
 *   cli_require_ms         — php -r "require 'wp-load.php';" (process start to exit)
 *   http_first_response_ms — Start PHP built-in server, time to first HTTP response
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import { NodeKernelHost } from "../../host/src/node-kernel-host.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const phpBinaryPath = resolve(repoRoot, "examples/libs/php/php-src/sapi/cli/php");
const wpDir = resolve(repoRoot, "examples/wordpress/wordpress");
const routerScript = resolve(repoRoot, "examples/wordpress/router.php");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function hasPrereqs(): boolean {
  return existsSync(phpBinaryPath) && existsSync(join(wpDir, "wp-settings.php"));
}

async function measureCliRequire(): Promise<number> {
  const t0 = performance.now();
  const result = await runCentralizedProgram({
    programPath: phpBinaryPath,
    argv: ["php", "-r", `chdir('${wpDir}'); require 'wp-load.php';`],
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
    timeout: 120_000,
  });
  const t1 = performance.now();
  if (result.exitCode !== 0) {
    throw new Error(`PHP wp-load.php failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return t1 - t0;
}

async function measureHttpFirstResponse(): Promise<number> {
  const port = 19400 + Math.floor(Math.random() * 100);
  const programBytes = loadBytes(phpBinaryPath);

  let serverStarted = false;
  let stderr = "";

  const host = new NodeKernelHost({
    maxWorkers: 4,
    onStdout: () => {},
    onStderr: (_pid, data) => {
      stderr += new TextDecoder().decode(data);
      if (stderr.includes("Development Server")) serverStarted = true;
    },
  });

  await host.init();

  const t0 = performance.now();

  const exitPromise = host.spawn(programBytes, [
    "php", "-S", `0.0.0.0:${port}`, "-t", wpDir, routerScript,
  ], {
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
    cwd: wpDir,
  });

  // Wait for server startup (PHP prints "Development Server started" to stderr)
  const startDeadline = Date.now() + 60_000;
  while (!serverStarted && Date.now() < startDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!serverStarted) {
    await host.destroy().catch(() => {});
    throw new Error("PHP server did not start within 60s");
  }

  // Poll for first complete HTTP response (WordPress first page load is slow)
  let firstResponseMs = -1;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (resp.status > 0) {
        await resp.text();
        firstResponseMs = performance.now() - t0;
        break;
      }
    } catch {
      // Not ready yet — retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Cleanup
  await host.destroy().catch(() => {});

  if (firstResponseMs < 0) {
    throw new Error("Timed out waiting for WordPress HTTP response");
  }

  return firstResponseMs;
}

const suite: BenchmarkSuite = {
  name: "wordpress",

  async run(): Promise<Record<string, number>> {
    if (!hasPrereqs()) {
      console.warn("  Skipping (PHP or WordPress not found)");
      return {};
    }

    const results: Record<string, number> = {};
    results.cli_require_ms = await measureCliRequire();
    results.http_first_response_ms = await measureHttpFirstResponse();
    return results;
  },
};

export default suite;
