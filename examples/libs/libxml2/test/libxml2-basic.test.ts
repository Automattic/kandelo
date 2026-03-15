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

describe("libxml2 basic verification", () => {
    it("parses XML and walks the DOM", async () => {
        const root = repoRoot();
        const { WasmPosixKernel } = await import(join(root, "host/src/kernel.ts"));
        const { ProgramRunner } = await import(join(root, "host/src/program-runner.ts"));
        const { NodePlatformIO } = await import(join(root, "host/src/platform/node.ts"));

        const kernelWasm = readFileSync(join(root, "host/wasm/wasm_posix_kernel.wasm"));
        const programWasm = readFileSync(join(__dirname, "libxml2_basic.wasm"));

        let stdout = "";
        const io = new NodePlatformIO();
        const kernel = new WasmPosixKernel(
            { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: false },
            io,
            { onStdout: (data: Uint8Array) => { stdout += new TextDecoder().decode(data); } },
        );
        await kernel.init(kernelWasm);

        const runner = new ProgramRunner(kernel);
        const exitCode = await runner.run(programWasm);

        expect(stdout).toContain("OK: parsed XML document");
        expect(stdout).toContain("OK: root element is 'root'");
        expect(stdout).toContain("hello-xml");
        expect(stdout).toContain("PASS");
        expect(exitCode).toBe(0);
    }, 30_000);
});
