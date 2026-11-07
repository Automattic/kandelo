import { expect, test } from "../playwright-test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { dosSmokeImage } from "../../../packages/registry/dosbox-pure/test/fixtures";
import { dosPcSpeakerExecutable } from "./support/dos-program";

type ToneMeasurement = { time: number; underruns: number; energy: number; samples: number; zeroRun: number };

// Observe the production processor's output and detached counters. Neither
// guest address spaces nor transport views leave its disposable worklet realm.
const observeTone = `
const processTone = KandeloPcmProcessor.prototype.process;
KandeloPcmProcessor.prototype.process = function(inputs, outputs) {
  const result = processTone.call(this, inputs, outputs);
  const p = this.toneProbe ??= { blocks: 0, energy: 0, samples: 0, zeroRun: 0, currentZero: 0 };
  for (const value of outputs[0]?.[0] ?? []) {
    p.energy += value * value; p.samples++;
    p.currentZero = value === 0 ? p.currentZero + 1 : 0;
    p.zeroRun = Math.max(p.zeroRun, p.currentZero);
  }
  if (++p.blocks % 128 === 0 && this.words) {
    this.port.postMessage({ type: "dos-tone", time: currentTime,
      underruns: Atomics.load(this.words, this.layout.underruns) >>> 0,
      energy: p.energy, samples: p.samples, zeroRun: p.zeroRun });
    p.energy = p.samples = p.zeroRun = 0;
  }
  return result;
};`;

test("DOSBox delivers a continuous PC-speaker tone without recurring playback gaps", async ({ page, baseURL, browserName }) => {
  test.skip(browserName === "firefox" && process.platform === "darwin",
    "this plain AudioContext fixture does not establish running playback on macOS Firefox; full-machine activation is covered by the memory gate");
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const state = window as any;
    state.__dosToneMeasurements = [];
    const Native = AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        this.port.addEventListener("message", event => {
          if (event.data?.type === "dos-tone") state.__dosToneMeasurements.push(event.data);
        });
        this.port.start();
      }
    };
  });
  await page.route("**/__dos_kernel", route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route("**/__dos_image", async route => route.fulfill({ body: Buffer.from(await dosSmokeImage()) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const moduleUrl = (path: string) => new URL(`/@fs/${fileURLToPath(new URL(path, import.meta.url))}`, baseURL).href;
  try {
    await page.evaluate(async ({ kernelUrl, source, tone }) => {
      const { BrowserKernel } = await import(kernelUrl);
      const state = (window as any).__dosTone = { kernel: null as any, child: null as any, url: "", stderr: "" };
      state.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const kernel = state.kernel = new BrowserKernel({ kernelOwnedFs: true, audioWorkletUrl: state.url,
        onStderr: (bytes: Uint8Array) => { state.stderr += new TextDecoder().decode(bytes); } });
      await kernel.initFromImage({ kernelWasm: await (await fetch("/__dos_kernel")).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch("/__dos_image")).arrayBuffer()) });
      await kernel.writeFileToVfs("/games/TONE.EXE", Uint8Array.from(tone));
      await kernel.prepareAudio();
      const button = document.createElement("button"); button.textContent = "Start audio";
      button.onclick = () => { kernel.resumeAudio().catch((error: unknown) => { state.stderr += String(error); }); };
      document.body.replaceChildren(button);
      state.child = await kernel.spawnFromVfs("/usr/bin/dosbox-pure", ["dosbox-pure", "/games/TONE.EXE"],
        { uid: 1000, gid: 1000, env: ["HOME=/home/player"] });
      state.child.exit.catch(() => {});
    }, { kernelUrl: moduleUrl("../../../host/src/browser-kernel-host.ts"),
      source: readFileSync(fileURLToPath(new URL("../../../host/src/audio/pcm-audio-worklet.js", import.meta.url)), "utf8") + observeTone,
      tone: Array.from(dosPcSpeakerExecutable()) });
    await page.getByRole("button", { name: "Start audio", exact: true }).click();
    const measurements = () => page.evaluate(() => (window as any).__dosToneMeasurements as ToneMeasurement[]);
    await expect.poll(async () => (await measurements()).some(m => m.energy / m.samples > 0.001),
      { timeout: 30_000 }).toBe(true);
    const firstTime = (await measurements()).at(-1)!.time;
    await expect.poll(async () => (await measurements()).at(-1)!.time, { timeout: 30_000 }).toBeGreaterThan(firstTime + 8);
    const stable = (await measurements()).filter(m => m.time > firstTime + 2);
    await test.info().attach("pc-speaker-continuity", { body: JSON.stringify(stable), contentType: "application/json" });
    expect(stable.length).toBeGreaterThan(10);
    expect(stable.at(-1)!.underruns - stable[0].underruns).toBeLessThanOrEqual(2);
    expect(Math.max(...stable.map(m => m.zeroRun))).toBeLessThan(64);
    expect(stable.every(m => m.energy / m.samples > 0.001)).toBe(true);
    const result = await page.evaluate(async () => {
      const s = (window as any).__dosTone;
      await s.kernel.signalProcess(s.child.pid, 15);
      return { exit: await s.child.exit, stderr: s.stderr };
    });
    expect(result.exit, result.stderr).toBe(0);
  } finally {
    await page.evaluate(async () => { const s = (window as any).__dosTone;
      await s?.kernel?.destroy(); if (s?.url) URL.revokeObjectURL(s.url); }).catch(() => {});
  }
});
