import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const imageModulePath = [
  resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm"),
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm"),
].find((path) => existsSync(path) && WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0) ?? null;
const fixturePath = resolve(repoRoot, "local-binaries/test-fixtures/wasm32/persistence-boot-counter.wasm");
const programPath = existsSync(fixturePath) ? fixturePath : null;
const fullBrowserProductsReady = [
  "programs/wasm32/bash.wasm",
  "programs/wasm32/shell.vfs.zst",
].every((path) => {
  try {
    return tryResolveBinary(path) !== null;
  } catch {
    return false;
  }
});

test.skip(imageModulePath === null || programPath === null, "image writer and boot-counter fixture are required");
test.skip(!fullBrowserProductsReady, "complete browser package artifacts are required");

async function probeImage(withHeadroom = true): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  if (withHeadroom) filesystem.setImageCapacity(64 * 1024 * 1024);
  filesystem.mkdir("/etc", 0o755);
  filesystem.mkdir("/etc/kandelo", 0o755);
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode("0"), 0o644);
  filesystem.writeFile("/bin/persistence-boot-counter", new Uint8Array(readFileSync(programPath!)), 0o755);
  filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify({
    version: 1,
    defaultProfile: "probe",
    profiles: { probe: { identity: { title: "Persistence probe", summary: "Real page reboot test", accent: "#123456", glyph: "sh" } } },
  })), 0o644);
  filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify({
    kind: "kandelo-experimental-terminal-session",
    version: 1,
    initial: { path: "/bin/persistence-boot-counter", argv: ["persistence-boot-counter"], uid: 0, gid: 0 },
  })), 0o644);
  return filesystem.saveImage();
}

async function terminalText(page: Page): Promise<string> {
  return (await page.locator(".xterm-rows").allInnerTexts()).join("\n");
}

async function expectBootCount(page: Page, count: number, errors: string[], timeout = 120_000): Promise<void> {
  try {
    await expect.poll(async () => {
      if (errors.length > 0) throw new Error(errors.join("\n"));
      const viteError = page.locator("vite-error-overlay");
      if (await viteError.count()) {
        throw new Error(`Vite rejected the page: ${await viteError.first().innerText()}`);
      }
      const failure = await page.locator('.kdock-status-text[data-status="error"]').count();
      if (failure > 0) {
        const lines = await page.locator(".ksys-line").allInnerTexts();
        throw new Error(`machine boot failed:\n${lines.join("\n")}`);
      }
      return terminalText(page);
    }, { timeout }).toContain(`PERSISTENCE_BOOT_${count}`);
  } catch (error) {
    await page.getByRole("button", { name: "Internals" }).click().catch(() => {});
    const lines = await page.locator(".ksys-line").allInnerTexts();
    const status = await page.locator(".kdock-status-text").allInnerTexts();
    throw new Error(`${String(error)}\nstatus: ${status.join(" | ")}\nboot log:\n${lines.join("\n")}`);
  }
}

const sourceCases = (["raw", "zstd"] as const).flatMap((sourceEncoding) =>
  [true, false].map((withHeadroom) => ({ sourceEncoding, withHeadroom })));

for (const { sourceEncoding, withHeadroom } of sourceCases) {
  test(`Kandelo page restores a guest-written computer after reload from ${sourceEncoding}${withHeadroom ? "" : " with a fully sized filesystem body"}`, async ({ playwright, browserName, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const image = await probeImage(withHeadroom);
    if (!withHeadroom) {
      expect(image.byteLength).toBeGreaterThan(KandeloImageFs.readImageCapacity(image).maxByteLength);
    }
    const fixtureDirectory = resolve(repoRoot, ".context");
    mkdirSync(fixtureDirectory, { recursive: true });
    const imagePath = resolve(fixtureDirectory, `persistence-page-probe-${crypto.randomUUID()}.vfs${sourceEncoding === "zstd" ? ".zst" : ""}`);
    writeFileSync(imagePath, sourceEncoding === "zstd" ? zstdCompressSync(Buffer.from(image)) : image);
    const sourceUrl = new URL(`/@fs/${imagePath}`, baseURL).href;
    const pageUrl = new URL("/", baseURL);
    pageUrl.searchParams.set("vfs", sourceUrl);
    pageUrl.searchParams.set("experimentalPersistence", `page-${crypto.randomUUID()}`);
    const projectUse = testInfo.project.use as {
      channel?: string;
      launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      extraHTTPHeaders?: Record<string, string>;
    };
    const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-persistence-page-"));
    try {
      const context = await playwright[browserName].launchPersistentContext(userDataDir, {
        channel: projectUse.channel,
        proxy: projectUse.proxy as never,
        extraHTTPHeaders: projectUse.extraHTTPHeaders,
        ...(projectUse.launchOptions ?? {}),
      });
      try {
        await context.addInitScript(() => { window.confirm = () => true; });
        const page = context.pages()[0] ?? await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
        await expectBootCount(page, 1, pageErrors);
        rmSync(imagePath);
        await page.addInitScript(() => {
          const original = File.prototype.arrayBuffer;
          File.prototype.arrayBuffer = function () {
            if (this.name.endsWith(".base")) {
              throw new Error("restored OPFS image was loaded as one ArrayBuffer");
            }
            return original.call(this);
          };
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectBootCount(page, 2, pageErrors);

        const competitor = await context.newPage();
        await competitor.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
        await expect(competitor.locator('.kdock-status-text[data-status="error"]')).toBeAttached({ timeout: 60_000 });
        await expect(competitor.locator(".ksys-line").last()).toContainText("already running in another tab");
        await competitor.close();
      } finally {
        await context.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(imagePath, { force: true });
    }
  });
}

test("Kandelo page installs and restores a physical >4 GiB v2 computer", async ({ playwright, browserName, baseURL }, testInfo) => {
  const fixturePath = process.env.KANDELO_LARGE_PAGE_VFSI_FIXTURE;
  test.skip(!fixturePath, "requires the opt-in page-enabled physical large-image fixture");
  test.setTimeout(1_200_000);
  const fixtureLength = statSync(fixturePath!).size;
  expect(fixtureLength).toBeGreaterThan(2 ** 32);
  let sourceAvailable = true;
  let sourceRequests = 0;
  const sourceUrl = new URL(`/@fs/${resolve(fixturePath!)}`, baseURL).href;
  const pageUrl = new URL("/", baseURL);
  pageUrl.searchParams.set("vfs", sourceUrl);
  pageUrl.searchParams.set("profile", "probe");
  pageUrl.searchParams.set("experimentalPersistence", `large-page-${crypto.randomUUID()}`);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-large-persistence-page-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      await context.addInitScript(() => {
        window.confirm = () => true;
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
          if (this.size > 64 * 1024 * 1024) {
            throw new Error("large OPFS image was loaded as one ArrayBuffer");
          }
          return original.call(this);
        };
      });
      const page = context.pages()[0] ?? await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route(sourceUrl, (route) => {
        sourceRequests += 1;
        return sourceAvailable ? route.continue() : route.abort();
      });
      const sourceResponse = page.waitForResponse(sourceUrl);
      await test.step("install, verify, and boot the large source", async () => {
        await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
        await expectBootCount(page, 1, pageErrors, 900_000);
        const response = await sourceResponse;
        expect(response.status()).toBe(200);
        expect(Number(response.headers()["content-length"])).toBe(fixtureLength);
      });
      const installedRequests = sourceRequests;
      sourceAvailable = false;
      await test.step("restore the saved computer with its source blocked", async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectBootCount(page, 2, pageErrors, 240_000);
        expect(sourceRequests).toBe(installedRequests);
      });
      await page.screenshot({ path: resolve(repoRoot, ".context", `persistent-large-page-${browserName}.png`) });
      await testInfo.attach("physical-image-install", {
        body: JSON.stringify({ fixtureLength, sourceRequests, recoveredBootCount: 2 }),
        contentType: "application/json",
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
