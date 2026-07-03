import { describe, expect, it } from "vitest";
import {
  classifiedSignalOrFallback,
  classifiedTrapExitStatus,
  classifyWasmCrashSignal,
  signalExitStatus,
  SIGFPE,
  SIGILL,
  SIGSEGV,
} from "../src/trap-signals";

describe("Wasm trap signal classification", () => {
  it("maps memory and stack traps to SIGSEGV", () => {
    expect(classifyWasmCrashSignal("RuntimeError: memory access out of bounds")).toMatchObject({
      category: "memory",
      signum: SIGSEGV,
      signalName: "SIGSEGV",
    });
    expect(classifyWasmCrashSignal("RuntimeError: Out of bounds memory access")).toMatchObject({
      category: "memory",
      signum: SIGSEGV,
    });
    expect(
      classifyWasmCrashSignal("RuntimeError: operation does not support unaligned accesses"),
    ).toMatchObject({
      category: "memory",
      signum: SIGSEGV,
    });
    expect(classifyWasmCrashSignal("RangeError: Maximum call stack size exceeded")).toMatchObject({
      category: "stack",
      signum: SIGSEGV,
    });
    expect(classifyWasmCrashSignal("RuntimeError: call stack exhausted")).toMatchObject({
      category: "stack",
      signum: SIGSEGV,
    });
  });

  it("maps generic Wasm bounds traps to SIGSEGV", () => {
    for (const message of [
      "RuntimeError: index out of bounds",
      "RuntimeError: table index is out of bounds",
      "RuntimeError: Out of bounds call_indirect",
    ]) {
      expect(classifyWasmCrashSignal(message), message).toMatchObject({
        category: "bounds",
        signum: SIGSEGV,
        signalName: "SIGSEGV",
      });
    }
  });

  it("maps arithmetic traps to SIGFPE", () => {
    for (const message of [
      "RuntimeError: divide by zero",
      "RuntimeError: integer divide by zero",
      "RuntimeError: integer overflow",
      "RuntimeError: remainder by zero",
    ]) {
      expect(classifyWasmCrashSignal(message), message).toMatchObject({
        category: "arithmetic",
        signum: SIGFPE,
        signalName: "SIGFPE",
      });
    }
  });

  it("maps illegal control-flow traps to SIGILL", () => {
    for (const message of [
      "RuntimeError: unreachable",
      "RuntimeError: unreachable executed",
      "RuntimeError: indirect call type mismatch",
      "RuntimeError: null function or function signature mismatch",
      "RuntimeError: call_indirect to a signature that does not match",
      "RuntimeError: call_indirect to a null table entry",
    ]) {
      expect(classifyWasmCrashSignal(message), message).toMatchObject({
        category: "illegal-instruction",
        signum: SIGILL,
        signalName: "SIGILL",
      });
    }
  });

  it("does not classify loader and ABI errors as Wasm trap causes", () => {
    for (const message of [
      "CompileError: WebAssembly.compile(): expected magic word",
      "LinkError: WebAssembly.instantiate(): Import #0 module=\"env\" error",
      "ABI version mismatch: program=1 kernel=2",
    ]) {
      expect(classifyWasmCrashSignal(message), message).toBeNull();
      expect(classifiedTrapExitStatus(message), message).toBeNull();
    }
  });

  it("keeps call_indirect bounds traps separate from null indirect calls", () => {
    const classification = classifyWasmCrashSignal("RuntimeError: Out of bounds call_indirect");
    expect(classification).toMatchObject({
      category: "bounds",
      signum: SIGSEGV,
    });
    expect(classifyWasmCrashSignal("RuntimeError: call_indirect to a null table entry")).toMatchObject({
      category: "illegal-instruction",
      signum: SIGILL,
    });
  });

  it("returns POSIX-style signal exit statuses for classified traps", () => {
    expect(signalExitStatus(SIGILL)).toBe(132);
    expect(signalExitStatus(SIGFPE)).toBe(136);
    expect(signalExitStatus(SIGSEGV)).toBe(139);
    expect(classifiedTrapExitStatus("RuntimeError: divide by zero")).toBe(136);
    expect(classifiedSignalOrFallback("not a wasm trap")).toBe(SIGSEGV);
  });
});
