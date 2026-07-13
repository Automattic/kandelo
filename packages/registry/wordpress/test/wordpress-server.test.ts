/**
 * WordPress HTTP server test — verifies that PHP's built-in server can
 * serve HTTP requests on kandelo.
 *
 * Uses the host's `fetchInKernel` API: the request goes straight into the
 * kernel's listening socket via `kernel_inject_connection`, no real TCP
 * port is opened on the host. That keeps the test self-contained and
 * exercises the same in-kernel HTTP path the browser demos use.
 *
 * Requires:
 *   1. PHP binary: packages/registry/php/php-src/sapi/cli/php
 *      (build with: cd packages/registry/php && bash build.sh)
 *   2. WordPress files: packages/registry/wordpress/wordpress/
 *      (download with: bash packages/registry/wordpress/setup.sh)
 *   3. Kernel wasm (run `bash build.sh`)
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");
const phpBinaryPath = tryResolveBinary("programs/php/php.wasm");
const kernelWasmPath = tryResolveBinary("kernel.wasm");
const wpDir = join(repoRoot, "packages/registry/wordpress/wordpress");
const routerScript = join(repoRoot, "packages/registry/wordpress/demo/router.php");
const databasePath = join(wpDir, "wp-content/database/wordpress.db");

const SKIP_REASON = !phpBinaryPath
  ? "PHP binary not built"
  : !existsSync(join(wpDir, "wp-settings.php"))
    ? "WordPress not downloaded (run packages/registry/wordpress/setup.sh)"
    : !kernelWasmPath
      ? "Kernel wasm not built (run bash build.sh)"
      : "";

/** PHP -S listens on this port inside the kernel's loopback; no real TCP. */
const KERNEL_PORT = 8080;

function loadFile(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resetWordPressDatabase(): void {
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

describe.skipIf(!!SKIP_REASON)("WordPress HTTP Server (fetchInKernel)", () => {
  it("serves HTTP requests via fetchInKernel", async () => {
    resetWordPressDatabase();
    const programBytes = loadFile(phpBinaryPath!);

    let stderr = "";
    const host = new NodeKernelHost({
      maxWorkers: 4,
      onStderr: (_pid, data) => {
        stderr += new TextDecoder().decode(data);
      },
    });
    await host.init();

    const exitPromise = host.spawn(
      programBytes,
      ["php", "-S", `0.0.0.0:${KERNEL_PORT}`, "-t", wpDir, routerScript],
      { env: ["HOME=/tmp", "TMPDIR=/tmp"] },
    );
    exitPromise.catch(() => {});

    try {
      const startTime = Date.now();
      while (!stderr.includes("Development Server") && Date.now() - startTime < 30_000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(stderr).toContain("Development Server");

      const response = await host.fetchInKernel(
        KERNEL_PORT,
        {
          method: "GET",
          url: "/",
          headers: { Host: `localhost:${KERNEL_PORT}` },
          body: null,
        },
        { timeoutMs: 30_000 },
      );

      expect(response.status).toBe(302);

      const installResp = await host.fetchInKernel(
        KERNEL_PORT,
        {
          method: "GET",
          url: "/wp-admin/install.php",
          headers: { Host: `localhost:${KERNEL_PORT}` },
          body: null,
        },
        { timeoutMs: 30_000 },
      );
      expect(installResp.status).toBe(200);
      expect(installResp.body.length).toBeGreaterThan(0);
      const html = new TextDecoder().decode(installResp.body);
      expect(html.toLowerCase()).toMatch(/wordpress/);
    } finally {
      await host.destroy().catch(() => {});
      resetWordPressDatabase();
    }
  }, 120_000);
});
