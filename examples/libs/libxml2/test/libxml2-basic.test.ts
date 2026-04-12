import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("libxml2 basic verification", () => {
    it("parses XML and walks the DOM", async () => {
        const result = await runCentralizedProgram({
            programPath: join(__dirname, "libxml2_basic.wasm"),
            argv: ["libxml2_basic"],
            timeout: 30_000,
        });

        expect(result.stdout).toContain("OK: parsed XML document");
        expect(result.stdout).toContain("OK: root element is 'root'");
        expect(result.stdout).toContain("hello-xml");
        expect(result.stdout).toContain("PASS");
        expect(result.exitCode).toBe(0);
    }, 30_000);
});
