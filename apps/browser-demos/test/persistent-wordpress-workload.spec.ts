import { clickDockTool } from "./support/dock";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { gotoInPreview, machineAppPrefix, machineUrl, previewFrame } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";
import { persistentFailureInventory, planPersistentFailureCapture } from "./support/persistent-failure-inventory";
import { capturePersistentServiceLogs } from "./support/persistent-service-diagnostics";
import { loginToWordPress } from "./support/wordpress-login";
import { parseFilesystemMemory, validateFilesystemMemoryBounds } from "../../../host/test/fixtures/filesystem-memory";

const machineTitle = "WordPress MariaDB";
const workloadRoot = "/home/projects/persistence-workload";
const blobBytes = 8 * 1024 * 1024;
const hash = createHash("sha256");
for (let block = 0; block < 128; block += 1) hash.update(Buffer.alloc(65536));
const blobHash = hash.digest("hex");
const recoveryPasses = Number(process.env.KANDELO_TEST_PERSISTENCE_RELOADS ?? "1");
if (!Number.isInteger(recoveryPasses) || recoveryPasses < 1 || recoveryPasses > 8) {
  throw new Error("KANDELO_TEST_PERSISTENCE_RELOADS must be an integer from 1 through 8");
}

async function capturePersistentFailure(page: Page, testInfo: TestInfo): Promise<void> {
  const prefix = new URL(page.url()).searchParams.get("experimentalPersistence");
  if (!prefix?.startsWith("wordpress-workload-")) throw new Error("failure capture requires its owned workload computer");
  const inventory = await persistentFailureInventory(page, prefix);
  await testInfo.attach("opfs-inventory", { body: JSON.stringify(inventory, null, 2), contentType: "application/json" });
  const plan = planPersistentFailureCapture(inventory.files);
  await testInfo.attach("opfs-capture-plan", { body: JSON.stringify(plan, null, 2), contentType: "application/json" });
  for (const [index, file] of plan.selected.entries()) {
    const downloadReady = page.waitForEvent("download", { timeout: 30_000 });
    void downloadReady.catch(() => {});
    const objectUrl = await page.evaluate(async name => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
      const file = await (await directory.getFileHandle(name)).getFile();
      const objectUrl = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = name;
      link.click();
      return objectUrl;
    }, file.name);
    try {
      const download = await downloadReady;
      const path = testInfo.outputPath(`opfs-${index}`);
      await download.saveAs(path);
      await testInfo.attach(file.name, { path, contentType: "application/octet-stream" });
    } finally {
      await page.evaluate(objectUrl => URL.revokeObjectURL(objectUrl), objectUrl);
    }
  }
}

async function requestJson(page: Page, prefix: string, path: string, method = "GET", body?: unknown, nonce?: string) {
  return page.evaluate(async ({ prefix, path, method, body, nonce }) => {
    const url = new URL(`${prefix}index.php`, location.href);
    const [route, query] = path.split("?");
    url.searchParams.set("rest_route", `/wp/v2/${route}`);
    for (const [key, value] of new URLSearchParams(query)) url.searchParams.append(key, value);
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(nonce ? { "X-WP-Nonce": nonce } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`WordPress ${method} ${path}: ${response.status} ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }, { prefix, path, method, body, nonce });
}

async function upload(page: Page, prefix: string, nonce: string, name: string, color: string) {
  return page.evaluate(async ({ prefix, nonce, name, color }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("canvas unavailable");
    drawing.fillStyle = color;
    drawing.fillRect(0, 0, 4, 4);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png");
    });
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const response = await fetch(`${prefix}index.php?rest_route=/wp/v2/media`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${name}.png"`, "X-WP-Nonce": nonce },
      body: blob,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`WordPress upload: ${response.status} ${text.slice(0, 500)}`);
    const media = JSON.parse(text) as { id: number; source_url: string };
    const sourcePath = new URL(media.source_url).pathname;
    if (!sourcePath.startsWith(prefix)) throw new Error(`upload escaped machine prefix: ${sourcePath}`);
    return { id: media.id, path: sourcePath.slice(prefix.length), bytes };
  }, { prefix, nonce, name, color });
}

async function terminal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toMatch(/kandelo(?:-bash-[0-9.]+)?\$ ?/);
}

async function verifyGuestWorkload(page: Page, removedUpload: string): Promise<void> {
  await terminal(page);
  await runTerminalCommand(page, `set -eu
root=${workloadRoot}/current
printf 'WORKLOAD_VERIFY_BEGIN\n'
test ! -e "/var/www/html/${removedUpload}"
for ((index=0; index<512; index++)); do
  case "$index" in
    0|1|2) continue ;;
  esac
  IFS= read -r value < "$root/file-$index"
  test "$value" = "value-$index"
done
printf 'WORKLOAD_NAMES_VERIFIED\n'
test ! -e "$root/file-1"
test ! -e "$root/file-2"
IFS= read -r value < "$root/renamed"
test "$value" = value-1
test "$(cat "$root/file-0")" = $'value-0\nappended'
printf 'WORKLOAD_CONTENT_VERIFIED\n'
cmp "$root/file-0" "$root/alias"
printf 'WORKLOAD_ALIAS_VERIFIED\n'
test "$(stat -c %i "$root/file-0")" = "$(stat -c %i "$root/alias")"
printf 'WORKLOAD_INODES_VERIFIED\n'
test "$(stat -c %h "$root/file-0")" -eq 2
test "$(stat -c %a "$root/file-0")" = 640
test "$(readlink "$root/current-link")" = renamed
printf 'WORKLOAD_METADATA_VERIFIED\n'
test "$(wc -c < "$root/blob")" -eq ${blobBytes}
test "$(sha256sum "$root/blob" | cut -d ' ' -f 1)" = ${blobHash}
for ((index=1; index<4; index++)); do
  test "$(wc -c < "$root/blob-$index")" -eq ${blobBytes}
  test "$(sha256sum "$root/blob-$index" | cut -d ' ' -f 1)" = ${blobHash}
done
printf 'WORDPRESS_WORKLOAD_VERIFIED\n'`, "WORDPRESS_WORKLOAD_VERIFIED");
}

for (const recovery of ["live", "checkpoint"] as const) {
test(`MariaDB updates, media deletion and 32 MiB guest files survive ${recovery} source-free reload`, async ({ playwright, browserName }, testInfo) => {
  test.skip(process.env.KANDELO_TEST_MACHINE_URLS === undefined && !tryResolveBinary("programs/wasm32/lamp.vfs.zst"),
    "ABI-matched WordPress MariaDB product is required");
  test.setTimeout(600_000);
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-persistent-wordpress-workload-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      acceptDownloads: true,
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    const diagnostics: string[] = [];
    let phase = "initial boot";
    let phaseStarted = performance.now();
    const timings: Array<{ phase: string; elapsedMs: number }> = [];
    const memory: Array<{ phase: string; report: ReturnType<typeof parseFilesystemMemory> }> = [];
    const enterPhase = (next: string) => {
      const now = performance.now();
      timings.push({ phase, elapsedMs: now - phaseStarted });
      phase = next;
      phaseStarted = now;
    };
    try {
      await context.addInitScript(() => { window.confirm = () => true; });
      const page = context.pages()[0] ?? await context.newPage();
      page.on("console", message => {
        if ((message.type() === "warning" || message.type() === "error") && diagnostics.length < 200) {
          diagnostics.push(`${message.type()}: ${message.text().slice(0, 4000)}`);
        }
      });
      page.on("pageerror", error => {
        if (diagnostics.length < 200) diagnostics.push(`pageerror: ${error.stack ?? error.message}`);
      });
      const target = await machineUrl(page, "wordpress-mariadb", { search: {
        experimentalPersistence: `wordpress-workload-${crypto.randomUUID()}`,
        experimentalPersistenceMode: "resizable",
      } });
      await testInfo.attach("persistent-computer-url", { body: target, contentType: "text/plain" });
      await page.goto(target, { waitUntil: "domcontentloaded" });
      const frame = previewFrame(page, machineTitle);
      await expect(frame.locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
      const prefix = await machineAppPrefix(page, machineTitle);
      await loginToWordPress(frame, prefix);
      await gotoInPreview(frame, prefix, "wp-admin/post-new.php");
      await expect(frame.locator("body.wp-admin")).toBeVisible({ timeout: 180_000 });
      const nonce = await frame.locator("body").evaluate(() => {
        const settings = (window as Window & { wpApiSettings?: { nonce?: string } }).wpApiSettings;
        const inline = document.querySelector("#wp-api-fetch-js-after")?.textContent ?? "";
        const nonce = settings?.nonce ?? /"nonce":"([^"]+)"/.exec(inline)?.[1];
        if (!nonce) throw new Error("WordPress REST nonce unavailable");
        return nonce;
      });
      const title = `Updated persistent workload ${crypto.randomUUID()}`;
      enterPhase("WordPress mutations");
      const post = await requestJson(page, prefix, "posts", "POST", { title: "Before update", content: "Before", status: "publish" }, nonce);
      const changed = await requestJson(page, prefix, `posts/${post.id}`, "POST", { title, content: "Database update survived" }, nonce);
      expect(changed.title.rendered).toBe(title);
      const retained = await upload(page, prefix, nonce, "retained-workload", "#0066cc");
      const removed = await upload(page, prefix, nonce, "removed-workload", "#cc6600");
      expect(removed.path).toMatch(/^wp-content\/uploads\/[A-Za-z0-9/._-]+$/);
      const media = await requestJson(page, prefix, `media/${retained.id}`, "POST", { alt_text: title }, nonce);
      expect(media.alt_text).toBe(title);
      const deleted = await requestJson(page, prefix, `media/${removed.id}?force=true`, "DELETE", undefined, nonce);
      expect(deleted.deleted).toBe(true);
      enterPhase("guest mutations");
      await terminal(page);
      await runTerminalCommand(page, `set -eu
root=${workloadRoot}
mkdir -p "$root/source"
for ((index=0; index<512; index++)); do printf 'value-%s\n' "$index" > "$root/source/file-$index"; done
ln "$root/source/file-0" "$root/source/alias"
printf 'appended\n' >> "$root/source/alias"
chmod 640 "$root/source/file-0"
mv "$root/source/file-1" "$root/source/renamed"
rm "$root/source/file-2"
ln -s renamed "$root/source/current-link"
dd if=/dev/zero of="$root/source/blob" bs=65536 count=128
for ((index=1; index<4; index++)); do
  dd if=/dev/zero of="$root/source/blob-$index" bs=65536 count=128
done
mv "$root/source" "$root/current"
sync
printf 'WORDPRESS_WORKLOAD_CREATED\n'`, "WORDPRESS_WORKLOAD_CREATED");
      enterPhase("initial guest verification");
      await verifyGuestWorkload(page, removed.path);
      const observeMemory = async () => {
        await terminal(page);
        const result = await runTerminalCommand(page,
          "printf 'FS_MEMORY_BEGIN|'; while IFS= read -r line; do printf '%s|' \"$line\"; done < /proc/kandelo/fs_memory; printf 'FS_MEMORY_END'", "FS_MEMORY_END");
        const report = parseFilesystemMemory(result.output.replaceAll("|", "\n"));
        validateFilesystemMemoryBounds(report);
        memory.push({ phase, report });
      };
      await observeMemory();
      const verifyApplication = async () => {
        await page.getByRole("button", { name: "Web", exact: true }).click();
        const currentPrefix = await machineAppPrefix(page, machineTitle);
        const savedPost = await requestJson(page, currentPrefix, `posts/${post.id}`);
        expect(savedPost.title.rendered).toBe(title);
        expect(savedPost.content.rendered).toContain("Database update survived");
        const savedMedia = await requestJson(page, currentPrefix, `media/${retained.id}`);
        expect(savedMedia.alt_text).toBe(title);
        const files = await page.evaluate(async ({ currentPrefix, retained, removed }) => {
          const saved = await fetch(`${currentPrefix}${retained.path}`, { cache: "no-store" });
          const deleted = await fetch(`${currentPrefix}index.php?rest_route=/wp/v2/media/${removed.id}`, { cache: "no-store" });
          const deletion = await deleted.json() as { code?: string };
          return { status: saved.status, bytes: Array.from(new Uint8Array(await saved.arrayBuffer())), deletedCode: deletion.code };
        }, { currentPrefix, retained, removed });
        expect(files).toEqual({ status: 200, bytes: retained.bytes, deletedCode: "rest_post_invalid_id" });
      };
      enterPhase("initial WordPress verification");
      await verifyApplication();
      if (recovery === "checkpoint") {
      enterPhase("checkpoint");
      await clickDockTool(page, "Internals");
      await page.getByRole("button", { name: "Checkpoint image" }).click();
      await page.locator('.kdock-status-text[data-status="booting"]').waitFor({ timeout: 120_000 });
      await expect.poll(async () => {
        const status = await page.locator(".kdock-status-text").getAttribute("data-status");
        if (status === "error") throw new Error(`checkpoint failed:\n${(await page.locator(".ksys-line").allTextContents()).join("\n")}`);
        return status;
      }, { timeout: 240_000 }).toBe("running");
      await expect(previewFrame(page, machineTitle).locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
      enterPhase("checkpoint WordPress verification");
      await verifyApplication();
      enterPhase("checkpoint guest verification");
      await verifyGuestWorkload(page, removed.path);
      await observeMemory();
      }
      const imageUrl = new URL(target, page.url()).searchParams.get("vfs");
      if (!imageUrl) throw new Error("WordPress machine URL has no image");
      let sourceRequests = 0;
      await page.route(imageUrl, route => { sourceRequests++; return route.abort("failed"); });
      const recoveries: Array<{ pass: number; applicationReadyMs: number; verifiedMs: number }> = [];
      for (let pass = 1; pass <= recoveryPasses; pass++) {
        const started = Date.now();
        enterPhase(`source-blocked reload ${pass}/${recoveryPasses}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(previewFrame(page, machineTitle).locator("body")).toContainText(/WordPress on Kandelo|Hello world/i, { timeout: 240_000 });
        const applicationReadyMs = Date.now() - started;
        enterPhase(`source-blocked WordPress verification ${pass}/${recoveryPasses}`);
        await verifyApplication();
        enterPhase(`source-blocked guest verification ${pass}/${recoveryPasses}`);
        await verifyGuestWorkload(page, removed.path);
        await observeMemory();
        recoveries.push({ pass, applicationReadyMs, verifiedMs: Date.now() - started });
        await testInfo.attach(`source-free-recovery-${pass}`, {
          body: JSON.stringify(recoveries.at(-1)), contentType: "application/json",
        });
      }
      expect(sourceRequests).toBe(0);
      enterPhase("complete");
    } catch (error) {
      await testInfo.attach("workload-phase", { body: phase, contentType: "text/plain" });
      const page = context.pages()[0]!;
      try {
        await clickDockTool(page, "Internals", { timeout: 5000 });
        await page.getByRole("tab", { name: "Syslog", exact: true }).click({ timeout: 5000 });
        await testInfo.attach("kernel-status", {
          body: JSON.stringify({
            status: await page.locator(".kdock-status-text").textContent(),
            log: await page.locator(".ksys-line").allTextContents(),
          }),
          contentType: "application/json",
        });
        await page.getByRole("tab", { name: "Procs", exact: true }).click({ timeout: 5000 });
        try {
          await expect(page.locator(".ktable").first()).toBeVisible({ timeout: 5000 });
        } finally {
          await testInfo.attach("process-inspection-ui", {
            body: (await page.locator(".kinternals-surface:visible .kinternals-body").first()
              .innerText({ timeout: 5000 })).slice(0, 16 * 1024),
            contentType: "text/plain",
          });
        }
        await testInfo.attach("live-processes", {
          body: (await page.locator(".ktable").first().innerText()).slice(0, 16 * 1024),
          contentType: "text/plain",
        });
      } catch (inspectionError) {
        diagnostics.push(`failure inspection: ${String(inspectionError).slice(0, 2000)}`);
      }
      try {
        await capturePersistentServiceLogs(page, testInfo);
      } catch (inspectionError) {
        diagnostics.push(`service log inspection: ${String(inspectionError).slice(0, 2000)}`);
      }
      if (process.env.KANDELO_CAPTURE_PERSISTENCE_FAILURE === "1") {
        try {
          await capturePersistentFailure(context.pages()[0]!, testInfo);
        } catch (captureError) {
          await testInfo.attach("opfs-capture-error", { body: String(captureError), contentType: "text/plain" });
        }
      }
      throw error;
    } finally {
      try {
        await context.close();
      } finally {
        await testInfo.attach("worker-diagnostics", { body: diagnostics.join("\n"), contentType: "text/plain" });
        await testInfo.attach("workload-observations", {
          body: JSON.stringify({ browserName, recovery, distinctPayloadBytes: 4 * blobBytes,
            phase, timings, memory, interpretation: "Desktop observations, not a matched speedup or physical-mobile measurement." }),
          contentType: "application/json",
        });
      }
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
}
