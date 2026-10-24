import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("primed audio clocks do not retain kernel transports before explicit demand", async ({ page, baseURL }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async urls => {
    const { BrowserPcmDriver } = await import(urls.driver);
    const { createPcmTransport } = await import(urls.helper);
    const NativeContext = globalThis.AudioContext;
    let contexts = 0;
    let nodes = 0;
    let detached = 0;
    globalThis.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) { super(options); contexts += 1; }
    };
    const makeDriver = () => new BrowserPcmDriver({ workletUrl: urls.worklet,
      createNode(context: AudioContext, name: string, options: AudioWorkletNodeOptions) {
        if (Object.hasOwn(options.processorOptions, "buffer")) throw new Error("remote node received shared storage on main");
        nodes += 1;
        const node = new AudioWorkletNode(context, name, options);
        node.port.addEventListener("message", event => {
          if (event.data?.type === "detached") detached += 1;
        });
        return node;
      },
    });
    try {
      for (let machine = 0; machine < 3; machine += 1) {
        const idle = makeDriver();
        idle.prepareContext();
        await idle.close();
      }
      const beforeDemand = { contexts, nodes, detached };
      const active = makeDriver();
      active.prepareContext();
      const connection = new MessageChannel();
      let attached = 0;
      connection.port1.onmessage = event => {
        if (event.data?.type === "attach") {
          attached += 1;
          connection.port1.postMessage(createPcmTransport());
        }
      };
      try {
        await active.prepareRemote(connection.port2);
        await active.close();
      } finally {
        connection.port1.close();
        connection.port2.close();
      }
      return { beforeDemand, afterDemand: { contexts, nodes, detached }, attached, state: active.getState() };
    } finally { globalThis.AudioContext = NativeContext; }
  }, {
    driver: new URL(`/@fs/${resolve("../../host/src/audio/browser-pcm-driver.ts")}`, baseURL).href,
    helper: new URL(`/@fs/${resolve("../../host/test/pcm-test-helpers.ts")}`, baseURL).href,
    worklet: new URL(`/@fs/${resolve("../../host/src/audio/pcm-audio-worklet.js")}`, baseURL).href,
  });
  expect(result).toEqual({ beforeDemand: { contexts: 1, nodes: 0, detached: 0 },
    afterDemand: { contexts: 1, nodes: 1, detached: 1 }, attached: 1, state: "closed" });
});

test("PCM preparation retires a real worklet after connection refusal", async ({ page, baseURL }) => {
  await page.goto("/trap-signal-test.html");
  const result = await page.evaluate(async urls => {
    const { BrowserPcmDriver } = await import(urls.driver);
    const { createPcmTransport } = await import(urls.helper);
    const detached: boolean[] = [];
    const driver = new BrowserPcmDriver({ workletUrl: urls.worklet,
      createNode(context: AudioContext, name: string, options: AudioWorkletNodeOptions) {
        const node = new AudioWorkletNode(context, name, options);
        node.port.addEventListener("message", event => {
          if (event.data?.type === "detached") detached.push(true);
        });
        node.connect = () => { throw new Error("injected connection refusal"); };
        return node;
      },
    });
    let failure = "";
    try {
      await driver.prepare(createPcmTransport());
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      await driver.close();
    }
    return { failure, detached, state: driver.getState() };
  }, {
    driver: new URL(`/@fs/${resolve("../../host/src/audio/browser-pcm-driver.ts")}`, baseURL).href,
    helper: new URL(`/@fs/${resolve("../../host/test/pcm-test-helpers.ts")}`, baseURL).href,
    worklet: new URL(`/@fs/${resolve("../../host/src/audio/pcm-audio-worklet.js")}`, baseURL).href,
  });
  expect(result).toEqual({ failure: "injected connection refusal", detached: [true], state: "closed" });
});

for (const state of ["suspended", "running", "fresh-running", "settled", "contended"] as const) {
  test(`PCM worklets release each transport while ${state}`, async ({ page, baseURL, browserName }) => {
    test.skip(state !== "suspended" && browserName === "firefox" && process.platform === "darwin",
      "pinned macOS Firefox leaves plain AudioContext.resume pending even after a trusted click; suspended detach remains covered");
    await page.goto("/trap-signal-test.html");
    const urls = {
      driver: new URL(`/@fs/${resolve("../../host/src/audio/browser-pcm-driver.ts")}`, baseURL).href,
      helper: new URL(`/@fs/${resolve("../../host/test/pcm-test-helpers.ts")}`, baseURL).href,
      worklet: new URL(`/@fs/${resolve("../../host/src/audio/pcm-audio-worklet.js")}`, baseURL).href,
      transport: new URL(`/@fs/${resolve("../../host/src/audio/pcm-transport.ts")}`, baseURL).href,
      contended: state === "contended",
      freshRunning: state === "fresh-running",
    };
    await page.evaluate(async urls => {
      const { BrowserPcmDriver } = await import(urls.driver);
      const { createPcmTransport } = await import(urls.helper);
      const { PCM_CONTROL, pcmControlWords, storeU32 } = await import(urls.transport);
      const contexts: AudioContext[] = [];
      const detached: number[] = [];
      let driver: InstanceType<typeof BrowserPcmDriver> | undefined;
      let resumeError: string | null = null;
      const prepare = async (generation: number) => {
        driver = new BrowserPcmDriver({
          workletUrl: urls.worklet,
          createNode(context: AudioContext, name: string, options: AudioWorkletNodeOptions) {
            contexts.push(context);
            const node = new AudioWorkletNode(context, name, options);
            node.port.addEventListener("message", event => {
              if (event.data?.type === "detached") detached.push(generation);
            });
            return node;
          },
        });
        const transport = createPcmTransport();
        if (urls.contended) storeU32(pcmControlWords(transport), PCM_CONTROL.producerSeq, 1);
        await driver.prepare(transport);
        if (!urls.freshRunning) await driver.suspend();
        return driver.getState();
      };
      const button = document.createElement("button");
      button.textContent = "Resume transport";
      button.onclick = () => { void driver!.resume().catch((error: Error) => { resumeError = error.message; }); };
      document.body.append(button);
      (window as any).__pcmLifecycle = {
        prepare,
        async close() { await driver!.close(); },
        async settle() { await driver!.settleOutputPipeline(); },
        snapshot() {
          return { detached, state: driver!.getState(), resumeError,
            sharedContext: contexts.every(context => context === contexts[0]),
            contextState: contexts[0]?.state };
        },
      };
    }, urls);
    for (let generation = 0; generation < 3; generation += 1) {
      await page.evaluate(generation => (window as any).__pcmLifecycle.prepare(generation), generation);
      if (state !== "suspended") {
        await page.getByRole("button", { name: "Resume transport" }).click();
        await expect.poll(() => page.evaluate(() => (window as any).__pcmLifecycle.snapshot()))
          .toMatchObject({ state: "running", resumeError: null });
      }
      if (state === "settled") {
        await page.evaluate(() => (window as any).__pcmLifecycle.settle());
        expect(await page.evaluate(() => (window as any).__pcmLifecycle.snapshot()))
          .toMatchObject({ state: "suspended", contextState: "suspended" });
      }
      await page.evaluate(() => (window as any).__pcmLifecycle.close());
      const snapshot = await page.evaluate(() => (window as any).__pcmLifecycle.snapshot());
      expect(snapshot).toMatchObject({ detached: Array.from({ length: generation + 1 }, (_, index) => index),
        state: "closed", sharedContext: true, resumeError: null });
      if (state !== "running") expect(snapshot.contextState).toBe("suspended");
    }
  });
}
