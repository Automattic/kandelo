import type { OwnedJobRead } from "../../src/owned-jobs";
import { readRustCompilerJob } from "./rust-guest-job";

const source = `/// Adds two numbers.
///
/// \`\`\`
/// assert_eq!(tooling_probe::add(2, 3), 5);
/// \`\`\`
pub fn add(a:u32,b:u32)->u32{a+b}
pub fn enabled()->bool{return true;}
`;

export const rustDevtoolFiles = {
  "developer-tools/Cargo.toml": `[package]
name="tooling-probe"
version="0.1.0"
edition="2024"
[workspace]
[profile.dev]
debug=0
codegen-units=1
incremental=false
`,
  "developer-tools/src/lib.rs": source,
  "developer-tools/selected-compiler.rs": `use std::os::unix::process::CommandExt;
fn main() {
    std::fs::write("/home/maker/project/developer-tools/compiler-selected", b"configured compiler ran\\n").unwrap();
    let error = std::process::Command::new("/usr/bin/rustc")
        .args(std::env::args_os().skip(1)).exec();
    panic!("configured compiler exec failed: {}", error);
}
`,
};

interface GuestToolHost {
  spawnFromVfs(path: string, argv: string[], options: {
    uid: number; gid: number; cwd: string; env: string[];
    ownedJob: { id: string; timeoutMs: number };
  }): Promise<{ exit: Promise<unknown> }>;
  readOwnedJob(id: string, offset?: number, limit?: number): Promise<OwnedJobRead>;
  releaseOwnedJob(id: string): Promise<void>;
  readFileFromVfs(path: string): Promise<Uint8Array | null>;
  writeFileToVfs(path: string, bytes: Uint8Array): Promise<void>;
}

// One real CLI workflow is run unchanged on Node and each browser engine.
// No host compiler participates in these checks.
export async function exerciseRustDevtools(host: GuestToolHost, env: string[]) {
  const cwd = "/home/maker/project/developer-tools";
  const results: Record<string, Awaited<ReturnType<typeof readRustCompilerJob>>> = {};
  let sequence = 0;
  async function run(name: string, program: string, args: string[], expectedExit = 0, timeoutMs = 300_000) {
    const id = `rust-devtools-${++sequence}`;
    console.info("[Rust developer tools]", name, program, ...args);
    const { exit } = await host.spawnFromVfs(`/usr/bin/${program}`, [program, ...args], {
      uid: 1000, gid: 1000, cwd, env, ownedJob: { id, timeoutMs },
    });
    void exit.catch(() => {});
    const result = await readRustCompilerJob(host, id, timeoutMs + 30_000);
    results[name] = result;
    console.info("[Rust developer tools]", name, result);
    if (result.exitCode !== expectedExit) {
      throw new Error(`${name}: expected exit ${expectedExit}, got ${JSON.stringify(result)}`);
    }
    return result;
  }
  function require(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
  }
  async function read(path: string) {
    const bytes = await host.readFileFromVfs(`${cwd}/${path}`);
    if (!bytes) throw new Error(`missing developer-tool output ${path}`);
    return new TextDecoder().decode(bytes);
  }
  require((await run("rustdoc-version", "rustdoc", ["--version"])).stdout.includes("rustdoc 1.97.0-nightly"),
    "rustdoc must match the compiler");
  require((await run("rustfmt-version", "cargo", ["fmt", "--version"])).stdout.includes("rustfmt"),
    "cargo fmt must find rustfmt");
  require((await run("clippy-version", "cargo", ["clippy", "--version"])).stdout.includes("clippy 0.1.97"),
    "cargo clippy must find the matching Clippy");
  require((await run("unformatted", "cargo", ["fmt", "--", "--check"], 1)).stdout.includes("Diff"),
    "format checking must reject the unformatted source");
  await run("format", "cargo", ["fmt"]);
  await run("formatted", "cargo", ["fmt", "--", "--check"]);
  const formattedSource = await read("src/lib.rs");
  require(formattedSource.includes("pub fn add(a: u32, b: u32) -> u32 {"),
    "rustfmt must actually rewrite the source");
  const rejected = await run("lint-rejection", "cargo",
    ["clippy", "--offline", "-j1", "--", "-Dclippy::needless_return"], 101, 600_000);
  require(/unneeded.*return/.test(rejected.stderr),
    "Clippy must reject the intended lint, rather than a failed compiler launch");
  require(formattedSource.includes("return true;"), "the lint fixture must retain its unnecessary return");
  // Editing source between commands uses the worker-owned VFS, just as the
  // embedding editor does. The positive case changes the code, not lint policy.
  await host.writeFileToVfs(`${cwd}/src/lib.rs`,
    new TextEncoder().encode(formattedSource.replace("return true;", "true")));
  await run("format-fixed-source", "cargo", ["fmt"]);
  await run("lint-clean", "cargo", ["clippy", "--offline", "-j1", "--", "-Dclippy::needless_return"], 0, 600_000);
  await run("documentation", "cargo", ["doc", "--offline", "--no-deps", "-j1"], 0, 600_000);
  const docsHtml = await read("target/doc/tooling_probe/fn.add.html");
  require(docsHtml.includes("Adds two numbers"), "rustdoc must generate the function's HTML documentation");
  const doctests = await run("doctests", "cargo", ["test", "--offline", "-j1", "--doc", "--", "--test-threads=1"], 0, 600_000);
  require(doctests.stdout.includes("test result: ok. 1 passed; 0 failed"),
    "the documentation example must execute, rather than report an empty run");
  await run("build-configured-compiler", "rustc", [
    "selected-compiler.rs", "-Cdebuginfo=0", "-Ccodegen-units=1", "-o", "selected-rustc.wasm",
  ]);
  await run("configured-compiler", "cargo", ["check", "--offline", "-j1", "--config",
    "build.rustc='/home/maker/project/developer-tools/selected-rustc.wasm'",
  ]);
  require((await read("compiler-selected")) === "configured compiler ran\n",
    "Cargo must honor --config build.rustc instead of the default SDK alias");
  return { results, formattedSource, docsHtml };
}
