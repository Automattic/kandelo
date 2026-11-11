import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../host/src/binary-resolver";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";
import { assertTracingOutput } from "../tests/nodejs/upstream/v8-tracing-component-assertions";

const [programArgument, reportArgument] = process.argv.slice(2);
if (!programArgument || !reportArgument || process.argv.length !== 4)
  throw new Error("usage: tsx scripts/run-v8-tracing-controls.ts <controls.wasm> <report.json>");
const program = resolve(programArgument), reportPath = resolve(reportArgument), kernel = resolveBinary("kernel.wasm");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
let result, detail, error, failures = 0;
try {
  result = await runCentralizedProgram({ programPath: program, kernelWasmBytes: readFileSync(kernel),
    useDefaultRootfs: false, argv: ["v8-tracing-component-controls"], env: ["PATH=/usr/bin:/bin"], timeout: 60_000 });
  if (result.exitCode !== 0 || result.stderr !== "" || result.hostDiagnostics.length)
    throw new Error(JSON.stringify(result));
  detail = assertTracingOutput(result.stdout);
} catch (caught) {
  failures++;
  error = caught instanceof Error ? { name: caught.name, message: caught.message, stack: caught.stack } : String(caught);
}
writeFileSync(reportPath, JSON.stringify({ schema: 1, completedAt: new Date().toISOString(),
  scope: "Standalone original tracing library on guest POSIX/libuv; not a V8 JS engine, native Node binding, agent or startup acceptance",
  host: { version: process.version, platform: process.platform, arch: process.arch },
  program: identity(program), kernel: identity(kernel),
  fixture: identity(resolve("packages/registry/v8-tracing/test/component-controls.cpp")),
  runner: identity(resolve("scripts/run-v8-tracing-controls.ts")),
  assertions: identity(resolve("tests/nodejs/upstream/v8-tracing-component-assertions.ts")), result, detail, error, failures,
}, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, failures, detail, exitCode: result?.exitCode }));
if (failures) process.exitCode = 1;
