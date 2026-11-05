import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { ERRNO } from "../../../host/src/generated/abi";
import { sparseComposerFileImage } from "../../../host/test/fixtures/sparse-composer-file-image";
import { MAX_COMPOSER_FILE_BYTES } from "../pages/kandelo/kernel-host/composer-file";
import { opfsTest } from "./support/opfs-page";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const modulePath = resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm");
const fixturePath = resolve(repoRoot, "apps/browser-demos/test/fixtures/composer-intake-worker.ts");

for (const length of [MAX_COMPOSER_FILE_BYTES, MAX_COMPOSER_FILE_BYTES + 1, 2 ** 32 + 3, 8 * 1024 ** 3]) {
  opfsTest(`composer patch admission uses real sparse OPFS metadata (${length})`, async ({ page, baseURL }) => {
    const image = sparseComposerFileImage(length);
    const imageUrl = new URL("/composer-sparse-patch.vfs", baseURL).href;
    const moduleUrl = new URL("/composer-sparse-patch-module.wasm", baseURL).href;
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
    await page.route(moduleUrl, route => route.fulfill({ body: readFileSync(resolve(repoRoot,
      "local-binaries/kandelo_image_module_positioned32.wasm")) }));
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const result = await page.evaluate(async input => {
      const worker = new Worker(input.workerUrl, { type: "module" });
      try {
        return await new Promise<Record<string, any>>((resolve, reject) => {
          worker.onmessage = event => resolve(event.data);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage(input);
        });
      } finally { worker.terminate(); }
    }, { imageUrl, moduleUrl, digest: createHash("sha256").update(image).digest("hex"),
      workerUrl: new URL(`/@fs/${resolve(repoRoot, "apps/browser-demos/test/fixtures/composer-file-worker.ts")}`, baseURL).href });
    expect(result.unexpected).toBeUndefined();
    expect(result.length).toBe(length);
    expect(result.largestSourceRead).toBeLessThanOrEqual(4096);
    expect(result.memoryAfter).toBeLessThanOrEqual(32 * 1024 * 1024);
    if (length <= MAX_COMPOSER_FILE_BYTES) {
      expect(result.failure).toBeUndefined();
      expect(result.outputLength).toBe(length);
      expect(result.zeroFilled).toBe(true);
      expect(result.opened).toBe(1);
      expect(result.largestFileRead).toBe(64 * 1024);
    } else {
      expect(result.failure).toMatchObject({ code: "ENOMEM", errno: ERRNO.ENOMEM });
      expect(result.opened).toBe(0);
      expect(result.largestFileRead).toBe(0);
      expect(result.memoryAfter).toBeLessThanOrEqual(result.memoryBefore + 65536);
    }
    if (length > 0xffff_ffff) {
      expect(result.wholeReadFailure).toMatchObject({ errno: ERRNO.EOVERFLOW,
        message: expect.stringContaining("EOVERFLOW: read /etc/php.ini") });
      expect(result.writes).toMatchObject({ highFailure: { errno: ERRNO.EFBIG },
        materializationFailure: { errno: ERRNO.ENOMEM }, sizeAfter: length, count: 2, bytes: [0, 0],
        resident: { count: 64 * 1024, tail: 1, atHighWord: 0, highWriteFailure: { errno: ERRNO.EFBIG },
          bytes: [47], size: 64 * 1024 + 1, mode: 0o4755 } });
      expect(result.probeMemoryAfter).toBeLessThanOrEqual(32 * 1024 * 1024);
    }
  });
}

for (const scenario of ["bounded", "empty", "checksum", "cancel", "memory", "http"] as const) {
  test(`composer configured assets use bounded native intake (${scenario})`, async ({ page, baseURL }) => {
    if (!existsSync(modulePath)) throw new Error("Current image module is required");
    const length = (scenario === "empty" ? 0 : scenario === "memory" ? 64 : 8) * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 90);
    const hash = createHash("sha256");
    for (let offset = 0; offset < length; offset += chunk.length) hash.update(chunk);
    const digest = hash.digest("hex");
    const server = createServer((_request, response) => {
      response.writeHead(scenario === "http" ? 503 : scenario === "empty" ? 204 : 200, { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Type": "application/octet-stream" });
      let sent = 0;
      const send = () => {
        while (!response.destroyed && sent < length) {
          sent += chunk.length;
          if (!response.write(chunk)) { response.once("drain", send); return; }
        }
        if (!response.destroyed) response.end();
      };
      send();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Asset server has no port");
      const moduleUrl = new URL("/composer-intake-module.wasm", baseURL).href;
      await page.route(moduleUrl, route => route.fulfill({ body: readFileSync(modulePath) }));
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async input => {
        const worker = new Worker(input.workerUrl, { type: "module" });
        try {
          return await new Promise<Record<string, any>>((resolve, reject) => {
            worker.onmessage = event => resolve(event.data);
            worker.onerror = event => reject(new Error(event.message));
            worker.postMessage(input);
          });
        } finally { worker.terminate(); }
      }, { moduleUrl, assetUrl: `http://127.0.0.1:${address.port}/payload`, digest, scenario,
        workerUrl: new URL(`/@fs/${fixturePath}`, baseURL).href });
      expect(result.unexpected).toBeUndefined();
      expect(result.eagerReads).toBe(0);
      expect(result.declaredLength).toBeNull();
      expect(result.bodyLocked).toBe(false);
      if (scenario === "http") expect(result.writes).toBe(0);
      else expect(result.writes).toBeGreaterThan(0);
      expect(result.largestWrite).toBeLessThanOrEqual(64 * 1024);
      if (scenario === "bounded" || scenario === "empty") {
        expect(result.failure).toBeUndefined();
        expect(result.length).toBe(length);
        expect(result.validBytes).toBe(true);
        expect(result.exportedBytes).toBeGreaterThan(length);
      } else {
        if (scenario === "memory") {
          expect(result.failure?.errno).toBe(ERRNO.ENOMEM);
          expect(result.failure?.message).toContain("resident staging limit");
        }
        if (scenario === "checksum") expect(result.failure?.message).toContain("sha256 mismatch");
        if (scenario === "cancel") expect(result.failure?.message).toContain("Composition was cancelled");
        if (scenario === "http") expect(result.failure?.message).toContain("503");
        expect(result.exportedBytes).toBe(0);
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
