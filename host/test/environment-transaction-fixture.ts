import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureProgramFixtureBuildContract,
  programFixtureNeedsRebuild,
  stampProgramFixture,
  type ProgramFixtureBuildContract,
} from "./program-fixture-freshness";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const buildFlags = [
  "-DKANDELO_ENV_TRANSACTION_TEST_WRAPPERS=1",
  "-Wl,--wrap=malloc",
  "-Wl,--wrap=realloc",
  "-Wl,--wrap=__syscall1",
  "-Wl,--wrap=__syscall3",
] as const;
const contracts = new Map<"wasm32" | "wasm64", ProgramFixtureBuildContract>();

function fixtureBuildContract(
  arch: "wasm32" | "wasm64",
): ProgramFixtureBuildContract {
  const cached = contracts.get(arch);
  if (cached) return cached;

  const compiler = `${arch}posix-cc`;
  const compilerVersion = execFileSync(compiler, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const contract = captureProgramFixtureBuildContract(
    repoRoot,
    `${arch}\nfork=false\nflags=${buildFlags.join(" ")}\n${compilerVersion}`,
    [
      join(repoRoot, "sdk/bin"),
      join(repoRoot, "sdk/src"),
      join(repoRoot, "sdk/package.json"),
      join(repoRoot, "sdk/package-lock.json"),
      join(repoRoot, arch === "wasm64" ? "sysroot64" : "sysroot"),
    ],
  );
  contracts.set(arch, contract);
  return contract;
}

/**
 * Build the public environment fixture with link-time-only failure injection.
 *
 * WHY: transaction regressions must exercise real libc public functions and
 * raw syscall errno conversion without adding a production failure hook.
 */
export function ensureEnvironmentTransactionFixture(
  arch: "wasm32" | "wasm64",
): string {
  const src = join(repoRoot, "examples/putenv_test.c");
  // WHY: the browser contract owns examples/putenv_test*.wasm as ordinary
  // production-linked fixtures. Keep these fault-wrapped binaries in the
  // Node-test tree so test order cannot silently replace browser evidence.
  const out = join(
    fixtureDirectory,
    arch === "wasm64"
      ? "environment-transaction.wasm64.wasm"
      : "environment-transaction.wasm",
  );
  const contract = fixtureBuildContract(arch);
  if (programFixtureNeedsRebuild(src, out, contract)) {
    console.log(`[fixture] Compiling putenv_test.c for ${arch}...`);
    execFileSync(`${arch}posix-cc`, [...buildFlags, src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    stampProgramFixture(src, out, contract);
  }
  return out;
}
