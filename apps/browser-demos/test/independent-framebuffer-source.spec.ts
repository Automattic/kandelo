import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const renderer = fileURLToPath(new URL("../../../host/src/framebuffer/index.ts", import.meta.url));
const session = process.env.R458_SESSION_SOURCE ?? fileURLToPath(new URL("../../../web-libs/kandelo-session/src/kernel-host.ts", import.meta.url));

declare global {
  interface Window {
    __independentFrame: { canvas: HTMLCanvasElement; registry: import("../../../host/src/framebuffer/registry").FramebufferRegistry; stop(): void };
    __restart: { host: import("../../../web-libs/kandelo-session/src/kernel-host").LiveKernelHost;
      spawns: Array<{ path: string; argv: string[] }> };
  }
}

test("the canvas consumes independent pixels and loudly refuses a missing mirror", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");
  await page.evaluate(async url => {
    const { FramebufferRegistry, attachCanvas } = await import(/* @vite-ignore */ url);
    const registry = new FramebufferRegistry();
    registry.bind({ pid: 7, addr: 0, len: 0, w: 1, h: 1, stride: 4, fmt: "BGRA32" });
    registry.fbWrite(7, 0, new Uint8Array([1, 2, 3, 0]));
    const canvas = document.createElement("canvas"); document.body.append(canvas);
    const stop = attachCanvas(canvas, registry, 7);
    window.__independentFrame = { canvas, registry, stop };
  }, `/@fs${renderer}`);
  await page.waitForFunction(() => {
    const canvas = window.__independentFrame.canvas;
    const pixel = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
    return pixel[0] === 3 && pixel[1] === 2 && pixel[2] === 1 && pixel[3] === 255;
  });
  const result = await page.evaluate(async url => {
    const { FramebufferRegistry, attachCanvas } = await import(/* @vite-ignore */ url);
    const fixture = window.__independentFrame; fixture.stop();
    // Stopped ownership listeners must not retain or veto the next binding.
    fixture.registry.bind({ pid: 7, addr: 16, len: 4, w: 1, h: 1, stride: 4, fmt: "BGRA32" });
    const registry = new FramebufferRegistry();
    registry.bind({ pid: 8, addr: 16, len: 4, w: 1, h: 1, stride: 4, fmt: "BGRA32" });
    let failure = "";
    try { attachCanvas(document.createElement("canvas"), registry, 8); }
    catch (error) { failure = String(error); }
    return { failure };
  }, `/@fs${renderer}`);
  expect(result.failure).toContain("no independent pixel storage");
});

test("a terminal restart retains the program selected before its asynchronous wait", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");
  await page.clock.install();
  await page.evaluate(async url => {
    const { LiveKernelHost } = await import(/* @vite-ignore */ url);
    const spawns: Array<{ path: string; argv: string[] }> = [];
    const active = new Set<number>();
    const exits = new Map<number, (status: number) => void>();
    const kernel = {
      spawn: async () => { throw new Error("unexpected raw spawn"); },
      spawnFromVfs: async (path: string, argv: string[]) => {
        const pid = spawns.length + 1; spawns.push({ path, argv: argv.slice() }); active.add(pid);
        const exit = new Promise<number>(resolve => exits.set(pid, status => { active.delete(pid); resolve(status); }));
        return { pid, exit };
      },
      onPtyOutput() {}, ptyWrite() {}, ptyResize() {},
      terminateProcess: async (pid: number) => { exits.get(pid)?.(0); },
      enumProcs: async () => [...active].map(pid => ({ pid, ppid: 0, uid: 0, gid: 0, vsizeBytes: 0, state: "R", comm: "login", cmdline: "login" })),
    };
    const host = new LiveKernelHost({ kernel, status: "running" });
    const policy = { initial: { programPath: "/bin/first", argv: ["first"] },
      afterExit: { programPath: "/bin/chosen", argv: ["chosen"] }, shortRunThresholdMs: 0,
      initialRestartDelayMs: 31_337, maximumRestartDelayMs: 31_337 };
    host.setTerminalSessionPolicy(policy); await host.attachPty("/dev/pts/0");
    const original = window.setTimeout;
    let didSchedule!: () => void;
    const scheduled = new Promise<void>(resolve => { didSchedule = resolve; });
    // Observe the actual scheduling boundary instead of guessing how many
    // promise turns process-exit handling takes on this browser engine.
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = original(handler, timeout, ...args);
      if (timeout === 31_337) didSchedule();
      return timer;
    }) as typeof window.setTimeout;
    try { exits.get(1)!(0); await scheduled; }
    finally { window.setTimeout = original; }
    host.setTerminalSessionPolicy({ ...policy, afterExit: { programPath: "/bin/later", argv: ["later"] } });
    window.__restart = { host, spawns };
  }, `/@fs${session}`);
  await page.clock.fastForward(31_337);
  await page.waitForFunction(() => window.__restart.spawns.length === 2);
  expect(await page.evaluate(() => window.__restart.spawns[1])).toEqual({ path: "/bin/chosen", argv: ["chosen"] });
  await page.evaluate(() => window.__restart.host.detachKernel());
});


test("the reusable framebuffer consumer retains independent-storage validation", async ({ page }) => {
  await page.goto("/terminate-atomics-test.html");
  await page.evaluate(async ({ rendererUrl, sessionUrl }) => {
    const { FramebufferRegistry } = await import(/* @vite-ignore */ rendererUrl);
    const { LiveKernelHost } = await import(/* @vite-ignore */ sessionUrl);
    const registry = new FramebufferRegistry();
    registry.bind({ pid: 7, addr: 0, len: 0, w: 1, h: 1, stride: 4, fmt: "BGRA32" });
    registry.fbWrite(7, 0, new Uint8Array([1, 2, 3, 0]));
    const canvas = document.createElement("canvas"); document.body.append(canvas);
    const kernel = { framebuffers: registry, enumProcs: async () => [],
      spawn: async () => { throw new Error("not a process-launch fixture"); },
      spawnFromVfs: async () => { throw new Error("not a process-launch fixture"); },
      onPtyOutput() {}, ptyWrite() {}, ptyResize() {} };
    const host = new LiveKernelHost({ kernel, status: "running" });
    const handle = host.attachFramebuffer(canvas);
    window.__independentFrame = { canvas, registry, stop: () => { handle.close(); host.detachKernel(); } };
  }, { rendererUrl: `/@fs${renderer}`, sessionUrl: `/@fs${session}` });
  await page.waitForFunction(() => {
    const pixel = window.__independentFrame.canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
    return pixel[0] === 3 && pixel[1] === 2 && pixel[2] === 1;
  });
  const failure = await page.evaluate(() => {
    try {
      window.__independentFrame.registry.bind({ pid: 7, addr: 16, len: 4, w: 1, h: 1, stride: 4, fmt: "BGRA32" });
      return "";
    } catch (error) { return String(error); }
    finally { window.__independentFrame.stop(); }
  });
  expect(failure).toContain("no independent pixel storage");
});
