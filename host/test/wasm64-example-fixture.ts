import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureProgramFixtureBuildContract,
  programFixtureNeedsRebuild,
  stampProgramFixture,
} from "./program-fixture-freshness";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
let wasm64BuildContract: ReturnType<
  typeof captureProgramFixtureBuildContract
> | null = null;

function fixtureBuildContract() {
  if (wasm64BuildContract) return wasm64BuildContract;
  const compilerVersion = execFileSync("wasm64posix-cc", ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  wasm64BuildContract = captureProgramFixtureBuildContract(
    repoRoot,
    `wasm64\nfork=false\n${compilerVersion}`,
    [
      join(repoRoot, "sdk/bin"),
      join(repoRoot, "sdk/src"),
      join(repoRoot, "sdk/package.json"),
      join(repoRoot, "sdk/package-lock.json"),
      join(repoRoot, "sysroot64"),
    ],
  );
  return wasm64BuildContract;
}

/** Build the memory64 counterpart owned by the test that imports it. */
export function ensureWasm64ExampleFixture(cFile: string): string {
  const src = join(repoRoot, "examples", cFile);
  const out = src.replace(/\.c$/, ".wasm64.wasm");
  if (!existsSync(src)) {
    throw new Error(`Missing wasm64 test source: ${src}`);
  }
  const contract = fixtureBuildContract();
  if (programFixtureNeedsRebuild(src, out, contract)) {
    console.log(`[fixture] Compiling ${cFile} for wasm64...`);
    execFileSync("wasm64posix-cc", [src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    stampProgramFixture(src, out, contract);
  }
  return out;
}
