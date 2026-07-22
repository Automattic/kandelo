import { expect, test, type Page } from "@playwright/test";

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

test("the exact public-bottle shell preserves shell, NetHack, and modeset behavior", async ({ page }) => {
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
  const publicBottleRequests: string[] = [];
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
  page.context().on("request", (request) => {
    const url = request.url();
    if (
      /\/releases\/download\/homebrew-shell-bottles-sha256-[0-9a-f]{64}\//
        .test(new URL(url).pathname) && url.endsWith("-layer.bin")
    ) {
      publicBottleRequests.push(url);
    }
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
  if (transportMode === "closed") {
    expect(closedPayloadResponses).toHaveLength(35);
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
      "git-remote-ftps nano vim nethack fbdoom modeset; " +
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
  if (transportMode === "closed") {
    expect(publicBottleRequests).toEqual([]);
  }

  const mirrorPlan = await page.evaluate(async (url) => {
    const response = await fetch(
      url,
      { cache: "no-store", credentials: "omit", redirect: "error" },
    );
    if (!response.ok) throw new Error(`mirror plan fetch failed: HTTP ${response.status}`);
    return response.json() as Promise<{ assets: MirrorAsset[] }>;
  }, mirrorPlanUrl);
  const expectedPackages = [
    "kandelo-dev/tap-core/dash",
    "kandelo-dev/tap-core/git",
    "kandelo-dev/tap-core/nethack",
  ];
  const expectedAssets = mirrorPlan.assets.filter((asset) =>
    expectedPackages.includes(asset.package)
  );
  expect(mirrorPlan.assets).toHaveLength(35);
  expect(expectedAssets.map((asset) => asset.package).sort()).toEqual(
    [...expectedPackages].sort(),
  );
  expect(mirrorPlan.assets.length - expectedAssets.length).toBe(32);
  if (transportMode === "public") {
    expect([...publicBottleRequests].sort()).toEqual(
      expectedAssets.map((asset) => asset.url).sort(),
    );
  }

  await page.getByRole("button", { name: "Internals" }).click();
  await page.getByRole("tab", { name: "Lazy Load" }).click();
  const downloadRows = page.locator(".kdownload-table tbody tr");
  await expect(downloadRows).toHaveCount(3);
  for (const asset of expectedAssets) {
    const row = downloadRows.filter({
      has: page.locator(".kdownload-asset-name", { hasText: asset.asset }),
    });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-download-kind", "tree");
    await expect(row).toHaveAttribute("data-download-status", "complete");
    await expect(row).toHaveAttribute("data-loaded-bytes", String(asset.bytes));
    await expect(row).toHaveAttribute("data-total-bytes", String(asset.bytes));
    await expect(row).toHaveAttribute("data-source", asset.url);
    const eventCount = Number(await row.getAttribute("data-download-events"));
    expect(eventCount).toBeGreaterThanOrEqual(3);
  }

  await page.goto("/?demo=modeset", { waitUntil: "domcontentloaded" });
  const modesetControls = page
    .locator(".kdemo-surface-controls")
    .filter({ has: page.locator(".kdemo-surface-title", { hasText: /MODESET/ }) })
    .first();
  await expect(modesetControls).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(() => modesetControls.innerText(), { timeout: 180_000 })
    .toMatch(/[1-9]\d*\s+flips/i);
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => (await canvas.screenshot()).byteLength,
      { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBeGreaterThan(5_000);

  await page.waitForFunction(() => {
    const evidence = (window as typeof window & {
      __kandeloHomebrewMainShellImageEvidence?: {
        digests: string[];
        errors: string[];
      };
    }).__kandeloHomebrewMainShellImageEvidence;
    return Boolean(evidence && (evidence.digests.length > 0 || evidence.errors.length > 0));
  }, undefined, { timeout: 180_000 });
  const modesetImageEvidence = await page.evaluate(() =>
    (window as typeof window & {
      __kandeloHomebrewMainShellImageEvidence: {
        digests: string[];
        errors: string[];
      };
    }).__kandeloHomebrewMainShellImageEvidence
  );
  expect(modesetImageEvidence.errors).toEqual([]);
  expect(new Set(modesetImageEvidence.digests)).toEqual(new Set([expectedImageSha256]));

  expect(legacyArtifactDownloads).toEqual([]);
});
