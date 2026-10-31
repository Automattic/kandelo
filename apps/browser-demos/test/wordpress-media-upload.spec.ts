import { clickDockTool } from "./support/dock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoInPreview, machineAppPrefix, machineUrl, previewFrame } from "./support/kandelo-machine";
import { loginToWordPress } from "./support/wordpress-login";

test("WordPress MariaDB media-library uploads survive checkpoint and oversized requests return 413", async ({ playwright, browserName }, testInfo) => {
  test.setTimeout(540_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-media-upload-"));
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
      const diagnostics: string[] = [];
      const transfers: { stage: string; url: string; detail?: string | number }[] = [];
      const transfer = (stage: string, url: string, detail?: string | number) => {
        if (transfers.length < 200 && url.includes("/wp-admin/async-upload.php")) {
          transfers.push({ stage, url: url.slice(0, 2000), detail });
        }
      };
      page.on("request", request => transfer("request", request.url(), request.method()));
      page.on("response", response => transfer("response", response.url(), response.status()));
      page.on("requestfailed", request => transfer("failed", request.url(), request.failure()?.errorText));
      page.on("console", message => {
        if (diagnostics.length < 200 && ["error", "warning"].includes(message.type())) diagnostics.push(message.text().slice(0, 1000));
      });
      page.on("pageerror", error => {
        if (diagnostics.length < 200) diagnostics.push(error.message.slice(0, 1000));
      });
      const target = await machineUrl(page, "wordpress-mariadb", {
        search: {
          experimentalPersistence: `media-upload-${crypto.randomUUID()}`,
          experimentalPersistenceMode: "resizable",
        },
      });
      await page.goto(target, { waitUntil: "domcontentloaded" });
      const frame = previewFrame(page, "WordPress MariaDB");
      await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
      const prefix = await machineAppPrefix(page, "WordPress MariaDB");
      await loginToWordPress(frame, prefix);
      await gotoInPreview(frame, prefix, "wp-admin/media-new.php");
      await expect(frame.getByRole("button", { name: "Select Files", exact: true })).toBeVisible({ timeout: 120_000 });
      const uploaded: { path: string; bytes: number[] }[] = [];
      for (const size of [2, 256, 640]) {
        const bytes = await page.evaluate(async size => {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const drawing = canvas.getContext("2d");
          if (!drawing) throw new Error("canvas unavailable");
          const pixels = drawing.createImageData(size, size);
          let seed = 42;
          for (let offset = 0; offset < pixels.data.length; offset += 4) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[offset] = seed & 255;
            pixels.data[offset + 1] = (seed >>> 8) & 255;
            pixels.data[offset + 2] = (seed >>> 16) & 255;
            pixels.data[offset + 3] = 255;
          }
          drawing.putImageData(pixels, 0, 0);
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png");
          });
          return Array.from(new Uint8Array(await blob.arrayBuffer()));
        }, size);
        let uploadPhase = "opening file chooser";
        const response = await Promise.all([
          page.waitForResponse(response => response.url().includes("/wp-admin/async-upload.php") && response.request().method() === "POST", { timeout: 120_000 }),
          (async () => {
            const [chooser] = await Promise.all([
              page.waitForEvent("filechooser", { timeout: 30_000 }),
              frame.getByRole("button", { name: "Select Files", exact: true }).click(),
            ]);
            uploadPhase = "setting selected file";
            await chooser.setFiles({ name: `media-library-${size}.png`, mimeType: "image/png", buffer: Buffer.from(bytes) });
            uploadPhase = "awaiting upload response";
          })(),
        ]).then(([response]) => response).catch(async error => {
          const uploader = await frame.locator("body").evaluate(body => {
            const globals = window as unknown as Record<string, unknown>;
            const instance = globals.uploader as { state?: unknown; files?: { name?: unknown; size?: unknown; status?: unknown }[] } | undefined;
            return {
              url: location.href,
              text: body.innerText.slice(-6000),
              inputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).slice(0, 8).map(input => ({
                id: input.id, disabled: input.disabled,
                files: Array.from(input.files ?? []).slice(0, 8).map(file => ({ name: file.name, size: file.size })),
              })),
              plupload: typeof globals.plupload,
              uploader: typeof globals.uploader,
              state: typeof instance?.state === "number" ? instance.state : null,
              files: Array.isArray(instance?.files) ? instance.files.slice(0, 8).map(file => ({
                name: String(file.name).slice(0, 255), size: Number(file.size), status: Number(file.status),
              })) : [],
            };
          }).catch(failure => ({ inspectionFailure: String(failure).slice(0, 2000) }));
          await testInfo.attach(`upload-timeout-${size}`, {
            body: JSON.stringify({ size, bytes: bytes.length, uploadPhase, diagnostics, transfers, uploader }),
            contentType: "application/json",
          });
          throw error;
        });
        const body = await response.text();
        await testInfo.attach(`diagnostics-${size}`, { body: JSON.stringify(diagnostics), contentType: "application/json" });
        await testInfo.attach(`upload-${size}`, { body: JSON.stringify({ status: response.status(), bytes: bytes.length, body }), contentType: "application/json" });
        if (size === 640) {
          expect(bytes.length).toBeGreaterThan(1024 * 1024);
          expect(response.status(), body.slice(0, 2000)).toBe(413);
          expect(body).toContain("413 Request Entity Too Large");
          continue;
        }
        expect(response.status(), body.slice(0, 2000)).toBe(200);
        const result = JSON.parse(body) as number | { success?: boolean; data?: { url?: string } };
        let sourceUrl: string;
        if (typeof result === "number") {
          expect(result, body.slice(0, 2000)).toBeGreaterThan(0);
          const copy = frame.locator(`button.copy-attachment-url[data-clipboard-text*="media-library-${size}"]`);
          await expect(copy).toBeAttached({ timeout: 120_000 });
          sourceUrl = (await copy.getAttribute("data-clipboard-text"))!;
        } else {
          expect(result.success, body.slice(0, 2000)).toBe(true);
          expect(result.data?.url, body.slice(0, 2000)).toBeTruthy();
          sourceUrl = result.data!.url!;
        }
        const pathname = new URL(sourceUrl, page.url()).pathname;
        expect(pathname.startsWith(prefix)).toBe(true);
        uploaded.push({ path: pathname.slice(prefix.length), bytes });
      }
      await page.evaluate(() => {
        const records: { elapsed: number; text: string }[] = [];
        const started = performance.now();
        let previous = "";
        const observer = new MutationObserver(() => {
          const text = document.querySelector(".kmprogress-card")?.textContent ?? "";
          if (text === previous || !text) return;
          previous = text;
          if (records.length < 512) records.push({ elapsed: performance.now() - started, text: text.slice(0, 500) });
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        Object.assign(window, { checkpointObservation: { records, observer } });
      });
      await clickDockTool(page, "Internals");
      await page.getByRole("button", { name: "Checkpoint image" }).click();
      await page.locator('.kdock-status-text[data-status="booting"]').waitFor({ timeout: 120_000 });
      await page.locator('.kdock-status-text[data-status="running"]').waitFor({ timeout: 240_000 });
      const checkpointProgress = await page.evaluate(() => {
        const observation = (window as unknown as { checkpointObservation: { records: { elapsed: number; text: string }[]; observer: MutationObserver } }).checkpointObservation;
        observation.observer.disconnect();
        return observation.records;
      });
      await testInfo.attach("checkpoint-progress", { body: JSON.stringify(checkpointProgress, null, 2), contentType: "application/json" });
      expect(checkpointProgress.some(event => /Writing filesystem snapshot|Verifying filesystem snapshot/.test(event.text))).toBe(true);
      const imageUrl = new URL(target, page.url()).searchParams.get("vfs");
      if (!imageUrl) throw new Error("machine URL has no source image");
      await page.route(imageUrl, route => route.abort("failed"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(previewFrame(page, "WordPress MariaDB").locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
      const restoredPrefix = await machineAppPrefix(page, "WordPress MariaDB");
      for (const file of uploaded) {
        const actual = await page.evaluate(async url => {
          const response = await fetch(url, { cache: "no-store" });
          return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
        }, `${restoredPrefix}${file.path}`);
        expect(actual.status).toBe(200);
        expect(Buffer.from(actual.bytes).equals(Buffer.from(file.bytes))).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath("persisted-media.png") });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
