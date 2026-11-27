import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { expect, type Page } from "../playwright-test";
import { test } from "./support/persistent-page";
import { runTerminalCommand } from "./support/terminal-command";

// The worktree's partial image (`./run.sh partial <image> <pkg>...`), served by
// the dev server as its own gallery machine (vite/dev-partial-image.ts). These
// tests run against whatever partial image this worktree built, and skip when
// there is none.
const manifestPath = resolve(import.meta.dirname, "../../../local-binaries/partial/partial.json");
const manifest: { image: string; sha256: string; packages: string[]; activities: string[] } | null =
  existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;

test.skip(manifest === null, "no partial image is built in this worktree");
test.use({ actionTimeout: 30_000 });

const PARTIAL_URL = "/@kandelo-partial/image.vfs.zst";

async function ready(page: Page) {
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 180_000 });
  await expect.poll(() => page.locator(".xterm-rows").first().textContent(), { timeout: 120_000 })
    .toMatch(/maker@[^:\s]+:[^\r\n]*\$ ?/);
}

async function cachedUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
}

test("the partial image is served uncached at one URL", async ({ page }) => {
  const response = await page.request.get(PARTIAL_URL);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-kandelo-partial-image-sha256"]).toBe(manifest!.sha256);
});

test("the partial image boots as its own machine with only its activities", async ({ page }) => {
  // A derived partial image (LAMP, WordPress, ...) boots its own services
  // rather than the maker login this test drives.
  test.skip(manifest?.image !== "shell", "drives the partial shell's login terminal");
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/?vfs=${encodeURIComponent(PARTIAL_URL)}&profile=shell`);
  await ready(page);

  // The named packages' programs run from the image; an unselected one is absent.
  for (const [pkg, command, expected] of [
    ["tmux", "tmux -V", /tmux \d/],
    ["less", "less --version | head -n 1", /less \d+/],
    ["dosbox-pure", "dosbox-pure --info", /CPU: x86 interpreter/],
  ] as const) {
    if (!manifest!.packages.includes(pkg)) continue;
    expect((await runTerminalCommand(page, command)).output).toMatch(expected);
  }
  // This suite accepts any selected package set. Presence must follow the
  // manifest; assuming ffmpeg is absent rejects valid graphics partials.
  const ffmpeg = (await runTerminalCommand(page, "command -v ffmpeg || echo NO_FFMPEG")).output;
  if (manifest!.packages.includes("ffmpeg")) expect(ffmpeg).toMatch(/\/usr\/bin\/ffmpeg/);
  else expect(ffmpeg).toContain("NO_FFMPEG");

  // The activity list is the image's own: exactly the activities it kept.
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  const panel = page.getByRole("region", { name: "Installed activities" });
  for (const activity of manifest!.activities.filter((id) => id !== "shell")) {
    await expect(panel.locator(`[data-image-activity="${activity}"]`)).toBeVisible();
  }
  for (const absent of ["quake", "scummvm", "freeciv", "ffplay"]) {
    if (!manifest!.activities.includes(absent)) {
      await expect(panel.locator(`[data-image-activity="${absent}"]`)).toHaveCount(0);
    }
  }

  await page.screenshot({ path: test.info().outputPath("partial-image-activities.png") });

  // Nothing the partial route served went into Cache Storage.
  expect((await cachedUrls(page)).filter((url) => url.includes("@kandelo-partial"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("the installed partial shell preserves its files through a shared OPFS upgrade and app restart", async ({ page }) => {
  test.skip(manifest?.image !== "shell", "checks the built shell's filesystem capacity");
  test.setTimeout(240_000);
  const selectedKernel = process.env.KANDELO_KIFS_BENCH_KERNEL;
  const kernel = readFileSync(selectedKernel ?? resolveBinary("kernel.wasm"));
  const kernelBytes = kernel.toString("base64");
  if (selectedKernel !== undefined) {
    // A persistent profile can route assets through its service worker before
    // Playwright sees them. Pin the bytes at the app's kernel asset request.
    await page.addInitScript(encoded => {
      const fetchAsset = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        if (url.origin !== location.origin || !/\/(?:kandelo[-_])?kernel\.wasm$/.test(url.pathname)) {
          return fetchAsset(input, init);
        }
        const loads = Number(sessionStorage.getItem("kifs-qualification-kernel-loads") ?? "0");
        sessionStorage.setItem("kifs-qualification-kernel-loads", String(loads + 1));
        const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        return Promise.resolve(new Response(bytes, { headers: { "content-type": "application/wasm" } }));
      };
    }, kernelBytes);
  }
  const name = `partial-inodes-${crypto.randomUUID()}`;
  const search = new URLSearchParams({
    vfs: PARTIAL_URL,
    profile: "shell",
    experimentalPersistence: name,
    experimentalPersistenceMode: "resizable",
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Each visit to this test-only named computer confirms persistence access.
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`/?${search}`);
  try {
    await ready(page);
  } catch (error) {
    const pageText = await page.locator("body").innerText();
    throw new Error(`Partial shell boot at ${page.url()} failed\n${errors.join("\n")}\n${pageText}`, { cause: error });
  }
  const stats = await runTerminalCommand(page, `set -eu
df -Pk / | tail -n 1
printf 'LOGIN %s %s %s\n' "$(id -u)" "$(id -g)" "$HOME"`);
  expect(stats.exitCode, stats.output).toBe(0);
  expect(stats.output).toMatch(/\s1048576\s/);
  const login = /LOGIN (\d+) (\d+) (\/[^\s]+)/.exec(stats.output);
  expect(login).toBeTruthy();

  // Use the same composed package base and manifest metadata to install a
  // separate legacy computer. The first normal app visit above covered a new
  // computer. The next visit must migrate an already initialized, used one.
  const legacyName = `partial-saved-${crypto.randomUUID()}`;
  search.set("experimentalPersistence", legacyName);
  const appUrl = new URL("/?" + search, page.url()).href;
  await page.goto("/trap-signal-test.html");
  const identity = await page.evaluate(async ({ name, legacyName, uid, gid, home, hostUrl, imageUrl, lazyUrl, kernelBytes }) => {
    const { BrowserKernel } = await import(hostUrl);
    const api = await import(imageUrl);
    const { imageOwnedLazyAssetDirectory } = await import(lazyUrl);
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
    const manifest = JSON.parse(await (await (await parent.getFileHandle(name + ".base.json")).getFile()).text());
    const installed = await api.loadFixedPersistenceImageHandle(name, manifest.identity);
    if (!installed?.journalInitialized) throw new Error("app did not commit the new computer");
    const kernelWasm = Uint8Array.from(atob(kernelBytes), char => char.charCodeAt(0)).buffer;
    const lazyAssetDirectory = imageOwnedLazyAssetDirectory(installed.lazyAssets);
    const reader = new BrowserKernel({ kernelOwnedFs: true });
    let raw: Uint8Array;
    try {
      await reader.initFromOpfsImage({ kernelWasm, lazyAssetDirectory, vfsImageFile: installed.file, persistentImageBinding: installed.persistentImageBinding });
      raw = await reader.exportRootfsImage();
    } finally { await reader.destroy(); }
    function* chunks() {
      for (let offset = 0; offset < raw.length; offset += 65536) yield raw.subarray(offset, offset + 65536);
    }
    const legacy = await api.saveFixedPersistenceImageStream(legacyName, manifest.identity,
      { chunks: chunks(), payloadLength: raw.length, integrityPolicy: installed.integrityPolicy },
      installed.lazyAssets, installed.composition);
    let output = "";
    const capture = (data: Uint8Array) => { output += new TextDecoder().decode(data); };
    const host = new BrowserKernel({ kernelOwnedFs: true, onStdout: capture, onStderr: capture });
    try {
      await host.initFromOpfsImage({ kernelWasm, lazyAssetDirectory, vfsImageFile: legacy.file, persistentImageBinding: legacy.persistentImageBinding,
        persistentComputerName: legacyName, experimentalResizablePersistenceName: legacy.journalName, kifsUpgradeProfile: "legacy" });
      const bash = await host.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-c", `set -eu
export PATH=/bin:/usr/bin
cd "$1"
printf 'persisted through upgrade\n' > kifs-saved-marker
ln kifs-saved-marker kifs-saved-alias
sync
stat -c 'SAVED_INODE %i %h %a %u %g' kifs-saved-marker
df -Pk / | tail -n 1`, "bash", home], { uid, gid });
      const code = await bash.exit;
      if (code !== 0 || !/\s524288\s/.test(output)) throw new Error(`legacy shell seed failed (${code}): ${output}`);
      await api.markFixedPersistenceJournalInitialized(legacyName, manifest.identity, legacy);
    } finally { await host.destroy(); }
    if (host.getPersistenceShutdownFailure()) throw new Error(host.getPersistenceShutdownFailure());
    const match = /SAVED_INODE [0-9 ]+/.exec(output);
    if (!match) throw new Error("missing saved inode identity: " + output);
    return match[0].trim();
  }, { name, legacyName, uid: Number(login![1]), gid: Number(login![2]), home: login![3]!,
    kernelBytes, hostUrl: "/@fs/" + resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts"),
    lazyUrl: "/@fs/" + resolve(import.meta.dirname, "../lib/init/image-owned-runtime-urls.ts"),
    imageUrl: "/@fs/" + resolve(import.meta.dirname, "../pages/kandelo/kernel-host/fixed-persistence-image.ts") });
  await page.goto(appUrl);
  const status = page.locator(".kdock-status-text");
  await expect(status).toHaveAttribute("data-status", /^(running|error)$/, { timeout: 120_000 });
  if (await status.getAttribute("data-status") === "error") {
    throw new Error("Activated shell boot failed: " + await page.locator("body").innerText());
  }
  await ready(page);
  const restored = await runTerminalCommand(page, `set -eu
cd "$HOME"
test "$(cat kifs-saved-alias)" = "persisted through upgrade"
stat -c 'SAVED_INODE %i %h %a %u %g' kifs-saved-marker kifs-saved-alias
df -Pk / | tail -n 1`);
  expect(restored.exitCode, restored.output).toBe(0);
  expect(restored.output.split(identity!).length - 1).toBe(2);
  expect(restored.output).toMatch(/\s1048576\s/);

  await page.goto("/trap-signal-test.html");
  await page.evaluate(async ({ legacyName, imageUrl }) => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("kandelo-persistent-overlay");
    const manifest = JSON.parse(await (await (await parent.getFileHandle(legacyName + ".base.json")).getFile()).text());
    const copies = [];
    for (const suffix of ["activation0", "activation1"]) {
      const name = manifest.journalName + "." + suffix;
      copies.push({ name, bytes: await (await (await parent.getFileHandle(name)).getFile()).arrayBuffer() });
      await parent.removeEntry(name);
    }
    let refused = false;
    try {
      await (await import(imageUrl)).loadFixedPersistenceImageHandle(legacyName, manifest.identity);
    } catch (error) {
      if (!String(error).includes("Cannot prove the latest writable journal generation")) throw error;
      refused = true;
    } finally {
      for (const { name, bytes } of copies) {
        const writer = await (await parent.getFileHandle(name, { create: true })).createWritable();
        await writer.write(bytes);
        await writer.close();
      }
    }
    if (!refused) throw new Error("manifest accepted the computer after both activation controls were lost");
    let retired = false;
    try { await parent.getFileHandle(manifest.journalName + ".journal"); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      retired = true;
    }
    if (!retired) throw new Error("confirmed migration retained its owned legacy journal");
  }, { legacyName, imageUrl: "/@fs/" + resolve(import.meta.dirname, "../pages/kandelo/kernel-host/fixed-persistence-image.ts") });
  search.set("experimentalKifsV3", "0");
  await page.goto("/?" + search);
  await ready(page);
  const reopened = await runTerminalCommand(page, 'stat -c "SAVED_INODE %i %h %a %u %g" "$HOME/kifs-saved-alias"');
  expect(reopened.exitCode, reopened.output).toBe(0);
  expect(reopened.output).toContain(identity);
  if (selectedKernel !== undefined) {
    const loads = await page.evaluate(() => Number(sessionStorage.getItem("kifs-qualification-kernel-loads")));
    expect(loads).toBeGreaterThanOrEqual(3);
  }
});

test("the gallery lists the partial image first, by what it carries", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(`/?vfs=${encodeURIComponent(PARTIAL_URL)}`);
  await expect(page.locator(".kdock-status-text")).toHaveAttribute("data-status", "running", { timeout: 300_000 });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "+ New computer", exact: true }).click();
  const named = manifest!.packages.length === 0 ? "the base only" : manifest!.packages.join(", ");
  await expect(page.getByText(`Partial ${manifest!.image} + ${named}`).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("partial-image-gallery.png") });
});
