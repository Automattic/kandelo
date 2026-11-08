import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../playwright-test";
import type { Request } from "@playwright/test";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { startPersistentImageSource, type PersistentImageSource } from "./support/persistent-image-source";
import { loginToWordPress } from "./support/wordpress-login";
import { expectWordPressEditor, publishWordPressPost, saveWordPressTemplateHeading } from "./support/wordpress-editor";
import { observeImageWorkerMemory, imageWorkerMemory } from "./support/image-worker-memory";
import { clickDockTool } from "./support/dock";
import {
  gotoInPreview,
  gotoInPreviewViaDock,
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

for (const storageMode of ["experimental", "library"] as const) {
for (const { profile, title: machineTitle, image } of [
  { profile: "wordpress-sqlite", title: "WordPress SQLite", image: "wordpress" },
  { profile: "wordpress-frankenphp", title: "WordPress on FrankenPHP", image: "wordpress" },
  { profile: "wordpress-frankenphp-caddy", title: "WordPress on FrankenPHP + Caddy", image: "wordpress" },
  { profile: "wordpress-mariadb", title: "WordPress MariaDB", image: "lamp" },
]) {
const savesTemplates = profile === "wordpress-frankenphp" || profile === "wordpress-frankenphp-caddy";
const content = savesTemplates ? "posts, uploads, and saved site templates" : "posts and uploads";
test(`${machineTitle} ${content} survive OPFS restart without checkpointing or the source image (${storageMode})`, async ({ playwright, browserName }, testInfo) => {
  test.skip(process.env.KANDELO_TEST_MACHINE_URLS === undefined && !imageReady(`programs/wasm32/${image}.vfs.zst`), "ABI-matched browser WordPress product is required");
  test.setTimeout(540_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
    baseURL?: string;
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
      const lifecyclePath = testInfo.outputPath("page-lifecycle.jsonl");
      const recordLifecycle = (event: string, detail?: string) => appendFileSync(lifecyclePath,
        `${JSON.stringify({ recordedAt: new Date().toISOString(), event, url: page.url(), detail })}\n`);
      page.on("domcontentloaded", () => recordLifecycle("main document loaded"));
      page.on("crash", () => recordLifecycle("page crashed"));
      page.on("pageerror", error => recordLifecycle("page error", String(error)));
      const requestDetails = (request: Request) => {
        let frameUrl: string | undefined;
        try { frameUrl = request.frame().url(); } catch { /* service-worker requests have no frame */ }
        const redirectedFrom: string[] = [];
        for (let prior = request.redirectedFrom(); prior; prior = prior.redirectedFrom()) {
          redirectedFrom.push(prior.url());
        }
        return { frameUrl, method: request.method(), resourceType: request.resourceType(), redirectedFrom };
      };
      context.on("requestfailed", request => recordLifecycle("request failed", JSON.stringify({
        url: request.url(), method: request.method(), resourceType: request.resourceType(),
        failure: request.failure(), ...requestDetails(request),
      })));
      context.on("response", response => {
        if (response.status() >= 400) {
          const request = response.request();
          const failure = { url: response.url(), status: response.status(),
            fromServiceWorker: response.fromServiceWorker(), ...requestDetails(request) };
          try {
            void request.frame().locator("html").evaluate(() => ({
              url: location.href, baseURI: document.baseURI,
              controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
            }), undefined, { timeout: 5000 }).then(frame =>
              recordLifecycle("HTTP error frame", JSON.stringify({ request: failure, frame })))
              .catch(error => recordLifecycle("HTTP error frame unavailable", String(error)));
          } catch { /* requests originating in the worker have no document */ }
          recordLifecycle("HTTP error", JSON.stringify(failure));
          void response.text().then(body => recordLifecycle("HTTP error body", JSON.stringify({
            ...failure, contentType: response.headers()["content-type"], body: body.slice(0, 2048),
          }))).catch(error => recordLifecycle("HTTP error body unavailable", String(error)));
        }
      });
      await context.exposeBinding("__kandeloObserveWordPressError", ({ frame }, detail) =>
        recordLifecycle("original browser error", JSON.stringify({ frame: frame.url(), detail })));
      await context.addInitScript(() => {
        const record = (kind: string, value: unknown) => {
          const detail = value as { message?: unknown; code?: unknown; stack?: unknown } | null;
          void (window as unknown as { __kandeloObserveWordPressError(detail: unknown): Promise<void> })
            .__kandeloObserveWordPressError({ kind, message: String(detail?.message ?? value),
              code: detail?.code, stack: String(detail?.stack ?? "").slice(0, 4096) }).catch(() => {});
        };
        window.addEventListener("error", event => record("error", event.error ?? event.message));
        window.addEventListener("unhandledrejection", event => record("rejection", event.reason));
        document.addEventListener("click", event => {
          const modal = document.querySelector('[role="dialog"][aria-label="Welcome to the editor"]');
          if (!modal) return;
          const target = event.target instanceof Element ? event.target : null;
          const describe = () => {
            const runtime = window as unknown as { wp?: { data?: { select(store: string): {
              get(scope: string, name: string): unknown;
            } } } };
            return { modalPresent: !!document.querySelector('[role="dialog"][aria-label="Welcome to the editor"]'),
              postWelcome: runtime.wp?.data?.select("core/preferences").get("core/edit-post", "welcomeGuide"),
              editorWelcome: runtime.wp?.data?.select("core/preferences").get("core/editor", "welcomeGuide"),
            };
          };
          record("welcome click", { message: JSON.stringify({ trusted: event.isTrusted,
            target: target?.outerHTML.slice(0, 2048), button: target?.closest("button")?.outerHTML.slice(0, 2048),
            x: event.clientX, y: event.clientY, state: describe() }) });
          queueMicrotask(() => record("welcome click microtask", { message: JSON.stringify(describe()) }));
          setTimeout(() => record("welcome click next task", { message: JSON.stringify(describe()) }), 0);
        }, { capture: true, passive: true });
      });
      context.on("console", message => {
        if (message.type() !== "error" && message.type() !== "warning") return;
        recordLifecycle(`console ${message.type()}`, message.text().slice(0, 4000));
        // Bridge failures log an Error whose cause is lost in text(). Read
        // it while its worker realm still exists, before reload/cleanup.
        void Promise.all(message.args().map(argument => argument.evaluate(value => {
          const describe = (value: unknown, depth: number): unknown => {
            if (value !== null && typeof value === "object") {
              const detail = value as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown; cause?: unknown };
              return { name: detail.name, message: detail.message, code: detail.code, stack: detail.stack,
                cause: depth > 0 && detail.cause !== undefined ? describe(detail.cause, depth - 1) : undefined };
            }
            return String(value);
          };
          return describe(value, 4);
        }))).then(details => recordLifecycle("console arguments", JSON.stringify(details).slice(0, 16000)))
          .catch(error => recordLifecycle("console arguments unavailable", String(error)));
      });
      const resolvedTarget = await machineUrl(page, profile, {
        search: {
          experimentalPersistence: `wordpress-${crypto.randomUUID()}`,
          experimentalPersistenceMode: "resizable",
        },
      });
      const targetUrl = new URL(resolvedTarget, projectUse.baseURL);
      if (storageMode === "library") {
        targetUrl.searchParams.delete("experimentalPersistence");
        targetUrl.searchParams.delete("experimentalPersistenceMode");
        targetUrl.searchParams.delete("experimentalPersistenceIntegrity");
      }
      const originalImage = targetUrl.searchParams.get("vfs");
      if (originalImage === null) throw new Error("WordPress machine URL has no image");
      source = await startPersistentImageSource(originalImage, projectUse.extraHTTPHeaders);
      targetUrl.searchParams.set("vfs", source.url);
      const target = targetUrl.href;
      const installationStarted = performance.now();
      await page.goto(target, { waitUntil: "domcontentloaded" });
      if (profile === "wordpress-mariadb" && browserName === "chromium") {
        const imageStatus = page.getByRole("status").filter({ has: page.getByRole("progressbar", { name: /^Decompressing / }) });
        await expect(imageStatus.getByRole("progressbar", { name: /^Decompressing / }))
          .toBeVisible({ timeout: 60_000 });
        await expect(imageStatus.getByRole("progressbar", { name: /^Downloading / })).toBeVisible();
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
      // Leave the editor before an external REST update, so its own save or
      // autosave cannot race the replacement of the published post content.
      await gotoInPreviewViaDock(page, "/wp-admin/edit.php");
      await expect(frame.locator(`#post-${postId}`)).toContainText(title, { timeout: 30_000 });
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
        return { sourceUrl: media.source_url, mediaId: media.id, bytes: Array.from(bytes) };
      }, { appPrefix, nonce });
      const uploadedPath = new URL(uploaded.sourceUrl).pathname;
      expect(uploadedPath.startsWith(appPrefix)).toBe(true);
      const uploadedRelativePath = uploadedPath.slice(appPrefix.length);
      await page.evaluate(async ({ appPrefix, nonce, postId, sourceUrl, mediaId }) => {
        const response = await fetch(`${appPrefix}index.php?rest_route=/wp/v2/posts/${postId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-WP-Nonce": nonce },
          body: JSON.stringify({ content:
            `<!-- wp:image ${JSON.stringify({ id: mediaId, sizeSlug: "full", linkDestination: "none" })} -->` +
            `<figure class="wp-block-image size-full"><img src="${sourceUrl}" alt="Persistent uploaded image" class="wp-image-${mediaId}"/></figure>` +
            "<!-- /wp:image -->",
          }),
        });
        if (!response.ok) throw new Error(`Embedding uploaded media failed: ${response.status} ${await response.text()}`);
        const post = await response.json();
        if (!post.content?.raw?.includes(sourceUrl)) {
          throw new Error(`WordPress did not retain the uploaded image block: ${JSON.stringify(post.content)}`);
        }
      }, { appPrefix, nonce, postId, sourceUrl: uploaded.sourceUrl, mediaId: uploaded.mediaId });

      // Reopen the saved block, as a user does, and require the uploaded PNG
      // to render before navigating away. Byte persistence alone does not
      // establish that the editor can display the attachment.
      await gotoInPreviewViaDock(page, `/wp-admin/post.php?post=${postId}&action=edit`);
      await testInfo.attach("saved-post-before-editor-reopen", {
        contentType: "application/json",
        body: JSON.stringify(await page.evaluate(async ({ appPrefix, nonce, postId }) => {
          const response = await fetch(`${appPrefix}index.php?rest_route=/wp/v2/posts/${postId}&context=edit`, {
            headers: { "X-WP-Nonce": nonce },
          });
          return { status: response.status, body: (await response.text()).slice(0, 16_000) };
        }, { appPrefix, nonce, postId })),
      });
      await expectWordPressEditor(frame);
      await expect.poll(() => frame.frameLocator('iframe[name="editor-canvas"]').locator("img")
        .evaluateAll((images, sourceUrl) => {
          const expected = new URL(sourceUrl).pathname;
          const image = (images as HTMLImageElement[]).find(image =>
            new URL(image.currentSrc || image.src, document.baseURI).pathname === expected);
          return image ? { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight } : null;
        }, uploaded.sourceUrl), {
        timeout: 120_000, message: "The uploaded PNG must render in the WordPress block editor",
      }).toEqual({ complete: true, width: 2, height: 2 });

      const templateHeading = savesTemplates
        ? `Kandelo durable template ${crypto.randomUUID()}` : undefined;
      if (templateHeading !== undefined) {
        await gotoInPreviewViaDock(page,
          "/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//home&canvas=edit");
        await saveWordPressTemplateHeading(frame, templateHeading, "twentytwentyfive//home");
        await gotoInPreviewViaDock(page, "/");
        await expect(frame.locator("body")).toContainText(templateHeading, { timeout: 30_000 });
      }

      expect(source.observations()).toEqual({ imageRequests: 1, refusedImageRequests: 0 });
      source.disableImage();
      const installationMemory = await imageWorkerMemory(page, true);
      const recoveryStarted = performance.now();
      const reopenUrl = page.url();
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
        await recoveryPage.goto(reopenUrl, { waitUntil: "domcontentloaded" });
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      const recoveryFrame = previewFrame(recoveryPage, machineTitle);
      await expect(recoveryFrame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
      if (templateHeading !== undefined) {
        await expect(recoveryFrame.locator("body")).toContainText(templateHeading, { timeout: 30_000 });
      }
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
      if (templateHeading !== undefined) {
        await gotoInPreviewViaDock(recoveryPage,
          "/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfive//home&canvas=edit");
        await expect(recoveryFrame.frameLocator('iframe[name="editor-canvas"]')
          .locator('[data-type="core/heading"]').filter({ hasText: templateHeading }).first())
          .toBeVisible({ timeout: 180_000 });
        await recoveryPage.screenshot({
          path: `../../.context/${profile}-template-after-restart-${storageMode}-${browserName}.png`,
        });
      }
      sourceRequestsDuringRecovery = source.observations().refusedImageRequests;
      expect(source.observations()).toEqual({ imageRequests: 1, refusedImageRequests: 0 });
      if (profile === "wordpress-mariadb" && browserName === "chromium") {
        await recoveryPage.screenshot({ path: "../../.context/persistent-mariadb-demo.png" });
      }
      await testInfo.attach("persistence-application-timings", { contentType: "application/json", body: JSON.stringify({
        profile, browserName, timings, sourceRequestsDuringRecovery, imageCheckpoints: 0,
        templateHeadingVerified: templateHeading !== undefined,
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
            frames: await Promise.all(observationPage.frames().map(async frame => ({
              url: frame.url(), name: frame.name(),
              document: await frame.locator("html").evaluate(() => ({
                url: location.href, baseURI: document.baseURI, readyState: document.readyState,
                controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
                iframes: Array.from(document.querySelectorAll("iframe")).map(iframe => ({
                  name: iframe.name, title: iframe.title, src: iframe.src,
                  srcdoc: iframe.getAttribute("srcdoc")?.slice(0, 2048),
                })),
                editables: Array.from(document.querySelectorAll('[contenteditable], [role="textbox"], .editor-post-title'))
                  .slice(0, 20).map(element => element.outerHTML.slice(0, 4096)),
                body: document.body?.innerText.slice(0, 12_000),
              }), undefined, { timeout: 5000 }).catch(error => ({ error: String(error) })),
            }))),
            body: (await observationPage.locator("body").innerText({ timeout: 5000 }).catch(() => "unavailable")).slice(-64 * 1024),
          }),
        });
        await observationPage.screenshot({ path: testInfo.outputPath("persistent-computer-failure.png") }).catch(() => {});
        try {
          await clickDockTool(observationPage, "Internals", { timeout: 2_000 });
          const inspector = observationPage.getByRole("dialog", { name: "Internals", exact: true });
          await inspector.getByRole("tab", { name: "Syslog", exact: true }).click({ timeout: 2_000 });
          await testInfo.attach("persistent-computer-syslog", {
            body: JSON.stringify(await inspector.locator(".ksys-line").allTextContents()),
            contentType: "application/json",
          });
          await inspector.getByRole("tab", { name: "Procs", exact: true }).click({ timeout: 2_000 });
          await testInfo.attach("persistent-computer-processes", {
            body: await inspector.locator(".ktable").first().innerText({ timeout: 2_000 }),
            contentType: "text/plain",
          });
          await inspector.getByRole("tab", { name: "VFS", exact: true }).click({ timeout: 2_000 });
          for (const segment of ["var", "log"]) {
            await inspector.locator(".ktable tr", {
              has: observationPage.locator("td", { hasText: new RegExp(`^${segment}/$`) }),
            }).click({ timeout: 2_000 });
          }
          const serviceLog = profile === "wordpress-frankenphp-caddy" ? "frankenphp-caddy.log"
            : profile === "wordpress-frankenphp" ? "frankenphp-classic.log" : "nginx.log";
          await inspector.locator(".ktable tr", {
            has: observationPage.locator("td", { hasText: serviceLog }),
          }).click({ timeout: 2_000 });
          await testInfo.attach(serviceLog, {
            body: await inspector.locator(".kinternals-surface pre").last().innerText({ timeout: 2_000 }),
            contentType: "text/plain",
          });
        } catch (inspectionError) {
          await testInfo.attach("persistent-computer-inspection-error", {
            body: String(inspectionError), contentType: "text/plain",
          });
        }
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
}
