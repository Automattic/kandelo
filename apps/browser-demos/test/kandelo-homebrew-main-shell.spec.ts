import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { parseHomebrewRuntimeSupportContract } from "../../../host/src/homebrew-runtime-support";
import { parseHomebrewVfsMaterializationPolicy } from "../../../host/src/homebrew-vfs-materialization-policy";
import { corsProxyTargetUrl } from "../../../host/src/networking/cors-proxy-url";
import { assertMainShellOperationalRuntimeFetches } from "../../../scripts/homebrew-main-shell-image-contract";
import { DEFAULT_BROWSER_CORS_PROXY_URL } from "../lib/browser-cors-proxy";
import {
  isShellVfsImageUrl,
  isVfsImageUrl,
  SHELL_VFS_IMAGE_PATH_PATTERN_SOURCE,
} from "../lib/shell-vfs-image-url";
import {
  runParentShellProbe,
  runTerminalCommand,
} from "./support/terminal-command";

const strict = process.env.KANDELO_HOMEBREW_MAIN_SHELL_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_HOMEBREW_MAIN_SHELL_SHA256;
const expectedBootstrapSha256 =
  process.env.KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_SHA256;
const expectedBootstrapBytes =
  process.env.KANDELO_HOMEBREW_MAIN_SHELL_BOOTSTRAP_BYTES;
const closedMirrorRoot =
  process.env.KANDELO_PLAYWRIGHT_CLOSED_ACCEPTANCE_ROOT;
const transportMode = process.env.KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE;
const mirrorPlanUrl = process.env.KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL;
const runtimeSupport = parseHomebrewRuntimeSupportContract(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../homebrew/main-shell-homebrew-runtime-support.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const materializationPolicy = parseHomebrewVfsMaterializationPolicy(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../homebrew/main-shell-materialization-policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

interface MirrorAsset {
  package: string;
  asset: string;
  sha256: string;
  bytes: number;
  url: string;
}

interface LazyDownloadRow {
  asset: string;
  status: string | null;
  kind: string | null;
  source: string | null;
  loadedBytes: string | null;
  totalBytes: string | null;
  eventCount: string | null;
}

interface ExactAcceptanceConfig {
  imageSha256: string;
  bootstrapSha256: string;
  bootstrapBytes: string;
  transportMode: "closed" | "public";
  mirrorPlanUrl: string;
  closedMirrorRoot: string | undefined;
}

interface BootstrapPayloadResponse {
  url: string;
  status: number;
  sha256: string;
  bytes: number;
}

interface ExactShellPage {
  config: ExactAcceptanceConfig;
  mirrorPlan: { assets: MirrorAsset[] };
  legacyArtifactDownloads: string[];
  bootstrapPayloadRequests: string[];
  bootstrapPayloadResponses: Array<Promise<BootstrapPayloadResponse>>;
  artifactTransportRequests: ArtifactTransportRequest[];
}

interface ArtifactTransportRequest {
  requestUrl: string;
  targetUrl: string;
  proxied: boolean;
}

const BASE_EXPECTED_PACKAGES = [
  "kandelo-dev/tap-core/dash",
  "kandelo-dev/tap-core/bzip2",
  "kandelo-dev/tap-core/m4",
] as const;
const RUNTIME_SUPPORT_EXPECTED_PACKAGES = runtimeSupport.additionalFormulaOrder;
const EXPECTED_MIRROR_PACKAGES = [
  ...runtimeSupport.baseFormulaOrder,
  ...runtimeSupport.additionalFormulaOrder,
]
  .filter(
    (packageName) =>
      !materializationPolicy.embedded_package_order.includes(packageName),
  )
  .sort();

function isHomebrewBootstrapUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  return /(?:^|\/)homebrew-bootstrap(?:-[A-Za-z0-9_-]+)?\.zip$/.test(path);
}

function isHomebrewBootstrapRow(row: LazyDownloadRow): boolean {
  return row.source !== null && isHomebrewBootstrapUrl(row.source);
}

function browserProxyTargetUrl(
  requestUrl: string,
  pageUrl: string,
): string | undefined {
  const configuredProxyUrl =
    process.env.VITE_CORS_PROXY_URL?.trim() ||
    DEFAULT_BROWSER_CORS_PROXY_URL;
  const configuredTarget = corsProxyTargetUrl(
    configuredProxyUrl,
    requestUrl,
    pageUrl,
  );
  if (configuredTarget !== undefined) return configuredTarget;

  // Vite development uses a same-origin proxy even when the production build
  // would use the public default. Recognize that route without accepting an
  // arbitrary query parameter as transport evidence.
  try {
    const request = new URL(requestUrl);
    if (!request.pathname.endsWith("/__kandelo_cors_proxy")) {
      return undefined;
    }
    const rawTarget = request.searchParams.get("url");
    if (rawTarget === null) return undefined;
    const target = new URL(rawTarget);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target.href
      : undefined;
  } catch {
    return undefined;
  }
}

function bottleRows(rows: readonly LazyDownloadRow[]): LazyDownloadRow[] {
  return rows.filter((row) => !isHomebrewBootstrapRow(row));
}

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(".xterm-rows")
    .first()
    .evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(
  page: Page,
  expected: string | RegExp,
  timeout = 180_000,
) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    text = await terminalText(page);
    const matched =
      typeof expected === "string"
        ? text.includes(expected)
        : expected.test(text);
    if (matched) return;
    if (/bash: \/bin\/sh: I\/O error/.test(text)) {
      throw new Error(
        `shell command hit lazy VFS I/O failure: ${await lazyDownloadDiagnostics(page)}`,
      );
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    `timed out waiting for ${String(expected)} in terminal output: ${text}`,
  );
}

async function lazyDownloadDiagnostics(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Internals" }).click();
  await page.getByRole("tab", { name: "Lazy Load" }).click();
  const rows = await page
    .locator(".kdownload-table tbody tr")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        status: element.getAttribute("data-download-status"),
        source: element.getAttribute("data-source"),
        text: element.textContent?.replace(/\s+/g, " ").trim(),
      })),
    );
  return JSON.stringify(rows);
}

async function readLazyDownloadRows(page: Page): Promise<LazyDownloadRow[]> {
  const internals = page.getByRole("button", { name: "Internals" });
  if ((await internals.getAttribute("aria-pressed")) !== "true") {
    await internals.click();
  }
  await page.getByRole("tab", { name: "Lazy Load" }).click();
  const rows = await page
    .locator(".kdownload-table tbody tr")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        asset:
          element.querySelector(".kdownload-asset-name")?.textContent?.trim() ??
          "",
        status: element.getAttribute("data-download-status"),
        kind: element.getAttribute("data-download-kind"),
        source: element.getAttribute("data-source"),
        loadedBytes: element.getAttribute("data-loaded-bytes"),
        totalBytes: element.getAttribute("data-total-bytes"),
        eventCount: element.getAttribute("data-download-events"),
      })),
    );
  await internals.click();
  return rows;
}

function packageNamesForRows(
  rows: readonly LazyDownloadRow[],
  mirrorPlan: { assets: MirrorAsset[] },
): string[] {
  const packageByUrl = new Map(
    mirrorPlan.assets.map((asset) => [asset.url, asset.package]),
  );
  return bottleRows(rows)
    .map((row) => {
      const packageName =
        row.source === null ? undefined : packageByUrl.get(row.source);
      if (packageName === undefined) {
        throw new Error(
          `lazy row source is absent from the mirror plan: ${String(row.source)}`,
        );
      }
      return packageName;
    })
    .sort();
}

function snapshotLazyRows(
  rows: readonly LazyDownloadRow[],
): Map<string | null, string> {
  const snapshot = new Map<string | null, string>();
  for (const row of rows) {
    if (snapshot.has(row.source)) {
      throw new Error(
        `lazy ledger contains duplicate source ${String(row.source)}`,
      );
    }
    snapshot.set(row.source, JSON.stringify(row));
  }
  return snapshot;
}

function assertPriorLazyRowsUnchanged(
  prior: ReadonlyMap<string | null, string>,
  currentRows: readonly LazyDownloadRow[],
): void {
  const current = snapshotLazyRows(currentRows);
  for (const [source, expected] of prior) {
    expect(
      current.get(source),
      `lazy ledger row changed for prior source ${String(source)}`,
    ).toBe(expected);
  }
}

async function waitForLazyPackageRows(
  page: Page,
  priorSources: ReadonlySet<string | null>,
  expectedPackages: readonly string[],
  mirrorPlan: { assets: MirrorAsset[] },
  timeoutMs = 30_000,
): Promise<LazyDownloadRow[]> {
  const deadline = Date.now() + timeoutMs;
  const settleWindowMs = 1_000;
  let rows: LazyDownloadRow[] = [];
  let stableCompleteFingerprint: string | undefined;
  let stableCompleteSince = 0;
  while (Date.now() < deadline) {
    rows = await readLazyDownloadRows(page);
    const added = rows.filter(({ source }) => !priorSources.has(source));
    const addedPackages = new Set(packageNamesForRows(added, mirrorPlan));
    const expectedPackagesPresent = expectedPackages.every((packageName) =>
      addedPackages.has(packageName),
    );
    const addedRowsComplete = added.every(
      ({ status }) => status === "complete",
    );
    if (expectedPackagesPresent && addedRowsComplete) {
      // Guest completion can precede the last React ledger update. Require a
      // quiet completed window so a delayed row cannot escape this phase.
      const fingerprint = JSON.stringify(added);
      if (fingerprint !== stableCompleteFingerprint) {
        stableCompleteFingerprint = fingerprint;
        stableCompleteSince = Date.now();
      } else if (Date.now() - stableCompleteSince >= settleWindowMs) {
        return rows;
      }
    } else {
      stableCompleteFingerprint = undefined;
      stableCompleteSince = 0;
    }
    await page.waitForTimeout(100);
  }
  const added = rows.filter(({ source }) => !priorSources.has(source));
  throw new Error(
    `timed out waiting for completed lazy packages: ${JSON.stringify({
      expectedPackages,
      observedPackages: packageNamesForRows(added, mirrorPlan),
      rows: added,
    })}`,
  );
}

async function waitForHomebrewBootstrapRow(
  page: Page,
): Promise<{ rows: LazyDownloadRow[]; bootstrap: LazyDownloadRow }> {
  const deadline = Date.now() + 180_000;
  let rows: LazyDownloadRow[] = [];
  while (Date.now() < deadline) {
    rows = await readLazyDownloadRows(page);
    const matches = rows.filter(isHomebrewBootstrapRow);
    if (matches.length === 1 && matches[0]?.status === "complete") {
      return { rows, bootstrap: matches[0] };
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    `timed out waiting for one completed Homebrew source tree: ${JSON.stringify(rows)}`,
  );
}

function exactAcceptanceConfig(): ExactAcceptanceConfig {
  if (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256)) {
    throw new Error(
      "KANDELO_HOMEBREW_MAIN_SHELL_SHA256 must be the exact lowercase image digest",
    );
  }
  if (
    !expectedBootstrapSha256 ||
    !/^[0-9a-f]{64}$/.test(expectedBootstrapSha256) ||
    !expectedBootstrapBytes ||
    !/^[1-9][0-9]*$/.test(expectedBootstrapBytes)
  ) {
    throw new Error(
      "the exact Homebrew bootstrap SHA-256 and byte count must be configured",
    );
  }
  if (transportMode !== "closed" && transportMode !== "public") {
    throw new Error(
      "KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE must be closed or public",
    );
  }
  if (
    !mirrorPlanUrl ||
    (transportMode === "closed" &&
      (!closedMirrorRoot || !closedMirrorRoot.startsWith("/"))) ||
    (transportMode === "public" && closedMirrorRoot !== undefined)
  ) {
    throw new Error(
      "main-shell transport mode has inconsistent mirror configuration",
    );
  }
  return {
    imageSha256: expectedImageSha256,
    bootstrapSha256: expectedBootstrapSha256,
    bootstrapBytes: expectedBootstrapBytes,
    transportMode,
    mirrorPlanUrl,
    closedMirrorRoot,
  };
}

async function bootExactShellPage(page: Page): Promise<ExactShellPage> {
  const config = exactAcceptanceConfig();
  const legacyArtifactDownloads: string[] = [];
  const bootstrapPayloadRequests: string[] = [];
  const bootstrapPayloadResponses: Array<Promise<BootstrapPayloadResponse>> =
    [];
  const artifactTransportRequests: ArtifactTransportRequest[] = [];
  const closedPayloadResponses: Array<{ url: string; status: number }> = [];
  await page.addInitScript((shellVfsImagePathPatternSource) => {
    const evidence = {
      digests: [] as string[],
      errors: [] as string[],
    };
    Object.defineProperty(window, "__kandeloHomebrewMainShellImageEvidence", {
      configurable: false,
      enumerable: false,
      value: evidence,
      writable: false,
    });

    const nativeFetch = window.fetch.bind(window);
    const shellVfsImagePathPattern = new RegExp(
      shellVfsImagePathPatternSource,
    );
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      // WHY: this observer runs inside the page and cannot close over the
      // imported helper. Passing the same tested pattern keeps byte hashing
      // and the request classifier on one filename contract.
      if (shellVfsImagePathPattern.test(new URL(response.url).pathname)) {
        void response
          .clone()
          .arrayBuffer()
          .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
          .then((digest) => {
            evidence.digests.push(
              Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            );
          })
          .catch((error: unknown) => {
            evidence.errors.push(
              error instanceof Error ? error.message : String(error),
            );
          });
      }
      return response;
    };
  }, SHELL_VFS_IMAGE_PATH_PATTERN_SOURCE);
  page.on("request", (request) => {
    if (request.resourceType() !== "fetch") return;
    const requestUrl = request.url();
    const proxyTarget = browserProxyTargetUrl(requestUrl, page.url());
    const targetUrl = proxyTarget ?? requestUrl;
    artifactTransportRequests.push({
      requestUrl,
      targetUrl,
      proxied: proxyTarget !== undefined,
    });
    if (isHomebrewBootstrapUrl(targetUrl)) {
      bootstrapPayloadRequests.push(targetUrl);
      return;
    }
    if (
      ((/\.(?:wasm|zip)(?:\?|$)/.test(targetUrl) &&
        !/kernel[^/]*\.wasm(?:\?|$)/.test(targetUrl)) ||
        (isVfsImageUrl(targetUrl) && !isShellVfsImageUrl(targetUrl)))
    ) {
      legacyArtifactDownloads.push(targetUrl);
    }
  });
  page.on("response", (response) => {
    if (response.request().resourceType() !== "fetch") return;
    const responseUrl = response.url();
    const targetUrl =
      browserProxyTargetUrl(responseUrl, page.url()) ?? responseUrl;
    if (isHomebrewBootstrapUrl(targetUrl)) {
      bootstrapPayloadResponses.push(
        response.body().then((bytes) => ({
          url: targetUrl,
          status: response.status(),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        })),
      );
    }
    if (!config.closedMirrorRoot) return;
    const url = new URL(response.url());
    if (
      url.pathname.startsWith(`${config.closedMirrorRoot}/`) &&
      url.pathname.endsWith("-layer.bin")
    ) {
      closedPayloadResponses.push({
        url: response.url(),
        status: response.status(),
      });
    }
  });

  await page.goto("/?demo=shell", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  const overlay = page.locator("vite-error-overlay");
  if (await overlay.count()) {
    const detail = await overlay.evaluate(
      (element) =>
        element.shadowRoot
          ?.querySelector(".message-body")
          ?.textContent?.trim() ||
        element.shadowRoot?.textContent?.trim() ||
        element.textContent?.trim() ||
        "unknown Vite import error",
    );
    throw new Error(
      `Homebrew main-shell smoke hit a Vite error overlay: ${detail}`,
    );
  }

  await page.waitForFunction(
    () => {
      const evidence = (
        window as typeof window & {
          __kandeloHomebrewMainShellImageEvidence?: {
            digests: string[];
            errors: string[];
          };
        }
      ).__kandeloHomebrewMainShellImageEvidence;
      return Boolean(
        evidence && (evidence.digests.length > 0 || evidence.errors.length > 0),
      );
    },
    undefined,
    { timeout: 180_000 },
  );
  const imageEvidence = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __kandeloHomebrewMainShellImageEvidence: {
            digests: string[];
            errors: string[];
          };
        }
      ).__kandeloHomebrewMainShellImageEvidence,
  );
  expect(imageEvidence.errors).toEqual([]);
  expect(new Set(imageEvidence.digests)).toEqual(new Set([config.imageSha256]));

  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 240_000);
  const mirrorPlan = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`mirror plan fetch failed: HTTP ${response.status}`);
    return response.json() as Promise<{ assets: MirrorAsset[] }>;
  }, config.mirrorPlanUrl);
  expect(mirrorPlan.assets.length).toBeGreaterThan(0);
  expect(mirrorPlan.assets.map(({ package: packageName }) => packageName).sort())
    .toEqual(EXPECTED_MIRROR_PACKAGES);
  if (config.transportMode === "closed") {
    expect(closedPayloadResponses).toHaveLength(mirrorPlan.assets.length);
    expect(closedPayloadResponses.every(({ status }) => status === 200)).toBe(
      true,
    );
  }
  await expect(page.getByRole("heading", { name: "Shell demo" })).toBeVisible({
    timeout: 60_000,
  });

  return {
    config,
    mirrorPlan,
    legacyArtifactDownloads,
    bootstrapPayloadRequests,
    bootstrapPayloadResponses,
    artifactTransportRequests,
  };
}

async function assertBootstrapStillDeferred(
  shell: ExactShellPage,
  rows: readonly LazyDownloadRow[],
): Promise<void> {
  expect(rows.filter(isHomebrewBootstrapRow)).toEqual([]);
  const responses = await Promise.all(shell.bootstrapPayloadResponses);
  if (shell.config.transportMode === "closed") {
    // WHY: closed acceptance verifies and snapshots the Vite-owned package
    // bytes during setup, but that preload must not materialize the guest tree.
    expect(shell.bootstrapPayloadRequests).toHaveLength(1);
    expect(responses).toEqual([
      expect.objectContaining({
        status: 200,
        sha256: shell.config.bootstrapSha256,
        bytes: Number(shell.config.bootstrapBytes),
      }),
    ]);
  } else {
    expect(shell.bootstrapPayloadRequests).toEqual([]);
    expect(responses).toEqual([]);
  }
}

async function assertBootstrapMaterialized(
  shell: ExactShellPage,
  row: LazyDownloadRow,
): Promise<void> {
  await expect
    .poll(() => shell.bootstrapPayloadRequests.length, {
      timeout: 180_000,
    })
    .toBe(1);
  expect(shell.bootstrapPayloadResponses).toHaveLength(1);
  expect(await Promise.all(shell.bootstrapPayloadResponses)).toEqual([
    expect.objectContaining({
      status: 200,
      sha256: shell.config.bootstrapSha256,
      bytes: Number(shell.config.bootstrapBytes),
    }),
  ]);
  expect(row).toEqual(
    expect.objectContaining({
      kind: "tree",
      status: "complete",
      loadedBytes: shell.config.bootstrapBytes,
      totalBytes: shell.config.bootstrapBytes,
    }),
  );
  expect(Number(row.eventCount)).toBeGreaterThanOrEqual(3);
}

function assertBottleLedger(
  rows: readonly LazyDownloadRow[],
  mirrorPlan: { assets: MirrorAsset[] },
): void {
  // The kernel worker's lazy-download ledger is the transport authority. Raw
  // browser request events are only diagnostic: service-worker delivery can
  // notify Playwright after the guest has consumed the verified response.
  const assetByUrl = new Map(
    mirrorPlan.assets.map((asset) => [asset.url, asset]),
  );
  for (const row of bottleRows(rows)) {
    const asset = row.source === null ? undefined : assetByUrl.get(row.source);
    expect(asset, `unplanned lazy row ${row.asset}`).toBeDefined();
    expect(row.asset).toBe(asset!.asset);
    expect(row.kind).toBe("tree");
    expect(row.status).toBe("complete");
    expect(row.loadedBytes).toBe(String(asset!.bytes));
    expect(row.totalBytes).toBe(String(asset!.bytes));
    expect(Number(row.eventCount)).toBeGreaterThanOrEqual(3);
  }
}

function assertPublicLazyTransport(
  shell: ExactShellPage,
  rows: readonly LazyDownloadRow[],
): void {
  if (shell.config.transportMode !== "public") return;
  for (const row of rows) {
    expect(row.source, `lazy row ${row.asset} has no source URL`).not.toBeNull();
    const sourceUrl = new URL(row.source!).href;
    const matches = shell.artifactTransportRequests.filter(
      ({ targetUrl }) => targetUrl === sourceUrl,
    );
    expect(
      matches.some(({ proxied }) => proxied),
      `lazy source bypassed the browser proxy: ${String(row.source)}`,
    ).toBe(true);
    expect(
      matches.filter(({ proxied }) => !proxied),
      `lazy source was also fetched directly: ${String(row.source)}`,
    ).toEqual([]);
  }
}

test("a fresh exact shell activates brew support atomically after independent base commands", async ({
  page,
}) => {
  test.skip(
    !strict,
    "exact Homebrew main-shell CI configures this acceptance test",
  );
  test.setTimeout(420_000);

  const shell = await bootExactShellPage(page);
  // WHY: this is an identity assertion about the interactive image-owned
  // shell, so executing it through the isolated child-Bash helper would make
  // `$0` report the helper's shell and could hide an incorrect default.
  await runParentShellProbe(
    page,
    'printf \'HOMEBREW_MAIN_SHELL_PATH:%s:%s\\n\' "$0" "${PATH%%:*}"',
    "HOMEBREW_MAIN_SHELL_PATH:bash:/home/linuxbrew/.linuxbrew/bin",
  );
  let lazyRows = await readLazyDownloadRows(page);
  expect(lazyRows).toEqual([]);
  await assertBootstrapStillDeferred(shell, lazyRows);

  const dashPriorSources = new Set(lazyRows.map(({ source }) => source));
  await runTerminalCommand(
    page,
    '/bin/sh -c \'test -z "${BASH_VERSION-}" && printf "HOMEBREW_DASH_OK\\n"\'',
    "HOMEBREW_DASH_OK",
  );
  lazyRows = await waitForLazyPackageRows(
    page,
    dashPriorSources,
    ["kandelo-dev/tap-core/dash"],
    shell.mirrorPlan,
  );
  expect(
    packageNamesForRows(
      lazyRows.filter(({ source }) => !dashPriorSources.has(source)),
      shell.mirrorPlan,
    ),
  ).toEqual(["kandelo-dev/tap-core/dash"]);

  const bzip2PriorSources = new Set(lazyRows.map(({ source }) => source));
  await runTerminalCommand(
    page,
    // Exercise the ordinary file workflow. The lazy-layer assertion belongs
    // to bzip2 itself and should not depend on terminal-device semantics.
    // The helper preserves ordinary Bash semantics, so each multi-step probe
    // opts into errexit rather than letting the final OK print mask a failure.
    "set -eu; printf 'mostly-lazy-shell\\n' > /tmp/kandelo-bzip2-smoke; " +
      "bzip2 -f /tmp/kandelo-bzip2-smoke; " +
      "bzip2 -d -f /tmp/kandelo-bzip2-smoke.bz2; " +
      "IFS= read -r bzip2_result < /tmp/kandelo-bzip2-smoke; " +
      'test "$bzip2_result" = mostly-lazy-shell; ' +
      "printf 'HOMEBREW_BZIP2_OK\\n'",
    "HOMEBREW_BZIP2_OK",
  );
  lazyRows = await waitForLazyPackageRows(
    page,
    bzip2PriorSources,
    ["kandelo-dev/tap-core/bzip2"],
    shell.mirrorPlan,
  );
  expect(
    packageNamesForRows(
      lazyRows.filter(({ source }) => !bzip2PriorSources.has(source)),
      shell.mirrorPlan,
    ),
  ).toEqual(["kandelo-dev/tap-core/bzip2"]);

  const m4PriorSources = new Set(lazyRows.map(({ source }) => source));
  await runTerminalCommand(
    page,
    'set -eu; test "$(printf mostly-lazy-shell | m4)" = mostly-lazy-shell; ' +
      "printf 'HOMEBREW_M4_OK\\n'",
    "HOMEBREW_M4_OK",
  );
  lazyRows = await waitForLazyPackageRows(
    page,
    m4PriorSources,
    ["kandelo-dev/tap-core/m4"],
    shell.mirrorPlan,
  );
  expect(
    packageNamesForRows(
      lazyRows.filter(({ source }) => !m4PriorSources.has(source)),
      shell.mirrorPlan,
    ),
  ).toEqual(["kandelo-dev/tap-core/m4"]);

  const repeatPriorSources = new Set(lazyRows.map(({ source }) => source));
  await runTerminalCommand(
    page,
    "set -eu; /bin/sh -c 'printf repeat-dash >/dev/null'; " +
      "printf repeat-bzip2 > /tmp/kandelo-repeat-bzip2; " +
      "bzip2 -f /tmp/kandelo-repeat-bzip2; " +
      "printf repeat-m4 | m4 >/dev/null; " +
      "printf 'HOMEBREW_BASE_REUSE_OK\\n'",
    "HOMEBREW_BASE_REUSE_OK",
  );
  lazyRows = await readLazyDownloadRows(page);
  expect(
    lazyRows.filter(({ source }) => !repeatPriorSources.has(source)),
  ).toEqual([]);

  const runtimeActivationPriorSources = new Set(
    lazyRows.map(({ source }) => source),
  );
  // WHY: admitted lazy base commands intentionally have public paths before
  // materialization. Probing one here could activate its bottle tree and
  // contaminate the exact atomic cohort checked below, so this phase resolves
  // only the runtime-support activation root and does not execute Homebrew.
  await runTerminalCommand(
    page,
    `
set -eu
IFS= read -r brew_shebang < /usr/bin/brew
test "$brew_shebang" = '#!/bin/bash -pu'
printf 'HOMEBREW_ATOMIC_RUNTIME_ACTIVATED\n'
`.trim(),
    "HOMEBREW_ATOMIC_RUNTIME_ACTIVATED",
    300_000,
  );
  lazyRows = await waitForLazyPackageRows(
    page,
    runtimeActivationPriorSources,
    RUNTIME_SUPPORT_EXPECTED_PACKAGES,
    shell.mirrorPlan,
    180_000,
  );
  expect(
    packageNamesForRows(
      lazyRows.filter(
        ({ source }) => !runtimeActivationPriorSources.has(source),
      ),
      shell.mirrorPlan,
    ),
  ).toEqual([...RUNTIME_SUPPORT_EXPECTED_PACKAGES].sort());
  const runtimeActivationResult = await waitForHomebrewBootstrapRow(page);
  lazyRows = runtimeActivationResult.rows;
  const runtimeActivationRows = lazyRows.filter(
    ({ source }) => !runtimeActivationPriorSources.has(source),
  );
  expect(
    packageNamesForRows(runtimeActivationRows, shell.mirrorPlan),
  ).toEqual([...RUNTIME_SUPPORT_EXPECTED_PACKAGES].sort());
  assertBottleLedger(runtimeActivationRows, shell.mirrorPlan);
  await assertBootstrapMaterialized(
    shell,
    runtimeActivationResult.bootstrap,
  );

  const brewOperationPriorRows = snapshotLazyRows(lazyRows);
  const brewOperationPriorSources = new Set(
    lazyRows.map(({ source }) => source),
  );
  // WHY: `brew ruby` is a developer command and may query Homebrew's developer
  // package API. A temporary ordinary command observes the post-brew.env
  // process environment while the lifecycle test separately proves installs.
  await runTerminalCommand(
    page,
    `
set -eu
test "$(/usr/bin/brew --prefix)" = /home/linuxbrew/.linuxbrew
probe=/home/linuxbrew/.linuxbrew/Library/Homebrew/cmd/kandelo-env-probe.sh
cat > "$probe" <<'KANDELO_BREW_ENV_PROBE'
homebrew-kandelo-env-probe() {
  printf '%s\n' "$HOMEBREW_KANDELO_BOTTLE_TAG"
}
KANDELO_BREW_ENV_PROBE
test "$(/usr/bin/brew kandelo-env-probe)" = wasm32_kandelo
rm -f "$probe"
printf 'HOMEBREW_OPERATIONAL_RUNTIME_OK\n'
`.trim(),
    "HOMEBREW_OPERATIONAL_RUNTIME_OK",
    300_000,
  );
  lazyRows = await waitForLazyPackageRows(
    page,
    brewOperationPriorSources,
    [],
    shell.mirrorPlan,
    180_000,
  );
  assertPriorLazyRowsUnchanged(brewOperationPriorRows, lazyRows);
  const operationalRuntimePackages = packageNamesForRows(
    lazyRows.filter(
      ({ source }) => !brewOperationPriorSources.has(source),
    ),
    shell.mirrorPlan,
  );
  assertMainShellOperationalRuntimeFetches(
    runtimeSupport,
    operationalRuntimePackages,
  );

  const repeatBrewPriorRows = snapshotLazyRows(lazyRows);
  const repeatBrewPriorSources = new Set(lazyRows.map(({ source }) => source));
  await runTerminalCommand(
    page,
    'test "$(/usr/bin/brew --prefix)" = /home/linuxbrew/.linuxbrew && ' +
      "printf 'HOMEBREW_RUNTIME_REUSE_OK\\n'",
    "HOMEBREW_RUNTIME_REUSE_OK",
    240_000,
  );
  lazyRows = await readLazyDownloadRows(page);
  assertPriorLazyRowsUnchanged(repeatBrewPriorRows, lazyRows);
  expect(
    lazyRows.filter(({ source }) => !repeatBrewPriorSources.has(source)),
  ).toEqual([]);
  const expectedFetchedPackages = [...new Set([
    ...BASE_EXPECTED_PACKAGES,
    ...RUNTIME_SUPPORT_EXPECTED_PACKAGES,
    ...operationalRuntimePackages,
  ])].sort();
  expect(packageNamesForRows(lazyRows, shell.mirrorPlan)).toEqual(
    expectedFetchedPackages,
  );
  // WHY: the complete mirror is the structural closure, while this smoke
  // deliberately exercises only a representative subset. Requiring untouched
  // packages proves the wider shell did not silently become eager again.
  expect(
    shell.mirrorPlan.assets.filter(
      ({ package: packageName }) =>
        !expectedFetchedPackages.includes(packageName),
    ).length,
  ).toBeGreaterThan(0);
  expect(lazyRows.filter(isHomebrewBootstrapRow)).toHaveLength(1);
  assertBottleLedger(lazyRows, shell.mirrorPlan);
  assertPublicLazyTransport(shell, lazyRows);
  expect(shell.legacyArtifactDownloads).toEqual([]);
});
