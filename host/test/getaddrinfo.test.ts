import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WasmPosixKernel } from "../src/kernel";
import { ProgramRunner } from "../src/program-runner";
import { NodePlatformIO } from "../src/platform/node";
import { FetchNetworkBackend } from "../src/networking/fetch-backend";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("getaddrinfo override", () => {
  async function runGetaddrinfoTest(): Promise<{ exitCode: number; stdout: string }> {
    const kernelWasm = readFileSync(join(__dirname, "../wasm/wasm_posix_kernel.wasm"));
    const programWasm = readFileSync(join(__dirname, "../../examples/getaddrinfo_test.wasm"));

    let stdout = "";
    const io = new NodePlatformIO();
    // Attach a FetchNetworkBackend (returns synthetic 10.x.x.x IPs, no real DNS needed)
    (io as any).network = new FetchNetworkBackend();

    const kernel = new WasmPosixKernel(
      { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
      io,
      {
        onStdout: (data: Uint8Array) => {
          stdout += new TextDecoder().decode(data);
        },
      },
    );
    await kernel.init(kernelWasm);

    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(programWasm);
    return { exitCode, stdout };
  }

  it("resolves numeric IP, NULL name, and hostname via getaddrinfo", async () => {
    const { exitCode, stdout } = await runGetaddrinfoTest();

    // Numeric IP (127.0.0.1) should resolve without syscall
    expect(stdout).toContain("OK: numeric IP resolved to 127.0.0.1");

    // NULL name should return loopback
    expect(stdout).toContain("OK: NULL name resolved to 127.0.0.1");

    // Hostname should resolve via syscall #140 → FetchNetworkBackend → 10.x.x.x
    expect(stdout).toContain("OK: example.com resolved to 10.");

    expect(stdout).toContain("ALL TESTS PASSED");
    expect(exitCode).toBe(0);
  }, 30_000);
});
