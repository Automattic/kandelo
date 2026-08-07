import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { HomebrewFlatVfsShippingProofResult } from
  "../../../homebrew/test/homebrew_flat_vfs_shipping_proof";
import {
  loadHomebrewFlatVfsProofInputs,
  readHomebrewFlatVfsRequestedImageFilename,
  runHomebrewFlatVfsProofWithEvidence,
} from "../../../homebrew/test/homebrew_flat_vfs_proof_inputs_node";
import type {
  HomebrewFlatVfsShippingProofRequest,
} from "../pages/homebrew-vfs-test/flat-vfs-shipping-request";
import {
  resolveHomebrewFlatVfsChromiumConfig,
} from "./homebrew-flat-vfs-shipping-config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewVfsAcceptance: (request: {
      vfsUrl: string;
      executable: string;
      argv: string[];
      timeoutMs: number;
    }) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      imageSha256: string;
      kernelSha256: string;
    }>;
    __runHomebrewFlatVfsShippingProof: (
      request: HomebrewFlatVfsShippingProofRequest,
    ) => Promise<HomebrewFlatVfsShippingProofResult>;
  }
}

test(
  "Chromium rejects the flat-VFS proof without live-network opt-in",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the first flat-VFS shipping proof targets Chromium",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== new URL(baseURL).origin) {
        externalRequests.push(request.url());
      }
    });
    const message = await page.evaluate(async () => {
      try {
        await window.__runHomebrewFlatVfsShippingProof({
          allowLiveNetwork: false,
          vfsUrl: "https://example.test/candidate.vfs.zst",
          expectedImageSha256: "1".repeat(64),
          expectedKernelSha256: "2".repeat(64),
          shellPath: "/bin/bash",
          shellArgv0: "bash",
          tapRevision: "1".repeat(40),
          timeoutMs: 1_000,
        } as unknown as HomebrewFlatVfsShippingProofRequest);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("flat-VFS request without live-network opt-in ran");
    });
    expect(message).toContain("explicit live-network opt-in");
    expect(externalRequests).toEqual([]);
  },
);

test(
  "Chromium rejects a kernel identity mismatch before fetching the VFS",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the first flat-VFS shipping proof targets Chromium",
    );
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    let imageRequests = 0;
    const vfsUrl = new URL("/__proof__/candidate.vfs.zst", baseURL).href;
    page.on("request", (request) => {
      if (request.url() === vfsUrl) imageRequests += 1;
    });
    const message = await page.evaluate(async (request) => {
      try {
        await window.__runHomebrewFlatVfsShippingProof(request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("flat-VFS request with the wrong kernel identity ran");
    }, {
      allowLiveNetwork: true,
      vfsUrl,
      expectedImageSha256: "1".repeat(64),
      expectedKernelSha256: "0".repeat(64),
      shellPath: "/bin/bash",
      shellArgv0: "bash",
      tapRevision: "2".repeat(40),
      timeoutMs: 1_000,
    } satisfies HomebrewFlatVfsShippingProofRequest);
    expect(message).toContain("requested kernel SHA-256 does not match");
    expect(imageRequests).toBe(0);
  },
);

for (const throughShell of [false, true]) {
  test(
    throughShell
      ? "the exact flat VFS starts Ruby through its selected shell in Chromium"
      : "the exact flat VFS starts its selected Ruby directly in Chromium",
    async ({ page, baseURL, browserName }) => {
      test.skip(
        browserName !== "chromium",
        "the first flat-VFS shipping proof targets Chromium",
      );
      const config = resolveHomebrewFlatVfsChromiumConfig(
        process.env,
        repoRoot,
      );
      if (config === null) {
        test.skip(true, "the exact flat Homebrew VFS is not configured");
        return;
      }
      if (!baseURL) throw new Error("Playwright baseURL is required");
      test.setTimeout(180_000);

      const inputs = loadHomebrewFlatVfsProofInputs({
        imagePath: resolve(
          config.assetRoot,
          readHomebrewFlatVfsRequestedImageFilename(config.selectionPath),
        ),
        selectionPath: config.selectionPath,
        selectionSourcePath: config.selectionSourcePath,
        reportPath: config.reportPath,
        kernelPath: config.kernelPath,
        tapRoot: config.tapRoot,
        tapRevision: config.tapRevision,
      });
      const vfsUrl = new URL(
        `/__kandelo_homebrew_flat_vfs__/${inputs.requestedVfsFilename}`,
        baseURL,
      );
      await page.route(vfsUrl.href, (route) => route.fulfill({
        path: inputs.imagePath,
        contentType: "application/octet-stream",
      }));
      await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
      await expect.poll(
        () => page.evaluate(() => window.__homebrewVfsTestReady),
        { timeout: 120_000 },
      ).toBe(true);

      const result = await page.evaluate(
        ({ url, executable, argv }) => window.__runHomebrewVfsAcceptance({
          vfsUrl: url,
          executable,
          argv,
          timeoutMs: 60_000,
        }),
        {
          url: vfsUrl.href,
          executable: throughShell
            ? inputs.shellPath
            : "/opt/kandelo/homebrew/bin/ruby",
          argv: throughShell
            ? [
                inputs.shellArgv0,
                "-c",
                "/opt/kandelo/homebrew/bin/ruby --version",
              ]
            : ["ruby", "--version"],
        },
      );
      expect(result.imageSha256).toBe(inputs.image.sha256);
      expect(result.kernelSha256).toBe(inputs.kernel.sha256);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^ruby 4\.0\.5\b/);
    },
  );
}

test(
  "the exact flat VFS installs and executes Bzip2 through stock Homebrew in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the first flat-VFS shipping proof targets Chromium",
    );
    const config = resolveHomebrewFlatVfsChromiumConfig(
      process.env,
      repoRoot,
    );
    if (config === null) {
      test.skip(true, "the exact flat Homebrew VFS is not configured");
      return;
    }
    if (!baseURL) throw new Error("Playwright baseURL is required");
    test.setTimeout(config.timeoutMs + 180_000);

    const inputs = loadHomebrewFlatVfsProofInputs({
      imagePath: resolve(
        config.assetRoot,
        readHomebrewFlatVfsRequestedImageFilename(config.selectionPath),
      ),
      selectionPath: config.selectionPath,
      selectionSourcePath: config.selectionSourcePath,
      reportPath: config.reportPath,
      kernelPath: config.kernelPath,
      tapRoot: config.tapRoot,
      tapRevision: config.tapRevision,
    });
    const vfsUrl = new URL(
      `/__kandelo_homebrew_flat_vfs__/${inputs.requestedVfsFilename}`,
      baseURL,
    );
    let imageRequests = 0;
    await page.route(vfsUrl.href, async (route) => {
      imageRequests += 1;
      await route.fulfill({
        path: inputs.imagePath,
        contentType: "application/octet-stream",
      });
    });

    await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
    await expect.poll(
      () => page.evaluate(() => window.__homebrewVfsTestReady),
      { timeout: 120_000 },
    ).toBe(true);
    let result: HomebrewFlatVfsShippingProofResult | undefined;
    await runHomebrewFlatVfsProofWithEvidence({
      host: "chromium",
      inputs,
      evidencePath: config.evidencePath,
      runProof: async () => {
        const proof = await page.evaluate(
          (request) => window.__runHomebrewFlatVfsShippingProof(request),
          {
            allowLiveNetwork: true,
            vfsUrl: vfsUrl.href,
            expectedImageSha256: inputs.image.sha256,
            expectedKernelSha256: inputs.kernel.sha256,
            shellPath: inputs.shellPath,
            shellArgv0: inputs.shellArgv0,
            tapRevision: inputs.tapRevision,
            timeoutMs: config.timeoutMs,
          } satisfies HomebrewFlatVfsShippingProofRequest,
        );
        result = proof;
        return proof;
      },
    });

    expect(result!.tapRevision).toBe(inputs.tapRevision);
    expect(result!.selectionSha256).toBe(inputs.selectionSha256);
    expect(result!.lazyDownloads).toEqual([]);
    expect(imageRequests).toBe(1);
  },
);
