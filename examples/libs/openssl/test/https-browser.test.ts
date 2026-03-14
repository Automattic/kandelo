import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
    return execSync("git rev-parse --show-toplevel", {
        cwd: __dirname, encoding: "utf-8",
    }).trim();
}

describe("HTTPS GET via OpenSSL with TLS MITM backend", () => {
    it("performs TLS handshake through MITM and receives HTTP response", async () => {
        const root = repoRoot();

        // Dynamic imports for kernel and backend
        const { WasmPosixKernel } = await import(join(root, "host/src/kernel.ts"));
        const { ProgramRunner } = await import(join(root, "host/src/program-runner.ts"));
        const { NodePlatformIO } = await import(join(root, "host/src/platform/node.ts"));
        const { TlsFetchBackend } = await import(join(__dirname, "../src/tls-fetch-backend.ts"));

        const kernelWasm = readFileSync(join(root, "host/wasm/wasm_posix_kernel.wasm"));
        const programWasm = readFileSync(join(__dirname, "https_get.wasm"));

        let stdout = "";
        let stderr = "";
        const io = new NodePlatformIO();
        const backend = new TlsFetchBackend();

        try {
            // Initialize MITM CA (synchronous — blocks on worker via Atomics)
            backend.init();

            // Attach backend as the network provider
            (io as any).network = backend;

            const kernel = new WasmPosixKernel(
                { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
                io,
                {
                    onStdout: (data: Uint8Array) => { stdout += new TextDecoder().decode(data); },
                    onStderr: (data: Uint8Array) => { stderr += new TextDecoder().decode(data); },
                },
            );

            await kernel.init(kernelWasm);

            // Note: To pre-populate the VFS with the MITM CA cert for OpenSSL
            // cert verification, we would need to call kernel_mkdir/kernel_open/
            // kernel_write after kernel_init(pid) but before the program starts.
            // ProgramRunner.run() handles kernel_init internally, so VFS writes
            // would need to happen inside that flow. For now, https_get.c uses
            // SSL_VERIFY_NONE so CA cert injection is not required.
            //
            // The CA PEM is available via backend.getCACertPEM() for future use.

            const runner = new ProgramRunner(kernel);
            const exitCode = await runner.run(programWasm, {
                argv: ["https_get", "example.com"],
            });

            if (exitCode !== 0) {
                console.log("STDOUT:", stdout);
                console.log("STDERR:", stderr);
            }

            expect(stdout).toContain("OK: connected to example.com:443");
            expect(stdout).toContain("OK: TLS handshake complete");
            expect(stdout).toContain("OK: response: HTTP/1.1");
            expect(stdout).toContain("PASS");
            expect(exitCode).toBe(0);
        } finally {
            backend.terminate();
        }
    }, 60_000);
});
