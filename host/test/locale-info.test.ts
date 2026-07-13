import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = join(__dirname, "../../examples/locale_info_test.wasm");

describe("locale information", () => {
  it("reports locale object names and alternate month data", async () => {
    const result = await runCentralizedProgram({
      programPath,
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("locale-info-ok\n");
    expect(result.stderr).toBe("");
  });
});
