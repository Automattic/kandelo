import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX,
} from "../../../host/test/fixtures/gc-reference-state-fresh-worker-bytes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
// The Rust image writer. Its wasm arrives as bytes from Node, the shape the
// program fixtures already use; the bridge no longer imports node builtins,
// so a page can transform it like any other module.
const imageFsModulePath = resolve(
  __dirname,
  "../../../images/vfs/lib/kandelo-image-fs.ts",
);
const imageModuleWasmPath = resolve(
  __dirname,
  "../../../local-binaries/kandelo_image_module32.wasm",
);
const catchRefFixtureSource = resolve(
  __dirname,
  "../../../host/test/fixtures/catch-ref-fresh-worker.wat",
);
const referenceCatchPayloadFixtureSource = resolve(
  __dirname,
  "../../../host/test/fixtures/reference-catch-payload-fresh-worker.wat",
);
const forkInstrumenterPath = resolve(
  __dirname,
  "../../../tools/bin/wasm-fork-instrument",
);

interface BrowserFixtureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: Array<{ source: string; message: string }>;
}

async function runBrowserFixture(
  page: Page,
  baseURL: string,
  fixturePath: string,
  argv0: string,
  maxMemoryPages?: number,
): Promise<BrowserFixtureResult> {
  const asViteFsUrl = (path: string) =>
    new URL(`/@fs/${path}`, baseURL).href;

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  return page.evaluate(
    async ({
      browserKernelModuleUrl,
      imageFsModuleUrl,
      imageModuleBytes,
      fixtureUrl,
      argv0,
      maxMemoryPages,
    }) => {
      // WHY: BrowserKernel already imports the VFS modules. Loading the host
      // entry first avoids asking a cold Vite server to optimize the same
      // dependency graph through two concurrent dynamic imports.
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelModuleUrl
      );
      const { KandeloImageFs } = await import(
        /* @vite-ignore */ imageFsModuleUrl
      );
      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";
      const diagnostics: Array<{ source: string; message: string }> = [];
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        ...(maxMemoryPages === undefined ? {} : { maxMemoryPages }),
        onStdout: (data: Uint8Array) => {
          stdout += decoder.decode(data);
        },
        onStderr: (data: Uint8Array) => {
          stderr += decoder.decode(data);
        },
        onHostDiagnostic: (diagnostic: { source: string; message: string }) => {
          diagnostics.push({
            source: diagnostic.source,
            message: diagnostic.message,
          });
        },
      });
      let initialized = false;

      try {
        // WHY: these fixtures do not use files. A minimal image keeps this a
        // BrowserKernel integration proof without coupling it to the much
        // larger shell image or its package publication state.
        const imageOwner = KandeloImageFs.create(new Uint8Array(imageModuleBytes));
        const vfsImage = await imageOwner.saveImage();
        await kernel.initFromImage({ vfsImage });
        initialized = true;

        const response = await fetch(fixtureUrl);
        if (!response.ok) {
          throw new Error(
            `fixture fetch failed: ${response.status} ${fixtureUrl}`,
          );
        }
        const exitCode = await kernel.spawn(
          await response.arrayBuffer(),
          [argv0],
        );
        return { exitCode, stdout, stderr, diagnostics };
      } finally {
        if (initialized) await kernel.destroy();
      }
    },
    {
      browserKernelModuleUrl: asViteFsUrl(browserKernelModulePath),
      imageFsModuleUrl: asViteFsUrl(imageFsModulePath),
      imageModuleBytes: Array.from(readFileSync(imageModuleWasmPath)),
      fixtureUrl: asViteFsUrl(fixturePath),
      argv0,
      maxMemoryPages,
    },
  );
}

/**
 * The recursion depth P-10 and P-11 hold live across fork.
 *
 * Both fixtures call `fork_at_depth(4096)`, and every one of those 4,096
 * activations runs on its FIRST call -- the parent's descent, then the child's
 * rewind -- so an engine that has not tiered the function up yet has to hold
 * 4,096 frames in its baseline tier.
 */
const FIXTURE_FORK_DEPTH = 4096;

/**
 * Can a dedicated Worker in this engine hold `depth` cold Wasm frames at all?
 *
 * A capability measurement, not an engine check. A fresh module is compiled
 * for each attempt and one trivial `(i32) -> i32` function recurses once, so
 * no attempt benefits from an earlier attempt's tier-up; the answer is the
 * deepest of three attempts. Measured on 2026-09-25 (Playwright builds):
 * Chromium Workers held 7,938 to 63,515 such frames, and WebKit Workers
 * 1,003 to 2,117. On WebKit the same function reaches 638,627 frames on the
 * main thread, and 49,817 in a Worker once it has tiered up; no Web API sizes a
 * Worker's stack, and Kandelo processes must run in Workers. Fork
 * instrumentation does not change the cold limit: in a Kandelo process on
 * WebKit, one cold call of P-10's recursion shape overflows between 1,280 and
 * 1,792 frames with and without instrumentation, so no Kandelo-side change can
 * fit 4,096 there.
 *
 * Fixtures only skip when even a trivial function cannot reach their depth.
 * An engine that passes this check and still fails the fixture is a real
 * failure, and the fixture reports it.
 */
async function workerHoldsColdWasmFrames(page: Page, depth: number): Promise<{ holds: boolean; deepest: number }> {
  await page.goto("about:blank");
  return page.evaluate(async (depth) => {
    // (module (func $rec (export "rec") (param i32) (result i32)
    //   (if (result i32) (i32.eqz (local.get 0)) (then (i32.const 0))
    //     (else (i32.add (call $rec (i32.sub (local.get 0) (i32.const 1)))
    //                    (i32.const 1))))))
    const hex =
      "0061736d0100000001060160017f017f030201000707010372656300000a17011500" +
      "200045047f410005200041016b100041016a0b0b";
    const source = `onmessage = (event) => {
      const bytes = new Uint8Array(event.data.bytes);
      const holds = (n) => {
        try {
          new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.rec(n);
          return true;
        } catch {
          return false;
        }
      };
      let deepest = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let lo = 0, hi = event.data.depth;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (holds(mid)) lo = mid; else hi = mid - 1;
        }
        deepest = Math.max(deepest, lo);
      }
      postMessage({ holds: deepest >= event.data.depth, deepest });
    };`;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    try {
      return await new Promise<{ holds: boolean; deepest: number }>((resolve, reject) => {
        worker.onmessage = (message) => resolve(message.data);
        worker.onerror = (error) => reject(new Error(error.message));
        worker.postMessage({ bytes: Array.from(bytes), depth });
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }, depth);
}

/** Skip a deep-continuation fixture only where the engine measurably cannot hold it. */
async function requireColdFrameDepth(page: Page): Promise<void> {
  const { holds, deepest } = await workerHoldsColdWasmFrames(page, FIXTURE_FORK_DEPTH);
  test.skip(
    !holds,
    `this engine's Worker holds at most ${deepest} cold Wasm frames of a trivial ` +
      `function, below the ${FIXTURE_FORK_DEPTH} this fixture keeps live across fork ` +
      `(see docs/browser-support.md, "Fork on WebKit")`,
  );
}

test("grows and replays a continuation beyond ABI 41's fixed reserve", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  await requireColdFrameDepth(page);

  const result = await runBrowserFixture(
    page,
    baseURL!,
    resolveBinary("programs/p_10_deep_linked_continuation.wasm"),
    "p_10_deep_linked_continuation",
  );

  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
  expect(result.stdout).toContain("PRE_DEEP_FORK");
  expect(result.stdout).toContain("DEEP_CHILD: ok");
  expect(result.stdout).toContain("DEEP_PARENT: child=");
  expect(result.stdout).toContain("PASS: P-10");
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
});

test("preserves the parent across root and later continuation ENOMEM", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();
  await requireColdFrameDepth(page);

  const result = await runBrowserFixture(
    page,
    baseURL!,
    resolveBinary("programs/p_11_fork_continuation_enomem.wasm"),
    "p_11_fork_continuation_enomem",
    // Keep the exhaustion loop bounded while leaving enough initial pages for
    // the program and BrowserKernel-owned channel/control memory.
    384,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("ROOT_CONTINUATION_ENOMEM: ok");
  expect(result.stdout).toContain("ROOT_NO_PHANTOM_CHILD: ok");
  expect(result.stdout).toContain("ROOT_PARENT_USABLE: ok");
  expect(result.stdout).toContain("CONTINUATION_ENOMEM: ok");
  expect(result.stdout).toContain("NO_PHANTOM_CHILD: ok");
  expect(result.stdout).toContain("CONTINUATION_PAGE_REUSED: ok");
  expect(result.stdout).toContain("RECOVERY_CHILD: ok");
  expect(result.stdout).toContain("RECOVERY_PARENT: child=");
  expect(result.stdout).toContain("PASS: P-11");
  expect(result.stderr).toBe("");
  expect(result.diagnostics).toEqual([]);
});

test("reconstructs CatchRef state in a fresh child worker", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const workDir = mkdtempSync(
    // Vite deliberately refuses to serve arbitrary host temporary paths.
    // Keep this generated fixture under the checked-out test tree so the
    // browser receives bytes from this exact worktree's allow-listed root.
    resolve(__dirname, ".catch-ref-fresh-worker-"),
  );
  try {
    const rawPath = resolve(workDir, "catch-ref-fresh-worker.raw.wasm");
    const programPath = resolve(workDir, "catch-ref-fresh-worker.wasm");
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      catchRefFixtureSource,
      "-o",
      rawPath,
    ]);
    // Stamp the current ABI at instrumentation time (test-only flag) so the
    // committed fixture, whose __abi_version is a placeholder sentinel rather
    // than a real epoch, tracks the running ABI instead of going stale. This
    // only unblocks the artifact gate; the reconstruction assertions below are
    // what prove correctness.
    execFileSync(forkInstrumenterPath, [
      "--stamp-abi-version",
      rawPath,
      "-o",
      programPath,
    ]);

    // The parent waits for the child, whose exit 91 means CatchRef payload
    // reconstruction failed after the browser worker instantiated a fresh
    // module. The parent reports that wait failure as exit 92.
    const result = await runBrowserFixture(
      page,
      baseURL!,
      programPath,
      "catch-ref-fresh-worker",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("reconstructs reference-bearing catches in fresh child workers", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const workDir = mkdtempSync(
    resolve(__dirname, ".reference-catch-payload-fresh-worker-"),
  );
  try {
    const rawPath = resolve(
      workDir,
      "reference-catch-payload-fresh-worker.raw.wasm",
    );
    const programPath = resolve(
      workDir,
      "reference-catch-payload-fresh-worker.wasm",
    );
    execFileSync("wat2wasm", [
      "--enable-exceptions",
      "--enable-threads",
      referenceCatchPayloadFixtureSource,
      "-o",
      rawPath,
    ]);
    // Stamp the current ABI at instrumentation time (test-only flag) so the
    // committed fixture, whose __abi_version is a placeholder sentinel rather
    // than a real epoch, tracks the running ABI instead of going stale. This
    // only unblocks the artifact gate; the reconstruction assertions below are
    // what prove correctness.
    execFileSync(forkInstrumenterPath, [
      "--stamp-abi-version",
      rawPath,
      "-o",
      programPath,
    ]);

    // One fresh child calls the reconstructed non-null funcref; a second
    // verifies the nullable externref path. Either child exits nonzero if its
    // caught exception recipe depended on the parent's module instance.
    const result = await runBrowserFixture(
      page,
      baseURL!,
      programPath,
      "reference-catch-payload-fresh-worker",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("reconstructs aliased Wasm GC state in a fresh child worker", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  expect(baseURL).toBeTruthy();

  const workDir = mkdtempSync(
    resolve(__dirname, ".gc-reference-state-fresh-worker-"),
  );
  try {
    const rawPath = resolve(workDir, "gc-reference-state.raw.wasm");
    const programPath = resolve(workDir, "gc-reference-state.wasm");
    writeFileSync(
      rawPath,
      Buffer.from(RAW_GC_REFERENCE_STATE_FRESH_WORKER_HEX, "hex"),
    );
    // Stamp the current ABI at instrumentation time (test-only flag) so the
    // committed fixture, whose __abi_version is a placeholder sentinel rather
    // than a real epoch, tracks the running ABI instead of going stale. This
    // only unblocks the artifact gate; the reconstruction assertions below are
    // what prove correctness.
    execFileSync(forkInstrumenterPath, [
      "--stamp-abi-version",
      rawPath,
      "-o",
      programPath,
    ]);

    // The child verifies one cyclic identity through a live parameter,
    // operand-stack carryover, mutable reference global, and mutated typed
    // table. Any fresh-instance alias break exits 91; its waiting parent then
    // exits 92.
    const result = await runBrowserFixture(
      page,
      baseURL!,
      programPath,
      "gc-reference-state-fresh-worker",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diagnostics).toEqual([]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
