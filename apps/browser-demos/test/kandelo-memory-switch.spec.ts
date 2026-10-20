import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { gotoMachineOrSkip, previewFrame } from "./support/kandelo-machine";
import { QUAKE_ZIP_URL } from "../../../web-libs/kandelo-session/src/demo-guides";

async function launch(page: Page, title: string, profile: string): Promise<void> {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator(".kgal-row", {
    has: page.locator(".kgal-machine-title", { hasText: title }),
  }).getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`profile=${profile}(?:&|$)`), { timeout: 240_000 });
  await expect(page.locator(".kmprogress-card")).toHaveCount(0, { timeout: 240_000 });
}

async function expectGameFrame(page: Page): Promise<void> {
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await expect.poll(() => canvas.evaluate((el: HTMLCanvasElement) => {
    const bytes = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < bytes.length; i += 4) {
      colors.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
      if (colors.size > 8) break;
    }
    return colors.size;
  }), { timeout: 180_000 }).toBeGreaterThan(8);
}

test("@slow framebuffer games and WordPress survive repeated constrained-budget switches", async ({ page }) => {
  test.setTimeout(900_000);
  // This follows the same external-data boundary as the Quake demo spec.
  const archive = await fetch(QUAKE_ZIP_URL, { method: "HEAD" }).catch(() => null);
  test.skip(!archive?.ok, "Quake shareware mirror unavailable");

  await gotoMachineOrSkip(page, "doom", { search: { memoryProfile: "constrained" } });
  for (let cycle = 0; cycle < 4; cycle++) {
    if (cycle > 0) await launch(page, "fbDOOM", "doom");
    await expectGameFrame(page);
    await launch(page, "Quake (software)", "quake");
    await expectGameFrame(page);
    await launch(page, "WordPress MariaDB", "wordpress-mariadb");
    await expect(previewFrame(page, "WordPress MariaDB").locator("body"))
      .toContainText(/Hello world/i, { timeout: 240_000 });
    // PHP-FPM can answer with its first child before the static pool finishes
    // forking. Keep the site alive through that remaining startup interval.
    await page.waitForTimeout(3_000);
    await expect(previewFrame(page, "WordPress MariaDB").locator("body"))
      .toContainText(/Hello world/i);
  }
});

// Keep the engine-level regression fast and independent of demo downloads.
test("process exit escapes guest exception handlers", async ({ page, baseURL }) => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ importsUrl, abiUrl }) => {
    const { buildKernelImportsForTest, isExecRetirementMarker } = await import(/* @vite-ignore */ importsUrl);
    const { CH_SIG_SIGNUM, CH_SIG_SI_CODE } = await import(/* @vite-ignore */ abiUrl);
    const { EXEC_RETIRE_SIGNAL_CODE } = await import(/* @vite-ignore */ importsUrl.replace("worker-main.ts", "worker-protocol.ts"));
    // A Wasm try_table/catch_all returns 1 if the import's exception is catchable.
    const guest = new WebAssembly.Module(new Uint8Array([
      0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,2,13,1,4,104,
      111,115,116,4,101,120,105,116,0,0,3,2,1,1,7,7,1,3,114,117,110,0,
      1,10,23,1,21,0,2,64,31,64,1,2,0,65,137,1,16,0,11,65,0,15,11,65,1,11,
    ]));
    const runWith = (exit: CallableFunction) =>
      new WebAssembly.Instance(guest, { host: { exit } }).exports.run as () => number;
    const caught = runWith(() => { throw new WebAssembly.RuntimeError("unreachable"); })();
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const channelOffset = 64;
    const view = new DataView(memory.buffer);
    view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
    view.setUint32(channelOffset + CH_SIG_SI_CODE, EXEC_RETIRE_SIGNAL_CODE, true);
    const imports = buildKernelImportsForTest(memory, channelOffset, 4);
    let trapped = false;
    try {
      runWith(imports.kernel_exit)();
    } catch (error) {
      trapped = error instanceof WebAssembly.RuntimeError;
    }
    return { caught, trapped, marker: isExecRetirementMarker(view, channelOffset) };
  }, {
    importsUrl: new URL(`/@fs/${repoRoot}/host/src/worker-main.ts`, baseURL).href,
    abiUrl: new URL(`/@fs/${repoRoot}/host/src/generated/abi.ts`, baseURL).href,
  });
  expect(result).toEqual({ caught: 1, trapped: true, marker: true });
});
