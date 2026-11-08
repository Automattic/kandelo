import type { OwnedJobRead } from "../../src/owned-jobs";
import { readRustCompilerJob } from "./rust-guest-job";

interface GuestHost {
  spawnFromVfs(path: string, argv: string[], options: {
    uid: number; gid: number; cwd: string; env: string[];
    ownedJob: { id: string; timeoutMs: number };
  }): Promise<{ exit: Promise<unknown> }>;
  readOwnedJob(id: string, offset?: number, limit?: number): Promise<OwnedJobRead>;
  releaseOwnedJob(id: string): Promise<void>;
}

/** The same actual compiler/linker and runtime checks run on both hosts. */
export async function exerciseRustNativeCompatibility(host: GuestHost, env: string[]) {
  const results: Record<string, Awaited<ReturnType<typeof readRustCompilerJob>>> = {};
  let sequence = 0;
  async function cargo(name: string, args: string[], timeoutMs: number) {
    const id = `rust-compatibility-${++sequence}`;
    console.info("[Rust compatibility]", name, ...args);
    const { exit } = await host.spawnFromVfs("/usr/bin/cargo", ["cargo", ...args], {
      uid: 1000, gid: 1000, cwd: "/home/maker/project/compatibility", env,
      ownedJob: { id, timeoutMs },
    });
    void exit.catch(() => {});
    const result = await readRustCompilerJob(host, id, timeoutMs + 30_000);
    results[name] = result;
    console.info("[Rust compatibility]", name, result);
    if (result.exitCode !== 0 || result.status !== "completed") {
      throw new Error(`${name}: ${JSON.stringify(result)}`);
    }
    return result;
  }
  const built = await cargo("native-build-and-run",
    ["run", "--offline", "-j1", "-p", "native-probe"], 600_000);
  if (!built.stdout.includes("C/C++=42/7; generated=17\n")) {
    throw new Error(`native code or generated source did not execute: ${built.stdout}`);
  }
  await cargo("compile-harnesses", ["test", "--offline", "-j1", "--workspace", "--no-run"], 600_000);
  // Separate cold compilation from the deadline for actual test execution.
  const tested = await cargo("native-process-and-thread-tests",
    ["test", "--offline", "-j1", "--workspace", "--", "--test-threads=1"], 180_000);
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
  return results;
}
