import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureProgramFixtureBuildContract,
  programFixtureNeedsRebuild,
  sdkProgramBuildInputs,
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
    sdkProgramBuildInputs(repoRoot, "wasm64"),
  );
  return wasm64BuildContract;
}

let hostTarget: string | null = null;

/**
 * Stamp this checkout's kandelo.abi.contract digest, as global-setup does for
 * the fixtures it builds. Without it the host warns that a program compiled
 * seconds ago is a legacy pre-rollout binary. scripts/build-programs.sh stamps
 * only what it builds itself, so this builder must stamp its own outputs.
 */
function stampAbiContract(out: string): void {
  hostTarget ??= execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "))
    ?.slice(6)
    .trim() ?? null;
  if (!hostTarget) {
    throw new Error("could not determine the Rust host target");
  }
  execFileSync(
    "cargo",
    [
      "run",
      "-p",
      "xtask",
      "--target",
      hostTarget,
      "--quiet",
      "--",
      "stamp-abi-contract",
      out,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
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
    stampAbiContract(out);
  }
  return out;
}
