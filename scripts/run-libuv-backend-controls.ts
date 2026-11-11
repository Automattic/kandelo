/** Real guest libuv controls through NodeKernelHost; no Node.js bootstrap. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../host/src/binary-resolver";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";

const [programArgument, reportArgument] = process.argv.slice(2);
if (!programArgument || !reportArgument || process.argv.length !== 4) {
  throw new Error("usage: tsx scripts/run-libuv-backend-controls.ts <controls.wasm> <report.json>");
}
const program = resolve(programArgument);
const reportPath = resolve(reportArgument);
const kernel = resolveBinary("kernel.wasm");
const expectedCases = [
  "public-layout", "empty-loop", "timer-deadline-and-close",
  "repeating-timer-stop", "unreferenced-timer-liveness", "busy-close-and-nowait",
  "prepare-check-phases", "thread-to-loop-async-wakeup",
  "threadpool-work-and-main-callback", "pipe-readiness-and-poll-close",
  "real-file-async-write-read-and-errors", "process-title-explicit-unsupported",
  "filesystem-watch-explicit-unsupported",
];
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
let result: Awaited<ReturnType<typeof runCentralizedProgram>> | undefined;
let error: unknown;
let failures = 0;
try {
  result = await runCentralizedProgram({
    programPath: program, kernelWasmBytes: readFileSync(kernel),
    useDefaultRootfs: false, argv: ["libuv-backend-controls"],
    env: ["PATH=/usr/bin:/bin"], timeout: 60_000,
  });
  check(result.exitCode === 0, `guest exit ${result.exitCode}`);
  check(result.stderr === "", "unexpected guest stderr");
  check(result.hostDiagnostics.length === 0, "unexpected host diagnostics");
  const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const summary = rows.pop();
  check(summary.kind === "libuv-backend-controls" && summary.cases === expectedCases.length && summary.failures === 0, "incorrect control summary");
  check(rows.length === expectedCases.length && rows.every((row, index) => row.case === expectedCases[index] && row.status === "pass"), "incorrect control inventory");
} catch (caught) {
  failures++;
  error = caught instanceof Error ? { name: caught.name, message: caught.message, stack: caught.stack } : String(caught);
}
const report = {
  schema: 1, completedAt: new Date().toISOString(),
  scope: "Focused real libuv loop controls on Node-host Kandelo guest; no Node.js startup or complete libuv compatibility",
  host: { version: process.version, platform: process.platform, arch: process.arch },
  program: identity(program), kernel: identity(kernel),
  fixture: identity(resolve("packages/registry/libuv/test/backend-controls.c")),
  runner: identity(resolve("scripts/run-libuv-backend-controls.ts")),
  expectedCases, result, error, failures,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, cases: expectedCases.length, failures, exitCode: result?.exitCode }));
if (failures) process.exitCode = 1;
