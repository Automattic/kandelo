import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("SQLite basic verification", () => {
    it("creates table, inserts, and selects from in-memory DB", async () => {
        const result = await runCentralizedProgram({
            programPath: join(__dirname, "sqlite_basic.wasm"),
            argv: ["sqlite_basic"],
            timeout: 30_000,
        });

        expect(result.stdout).toContain("OK: sqlite3_open succeeded");
        expect(result.stdout).toContain("OK: SELECT returned 'hello'");
        expect(result.stdout).toContain("PASS");
        expect(result.exitCode).toBe(0);
    }, 30_000);
});
