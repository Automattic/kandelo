import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

it("mkdir and mkdirat report occupied names before parent write permission", async () => {
  const result = await runCentralizedProgram({
    programPath: fileURLToPath(new URL("./fixtures/mkdir-existing-directory.wasm", import.meta.url)),
    argv: ["mkdir-existing-directory"],
    uid: 1000,
    gid: 1000,
  });
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("mkdir-existing-directory: ok");
}, 30_000);
