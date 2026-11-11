/** Focused guest-engine controls; this does not execute upstream Node startup. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../host/src/binary-resolver";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";

const [programArgument, reportArgument, modeArgument = "private-keys"] = process.argv.slice(2);
if (!programArgument || !reportArgument || process.argv.length > 5 ||
    !["private-keys", "per-context", "synthetic-modules", "module-wrap", "dynamic-import", "error-stack", "realm-library", "process-config", "timers"].includes(modeArgument)) {
  throw new Error("usage: tsx scripts/run-nodejs-private-key-controls.ts <js.wasm> <report.json> [private-keys|per-context|synthetic-modules|module-wrap|dynamic-import|error-stack|realm-library|process-config|timers]");
}
const perContext = modeArgument === "per-context";
const synthetic = modeArgument === "synthetic-modules";
const moduleWrap = modeArgument === "module-wrap";
const dynamicImport = modeArgument === "dynamic-import";
const errorStack = modeArgument === "error-stack";
const nativeTimers = modeArgument === "timers";
const processConfig = modeArgument === "process-config";
const realmLibrary = modeArgument === "realm-library";
const expectedKind = nativeTimers ? "native-timers-controls" : processConfig ? "native-process-config-controls" : realmLibrary ? "upstream-realm-library-controls" : errorStack ? "native-error-stack-controls" : dynamicImport ? "native-dynamic-import-controls" : moduleWrap ? "native-module-wrap-controls" : synthetic ? "engine-synthetic-module-controls" : perContext ? "upstream-per-context-controls" : "engine-private-key-controls-only";
const expectedCases = nativeTimers ? 27 : processConfig ? 13 : realmLibrary ? 16 : errorStack ? 21 : dynamicImport ? 14 : moduleWrap ? 19 : synthetic ? 15 : perContext ? 14 : 23;
const program = resolve(programArgument);
const reportPath = resolve(reportArgument);
const kernel = resolveBinary("kernel.wasm");
const fixturePath = resolve(nativeTimers ? "tests/nodejs/upstream/timers-engine-controls.js" : processConfig ? "tests/nodejs/upstream/process-config-engine-controls.js" : realmLibrary ? "tests/nodejs/upstream/realm-library-engine-controls.js" : errorStack ? "tests/nodejs/upstream/error-stack-engine-controls.js" : dynamicImport ? "tests/nodejs/upstream/dynamic-import-engine-controls.js" : moduleWrap ? "tests/nodejs/upstream/module-wrap-engine-controls.js" : synthetic ? "tests/nodejs/upstream/synthetic-module-engine-controls.js" : perContext ? "tests/nodejs/upstream/per-context-engine-controls.js"
  : "tests/nodejs/upstream/private-key-engine-controls.js");
const fixture = readFileSync(fixturePath, "utf8");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const runs: Array<Record<string, unknown>> = [];
let failures = 0;
async function run(name: string, argv: string[], validate: (result: Awaited<ReturnType<typeof runCentralizedProgram>>) => unknown) {
  let result: Awaited<ReturnType<typeof runCentralizedProgram>> | undefined;
  let guestPid: number | undefined;
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
      ...(realmLibrary ? { onStarted: (_proxy: unknown, pid: number) => { guestPid = pid; } } : {}),
    });
    const detail = validate(result);
    if (realmLibrary && name === modeArgument + "-controls") {
      const row = detail as { processMetadata: { pid: number } };
      expect(row.processMetadata.pid === guestPid, "native process PID differs from the real kernel-assigned PID");
    }
    runs.push({ name, status: "pass", ...result, detail, ...(realmLibrary ? { guestPid } : {}) });
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
await run(modeArgument + "-controls", ["js", "--kandelo-test-upstream",
  ...(synthetic ? ["--enable-import-attributes"] : []), "-e", fixture], (result) => {
  expect(result.exitCode === 0, JSON.stringify(result));
  const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.length === 1, "expected one complete engine result");
  const row = rows[0];
  expect(row.kind === expectedKind, "wrong result kind");
  expect(row.cases === expectedCases && row.failures === 0 && row.observations.length === expectedCases, JSON.stringify(row));
  expect(new Set(row.observations.map((item: { name: string }) => item.name)).size === expectedCases, "duplicate engine controls");
  expect(row.observations.every((item: { status: string }) => item.status === "pass"), JSON.stringify(row));
  return row;
});
if (perContext) {
  await run("fresh-exports-invariant-remains-fatal", ["js", "--kandelo-test-upstream", "-e",
    "Object.prototype.primordials = {}; try { __kandeloUpstreamTest.initializeContext(); print('UNEXPECTED_RETURN'); } catch (error) { print('UNEXPECTED_CATCH'); }"], (result) => {
    expect(result.exitCode !== 0, JSON.stringify(result));
    expect(result.stderr.includes("Node per-context exports invariant"), JSON.stringify(result));
    expect(!result.stdout.includes("UNEXPECTED_"), JSON.stringify(result));
  });
}
if (moduleWrap) {
  for (const [name, operation, assertion] of [
    ["module-constructor-invariant-remains-fatal", "ModuleWrap('fixture:invalid', undefined, [], () => {});", "Node ModuleWrap constructor invariant"],
    ["module-source-object-invariant-remains-fatal", "const module = new ModuleWrap('fixture:source', undefined, [], () => {}); module.setModuleSourceObject({}); module.setModuleSourceObject({});", "Node module source object initialization invariant"],
  ]) {
    await run(name, ["js", "--kandelo-test-upstream", "-e",
      "__kandeloUpstreamTest.initializeContext(); const { ModuleWrap } = __kandeloUpstreamTest.getModuleWrapBinding(); try { " + operation + " print('UNEXPECTED_RETURN'); } catch (error) { print('UNEXPECTED_CATCH'); }"], (result) => {
      expect(result.exitCode !== 0, JSON.stringify(result));
      expect(result.stderr.includes(assertion), JSON.stringify(result));
      expect(!result.stdout.includes("UNEXPECTED_"), JSON.stringify(result));
    });
  }
}
if (realmLibrary) {
  await run("once-only-loaders-registration-invariant-is-fatal", ["js", "--kandelo-test-upstream", "-e",
    "__kandeloUpstreamTest.initializeContext(); const realm = __kandeloUpstreamTest.initializeRealm(); try { realm.internalBinding('builtins').setInternalLoaders(() => {}, () => {}); print('UNEXPECTED_RETURN'); } catch (error) { print('UNEXPECTED_CATCH'); }"], (result) => {
      expect(result.exitCode !== 0, JSON.stringify(result));
      expect(result.stderr.includes("Node internal loaders registration invariant"), JSON.stringify(result));
      expect(!result.stdout.includes("UNEXPECTED_"), JSON.stringify(result));
    });
}
if (nativeTimers) {
  await run("timer-callback-quit-preserves-requested-shell-exit", ["js", "--kandelo-test-upstream", "-e",
    "__kandeloUpstreamTest.initializeContext();const realm=__kandeloUpstreamTest.initializeRealm();const timers=realm.internalBinding('timers');timers.setupTimers(()=>{},()=>quit(23));timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);"], (result) => {
      expect(result.exitCode === 23 && result.stderr === "" && result.hostDiagnostics.length === 0, JSON.stringify(result));
  });
  for (const mode of ["timer", "immediate"]) {
    await run("unreferenced-native-" + mode + "-permits-natural-guest-exit", ["js", "--kandelo-test-upstream", "-e",
      "__kandeloUpstreamTest.initializeContext(); const realm=__kandeloUpstreamTest.initializeRealm(); const timers=realm.internalBinding('timers'); timers.setupTimers(()=>{throw new Error('UNEXPECTED_IMMEDIATE_CALLBACK')},()=>{throw new Error('UNEXPECTED_TIMER_CALLBACK')}); " +
      (mode === "timer" ? "timers.getLibuvNow(); timers.scheduleTimer(0); timers.toggleTimerRef(false);" : "timers.immediateInfo[0]=1; timers.toggleImmediateRef(false);") +
      " print('UNREFERENCED_NATIVE_PENDING');"], (result) => {
        expect(result.exitCode === 0 && result.stdout.trim() === "UNREFERENCED_NATIVE_PENDING", JSON.stringify(result));
        expect(result.hostDiagnostics.length === 0, JSON.stringify(result));
      });
  }
  for (const [operation, assertion] of [
    ["timers.setupTimers(1,()=>0)", "Node immediate callback invariant"],
    ["timers.setupTimers(()=>{},1)", "Node timers callback invariant"],
  ]) {
    await run(assertion + "-remains-fatal", ["js", "--kandelo-test-upstream", "-e",
      "__kandeloUpstreamTest.initializeContext();const realm=__kandeloUpstreamTest.initializeRealm();const timers=realm.internalBinding('timers');try{" + operation + ";print('UNEXPECTED_RETURN')}catch(error){print('UNEXPECTED_CATCH')}"], (result) => {
        expect(result.exitCode !== 0 && result.stderr.includes(assertion) && !result.stdout.includes("UNEXPECTED_"), JSON.stringify(result));
      });
  }
}
const report = {
  schema: 1, completedAt: new Date().toISOString(),
  scope: `Focused SpiderMonkey guest-engine ${modeArgument} controls on the Node host; no upstream Node startup`,
  host: { version: process.version, platform: process.platform, arch: process.arch },
  program: identity(program), kernel: identity(kernel), fixture: identity(fixturePath),
  runner: identity(resolve("scripts/run-nodejs-private-key-controls.ts")),
  runs, failures,
  limits: ["No Chromium/Firefox/WebKit execution", "No upstream startup or module compatibility evidence", "No complete native-V8 differential proof", "No security-wrapper/OOM or complete symbol-owner teardown/finalization proof"],
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, runs: runs.length, failures }));
if (failures) process.exitCode = 1;
