import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGFPE, SIGILL, SIGSEGV } from "../../../host/src/trap-signals";

const __dirname = dirname(fileURLToPath(import.meta.url));
const trapSignalsModulePath = resolve(
  __dirname,
  "../../../host/src/trap-signals.ts",
);

// Browser engines do not all isolate synthetic Wasm traps well enough for a
// stable E2E test. The host tests exercise real traps; this suite verifies that
// the classifier Kandelo ships to browsers maps representative engine messages.
const TRAP_MESSAGE_CASES = [
  {
    name: "v8 memory-oob",
    message: "RuntimeError: memory access out of bounds",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "jsc memory-oob",
    message: "RuntimeError: Out of bounds memory access",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "spidermonkey generic bounds",
    message: "RuntimeError: index out of bounds",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "table index bounds",
    message: "RuntimeError: table index is out of bounds",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "call_indirect bounds",
    message: "RuntimeError: Out of bounds call_indirect",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "divide by zero",
    message: "RuntimeError: divide by zero",
    expectedSignum: SIGFPE,
    expectedSignalName: "SIGFPE",
  },
  {
    name: "integer divide by zero",
    message: "RuntimeError: integer divide by zero",
    expectedSignum: SIGFPE,
    expectedSignalName: "SIGFPE",
  },
  {
    name: "integer overflow",
    message: "RuntimeError: integer overflow",
    expectedSignum: SIGFPE,
    expectedSignalName: "SIGFPE",
  },
  {
    name: "unreachable",
    message: "RuntimeError: unreachable",
    expectedSignum: SIGILL,
    expectedSignalName: "SIGILL",
  },
  {
    name: "unreachable executed",
    message: "RuntimeError: unreachable executed",
    expectedSignum: SIGILL,
    expectedSignalName: "SIGILL",
  },
  {
    name: "indirect type mismatch",
    message: "RuntimeError: indirect call type mismatch",
    expectedSignum: SIGILL,
    expectedSignalName: "SIGILL",
  },
  {
    name: "null indirect function",
    message: "RuntimeError: null function or function signature mismatch",
    expectedSignum: SIGILL,
    expectedSignalName: "SIGILL",
  },
  {
    name: "call_indirect signature mismatch",
    message: "RuntimeError: call_indirect to a signature that does not match",
    expectedSignum: SIGILL,
    expectedSignalName: "SIGILL",
  },
  {
    name: "call_indirect null table entry",
    message: "RuntimeError: call_indirect to a null table entry",
    expectedSignum: SIGILL,
    expectedSignalName: "SIGILL",
  },
  {
    name: "stack overflow",
    message: "RangeError: Maximum call stack size exceeded",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "stack exhausted",
    message: "RuntimeError: call stack exhausted",
    expectedSignum: SIGSEGV,
    expectedSignalName: "SIGSEGV",
  },
  {
    name: "loader compile error",
    message: "CompileError: WebAssembly.compile(): expected magic word",
    expectedSignum: null,
    expectedSignalName: null,
  },
  {
    name: "ABI mismatch",
    message: "ABI version mismatch: program=1 kernel=2",
    expectedSignum: null,
    expectedSignalName: null,
  },
] as const;

for (const trapCase of TRAP_MESSAGE_CASES) {
  test(`@trap-signal classifies ${trapCase.name} in the browser`, async ({
    page,
    baseURL,
    browserName,
  }) => {
    expect(baseURL).toBeTruthy();
    const moduleUrl = new URL(`/@fs/${trapSignalsModulePath}`, baseURL).href;

    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const classification = await page.evaluate(
      async ({ moduleUrl, message }) => {
        const trapSignals = await import(/* @vite-ignore */ moduleUrl);
        return trapSignals.classifyWasmCrashSignal(message) as {
          signum: number;
          signalName: string;
        } | null;
      },
      { moduleUrl, message: trapCase.message },
    );

    if (trapCase.expectedSignum === null) {
      expect(classification, `${browserName} ${trapCase.name}`).toBeNull();
      return;
    }

    expect(classification, `${browserName} ${trapCase.name}`).toMatchObject({
      signum: trapCase.expectedSignum,
      signalName: trapCase.expectedSignalName,
    });
  });
}
