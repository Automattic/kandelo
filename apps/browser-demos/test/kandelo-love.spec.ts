import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { gotoMachine } from "./support/kandelo-machine";
import { encodeBootDescriptor } from "../../../web-libs/kandelo-session/src/boot-descriptor";
import { createInlineBootInput } from "../../../web-libs/kandelo-session/src/boot-inputs";
import type { BootDescriptor } from "../../../web-libs/kandelo-session/src/kernel-host";

const games = [
  ["pong", "Pong"], ["snake", "Snake"], ["breakout", "Breakout"],
  ["asteroids", "Asteroids"], ["bytepath", "BYTEPATH"], ["snkrx", "SNKRX"],
] as const;

// Observe actual Web Audio samples, not just device-open diagnostics. The
// analyser receives host output only; no guest memory crosses this boundary.
async function installAudioProbe(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { loveAudioPeak: number };
    state.loveAudioPeak = 0;
    const Original = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Original {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "kandelo-pcm-output") return;
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        const silent = context.createGain();
        silent.gain.value = 0;
        this.connect(analyser);
        analyser.connect(silent);
        silent.connect(context.destination);
        const samples = new Float32Array(analyser.fftSize);
        // The test page owns this timer and graph; page teardown releases it.
        setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) state.loveAudioPeak = Math.max(state.loveAudioPeak, Math.abs(sample));
        }, 10);
      }
    };
  });
}

async function showDemo(page: Page) {
  const internals = page.getByRole("button", { name: "Internals", exact: true });
  await expect(internals).toBeVisible({ timeout: 60_000 });
  if (await internals.getAttribute("aria-pressed") === "true") await internals.click();
  await page.getByLabel("Computer views").getByRole("button", { name: "Demo", exact: true }).click();
}

async function flips(page: Page): Promise<number> {
  const text = await page.locator("body").innerText();
  return Number(text.match(/(\d+)\s*flips\s*·/i)?.[1] ?? -1);
}

async function terminalText(page: Page, game?: string): Promise<string> {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const rows = page.locator(".xterm-rows");
  await expect.poll(async () => (await rows.allTextContents()).join("\n"))
    .toContain("love: using upstream");
  // The persistent terminal renders replayed PTY output asynchronously when
  // shown. Wait for this game's command, not a previous game's renderer line.
  if (game !== undefined) {
    await expect.poll(async () => (await rows.allTextContents()).join("\n"))
      .toContain(`/usr/share/love/examples/${game}`);
  }
  return (await rows.allTextContents()).join("\n");
}

test("LÖVE menu launches all six games through the native renderer @slow", async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || /\[webgl\].*failed|GL_INVALID_|GL_OUT_OF_MEMORY|WebGL: INVALID_/.test(message.text())) {
      errors.push(message.text());
    }
  });
  await installAudioProbe(page);
  await gotoMachine(page, "love");
  await page.bringToFront();
  await showDemo(page);
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  await expect(canvas).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText(/Waiting for PAGE_FLIP on CRTC/)).toBeHidden({ timeout: 180_000 });

  const menuButton = page.getByTestId("kms-dock-action-games");
  await menuButton.click();
  const menu = page.getByTestId("kms-dock-menu-games");
  await expect(menu.getByRole("menuitem")).toHaveCount(games.length);
  for (const [id, label] of games) {
    await expect(page.getByTestId(`kms-dock-menu-entry-${id}`)).toContainText(label);
  }
  await page.keyboard.press("Escape");

  const screenshotDir = resolve("../../.context/love-browser");
  mkdirSync(screenshotDir, { recursive: true });
  // Return to Pong too, proving the last custom loop releases the display.
  for (const [index, [id]] of [...games, games[0]].entries()) {
    if (index > 0) {
      await menuButton.click();
      await page.getByTestId(`kms-dock-menu-entry-${id}`).click();
      await expect(menuButton).toBeDisabled();
      await expect(menuButton).toBeEnabled({ timeout: 180_000 });
      await expect(page.getByTestId("kms-dock-action-status")).toBeHidden({ timeout: 180_000 });
      if (await page.getByTestId("kms-dock-action-error").count()) {
        const error = await page.getByTestId("kms-dock-action-error").innerText();
        throw new Error(`${id}: ${error}\n${await terminalText(page)}`);
      }
      await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);
    }
    await expect(page.locator('[data-audio-active="true"]')).toHaveCount(1, { timeout: 120_000 });
    await expect.poll(async () => {
      if (await page.locator(".kpcm-audio-enable").isVisible()) await page.locator(".kpcm-audio-enable").click();
      return page.locator('[data-audio-state]').getAttribute("data-audio-state");
    }, { timeout: 30_000 }).toBe("running");
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => flips(page), { timeout: 120_000 }).toBeGreaterThan(0);
    // Reset after the old process has exited and the new one has rendered;
    // a drained tail from the previous game must not satisfy this assertion.
    await page.evaluate(() => { (window as typeof window & { loveAudioPeak: number }).loveAudioPeak = 0; });
    const coreIndex = ["pong", "snake", "breakout", "asteroids"].indexOf(id);
    if (coreIndex >= 0) {
      await canvas.click();
      await page.keyboard.press("Escape");
      await page.keyboard.press(String(coreIndex + 1));
    }
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { loveAudioPeak: number }).loveAudioPeak), {
      timeout: 120_000, message: `${id} must produce nonzero audio samples`,
    }).toBeGreaterThan(0.001);
    // Sustained flips prove the guest is running its loop after startup.
    const before = await flips(page);
    await expect.poll(() => flips(page), { timeout: 30_000 }).toBeGreaterThan(before + 5);
    if (id === "bytepath") {
      // Exercise the full upstream intro, including delayed text-glitch
      // callbacks, rather than stopping at its first visible frame.
      await expect.poll(() => flips(page), { timeout: 120_000 })
        .toBeGreaterThan(before + 2_000);
    }
    // BYTEPATH's upstream introduction starts dark. Require visible rendering,
    // as well as flips, before capturing the selected game's surface.
    await expect.poll(async () => (await canvas.screenshot()).byteLength, {
      timeout: 120_000, intervals: [1_000, 2_000, 5_000],
    }).toBeGreaterThan(5_000);
    await expect(page.getByTestId("kms-dock-action-error")).toHaveCount(0);
    await canvas.screenshot({ path: resolve(screenshotDir, `${id}.png`) });
    // Mount the terminal view so guest stderr is available for inspection.
    const terminal = await terminalText(page, id);
    expect(terminal, id).toContain(`/usr/share/love/examples/${id}`);
    expect(terminal, id).toContain("love: audio output via SDL2/dsp on /dev/dsp");
    expect(terminal, id).not.toMatch(/lovefb:.*(?:error|main\.lua:)|configured command failed/);
    await showDemo(page);
  }
  expect(errors).toEqual([]);
});

// Read the rendered probe, since the production canvas belongs to a worker.
async function pointerMarker(canvas: ReturnType<Page["locator"]>) {
  const bytes = await canvas.screenshot();
  return canvas.page().evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const scratch = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = scratch.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const scale = Math.min(scratch.width / 960, scratch.height / 540);
    const originX = (scratch.width - 960 * scale) / 2;
    const originY = (scratch.height - 540 * scale) / 2;
    const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
    let minX = scratch.width, maxX = -1, minY = scratch.height, maxY = -1;
    for (let y = 0; y < scratch.height; y++) {
      for (let x = 0; x < scratch.width; x++) {
        const i = (y * scratch.width + x) * 4;
        if (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: ((minX + maxX + 1) / 2 - originX) / scale,
      y: ((minY + maxY + 1) / 2 - originY) / scale };
  }, bytes.toString("base64"));
}

async function pointerProbeFragment() {
  // A real Lua consumer of the packaged engine, delivered through ordinary
  // boot inputs. No host-side coordinate hook substitutes for LÖVE's API.
  const script = `mkdir -p /tmp/love-pointer-probe
cat > /tmp/love-pointer-probe/main.lua <<'LUA'
function love.load()
  love.graphics.setBackgroundColor(0, 0, 0)
  love.mouse.setVisible(false)
end
function love.draw()
  local x, y = love.mouse.getPosition()
  local w, h = love.graphics.getDimensions()
  x = math.max(8, math.min(w - 8, x))
  y = math.max(8, math.min(h - 8, y))
  love.graphics.setColor(1, 1, 1)
  love.graphics.rectangle("fill", x - 8, y - 8, 16, 16)
end
LUA
exec /usr/local/bin/love /tmp/love-pointer-probe
`;
  return scriptFragment(script, "love-pointer-probe");
}

async function scriptFragment(script: string, id: string) {
  const descriptor: BootDescriptor = {
    version: 1, id, title: "LÖVE API probe",
    base: "kandelo:shell@abi50",
    runtime: { arch: "wasm32", kernel: "kernel@local", memoryPages: 2048, features: [], time: "real" },
    packages: [], mounts: [{ path: "/", source: "image", ref: "shell.vfs@local" }],
    boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {},
      inputs: [await createInlineBootInput({ id: "script", filename: "pointer.sh",
        bytes: new TextEncoder().encode(script), compression: "gzip" })],
      parameters: { runScript: "script" } },
  };
  return (await encodeBootDescriptor(descriptor)).fragment;
}

async function gamePoint(canvas: ReturnType<Page["locator"]>, x: number, y: number) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("LÖVE canvas is not visible");
  const scale = Math.min(box.width / 960, box.height / 540);
  return {
    x: box.x + (box.width - 960 * scale) / 2 + x * scale,
    y: box.y + (box.height - 540 * scale) / 2 + y * scale,
  };
}

test("LÖVE pointer tracks device coordinates across the playfield and CSS resize @slow", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoMachine(page, "love", { hash: await pointerProbeFragment() });
  await page.bringToFront();
  await showDemo(page);
  const canvas = page.locator(".kmachine-primary-slot:not(.is-hidden) canvas").first();
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => flips(page), { timeout: 60_000 }).toBeGreaterThan(5);
  await expect.poll(() => pointerMarker(canvas), { timeout: 60_000 }).not.toBeNull();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 920, height: 720 }]) {
    await page.setViewportSize(viewport);
    for (const [x, y] of [[200, 300], [480, 20], [760, 520], [2, 2], [957, 537]]) {
      const expected = { x: Math.max(8, Math.min(952, x)), y: Math.max(8, Math.min(532, y)) };
      await expect.poll(async () => {
        // Responsive layout may finish after setViewportSize resolves.
        // Measure the actual canvas each attempt, then observe that input.
        const point = await gamePoint(canvas, x, y);
        await page.mouse.move(point.x, point.y);
        const observed = await pointerMarker(canvas);
        return observed === null ? Infinity : Math.max(Math.abs(observed.x - expected.x), Math.abs(observed.y - expected.y));
      }, { timeout: 30_000, message: `LÖVE marker must follow pointer at ${x},${y}` }).toBeLessThan(3);
    }
  }
  const screenshotDir = resolve("../../.context/love-pointer");
  mkdirSync(screenshotDir, { recursive: true });
  await canvas.screenshot({ path: resolve(screenshotDir, "pointer-probe.png") });
});


test("LÖVE audio source controls and stream boundaries @slow", async ({ page }) => {
  test.setTimeout(180_000);
  const fragment = await scriptFragment(
    "exec /usr/local/bin/love /usr/share/love/examples/audio-check\n",
    "love-audio-api-check",
  );
  await gotoMachine(page, "love", { hash: fragment });
  await page.bringToFront();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const output = () => page.locator(".xterm-rows").allTextContents().then(rows => rows.join("\n"));
  await expect.poll(async () => {
    if (await page.locator(".kpcm-audio-enable").isVisible()) {
      await page.locator(".kpcm-audio-enable").click();
    }
    return output();
  }, { timeout: 120_000 }).toContain("love: audio API checks passed");
  expect(await output()).not.toMatch(/lovefb:.*error|configured command failed/);
});


test("SNKRX optional hand cursor preserves hover behavior on KMSDRM @slow", async ({ page }) => {
  test.setTimeout(180_000);
  // Exercise the installed game's real hover handler after its ordinary
  // engine initialization. Copy only to append the test's entry point.
  const script = `cp -R /usr/share/love/examples/snkrx /tmp/snkrx-cursor-check
cat >> /tmp/snkrx-cursor-check/main.lua <<'LUA'
local originalRun = love.run
function love.run()
  originalRun()
  local button = SteamFollowButton{group = main.current.ui, x = gw/2, y = gh/2}
  button:on_mouse_enter()
  assert(button.selected)
  button:on_mouse_exit()
  assert(not button.selected)
  print('SNKRX: cursor hover ' .. 'check passed')
  return function() return 0 end
end
LUA
exec /usr/local/bin/love /tmp/snkrx-cursor-check
`;
  await gotoMachine(page, "love", { hash: await scriptFragment(script, "snkrx-cursor-check") });
  await page.bringToFront();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const output = () => page.locator(".xterm-rows").allTextContents().then(rows => rows.join("\n"));
  await expect.poll(async () => {
    if (await page.locator(".kpcm-audio-enable").isVisible()) await page.locator(".kpcm-audio-enable").click();
    return output();
  }, { timeout: 120_000 }).toContain("SNKRX: cursor hover check passed");
  expect(await output()).not.toMatch(/lovefb:.*error|configured command failed/);
});
