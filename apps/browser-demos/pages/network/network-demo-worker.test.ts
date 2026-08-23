import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs.ts";

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "network-demo-worker.ts");

test("canonical network rootfs binds activated lazy URLs before mounting", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-network-pages-loader-"));
  const fixture = await rootfsFixture();
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
        return `export default ${JSON.stringify([fixture.entry])};\n`;
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
          export { MemoryFileSystem } from ${JSON.stringify(
            resolve(dirname(workerPath), "../../../../host/src/vfs/memory-fs.ts"),
          )};
          export const CAPTURED_STDIO = {};
          export class CentralizedKernelWorker {}
          export function installBrowserSetImmediatePolyfill() {}
          export class BrowserWorkerAdapter {}
          export function detectPtrWidth() { return 4; }
          export function extractHeapBase() { return null; }
          export class LocalVirtualNetwork {}
          export class DeviceFileSystem {}
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
      base: "/a/",
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
      if (url === fixture.manifestPath) {
        return new Response(fixture.manifest.slice().buffer, {
          headers: { "content-length": String(fixture.manifest.byteLength) },
        });
      }
      if (url === fixture.imageUrl) {
        return new Response(fixture.image.slice().buffer, {
          headers: { "content-length": String(fixture.image.byteLength) },
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
    const restored = MemoryFileSystem.fromImage(artifacts.rootfs);
    assert.equal(
      restored.getLazyEntry("/bin/program")?.url,
      "https://kandelo.invalid/a/vfs-groups/release-1/assets/programs/wasm32/program.wasm",
      "the rootfs handed to network machines must bind product lazy URLs from activation authority",
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

test("legacy map-only network rootfs preserves absent lazy asset authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-network-pages-loader-"));
  const fixture = await rootfsFixture({ withLazyFile: false });
  const output = join(root, "output");
  const { asset_group: _assetGroup, ...legacyEntry } = fixture.entry;
  const virtual: Plugin = {
    name: "network-worker-legacy-pages-loader-fixture",
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
        return `export default ${JSON.stringify([legacyEntry])};\n`;
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
          export { MemoryFileSystem } from ${JSON.stringify(
            resolve(dirname(workerPath), "../../../../host/src/vfs/memory-fs.ts"),
          )};
          export const CAPTURED_STDIO = {};
          export class CentralizedKernelWorker {}
          export function installBrowserSetImmediatePolyfill() {}
          export class BrowserWorkerAdapter {}
          export function detectPtrWidth() { return 4; }
          export function extractHeapBase() { return null; }
          export class LocalVirtualNetwork {}
          export class DeviceFileSystem {}
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
  try {
    await build({
      base: "/a/",
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
      if (String(input) === fixture.entry.path) {
        return new Response(fixture.image.slice().buffer, {
          headers: { "content-length": String(fixture.image.byteLength) },
        });
      }
      return new Response(new Uint8Array([0, 97, 115, 109]).buffer);
    };

    const module = await import(
      `${pathToFileURL(join(output, "worker.mjs")).href}?t=${Date.now()}`,
    );
    const artifacts = await module.__loadArtifactsForTest();
    assert.deepEqual(
      new Uint8Array(artifacts.rootfs),
      fixture.image,
      "legacy activation must use the undefined authority branch before serialization",
    );
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

async function rootfsFixture(options: { withLazyFile?: boolean } = {}) {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  if (options.withLazyFile !== false) {
    fs.registerLazyFile(
      "/bin/program",
      "binaries/programs/wasm32/program.wasm",
      1,
    );
  }
  const image = await fs.saveImage();
  const imageDigest = createHash("sha256").update(image).digest("hex");
  const manifestPath = "/a/vfs-groups/release-1/manifest.json";
  const imageUrl =
    "https://kandelo.invalid/a/vfs-groups/release-1/images/rootfs.vfs.zst";
  const manifest = new TextEncoder().encode(JSON.stringify({
    assets: [],
    kind: "kandelo-vfs-asset-group",
    policy: "source-only-v1",
    products: [{
      eager_groups: [],
      id: "platform-rootfs",
      image: {
        bytes: image.byteLength,
        path: "images/rootfs.vfs.zst",
        sha256: imageDigest,
      },
      lazy_groups: [],
    }],
    schema: 1,
  }));
  return {
    entry: {
      asset_group: {
        bytes: manifest.byteLength,
        path: manifestPath,
        sha256: createHash("sha256").update(manifest).digest("hex"),
      },
      bytes: image.byteLength,
      id: "platform-rootfs",
      load: "eager",
      path: `/a/products/platform-rootfs/sha256-${imageDigest}/platform-rootfs-42.vfs.zst`,
      sha256: imageDigest,
    },
    image,
    imageDigest,
    imageUrl,
    manifest,
    manifestPath,
  };
}
