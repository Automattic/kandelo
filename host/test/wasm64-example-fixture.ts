import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Build the memory64 counterpart owned by the test that imports it. */
export function ensureWasm64ExampleFixture(cFile: string): string {
  const src = join(repoRoot, "examples", cFile);
  const out = src.replace(/\.c$/, ".wasm64.wasm");
  if (!existsSync(src)) {
    throw new Error(`Missing wasm64 test source: ${src}`);
  }
  if (!existsSync(out) || statSync(src).mtimeMs > statSync(out).mtimeMs) {
    console.log(`[fixture] Compiling ${cFile} for wasm64...`);
    execFileSync("wasm64posix-cc", [src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }
  return out;
}
