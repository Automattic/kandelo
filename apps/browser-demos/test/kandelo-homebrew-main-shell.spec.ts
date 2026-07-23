import { expect, test, type Page } from "@playwright/test";
import { MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS } from "../../../scripts/homebrew-language-runtime-contract";

const strict = process.env.KANDELO_HOMEBREW_MAIN_SHELL_STRICT === "1";
const expectedImageSha256 = process.env.KANDELO_HOMEBREW_MAIN_SHELL_SHA256;
const closedMirrorRoot =
  process.env.VITE_KANDELO_HOMEBREW_CLOSED_ACCEPTANCE_ROOT;
const transportMode = process.env.KANDELO_HOMEBREW_MAIN_SHELL_TRANSPORT_MODE;
const mirrorPlanUrl = process.env.KANDELO_HOMEBREW_MAIN_SHELL_MIRROR_PLAN_URL;

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

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
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
    const matched = typeof expected === "string"
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
  const rows = await page.locator(".kdownload-table tbody tr").evaluateAll((elements) =>
    elements.map((element) => ({
      status: element.getAttribute("data-download-status"),
      source: element.getAttribute("data-source"),
      text: element.textContent?.replace(/\s+/g, " ").trim(),
    }))
  );
  return JSON.stringify(rows);
}

async function runTerminalCommand(
  page: Page,
  command: string,
  expected: string | RegExp,
  timeout = 180_000,
) {
  const input = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await input.count()) {
    await input.focus();
  } else {
    await page.locator(".kshell-host").first().click();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

async function readLazyDownloadRows(page: Page): Promise<LazyDownloadRow[]> {
  const internals = page.getByRole("button", { name: "Internals" });
  if (await internals.getAttribute("aria-pressed") !== "true") {
    await internals.click();
  }
  await page.getByRole("tab", { name: "Lazy Load" }).click();
  const rows = await page.locator(".kdownload-table tbody tr").evaluateAll((elements) =>
    elements.map((element) => ({
      asset: element.querySelector(".kdownload-asset-name")?.textContent?.trim() ?? "",
      status: element.getAttribute("data-download-status"),
      kind: element.getAttribute("data-download-kind"),
      source: element.getAttribute("data-source"),
      loadedBytes: element.getAttribute("data-loaded-bytes"),
      totalBytes: element.getAttribute("data-total-bytes"),
      eventCount: element.getAttribute("data-download-events"),
    }))
  );
  await internals.click();
  return rows;
}

function packageNamesForRows(
  rows: readonly LazyDownloadRow[],
  mirrorPlan: { assets: MirrorAsset[] },
): string[] {
  const packageByUrl = new Map(mirrorPlan.assets.map((asset) => [asset.url, asset.package]));
  return rows.map((row) => {
    const packageName = row.source === null ? undefined : packageByUrl.get(row.source);
    if (packageName === undefined) {
      throw new Error(`lazy row source is absent from the mirror plan: ${String(row.source)}`);
    }
    return packageName;
  }).sort();
}

async function waitForLazyPackageRows(
  page: Page,
  priorSources: ReadonlySet<string | null>,
  expectedPackages: readonly string[],
  mirrorPlan: { assets: MirrorAsset[] },
): Promise<LazyDownloadRow[]> {
  const deadline = Date.now() + 30_000;
  const settleWindowMs = 1_000;
  let rows: LazyDownloadRow[] = [];
  let stableCompleteFingerprint: string | undefined;
  let stableCompleteSince = 0;
  while (Date.now() < deadline) {
    rows = await readLazyDownloadRows(page);
    const added = rows.filter(({ source }) => !priorSources.has(source));
    const addedPackages = new Set(packageNamesForRows(added, mirrorPlan));
    const expectedPackagesPresent = expectedPackages.every((packageName) =>
      addedPackages.has(packageName)
    );
    const addedRowsComplete = added.every(({ status }) => status === "complete");
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

test("the exact public-bottle shell preserves shell, language, and NetHack behavior", async ({ page }) => {
  test.skip(!strict, "exact Homebrew main-shell CI configures this acceptance test");
  if (!expectedImageSha256 || !/^[0-9a-f]{64}$/.test(expectedImageSha256)) {
    throw new Error(
      "KANDELO_HOMEBREW_MAIN_SHELL_SHA256 must be the exact lowercase image digest",
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
    throw new Error("main-shell transport mode has inconsistent mirror configuration");
  }
  test.setTimeout(420_000);

  const legacyArtifactDownloads: string[] = [];
  const closedPayloadResponses: Array<{ url: string; status: number }> = [];
  await page.addInitScript(() => {
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
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (/shell[^/]*\.vfs\.zst(?:\?|$)/.test(response.url)) {
        void response.clone().arrayBuffer()
          .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
          .then((digest) => {
            evidence.digests.push(
              Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
                .join(""),
            );
          })
          .catch((error: unknown) => {
            evidence.errors.push(error instanceof Error ? error.message : String(error));
          });
      }
      return response;
    };
  });
  page.on("request", (request) => {
    const url = request.url();
    if (
      request.resourceType() === "fetch" &&
      (
        (/\.(?:wasm|zip)(?:\?|$)/.test(url) &&
          !/kernel[^/]*\.wasm(?:\?|$)/.test(url)) ||
        (/\.vfs(?:\.zst)?(?:\?|$)/.test(url) &&
          !/shell[^/]*\.vfs\.zst(?:\?|$)/.test(url))
      )
    ) {
      legacyArtifactDownloads.push(url);
    }
  });
  page.on("response", (response) => {
    if (!closedMirrorRoot) return;
    const url = new URL(response.url());
    if (
      url.pathname.startsWith(`${closedMirrorRoot}/`) &&
      url.pathname.endsWith("-layer.bin")
    ) {
      closedPayloadResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto("/?demo=shell", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  const overlay = page.locator("vite-error-overlay");
  if (await overlay.count()) {
    const detail = await overlay.evaluate((element) =>
      element.shadowRoot?.querySelector(".message-body")?.textContent?.trim()
      || element.shadowRoot?.textContent?.trim()
      || element.textContent?.trim()
      || "unknown Vite import error"
    );
    throw new Error(`Homebrew main-shell smoke hit a Vite error overlay: ${detail}`);
  }

  await page.waitForFunction(() => {
    const evidence = (window as typeof window & {
      __kandeloHomebrewMainShellImageEvidence?: {
        digests: string[];
        errors: string[];
      };
    }).__kandeloHomebrewMainShellImageEvidence;
    return Boolean(evidence && (evidence.digests.length > 0 || evidence.errors.length > 0));
  }, undefined, { timeout: 180_000 });
  const imageEvidence = await page.evaluate(() =>
    (window as typeof window & {
      __kandeloHomebrewMainShellImageEvidence: {
        digests: string[];
        errors: string[];
      };
    }).__kandeloHomebrewMainShellImageEvidence
  );
  expect(imageEvidence.errors).toEqual([]);
  expect(new Set(imageEvidence.digests)).toEqual(new Set([expectedImageSha256]));

  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 180_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 240_000);
  const mirrorPlan = await page.evaluate(async (url) => {
    const response = await fetch(
      url,
      { cache: "no-store", credentials: "omit", redirect: "error" },
    );
    if (!response.ok) throw new Error(`mirror plan fetch failed: HTTP ${response.status}`);
    return response.json() as Promise<{ assets: MirrorAsset[] }>;
  }, mirrorPlanUrl);
  expect(mirrorPlan.assets.length).toBeGreaterThan(0);
  if (transportMode === "closed") {
    expect(closedPayloadResponses).toHaveLength(mirrorPlan.assets.length);
    expect(closedPayloadResponses.every(({ status }) => status === 200)).toBe(true);
  }
  await expect(page.getByRole("heading", { name: "Shell demo" })).toBeVisible({
    timeout: 60_000,
  });
  await runTerminalCommand(
    page,
    "printf 'HOMEBREW_MAIN_SHELL_PATH:%s:%s\\n' \"$0\" \"${PATH%%:*}\"",
    "HOMEBREW_MAIN_SHELL_PATH:bash:/home/linuxbrew/.linuxbrew/bin",
  );
  await runTerminalCommand(
    page,
    "/bin/sh -c 'set -e; " +
      "for cmd in sh bash dash tput cat awk gawk grep egrep fgrep sed bc file m4 make find diff " +
      "ed more ex less tar curl nc wget git gzip bzip2 xz zstd zip unzip lsof " +
      "bunzip2 bzcat netcat git-remote-http git-remote-https git-remote-ftp " +
      "git-remote-ftps nano vim nethack fbdoom modeset " +
      "python python3 python3.13 perl erl ruby gem bundle bundler; " +
      "do command -v \"$cmd\" >/dev/null; done; " +
      "test \"$(git config --get user.name)\" = User; " +
      "printf \"HOMEBREW_MAIN_SHELL_OK:%s\\n\" \"$(git --version)\"'",
    "HOMEBREW_MAIN_SHELL_OK:git version 2.47.1",
    240_000,
  );
  await runTerminalCommand(
    page,
    "/bin/bash -c 'set -e; " +
      ": > /home/.nethack/record; " +
      "if ! nethack_output=$(nethack -s all 2>&1); then " +
      "printf \"%s\\n\" \"$nethack_output\" >&2; exit 1; fi; " +
      "case \"$nethack_output\" in *\"Cannot open record file\"*) " +
      "printf \"%s\\n\" \"$nethack_output\" >&2; exit 1;; esac; " +
      "printf \"HOMEBREW_NETHACK_STATE_OK\\n\"'",
    "HOMEBREW_NETHACK_STATE_OK",
    180_000,
  );
  const basePackages = [
    "kandelo-dev/tap-core/dash",
    "kandelo-dev/tap-core/git",
    "kandelo-dev/tap-core/nethack",
  ];
  expect(mirrorPlan.assets).toHaveLength(39);
  let lazyRows = await waitForLazyPackageRows(
    page,
    new Set(),
    basePackages,
    mirrorPlan,
  );
  expect(packageNamesForRows(lazyRows, mirrorPlan)).toEqual([...basePackages].sort());

  for (const invocation of MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS) {
    const priorSources = new Set(lazyRows.map(({ source }) => source));
    await runTerminalCommand(
      page,
      invocation.terminalCommand,
      invocation.expectedStdout.trim(),
      240_000,
    );
    const nextRows = await waitForLazyPackageRows(
      page,
      priorSources,
      [invocation.packageName],
      mirrorPlan,
    );
    const newRows = nextRows.filter(({ source }) => !priorSources.has(source));
    const fetchedPackages = packageNamesForRows(newRows, mirrorPlan);
    expect(fetchedPackages).toContain(invocation.packageName);
    const allowedPackages = new Set([
      invocation.packageName,
      ...invocation.dependencyPackages,
    ]);
    expect(fetchedPackages.every((name) => allowedPackages.has(name))).toBe(true);
    const otherLanguages = fetchedPackages.filter((name) =>
      name !== invocation.packageName &&
      MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.some(
        (candidate) => candidate.packageName === name,
      )
    );
    expect(otherLanguages).toEqual([]);
    lazyRows = nextRows;
  }

  const requiredPackages = [
    ...basePackages,
    ...MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.map(({ packageName }) => packageName),
  ];
  const fetchedPackages = packageNamesForRows(lazyRows, mirrorPlan);
  for (const packageName of requiredPackages) {
    expect(fetchedPackages).toContain(packageName);
  }
  const allowedPackages = new Set([
    ...requiredPackages,
    ...MAIN_SHELL_LANGUAGE_RUNTIME_INVOCATIONS.flatMap(
      ({ dependencyPackages }) => dependencyPackages,
    ),
  ]);
  expect(fetchedPackages.every((name) => allowedPackages.has(name))).toBe(true);
  expect(mirrorPlan.assets.length - lazyRows.length).toBeGreaterThan(0);

  // The kernel worker's lazy-download ledger is the transport authority. Raw
  // browser request events are only diagnostic: service-worker delivery can
  // notify Playwright after the guest has consumed the verified response.
  const assetByUrl = new Map(mirrorPlan.assets.map((asset) => [asset.url, asset]));
  for (const row of lazyRows) {
    const asset = row.source === null ? undefined : assetByUrl.get(row.source);
    expect(asset, `unplanned lazy row ${row.asset}`).toBeDefined();
    expect(row.asset).toBe(asset!.asset);
    expect(row.kind).toBe("tree");
    expect(row.status).toBe("complete");
    expect(row.loadedBytes).toBe(String(asset!.bytes));
    expect(row.totalBytes).toBe(String(asset!.bytes));
    expect(Number(row.eventCount)).toBeGreaterThanOrEqual(3);
  }

  expect(legacyArtifactDownloads).toEqual([]);
});
