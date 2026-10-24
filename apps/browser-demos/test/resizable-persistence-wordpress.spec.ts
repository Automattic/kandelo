import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { startPersistentImageSource, type PersistentImageSource } from "./support/persistent-image-source";
import { loginToWordPress } from "./support/wordpress-login";
import { expectWordPressEditor, publishWordPressPost } from "./support/wordpress-editor";
import { observeImageWorkerMemory, imageWorkerMemory } from "./support/image-worker-memory";
import {
  gotoInPreview,
  machineAppPrefix,
  machineUrl,
  previewFrame,
} from "./support/kandelo-machine";

function imageReady(image: string): boolean {
  return [image, "programs/wasm32/bash.wasm"].every((path) => {
    try {
      return tryResolveBinary(path) !== null;
    } catch {
      return false;
    }
  });
}

for (const { profile, title: machineTitle, image } of [
  { profile: "wordpress-sqlite", title: "WordPress SQLite", image: "wordpress" },
  { profile: "wordpress-mariadb", title: "WordPress MariaDB", image: "lamp" },
]) {
test(`${machineTitle} posts and uploads survive OPFS restart without checkpointing or the source image`, async ({ playwright, browserName }, testInfo) => {
  test.skip(process.env.KANDELO_TEST_MACHINE_URLS === undefined && !imageReady(`programs/wasm32/${image}.vfs.zst`), "ABI-matched browser WordPress product is required");
  test.setTimeout(540_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-persistent-wordpress-"));
  let source: PersistentImageSource | undefined;
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    let recoveryContext: typeof context | null = null;
    const timings: { operation: string; elapsedMs: number }[] = [];
    let sourceRequestsDuringRecovery = 0;
    let observationPage = context.pages()[0] ?? await context.newPage();
    try {
      await context.addInitScript(() => { window.confirm = () => true; });
      await observeImageWorkerMemory(context);
      const page = observationPage;
      const resolvedTarget = await machineUrl(page, profile, {
        search: {
          experimentalPersistence: `wordpress-${crypto.randomUUID()}`,
          experimentalPersistenceMode: "resizable",
        },
      });
      const targetUrl = new URL(resolvedTarget);
      const originalImage = targetUrl.searchParams.get("vfs");
      if (originalImage === null) throw new Error("WordPress machine URL has no image");
      source = await startPersistentImageSource(originalImage, projectUse.extraHTTPHeaders);
      targetUrl.searchParams.set("vfs", source.url);
      const target = targetUrl.href;
      const installationStarted = performance.now();
      await page.goto(target, { waitUntil: "domcontentloaded" });
      if (profile === "wordpress-mariadb" && browserName === "chromium") {
        await expect(page.getByRole("progressbar", { name: /^Decompressing / }))
          .toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole("progressbar", { name: /^Downloading / })).toBeVisible();
        await page.screenshot({ path: "../../.context/persistent-mariadb-decompression.png" });
      }
      const frame = previewFrame(page, machineTitle);
      await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 360_000 });
      timings.push({ operation: "fresh-profile installation to first WordPress response", elapsedMs: performance.now() - installationStarted });
      const appPrefix = await machineAppPrefix(page, machineTitle);

      await loginToWordPress(frame, appPrefix);
      await gotoInPreview(frame, appPrefix, "wp-admin/post-new.php");
      const title = `Kandelo persistent ${crypto.randomUUID()}`;
      const postId = await publishWordPressPost(frame, title);
      const nonce = await frame.locator("body").evaluate(() => {
        const settings = (window as Window & { wpApiSettings?: { nonce?: string } }).wpApiSettings;
        const inline = document.querySelector("#wp-api-fetch-js-after")?.textContent ?? "";
        const nonce = settings?.nonce ?? /"nonce":"([^"]+)"/.exec(inline)?.[1];
        if (!nonce) throw new Error(`WordPress REST nonce unavailable: ${inline.slice(0, 500)}`);
        return nonce;
      });
      const uploaded = await page.evaluate(async ({ appPrefix, nonce }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas unavailable for WordPress upload fixture");
        context.fillStyle = "#0066cc";
        context.fillRect(0, 0, 2, 2);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png");
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const response = await fetch(`${appPrefix}index.php?rest_route=/wp/v2/media`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "image/png",
            "Content-Disposition": 'attachment; filename="persistence-proof.png"',
            "X-WP-Nonce": nonce,
          },
          body: bytes,
        });
        const body = await response.text();
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          throw new Error(`WordPress upload failed ${response.status} ${response.url}: ${body.slice(0, 500)}`);
        }
        const media = JSON.parse(body) as { id?: number; source_url?: string };
        if (!media.id || !media.source_url) throw new Error(`WordPress upload has no file identity: ${body.slice(0, 500)}`);
        return { sourceUrl: media.source_url, bytes: Array.from(bytes) };
      }, { appPrefix, nonce });
      const uploadedPath = new URL(uploaded.sourceUrl).pathname;
      expect(uploadedPath.startsWith(appPrefix)).toBe(true);
      const uploadedRelativePath = uploadedPath.slice(appPrefix.length);
      await page.evaluate(async ({ appPrefix, nonce, postId, sourceUrl }) => {
        const response = await fetch(`${appPrefix}index.php?rest_route=/wp/v2/posts/${postId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WP-Nonce": nonce },
          body: JSON.stringify({ content: `<figure class="wp-block-image"><img src="${sourceUrl}" alt="Persistent uploaded image"></figure>` }),
        });
        if (!response.ok) throw new Error(`Embedding uploaded media failed: ${response.status} ${await response.text()}`);
      }, { appPrefix, nonce, postId, sourceUrl: uploaded.sourceUrl });

      expect(source.observations()).toEqual({ imageRequests: 1, refusedImageRequests: 0 });
      source.disableImage();
      const installationMemory = await imageWorkerMemory(page, true);
      const recoveryStarted = performance.now();
      let recoveryPage = page;
      if (browserName === "chromium") {
        const session = await context.newCDPSession(page);
        const closed = context.waitForEvent("close", { timeout: 15_000 });
        void session.send("Browser.crash").catch(() => {});
        await closed;
        recoveryContext = await playwright.chromium.launchPersistentContext(userDataDir, {
          channel: projectUse.channel,
          proxy: projectUse.proxy as never,
          extraHTTPHeaders: projectUse.extraHTTPHeaders,
          ...(projectUse.launchOptions ?? {}),
        });
        await recoveryContext.addInitScript(() => { window.confirm = () => true; });
        await observeImageWorkerMemory(recoveryContext);
        recoveryPage = recoveryContext.pages()[0] ?? await recoveryContext.newPage();
        observationPage = recoveryPage;
        await recoveryPage.goto(target, { waitUntil: "domcontentloaded" });
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      const recoveryFrame = previewFrame(recoveryPage, machineTitle);
      await expect(recoveryFrame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
      timings.push({ operation: browserName === "chromium"
        ? "browser-process crash, relaunch and saved-computer boot to first WordPress response"
        : "page reload and saved-computer boot to first WordPress response", elapsedMs: performance.now() - recoveryStarted });
      const reopenedPrefix = await machineAppPrefix(recoveryPage, machineTitle);
      expect(reopenedPrefix).toBe(appPrefix);
      await gotoInPreview(recoveryFrame, reopenedPrefix, `?p=${postId}`);
      await expect(recoveryFrame.locator("body")).toContainText(title, { timeout: 120_000 });
      const embeddedImage = recoveryFrame.getByRole("img", { name: "Persistent uploaded image", exact: true });
      await expect(embeddedImage).toHaveJSProperty("naturalWidth", 2, { timeout: 120_000 });
      await expect(embeddedImage).toHaveAttribute("src", uploaded.sourceUrl);
      const restoredUpload = await recoveryPage.evaluate(async (url) => {
        const response = await fetch(url, { cache: "no-store" });
        return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
      }, `${reopenedPrefix}${uploadedRelativePath}`);
      expect(restoredUpload).toEqual({ status: 200, bytes: uploaded.bytes });
      await loginToWordPress(recoveryFrame, reopenedPrefix);
      await gotoInPreview(recoveryFrame, reopenedPrefix, "wp-admin/post-new.php");
      await expectWordPressEditor(recoveryFrame);
      sourceRequestsDuringRecovery = source.observations().refusedImageRequests;
      expect(source.observations()).toEqual({ imageRequests: 1, refusedImageRequests: 0 });
      if (profile === "wordpress-mariadb" && browserName === "chromium") {
        await recoveryPage.screenshot({ path: "../../.context/persistent-mariadb-demo.png" });
      }
      await testInfo.attach("persistence-application-timings", { contentType: "application/json", body: JSON.stringify({
        profile, browserName, timings, sourceRequestsDuringRecovery, imageCheckpoints: 0,
        interpretation: "Single-run wall-clock observations, not a matched performance comparison. Installation includes download and persistent-format creation; recovery includes the named page/browser lifecycle.",
      }) });
      await testInfo.attach("persistence-image-worker-memory", { contentType: "application/json", body: JSON.stringify({
        installation: installationMemory, recovery: await imageWorkerMemory(recoveryPage, false),
        interpretation: "Native Wasm pages, bounded transfer windows and modeled manifest credits. Worker retirement request is not a process-RSS measurement.",
      }) });
    } catch (error) {
      if (!observationPage.isClosed()) {
        await testInfo.attach("persistent-computer-failure", {
          contentType: "application/json",
          body: JSON.stringify({
            url: observationPage.url(),
            frames: observationPage.frames().map(frame => frame.url()),
            body: (await observationPage.locator("body").innerText({ timeout: 5000 }).catch(() => "unavailable")).slice(-64 * 1024),
          }),
        });
        await observationPage.screenshot({ path: testInfo.outputPath("persistent-computer-failure.png") }).catch(() => {});
      }
      throw error;
    } finally {
      if (recoveryContext !== null) await recoveryContext.close();
      else await context.close().catch(() => {});
    }
  } finally {
    try { await source?.close(); }
    finally { rmSync(userDataDir, { recursive: true, force: true }); }
  }
});
}
