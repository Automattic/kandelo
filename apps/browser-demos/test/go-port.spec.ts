import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  ABI_CONTRACT_SECTION,
  readWasmCustomSectionPayload,
} from "../../../host/src/constants";
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
  selfExecPath?: string;
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
    name: "Go account and supplementary-group lookup from VFS files",
    file: "user-basic.wasm",
    argv: ["go-user-basic"],
    stdout: ["GO USER PASS"],
    dataFiles: [
      {
        path: "/etc/passwd",
        data: Array.from(Buffer.from(
          "root:x:0:0:Root:/root:/bin/sh\ndaemon:x:1:1:Daemon:/home/daemon:/bin/sh\nrunner:x:1001:200:Runner:/home/runner:/bin/sh\n",
        )),
      },
      {
        path: "/etc/group",
        data: Array.from(Buffer.from("staff:x:200:runner\nworkers:x:201:runner\n")),
      },
    ],
  },
  {
    name: "upstream Go os/user pure-Go parser tests",
    file: "user-test.wasm",
    argv: [
      "go-user-test",
      "-test.run=^(TestFindGroupName|TestFindGroupId|TestInvalidUserId|TestLookupUserId|TestLookupUserPopulatesAllFields|TestLookupUser|TestListGroups)$",
    ],
    stdout: ["PASS"],
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
    name: "locked M burst churn exceeds the former eight-slot arena",
    file: "locked-exit.wasm",
    argv: ["go-locked-exit", "--burst"],
    stdout: ["locked worker burst exit and slot reuse: complete"],
  },
  {
    name: "sysmon preempts a CPU-bound goroutine for a timer",
    file: "sysmon.wasm",
    argv: ["go-sysmon"],
    stdout: ["sysmon cooperative preemption: complete"],
  },
  {
    name: "Go syscall TCP loopback socket",
    file: "socket-basic.wasm",
    argv: ["go-socket-basic"],
    stdout: ["GO SOCKET PASS"],
  },
  {
    name: "Go runtime TCP readiness and blocking syscall scheduler release",
    file: "netpoll-basic.wasm",
    argv: ["go-netpoll-basic"],
    stdout: ["GO NETPOLL PASS"],
  },
  {
    name: "Go net TCP dial and listener on IPv4 and IPv6",
    file: "net-basic.wasm",
    argv: ["go-net-basic"],
    stdout: ["GO NET PASS"],
  },
  {
    name: "Go HTTP request and response on IPv4 and IPv6",
    file: "http-basic.wasm",
    argv: ["go-http-basic"],
    stdout: ["GO HTTP PASS"],
  },
  {
    name: "Go spawn, wait, and command output through a pipe",
    file: "exec-basic.wasm",
    argv: ["go-exec-basic"],
    stdout: ["GO EXEC CHILD", "GO EXEC PASS"],
    selfExecPath: "/bin/go-exec-basic.wasm",
  },
  {
    name: "process exit from a worker M",
    file: "exit-worker.wasm",
    argv: ["go-exit-worker"],
    stdout: ["worker M: exiting process"],
  },
  {
    name: "Go atomic package short tests",
    file: "atomic-test.wasm",
    argv: ["go-atomic-test", "-test.short"],
    stdout: ["PASS"],
  },
  {
    name: "Go sync mutex, waitgroup, and condition tests",
    file: "sync-test.wasm",
    argv: ["go-sync-test", "-test.run=^(TestMutex|TestWaitGroup|TestCondSignal)$", "-test.short"],
    stdout: ["PASS"],
  },
];

if (process.env.KANDELO_GO_CGO_LINK_TESTS === "1") {
  probes.push({
    name: "Go calls linked C code with initialized data",
    file: "../go-c-link-only/combined.wasm",
    argv: ["go-c-data"],
    stdout: ["GO TO C DATA PASS"],
  });
}

if (process.env.KANDELO_GO_CGO_RUNTIME_TESTS === "1") {
  probes.push({
    name: "PHP ZTS embed initializes, evaluates, and shuts down in Go cgo",
    file: "../go-php-embed/probe-instrumented.wasm",
    argv: ["go-php-embed"],
    stdout: ["PHP EMBED PASS", "GO PHP EMBED PASS"],
  });
  probes.push({
    name: "cgo links a declared C static archive",
    file: "../go-static-archive/probe-instrumented.wasm",
    argv: ["go-cgo-static-archive"],
    stdout: ["CGO STATIC ARCHIVE PASS"],
  });
  probes.push({
    name: "standard cgo calls C with scalar, pointer, and per-M TLS state",
    file: "../go-c-abs-instrumented.wasm",
    argv: ["go-cgo-basic"],
    env: ["KANDELO_CGO_PROBE=cgo-startup"],
    stdout: ["CGO ABS PASS"],
  });
  probes.push({
    name: "Go-owned M cgo callback yields and calls C again",
    file: "../go-callback-same-instrumented.wasm",
    argv: ["go-cgo-callback"],
    stdout: ["CGO CALLBACK PASS"],
  });
  probes.push({
    name: "C-created pthread callback grows its Go stack",
    file: "../cgo-callback-probe-instrumented.wasm",
    argv: ["go-cgo-pthread-callback"],
    stdout: ["CGO CALLBACK PASS"],
  });
  probes.push({
    name: "Concurrent C pthread callbacks survive Go/C allocation churn",
    file: "../cgo-callback-probe-instrumented.wasm",
    argv: ["go-cgo-pthread-callback", "stress"],
    stdout: ["CGO CALLBACK STRESS PASS"],
  });
  probes.push({
    name: "C constructors run in priority order before Go main",
    file: "../go-constructors-instrumented.wasm",
    argv: ["go-cgo-constructors"],
    stdout: ["CGO CONSTRUCTORS PASS"],
  });
  probes.push({
    name: "C exit dispatches registered handlers from Go/cgo",
    file: "../go-constructors-instrumented.wasm",
    argv: ["go-cgo-constructors", "c-exit"],
    stdout: ["CGO C EXIT HANDLER PASS"],
  });
}

async function runProbe(page: Page, baseURL: string, probe: Probe): Promise<ProbeResult> {
  const programBytes = readFileSync(resolve(fixtureDir, probe.file));
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const programDigest = readWasmCustomSectionPayload(
    Uint8Array.from(programBytes).buffer, ABI_CONTRACT_SECTION,
  );
  const kernelDigest = readWasmCustomSectionPayload(
    Uint8Array.from(kernelBytes).buffer, ABI_CONTRACT_SECTION,
  );
  expect(kernelDigest?.length).toBe(32);
  expect(programDigest).toEqual(kernelDigest);
  const programUrl = new URL("/__kandelo_go_probe__.wasm", baseURL).href;
  const kernelUrl = new URL("/__kandelo_go_kernel__.wasm", baseURL).href;
  const browserKernelUrl = new URL(`/@fs/${browserKernelModulePath}`, baseURL).href;
  await page.route(programUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: programBytes,
  }));
  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: kernelBytes,
  }));
  const imageCapacity = probe.selfExecPath
    ? Math.max(8 * 1024 * 1024, programBytes.byteLength + 2 * 1024 * 1024)
    : 2 * 1024 * 1024;
  const image = MemoryFileSystem.create(new SharedArrayBuffer(Math.ceil(imageCapacity / 4) * 4));
  image.mkdir("/etc", 0o755);
  if (probe.selfExecPath) {
    image.mkdir("/bin", 0o755);
    image.createFileWithOwner(probe.selfExecPath, 0o755, 0, 0, new Uint8Array(programBytes));
  }
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
