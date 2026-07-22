import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  createHomebrewBootstrapGuestContractScript,
  HOMEBREW_BOOTSTRAP_CONTRACT_MARKER,
  HOMEBREW_BOOTSTRAP_GUEST,
  HOMEBREW_BOOTSTRAP_GUEST_ENV,
} from "../../../scripts/homebrew-bootstrap-guest-contract";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

interface BootstrapRequest {
  vfsUrl: string;
  executable: string;
  argv: string[];
  env?: string[];
  cwd?: string;
  uid?: number;
  gid?: number;
  lazyUrlBase?: string;
  timeoutMs: number;
}

interface BootstrapResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  imageSha256: string;
  kernelSha256: string;
}

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewVfsAcceptance: (
      request: BootstrapRequest,
    ) => Promise<BootstrapResult>;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const localImage = resolve(
  repoRoot,
  "target/homebrew-bootstrap/homebrew-bootstrap.vfs",
);
const publicImage = resolve(
  repoRoot,
  "apps/browser-demos/public/__kandelo-acceptance/homebrew-bootstrap.vfs",
);
let copiedLocalImage = false;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test.beforeAll(() => {
  if (process.env.KANDELO_HOMEBREW_BOOTSTRAP_VFS_URL || !existsSync(localImage)) return;
  mkdirSync(dirname(publicImage), { recursive: true });
  copyFileSync(localImage, publicImage);
  copiedLocalImage = true;
});

test.afterAll(() => {
  if (copiedLocalImage) rmSync(publicImage, { force: true });
});

test("stock Homebrew bootstrap entrypoints and state work in Chromium", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(600_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");

  const configuredUrl = process.env.KANDELO_HOMEBREW_BOOTSTRAP_VFS_URL;
  const hasLocalImage = existsSync(localImage);
  test.skip(!configuredUrl && !hasLocalImage, "Homebrew bootstrap VFS is not available");

  const vfsUrl = configuredUrl ??
    new URL("/__kandelo-acceptance/homebrew-bootstrap.vfs", baseURL).href;
  const imageSha256 = process.env.KANDELO_HOMEBREW_BOOTSTRAP_VFS_SHA256 ??
    (hasLocalImage ? sha256(localImage) : undefined);
  const kernelPath = tryResolveBinary("kernel.wasm");
  const kernelSha256 = process.env.KANDELO_HOMEBREW_BOOTSTRAP_KERNEL_SHA256 ??
    (kernelPath ? sha256(kernelPath) : undefined);
  if (!imageSha256 || !kernelSha256) {
    throw new Error("Homebrew bootstrap image and kernel digests are required");
  }

  const unexpectedLazyDownloads: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/\/binaries\/programs\//.test(url)) unexpectedLazyDownloads.push(url);
  });

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect
    .poll(() => page.evaluate(() => window.__homebrewVfsTestReady), {
      timeout: 120_000,
    })
    .toBe(true);

  const result = await page.evaluate(
    async ({ imageUrl, script, env, guest }) =>
      window.__runHomebrewVfsAcceptance({
        vfsUrl: imageUrl,
        executable: "/usr/bin/bash",
        argv: ["/bin/bash", "-c", script],
        env,
        cwd: guest.cwd,
        uid: guest.uid,
        gid: guest.gid,
        timeoutMs: 300_000,
      }),
    {
      imageUrl: vfsUrl,
      script: createHomebrewBootstrapGuestContractScript(),
      env: [...HOMEBREW_BOOTSTRAP_GUEST_ENV],
      guest: HOMEBREW_BOOTSTRAP_GUEST,
    },
  );

  expect(result.imageSha256).toBe(imageSha256);
  expect(result.kernelSha256).toBe(kernelSha256);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout.split(/\r?\n/)).toContain(HOMEBREW_BOOTSTRAP_CONTRACT_MARKER);
  expect(unexpectedLazyDownloads).toEqual([]);
});
