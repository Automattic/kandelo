import { expect } from "@playwright/test";
import { resolve } from "node:path";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { test } from "./support/streamed-artifacts";

for (const mode of ["pure", "cgo"]) {
  for (const probeMode of mode === "cgo" ? ["http-drain", "restart"] : ["http-drain"]) {
    test(`Go ${mode} signal ${probeMode}`, async ({ page, baseURL, serveArtifacts }) => {
      test.skip(process.env.KANDELO_GO_SIGNAL_TESTS !== "1", "Build tests/go/signal-basic and set KANDELO_GO_SIGNAL_TESTS=1");
      const urls = await serveArtifacts({
        program: { path: resolve("../../.context/go-signals", `${mode}.wasm`), contentType: "application/wasm" },
        kernel: { path: resolveBinary("kernel.wasm"), contentType: "application/wasm" },
        image: { bytes: await KandeloImageFs.create().saveImage(), contentType: "application/octet-stream" },
      });
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ urls, browserKernelUrl, probeUrl, probeMode }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
        const probe = await import(/* @vite-ignore */ probeUrl);
        const verify = probeMode === "restart" ? probe.verifySignalRestart : probe.verifyHttpSignalDrain;
        const [program, kernelWasm, image] = await Promise.all(["program", "kernel", "image"].map(async name => {
          const response = await fetch(urls[name]);
          if (!response.ok) throw new Error(`signal fixture fetch failed: ${name}: ${response.status}`);
          return response.arrayBuffer();
        }));
        let onOutput = (_bytes: Uint8Array) => {};
        let stderr = "";
        const diagnostics: unknown[] = [];
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (bytes: Uint8Array) => onOutput(bytes),
          onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
          onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
        });
        try {
          await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
          const result = await verify(kernel, async (onStdout: (bytes: Uint8Array) => void) => {
            onOutput = onStdout;
            let started!: (pid: number) => void;
            const ready = new Promise<number>(resolve => { started = resolve; });
            const exit = kernel.spawn(program, ["go-signal-basic", probeMode], { onStarted: started });
            const pid = await Promise.race([ready, exit.then((code: number) => {
              throw new Error(`HTTP guest exited before startup: ${code}`);
            })]);
            return { pid, exit };
          });
          return { ...result, stderr, diagnostics };
        } finally { await kernel.destroy(); }
      }, {
        urls,
        probeMode,
        browserKernelUrl: new URL(`/@fs${resolve("../../host/src/browser-kernel-host.ts")}`, baseURL).href,
        probeUrl: new URL(`/@fs${resolve(`../../tests/go/signal-basic/${probeMode === "restart" ? "restart" : "http-drain"}.ts`)}`, baseURL).href,
      });
      expect(result.exitCode).toBe(0);
      if (probeMode === "http-drain") expect(result.status).toBe(200);
      else expect(result.readDispatches).toBeGreaterThanOrEqual(2);
      expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
    });
  }
  for (const disposition of ["notify", "reset", "stop", "upstream", "quit", "blocked-wait"]) {
    test(`Go ${mode} signal ${disposition}`, async ({ page, baseURL, serveArtifacts }) => {
      test.skip(process.env.KANDELO_GO_SIGNAL_TESTS !== "1", "Build tests/go/signal-basic and set KANDELO_GO_SIGNAL_TESTS=1");
      const urls = await serveArtifacts({
        program: { path: resolve("../../.context/go-signals", `${mode}${disposition === "upstream" ? "-stdlib" : ""}.wasm`), contentType: "application/wasm" },
        kernel: { path: resolveBinary("kernel.wasm"), contentType: "application/wasm" },
        image: { bytes: await KandeloImageFs.create().saveImage(), contentType: "application/octet-stream" },
      });
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ urls, disposition, browserKernelUrl }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
        const [program, kernelWasm, image] = await Promise.all(["program", "kernel", "image"].map(async name => {
          const response = await fetch(urls[name]);
          if (!response.ok) throw new Error(`signal fixture fetch failed: ${name}: ${response.status}`);
          return response.arrayBuffer();
        }));
        if (disposition === "blocked-wait") {
          const imports = WebAssembly.Module.imports(await WebAssembly.compile(program));
          if (!imports.some(entry => entry.module === "kernel" && entry.name === "kernel_heap_safepoint")) {
            throw new Error("Go runtime omitted the host heap-safepoint import");
          }
        }
        let stdout = "";
        let stderr = "";
        const diagnostics: unknown[] = [];
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (bytes: Uint8Array) => { stdout += new TextDecoder().decode(bytes); },
          onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
          onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
        });
        try {
          await kernel.initFromImage({ kernelWasm, vfsImage: new Uint8Array(image) });
          const argv = disposition === "upstream" ? ["go-signal-stdlib",
            "-test.run=^(TestSignal|TestStress|TestReset|TestIgnore|TestIgnored|TestNotifyContextStop|TestNotifyContextCancelParent|TestNotifyContextPrematureCancelParent|TestNotifyContextSimultaneousStop|TestNotifyContextStringer)$",
            "-test.v"] : disposition === "notify" ? ["go-signal-basic"] : ["go-signal-basic", disposition];
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const exitCode = await Promise.race([
              kernel.spawn(program, argv),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Go signal timed out: ${stdout}\n${stderr}`)), 20_000);
              }),
            ]);
            return { exitCode, stdout, stderr, diagnostics };
          } finally { clearTimeout(timer); }
        } finally { await kernel.destroy(); }
      }, { urls, disposition, browserKernelUrl: new URL(`/@fs${resolve("../../host/src/browser-kernel-host.ts")}`, baseURL).href });
      expect(result.exitCode, JSON.stringify(result)).toBe(disposition === "quit" ? 2 : ["notify", "upstream", "blocked-wait"].includes(disposition) ? 0 : 143);
      expect(result.stdout).toContain(disposition === "blocked-wait" ? "GO SAFEPOINT WAIT PASS" : disposition === "quit" ? "GO SIGNAL QUIT READY" : disposition === "upstream" ? "PASS\n" : disposition === "notify" ? "GO SIGNAL PASS" : "GO SIGNAL NOTIFY PASS");
      if (disposition === "upstream") {
        expect(result.stdout).toContain("--- PASS: TestSignal");
        expect(result.stdout).toContain("--- PASS: TestStress");
        expect(result.stdout).toContain("--- PASS: TestReset");
      }
      if (mode === "cgo" && disposition === "notify") {
        expect(result.stdout).toContain("GO SIGNAL CGO PASS");
        expect(result.stdout).toContain("GO SIGNAL C HANDLER PASS");
      }
      if (disposition === "quit") {
        expect(result.stderr).toContain("SIGQUIT");
        expect(result.stderr).toContain("goroutine");
      } else expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
    });
  }
}
