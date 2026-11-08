import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("browser libc conformance inventory", () => {
  it.each(["missing", "empty"])("refuses a %s upstream inventory before starting a browser", (inventory) => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-libc-empty-"));
    roots.push(root);
    const write = (name: string, body: string, executable = false) => {
      const file = join(root, name);
      mkdirSync(resolve(file, ".."), { recursive: true });
      writeFileSync(file, body);
      if (executable) chmodSync(file, 0o755);
    };
    // WHY: execute the real discovery/accounting wrapper, not a textual model
    // of its guard. Only unavailable build/runtime prerequisites are peers.
    for (const name of ["run-browser-libc-tests.sh", "browser-runner-accounting.sh"]) {
      write(`scripts/${name}`, readFileSync(join(repoRoot, "scripts", name), "utf8"));
    }
    write("scripts/resolve-binary.sh", '#!/bin/sh\nprintf "%s\\n" "$(dirname "$0")/../kernel.wasm"\n', true);
    write("scripts/abi-contract-stamp.sh", 'abi_contract_stamp_prepare() { : > "$ABI_PREPARED"; }\n');
    write("sysroot/lib/libc.a", "");
    write("kernel.wasm", "");
    const forbiddenCompile = '#!/bin/sh\n: > "$COMPILER_INVOKED"\nexit 93\n';
    write("bin/clang", forbiddenCompile, true);
    write("sdk/bin/wasm32posix-cc", forbiddenCompile, true);
    write("bin/npx", '#!/bin/sh\n: > "$BROWSER_INVOKED"\nexit 94\n', true);
    if (inventory === "empty") {
      for (const category of ["functional", "regression", "math"]) {
        mkdirSync(join(root, "tests/libc/libc-test/src", category), { recursive: true });
      }
    }
    const abi = join(root, "abi-prepared"), browser = join(root, "browser-invoked");
    const compiler = join(root, "compiler-invoked");
    const result = spawnSync("bash", [join(root, "scripts/run-browser-libc-tests.sh")], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, LLVM_BIN: join(root, "bin"),
        PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
        ABI_PREPARED: abi, BROWSER_INVOKED: browser, COMPILER_INVOKED: compiler },
    });
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    expect(result.signal, output).toBeNull();
    expect(existsSync(abi), output).toBe(true);
    expect(existsSync(compiler), output).toBe(false);
    expect(existsSync(browser), output).toBe(false);
    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Error: no libc-test tests were discovered or selected (categories: functional regression math); is tests/libc/libc-test checked out?");
    expect(output).not.toContain("===== Running");
  });
});
