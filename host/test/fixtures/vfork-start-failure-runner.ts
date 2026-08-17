import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

console.log("[vfork-mechanism-run] begin=start-failure");
let result;
try {
  result = await runCentralizedProgram({
    programPath: join(
      repoRoot,
      "local-binaries/programs/wasm32/vfork-lifecycle.wasm",
    ),
    argv: ["vfork-start-failure", "no-successful-exec"],
    useDefaultRootfs: false,
    timeout: 15_000,
  });
} finally {
  console.log("[vfork-mechanism-run] end=start-failure");
}

console.log(`VFORK_START_FAILURE_RESULT ${JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  diagnostics: result.hostDiagnostics,
})}`);
