import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { gzipSync, zipSync } from "fflate";

import { ABI_VERSION } from "../../../host/src/generated/abi";
import {
  MemoryFileSystem,
  type LazyTreeRegistrationEntry,
} from "../../../host/src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

interface LazyAcceptanceResult {
  readText: string;
  firstReadError?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runLazyVfsAcceptance: (request: {
      vfsUrl: string;
      readPath: string;
      executable?: string;
      argv?: string[];
      env?: string[];
      retryReadAfterFailure?: boolean;
      timeoutMs: number;
    }) => Promise<LazyAcceptanceResult>;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const environmentProgram = join(
  here,
  "../../../examples/environment_lifecycle_test.wasm",
);
const kernel = join(here, "../../../host/wasm/kandelo-kernel.wasm");
const available = existsSync(environmentProgram) && existsSync(kernel);
const TAR_BLOCK = 512;

function identity(bytes: Uint8Array): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

async function lazyImage(groups: Array<{
  url: string;
  archive: Uint8Array;
  tarBytes?: number;
  inventory?: LazyTreeRegistrationEntry[];
}>): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  for (const group of groups) {
    if (group.inventory && group.tarBytes !== undefined) {
      fs.registerLazyTree({
        decoder: "homebrew-bottle-tar-gzip-v1",
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        ...identity(group.archive),
        expandedBytes: group.tarBytes,
        sourceEntryCount: group.inventory.length,
        transports: [group.url],
      }, group.inventory);
    } else {
      fs.registerLazyArchiveFromEntries(
        group.url,
        parseZipCentralDirectory(group.archive),
        "/",
        undefined,
        identity(group.archive),
      );
    }
  }
  return fs.saveImage();
}

async function routeBytes(
  page: Page,
  url: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  await page.route(url, async (route) => {
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
        "content-type": contentType,
      },
    });
  });
}

test.skip(!available, "lazy archive Chromium fixtures are not built");

test("Chromium boots, reads, and execs through verified lazy archives", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const execUrl = "https://fixtures.kandelo.invalid/exec.tar.gz";
  const dataUrl = "https://fixtures.kandelo.invalid/data.zip";
  const imageUrl = "https://fixtures.kandelo.invalid/lazy.vfs";
  const execBytes = new Uint8Array(readFileSync(environmentProgram));
  const execTar = tarBytes([
    { path: "bin/environment-lifecycle-real", mode: 0o755, data: execBytes },
    {
      path: "bin/environment-lifecycle",
      mode: 0o755,
      target: "bin/environment-lifecycle-real",
    },
  ]);
  const execArchive = gzipSync(execTar);
  const dataArchive = zipSync({
    "etc/lazy-browser-data": new TextEncoder().encode("lazy-browser-data"),
  });
  const image = await lazyImage([
    {
      url: execUrl,
      archive: execArchive,
      tarBytes: execTar.byteLength,
      inventory: [
        {
          vfsPath: "/bin/environment-lifecycle-real",
          sourcePath: "bin/environment-lifecycle-real",
          type: "file",
          mode: 0o755,
          size: execBytes.byteLength,
          inodeGroup: "environment-lifecycle",
        },
        {
          vfsPath: "/bin/environment-lifecycle",
          sourcePath: "bin/environment-lifecycle",
          type: "hardlink",
          mode: 0o755,
          size: execBytes.byteLength,
          target: "/bin/environment-lifecycle-real",
          inodeGroup: "environment-lifecycle",
        },
      ],
    },
    { url: dataUrl, archive: dataArchive },
  ]);
  let execFetches = 0;
  let dataFetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(execUrl, async (route) => {
    execFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(execArchive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(execArchive.byteLength),
      },
    });
  });
  await page.route(dataUrl, async (route) => {
    dataFetches++;
    await route.fulfill({
      status: 200,
      body: Buffer.from(dataArchive),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(dataArchive.byteLength),
      },
    });
  });

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__homebrewVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/lazy-browser-data",
      executable: "/bin/environment-lifecycle",
      argv: ["/bin/environment-lifecycle"],
      env: ["INITIAL=parent", "REMOVE=before-fork"],
      timeoutMs: 90_000,
    }),
    imageUrl,
  );

  expect(result.readText).toBe("lazy-browser-data");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("EXEC_ENV_PASS");
  expect(result.stdout).toContain("EMPTY_ENV_PASS");
  expect(result.stderr).toBe("");
  expect(dataFetches).toBe(1);
  expect(execFetches).toBe(1);
});

test("Chromium reports digest failure without mutation and retries cleanly", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const archiveUrl = "https://fixtures.kandelo.invalid/retry.zip";
  const imageUrl = "https://fixtures.kandelo.invalid/retry.vfs";
  const archive = zipSync({
    "etc/retry-data": new TextEncoder().encode("verified-after-retry"),
  });
  const image = await lazyImage([{ url: archiveUrl, archive }]);
  const bad = archive.slice();
  bad[0] ^= 0xff;
  let fetches = 0;
  await routeBytes(page, imageUrl, image, "application/octet-stream");
  await page.route(archiveUrl, async (route) => {
    fetches++;
    const bytes = fetches === 1 ? bad : archive;
    await route.fulfill({
      status: 200,
      body: Buffer.from(bytes),
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(bytes.byteLength),
      },
    });
  });

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect.poll(
    () => page.evaluate(() => window.__homebrewVfsTestReady),
    { timeout: 120_000 },
  ).toBe(true);
  const result = await page.evaluate(
    (url) => window.__runLazyVfsAcceptance({
      vfsUrl: url,
      readPath: "/etc/retry-data",
      retryReadAfterFailure: true,
      timeoutMs: 30_000,
    }),
    imageUrl,
  );

  expect(result.firstReadError).toContain("SHA-256");
  expect(result.readText).toBe("verified-after-retry");
  expect(fetches).toBe(2);
});

interface TarSpec {
  path: string;
  mode: number;
  data?: Uint8Array;
  target?: string;
}

function tarBytes(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = TAR_BLOCK * 2;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const payload = new Uint8Array(Math.ceil(data.byteLength / TAR_BLOCK) * TAR_BLOCK);
    payload.set(data);
    const header = new Uint8Array(TAR_BLOCK);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.target ? "1" : "0").charCodeAt(0);
    if (entry.target) writeTarString(header, 157, 100, entry.target);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeTarString(
      header,
      148,
      8,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
    );
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeTarString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error("test TAR field is too long");
  target.set(bytes, offset);
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeTarString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 2, "0")}\0`,
  );
}
