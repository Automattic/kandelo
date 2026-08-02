import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const TEST_TIMEOUT_MS = 60_000;
const PROGRAM_TIMEOUT_MS = 10_000;
const ITERATIONS = 10;
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const fixtures = [
  {
    source: join(fixtureDirectory, "pthread-shared-memory-late-growth.c"),
    output: "pthread-shared-memory-late-growth.wasm",
    stdout: "PASS late pthread memory growth\n",
  },
  {
    source: join(
      fixtureDirectory,
      "pthread-shared-memory-growth-across-creation.c",
    ),
    output: "pthread-shared-memory-growth-across-creation.wasm",
    stdout: "PASS pthread growth across creation\n",
  },
] as const;

const architectures = [
  {
    name: "wasm32",
    compiler: "wasm32posix-cc",
    suffix: ".wasm",
    iterations: ITERATIONS,
  },
  {
    name: "wasm64",
    compiler: "wasm64posix-cc",
    suffix: ".wasm64.wasm",
    iterations: 1,
  },
] as const;

/*
 * These executable fixtures cover the real Kandelo pthread and worker path.
 * They protect two related safety properties: an existing pthread observes a
 * later grow, and growth can straddle creation of another pthread.
 *
 * For wasm32, these are intentionally not described as the RED reproduction
 * for the stale-view startup bug: a later grow gives Node another chance to
 * update the receiving isolate. For wasm64, the first pthread startup is a
 * deterministic RED test for the same synchronization boundary because the
 * JavaScript memory64 API rejects a numeric page delta. One wasm64 execution
 * per fixture proves that distinct width contract without multiplying this
 * already-repeated suite's permanent cost.
 */

let buildDirectory: string;
const programs = new Map<string, string>();

beforeAll(() => {
  buildDirectory = mkdtempSync(join(tmpdir(), "kandelo-pthread-growth-"));
  for (const architecture of architectures) {
    for (const fixture of fixtures) {
      const outputName = fixture.output.replace(/\.wasm$/, architecture.suffix);
      const output = join(buildDirectory, outputName);
      execFileSync(architecture.compiler, [fixture.source, "-o", output], {
        stdio: "inherit",
      });
      programs.set(`${architecture.name}:${fixture.output}`, output);
    }
  }
});

afterAll(() => {
  if (buildDirectory) {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
});

describe("pthread shared WebAssembly.Memory growth", () => {
  for (const architecture of architectures) {
    for (const fixture of fixtures) {
      it(
        `runs ${basename(fixture.source)} (${architecture.name})`,
        async () => {
          const programPath = programs.get(
            `${architecture.name}:${fixture.output}`,
          );
          expect(programPath).toBeDefined();

          for (
            let iteration = 1;
            iteration <= architecture.iterations;
            iteration++
          ) {
            const result = await runCentralizedProgram({
              programPath: programPath!,
              argv: [fixture.output],
              timeout: PROGRAM_TIMEOUT_MS,
              useDefaultRootfs: false,
            });
            expect(result, `iteration ${iteration}`).toMatchObject({
              exitCode: 0,
              stdout: fixture.stdout,
              stderr: "",
            });
          }
        },
        TEST_TIMEOUT_MS,
      );
    }
  }
});
