import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

import { DEFAULT_BROWSER_CORS_PROXY_URL } from "../lib/browser-cors-proxy";
import {
  browserLazyFetchUrl,
  canonicalAssetForPackage,
  canonicalHomebrewTransportPlan,
  type CanonicalHomebrewAsset,
  type CanonicalHomebrewTransportPlan,
} from "./support/homebrew-lazy-transport";
import { runTerminalCommand } from "./support/terminal-command";

const TOOLCHAIN_PACKAGES = [
  "kandelo-dev/tap-core/libcxx",
  "kandelo-dev/tap-core/clang",
  "kandelo-dev/tap-core/kandelo-sdk",
] as const;
const acceptance = process.env.KANDELO_C_DEVELOPMENT_CANONICAL_ACCEPTANCE === "1"
  ? loadCanonicalAcceptance(
      process.env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT,
    )
  : undefined;

test.describe("canonical C development browser delivery", () => {
  test.skip(
    acceptance === undefined,
    "requires the explicitly enabled canonical Pages producer handoff",
  );

  let bodies: ReadonlyMap<string, Buffer>;

  test.beforeAll(async ({ request }, testInfo) => {
    bodies = await fetchExactBodies(
      request,
      String(testInfo.project.use.baseURL),
      acceptance!.assets,
    );
  });

  test("keeps the terminal usable during background prefetch and reuses materialized trees", async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
    });
    let releaseClang!: () => void;
    const clangRelease = new Promise<void>((resolveRelease) => {
      releaseClang = resolveRelease;
    });
    let clangResponseReleased = false;
    const transport = await routeToolchainAssets(
      context,
      String(testInfo.project.use.baseURL),
      acceptance!.assets,
      bodies,
      async (asset, route) => {
        if (asset.package === "kandelo-dev/tap-core/clang") {
          await clangRelease;
          clangResponseReleased = true;
        }
        await fulfillExact(route, asset, bodies);
      },
    );
    const page = await context.newPage();
    try {
      await bootProfile(page, "c-dev");
      await expect(page.getByRole("heading", { name: "C development" }))
        .toBeVisible();
      await expect.poll(
        () => transport.count("kandelo-dev/tap-core/clang"),
        { timeout: 180_000 },
      ).toBe(1);
      await runTerminalCommand(
        page,
        "printf 'C_DEV_TERMINAL_USABLE_DURING_PREFETCH\\n'",
        "C_DEV_TERMINAL_USABLE_DURING_PREFETCH",
      );
      expect(clangResponseReleased).toBe(false);

      releaseClang();
      await waitForToolchainReady(page);
      await runTerminalCommand(
        page,
        "cc hello.c -o hello.wasm && ./hello.wasm",
        "Hello from Kandelo C!",
        300_000,
      );
      const requestsAfterCompile = transport.snapshot();
      await runTerminalCommand(
        page,
        "cc hello.c -o hello-again.wasm && ./hello-again.wasm",
        "Hello from Kandelo C!",
        300_000,
      );
      expect(transport.snapshot()).toEqual(requestsAfterCompile);
      expect(requestsAfterCompile).toEqual(Object.fromEntries(
        TOOLCHAIN_PACKAGES.map((packageName) => [packageName, 1]),
      ));
    } finally {
      releaseClang();
      await context.close();
    }
  });

  test("defers the compiler closure in the ordinary shell until first use", async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
    });
    const transport = await routeToolchainAssets(
      context,
      String(testInfo.project.use.baseURL),
      acceptance!.assets,
      bodies,
      (asset, route) => fulfillExact(route, asset, bodies),
    );
    const page = await context.newPage();
    try {
      await bootProfile(page, "shell");
      await runTerminalCommand(
        page,
        "printf 'DEFAULT_SHELL_READY\\n'",
        "DEFAULT_SHELL_READY",
      );
      expect(transport.snapshot()).toEqual(Object.fromEntries(
        TOOLCHAIN_PACKAGES.map((packageName) => [packageName, 0]),
      ));
      expect(await selectedLazyRows(page, acceptance!.assets)).toEqual([]);

      const work = "/tmp/kandelo-default-toolchain";
      await runTerminalCommand(
        page,
        [
          "set -eu",
          "export HOME=/tmp MAKEFLAGS=-j1",
          `printf '%s\\n' '#include <stdio.h>' ` +
            `'int main(void) { puts("BROWSER_C_IN_GUEST_OK"); return 0; }' ` +
            `> ${work}.c`,
          `printf '%s\\n' '#include <iostream>' ` +
            `'int main() { std::cout << "BROWSER_CXX_IN_GUEST_OK\\n"; return 0; }' ` +
            `> ${work}.cpp`,
          `cc ${work}.c -o ${work}-c.wasm`,
          `c++ ${work}.cpp -o ${work}-cxx.wasm`,
          `${work}-c.wasm`,
          `${work}-cxx.wasm`,
        ].join("\n"),
        "BROWSER_CXX_IN_GUEST_OK",
        300_000,
      );
      expect(transport.snapshot()).toEqual(Object.fromEntries(
        TOOLCHAIN_PACKAGES.map((packageName) => [packageName, 1]),
      ));
      expect(await selectedLazyRows(page, acceptance!.assets))
        .toEqual(acceptance!.assets.map((asset) => ({
          source: asset.sourceUrl,
          status: "complete",
        })).sort((left, right) => left.source.localeCompare(right.source)));
    } finally {
      await context.close();
    }
  });

  for (const failure of [
    {
      name: "missing",
      expected: /404|not found/iu,
      response: async (_asset: CanonicalHomebrewAsset, route: Route) => {
        await route.fulfill({ body: "missing", status: 404 });
      },
    },
    {
      name: "truncated",
      expected: /byte count|bytes|size|truncated/iu,
      response: async (
        asset: CanonicalHomebrewAsset,
        route: Route,
        exactBodies: ReadonlyMap<string, Buffer>,
      ) => {
        const body = exactBody(asset, exactBodies);
        await route.fulfill({ body: body.subarray(0, body.byteLength - 1), status: 200 });
      },
    },
    {
      name: "digest-mismatch",
      expected: /sha-?256|digest/iu,
      response: async (
        asset: CanonicalHomebrewAsset,
        route: Route,
        exactBodies: ReadonlyMap<string, Buffer>,
      ) => {
        const corrupt = Buffer.from(exactBody(asset, exactBodies));
        corrupt[0] = corrupt[0]! ^ 0xff;
        await route.fulfill({ body: corrupt, status: 200 });
      },
    },
  ] as const) {
    test(`recovers atomically from a ${failure.name} compiler asset`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        baseURL: String(testInfo.project.use.baseURL),
      });
      const failedPackage = "kandelo-dev/tap-core/clang";
      let injectFailure = true;
      const requestedUrls: string[] = [];
      const transport = await routeToolchainAssets(
        context,
        String(testInfo.project.use.baseURL),
        acceptance!.assets,
        bodies,
        async (asset, route) => {
          if (asset.package === failedPackage && injectFailure) {
            requestedUrls.push(route.request().url());
            await failure.response(asset, route, bodies);
            return;
          }
          if (asset.package === failedPackage) {
            requestedUrls.push(route.request().url());
          }
          await fulfillExact(route, asset, bodies);
        },
      );
      const page = await context.newPage();
      try {
        await bootProfile(page, "c-dev");
        const alert = page.getByRole("alert").filter({
          hasText: "C/C++ toolchain",
        });
        await expect(alert).toBeVisible({ timeout: 300_000 });
        await expect(alert).toContainText(failure.expected);
        await runTerminalCommand(
          page,
          "printf 'SHELL_STILL_ALIVE\\n'",
          "SHELL_STILL_ALIVE",
        );
        const requestsBeforeUnavailableProbe = transport.count(failedPackage);
        const unavailable = await runTerminalCommand(
          page,
          "if cc --version >/tmp/cc-version 2>&1; then printf 'PARTIAL_COMPILER\\n'; else printf 'CC_UNAVAILABLE\\n'; fi",
          "CC_UNAVAILABLE",
        );
        expect(unavailable.output).not.toContain("PARTIAL_COMPILER");
        expect(transport.count(failedPackage)).toBe(requestsBeforeUnavailableProbe);
        expect(await selectedLazyRows(page, acceptance!.assets))
          .toContainEqual({
            source: canonicalAssetForPackage(
              acceptance!.plan,
              failedPackage,
            ).sourceUrl,
            status: "error",
          });

        injectFailure = false;
        await alert.getByRole("button", { name: "Retry" }).click();
        await waitForToolchainReady(page);
        await runTerminalCommand(
          page,
          "cc hello.c -o hello.wasm && ./hello.wasm",
          "Hello from Kandelo C!",
          300_000,
        );
        expect(transport.count(failedPackage)).toBe(
          requestsBeforeUnavailableProbe + 1,
        );
        const failedAsset = canonicalAssetForPackage(
          acceptance!.plan,
          failedPackage,
        );
        const expectedUrl = browserLazyFetchUrl(
          failedAsset.sourceUrl,
          String(testInfo.project.use.baseURL),
          DEFAULT_BROWSER_CORS_PROXY_URL,
        );
        expect(requestedUrls).toHaveLength(requestsBeforeUnavailableProbe + 1);
        expect(requestedUrls.every((url) => url === expectedUrl)).toBe(true);
        expect(await selectedLazyRows(page, acceptance!.assets))
          .toContainEqual({ source: failedAsset.sourceUrl, status: "complete" });
      } finally {
        await context.close();
      }
    });
  }
});

interface CanonicalAcceptance {
  assets: CanonicalHomebrewAsset[];
  plan: CanonicalHomebrewTransportPlan;
}

function loadCanonicalAcceptance(siteRootValue: string | undefined): CanonicalAcceptance {
  if (
    siteRootValue === undefined ||
    siteRootValue === "" ||
    resolve(siteRootValue) !== siteRootValue ||
    basename(siteRootValue) !== "source-tree"
  ) {
    throw new Error(
      "canonical C-development acceptance requires the producer source-tree",
    );
  }
  const metadata = lstatSync(siteRootValue);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("canonical C-development source tree is not one direct directory");
  }
  const outputRoot = dirname(siteRootValue);
  const resolvedPath = join(
    outputRoot,
    "artifacts/products/browser-main-shell/resolved-inputs.json",
  );
  const resolvedBytes = readFileSync(resolvedPath);
  if (resolvedBytes.byteLength < 1 || resolvedBytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("canonical browser-main-shell resolved inputs exceed their bound");
  }
  const resolved = JSON.parse(resolvedBytes.toString("utf8"));
  if (resolved.product?.id !== "browser-main-shell") {
    throw new Error("canonical resolved inputs name another product");
  }
  const plan = canonicalHomebrewTransportPlan(resolved);
  const assets = TOOLCHAIN_PACKAGES.map((packageName) =>
    canonicalAssetForPackage(plan, packageName)
  );

  const deployment = JSON.parse(readFileSync(join(
    siteRootValue,
    ".well-known/kandelo/pages-deployment.json",
  ), "utf8"));
  const expectedProducts = [
    "browser-lamp",
    "browser-main-shell",
    "browser-nginx",
    "browser-nginx-php",
    "browser-node",
    "browser-wordpress",
    "platform-rootfs",
  ];
  if (
    deployment.kind !== "kandelo-pages-site-manifest" ||
    deployment.schema !== 1 ||
    JSON.stringify(deployment.products?.map(({ id }: { id: string }) => id)) !==
      JSON.stringify(expectedProducts)
  ) {
    throw new Error("canonical C-development acceptance requires the exact seven-product site");
  }
  const shell = deployment.products.find(
    ({ id }: { id: string }) => id === "browser-main-shell",
  );
  const vfs = readFileSync(join(siteRootValue, shell.path));
  if (
    vfs.byteLength !== shell.vfs_bytes ||
    sha256(vfs) !== shell.vfs_sha256
  ) {
    throw new Error("assembled browser-main-shell differs from its deployment identity");
  }
  return { assets, plan };
}

async function fetchExactBodies(
  request: APIRequestContext,
  pageUrl: string,
  assets: readonly CanonicalHomebrewAsset[],
): Promise<ReadonlyMap<string, Buffer>> {
  const bodies = new Map<string, Buffer>();
  for (const asset of assets) {
    const fetchUrl = browserLazyFetchUrl(
      asset.sourceUrl,
      pageUrl,
      DEFAULT_BROWSER_CORS_PROXY_URL,
    );
    const response = await request.get(fetchUrl, { timeout: 300_000 });
    if (!response.ok()) {
      throw new Error(
        `canonical Homebrew acceptance source returned HTTP ${response.status()}`,
      );
    }
    const body = await response.body();
    if (body.byteLength !== asset.bytes || sha256(body) !== asset.sha256) {
      throw new Error(
        `canonical Homebrew acceptance source changed for ${asset.package}`,
      );
    }
    bodies.set(asset.package, body);
  }
  return bodies;
}

async function routeToolchainAssets(
  context: BrowserContext,
  pageUrl: string,
  assets: readonly CanonicalHomebrewAsset[],
  bodies: ReadonlyMap<string, Buffer>,
  respond: (
    asset: CanonicalHomebrewAsset,
    route: Route,
    bodies: ReadonlyMap<string, Buffer>,
  ) => Promise<void>,
): Promise<{
  count(packageName: string): number;
  snapshot(): Record<string, number>;
}> {
  const counts = new Map(assets.map((asset) => [asset.package, 0]));
  for (const asset of assets) {
    const fetchUrl = browserLazyFetchUrl(
      asset.sourceUrl,
      pageUrl,
      DEFAULT_BROWSER_CORS_PROXY_URL,
    );
    await context.route(fetchUrl, async (route) => {
      counts.set(asset.package, (counts.get(asset.package) ?? 0) + 1);
      await respond(asset, route, bodies);
    });
  }
  return {
    count: (packageName) => counts.get(packageName) ?? 0,
    snapshot: () => Object.fromEntries(TOOLCHAIN_PACKAGES.map(
      (packageName) => [packageName, counts.get(packageName) ?? 0],
    )),
  };
}

async function fulfillExact(
  route: Route,
  asset: CanonicalHomebrewAsset,
  bodies: ReadonlyMap<string, Buffer>,
): Promise<void> {
  await route.fulfill({ body: exactBody(asset, bodies), status: 200 });
}

function exactBody(
  asset: CanonicalHomebrewAsset,
  bodies: ReadonlyMap<string, Buffer>,
): Buffer {
  const body = bodies.get(asset.package);
  if (
    body === undefined ||
    body.byteLength !== asset.bytes ||
    sha256(body) !== asset.sha256
  ) {
    throw new Error(`exact Homebrew body is unavailable for ${asset.package}`);
  }
  return body;
}

async function bootProfile(page: Page, profile: "c-dev" | "shell"): Promise<void> {
  const disabledGallery = encodeURIComponent(
    "/kandelo/.well-known/kandelo/c-development-no-external-gallery.json",
  );
  const response = await page.goto(
    `pages/kandelo/?demo=${profile}&softwareManifest=${disabledGallery}`,
    { waitUntil: "domcontentloaded" },
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator(".kdock-status-text[data-status=running]"))
    .toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole("textbox", { name: "Terminal input" }).first())
    .toBeVisible({ timeout: 180_000 });
}

async function waitForToolchainReady(page: Page): Promise<void> {
  await expect(
    page.locator(".kpackage-prefetch-toasts .kdownload-toast-title").filter({
      hasText: "C/C++ toolchain ready",
    }),
  ).toBeVisible({ timeout: 300_000 });
}

async function selectedLazyRows(
  page: Page,
  assets: readonly CanonicalHomebrewAsset[],
): Promise<Array<{ source: string; status: string | null }>> {
  const internals = page.getByRole("button", { name: "Internals" });
  if ((await internals.getAttribute("aria-pressed")) !== "true") {
    await internals.click();
  }
  await page.getByRole("tab", { name: "Lazy Load" }).click();
  const selectedSources = new Set(assets.map(({ sourceUrl }) => sourceUrl));
  const rows = await page.locator(".kdownload-table tbody tr").evaluateAll(
    (elements) => elements.map((element) => ({
      source: element.getAttribute("data-source") ?? "",
      status: element.getAttribute("data-download-status"),
    })),
  );
  await internals.click();
  return rows
    .filter(({ source }) => selectedSources.has(source))
    .sort((left, right) => left.source.localeCompare(right.source));
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
