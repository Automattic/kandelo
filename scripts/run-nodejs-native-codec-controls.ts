/** Real guest codec controls through NodeKernelHost; no Node.js bootstrap. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../host/src/binary-resolver";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";

const [programArgument, reportArgument] = process.argv.slice(2);
if (!programArgument || !reportArgument || process.argv.length !== 4) {
  throw new Error("usage: tsx scripts/run-nodejs-native-codec-controls.ts <controls.wasm> <report.json>");
}
const program = resolve(programArgument);
const reportPath = resolve(reportArgument);
const kernel = resolveBinary("kernel.wasm");
const expectedCases = ["ascii-validation", "utf8-to-utf16", "invalid-utf8-rejected", "utf16-surrogate-validation", "utf16-surrogate-replacement", "latin1-to-utf8", "utf8-to-latin1", "base64-encode", "base64url-encode", "base64-decode", "base64-bounded-output", "byte-swap-and-odd-length", "hex-encode", "hex-decode-stops-at-invalid", "node-base64-permissive-fallback", "byte-alignment", "actual-runtime-implementation"];
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
    useDefaultRootfs: false, argv: ["native-codec-controls"],
    env: ["PATH=/usr/bin:/bin"], timeout: 60_000,
  });
  check(result.exitCode === 0, `guest exit ${result.exitCode}`);
  check(result.stderr === "", "unexpected guest stderr");
  check(result.hostDiagnostics.length === 0, "unexpected host diagnostics");
  const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const summary = rows.pop();
  check(summary.kind === "native-codec-controls" && summary.cases === expectedCases.length && summary.failures === 0, "incorrect control summary");
  check(rows.length === expectedCases.length && rows.every((row, index) => row.case === expectedCases[index] && row.status === "pass"), "incorrect control inventory");
} catch (caught) {
  failures++;
  error = caught instanceof Error ? { name: caught.name, message: caught.message, stack: caught.stack } : String(caught);
}
const report = {
  schema: 1, completedAt: new Date().toISOString(),
  scope: "Focused real native codec controls on Node-host Kandelo guest; no Node.js startup or complete codec conformance",
  host: { version: process.version, platform: process.platform, arch: process.arch },
  program: identity(program), kernel: identity(kernel),
  fixture: identity(resolve("tests/nodejs/upstream/native-codec-controls.cpp")),
  runner: identity(resolve("scripts/run-nodejs-native-codec-controls.ts")),
  expectedCases, result, error, failures,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, cases: expectedCases.length, failures, exitCode: result?.exitCode }));
if (failures) process.exitCode = 1;
