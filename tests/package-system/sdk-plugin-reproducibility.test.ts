import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("reproduces compiler plugin bytes across source and staging paths", () => {
  const llvmBin = process.env.LLVM_BIN;
  if (!llvmBin) throw new Error("Run compiler-plugin checks inside scripts/dev-shell.sh");
  const scratch = mkdtempSync(join(tmpdir(), "kandelo-plugin-repro-"));
  try {
    const outputs = [];
    for (const name of ["short", "a-longer-independent-checkout"]) {
      const source = join(scratch, name, "sdk/src/plugin");
      cpSync(join(repo, "sdk/src/plugin"), source, { recursive: true });
      const output = join(scratch, name, `plugin.tmp-${process.pid}-${name}`,
        process.platform === "darwin" ? "KandeloCallTypes.dylib" : "KandeloCallTypes.so");
      mkdirSync(dirname(output), { recursive: true });
      execFileSync("bash", [join(source, "build.sh"), output], { timeout: 120_000, stdio: "pipe" });
      outputs.push(output);
    }
    // Compare the actual loadable libraries, including native link metadata.
    expect(readFileSync(outputs[0]).equals(readFileSync(outputs[1]))).toBe(true);
    if (process.platform === "darwin") {
      for (const output of outputs) {
        const identity = execFileSync("/usr/bin/otool", ["-D", output], { encoding: "utf8" });
        expect(identity.trim().split("\n").slice(1)).toEqual(["@rpath/KandeloCallTypes.dylib"]);
      }
    }

    const source = join(scratch, "callback.c");
    writeFileSync(source, "typedef int (*callback)(int);\nint invoke(callback f, int x) { return f(x); }\n");
    const objects = outputs.map((plugin, index) => {
      const output = join(scratch, `callback-${index}.o`);
      execFileSync(join(llvmBin, "clang"), ["--target=wasm32-unknown-unknown", "-O2", "-c", source,
        "-Xclang", "-fsanitize=cfi-icall", "-Xclang", "-fsanitize-trap=cfi-icall",
        "-Xclang", "-flto-unit", "-Xclang", "-fwhole-program-vtables",
        "-Xclang", "-load", "-Xclang", plugin, "-Xclang", "-add-plugin",
        "-Xclang", "kandelo-fncasts", `-fpass-plugin=${plugin}`, "-o", output],
      { timeout: 30_000, stdio: "pipe" });
      const sections = execFileSync(join(llvmBin, "llvm-readobj"), ["--sections", output], { encoding: "utf8" });
      expect(sections).toContain("Name: kandelo.calltypes");
      return readFileSync(output);
    });
    expect(objects[0].equals(objects[1])).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240_000);
