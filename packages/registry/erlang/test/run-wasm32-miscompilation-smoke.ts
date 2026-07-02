/**
 * CI gate runner for the wasm32 `-O2` miscompilation smoke matrix (Layer A,
 * authoritative). Runs the shared matrix
 * (./wasm32-miscompilation-matrix.ts) against a real BEAM in ONE boot, then
 * exits non-zero on any mismatch, incompletion, or — critically — if NO active
 * case executed (which would mean the OTP runtime tree is missing in the gate
 * context; silently "passing" there is the design's highest-listed risk, a
 * smoke that never runs). Pending cases (behind an unmerged PR) are reported as
 * expected skips.
 *
 * Invocation (from the bottle-build / smoke job, OTP runtime tree present):
 *   npx tsx packages/registry/erlang/test/run-wasm32-miscompilation-smoke.ts
 *
 * The default BEAM path reuses demo/serve.ts, so it runs whatever
 * `erlang.wasm` + `erlang-install/` the resolver finds (a from-source build or,
 * once published, the fetched `erlang-otp.tar.zst` sidecar extracted into
 * `erlang-install/`).
 *
 * Env:
 *   MISCOMP_BEAM_MODE=native-erl  Run the batch under the host's native `erl`
 *                                 instead of erlang.wasm. For self-testing the
 *                                 RUNNER (parse + exit + outcome lists) without
 *                                 a wasm build; NOT a substitute for the gate.
 *   MISCOMP_OUTCOME_DIR=<dir>     Write passed/failed/skipped outcome lists
 *                                 (durable artifacts per the validation std).
 *   MISCOMP_TIMEOUT_MS=<n>        BEAM run timeout (default 150000).
 */
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import {
  cases,
  activeCases,
  pendingCases,
  buildBatchProgram,
  parseBatchOutput,
  OTP_ORACLE_VERSION,
} from "./wasm32-miscompilation-matrix";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lightweight repo-root finder (workspace Cargo.toml + package.json), used only
// as the cwd for the serve.ts subprocess so `npx tsx` resolves. Kept inline to
// avoid pulling the binary-resolver's vfs/fzstd chain into this small gate
// script (serve.ts resolves its own paths from import.meta.url regardless).
function findRepoRootLite(from: string): string {
  let dir = from;
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "Cargo.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}
const repoRoot = findRepoRootLite(__dirname);
const timeoutMs = Number(process.env.MISCOMP_TIMEOUT_MS ?? 150_000);

function runBeam(program: string): string {
  if (process.env.MISCOMP_BEAM_MODE === "native-erl") {
    return execFileSync("erl", ["-noshell", "-eval", program], {
      encoding: "utf-8",
      timeout: timeoutMs,
    });
  }
  // Authoritative path: run the actual erlang.wasm via the demo launcher.
  const serve = join(__dirname, "..", "demo", "serve.ts");
  return execFileSync("npx", ["tsx", serve, "-eval", program], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function main(): void {
  const program = buildBatchProgram();
  const active = activeCases().map((c) => c.name);
  const pending = pendingCases();

  let stdout = "";
  let runError: unknown = null;
  try {
    stdout = runBeam(program);
  } catch (e: any) {
    // Capture partial output; a crash mid-matrix is itself a finding.
    stdout = (e.stdout ?? "") + "\n" + (e.stderr ?? "");
    runError = e;
  }

  const res = parseBatchOutput(stdout, cases.length);
  const passed = [...res.ok].sort();
  const failed = [...res.failures.keys()].sort();
  const skipped = [...res.skipped.keys()].sort();

  // Durable outcome lists (passed/failed/skipped) for the validation standard.
  const outDir = process.env.MISCOMP_OUTCOME_DIR;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "passed-tests.txt"), passed.join("\n") + "\n");
    writeFileSync(
      join(outDir, "failed-tests.txt"),
      failed.map((n) => res.failures.get(n)).join("\n") + (failed.length ? "\n" : ""),
    );
    writeFileSync(
      join(outDir, "skipped-tests.txt"),
      skipped.map((n) => `${n}\tpending_pr_${res.skipped.get(n)}`).join("\n") +
        (skipped.length ? "\n" : ""),
    );
  }

  // Gate assertions.
  const problems: string[] = [];
  const ranAny = res.ok.size + res.failures.size > 0;
  if (!ranAny) {
    problems.push(
      "NO active case executed — the OTP runtime tree is missing in this gate " +
        "context (erlang.wasm + erlang-install/). This is a false-coverage guard, " +
        "not a pass. Ensure the runtime tree is present before the gate runs.",
    );
  }
  if (!res.completed) {
    problems.push(
      "matrix did not run to completion (no matching 'matrix_done' sentinel) — " +
        "BEAM likely crashed mid-run; output truncated.",
    );
  }
  for (const name of active) {
    if (!res.ok.has(name)) {
      problems.push(res.failures.get(name) ?? `missing 'ok ${name}' (no result line)`);
    }
  }
  for (const c of pending) {
    if (!res.skipped.has(c.name)) {
      problems.push(`pending case '${c.name}' (PR #${c.pendingPr}) was not reported as a skip`);
    }
  }
  if (runError && problems.length === 0) {
    problems.push(`BEAM invocation errored: ${(runError as Error).message}`);
  }

  // Report.
  console.log(`wasm32 -O2 miscompilation smoke — oracle ${OTP_ORACLE_VERSION}`);
  console.log(`  passed:  ${passed.length}/${active.length} active  [${passed.join(", ")}]`);
  console.log(`  skipped: ${skipped.length} pending  [${skipped.join(", ")}]`);
  if (failed.length) console.log(`  FAILED:  ${failed.join(", ")}`);
  for (const f of failed) console.log(`    ${res.failures.get(f)}`);

  if (problems.length) {
    console.error("\nGATE FAIL:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nGATE PASS: all active miscompilation guards green.");
}

main();
