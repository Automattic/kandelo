import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await runCentralizedProgram({
  programPath: join(
    repoRoot,
    "local-binaries/programs/wasm32/exec-child.wasm",
  ),
  argv: ["exec-child"],
  useDefaultRootfs: false,
  timeout: 15_000,
});

process.stdout.write(JSON.stringify({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
  hostDiagnostics: result.hostDiagnostics,
}));
