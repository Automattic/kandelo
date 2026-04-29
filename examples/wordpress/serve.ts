#!/usr/bin/env node --experimental-strip-types
/**
 * WordPress HTTP Server — serves WordPress via PHP's built-in server
 * running on wasm-posix-kernel with real TCP connections bridged in.
 *
 * Usage:
 *   node --experimental-strip-types examples/wordpress/serve.ts [port]
 *
 * Requires:
 *   1. PHP binary: examples/libs/php/php-src/sapi/cli/php
 *      (build with: cd examples/libs/php && bash build.sh)
 *   2. WordPress files: examples/wordpress/wordpress/
 *      (download with: bash examples/wordpress/setup.sh)
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../../host/src/node-kernel-host.ts";
import { tryResolveBinary } from "../../host/src/binary-resolver.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  join(repoRoot, "examples/libs/php/php-src/sapi/cli/php");
const wpDir = join(__dirname, "wordpress");
const routerScript = join(__dirname, "router.php");

const port = parseInt(process.argv[2] || "3000", 10);

// Validate prerequisites
if (!existsSync(phpBinaryPath)) {
  console.error("Error: PHP binary not found. Build with: cd examples/libs/php && bash build.sh");
  process.exit(1);
}
if (!existsSync(join(wpDir, "wp-settings.php"))) {
  console.error("Error: WordPress not found. Run: bash examples/wordpress/setup.sh");
  process.exit(1);
}

function loadFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const programBytes = loadFile(phpBinaryPath);

  const host = new NodeKernelHost({
    maxWorkers: 4,
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });

  await host.init();

  console.log(`WordPress server starting on http://localhost:${port}`);
  console.log("Waiting for PHP built-in server to initialize...");

  const exitPromise = host.spawn(programBytes, [
    "php", "-S", `0.0.0.0:${port}`, "-t", wpDir, routerScript,
  ], {
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await host.destroy().catch(() => {});
    process.exit(0);
  });

  const status = await exitPromise;
  await host.destroy().catch(() => {});
  process.exit(status);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
