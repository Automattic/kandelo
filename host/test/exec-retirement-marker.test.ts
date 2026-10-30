import { describe, expect, it, vi } from "vitest";

import {
  ABI_SYSCALLS,
  CH_SYSCALL,
  CH_REQUEST_FLAGS,
  CHANNEL_REQUEST_FLAG_OPAQUE_RECORD,
  CH_SIG_BASE,
  CH_SIG_SIGNUM,
  CH_SIG_SI_CODE,
} from "../src/generated/abi";
import { buildKernelImportsForTest, isExecRetirementMarker } from "../src/worker-main";
import { EXEC_RETIRE_SIGNAL_CODE, EXIT_RETIRE_SIGNAL_CODE } from "../src/worker-protocol";

describe("exec worker retirement marker", () => {
  it("reads the marker from the generated ABI layout", () => {
    const channelOffset = 64;
    const view = new DataView(
      new ArrayBuffer(channelOffset + CH_SIG_SI_CODE + 4),
    );
    view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
    view.setUint32(
      channelOffset + CH_SIG_SI_CODE,
      EXEC_RETIRE_SIGNAL_CODE,
      true,
    );

    expect(isExecRetirementMarker(view, channelOffset)).toBe(true);

    view.setUint32(channelOffset + CH_SIG_SI_CODE, 0, true);
    // ABI 42 placed si_code four bytes earlier. A stale derived offset must
    // not accidentally become worker protocol after an ABI layout change.
    view.setUint32(
      channelOffset + CH_SIG_BASE + 24,
      EXEC_RETIRE_SIGNAL_CODE,
      true,
    );
    expect(isExecRetirementMarker(view, channelOffset)).toBe(false);
  });
  it("uses trap semantics and preserves the private marker across import adapters", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const channelOffset = 64;
    const view = new DataView(memory.buffer);
    view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
    view.setUint32(channelOffset + CH_SIG_SI_CODE, EXEC_RETIRE_SIGNAL_CODE, true);
    const imports = buildKernelImportsForTest(memory, channelOffset, 4);

    // An ordinary Error reaches libc++'s noexcept handler instead of unwinding
    // the discarded image. A local import adapter can replace a trap object,
    // so the worker boundary must still be able to identify its private marker.
    expect(() => (imports.kernel_exit as CallableFunction)(137))
      .toThrow(WebAssembly.RuntimeError);
    expect(isExecRetirementMarker(view, channelOffset)).toBe(true);
  });

  it.each(["exit", "exec", "retired"])("%s cannot enter a guest catch-all/noexcept handler", mode => {
    // (module (import "host" "exit" (func $exit (param i32)))
    //   (func (export "run") (result i32)
    //     (block $caught (try_table (catch_all $caught)
    //       i32.const 137 call $exit) i32.const 0 return) i32.const 1))
    const guest = new WebAssembly.Module(new Uint8Array([
      0,97,115,109,1,0,0,0,1,9,2,96,1,127,0,96,0,1,127,2,13,1,4,104,
      111,115,116,4,101,120,105,116,0,0,3,2,1,1,7,7,1,3,114,117,110,0,
      1,10,23,1,21,0,2,64,31,64,1,2,0,65,137,1,16,0,11,65,0,15,11,65,1,11,
    ]));
    const runWith = (exit: CallableFunction) =>
      new WebAssembly.Instance(guest, { host: { exit } }).exports.run as () => number;
    // A JavaScript-thrown RuntimeError is an ordinary catchable host exception.
    expect(runWith(() => { throw new WebAssembly.RuntimeError("unreachable"); })()).toBe(1);

    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const channelOffset = 64;
    const view = new DataView(memory.buffer);
    if (mode !== "exit") {
      view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
      view.setUint32(channelOffset + CH_SIG_SI_CODE,
        mode === "exec" ? EXEC_RETIRE_SIGNAL_CODE : EXIT_RETIRE_SIGNAL_CODE, true);
    }
    const imports = buildKernelImportsForTest(memory, channelOffset, 4);
    // Model the kernel's completed exit handshake without another Worker.
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("not-equal");
    try {
      expect(runWith(imports.kernel_exit as CallableFunction)).toThrow(WebAssembly.RuntimeError);
    } finally {
      wait.mockRestore();
    }
  });

  it("unwinds an already-exited Worker without publishing a second exit syscall", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const channelOffset = 64;
    const view = new DataView(memory.buffer);
    view.setUint32(channelOffset + CH_SIG_SIGNUM, 9, true);
    view.setUint32(channelOffset + CH_SIG_SI_CODE, EXIT_RETIRE_SIGNAL_CODE, true);
    view.setUint32(channelOffset + CH_SYSCALL, ABI_SYSCALLS.Getpid, true);
    const imports = buildKernelImportsForTest(memory, channelOffset, 4);
    expect(() => (imports.kernel_exit as CallableFunction)(137)).toThrow(WebAssembly.RuntimeError);
    expect(view.getUint32(channelOffset + CH_SYSCALL, true)).toBe(ABI_SYSCALLS.Getpid);
    expect(view.getUint32(channelOffset + CH_SIG_SI_CODE, true)).toBe(EXIT_RETIRE_SIGNAL_CODE);
    expect(isExecRetirementMarker(view, channelOffset)).toBe(false);
  });

  it("publishes a fresh raw exit after an unhandled record request is torn down", () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const channelOffset = 64;
    const view = new DataView(memory.buffer);
    // Machine teardown may complete a PENDING request before dispatch has
    // consumed its flags. The exit import must not inherit that record path.
    view.setUint32(channelOffset + CH_REQUEST_FLAGS, CHANNEL_REQUEST_FLAG_OPAQUE_RECORD, true);
    const imports = buildKernelImportsForTest(memory, channelOffset, 4);
    const flags: number[] = [];
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      flags.push(view.getUint32(channelOffset + CH_REQUEST_FLAGS, true));
      return "not-equal";
    });
    try {
      expect(() => (imports.kernel_exit as CallableFunction)(137)).toThrow(WebAssembly.RuntimeError);
      expect(flags).toEqual([0]);
      expect(view.getUint32(channelOffset + CH_SYSCALL, true)).toBe(ABI_SYSCALLS.Exit);
    } finally {
      wait.mockRestore();
    }
  });

});
