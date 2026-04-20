import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
    const gitCommon = execSync("git rev-parse --git-common-dir", {
        cwd: __dirname, encoding: "utf-8",
    }).trim();
    return join(gitCommon, "..");
}

const wasmPath = join(__dirname, "ssl_basic.wasm");
const SSL_AVAILABLE = existsSync(wasmPath);

describe.skipIf(!SSL_AVAILABLE)("OpenSSL basic verification", () => {
    it("SSL_CTX_new/free succeeds", async () => {
        const root = repoRoot();
        const { WasmPosixKernel } = await import(
            join(root, "host/src/kernel.ts")
        );
        const { ProgramRunner } = await import(
            join(root, "host/src/program-runner.ts")
        );
        const { NodePlatformIO } = await import(
            join(root, "host/src/platform/node.ts")
        );

        const { resolveBinary } = await import(
            join(root, "host/src/binary-resolver.ts")
        );
        const kernelWasm = readFileSync(resolveBinary("kernel.wasm"));
        const programWasm = readFileSync(wasmPath);

        let stdout = "";
        const io = new NodePlatformIO();
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
        const exitCode = await runner.run(programWasm, { argv: ["ssl_basic"] });

        expect(stdout).toContain("OK: SSL_CTX_new succeeded");
        expect(stdout).toContain("OpenSSL version:");
        expect(stdout).toContain("PASS");
        expect(exitCode).toBe(0);
    }, 60_000);
});
