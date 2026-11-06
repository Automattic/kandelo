import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHostScratchTempRoot } from "../centralized-test-helper";

interface FixtureOptions {
  forkInstrument?: boolean;
  arch?: "wasm32" | "wasm64";
}

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Apply the same ABI digest as the normal package and fixture builders. */
export function stampFixtureAbiContract(programPath: string): void {
  const configured = process.env.WASM_POSIX_XTASK_BIN;
  const target = configured ? undefined
    : execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)![1];
  execFileSync(configured ?? "cargo", [
    ...(configured ? [] : ["run", "-p", "xtask", "--target", target!, "--quiet", "--"]),
    "stamp-abi-contract", programPath,
  ], { cwd: root, stdio: "pipe" });
}

/** Build and stamp a test-owned guest using the current SDK and ABI contract. */
export function compileSdkFixture(
  source: URL, linkArgs: string[] = [],
  { forkInstrument = false, arch = "wasm32" }: FixtureOptions = {},
) {
  const scratch = makeHostScratchTempRoot("sdk-fixture-");
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const programPath = join(scratch, "probe.wasm");
  try {
    const linked = forkInstrument ? `${programPath}.linked` : programPath;
    execFileSync(join(root, `sdk/bin/${arch}posix-cc`), [
      fileURLToPath(source), "-O2", ...linkArgs, "-o", linked,
    ], { cwd: root, stdio: "pipe" });
    if (forkInstrument) execFileSync("bash", [
      join(root, "scripts/run-wasm-fork-instrument.sh"), linked, "-o", programPath,
    ], { cwd: root, stdio: "pipe" });
    stampFixtureAbiContract(programPath);
    return { programPath, cleanup };
  } catch (error) { cleanup(); throw error; }
}
