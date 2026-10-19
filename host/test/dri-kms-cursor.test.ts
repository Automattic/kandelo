import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

it("runs Linux KMS cursor ioctls through the guest channel on Node", async () => {
  const result = await runCentralizedProgram({
    programPath: fileURLToPath(new URL("./fixtures/kms-cursor.wasm", import.meta.url)),
    argv: ["kms-cursor"], uid: 1000, gid: 1000,
  });
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("kms-cursor: ok");
}, 30_000);
