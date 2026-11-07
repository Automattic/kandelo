import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "../playwright-test";

const installed = (page: Page) => page.evaluate(() =>
  Boolean((globalThis as any)[Symbol.for("kandelo.playwright.silent-audio")]));

test("speaker output is zero while upstream PCM stays measurable", async ({ page }) => {
  // This public HTML fixture bypasses Vite's transformIndexHtml hook. The
  // policy must come from Playwright itself, including on reused servers.
  await page.goto("/trap-signal-test.html");
  expect(await installed(page)).toBe(true);
  await page.evaluate(() => {
    const context = new AudioContext();
    const source = context.createBufferSource();
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; ++i)
      samples[i] = Math.sin(i * 440 * 2 * Math.PI / context.sampleRate) * 0.25;
    source.buffer = buffer;
    source.loop = true;
    const before = context.createAnalyser();
    source.connect(before);
    before.connect(context.destination);
    const mute = (globalThis as any)[Symbol.for("kandelo.playwright.silent-audio")]
      .mutes.get(context) as GainNode | undefined;
    // Refuse to start the signal unless the silent output is already wired.
    if (!mute || mute.gain.value !== 0) throw new Error("Test output is not muted");
    const after = context.createAnalyser();
    const probe = context.createMediaStreamDestination();
    mute.connect(after);
    after.connect(probe);
    const state = (globalThis as any).__audioPolicyProbe = { context, source, before, after, probe };
    const button = document.createElement("button");
    button.textContent = "Start silent PCM probe";
    button.onclick = async () => { await state.context.resume(); state.source.start(); };
    document.body.replaceChildren(button);
  });
  try {
    await page.getByRole("button", { name: "Start silent PCM probe" }).click();
    const peak = (which: "before" | "after") => page.evaluate((name) => {
      const analyser = (globalThis as any).__audioPolicyProbe[name] as AnalyserNode;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.max(...data.map(Math.abs));
    }, which);
    await expect.poll(() => peak("before")).toBeGreaterThan(0.05);
    expect(await peak("after")).toBe(0);
  } finally {
    await page.evaluate(async () => {
      const state = (globalThis as any).__audioPolicyProbe;
      state.source.stop();
      state.probe.stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      await state.context.close();
    });
  }
});

test("manually created browser contexts and pages are silent by default", async ({ browser }) => {
  const context = await browser.newContext();
  const direct = await browser.newPage();
  try {
    expect(await installed(await context.newPage())).toBe(true);
    expect(await installed(direct)).toBe(true);
  } finally {
    await context.close();
    await direct.close();
  }
});

test("persistent browser profiles receive the same silent output policy", async ({ playwright, browserName }, info) => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-quiet-browser-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(directory, {
      ...info.project.use.launchOptions,
      channel: info.project.use.channel,
    });
    try { expect(await installed(context.pages()[0] ?? await context.newPage())).toBe(true); }
    finally { await context.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
