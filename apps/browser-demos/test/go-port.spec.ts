import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixtureDir = resolve(here, "../../../.context/go-browser");
const browserKernelModulePath = resolve(repoRoot, "host/src/browser-kernel-host.ts");

type ProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  hostDiagnostics: unknown[];
};

type Probe = {
  name: string;
  file: string;
  argv: string[];
  stdout: string[];
  threadMarkers?: number;
  env?: string[];
  dataFiles?: { path: string; data: number[] }[];
};

const probes: Probe[] = [
  {
    name: "stdlib, startup metadata, and file syscalls",
    file: "basic.wasm",
    argv: ["go-basic", "alpha", "beta"],
    stdout: ["GO BASIC PASS"],
    env: ["KANDELO_GO_BROWSER=present"],
    dataFiles: [{
      path: "/etc/go-browser-input",
      data: Array.from(Buffer.from("browser fixture\n")),
    }],
  },
  {
    name: "second-M bootstrap and per-M syscall channel",
    file: "second-m.wasm",
    argv: ["go-second-m"],
    stdout: ["M1: before spawn", "M1: after spawn"],
    threadMarkers: 1,
  },
  {
    name: "five sequential clone handoffs and arena slots",
    file: "clone-handoff.wasm",
    argv: ["go-clone-handoff"],
    stdout: ["M1: before spawn", "M1: after spawn"],
    threadMarkers: 5,
  },
  {
    name: "parallel goroutines on two scheduler Ms",
    file: "scheduler.wasm",
    argv: ["go-scheduler"],
    stdout: ["GOMAXPROCS: 2", "parallel M: complete"],
  },
  {
    name: "concurrent clone handoffs from two scheduler Ms",
    file: "concurrent-clone.wasm",
    argv: ["go-concurrent-clone"],
    stdout: ["parallel clone handoffs: complete"],
    threadMarkers: 4,
  },
  {
    name: "LockOSThread keeps a goroutine on one M until unlock",
    file: "locked-thread.wasm",
    argv: ["go-locked-thread"],
    stdout: ["locked worker affinity: complete"],
  },
  {
    name: "locked M exits and reuses thread slots across twelve rounds",
    file: "locked-exit.wasm",
    argv: ["go-locked-exit"],
    stdout: ["locked worker exit and slot reuse: complete"],
  },
  {
    name: "sysmon preempts a CPU-bound goroutine for a timer",
    file: "sysmon.wasm",
    argv: ["go-sysmon"],
    stdout: ["sysmon cooperative preemption: complete"],
  },
  {
    name: "process exit from a worker M",
    file: "exit-worker.wasm",
    argv: ["go-exit-worker"],
    stdout: ["worker M: exiting process"],
  },
];

async function runProbe(page: Page, baseURL: string, probe: Probe): Promise<ProbeResult> {
  const programUrl = new URL("/__kandelo_go_probe__.wasm", baseURL).href;
  const kernelUrl = new URL("/__kandelo_go_kernel__.wasm", baseURL).href;
  const browserKernelUrl = new URL(`/@fs/${browserKernelModulePath}`, baseURL).href;
  await page.route(programUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: readFileSync(resolve(fixtureDir, probe.file)),
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: readFileSync(resolveBinary("kernel.wasm")),
  }));
  const image = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  image.mkdir("/etc", 0o755);
  for (const file of probe.dataFiles ?? []) {
    image.createFileWithOwner(file.path, 0o644, 0, 0, new Uint8Array(file.data));
  }
  const vfsImage = Array.from(await image.saveImage());
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  return page.evaluate(async ({ programUrl, kernelUrl, browserKernelUrl, argv, env, vfsImage }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
    const [programResponse, kernelResponse] = await Promise.all([
      fetch(programUrl),
      fetch(kernelUrl),
    ]);
    if (!programResponse.ok || !kernelResponse.ok) {
      throw new Error(`Go fixture fetch failed: program=${programResponse.status}, kernel=${kernelResponse.status}`);
    }
    const [programBytes, kernelWasm] = await Promise.all([
      programResponse.arrayBuffer(),
      kernelResponse.arrayBuffer(),
    ]);
    if (!WebAssembly.validate(programBytes) || !WebAssembly.validate(kernelWasm)) {
      throw new Error("Go program or kernel is not valid WebAssembly");
    }
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    const hostDiagnostics: unknown[] = [];
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data: Uint8Array) => { stdout += decoder.decode(data); },
      onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
      onHostDiagnostic: (diagnostic: unknown) => { hostDiagnostics.push(diagnostic); },
    });
    try {
      await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(vfsImage) });
      const exitCode = await kernel.spawn(programBytes, argv, { env });
      return { exitCode, stdout, stderr, hostDiagnostics };
    } finally {
      await kernel.destroy();
    }
  }, {
    programUrl,
    kernelUrl,
    browserKernelUrl,
    argv: probe.argv,
    env: probe.env,
    vfsImage,
  });
}

test.describe("native Go port milestones in Chromium", () => {
  test.skip(
    process.env.KANDELO_GO_BROWSER_TESTS !== "1",
    "Build the Go fork fixtures and set KANDELO_GO_BROWSER_TESTS=1",
  );

  for (const probe of probes) {
    test(probe.name, async ({ page, baseURL, browserName }) => {
      test.skip(browserName !== "chromium", "Go browser milestone gate uses Chromium");
      expect(baseURL).toBeTruthy();

      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") {
          runtimeErrors.push(`console: ${message.text()}`);
        }
      });

      const result = await runProbe(page, baseURL!, probe);
      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      for (const marker of probe.stdout) {
        expect(result.stdout).toContain(marker);
      }
      if (probe.threadMarkers !== undefined) {
        expect(result.stderr.match(/M2 alive via kernel_clone/g) ?? []).toHaveLength(
          probe.threadMarkers,
        );
        expect(result.stderr.replaceAll("M2 alive via kernel_clone\n", "")).toBe("");
      } else {
        expect(result.stderr).toBe("");
      }
      expect(result.hostDiagnostics).toEqual([]);
      expect(runtimeErrors).toEqual([]);
    });
  }
});
