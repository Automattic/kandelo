/** Focused guest-engine controls; this does not execute upstream Node startup. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBinary } from "../host/src/binary-resolver";
import { runCentralizedProgram } from "../host/test/centralized-test-helper";

const [programArgument, reportArgument, modeArgument = "private-keys"] = process.argv.slice(2);
if (!programArgument || !reportArgument || process.argv.length > 5 ||
    !["private-keys", "per-context", "synthetic-modules", "module-wrap", "dynamic-import", "error-stack", "realm-library", "process-config", "timers", "task-queue", "async-wrap", "constants", "types", "options"].includes(modeArgument)) {
  throw new Error("usage: tsx scripts/run-nodejs-private-key-controls.ts <js.wasm> <report.json> [private-keys|per-context|synthetic-modules|module-wrap|dynamic-import|error-stack|realm-library|process-config|timers|task-queue|async-wrap|constants|types|options]");
}
const perContext = modeArgument === "per-context";
const synthetic = modeArgument === "synthetic-modules";
const moduleWrap = modeArgument === "module-wrap";
const dynamicImport = modeArgument === "dynamic-import";
const errorStack = modeArgument === "error-stack";
const nativeTimers = modeArgument === "timers";
const nativeConstants = modeArgument === "constants";
const nativeTypes = modeArgument === "types";
const nativeOptions = modeArgument === "options";
const nativeAsync = modeArgument === "async-wrap";
const nativeTasks = modeArgument === "task-queue";
const processConfig = modeArgument === "process-config";
const realmLibrary = modeArgument === "realm-library";
const expectedKind = nativeOptions ? "native-options-controls" : nativeTypes ? "native-types-controls" : nativeConstants ? "native-constants-controls" : nativeAsync ? "native-async-wrap-controls" : nativeTasks ? "native-task-queue-controls" : nativeTimers ? "native-timers-controls" : processConfig ? "native-process-config-controls" : realmLibrary ? "upstream-realm-library-controls" : errorStack ? "native-error-stack-controls" : dynamicImport ? "native-dynamic-import-controls" : moduleWrap ? "native-module-wrap-controls" : synthetic ? "engine-synthetic-module-controls" : perContext ? "upstream-per-context-controls" : "engine-private-key-controls-only";
const expectedCases = nativeOptions ? 14 : nativeTypes ? 21 : nativeConstants ? 10 : nativeAsync ? 20 : nativeTasks ? 26 : nativeTimers ? 27 : processConfig ? 13 : realmLibrary ? 16 : errorStack ? 21 : dynamicImport ? 14 : moduleWrap ? 19 : synthetic ? 15 : perContext ? 14 : 23;
const program = resolve(programArgument);
const reportPath = resolve(reportArgument);
const kernel = resolveBinary("kernel.wasm");
const fixturePath = resolve(nativeOptions ? "tests/nodejs/upstream/options-engine-controls.js" : nativeTypes ? "tests/nodejs/upstream/types-engine-controls.js" : nativeConstants ? "tests/nodejs/upstream/constants-engine-controls.js" : nativeAsync ? "tests/nodejs/upstream/async-wrap-engine-controls.js" : nativeTasks ? "tests/nodejs/upstream/task-queue-engine-controls.js" : nativeTimers ? "tests/nodejs/upstream/timers-engine-controls.js" : processConfig ? "tests/nodejs/upstream/process-config-engine-controls.js" : realmLibrary ? "tests/nodejs/upstream/realm-library-engine-controls.js" : errorStack ? "tests/nodejs/upstream/error-stack-engine-controls.js" : dynamicImport ? "tests/nodejs/upstream/dynamic-import-engine-controls.js" : moduleWrap ? "tests/nodejs/upstream/module-wrap-engine-controls.js" : synthetic ? "tests/nodejs/upstream/synthetic-module-engine-controls.js" : perContext ? "tests/nodejs/upstream/per-context-engine-controls.js"
  : "tests/nodejs/upstream/private-key-engine-controls.js");
const fixture = readFileSync(fixturePath, "utf8").replace("// @shared-controls",
  nativeAsync ? readFileSync("tests/nodejs/upstream/async-wrap-shared-controls.js", "utf8") : "// no shared controls").replace("// @shared-constants-controls", nativeConstants ? readFileSync("tests/nodejs/upstream/constants-shared-controls.js", "utf8") : "// no shared constants").replace("// @shared-types-controls", nativeTypes ? readFileSync("tests/nodejs/upstream/types-shared-controls.js", "utf8") : "// no shared types").replace("// @shared-options-controls", nativeOptions ? readFileSync("tests/nodejs/upstream/options-shared-controls.js", "utf8") : "// no shared options");
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
  if (nativeOptions || nativeTypes || nativeAsync || nativeConstants) expect(result.stderr === "" && result.hostDiagnostics.length === 0, JSON.stringify(result));
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
if (nativeOptions) {
  const setup="const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('options');";
  for (const [name,setter,assertion] of [
    ["original-method-setter-failure-retains-fatal-check", "throw new Error('REGISTRATION_SETTER')", "Original native options method property invariant"],
    ["unimplemented-late-name-inspection-is-an-explicit-fatal-boundary", "void value.name", "Native option method late naming after inspection is not implemented"],
  ]) await run(name,["js","--kandelo-test-upstream","-e", "const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();Object.defineProperty(Object.prototype,'getCLIOptionsValues',{set(value){"+setter+"},configurable:true});realm.internalBinding('options');print('UNEXPECTED_RETURN')"],result=>{
    expect(result.exitCode===132 && result.stderr.includes(assertion) && result.hostDiagnostics.length===1 && !result.stdout.includes('UNEXPECTED_RETURN'),JSON.stringify(result));
  });
  const controls = [
    ["primitive-profile-arguments-reject-with-a-real-exception", "try{api.configureOptions(1);throw new Error('unexpected success')}catch(error){if(!error.message.includes('requires an argument array'))throw error}if(api.inspectOptions().configured)throw new Error('unexpected mutation');print('PROFILE_ARGUMENT_REJECTED')", "PROFILE_ARGUMENT_REJECTED"],
    ["original-cpp-option-error-preserves-terminal-profile-failure", "try{api.configureOptions(['node','--input-type=incorrect']);throw new Error('unexpected success')}catch(error){if(!error.message.includes('--input-type must be'))throw error}if(!api.inspectOptions().failed)throw new Error('profile not failed');try{binding.parseNodeOptionsEnvVar('--x');throw new Error('unexpected reuse')}catch(error){if(!error.message.includes('Previous native options configuration failed'))throw error}print('ORIGINAL_CPP_ERROR_RETAINED')", "ORIGINAL_CPP_ERROR_RETAINED"],
    ["unsupported-memory-accounting-cannot-publish-a-zero-value", "try{api.configureOptions(['node','--max-old-space-size-percentage=25']);throw new Error('unexpected success')}catch(error){if(error.code!=='ERR_KANDELO_NOT_IMPLEMENTED'||!error.message.includes('real libuv memory accounting'))throw error}if(!api.inspectOptions().failed||api.inspectOptions().serialized)throw new Error('false memory success');print('MEMORY_BOUNDARY_RETAINED')", "MEMORY_BOUNDARY_RETAINED"],
    ["unimplemented-engine-option-adoption-is-an-error", "try{api.configureOptions(['node','--definitely-not-a-native-option']);throw new Error('unexpected success')}catch(error){if(error.code!=='ERR_KANDELO_NOT_IMPLEMENTED')throw error}if(!api.inspectOptions().failed)throw new Error('false engine success');print('ENGINE_OPTION_REJECTED')", "ENGINE_OPTION_REJECTED"],
    ["unimplemented-env-file-adoption-is-an-error", "try{api.configureOptions(['node','--env-file=/tmp/missing-node-options.env']);throw new Error('unexpected success')}catch(error){if(error.code!=='ERR_KANDELO_NOT_IMPLEMENTED')throw error}if(!api.inspectOptions().failed)throw new Error('false env-file success');print('ENV_FILE_OPTION_REJECTED')", "ENV_FILE_OPTION_REJECTED"],
  ];
  for (const [name,source,output] of controls) await run(name,["js","--kandelo-test-upstream","-e",setup+source],result=>{
    expect(result.exitCode===0 && result.stdout.trim()===output && result.stderr==="" && result.hostDiagnostics.length===0,JSON.stringify(result));
  });
}
if (nativeAsync) {
  const setup="__kandeloUpstreamTest.initializeContext();const realm=__kandeloUpstreamTest.initializeRealm();const binding=realm.internalBinding('async_wrap');";
  for (const [name, operation, assertion] of [
    ["setup-object-invariant", "binding.setupHooks(null)", "Node async hooks object invariant"],
    ["setup-callable-invariant", "binding.setupHooks({})", "Node async hook function invariant"],
    ["setup-once-invariant", "binding.setupHooks(realm.require('internal/async_hooks').nativeHooks);binding.setupHooks({})", "Node async hooks once invariant"],
    ["push-id-invariant", "binding.pushAsyncContext(-2,0)", "Node async IDs invariant"],
    ["push-conversion-invariant", "binding.pushAsyncContext(Symbol(),0)", "Node async ID conversion invariant"],
    ["pop-corruption-invariant", "binding.pushAsyncContext(7,0);binding.popAsyncContext(9)", "Node async stack corruption invariant"],
    ["destroy-id-invariant", "binding.queueDestroyAsyncId('1')", "Node destroy async ID invariant"],
    ["destroy-registration-invariant", "binding.registerDestroyHook(null,1)", "Node GC destroy registration invariant"],
  ]) {
    await run(name,["js","--kandelo-test-upstream","-e",setup+"try{"+operation+";print('UNEXPECTED_RETURN')}catch(error){print('UNEXPECTED_CATCH')}"],result=>{
      expect(result.exitCode===132 && result.stderr.includes(assertion) && result.hostDiagnostics.length===1 && !result.stdout.includes('UNEXPECTED_'),JSON.stringify(result));
    });
  }
  await run("detached-native-async-state-is-an-error",["js","--kandelo-test-upstream","-e",setup+"detachArrayBuffer(binding.async_id_fields.buffer);try{binding.pushAsyncContext(1,0);throw new Error('unexpected success')}catch(error){if(!error.message.includes('backing array'))throw error;print('DETACHED_ASYNC_STATE_REJECTED')}"],result=>{
    expect(result.exitCode===0 && result.stdout.trim()==='DETACHED_ASYNC_STATE_REJECTED' && result.stderr==='' && result.hostDiagnostics.length===0,JSON.stringify(result));
  });
}
if (nativeTasks) {
  const setup = "__kandeloUpstreamTest.initializeContext();const realm=__kandeloUpstreamTest.initializeRealm();const queue=realm.internalBinding('task_queue');";
  for (const [name, operation, assertion] of [
    ["enqueue-function-invariant", "queue.enqueueMicrotask(undefined)", "Node microtask function invariant"],
    ["tick-function-invariant", "queue.setTickCallback(false)", "Node task queue callback function invariant"],
    ["reject-function-invariant", "queue.setPromiseRejectCallback({})", "Node task queue callback function invariant"],
    ["unregistered-tick-invariant", "queue.tickInfo[0]=1;drainJobQueue()", "Node tick callback was not registered"],
    ["unregistered-rejection-invariant", "Promise.reject({})", "Node promise rejection callback was not registered"],
  ]) {
    await run(name, ["js", "--kandelo-test-upstream", "-e", setup + "try{" + operation + ";print('UNEXPECTED_RETURN')}catch(error){print('UNEXPECTED_CATCH')}"], (result) => {
      expect(result.exitCode === 132 && result.stderr.includes(assertion), JSON.stringify(result));
      expect(result.hostDiagnostics.length === 1 && !result.stdout.includes("UNEXPECTED_"), JSON.stringify(result));
    });
  }
  await run("queued-job-natural-exit", ["js", "--kandelo-test-upstream", "-e", setup + "queue.enqueueMicrotask(()=>print('MICROTASK_DONE'));"], (result) => {
    expect(result.exitCode === 0 && result.stdout.trim() === "MICROTASK_DONE" && result.stderr === "" && result.hostDiagnostics.length === 0, JSON.stringify(result));
  });
  await run("queued-job-quit-status", ["js", "--kandelo-test-upstream", "-e", setup + "queue.enqueueMicrotask(()=>quit(23));"], (result) => {
    expect(result.exitCode === 23 && result.stderr === "" && result.hostDiagnostics.length === 0, JSON.stringify(result));
  });
  await run("detached-live-tick-state-is-an-explicit-failure", ["js", "--kandelo-test-upstream", "-e", setup + "detachArrayBuffer(queue.tickInfo.buffer);try{drainJobQueue()}catch(error){if(!error.message.includes('tickInfo backing array'))throw error;print('DETACHED_TICK_STATE_REJECTED')}"], (result) => {
    expect(result.exitCode === 3 && result.stdout.trim() === "DETACHED_TICK_STATE_REJECTED" && result.stderr.includes("tickInfo backing array") && result.hostDiagnostics.length === 0, JSON.stringify(result));
  });
  await run("promise-handler-exceptions-are-reported-without-false-exit", ["js", "--kandelo-test-upstream", "-e", setup + "let calls=0;queue.setPromiseRejectCallback(()=>{calls++;throw new Error('PROMISE_REJECT_HANDLER_SENTINEL')});const promise=Promise.reject({});promise.catch(()=>{});queue.runMicrotasks();if(calls!==2)throw new Error('callback count');print('REJECTION_DIAGNOSTIC_ONLY')"], (result) => {
    expect(result.exitCode === 0 && result.stdout.trim() === "REJECTION_DIAGNOSTIC_ONLY" && result.stderr.includes("PROMISE_REJECT_HANDLER_SENTINEL") && result.hostDiagnostics.length === 0, JSON.stringify(result));
  });
  await run("assigned-promise-handler-exception-restores-real-context", ["js", "--kandelo-test-upstream", "-e", setup + "const binding=realm.internalBinding('async_wrap'),c=binding.constants,s=realm.internalBinding('symbols');let calls=0,reject;queue.setPromiseRejectCallback(()=>{calls++;if(binding.async_id_fields[c.kExecutionAsyncId]!==71)throw new Error('WRONG_ASYNC_ID');throw new Error('ASSIGNED_CALLBACK_SENTINEL')});const promise=new Promise((resolve,r)=>reject=r);promise[s.async_id_symbol]=71;promise[s.trigger_async_id_symbol]=33;reject({});promise.catch(()=>{});queue.runMicrotasks();if(calls!==2||binding.async_id_fields[c.kExecutionAsyncId]!==0||binding.async_hook_fields[c.kStackLength]!==0)throw new Error('context restore');print('ASSIGNED_ASYNC_CONTEXT_RESTORED')"], (result) => {
    expect(result.exitCode === 0 && result.stdout.trim() === "ASSIGNED_ASYNC_CONTEXT_RESTORED" && result.stderr.includes("ASSIGNED_CALLBACK_SENTINEL") && !result.stderr.includes("WRONG_ASYNC_ID") && result.hostDiagnostics.length === 0, JSON.stringify(result));
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
  ...(nativeOptions ? { sharedFixture: identity(resolve("tests/nodejs/upstream/options-shared-controls.js")), executedFixtureSha256: createHash("sha256").update(fixture).digest("hex") } : {}),
  ...(nativeTypes ? { sharedFixture: identity(resolve("tests/nodejs/upstream/types-shared-controls.js")), executedFixtureSha256: createHash("sha256").update(fixture).digest("hex") } : {}),
  ...(nativeConstants ? { sharedFixture: identity(resolve("tests/nodejs/upstream/constants-shared-controls.js")), executedFixtureSha256: createHash("sha256").update(fixture).digest("hex") } : {}),
  ...(nativeAsync ? { sharedFixture: identity(resolve("tests/nodejs/upstream/async-wrap-shared-controls.js")), executedFixtureSha256: createHash("sha256").update(fixture).digest("hex") } : {}),
  runs, failures,
  limits: ["No Chromium/Firefox/WebKit execution", "No upstream startup or module compatibility evidence", "No complete native-V8 differential proof", "No security-wrapper/OOM or complete symbol-owner teardown/finalization proof"],
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, runs: runs.length, failures }));
if (failures) process.exitCode = 1;
