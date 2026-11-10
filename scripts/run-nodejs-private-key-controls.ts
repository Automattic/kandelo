/** Focused guest-engine controls; this does not execute upstream Node startup. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../host/src/binary-resolver";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";

const [programArgument, reportArgument] = process.argv.slice(2);
if (!programArgument || !reportArgument || process.argv.length !== 4) {
  throw new Error("usage: tsx scripts/run-nodejs-private-key-controls.ts <js.wasm> <report.json>");
}
const program = resolve(programArgument);
const reportPath = resolve(reportArgument);
const kernel = resolveBinary("kernel.wasm");
const fixturePath = resolve("tests/nodejs/upstream/private-key-engine-controls.js");
const fixture = readFileSync(fixturePath, "utf8");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const runs: Array<Record<string, unknown>> = [];
let failures = 0;
async function run(name: string, argv: string[], validate: (result: Awaited<ReturnType<typeof runCentralizedProgram>>) => unknown) {
  let result: Awaited<ReturnType<typeof runCentralizedProgram>> | undefined;
  try {
    // No custom PlatformIO/onKernelReady: the helper uses NodeKernelHost and
    // its dedicated kernel worker, with real guest descriptors and syscalls.
    result = await runCentralizedProgram({
      programPath: program,
      kernelWasmBytes: readFileSync(kernel),
      useDefaultRootfs: false,
      argv,
      env: ["PATH=/usr/bin:/bin"],
      timeout: 120_000,
    });
    const detail = validate(result);
    runs.push({ name, status: "pass", ...result, detail });
  } catch (error) {
    failures++;
    const failureKind = result ? "guest-control-failure"
      : error instanceof Error && error.message.startsWith("Program timed out")
        ? "timeout" : "harness-error";
    runs.push({ name, status: "fail", failureKind, ...result,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) });
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
await run("ordinary-shell-does-not-expose-native-controls", ["js", "-e", "if ('__kandeloUpstreamTest' in globalThis) throw new Error('native controls exposed'); print('UPSTREAM_TEST_API_ABSENT');"], (result) => {
  expect(result.exitCode === 0, JSON.stringify(result));
  expect(result.stdout.trim() === "UPSTREAM_TEST_API_ABSENT", JSON.stringify(result));
});
await run("node-mode-refuses-native-test-controls", ["node", "--kandelo-test-upstream", "-e", "throw new Error('test mode should already have been refused');"], (result) => {
  expect(result.exitCode !== 0, JSON.stringify(result));
  expect(result.stderr.includes("upstream test controls require JS-shell mode"), JSON.stringify(result));
});
await run("engine-private-key-controls", ["js", "--kandelo-test-upstream", "-e", fixture], (result) => {
  expect(result.exitCode === 0, JSON.stringify(result));
  const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.length === 1, "expected one complete engine result");
  const row = rows[0];
  expect(row.kind === "engine-private-key-controls-only", "wrong result kind");
  expect(row.cases === 23 && row.failures === 0 && row.observations.length === 23, JSON.stringify(row));
  expect(new Set(row.observations.map((item: { name: string }) => item.name)).size === 23, "duplicate engine controls");
  expect(row.observations.every((item: { status: string }) => item.status === "pass"), JSON.stringify(row));
  return row;
});
const report = {
  schema: 1, completedAt: new Date().toISOString(),
  scope: "Focused SpiderMonkey guest-engine private-key controls on the Node host; no upstream Node startup",
  host: { version: process.version, platform: process.platform, arch: process.arch },
  program: identity(program), kernel: identity(kernel), fixture: identity(fixturePath),
  runner: identity(resolve("scripts/run-nodejs-private-key-controls.ts")),
  runs, failures,
  limits: ["No Chromium/Firefox/WebKit execution", "No upstream startup or module compatibility evidence", "No complete native-V8 differential proof", "No security-wrapper/OOM/finalization or canonical symbol-owner proof"],
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, runs: runs.length, failures }));
if (failures) process.exitCode = 1;
