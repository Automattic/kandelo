import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../../../host/src/platform/node";
import { TlsFetchBackend } from "../src/tls-fetch-backend";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("HTTPS GET via OpenSSL with TLS MITM backend", () => {
    it("performs TLS handshake through MITM and receives HTTP response", async () => {
        const backend = new TlsFetchBackend();

        try {
            // Initialize MITM CA (synchronous — blocks on worker via Atomics)
            backend.init();

            const io = new NodePlatformIO();
            // Attach backend as the network provider
            (io as any).network = backend;

            // Note: To pre-populate the VFS with the MITM CA cert for OpenSSL
            // cert verification, we would need to call kernel_mkdir/kernel_open/
            // kernel_write after kernel_init(pid) but before the program starts.
            // ProgramRunner.run() handles kernel_init internally, so VFS writes
            // would need to happen inside that flow. For now, https_get.c uses
            // SSL_VERIFY_NONE so CA cert injection is not required.
            //
            // The CA PEM is available via backend.getCACertPEM() for future use.

            const result = await runCentralizedProgram({
                programPath: join(__dirname, "https_get.wasm"),
                argv: ["https_get", "example.com"],
                timeout: 60_000,
                io,
            });

            if (result.exitCode !== 0) {
                console.log("STDOUT:", result.stdout);
                console.log("STDERR:", result.stderr);
            }

            expect(result.stdout).toContain("OK: connected to example.com:443");
            expect(result.stdout).toContain("OK: TLS handshake complete");
            expect(result.stdout).toContain("OK: response: HTTP/1.1");
            expect(result.stdout).toContain("PASS");
            expect(result.exitCode).toBe(0);
        } finally {
            backend.terminate();
        }
    }, 60_000);
});
