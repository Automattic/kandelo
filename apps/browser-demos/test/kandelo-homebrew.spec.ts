import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  KANDELO_SHELL_CONFIG_PATH,
} from "../../../web-libs/kandelo-session/src/shell-config";

const FIXTURE_BASE_PATH = "/__kandelo-homebrew-test";
const FIXTURE_ROOT = new URL("../public/__kandelo-homebrew-test/", import.meta.url);

type FixtureEntry = {
  id: string;
  title: string;
  browserCompatible: boolean;
};

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function gotoOrSkip(page: Page, path: string, allowMissingBinary = true) {
  await page.goto(appUrl(path), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  await handleViteOverlay(page, allowMissingBinary);
}

async function handleViteOverlay(page: Page, allowMissingBinary: boolean) {
  const overlay = page.locator("vite-error-overlay");
  if (!await overlay.count()) return;
  if (!allowMissingBinary) {
    const detail = await overlay.evaluate((element) =>
      element.shadowRoot?.querySelector(".message-body")?.textContent?.trim()
      || element.shadowRoot?.textContent?.trim()
      || element.textContent?.trim()
      || "unknown Vite import error"
    );
    throw new Error(`Published Homebrew browser smoke hit a Vite error overlay: ${detail}`);
  }
  test.skip(true, "Required binary not built - Vite import error");
}

async function openNewMachineLauncher(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launch New Machine" })).toBeVisible();
  await expect(galleryRowByTitle(page, /^Bare shell$/)).toBeVisible({
    timeout: 90_000,
  });
}

function galleryRowByTitle(page: Page, title: string | RegExp) {
  return page.locator(".kgal-row", {
    has: page.locator(".kgal-machine-title", { hasText: title }),
  });
}

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate((node) => node.textContent ?? "");
}

async function waitForTerminalContent(
  page: Page,
  expected: string | RegExp,
  timeout = 120_000,
) {
  const assertion = expect.poll(() => terminalText(page), { timeout });
  if (typeof expected === "string") {
    await assertion.toContain(expected);
  } else {
    await assertion.toMatch(expected);
  }
}

async function runTerminalCommand(
  page: Page,
  command: string,
  expected: string | RegExp,
  timeout = 120_000,
) {
  await page.locator(".kshell-host").first().click();
  const terminalInput = page.getByRole("textbox", { name: "Terminal input" }).first();
  if (await terminalInput.count()) {
    await terminalInput.focus();
  }
  await page.keyboard.insertText(command);
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForTerminalContent(page, expected, timeout);
}

async function writeHomebrewGalleryFixture(
  name: string,
  entries: FixtureEntry[],
): Promise<string> {
  const fixtureDir = new URL(`${name}/`, FIXTURE_ROOT);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(new URL("gallery.json", fixtureDir), JSON.stringify({
    source_id: "kandelo-homebrew",
    index_url: "index.toml",
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      description: "A sample package poured from a Homebrew bottle.",
      packages: [{ name: packageNameForEntry(entry), version: "2.12.3" }],
    })),
  }), "utf8");
  await writeFile(new URL("index.toml", fixtureDir), `abi_version = ${ABI_VERSION}

${entries.map((entry) => `[[packages]]
name = "${packageNameForEntry(entry)}"
version = "2.12.3"

[packages.binary.wasm32]
status = "success"
archive_url = "${FIXTURE_BASE_PATH}/${name}/${packageNameForEntry(entry)}.tar.zst"
archive_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
cache_key_sha = "1111111111111111111111111111111111111111111111111111111111111111"
browser_compatible = ${entry.browserCompatible ? "true" : "false"}
`).join("\n")}
`, "utf8");
  return `${FIXTURE_BASE_PATH}/${name}/gallery.json`;
}

function packageNameForEntry(entry: FixtureEntry): string {
  return `sample-homebrew-${entry.id}`;
}

async function writeHomebrewDefaultShellFixture(): Promise<string> {
  const rootfsPath = tryResolveBinary("rootfs.vfs")
    ?? tryResolveBinary("programs/rootfs.vfs");
  const dashPath = tryResolveBinary("programs/dash.wasm");
  if (!rootfsPath || !dashPath) {
    throw new Error("Homebrew default-shell smoke requires rootfs.vfs and dash.wasm");
  }

  const rootfsBytes = new Uint8Array(await readFile(rootfsPath));
  const dashBytes = new Uint8Array(await readFile(dashPath));
  const profile = await readFile(
    new URL("../../../images/rootfs/etc/profile", import.meta.url),
    "utf8",
  );
  const fs = MemoryFileSystem.fromImage(rootfsBytes);
  const shellPath = "/home/linuxbrew/.linuxbrew/bin/dash";
  ensureDirRecursive(fs, "/home/linuxbrew/.linuxbrew/bin");
  writeVfsBinary(fs, shellPath, dashBytes, 0o755);
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(fs, "/etc/profile", profile, 0o644);
  writeVfsFile(
    fs,
    "/etc/profile.d/kandelo-homebrew.sh",
    'PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"\nexport PATH\n',
    0o644,
  );
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(fs, KANDELO_SHELL_CONFIG_PATH, JSON.stringify({
    version: 1,
    path: shellPath,
    argv: ["dash", "-l", "-i"],
  }), 0o644);

  const fixtureDir = new URL("default-shell/", FIXTURE_ROOT);
  const fixtureName = "homebrew-default-shell.vfs";
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(new URL(fixtureName, fixtureDir), await fs.saveImage());
  return `${FIXTURE_BASE_PATH}/default-shell/${fixtureName}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseEvidenceAsset(
  repository: string,
  tag: string,
  asset: string,
): { asset: string; url: string; sha256: string; bytes: number } {
  const bytes = new TextEncoder().encode(asset);
  return {
    asset,
    url: `https://github.com/${repository}/releases/download/${tag}/${asset}`,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
}

test.afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test("strict Homebrew publisher smoke reads Vite shadow-root errors", async ({ page }) => {
  await page.setContent("<vite-error-overlay></vite-error-overlay>");
  await page.locator("vite-error-overlay").evaluate((element) => {
    const root = element.attachShadow({ mode: "open" });
    const message = document.createElement("span");
    message.className = "message-body";
    message.textContent = "missing ABI node.wasm";
    root.append(message);
  });
  await expect(handleViteOverlay(page, false)).rejects.toThrow(/missing ABI node\.wasm/);
});

test("software gallery hides wasm32 entries without browser-compatible metadata", async ({ page }) => {
  const manifestPath = await writeHomebrewGalleryFixture("nonbrowser", [
    { id: "sample-vfs", title: "Sample Homebrew VFS", browserCompatible: false },
    { id: "sample-sentinel", title: "Sample Browser Sentinel", browserCompatible: true },
  ]);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(manifestPath)}`);
  await openNewMachineLauncher(page);

  await expect(galleryRowByTitle(page, /^Sample Browser Sentinel$/)).toBeVisible({
    timeout: 90_000,
  });
  await expect(galleryRowByTitle(page, /^Sample Homebrew VFS$/)).toHaveCount(0);
});

test("browser-compatible gallery archive launch failures are visible", async ({ page }) => {
  const manifestPath = await writeHomebrewGalleryFixture("browser", [
    { id: "sample-vfs", title: "Sample Homebrew VFS", browserCompatible: true },
  ]);
  await gotoOrSkip(page, `/?softwareManifest=${encodeURIComponent(manifestPath)}`);
  await openNewMachineLauncher(page);

  const row = galleryRowByTitle(page, /^Sample Homebrew VFS$/);
  await expect(row).toBeVisible({ timeout: 90_000 });
  await row.getByRole("button", { name: "Launch" }).click();

  await expect(page.getByText("Failed to boot Sample Homebrew VFS")).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/404|artifact|archive/i).first()).toBeVisible();
  await expect(page.getByText(/third-party gallery entry/i)).toBeVisible();
});

test("Homebrew file-formula VFS image boots in browser and runs file --version", async ({ page }) => {
  const vfsUrl = process.env.KANDELO_BROWSER_FILE_FORMULA_VFS_URL;
  if (!vfsUrl && process.env.KANDELO_HOMEBREW_STRICT_PUBLISHER_SMOKE === "1") {
    throw new Error("KANDELO_BROWSER_FILE_FORMULA_VFS_URL is required for the strict publisher smoke");
  }
  test.skip(
    !vfsUrl,
    "KANDELO_BROWSER_FILE_FORMULA_VFS_URL is required for the published Homebrew file-formula smoke",
  );
  test.setTimeout(360_000);

  await gotoOrSkip(page, `/?vfs=${encodeURIComponent(vfsUrl!)}`, false);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 240_000);

  await runTerminalCommand(
    page,
    "/home/linuxbrew/.linuxbrew/bin/file --version",
    /^file(?:\.wasm)?-5\.45$/m,
    180_000,
  );
});

test("an image-owned Homebrew shell boots without legacy shell downloads", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const configuredVfsUrl = process.env.KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL;
  const configuredShellPath = process.env.KANDELO_HOMEBREW_DEFAULT_SHELL_PATH;
  const configuredShellArgv0 = process.env.KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0;
  const configured = [
    configuredVfsUrl,
    configuredShellPath,
    configuredShellArgv0,
  ].some((value) => value !== undefined);
  if (configured && (!configuredVfsUrl || !configuredShellPath || !configuredShellArgv0)) {
    throw new Error(
      "KANDELO_HOMEBREW_DEFAULT_SHELL_VFS_URL, " +
      "KANDELO_HOMEBREW_DEFAULT_SHELL_PATH, and " +
      "KANDELO_HOMEBREW_DEFAULT_SHELL_ARGV0 must be configured together",
    );
  }
  const shellPath = configuredShellPath ?? "/home/linuxbrew/.linuxbrew/bin/dash";
  const shellArgv0 = configuredShellArgv0 ?? "dash";
  const fixturePath = configuredVfsUrl ? undefined : await writeHomebrewDefaultShellFixture();
  const vfsUrl = configuredVfsUrl ?? new URL(fixturePath!, baseURL).href;
  const legacyShellFetches: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      request.resourceType() === "fetch"
      && /\/(?:bash|dash)\.wasm(?:\?|$)/.test(url)
      && !url.includes("?import&url")
    ) {
      legacyShellFetches.push(url);
    }
  });

  await gotoOrSkip(page, `/?vfs=${encodeURIComponent(vfsUrl)}`, false);
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 180_000);
  await runTerminalCommand(
    page,
    "printf 'HOMEBREW_DEFAULT_SHELL:%s:%s:%s\\n' \"$0\" \"$(command -v \"$0\")\" \"${PATH%%:*}\"",
    `HOMEBREW_DEFAULT_SHELL:${shellArgv0}:${shellPath}:/home/linuxbrew/.linuxbrew/bin`,
    120_000,
  );

  expect(legacyShellFetches).toEqual([]);
});

test("Homebrew release mounts do not inherit colliding built-in profile policy", async ({
  page,
}) => {
  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });

  const profiles = await page.evaluate(async (abiVersion) => {
    const { profileForDescriptor } = await import(
      "/pages/kandelo/kernel-host/live-setup.ts"
    );
    const imageUrl =
      "https://github.com/Example/homebrew-tools/releases/download/" +
      `homebrew-vfs-sha256-${"a".repeat(64)}/kandelo-homebrew.vfs.zst`;
    const descriptorUrl = imageUrl.replace(
      "kandelo-homebrew.vfs.zst",
      "kandelo-homebrew-vfs.json",
    );
    return ["shell", "wordpress-sqlite"].map((id) => {
      const profile = profileForDescriptor({
        version: 1,
        id,
        title: "Known-ID Homebrew shell",
        base: `kandelo:shell@abi${abiVersion}`,
        runtime: {
          arch: "wasm32",
          kernel: "kernel@local",
          memoryPages: 2048,
          features: ["shared-array-buffer", "pty"],
          time: "real",
        },
        packages: [],
        mounts: [{
          path: "/",
          source: "image",
          ref: imageUrl,
          resolver: {
            kind: "homebrew-vfs-release",
            descriptorUrl,
            requireDefaultShell: true,
          },
          integrity: {
            algorithm: "sha256",
            digest: "a".repeat(64),
            bytes: 4096,
          },
          readonly: false,
        }],
        boot: {
          argv: ["dash", "-l", "-i"],
          cwd: "/home/user",
          env: { HOME: "/home/user" },
          uid: 1000,
          gid: 1000,
        },
      }, "none", {
        path: "/home/linuxbrew/.linuxbrew/bin/dash",
        argv: ["dash", "-l", "-i"],
      });
      return {
        requestedId: id,
        profileId: profile.id,
        vfsUrl: profile.vfsUrl,
        hasBuiltInVfsSource: Object.hasOwn(profile, "vfsSource"),
        hasBuiltInInit: Object.hasOwn(profile, "init"),
        expectedImageShell: profile.expectedImageShell,
      };
    });
  }, ABI_VERSION);

  for (const profile of profiles) {
    expect(profile.profileId).toBe(profile.requestedId);
    expect(profile.vfsUrl).toContain("/Example/homebrew-tools/releases/download/");
    expect(profile.hasBuiltInVfsSource).toBe(false);
    expect(profile.hasBuiltInInit).toBe(false);
    expect(profile.expectedImageShell).toEqual({
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    });
  }
});

test("an immutable Homebrew release boots its exact shell and rejects shell drift", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await writeHomebrewDefaultShellFixture();
  const imageBytes = new Uint8Array(await readFile(
    new URL("default-shell/homebrew-default-shell.vfs", FIXTURE_ROOT),
  ));
  const imageSha256 = sha256(imageBytes);
  const repository = "Example/homebrew-tools";
  const tag = `homebrew-vfs-sha256-${imageSha256}`;
  const releaseBase = `https://github.com/${repository}/releases/download/${tag}`;
  const descriptorUrl = `${releaseBase}/kandelo-homebrew-vfs.json`;
  const imageUrl = `${releaseBase}/kandelo-homebrew.vfs.zst`;
  const descriptor = {
    schema: 1,
    kind: "kandelo-homebrew-vfs",
    formula: "file-formula",
    arch: "wasm32",
    tap: {
      repository,
      name: "example/tools",
      commit: "1111111111111111111111111111111111111111",
    },
    kandelo: {
      repository: "Automattic/kandelo",
      commit: "2222222222222222222222222222222222222222",
      abi: ABI_VERSION,
    },
    bottle_release_tag: `bottles-abi-v${ABI_VERSION}`,
    selection: {
      requested_packages: ["dash", "file-formula"],
      dependency_edges: [{
        from: "example/tools/file-formula",
        to: "example/tools/dash",
        version: "0.5.12",
      }],
    },
    acceptance: {
      node: "success",
      browser: "chromium",
      executable: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-c", "printf accepted"],
    },
    release: { repository, tag },
    image: {
      asset: "kandelo-homebrew.vfs.zst",
      url: imageUrl,
      sha256: imageSha256,
      bytes: imageBytes.byteLength,
      kernel_abi: ABI_VERSION,
    },
    evidence: {
      report: releaseEvidenceAsset(repository, tag, "kandelo-homebrew-vfs-report.json"),
      node: releaseEvidenceAsset(repository, tag, "kandelo-homebrew-node-evidence.json"),
      browser: releaseEvidenceAsset(repository, tag, "kandelo-homebrew-browser-evidence.json"),
    },
    launch: { query_parameter: "vfs", value: imageUrl },
    default_shell: {
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    },
  };
  await page.route(descriptorUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(descriptor),
    });
  });
  await page.route(imageUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from(imageBytes),
    });
  });
  // Once the page is cross-origin isolated, its service worker deliberately
  // sends external artifacts through the configured CORS proxy. Intercept the
  // service worker's outbound request as well as the direct pre-control form.
  await page.context().route(
    (url) =>
      url.pathname === "/__kandelo_cors_proxy" &&
      [descriptorUrl, imageUrl].includes(url.searchParams.get("url") ?? ""),
    async (route) => {
      const target = new URL(route.request().url()).searchParams.get("url");
      await route.fulfill({
        status: 200,
        contentType: target === descriptorUrl
          ? "application/json"
          : "application/octet-stream",
        body: target === descriptorUrl
          ? JSON.stringify(descriptor)
          : Buffer.from(imageBytes),
      });
    },
  );
  const legacyShellFetches: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      request.resourceType() === "fetch" &&
      /\/(?:bash|dash)\.wasm(?:\?|$)/.test(url) &&
      !url.includes("?import&url")
    ) {
      legacyShellFetches.push(url);
    }
  });

  await gotoOrSkip(
    page,
    `/?homebrewVfs=${encodeURIComponent(descriptorUrl)}`,
    false,
  );
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await waitForTerminalContent(page, /kandelo\$\s*$/, 180_000);
  await runTerminalCommand(
    page,
    "printf 'IMMUTABLE_HOMEBREW:%s:%s\\n' \"$0\" \"${PATH%%:*}\"",
    "IMMUTABLE_HOMEBREW:dash:/home/linuxbrew/.linuxbrew/bin",
  );
  expect(legacyShellFetches).toEqual([]);

  descriptor.default_shell.argv = ["dash", "-i"];
  legacyShellFetches.length = 0;
  await gotoOrSkip(
    page,
    `/?homebrewVfs=${encodeURIComponent(descriptorUrl)}`,
    false,
  );
  await expect(page.locator("main")).toContainText(
    `${KANDELO_SHELL_CONFIG_PATH} does not match its immutable release descriptor`,
    { timeout: 30_000 },
  );
  expect(legacyShellFetches).toEqual([]);
});
