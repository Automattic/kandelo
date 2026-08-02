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

/*
 * These executable fixtures cover the real Kandelo pthread and worker path.
 * They protect two related safety properties: an existing pthread observes a
 * later grow, and growth can straddle creation of another pthread.
 *
 * They are intentionally not described as the RED reproduction for the
 * startup bug. Minimal guests also pass without the startup synchronization,
 * because a later grow gives Node another chance to update the receiving
 * isolate. The repeated SpiderMonkey test is the product-path RED evidence;
 * the focused isolate test protects the synchronization contract without
 * depending on guest scheduling.
 */

let buildDirectory: string;
const programs = new Map<string, string>();

beforeAll(() => {
  buildDirectory = mkdtempSync(join(tmpdir(), "kandelo-pthread-growth-"));
  for (const fixture of fixtures) {
    const output = join(buildDirectory, fixture.output);
    execFileSync("wasm32posix-cc", [fixture.source, "-o", output], {
      stdio: "inherit",
    });
    programs.set(fixture.output, output);
  }
});

afterAll(() => {
  if (buildDirectory) {
    rmSync(buildDirectory, { recursive: true, force: true });
  }
});

describe("pthread shared WebAssembly.Memory growth", () => {
  for (const fixture of fixtures) {
    it(
      `runs ${basename(fixture.source)} repeatedly`,
      async () => {
        const programPath = programs.get(fixture.output);
        expect(programPath).toBeDefined();

        for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
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
});
