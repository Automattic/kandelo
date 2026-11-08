import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Build through the public Cargo wrapper, including a no-change second build. */
export function buildRustBacktraceFixture(directory: string): string {
  const target = join(directory, "target");
  const program = join(target, "wasm32-unknown-kandelo-std/debug/kandelo-backtrace.wasm");
  const options = {
    cwd: join(repo, "programs/rust/backtrace"),
    env: {
      ...process.env,
      KANDELO_RUST_DIR: join(directory, "sysroot"),
      CARGO_TARGET_DIR: target,
      RUSTFLAGS: `--remap-path-prefix=${repo}=/usr/src/kandelo --remap-path-prefix=${directory}=/usr/src/kandelo-test`,
    },
    maxBuffer: 64 * 1024 ** 2,
  };
  const build = () => execFileSync("bash", [join(repo, "sdk/bin/wasm32posix-cargo"), "build"], options);
  build();
  const digest = () => createHash("sha256").update(readFileSync(program)).digest("hex");
  const first = digest();
  build();
  if (digest() !== first) throw new Error("unchanged Cargo build changed the prepared backtrace artifact");
  return program;
}
