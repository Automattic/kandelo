import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "network-demo-worker.ts");

test("canonical network rootfs bytes pass through the authenticated Pages loader", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-network-pages-loader-"));
  const canonicalRootfs = new TextEncoder().encode("authenticated network rootfs\n");
  const digest = createHash("sha256").update(canonicalRootfs).digest("hex");
  const canonicalPath =
    `/products/platform-rootfs/sha256-${digest}/platform-rootfs-42.vfs.zst`;
  const output = join(root, "output");
  const virtual: Plugin = {
    name: "network-worker-pages-loader-fixture",
    resolveId(source) {
      if (source === "virtual:kandelo-pages-vfs-products") return "\0pages-products";
      if (source.endsWith("?url") || source.includes("?worker&url")) {
        return `\0asset-url:${source}`;
      }
      if (source.startsWith("@host/")) return "\0host-stubs";
      return null;
    },
    load(id) {
      if (id === "\0pages-products") {
        return `export default ${JSON.stringify([{
          bytes: canonicalRootfs.byteLength,
          id: "platform-rootfs",
          load: "eager",
          path: canonicalPath,
          sha256: digest,
        }])};\n`;
      }
      if (id.startsWith("\0asset-url:")) {
        const source = id.slice("\0asset-url:".length);
        const url = source.startsWith("@rootfs-vfs")
          ? "/legacy-rootfs.vfs"
          : `/${source.replace(/[^A-Za-z0-9]+/gu, "-")}`;
        return `export default ${JSON.stringify(url)};\n`;
      }
      if (id === "\0host-stubs") {
        return `
          export const CAPTURED_STDIO = {};
          export class CentralizedKernelWorker {}
          export function installBrowserSetImmediatePolyfill() {}
          export class BrowserWorkerAdapter {}
          export function detectPtrWidth() { return 4; }
          export function extractHeapBase() { return null; }
          export class LocalVirtualNetwork {}
          export class DeviceFileSystem {}
          export class MemoryFileSystem { static create() { return {}; } }
          export class BrowserTimeProvider {}
          export const DEFAULT_MOUNT_SPEC = [];
          export async function resolveForBrowser() { return []; }
          export class VirtualPlatformIO {}
        `;
      }
      return null;
    },
    transform(code, id) {
      if (resolve(id.split("?", 1)[0]!) !== workerPath) return null;
      const withoutNestedWorker = code.replace(
        'import workerEntryUrl from "@host/worker-entry-browser.ts?worker&url";',
        'const workerEntryUrl = "/worker-entry.js";',
      );
      return `${withoutNestedWorker}\nexport { loadArtifacts as __loadArtifactsForTest };\n`;
    },
  };

  const savedSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const savedFetch = globalThis.fetch;
  let legacyRootfsFetches = 0;
  try {
    await build({
      build: {
        emptyOutDir: true,
        lib: { entry: workerPath, formats: ["es"] },
        minify: false,
        outDir: output,
        rollupOptions: { output: { entryFileNames: "worker.mjs" } },
      },
      configFile: false,
      plugins: [virtual],
    });

    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: { onmessage: null, postMessage() {} },
      writable: true,
    });
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === canonicalPath) {
        return new Response(canonicalRootfs.slice().buffer, {
          headers: { "content-length": String(canonicalRootfs.byteLength) },
        });
      }
      if (url === "/legacy-rootfs.vfs") {
        legacyRootfsFetches += 1;
        return new Response("untrusted direct rootfs\n");
      }
      return new Response(new Uint8Array([0, 97, 115, 109]).buffer);
    };

    const module = await import(
      `${pathToFileURL(join(output, "worker.mjs")).href}?t=${Date.now()}`
    );
    const artifacts = await module.__loadArtifactsForTest();
    assert.deepEqual(
      [...artifacts.rootfs],
      [...canonicalRootfs],
      "the rootfs handed to network machines must be the digest-validated product bytes",
    );
    assert.equal(legacyRootfsFetches, 0, "canonical mode must not consult the legacy rootfs URL");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedSelf === undefined) {
      delete (globalThis as { self?: unknown }).self;
    } else {
      Object.defineProperty(globalThis, "self", savedSelf);
    }
    rmSync(root, { force: true, recursive: true });
  }
});
