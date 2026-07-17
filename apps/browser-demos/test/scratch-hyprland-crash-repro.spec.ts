import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, writeFileSync } from "node:fs";

// SCRATCH observational repro (uncommitted). Goal: capture the REAL crash
// signal for CTRL+2, CTRL+K x7, CTRL+W x2 the way a user actually drives it —
// staying on the Demo surface, individual rapid key presses, back-to-back
// closes — and dump console/pageerror/crash + full .ksys syslog to disk.

const OUT = "/tmp/hyprland-repro";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function syslogText(page: Page): Promise<string> {
  const lines = await page.locator(".ksys-line").allInnerTexts();
  return lines.join("\n");
}
async function syslogStream(page: Page): Promise<string> {
  const msgs = await page.locator(".ksys-line .ksys-msg").allInnerTexts();
  return msgs.join("");
}
async function openSurface(page: Page, label: string) {
  const btn = page.locator("button.kmachine-switch-btn", { hasText: label });
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click();
}

// Press a modified key the way a browser delivers it: modifier down, key
// down+up, modifier up. delayMs spaces successive presses like a human.
async function chord(page: Page, key: string) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
}

test("SCRATCH repro: CTRL+2, CTRL+K x7, CTRL+W x2 on the Demo surface", async ({ page }) => {
  test.setTimeout(300_000);

  const events: string[] = [];
  const kernelLog: string[] = [];
  const stamp = () => `+${Math.round(process.hrtime()[0])}s`;
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    // Kernel debug ring (host_debug_log -> console.log("[KERNEL] ...")) carries
    // the BODBG bo-registry trace from the instrumented kernel.
    if (txt.includes("BODBG") || txt.includes("[KERNEL]")) {
      kernelLog.push(txt);
      return;
    }
    if (t === "error" || t === "warning") events.push(`[console.${t}] ${txt}`);
  });
  page.on("pageerror", (e) => events.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`));
  page.on("crash", () => events.push(`[PAGE CRASH] ${stamp()}`));
  page.on("worker", (w) => {
    events.push(`[worker created] ${w.url()}`);
    w.on("close", () => events.push(`[WORKER CLOSED] ${w.url()}`));
  });

  await page.goto(appUrl("/?demo=hyprland"), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (await page.locator("vite-error-overlay").count()) {
    test.skip(true, "Required binary not built - Vite import error");
  }

  // Boot.
  await openSurface(page, "Internals");
  await expect.poll(() => syslogText(page), { timeout: 180_000 }).toMatch(/running wlterm/);
  await expect.poll(() => syslogStream(page), { timeout: 120_000 }).toMatch(/CLIENT_CONNECTED count=3/);
  await expect.poll(() => syslogStream(page), { timeout: 120_000 }).toMatch(/TILE n=3 i=2 /);

  const bootLog = await syslogText(page);
  writeFileSync(`${OUT}-boot.log`, bootLog);

  // Now drive it EXACTLY like the user: on the Demo surface, no surface
  // switches between presses, rapid cadence, back-to-back closes.
  await openSurface(page, "Demo");
  await page.locator("body").click({ position: { x: 5, y: 5 } });

  // CTRL+2 -> empty workspace 2
  await chord(page, "2");
  await page.waitForTimeout(120);

  // CTRL+K x7, rapid (human-ish 90ms spacing), all on Demo
  for (let i = 0; i < 7; i++) {
    await chord(page, "KeyK");
    await page.waitForTimeout(90);
  }

  // Give the launch storm a beat to tile, then close two, back to back.
  await page.waitForTimeout(400);
  await chord(page, "KeyW");
  await page.waitForTimeout(60);
  await chord(page, "KeyW");

  // Liveness window: let it run 4s while we watch whether the canvas / syslog
  // keep advancing (a crash freezes both).
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  let sizes: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    try {
      sizes.push((await canvas.screenshot()).byteLength);
    } catch (e) {
      events.push(`[canvas screenshot threw] ${String(e)}`);
      sizes.push(-1);
    }
  }

  await openSurface(page, "Internals");
  await page.waitForTimeout(1000);
  const finalLog = await syslogText(page);
  writeFileSync(`${OUT}-final.log`, finalLog);
  writeFileSync(`${OUT}-events.log`, events.join("\n") + "\n");
  writeFileSync(`${OUT}-canvas-sizes.log`, JSON.stringify(sizes));
  writeFileSync(`${OUT}-kernel-bodbg.log`, kernelLog.join("\n") + "\n");

  // Smoking gun: which bo_id(s) fail to map, and the decref that removed them.
  const missIds = [
    ...new Set(
      kernelLog
        .filter((l) => l.includes("MMAP-EINVAL"))
        .map((l) => (l.match(/bo_id=(\d+)/) ?? [])[1])
        .filter(Boolean),
    ),
  ];
  console.log(`\n===== BO-REGISTRY SMOKING GUN =====`);
  console.log(`failing (unmappable) bo_id(s): ${JSON.stringify(missIds)}`);
  for (const id of missIds) {
    const lifeline = kernelLog.filter((l) => new RegExp(`\\bid=${id}\\b|bo_id=${id}\\b`).test(l));
    console.log(`\n--- lifeline of bo_id=${id} (${lifeline.length} events) ---`);
    console.log(lifeline.join("\n"));
  }
  console.log(`\n--- all decref-MISS / DOUBLE-DECREF events ---`);
  console.log(kernelLog.filter((l) => l.includes("DOUBLE-DECREF")).join("\n") || "(none)");
  console.log(`===================================\n`);

  // Report signal to the run output (don't hard-fail yet — this is observational).
  const gbm = (finalLog.match(/gbm_bo_map failed|gbm_bo_import/g) ?? []).length;
  const invalidShm = /invalid arguments for wl_shm/.test(finalLog);
  const commErr = /error in client communication/.test(finalLog);
  const setupFail = /hyprland failed|wlcompositor failed|wlclock failed|wlterm failed/.test(finalLog);
  console.log(`\n===== REPRO SIGNAL =====`);
  console.log(`page crash / worker closed / pageerror events: ${events.filter((e) => /CRASH|CLOSED|pageerror/.test(e)).length}`);
  console.log(`gbm failures: ${gbm}`);
  console.log(`invalid wl_shm: ${invalidShm}  commErr: ${commErr}  setupFail: ${setupFail}`);
  console.log(`canvas sizes over 4s: ${JSON.stringify(sizes)}`);
  console.log(`events:\n${events.join("\n")}`);
  console.log(`========================\n`);

  // === HARD LIVENESS ASSERTIONS (this is what the old geometry/string gate missed) ===
  // 1. The compositor must not be flooding gbm_bo_map failures — a single one
  //    means the GPU->CPU fallback tripped and the scanout bo can't be mapped.
  expect(gbm, "compositor flooded gbm_bo_map failures after the closes (frozen desktop)")
    .toBe(0);
  // 2. The canvas must still be advancing after the two closes: a live desktop
  //    keeps recompositing (blinking wlclocks), so consecutive screenshots differ.
  //    A frozen desktop yields an identical byteLength every sample.
  const distinct = new Set(sizes.filter((n) => n > 0)).size;
  expect(distinct, `canvas frozen after closes (identical byteLength x${sizes.length}: ${JSON.stringify(sizes)})`)
    .toBeGreaterThan(1);
});
