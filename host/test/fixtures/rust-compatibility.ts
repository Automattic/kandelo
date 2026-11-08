import type { OwnedJobRead } from "../../src/owned-jobs";
import { nativeCSource, rustCompatibilityFiles } from "./rust-compatibility-project";
import { readRustCompilerJob } from "./rust-guest-job";

interface GuestHost {
  spawnFromVfs(path: string, argv: string[], options: {
    uid: number; gid: number; cwd: string; env: string[];
    ownedJob: { id: string; timeoutMs: number };
  }): Promise<{ exit: Promise<unknown> }>;
  readOwnedJob(id: string, offset?: number, limit?: number): Promise<OwnedJobRead>;
  releaseOwnedJob(id: string): Promise<void>;
  writeFileToVfs(path: string, bytes: Uint8Array): Promise<void>;
  readFileFromVfs(path: string): Promise<Uint8Array | null>;
}

/** The same actual compiler/linker and runtime checks run on both hosts. */
export async function exerciseRustNativeCompatibility(host: GuestHost, env: string[]) {
  const results: Record<string, Awaited<ReturnType<typeof readRustCompilerJob>>> = {};
  let sequence = 0;
  const cwd = "/home/maker/project/compatibility";
  async function write(path: string, source: string) {
    await host.writeFileToVfs(`${cwd}/${path}`, new TextEncoder().encode(source));
  }
  function require(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
  }
  async function run(name: string, program: string, args: string[], timeoutMs: number,
    expectedExit = 0, directory = cwd, expectedStatus = "completed") {
    const id = `rust-compatibility-${++sequence}`;
    console.info("[Rust compatibility]", name, program, ...args);
    const { exit } = await host.spawnFromVfs(program, [program.split("/").at(-1)!, ...args], {
      uid: 1000, gid: 1000, cwd: directory, env,
      ownedJob: { id, timeoutMs },
    });
    void exit.catch(() => {});
    const result = await readRustCompilerJob(host, id, timeoutMs + 30_000);
    results[name] = result;
    console.info("[Rust compatibility]", name, result);
    if (result.exitCode !== expectedExit || result.status !== expectedStatus) {
      throw new Error(`${name}: ${JSON.stringify(result)}`);
    }
    return result;
  }
  const cargo = (name: string, args: string[], timeoutMs: number, expectedExit = 0, directory = cwd) =>
    run(name, "/usr/bin/cargo", args, timeoutMs, expectedExit, directory);
  const built = await cargo("native-build-and-run",
    ["run", "--offline", "-j1", "-p", "native-probe"], 600_000);
  if (!built.stdout.includes("C/C++=42/7; generated=17\n")) {
    throw new Error(`native code or generated source did not execute: ${built.stdout}`);
  }
  // A native object can compile while its final executable still cannot link.
  await write("native-probe/native.c", nativeCSource.replace("return 42;",
    "extern int deliberately_missing_native_symbol(void); return deliberately_missing_native_symbol();"));
  const missing = await cargo("missing-native-symbol", ["build", "--offline", "-j1", "-p", "native-probe"], 600_000, 101);
  require(missing.stderr.includes("deliberately_missing_native_symbol") && /undefined symbol/.test(missing.stderr),
    `expected final-link rejection: ${missing.stderr}`);
  await write("native-probe/native.c", nativeCSource.replace("return 42;", "return 43;"));
  const rebuilt = await cargo("changed-native-source", ["run", "--offline", "-j1", "-p", "native-probe"], 600_000);
  require(rebuilt.stdout.includes("C/C++=43/7; generated=17"), "Cargo did not rebuild changed native source");
  await write("native-probe/native.c", nativeCSource);
  const restored = await cargo("restored-native-source", ["run", "--offline", "-j1", "-p", "native-probe"], 600_000);
  require(restored.stdout.includes("C/C++=42/7; generated=17"), "native source recovery failed");
  const cached = await cargo("unchanged-native-source", ["run", "--offline", "-j1", "-p", "native-probe"], 180_000);
  require(!cached.stderr.includes("Compiling") && cached.stdout.includes("C/C++=42/7"), "unchanged native build was not reused");
  await cargo("compile-harnesses", ["test", "--offline", "-j1", "--workspace", "--no-run"], 600_000);
  // Separate cold compilation from the deadline for actual test execution.
  const tested = await cargo("native-process-and-thread-tests",
    ["test", "--offline", "-j1", "--workspace", "--lib", "--bins", "--tests", "--", "--test-threads=1"], 180_000);
  for (const expected of [
    "test result: ok. 3 passed; 0 failed",
    "test result: ok. 2 passed; 0 failed",
    "native_code_and_generated_source ... ok",
    "synchronization ... ok",
    "subprocess_streams_environment_and_exit ... ok",
    "panic_aborts_only_the_child ... ok",
  ]) {
    if (!tested.stdout.includes(expected)) throw new Error(`missing ${expected}: ${tested.stdout}`);
  }
  const doctests = await cargo("doctest-attributes", ["test", "--offline", "-j1", "--doc", "--", "--test-threads=1"], 600_000);
  const marker = await host.readFileFromVfs("/tmp/rust-doctest-executed");
  require(marker !== null && new TextDecoder().decode(marker) === "native doctest ran", "positive native doctest did not execute");
  require(await host.readFileFromVfs("/tmp/rust-doctest-no-run") === null, "no_run doctest executed");
  for (const expected of [
    "test result: ok. 3 passed; 0 failed; 0 ignored",
    "test result: ok. 1 passed; 0 failed; 1 ignored",
    "- compile ... ok", "- should panic ... ok", "- compile fail ... ok",
  ]) require(doctests.stdout.includes(expected), `missing doctest attribute result ${expected}: ${doctests.stdout}`);
  const libPath = "native-probe/src/lib.rs";
  const libSource = rustCompatibilityFiles[`compatibility/${libPath}`]!;
  await write(libPath, libSource + `
/// \`\`\`
/// assert!(false, "deliberately failing doctest sentinel");
/// \`\`\`
pub fn failing_documentation_control() {}
`);
  const failedDoc = await cargo("failing-doctest", ["test", "--offline", "-j1", "--doc", "--", "--test-threads=1"], 600_000, 101);
  require((failedDoc.stdout + failedDoc.stderr).includes("deliberately failing doctest sentinel"), "negative doctest failed for another reason");
  await write(libPath, libSource);
  await cargo("restored-doctests", ["test", "--offline", "-j1", "--doc", "--", "--test-threads=1"], 600_000);

  const executable = `${cwd}/target/debug/native-probe.wasm`;
  const timed = await run("process-family-timeout", executable, ["--wait-parent"], 20_000, 137, cwd, "timed_out");
  const pids = [...timed.stdout.matchAll(/timeout (?:parent|child)=(\d+)/g)].map(match => match[1]!);
  require(pids.length === 2 && new Set(pids).size === 2, `both timeout processes must start: ${timed.stdout}`);
  const reaped = await run("timeout-family-reaped", executable, ["--check-pids", ...pids], 30_000);
  require(reaped.stdout.includes("timed-out family reaped"), "timeout family was not reaped");
  const healthy = await run("machine-healthy-after-timeout", executable, [], 30_000);
  require(healthy.stdout.includes("C/C++=42/7; generated=17"), "machine failed after timeout");

  // This is a known unsupported target boundary, not successful expansion.
  const macros = await cargo("external-procedural-macro-boundary", ["run", "--offline", "-j1", "-p", "macro-consumer"],
    180_000, 101, `${cwd}/macro`);
  require(macros.stderr.includes("cannot produce proc-macro") && macros.stderr.includes("does not support these crate types"),
    `procedural macro boundary changed; investigate actual expansion support: ${macros.stderr}`);
  require(!macros.stdout.includes("real macro expansion=42"), "procedural macro unexpectedly expanded");
  return results;
}
