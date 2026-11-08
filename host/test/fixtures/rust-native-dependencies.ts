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

/** Compile the real pinned cc crate and its native output on each host. */
export async function exerciseRustNativeDependencies(host: GuestHost, env: string[], expectCompilerStackLimit = false) {
  async function run(id: string, extraEnv: string[], expectedExit: number) {
    console.info("[Rust native dependency]", id);
    const { exit } = await host.spawnFromVfs("/usr/bin/cargo",
      ["cargo", "run", "--offline", "--locked", "-j1"], {
        uid: 1000, gid: 1000, cwd: "/home/maker/project/ecosystem",
        env: [...env, ...extraEnv], ownedJob: { id, timeoutMs: 600_000 },
      });
    void exit.catch(() => {});
    const result = await readRustCompilerJob(host, id, 630_000);
    console.info("[Rust native dependency]", id, result);
    if (result.exitCode !== expectedExit || result.status !== "completed") {
      throw new Error(`${id}: ${JSON.stringify(result)}`);
    }
    return result;
  }
  const discovery = await run("native-default-discovery", [], 101);
  if (expectCompilerStackLimit) {
    if (!discovery.stderr.includes("could not compile `cc` (lib)") ||
        !discovery.stderr.includes("rustc --crate-name cc ") ||
        !discovery.stderr.includes("(exit status: 139)")) {
      throw new Error(`compiler stack boundary changed: ${discovery.stderr}`);
    }
    // The browser caller additionally requires the actual worker stack-limit
    // diagnostic. This result records a failed capability, not native output.
    return { discovery, configured: null };
  }
  if (!discovery.stderr.includes('failed to find tool "clang"')) {
    throw new Error(`default discovery failed for another reason: ${discovery.stderr}`);
  }
  const configured = await run("native-configured-sdk", [
    "CC=wasm32posix-cc", "CXX=wasm32posix-c++", "AR=wasm32posix-ar", "CXXSTDLIB=c++",
  ], 0);
  if (configured.stdout !== "cc-rs native execution=42/7\n") {
    throw new Error(`native dependency output did not execute: ${configured.stdout}`);
  }
  return { discovery, configured };
}
