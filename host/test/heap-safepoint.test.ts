/*
 * Process heap safepoints for JavaScriptCore. Runs under V8 (Node, via
 * `vitest`) and JavaScriptCore (Bun, via `npm run test:teardown:bun`).
 *
 * JavaScriptCore is suspected (not confirmed) to keep a blocked worker's
 * heap access, so the syscall glue bounds each wait and calls
 * kernel.kernel_heap_safepoint after a timeout.
 * Under Node the host answers with an unbounded wait after the first
 * timeout; under Bun it keeps answering 100 ms, so the fixture's blocking
 * syscalls pass through several safepoints. Both must return the kernel's
 * result unchanged. See docs/browser-support.md, "JavaScriptCore garbage
 * collection and blocked workers".
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { HEAP_SAFEPOINT_PROCESS_IMPORT } from "../src/generated/abi";
import {
  HEAP_SAFEPOINT_INTERVAL_NS,
  HEAP_SAFEPOINT_UNBOUNDED,
  createHeapSafepointImport,
  engineHoldsHeapAccessWhileWaiting,
  lastHeapSafepointAllocationForTest,
} from "../src/heap-safepoint";
import { buildKernelImportsForTest } from "../src/worker-main";
import { runCentralizedProgram } from "./centralized-test-helper";

const USER_AGENTS = {
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    + "(KHTML, like Gecko) Version/27.0.1 Safari/605.1.15",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 "
    + "(KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  bun: "Bun/1.3.3",
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) "
    + "Chrome/141.0.0.0 Mobile Safari/537.36",
  firefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
  node: "Node.js/24",
} as const;

const fixture = fileURLToPath(
  new URL("./fixtures/heap-safepoint-blocking-wait.wasm", import.meta.url),
);

describe("process heap safepoints", () => {
  it("bounds waits only on JavaScriptCore", () => {
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.safariMac)).toBe(true);
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.safariIos)).toBe(true);
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.bun)).toBe(true);
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.chrome)).toBe(false);
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.chromeAndroid)).toBe(false);
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.firefox)).toBe(false);
    expect(engineHoldsHeapAccessWhileWaiting(USER_AGENTS.node)).toBe(false);
    expect(engineHoldsHeapAccessWhileWaiting(undefined)).toBe(false);
  });

  it("allocates from JavaScript at every safepoint and returns the next bound", () => {
    const webkit = createHeapSafepointImport(USER_AGENTS.safariMac);
    expect(webkit()).toBe(HEAP_SAFEPOINT_INTERVAL_NS);
    const first = lastHeapSafepointAllocationForTest();
    expect(webkit()).toBe(HEAP_SAFEPOINT_INTERVAL_NS);
    expect(lastHeapSafepointAllocationForTest()).toBeInstanceOf(ArrayBuffer);
    expect(lastHeapSafepointAllocationForTest()).not.toBe(first);

    const v8 = createHeapSafepointImport(USER_AGENTS.chrome);
    expect(v8()).toBe(HEAP_SAFEPOINT_UNBOUNDED);
  });

  it("is supplied with the ABI-declared name to every process image", () => {
    const imports = buildKernelImportsForTest(
      new WebAssembly.Memory({ initial: 1 }),
      0,
      4,
    );
    expect(HEAP_SAFEPOINT_PROCESS_IMPORT).toEqual({
      module: "kernel",
      name: "kernel_heap_safepoint",
      params: [],
      results: ["i64"],
    });
    const safepoint = imports[HEAP_SAFEPOINT_PROCESS_IMPORT.name];
    expect(typeof safepoint).toBe("function");
    expect(typeof (safepoint as () => unknown)()).toBe("bigint");
  });

  it(
    "keeps a blocked syscall's result across bounded waits",
    async () => {
      const result = await runCentralizedProgram({
        programPath: fixture,
        argv: ["heap-safepoint-blocking-wait"],
      });
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("heap-safepoint-blocking-wait: ok");
    },
    30_000,
  );
});
