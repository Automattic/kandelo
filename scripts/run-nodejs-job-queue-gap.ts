import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";
import { resolveBinary } from "../host/src/binary-resolver";

const [programArgument, nativeArgument, reportArgument] = process.argv.slice(2);
if (!programArgument || !nativeArgument || !reportArgument || process.argv.length !== 5)
  throw new Error("usage: tsx scripts/run-nodejs-job-queue-gap.ts <js.wasm> <pinned-native-node> <report.json>");

function identity(path: string) {
  const bytes = readFileSync(path);
  return { path: resolve(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const receipt = JSON.parse(readFileSync("tests/nodejs/upstream/timers-libuv-engine-check.json", "utf8"));
const program = resolve(programArgument);
const kernel = resolveBinary("kernel.wasm");
expect(identity(program).sha256 === receipt.artifacts.program.sha256, "program drift");
expect(identity(kernel).sha256 === receipt.artifacts.kernel.sha256, "kernel drift");
const guestFixture = "tests/nodejs/upstream/task-queue-gap-controls.js";
const nativeFixture = "tests/nodejs/upstream/task-queue-native-controls.cjs";
const nativeProgram = resolve(nativeArgument);
const nativePin = JSON.parse(readFileSync("tests/nodejs/upstream/timers-libuv-native-reference.json", "utf8"));
expect(identity(nativeProgram).sha256 === nativePin.executableSha256, "native pin drift");
const runs: Array<Record<string, unknown>> = [];
let failures = 0;
for (const mode of ["primitives", "exception", "weakref"]) {
  let result;
  try {
    result = await runCentralizedProgram({
      programPath: program, kernelWasmBytes: readFileSync(kernel), useDefaultRootfs: false,
      argv: ["js", "--kandelo-test-upstream", "-e",
        "const taskQueueGapMode=" + JSON.stringify(mode) + ";\n" + readFileSync(guestFixture, "utf8")],
      env: ["PATH=/usr/bin:/bin"], timeout: 90_000,
    });
    const detail = JSON.parse(result.stdout.trim());
    expect(result.hostDiagnostics.length === 0, "unexpected host diagnostics");
    if (mode === "primitives") {
      expect(result.exitCode === 0 && result.stderr === "", JSON.stringify(result));
      expect(detail.kind === "task-queue-shell-primitives" && detail.observations.length === 3, "wrong primitive observations");
    } else if (mode === "exception") {
      expect(result.exitCode !== 0 && result.stderr.includes("TASK_QUEUE_SHELL_EXCEPTION_GAP"), JSON.stringify(result));
      expect(detail.kind === "task-queue-shell-exception-gap" && detail.caught === false, "unexpected exception routing");
      expect(JSON.stringify(detail.order) === JSON.stringify(["throw", "after"]), "queue did not continue");
    } else {
      expect(result.exitCode === 0 && result.stderr === "", JSON.stringify(result));
      expect(detail.kind === "task-queue-shell-weakref-observation" && detail.before === true && typeof detail.after === "boolean", "weakref observation");
    }
    runs.push({ mode, status: "verified-observation", result, detail });
  } catch (error) {
    failures++;
    runs.push({ mode, status: "failed-observation", result,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) });
  }
}
const args = ["--expose-internals", "--expose-gc", "--no-warnings", resolve(nativeFixture)];
const native = spawnSync(resolve(nativeProgram), args,
  { env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, encoding: "utf8", timeout: 60_000 });
let nativeDetail;
try {
  expect(native.status === 0 && native.stderr === "" && !native.error, JSON.stringify(native));
  nativeDetail = JSON.parse(native.stdout.trim());
  expect(nativeDetail.kind === "task-queue-native-reference" && nativeDetail.cases === 6 && nativeDetail.failures === 0, "native reference inventory");
} catch (error) {
  failures++;
  nativeDetail = { error: String(error) };
}
const report = {
  schema: 1, completedAt: new Date().toISOString(), scope: "Task queue integration prerequisites and verified exception-routing gap; no task_queue implementation or Node startup claim",
  program: identity(program), kernel: identity(kernel), fixture: identity(guestFixture), runner: identity("scripts/run-nodejs-job-queue-gap.ts"),
  guestRuns: runs,
  nativeReference: { program: identity(nativeProgram), fixture: identity(nativeFixture), sourceCommit: nativePin.sourceCommit, args, environmentKeys: ["PATH", "LANG", "TZ"],
    exit: native.status, signal: native.signal, stdout: native.stdout, stderr: native.stderr,
    error: native.error ? String(native.error) : undefined, detail: nativeDetail },
  failures,
  limits: ["Node outer host only; no new browser queue probes", "Selected existing shell primitives are not Node's task_queue binding", "Native reference is already bootstrapped; no full async hooks, rejection/fatal policy or lifecycle differential"],
};
writeFileSync(resolve(reportArgument), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ failures, guestRuns: runs.map(({ mode, status, result }: any) => ({ mode, status, exit: result?.exitCode })), native: { exit: native.status, detail: nativeDetail } }));
if (failures) process.exitCode = 1;
