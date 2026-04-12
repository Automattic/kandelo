import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

const wasmPath = join(__dirname, "ssl_basic.wasm");
const SSL_AVAILABLE = existsSync(wasmPath);

describe.skipIf(!SSL_AVAILABLE)("OpenSSL basic verification", () => {
    it("SSL_CTX_new/free succeeds", async () => {
        const result = await runCentralizedProgram({
            programPath: wasmPath,
            argv: ["ssl_basic"],
            timeout: 60_000,
        });

        expect(result.stdout).toContain("OK: SSL_CTX_new succeeded");
        expect(result.stdout).toContain("OpenSSL version:");
        expect(result.stdout).toContain("PASS");
        expect(result.exitCode).toBe(0);
    }, 60_000);
});
