import { describe, expect, it, vi } from "vitest";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_REQUEST_FLAGS,
  CH_RETURN,
  CH_SIG_FLAGS,
  CH_SIG_SIGNUM,
  CH_STATUS,
  CH_SYSCALL,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CHANNEL_REQUEST_FLAG_CANCELLATION_POINT,
  CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
  CHANNEL_REQUEST_FLAGS_KNOWN_MASK,
  KERNEL_WAIT_RESULT_CHILD_UID_OFFSET,
  KERNEL_WAIT_RESULT_RUSAGE_OFFSET,
  KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
  KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
  KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
  PROCESS_SIGINFO_CODE_OFFSET,
  PROCESS_SIGINFO_SIGNO_OFFSET,
  PROCESS_SIGINFO_WASM32_PID_OFFSET,
  PROCESS_SIGINFO_WASM32_SIZE,
  PROCESS_SIGINFO_WASM32_UID_OFFSET,
  PROCESS_SIGINFO_WASM32_VALUE_OFFSET,
  PROCESS_SIGINFO_WASM64_PID_OFFSET,
  PROCESS_SIGINFO_WASM64_SIZE,
  PROCESS_SIGINFO_WASM64_UID_OFFSET,
  PROCESS_SIGINFO_WASM64_VALUE_OFFSET,
  PROCESS_STATE_EXITED,
  PROCESS_STATE_RUNNING,
  PROCESS_STATE_STOPPED,
  STRUCT_SIZE_KERNEL_WAIT_RESULT,
  STRUCT_SIZE_WASM_RUSAGE_WIRE,
  WAIT_CLD_EXITED,
  WAIT_CLD_STOPPED,
  WAIT_EVENT_EXITED,
  WAIT_EVENT_STOPPED,
  WAIT_WEXITED,
  WAIT_WNOHANG,
  WAIT_WNOWAIT,
  WAIT_WSTOPPED,
  WAKE_PROCESS_CONTINUED,
  WAKE_PROCESS_STOPPED,
} from "../src/generated/abi";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const SIGCHLD = 17;
const SIGCONT = 18;
const SIGTERM = 15;
const SIGUSR1 = 10;
const SA_RESTART = 0x10000000;

describe("Rust-owned process wait lifecycle", () => {
  it("wait4 atomically consumes a Rust-selected event and copies status+rusage", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const statusPtr = 256;
    const waitStatus = 5 << 8;
    const rusage = Uint8Array.from(
      { length: STRUCT_SIZE_WASM_RUSAGE_WIRE },
      (_, index) => index & 0xff,
    );
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number | bigint,
    ) => {
      writeKernelWaitResult(kernelMemory, Number(resultPtr), {
        waitStatus,
        siCode: 1,
        siStatus: 5,
        childUid: 123,
        rusage,
      });
      return 42;
    });
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_wait_child_poll: waitChildPoll,
      kernel_reap_exited_child: reapExitedChild,
    }, 4, kernelMemory);
    const completeChannel = observeMarshalledCompletions(worker);

    const rusagePtr = 512;
    const channel = registerMainChannel(worker, createChannel(7, processMemory));
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(-1, statusPtr, 0, rusagePtr),
    );

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      7,
      -1,
      WAIT_EVENT_EXITED,
      0,
      128,
      STRUCT_SIZE_KERNEL_WAIT_RESULT,
    );
    expect(reapExitedChild).not.toHaveBeenCalled();
    expect(new DataView(processMemory.buffer).getInt32(statusPtr, true)).toBe(waitStatus);
    expect(new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    )).toEqual(rusage);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(-1, statusPtr, 0, rusagePtr),
      undefined,
      42,
      0,
    );
  });

  it("wait4 leaves blocking waits in the host queue when Rust reports a running child", () => {
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    worker.waitingForChild = [];
    const completeChannel = observeMarshalledCompletions(worker);

    const channel = createChannel(7, createSharedMemory());
    registerMainChannel(worker, channel);
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0],
    );

    expect(completeChannel).not.toHaveBeenCalled();
    expect(worker.waitingForChild).toEqual([
      {
        cancellationPoint: false,
        cancellationWakeAllowed: false,
        parentPid: 7,
        channel,
        origArgs: syscallArgs(-1, 0, 0, 0),
        pid: -1,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
    ]);
  });

  it("honors cancellation that lands before a wait can enqueue", () => {
    const waitChildPoll = vi.fn(() => 0);
    const kernelMemory = createSharedMemory();
    const cancellationCleanupRequests: Array<readonly [number, bigint]> = [];
    const handleChannel = successfulKernelHandle(kernelMemory, (view) => {
      cancellationCleanupRequests.push([
        view.getUint32(CH_SYSCALL, true),
        view.getBigInt64(CH_ARGS, true),
      ]);
    });
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    const worker = createWorkerHarness({
      kernel_handle_channel: handleChannel,
      kernel_wait_child_poll: waitChildPoll,
    }, 4, kernelMemory);
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.pendingCancels = new Set([channel]);
    worker.waitingForChild = [];
    const relistenChannel = observeRelisten(worker);

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0],
      true,
    );

    // Cancellation is consumed at the final boundary immediately before the
    // host would register the waiter, after Rust proves the child is still
    // running.
    expect(waitChildPoll).toHaveBeenCalledOnce();
    // WHY: the host may publish EINTR only after Rust confirms exact-task
    // cleanup. This is a real synthetic kernel request, not a test-only
    // shortcut around the production cancellation protocol.
    expect(cancellationCleanupRequests).toEqual([
      [ABI_SYSCALLS.ThreadCancel, 7n],
    ]);
    expect(worker.waitingForChild).toEqual([]);
    expect(readCompletion(channel)).toEqual({
      retVal: -4,
      errVal: 4,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(relistenChannel).toHaveBeenCalledWith(channel);
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s preserves cancellation-point identity until wait registration",
    (_name, pointerWidth) => {
      const waitChildPoll = vi.fn(() => 0);
      const kernelMemory = createSharedMemory();
      const cancellationCleanupRequests: Array<readonly [number, bigint]> = [];
      const handleChannel = successfulKernelHandle(kernelMemory, (view) => {
        cancellationCleanupRequests.push([
          view.getUint32(CH_SYSCALL, true),
          view.getBigInt64(CH_ARGS, true),
        ]);
      });
      const processMemory = createSharedMemory();
      const channel = createChannel(7, processMemory);
      const worker = createWorkerHarness(
        {
          kernel_handle_channel: handleChannel,
          kernel_wait_child_poll: waitChildPoll,
        },
        pointerWidth,
        kernelMemory,
      );
      worker.processes = new Map([[7, {
        channels: [channel],
        memory: processMemory,
      }]]);
      worker.pendingCancels = new Set([channel]);
      worker.waitingForChild = [];
      const relistenChannel = observeRelisten(worker);

      dispatchLifecycleSyscall(
        worker,
        channel,
        ABI_SYSCALLS.Wait4,
        [-1, 0, 0, 0],
        true,
      );

      expect(
        new DataView(
          processMemory.buffer,
          channel.channelOffset,
        ).getUint32(CH_REQUEST_FLAGS, true),
      ).toBe(0);
      expect(waitChildPoll).toHaveBeenCalledOnce();
      expect(cancellationCleanupRequests).toEqual([
        [ABI_SYSCALLS.ThreadCancel, 7n],
      ]);
      expect(worker.waitingForChild).toEqual([]);
      expect(worker.pendingCancels.has(channel)).toBe(false);
      expect(readCompletion(channel)).toEqual({
        retVal: -4,
        errVal: 4,
        status: CHANNEL_STATUS_COMPLETE,
      });
      expect(relistenChannel).toHaveBeenCalledWith(channel);
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s clears and rejects unknown request identity bits",
    (_name, pointerWidth) => {
      const waitChildPoll = vi.fn(() => 0);
      const memory = createSharedMemory();
      const channel = createChannel(7, memory);
      const worker = createWorkerHarness(
        { kernel_wait_child_poll: waitChildPoll },
        pointerWidth,
      );
      registerMainChannel(worker, channel);
      markPending(channel);
      const view = new DataView(memory.buffer, channel.channelOffset);
      view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Wait4, true);
      view.setUint32(
        CH_REQUEST_FLAGS,
        CHANNEL_REQUEST_FLAGS_KNOWN_MASK | 8,
        true,
      );

      worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

      expect(view.getUint32(CH_REQUEST_FLAGS, true)).toBe(0);
      expect(waitChildPoll).not.toHaveBeenCalled();
      expect(readCompletion(channel)).toEqual({
        retVal: -1,
        errVal: 22,
        status: CHANNEL_STATUS_COMPLETE,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s rejects cancellation-wake authority without cancellation-point identity",
    (_name, pointerWidth) => {
      const waitChildPoll = vi.fn(() => 0);
      const memory = createSharedMemory();
      const channel = createChannel(7, memory);
      const worker = createWorkerHarness(
        { kernel_wait_child_poll: waitChildPoll },
        pointerWidth,
      );
      registerMainChannel(worker, channel);
      markPending(channel);
      const view = new DataView(memory.buffer, channel.channelOffset);
      view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Wait4, true);
      view.setUint32(
        CH_REQUEST_FLAGS,
        CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED,
        true,
      );

      worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);

      expect(view.getUint32(CH_REQUEST_FLAGS, true)).toBe(0);
      expect(waitChildPoll).not.toHaveBeenCalled();
      expect(readCompletion(channel)).toEqual({
        retVal: -1,
        errVal: 22,
        status: CHANNEL_STATUS_COMPLETE,
      });
    },
  );

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s does not consume a pending cancel for plain wait4",
    (_name, pointerWidth) => {
      const waitChildPoll = vi.fn(() => 0);
      const processMemory = createSharedMemory();
      const channel = createChannel(7, processMemory);
      const worker = createWorkerHarness(
        { kernel_wait_child_poll: waitChildPoll },
        pointerWidth,
      );
      worker.processes = new Map([[7, {
        channels: [channel],
        memory: processMemory,
      }]]);
      worker.pendingCancels = new Set([channel]);
      worker.waitingForChild = [];
      markPending(channel);

      dispatchLifecycleSyscall(
        worker,
        channel,
        ABI_SYSCALLS.Wait4,
        [-1, 0, 0, 0],
        false,
      );

      expect(waitChildPoll).toHaveBeenCalledOnce();
      expect(worker.pendingCancels.has(channel)).toBe(true);
      expect(worker.waitingForChild).toEqual([
        expect.objectContaining({
          channel,
          syscallNr: ABI_SYSCALLS.Wait4,
          cancellationPoint: false,
        }),
      ]);
      expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
    },
  );

  it("consumes a pre-enqueue cancel only for the exact FIFO open retry", () => {
    const memory = createSharedMemory();
    const channel = createChannel(7, memory);
    const blockingRetryToken = 91n;
    const tokenForRetry = vi.fn(() => blockingRetryToken);
    const releaseRetry = vi.fn(() => 0);
    const kernelSyscalls: number[] = [];
    const handleChannel = vi.fn((channelPtr: number | bigint) => {
      const view = new DataView(memory.buffer, Number(channelPtr));
      const syscallNr = view.getUint32(CH_SYSCALL, true);
      kernelSyscalls.push(syscallNr);
      const isOpen = syscallNr === ABI_SYSCALLS.Open;
      view.setBigInt64(CH_RETURN, BigInt(isOpen ? -1 : 0), true);
      view.setUint32(CH_ERRNO, isOpen ? 11 : 0, true);
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_blocking_retry_release: releaseRetry,
      kernel_blocking_retry_token: tokenForRetry,
      kernel_handle_channel: handleChannel,
    }, 4, memory);
    registerMainChannel(worker, channel);
    worker.pendingCancels = new Set([channel]);
    const relistenChannel = observeRelisten(worker);
    new TextEncoder().encodeInto(
      "/fifo\0",
      new Uint8Array(memory.buffer, 1024, 6),
    );

    expect(worker.pendingCancels.has(channel)).toBe(true);

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Open,
      [1024, 0, 0],
      true,
    );

    expect(worker.pendingCancels.has(channel)).toBe(false);
    expect(kernelSyscalls).toEqual([
      ABI_SYSCALLS.Open,
      ABI_SYSCALLS.ThreadCancel,
    ]);
    expect(tokenForRetry).toHaveBeenCalledOnce();
    expect(tokenForRetry).toHaveBeenCalledWith(
      channel.pid,
      channel.pid,
      ABI_SYSCALLS.Open,
    );
    expect(releaseRetry).toHaveBeenCalledOnce();
    expect(releaseRetry).toHaveBeenCalledWith(
      channel.pid,
      channel.pid,
      blockingRetryToken,
    );
    expect(readCompletion(channel)).toEqual({
      retVal: -4,
      errVal: 4,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(relistenChannel).toHaveBeenCalledOnce();
    expect(relistenChannel).toHaveBeenCalledWith(channel);
  });

  it("wait4 WNOHANG completes without queuing when Rust reports no event", () => {
    const worker = createWorkerHarness({ kernel_wait_child_poll: vi.fn(() => 0) });
    worker.waitingForChild = [];
    const completeChannel = observeMarshalledCompletions(worker);

    const channel = registerMainChannel(worker, createChannel(7, createSharedMemory()));
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(-1, 0, WAIT_WNOHANG, 0),
    );

    expect(worker.waitingForChild).toEqual([]);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(-1, 0, WAIT_WNOHANG, 0),
      undefined,
      0,
      0,
    );
  });

  it("wait4 passes a bigint status pointer for wasm64 kernels", () => {
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll }, 8);
    worker.waitingForChild = [];
    const completeChannel = observeMarshalledCompletions(worker);

    const channel = registerMainChannel(worker, createChannel(7, createSharedMemory()));
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(-1, 0, WAIT_WNOHANG, 0),
    );

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      7,
      -1,
      WAIT_EVENT_EXITED,
      0,
      BigInt(128),
      STRUCT_SIZE_KERNEL_WAIT_RESULT,
    );
    expect(worker.waitingForChild).toEqual([]);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(-1, 0, WAIT_WNOHANG, 0),
      undefined,
      0,
      0,
    );
  });

  it("returns EFAULT before polling or consuming an event for invalid wait4 outputs", () => {
    const waitChildPoll = vi.fn(() => 42);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    const completeChannel = observeMarshalledCompletions(worker);
    const processMemory = createSharedMemory();
    const invalidStatusPtr = processMemory.buffer.byteLength - 2;
    const args = [-1, invalidStatusPtr, 0, 0];
    const channel = registerMainChannel(
      worker,
      createChannel(7, processMemory),
    );

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(...args),
    );

    expect(waitChildPoll).not.toHaveBeenCalled();
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      syscallArgs(...args),
      undefined,
      -1,
      14,
    );
  });

  it("waitid passes STOPPED+WNOWAIT and writes exact CLD, uid, status, and rusage", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const siginfoPtr = 512;
    const rusagePtr = 1024;
    const rusage = new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE).fill(0x5a);
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number | bigint,
    ) => {
      writeKernelWaitResult(kernelMemory, Number(resultPtr), {
        waitStatus: (19 << 8) | 0x7f,
        siCode: WAIT_CLD_STOPPED,
        siStatus: 19,
        childUid: 4242,
        rusage,
      });
      return 44;
    });
    const worker = createWorkerHarness(
      { kernel_wait_child_poll: waitChildPoll },
      4,
      kernelMemory,
    );
    const completeChannel = observeMarshalledCompletions(worker);
    const args = syscallArgs(
      1,
      44,
      siginfoPtr,
      WAIT_WSTOPPED | WAIT_WNOWAIT,
      rusagePtr,
    );

    const channel = registerMainChannel(worker, createChannel(7, processMemory));
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Waitid,
      syscallArgs(...args),
    );

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      7,
      44,
      WAIT_EVENT_STOPPED,
      WAIT_WNOWAIT,
      128,
      STRUCT_SIZE_KERNEL_WAIT_RESULT,
    );
    const siginfo = new DataView(processMemory.buffer);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_SIGNO_OFFSET,
      true,
    )).toBe(SIGCHLD);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_CODE_OFFSET,
      true,
    )).toBe(WAIT_CLD_STOPPED);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_WASM32_PID_OFFSET,
      true,
    )).toBe(44);
    expect(siginfo.getUint32(
      siginfoPtr + PROCESS_SIGINFO_WASM32_UID_OFFSET,
      true,
    )).toBe(4242);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_WASM32_VALUE_OFFSET,
      true,
    )).toBe(19);
    expect(new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    )).toEqual(rusage);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Waitid,
      args,
      undefined,
      0,
      0,
    );
  });

  it("waitid writes musl's aligned wasm64 siginfo fields", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    const siginfoPtr = 512;
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number | bigint,
    ) => {
      writeKernelWaitResult(kernelMemory, Number(resultPtr), {
        waitStatus: 9 << 8,
        siCode: WAIT_CLD_EXITED,
        siStatus: 9,
        childUid: 5150,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 44;
    });
    const worker = createWorkerHarness(
      { kernel_wait_child_poll: waitChildPoll },
      8,
      kernelMemory,
    );
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
      ptrWidth: 8,
    }]]);
    observeMarshalledCompletions(worker);
    const args = [1, 44, siginfoPtr, WAIT_WEXITED, 0];
    new Uint8Array(
      processMemory.buffer,
      siginfoPtr,
      PROCESS_SIGINFO_WASM64_SIZE,
    ).fill(0xa5);

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Waitid,
      args,
    );

    const siginfo = new DataView(processMemory.buffer);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_SIGNO_OFFSET,
      true,
    )).toBe(SIGCHLD);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_CODE_OFFSET,
      true,
    )).toBe(WAIT_CLD_EXITED);
    expect(siginfo.getUint32(
      siginfoPtr + PROCESS_SIGINFO_CODE_OFFSET + Int32Array.BYTES_PER_ELEMENT,
      true,
    )).toBe(0);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_WASM64_PID_OFFSET,
      true,
    )).toBe(44);
    expect(siginfo.getUint32(
      siginfoPtr + PROCESS_SIGINFO_WASM64_UID_OFFSET,
      true,
    )).toBe(5150);
    expect(siginfo.getInt32(
      siginfoPtr + PROCESS_SIGINFO_WASM64_VALUE_OFFSET,
      true,
    )).toBe(9);
    expect(siginfo.getUint8(
      siginfoPtr + PROCESS_SIGINFO_WASM64_SIZE - 1,
    )).toBe(0);
  });

  it("waitid WNOHANG zeros all siginfo bytes and leaves rusage untouched", () => {
    const processMemory = createSharedMemory();
    const siginfoPtr = 512;
    const rusagePtr = 1024;
    new Uint8Array(
      processMemory.buffer,
      siginfoPtr,
      PROCESS_SIGINFO_WASM32_SIZE,
    ).fill(0xa5);
    new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    ).fill(0x6b);
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    const completeChannel = observeMarshalledCompletions(worker);
    const args = syscallArgs(
      0,
      0,
      siginfoPtr,
      WAIT_WEXITED | WAIT_WNOHANG,
      rusagePtr,
    );

    const channel = registerMainChannel(worker, createChannel(7, processMemory));
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Waitid,
      args,
    );

    expect(new Uint8Array(
      processMemory.buffer,
      siginfoPtr,
      PROCESS_SIGINFO_WASM32_SIZE,
    )).toEqual(new Uint8Array(PROCESS_SIGINFO_WASM32_SIZE));
    expect(new Uint8Array(
      processMemory.buffer,
      rusagePtr,
      STRUCT_SIZE_WASM_RUSAGE_WIRE,
    )).toEqual(new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE).fill(0x6b));
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Waitid,
      args,
      undefined,
      0,
      0,
    );
  });

  it("rejects invalid waitid idtypes and required null siginfo before polling", () => {
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({ kernel_wait_child_poll: waitChildPoll });
    const completeChannel = observeMarshalledCompletions(worker);
    const channel = registerMainChannel(
      worker,
      createChannel(7, createSharedMemory()),
    );

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Waitid,
      [99, 0, 512, WAIT_WEXITED, 0],
    );
    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Waitid,
      [0, 0, 0, WAIT_WEXITED, 0],
    );

    expect(waitChildPoll).not.toHaveBeenCalled();
    expect(completeChannel.mock.calls.map((call: unknown[]) => call[5]))
      .toEqual([22, 14]);
  });

  it("owns a drained wake batch before nested SIGCHLD work reuses scratch", () => {
    const kernelMemory = createSharedMemory();
    const drain = vi.fn((outPtr: number, _outLen: number, _max: number) => {
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_STOPPED);
      writeWakeEvent(kernelMemory, outPtr, 1, 43, WAKE_PROCESS_CONTINUED);
      return 2;
    });
    const worker = createWorkerHarness(
      {
        kernel_drain_wakeup_events: drain,
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_has_sa_nocldstop: vi.fn(() => 0),
      },
      4,
      kernelMemory,
    );
    worker.stoppedPids = new Set();
    const sendSignalToProcess = vi.fn(() => {
      new Uint8Array(kernelMemory.buffer).fill(0xff);
    });
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.drainAndProcessWakeupEvents();

    expect(worker.stoppedPids.has(42)).toBe(true);
    expect(worker.pendingResumePids.has(43)).toBe(true);
    expect(sendSignalToProcess).toHaveBeenCalledTimes(2);
    expect(sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD, true);
  });

  it("keeps SIGCONT release final after retry and kill publications", async () => {
    const kernelMemory = createSharedMemory();
    const parentMemory = createSharedMemory();
    const childMemory = createSharedMemory();
    const parentChannel = createChannel(7, parentMemory);
    const childChannel = createChannel(42, childMemory);
    let continuedPending = false;
    const handleChannel = vi.fn((channelPtr: number | bigint) => {
      const view = new DataView(kernelMemory.buffer, Number(channelPtr));
      const syscallNr = view.getUint32(CH_SYSCALL, true);
      const targetPid = Number(view.getBigInt64(CH_ARGS, true));
      const signum = Number(
        view.getBigInt64(CH_ARGS + CH_ARG_SIZE, true),
      );
      if (
        syscallNr === ABI_SYSCALLS.Kill
        && targetPid === 42
        && signum === SIGCONT
      ) {
        continuedPending = true;
      }
      view.setBigInt64(CH_RETURN, 0n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const drain = vi.fn((outPtr: number) => {
      if (!continuedPending) return 0;
      continuedPending = false;
      writeWakeEvent(
        kernelMemory,
        outPtr,
        0,
        42,
        WAKE_PROCESS_CONTINUED,
      );
      return 1;
    });
    const worker = createWorkerHarness({
      kernel_drain_wakeup_events: drain,
      kernel_get_parent_pid: vi.fn((pid: number) => pid === 42 ? 7 : 0),
      kernel_get_process_state: vi.fn(() => PROCESS_STATE_RUNNING),
      kernel_handle_channel: handleChannel,
      kernel_has_sa_nocldstop: vi.fn(() => 0),
      kernel_pick_signal_target_tid: vi.fn(() => 0),
    }, 4, kernelMemory);
    worker.processes = new Map([
      [7, { pid: 7, channels: [parentChannel], memory: parentMemory }],
      [42, { pid: 42, channels: [childChannel], memory: childMemory }],
    ]);
    worker.channelTids = new Map([
      ["7:0", 7],
      ["42:0", 42],
    ]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    const relistenChannel = observeRelisten(worker);
    markPending(parentChannel);

    // This is the production ordering that failed in the real worker:
    // resume requests its detached transaction while the enclosing kill still
    // has to queue retry scheduling and mailbox publication.
    dispatchLifecycleSyscall(
      worker,
      parentChannel,
      ABI_SYSCALLS.Kill,
      [42, SIGCONT],
    );
    await drainLifecycleGate();

    expect(readCompletion(parentChannel)).toEqual({
      retVal: 0,
      errVal: 0,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(worker.stoppedPids.has(42)).toBe(false);
    expect(relistenChannel).toHaveBeenCalledWith(parentChannel);
    expect(handleChannel).toHaveBeenCalledTimes(2);
  });

  it("does not report CONTINUED when resume preflight stops the process again", () => {
    const kernelMemory = createSharedMemory();
    let drained = false;
    const drain = vi.fn((outPtr: number) => {
      if (drained) return 0;
      drained = true;
      writeWakeEvent(
        kernelMemory,
        outPtr,
        0,
        43,
        WAKE_PROCESS_CONTINUED,
      );
      return 1;
    });
    const worker = createWorkerHarness(
      {
        kernel_drain_wakeup_events: drain,
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_get_process_state: vi.fn(() => PROCESS_STATE_STOPPED),
        kernel_has_sa_nocldstop: vi.fn(() => 0),
      },
      4,
      kernelMemory,
    );
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    const sendSignalToProcess = vi.fn();
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.drainAndProcessWakeupEvents();

    expect(worker.stoppedPids.has(43)).toBe(false);
    expect(sendSignalToProcess).not.toHaveBeenCalled();
  });

  it("drains a STOPPED transition generated while CONTINUED preflight fails", () => {
    const kernelMemory = createSharedMemory();
    let batch = 0;
    const drain = vi.fn((outPtr: number) => {
      if (batch++ === 0) {
        writeWakeEvent(
          kernelMemory,
          outPtr,
          0,
          43,
          WAKE_PROCESS_CONTINUED,
        );
        return 1;
      }
      if (batch === 2) {
        writeWakeEvent(
          kernelMemory,
          outPtr,
          0,
          43,
          WAKE_PROCESS_STOPPED,
        );
        return 1;
      }
      return 0;
    });
    const worker = createWorkerHarness(
      {
        kernel_drain_wakeup_events: drain,
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_get_process_state: vi.fn()
          .mockReturnValueOnce(PROCESS_STATE_RUNNING)
          .mockReturnValue(PROCESS_STATE_STOPPED),
        kernel_has_sa_nocldstop: vi.fn(() => 0),
      },
      4,
      kernelMemory,
    );
    worker.stoppedPids = new Set();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    const sendSignalToProcess = vi.fn();
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.drainAndProcessWakeupEvents();

    expect(drain).toHaveBeenCalledTimes(2);
    expect(worker.stoppedPids.has(43)).toBe(true);
    expect(sendSignalToProcess).toHaveBeenCalledOnce();
    expect(sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD, true);
  });

  it("drains overflow wake batches until a short batch includes lifecycle events", () => {
    const kernelMemory = createSharedMemory();
    let batch = 0;
    const drain = vi.fn((outPtr: number) => {
      if (batch++ === 0) {
        for (let i = 0; i < 256; i++) {
          writeWakeEvent(kernelMemory, outPtr, i, i + 100, 1);
        }
        return 256;
      }
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_STOPPED);
      return 1;
    });
    const worker = createWorkerHarness(
      {
        kernel_drain_wakeup_events: drain,
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_has_sa_nocldstop: vi.fn(() => 0),
      },
      4,
      kernelMemory,
    );
    worker.stoppedPids = new Set();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    const sendSignalToProcess = vi.fn();
    configureBoundaryHooks(worker, {
      scheduleWakeBlockedRetries: vi.fn(),
      sendSignalToProcess,
    });

    worker.drainAndProcessWakeupEvents();

    expect(drain).toHaveBeenCalledTimes(2);
    expect(worker.stoppedPids.has(42)).toBe(true);
    expect(sendSignalToProcess).toHaveBeenCalledOnce();
  });

  it("finalizes signal death before a stale continue event can notify or reap", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(42, processMemory);
    let drained = false;
    const drain = vi.fn((outPtr: number) => {
      if (drained) return 0;
      drained = true;
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_CONTINUED);
      return 1;
    });
    let exitSignal = SIGTERM;
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_drain_wakeup_events: drain,
      kernel_get_process_state: vi.fn(() => 2),
      kernel_get_process_exit_signal: vi.fn(() => exitSignal),
    }, 4, kernelMemory);
    worker.processes = new Map([[42, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.hostReaped = new Set();
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.pendingSleeps = new Map();
    worker.callbacks = { onExit };

    worker.drainAndProcessWakeupEvents();

    expect(worker.hostReaped.has(42)).toBe(true);
    expect(onExit).toHaveBeenCalledWith(42, 128 + SIGTERM);
    expect(worker.pendingResumePids.has(42)).toBe(false);
  });

  it("wakes a matching parent waiter while SA_NOCLDSTOP suppresses only SIGCHLD", () => {
    const waitChildPoll = vi.fn(() => 0);
    const kernelMemory = createSharedMemory();
    let drained = false;
    const drain = vi.fn((outPtr: number) => {
      if (drained) return 0;
      drained = true;
      writeWakeEvent(
        kernelMemory,
        outPtr,
        0,
        42,
        WAKE_PROCESS_STOPPED,
      );
      return 1;
    });
    const worker = createWorkerHarness({
      kernel_drain_wakeup_events: drain,
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldstop: vi.fn(() => 1),
      kernel_wait_child_poll: waitChildPoll,
    }, 4, kernelMemory);
    const parentChannel = registerMainChannel(
      worker,
      createChannel(7, createSharedMemory()),
    );
    worker.waitingForChild = [{
      cancellationPoint: false,
      cancellationWakeAllowed: false,
      parentPid: 7,
      channel: parentChannel,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    const sendSignalToProcess = vi.fn();
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.drainAndProcessWakeupEvents();

    expect(sendSignalToProcess).not.toHaveBeenCalled();
    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      7,
      -1,
      WAIT_EVENT_EXITED,
      0,
      128,
      STRUCT_SIZE_KERNEL_WAIT_RESULT,
    );
    expect(worker.waitingForChild).toHaveLength(1);
  });

  it("uses WNOWAIT for process-group waiter rechecks", () => {
    const waitChildPoll = vi.fn(() => 0);
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    const worker = createWorkerHarness({
      kernel_handle_channel: successfulKernelHandle(kernelMemory),
      kernel_wait_child_poll: waitChildPoll,
    }, 4, kernelMemory);
    worker.processes = new Map([[7, { channels: [channel], memory: processMemory }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [0, 0, 0, 0],
      pid: 0,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    observeMarshalledCompletions(worker);

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Setpgid,
      [0, 0],
    );

    expect(waitChildPoll).toHaveBeenCalledWith(
      7,
      7,
      0,
      WAIT_EVENT_EXITED,
      WAIT_WNOWAIT,
      128,
      STRUCT_SIZE_KERNEL_WAIT_RESULT,
    );
  });

  it("services status that becomes eligible after a process-group change", () => {
    const kernelMemory = createSharedMemory();
    const channel = createChannel(7, createSharedMemory());
    let pollCount = 0;
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number,
    ) => {
      pollCount++;
      writeKernelWaitResult(kernelMemory, resultPtr, {
        waitStatus: 0,
        siCode: WAIT_CLD_EXITED,
        siStatus: 0,
        childUid: 0,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 42;
    });
    const worker = createWorkerHarness({
      kernel_handle_channel: successfulKernelHandle(kernelMemory),
      kernel_wait_child_poll: waitChildPoll,
    }, 4, kernelMemory);
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: channel.memory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [0, 0, 0, 0],
      pid: 0,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    const completeChannel = observeMarshalledCompletions(worker);

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Setpgid,
      [0, 0],
    );

    expect(pollCount).toBe(2);
    expect(waitChildPoll.mock.calls.map((call: unknown[]) => call[4]))
      .toEqual([WAIT_WNOWAIT, 0]);
    expect(worker.waitingForChild).toEqual([]);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      [0, 0, 0, 0],
      undefined,
      42,
      0,
    );
  });

  it("completes a consuming waiter and a following ECHILD waiter in one wake", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(7, processMemory, 0);
    const second = createChannel(7, processMemory, 256);
    let drained = false;
    const drain = vi.fn((outPtr: number) => {
      if (drained) return 0;
      drained = true;
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_STOPPED);
      return 1;
    });
    let pollCount = 0;
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      _targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number,
    ) => {
      if (pollCount++ > 0) return -10; // ECHILD after the first wait reaps.
      writeKernelWaitResult(kernelMemory, resultPtr, {
        waitStatus: 3 << 8,
        siCode: WAIT_CLD_EXITED,
        siStatus: 3,
        childUid: 12,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 42;
    });
    const worker = createWorkerHarness(
      {
        kernel_drain_wakeup_events: drain,
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_has_sa_nocldstop: vi.fn(() => 1),
        kernel_wait_child_poll: waitChildPoll,
      },
      4,
      kernelMemory,
    );
    worker.processes = new Map([[7, {
      channels: [first, second],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map([["7:256", 8]]);
    const completeChannel = observeMarshalledCompletions(worker);
    worker.waitingForChild = [
      {
        parentPid: 7,
        channel: first,
        origArgs: [42, 1024, 0, 0],
        pid: 42,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
      {
        parentPid: 7,
        channel: second,
        origArgs: [42, 1280, 0, 0],
        pid: 42,
        options: 0,
        syscallNr: ABI_SYSCALLS.Wait4,
      },
    ];

    worker.drainAndProcessWakeupEvents();

    expect(worker.waitingForChild).toEqual([]);
    expect(completeChannel.mock.calls.map((call: unknown[]) => call.slice(4)))
      .toEqual([[42, 0], [-1, 10]]);
    expect(new DataView(processMemory.buffer).getInt32(1024, true)).toBe(3 << 8);
  });

  it("completes every matching WNOWAIT waiter while leaving a running waiter blocked", () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(7, processMemory, 0);
    const second = createChannel(7, processMemory, 256);
    const running = createChannel(7, processMemory, 512);
    let drained = false;
    const drain = vi.fn((outPtr: number) => {
      if (drained) return 0;
      drained = true;
      writeWakeEvent(kernelMemory, outPtr, 0, 42, WAKE_PROCESS_STOPPED);
      return 1;
    });
    const waitChildPoll = vi.fn((
      _parentPid: number,
      _callerTid: number,
      targetPid: number,
      _eventMask: number,
      _flags: number,
      resultPtr: number,
    ) => {
      if (targetPid === 43) return 0;
      writeKernelWaitResult(kernelMemory, resultPtr, {
        waitStatus: 0,
        siCode: WAIT_CLD_EXITED,
        siStatus: 0,
        childUid: 99,
        rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
      });
      return 42;
    });
    const worker = createWorkerHarness(
      {
        kernel_drain_wakeup_events: drain,
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_has_sa_nocldstop: vi.fn(() => 1),
        kernel_wait_child_poll: waitChildPoll,
      },
      4,
      kernelMemory,
    );
    worker.processes = new Map([[7, {
      channels: [first, second, running],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map([
      ["7:256", 8],
      ["7:512", 9],
    ]);
    const completeChannel = observeMarshalledCompletions(worker);
    const options = WAIT_WEXITED | WAIT_WNOWAIT;
    const makeWaiter = (channel: any, pid: number, siginfoPtr: number) => ({
      parentPid: 7,
      channel,
      origArgs: [1, pid, siginfoPtr, options, 0],
      pid,
      options,
      syscallNr: ABI_SYSCALLS.Waitid,
    });
    const runningWaiter = makeWaiter(running, 43, 1536);
    worker.waitingForChild = [
      makeWaiter(first, 42, 1024),
      runningWaiter,
      makeWaiter(second, 42, 1280),
    ];

    worker.drainAndProcessWakeupEvents();

    expect(worker.waitingForChild).toEqual([runningWaiter]);
    expect(completeChannel).toHaveBeenCalledTimes(2);
    expect(waitChildPoll.mock.calls.filter((call: unknown[]) => call[2] === 42))
      .toEqual([
        [
          7,
          7,
          42,
          WAIT_EVENT_EXITED,
          WAIT_WNOWAIT,
          128,
          STRUCT_SIZE_KERNEL_WAIT_RESULT,
        ],
        [
          7,
          8,
          42,
          WAIT_EVENT_EXITED,
          WAIT_WNOWAIT,
          128,
          STRUCT_SIZE_KERNEL_WAIT_RESULT,
        ],
      ]);
    expect(new DataView(processMemory.buffer).getInt32(
      1024 + PROCESS_SIGINFO_WASM32_PID_OFFSET,
      true,
    )).toBe(42);
    expect(new DataView(processMemory.buffer).getInt32(
      1280 + PROCESS_SIGINFO_WASM32_PID_OFFSET,
      true,
    )).toBe(42);
  });

  it("interrupts the exact host-deferred wait thread with its caught signal", () => {
    const kernelMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const processMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const channel = createChannel(7, processMemory);
    const dequeue = vi.fn((_pid: number, _tid: number, outPtr: number) => {
      const view = new DataView(kernelMemory.buffer);
      view.setUint32(outPtr, SIGUSR1, true);
      view.setUint32(outPtr + 8, SA_RESTART, true);
      return SIGUSR1;
    });
    const worker = createWorkerHarness({
      kernel_pick_signal_target_tid: vi.fn(() => 7),
      kernel_dequeue_signal: dequeue,
      kernel_wait_child_poll: vi.fn(() => 0),
    }, 4, kernelMemory);
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    const completeChannel = observeMarshalledCompletions(worker);

    worker.testAuthority.sendSignalForTest(7, SIGUSR1, false);

    expect(worker.waitingForChild).toEqual([]);
    expect(completeChannel).toHaveBeenCalledWith(
      channel,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0],
      undefined,
      -1,
      4,
    );
    const signalView = new DataView(processMemory.buffer);
    expect(signalView.getUint32(CH_SIG_SIGNUM, true)).toBe(SIGUSR1);
    expect(signalView.getUint32(CH_SIG_FLAGS, true)).toBe(SA_RESTART);
  });

  it("removes and wakes an exact wait cancellation point", () => {
    const kernelMemory = createSharedMemory();
    const memory = createSharedMemory();
    const caller = createChannel(7, memory, 0);
    const target = createChannel(7, memory, 256);
    const worker = createWorkerHarness({
      kernel_handle_channel: successfulKernelHandle(kernelMemory),
    }, 4, kernelMemory);
    worker.processes = new Map([[7, {
      channels: [caller, target],
      memory,
    }]]);
    worker.channelTids = new Map([["7:256", 99]]);
    worker.pendingCancels = new Set();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.waitingForChild = [{
      cancellationPoint: true,
      cancellationWakeAllowed: true,
      parentPid: 7,
      channel: target,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    const relistenChannel = observeRelisten(worker);
    markPending(caller);
    markPending(target);

    dispatchLifecycleSyscall(
      worker,
      caller,
      ABI_SYSCALLS.ThreadCancel,
      [99],
    );

    expect(worker.waitingForChild).toEqual([]);
    // Completing the exact blocked target consumes the host-side token; the
    // guest pthread cancellation bit remains the authoritative notification.
    expect(worker.pendingCancels.has(target)).toBe(false);
    expect(readCompletion(caller)).toEqual({
      retVal: 0,
      errVal: 0,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(readCompletion(target)).toEqual({
      retVal: -4,
      errVal: 4,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(relistenChannel).toHaveBeenCalledWith(target);
  });

  it("does not wake a plain wait4 parked beside cancellation-point waiters", () => {
    const kernelMemory = createSharedMemory();
    const memory = createSharedMemory();
    const caller = createChannel(7, memory, 0);
    const target = createChannel(7, memory, 256);
    const waitChildPoll = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_handle_channel: successfulKernelHandle(kernelMemory),
      kernel_wait_child_poll: waitChildPoll,
    }, 4, kernelMemory);
    worker.processes = new Map([[7, {
      channels: [caller, target],
      memory,
    }]]);
    worker.channelTids = new Map([["7:256", 99]]);
    worker.pendingCancels = new Set();
    worker.waitingForChild = [];
    const relistenChannel = observeRelisten(worker);
    markPending(target);

    dispatchLifecycleSyscall(
      worker,
      target,
      ABI_SYSCALLS.Wait4,
      [-1, 0, 0, 0],
      false,
    );
    expect(waitChildPoll).toHaveBeenCalledOnce();
    expect(worker.waitingForChild).toEqual([
      expect.objectContaining({
        channel: target,
        syscallNr: ABI_SYSCALLS.Wait4,
        cancellationPoint: false,
      }),
    ]);

    markPending(caller);
    dispatchLifecycleSyscall(
      worker,
      caller,
      ABI_SYSCALLS.ThreadCancel,
      [99],
    );

    expect(worker.waitingForChild).toEqual([
      expect.objectContaining({
        channel: target,
        syscallNr: ABI_SYSCALLS.Wait4,
        cancellationPoint: false,
      }),
    ]);
    expect(worker.pendingCancels.has(target)).toBe(true);
    expect(readStatus(target)).toBe(CHANNEL_STATUS_PENDING);
    expect(readCompletion(caller)).toEqual({
      retVal: 0,
      errVal: 0,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(relistenChannel).not.toHaveBeenCalledWith(target);
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s leaves a cancellation-disabled wait blocked and preserves its pending cancel",
    (_name, pointerWidth) => {
      const kernelMemory = createSharedMemory();
      const memory = createSharedMemory();
      const caller = createChannel(7, memory, 0);
      const target = createChannel(7, memory, 256);
      let childReady = false;
      let drained = false;
      const waitChildPoll = vi.fn((
        _parentPid: number,
        _callerTid: number,
        _targetPid: number,
        _eventMask: number,
        _flags: number,
        resultPtr: number | bigint,
      ) => {
        if (!childReady) return 0;
        writeKernelWaitResult(kernelMemory, Number(resultPtr), {
          waitStatus: 12 << 8,
          siCode: WAIT_CLD_EXITED,
          siStatus: 12,
          childUid: 0,
          rusage: new Uint8Array(STRUCT_SIZE_WASM_RUSAGE_WIRE),
        });
        return 42;
      });
      const worker = createWorkerHarness({
        kernel_drain_wakeup_events: vi.fn((outPtr: number | bigint) => {
          if (!childReady || drained) return 0;
          drained = true;
          writeWakeEvent(
            kernelMemory,
            Number(outPtr),
            0,
            42,
            WAKE_PROCESS_STOPPED,
          );
          return 1;
        }),
        kernel_get_parent_pid: vi.fn(() => 7),
        kernel_handle_channel: successfulKernelHandle(kernelMemory),
        kernel_has_sa_nocldstop: vi.fn(() => 1),
        kernel_wait_child_poll: waitChildPoll,
      }, pointerWidth, kernelMemory);
      worker.processes = new Map([[7, {
        channels: [caller, target],
        memory,
      }]]);
      worker.channelTids = new Map([["7:256", 99]]);
      worker.pendingCancels = new Set();
      worker.waitingForChild = [];
      const relistenChannel = observeRelisten(worker);
      markPending(target);

      // A cancellation point without cancellation-wake authority represents
      // PTHREAD_CANCEL_DISABLE. The request stays parked even after the host
      // records pthread_cancel for its exact thread.
      dispatchLifecycleSyscall(
        worker,
        target,
        ABI_SYSCALLS.Wait4,
        [-1, 0, 0, 0],
        true,
        false,
      );
      expect(worker.waitingForChild).toHaveLength(1);

      markPending(caller);
      dispatchLifecycleSyscall(
        worker,
        caller,
        ABI_SYSCALLS.ThreadCancel,
        [99],
      );

      expect(worker.waitingForChild).toHaveLength(1);
      expect(worker.pendingCancels.has(target)).toBe(true);
      expect(readStatus(target)).toBe(CHANNEL_STATUS_PENDING);
      expect(relistenChannel).not.toHaveBeenCalledWith(target);

      childReady = true;
      worker.drainAndProcessWakeupEvents();

      expect(worker.waitingForChild).toEqual([]);
      expect(readCompletion(target)).toEqual({
        retVal: 42,
        errVal: 0,
        status: CHANNEL_STATUS_COMPLETE,
      });
      expect(worker.pendingCancels.has(target)).toBe(true);
    },
  );

  it("retires an interrupted engine futex waiter before a later wake quota", async () => {
    const memory = createSharedMemory();
    const first = createChannel(7, memory, 0);
    const second = createChannel(7, memory, 256);
    const waker = createChannel(7, memory, 512);
    const futexPtr = 4096;
    new Int32Array(memory.buffer)[futexPtr >>> 2] = 0;
    const worker = createWorkerHarness({});
    worker.processes = new Map([[7, {
      channels: [first, second, waker],
      memory,
    }]]);
    worker.pendingFutexWaits = new Map();
    observeRelisten(worker);
    markPending(first);
    markPending(second);

    dispatchLifecycleSyscall(
      worker,
      first,
      ABI_SYSCALLS.Futex,
      [futexPtr, 0, 0, 0, 0, 0],
    );
    dispatchLifecycleSyscall(
      worker,
      second,
      ABI_SYSCALLS.Futex,
      [futexPtr, 0, 0, 0, 0, 0],
    );
    expect(worker.pendingFutexWaits.size).toBe(2);

    worker.pendingFutexWaits.get(first).interrupt(-4, 4);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(worker.pendingFutexWaits.size).toBe(0);
    expect(readCompletion(first)).toMatchObject({ retVal: -4, errVal: 4 });
    expect(readCompletion(second)).toMatchObject({ retVal: 0, errVal: 0 });

    markPending(second);
    dispatchLifecycleSyscall(
      worker,
      second,
      ABI_SYSCALLS.Futex,
      [futexPtr, 0, 0, 0, 0, 0],
    );
    expect(worker.pendingFutexWaits.size).toBe(1);
    markPending(waker);
    dispatchLifecycleSyscall(
      worker,
      waker,
      ABI_SYSCALLS.Futex,
      [futexPtr, 1, 1, 0, 0, 0],
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(readCompletion(waker)).toMatchObject({ retVal: 1, errVal: 0 });
    expect(readCompletion(second)).toMatchObject({ retVal: 0, errVal: 0 });
    expect(worker.pendingFutexWaits.size).toBe(0);
  });

  it("retires futex and cancel state with an exact thread channel", () => {
    const memory = createSharedMemory();
    const channel = createChannel(7, memory, 256);
    const retire = vi.fn();
    const worker = createWorkerHarness({});
    worker.processes = new Map([[7, { channels: [channel], memory }]]);
    worker.activeChannels = [channel];
    worker.stoppedPids = new Set();
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.resumePreparedSignals = new WeakSet();
    worker.pendingCancels = new Set([channel]);
    worker.waitingForChild = [];
    worker.pendingSleeps = new Map();
    worker.pendingFutexWaits = new Map([[channel, {
      futexIndex: 1024,
      retire,
    }]]);
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.socketTimeoutTimers = new Map();
    worker.channelTids = new Map([["7:256", 99]]);
    worker.threadForkContexts = new Map([["7:256", { fnPtr: 1, argPtr: 2 }]]);

    worker.removeChannel(7, 256);

    expect(retire).toHaveBeenCalledOnce();
    expect(worker.pendingFutexWaits.size).toBe(0);
    expect(worker.pendingCancels.size).toBe(0);
    expect(worker.processes.get(7).channels).toEqual([]);
    expect(worker.activeChannels).toEqual([]);
    expect(worker.channelTids.has("7:256")).toBe(false);
    expect(worker.threadForkContexts.has("7:256")).toBe(false);
  });

  it("parks exact mailbox notifications while materializing completed output", async () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(42, processMemory, 0);
    const second = createChannel(42, processMemory, 256);
    markPending(first);
    markPending(second);
    const handleChannel = vi.fn((channelPtr: number | bigint) => {
      const view = new DataView(kernelMemory.buffer, Number(channelPtr));
      const syscallNr = view.getUint32(CH_SYSCALL, true);
      const retVal = syscallNr === ABI_SYSCALLS.Read ? 3 : 8;
      if (syscallNr === ABI_SYSCALLS.Read) {
        new Uint8Array(
          kernelMemory.buffer,
          Number(channelPtr) + CH_DATA,
          3,
        ).set([1, 2, 3]);
      }
      view.setBigInt64(CH_RETURN, BigInt(retVal), true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_handle_channel: handleChannel,
    }, 4, kernelMemory);
    worker.processes = new Map([[42, {
      channels: [first, second],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map([["42:256", 43]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    const synchronizeSharedMemoryForBoundary = vi.fn();
    const relistenChannel = vi.fn();
    configureBoundaryHooks(worker, {
      synchronizeSharedMemoryForBoundary,
      relistenChannel,
    });

    dispatchLifecycleSyscall(
      worker,
      first,
      ABI_SYSCALLS.Read,
      [3, 2048, 3],
    );
    dispatchLifecycleSyscall(
      worker,
      second,
      ABI_SYSCALLS.SchedYield,
      [],
    );

    expect(worker.parkedChannelCompletions.size).toBe(2);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_PENDING);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_PENDING);
    // A peer mapping the same SharedArrayBuffer observes completed syscall
    // output even though this stopped process remains parked at CH_PENDING.
    expect(new Uint8Array(processMemory.buffer, 2048, 3))
      .toEqual(Uint8Array.of(1, 2, 3));
    expect(synchronizeSharedMemoryForBoundary).toHaveBeenCalledTimes(4);

    expect(worker.testAuthority.resumeStoppedProcessForTest(42)).toBe(true);
    await drainLifecycleGate();

    expect(worker.parkedChannelCompletions.size).toBe(0);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(new DataView(
      processMemory.buffer,
      first.channelOffset,
    ).getBigInt64(CH_RETURN, true)).toBe(3n);
    expect(new DataView(
      processMemory.buffer,
      second.channelOffset,
    ).getBigInt64(CH_RETURN, true)).toBe(8n);
    expect(new Uint8Array(processMemory.buffer, 2048, 3))
      .toEqual(Uint8Array.of(1, 2, 3));
    expect(relistenChannel).toHaveBeenCalledWith(first);
    expect(relistenChannel).toHaveBeenCalledWith(second);
  });

  it("delivers a caught SIGCONT before publishing the parked stop boundary", async () => {
    const kernelMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const processMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const channel = createChannel(42, processMemory);
    const dequeue = vi.fn((_pid: number, _tid: number, outPtr: number) => {
      new DataView(kernelMemory.buffer).setUint32(outPtr, SIGCONT, true);
      return SIGCONT;
    });
    const worker = createWorkerHarness({
      kernel_dequeue_signal: dequeue,
      kernel_get_process_exit_signal: vi.fn(() => -1),
    }, 4, kernelMemory);
    worker.processes = new Map([[42, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map();
    worker.hostReaped = new Set();
    worker.stoppedPids = new Set();
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    markPending(channel);
    worker.testAuthority.installParkedCloneCompletionForTest({
      channel,
      tid: 101,
      parentTidPointer: 2048,
    });

    expect(worker.testAuthority.resumeStoppedProcessForTest(42)).toBe(true);
    await drainLifecycleGate();

    expect(dequeue).toHaveBeenCalledOnce();
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGCONT);
    expect(readCompletion(channel)).toEqual({
      retVal: 101,
      errVal: 0,
      status: CHANNEL_STATUS_COMPLETE,
    });
  });

  it("preflights every pthread before starting or publishing after SIGCONT", async () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const first = createChannel(42, processMemory, 0);
    const second = createChannel(42, processMemory, 256);
    markPending(first);
    markPending(second);

    let state = PROCESS_STATE_STOPPED;
    let secondScans = 0;
    const dequeue = vi.fn((_pid: number, tid: number, outPtr: number) => {
      if (tid === 101) {
        new DataView(kernelMemory.buffer).setUint32(outPtr, SIGCONT, true);
        return SIGCONT;
      }
      secondScans++;
      if (secondScans === 1) state = PROCESS_STATE_STOPPED;
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_get_process_state: vi.fn(() => state),
      kernel_set_current_tid: vi.fn(() => 0),
      kernel_dequeue_signal: dequeue,
      kernel_get_process_exit_signal: vi.fn(() => -1),
    }, 4, kernelMemory);
    worker.processes = new Map([[42, {
      channels: [first, second],
      memory: processMemory,
    }]]);
    worker.channelTids = new Map([
      ["42:0", 101],
      ["42:256", 102],
    ]);
    worker.stoppedPids = new Set();
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.pendingSleeps = new Map();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    const start = vi.fn();
    const cancel = vi.fn();
    worker.testAuthority.installParkedCloneCompletionForTest({
      channel: first,
      tid: 101,
      parentTidPointer: 2048,
    });
    worker.testAuthority.installParkedCloneCompletionForTest({
      channel: second,
      tid: 102,
      parentTidPointer: 2052,
    });

    expect(worker.startProcessWorkerWhenRunnable(
      42,
      processMemory,
      start,
      cancel,
    )).toBe("deferred");

    state = PROCESS_STATE_RUNNING;
    expect(worker.testAuthority.resumeStoppedProcessForTest(42)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(worker.parkedChannelCompletions.size).toBe(2);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_PENDING);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_PENDING);
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGCONT);

    state = PROCESS_STATE_RUNNING;
    expect(worker.testAuthority.resumeStoppedProcessForTest(42)).toBe(true);
    await drainLifecycleGate();
    expect(start).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(readStatus(first)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(dequeue).toHaveBeenCalledTimes(3);
    // The first channel's caught signal was not dequeued/cleared again on the
    // second resume attempt.
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGCONT);
  });

  it("interrupts a stopped exact wait thread with its retained caught signal", async () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(7, processMemory);
    markPending(channel);
    let state = PROCESS_STATE_STOPPED;
    const dequeue = vi.fn((_pid: number, _tid: number, outPtr: number) => {
      new DataView(kernelMemory.buffer).setUint32(outPtr, SIGUSR1, true);
      return SIGUSR1;
    });
    const worker = createWorkerHarness({
      kernel_get_process_state: vi.fn(() => state),
      kernel_dequeue_signal: dequeue,
      kernel_get_process_exit_signal: vi.fn(() => -1),
    }, 4, kernelMemory);
    worker.processes = new Map([[7, {
      channels: [channel],
      memory: processMemory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel,
      origArgs: [-1, 0, 0, 0],
      pid: -1,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    worker.stoppedPids = new Set([7]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.deferredProcessWorkerStarts = new Map();
    worker.pendingSleeps = new Map();
    worker.pendingFutexWaits = new Map();
    worker.pendingPollRetries = new Map();
    worker.pendingSelectRetries = new Map();
    worker.pendingPipeReaders = new Map();
    worker.pendingPipeWriters = new Map();
    worker.socketTimeoutTimers = new Map();
    const sequence: string[] = [];
    const synchronizeSharedMemoryForBoundary = vi.fn(() => {
      sequence.push("sync");
    });
    configureBoundaryHooks(worker, { synchronizeSharedMemoryForBoundary });
    const start = vi.fn(() => sequence.push("start"));
    const cancel = vi.fn();

    expect(worker.startProcessWorkerWhenRunnable(
      7,
      processMemory,
      start,
      cancel,
    )).toBe("deferred");
    state = PROCESS_STATE_RUNNING;
    expect(worker.testAuthority.resumeStoppedProcessForTest(7)).toBe(true);
    await drainLifecycleGate();

    expect(worker.waitingForChild).toEqual([]);
    expect(dequeue).toHaveBeenCalledOnce();
    expect(sequence).toEqual(["sync", "start"]);
    expect(readCompletion(channel)).toEqual({
      retVal: -1,
      errVal: 4,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(new DataView(processMemory.buffer).getUint32(CH_SIG_SIGNUM, true))
      .toBe(SIGUSR1);
  });

  it("materializes detached descriptor output before wake scratch is reused", async () => {
    const kernelMemory = createSharedMemory();
    const processMemory = createSharedMemory();
    const channel = createChannel(42, processMemory);
    const outputPtr = 2048;
    markPending(channel);
    // WHY: completeChannel consumes bytes detached while the scratch lease is
    // still active. It must never reconstruct output later from shared scratch,
    // which a lifecycle wake may synchronously reuse.
    const sequence: string[] = [];
    const handleChannel = vi.fn((channelPtr: number | bigint) => {
      const pointer = Number(channelPtr);
      const view = new DataView(kernelMemory.buffer, pointer);
      new Uint8Array(kernelMemory.buffer, pointer + CH_DATA, 4)
        .set([9, 8, 7, 6]);
      view.setBigInt64(CH_RETURN, 4n, true);
      view.setUint32(CH_ERRNO, 0, true);
      return 0;
    });
    const drainWakeups = vi.fn((outPtr: number) => {
      sequence.push("drain");
      expect(new Uint8Array(processMemory.buffer, outputPtr, 4))
        .toEqual(Uint8Array.of(9, 8, 7, 6));
      new Uint8Array(kernelMemory.buffer, outPtr, 4).fill(0xee);
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_handle_channel: handleChannel,
      kernel_drain_wakeup_events: drainWakeups,
    }, 4, kernelMemory);
    worker.processes = new Map([[42, { channels: [channel], memory: processMemory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    const synchronizeSharedMemoryForBoundary = vi.fn(() => {
      sequence.push("sync");
    });
    configureBoundaryHooks(worker, {
      synchronizeSharedMemoryForBoundary,
    });

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.Read,
      [0, outputPtr, 4],
    );

    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
    expect(new Uint8Array(processMemory.buffer, outputPtr, 4))
      .toEqual(Uint8Array.of(9, 8, 7, 6));
    expect(synchronizeSharedMemoryForBoundary).toHaveBeenCalledTimes(2);
    expect(sequence).toEqual(["sync", "sync", "drain"]);
    expect(worker.testAuthority.resumeStoppedProcessForTest(42)).toBe(true);
    await drainLifecycleGate();
    expect(new Uint8Array(processMemory.buffer, outputPtr, 4))
      .toEqual(Uint8Array.of(9, 8, 7, 6));
  });

  it("synchronizes raw completion before lifecycle wake observers", () => {
    const kernelMemory = createSharedMemory();
    const memory = createSharedMemory();
    const channel = createChannel(42, memory);
    markPending(channel);
    const sequence: string[] = [];
    const worker = createWorkerHarness({
      kernel_handle_channel: successfulKernelHandle(kernelMemory),
      kernel_drain_wakeup_events: vi.fn(() => {
        sequence.push("drain");
        return 0;
      }),
    }, 4, kernelMemory);
    worker.processes = new Map([[42, { channels: [channel], memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map();
    worker.deferredStoppedChannels = new Map();
    worker.pendingCancels = new Set();
    const synchronizeSharedMemoryForBoundary = vi.fn(() => {
      sequence.push("sync");
    });
    configureBoundaryHooks(worker, {
      synchronizeSharedMemoryForBoundary,
    });

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.ThreadCancel,
      [99],
    );

    expect(sequence).toEqual(["sync", "sync", "drain"]);
    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
    expect(worker.parkedChannelCompletions.has(channel)).toBe(true);
  });

  it("defers an exact stopped channel and re-arms it on continuation", async () => {
    const channel = createChannel(42, createSharedMemory());
    const worker = createWorkerHarness({});
    worker.processes = new Map([[42, { channels: [channel], memory: channel.memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.deferredStoppedChannels = new Map();
    worker.parkedChannelCompletions = new Map();
    const relistenChannel = observeRelisten(worker);
    markPending(channel);
    new DataView(channel.memory.buffer).setUint32(
      CH_SYSCALL,
      ABI_SYSCALLS.SchedYield,
      true,
    );

    worker.handleSyscall(channel);

    expect(worker.deferredStoppedChannels.has(channel)).toBe(true);
    expect(worker.testAuthority.resumeStoppedProcessForTest(42)).toBe(true);
    await drainLifecycleGate();
    expect(relistenChannel).toHaveBeenCalledWith(channel);
  });

  it("discards every parked and deferred channel without publication on signal death", () => {
    const memory = createSharedMemory();
    const first = createChannel(42, memory, 0);
    const second = createChannel(42, memory, 256);
    markPending(first);
    markPending(second);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_get_process_exit_signal: vi.fn(() => 9),
    });
    worker.processes = new Map([[42, { channels: [first, second], memory }]]);
    worker.stoppedPids = new Set([42]);
    worker.parkedChannelCompletions = new Map([
      [first, {
        prepared: {
          kind: "raw",
          outputWrites: [],
          retVal: 1,
          errVal: 0,
          relistenRequested: false,
        },
        relistenRequested: false,
      }],
    ]);
    worker.deferredStoppedChannels = new Map([[second, true]]);
    worker.hostReaped = new Set();
    worker.callbacks = { onExit };

    worker.handleProcessTerminated(first);

    expect(worker.stoppedPids.has(42)).toBe(false);
    expect(worker.parkedChannelCompletions.size).toBe(0);
    expect(worker.deferredStoppedChannels.size).toBe(0);
    expect(readStatus(first)).toBe(CHANNEL_STATUS_PENDING);
    expect(readStatus(second)).toBe(CHANNEL_STATUS_PENDING);
    expect(onExit).toHaveBeenCalledWith(42, 137);
  });

  it("settles only the exit handshake after Rust has reaped a process", () => {
    const memory = createSharedMemory();
    const channel = createChannel(42, memory);
    const setCurrentTid = vi.fn(() => -3);
    const handleChannel = vi.fn();
    const worker = createWorkerHarness({
      kernel_set_current_tid: setCurrentTid,
      kernel_handle_channel: handleChannel,
    });
    worker.processes = new Map([[42, { channels: [channel], memory }]]);
    worker.hostReaped = new Set([42]);
    const relistenChannel = observeRelisten(worker);
    const processView = new DataView(memory.buffer, channel.channelOffset);

    markPending(channel);
    processView.setUint32(CH_SYSCALL, ABI_SYSCALLS.ExitGroup, true);
    worker.handleSyscall(channel);

    expect(readCompletion(channel)).toEqual({
      retVal: 0,
      errVal: 0,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(relistenChannel).toHaveBeenCalledOnce();
    expect(relistenChannel).toHaveBeenCalledWith(channel);

    markPending(channel);
    processView.setUint32(CH_SYSCALL, ABI_SYSCALLS.Exit, true);
    worker.handleSyscall(channel);

    expect(readCompletion(channel)).toEqual({
      retVal: 0,
      errVal: 0,
      status: CHANNEL_STATUS_COMPLETE,
    });
    expect(relistenChannel).toHaveBeenCalledOnce();
    expect(setCurrentTid).not.toHaveBeenCalled();
    expect(handleChannel).not.toHaveBeenCalled();
  });

  it("parks non-exit syscalls from a process Rust has already reaped", () => {
    const memory = createSharedMemory();
    const channel = createChannel(42, memory);
    markPending(channel);
    const setCurrentTid = vi.fn(() => -3);
    const handleChannel = vi.fn();
    const worker = createWorkerHarness({
      kernel_set_current_tid: setCurrentTid,
      kernel_handle_channel: handleChannel,
    });
    worker.processes = new Map([[42, { channels: [channel], memory }]]);
    worker.hostReaped = new Set([42]);
    const relistenChannel = observeRelisten(worker);
    new DataView(memory.buffer, channel.channelOffset).setUint32(
      CH_SYSCALL,
      ABI_SYSCALLS.SchedYield,
      true,
    );

    worker.handleSyscall(channel);

    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
    expect(channel.handling).toBe(true);
    expect(relistenChannel).not.toHaveBeenCalled();
    expect(setCurrentTid).not.toHaveBeenCalled();
    expect(handleChannel).not.toHaveBeenCalled();
  });

  it("terminates a live process whose channel cannot bind to a kernel task", () => {
    const pid = 42;
    const tid = 101;
    const memory = createSharedMemory();
    const channel = createChannel(pid, memory);
    const setCurrentTid = vi.fn(() => -3);
    const markSignaled = vi.fn(() => 0);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markSignaled,
      kernel_set_current_tid: setCurrentTid,
    });
    worker.processes = new Map([[pid, { channels: [channel], memory }]]);
    worker.channelTids = new Map([
      [`${pid}:${channel.channelOffset}`, tid],
    ]);
    worker.hostReaped = new Set();
    worker.callbacks = { onExit };
    markPending(channel);
    new DataView(memory.buffer, channel.channelOffset).setUint32(
      CH_SYSCALL,
      ABI_SYSCALLS.SchedYield,
      true,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      worker.handleSyscall(channel);

      expect(setCurrentTid).toHaveBeenCalledWith(pid, tid);
      expect(markSignaled).toHaveBeenCalledWith(pid, 11);
      expect(onExit).toHaveBeenCalledWith(pid, 139);
      expect(channel.handling).toBe(true);
      expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
      expect(error).toHaveBeenCalledWith(
        "[handleSyscall] FATAL task binding error: " +
          `Kernel rejected tid ${tid} for process ${pid}: errno 3`,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("terminates instead of substituting the leader for a pthread with no TID mapping", () => {
    const pid = 42;
    const memory = createSharedMemory();
    const mainChannel = createChannel(pid, memory);
    const threadChannel = createChannel(pid, memory, 256);
    const markSignaled = vi.fn(() => 0);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markSignaled,
    });
    worker.processes = new Map([[pid, {
      channels: [mainChannel, threadChannel],
      memory,
    }]]);
    worker.channelTids = new Map();
    worker.hostReaped = new Set();
    worker.callbacks = { onExit };
    markPending(threadChannel);
    new DataView(memory.buffer, threadChannel.channelOffset).setUint32(
      CH_SYSCALL,
      ABI_SYSCALLS.SchedYield,
      true,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const expected =
      `No kernel-validated TID for non-main channel ${threadChannel.channelOffset} ` +
      `of process ${pid}`;

    try {
      worker.handleSyscall(threadChannel);

      expect(markSignaled).toHaveBeenCalledWith(pid, 11);
      expect(onExit).toHaveBeenCalledWith(pid, 139);
      expect(threadChannel.handling).toBe(true);
      expect(readStatus(threadChannel)).toBe(CHANNEL_STATUS_PENDING);
      expect(error).toHaveBeenCalledWith(
        `[handleSyscall] FATAL task binding error: ${expected}`,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("still requests Worker teardown when recording a binding crash fails", async () => {
    const pid = 42;
    const tid = 101;
    const memory = createSharedMemory();
    const channel = createChannel(pid, memory);
    const transitionError = new Error("kernel crash transition failed");
    const onExit = vi.fn();
    const onKernelFatal = vi.fn();
    const markSignaled = vi.fn(() => {
      throw transitionError;
    });
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markSignaled,
      kernel_set_current_tid: vi.fn(() => -3),
    });
    worker.processes = new Map([[pid, { channels: [channel], memory }]]);
    worker.channelTids = new Map([
      [`${pid}:${channel.channelOffset}`, tid],
    ]);
    worker.hostReaped = new Set();
    worker.callbacks = { onExit, onKernelFatal };
    markPending(channel);
    new DataView(memory.buffer, channel.channelOffset).setUint32(
      CH_SYSCALL,
      ABI_SYSCALLS.SchedYield,
      true,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => worker.handleSyscall(channel))
        .toThrow(/kernel_mark_process_signaled failed/);
      await Promise.resolve();

      expect(markSignaled).toHaveBeenCalledWith(pid, 11);
      expect(onExit).not.toHaveBeenCalled();
      expect(onKernelFatal).toHaveBeenCalledOnce();
      expect(channel.handling).toBe(true);
      expect(error).toHaveBeenCalledWith(
        "[handleSyscall] FATAL task binding error: " +
          `Kernel rejected tid ${tid} for process ${pid}: errno 3`,
      );
    } finally {
      error.mockRestore();
    }
  });

  it("retires stale pthread transport metadata when deactivating a zombie", () => {
    const pid = 42;
    const otherPid = 420;
    const memory = createSharedMemory();
    const otherMemory = createSharedMemory();
    const channel = createChannel(pid, memory);
    const otherChannel = createChannel(otherPid, otherMemory);
    const worker = createWorkerHarness({});
    worker.waitingForChild = [];
    worker.activeChannels = [channel, otherChannel];
    worker.channelTids = new Map([
      [`${pid}:0`, 1001],
      [`${otherPid}:0`, 2001],
    ]);
    worker.threadForkContexts = new Map([
      [`${pid}:0`, { fnPtr: 1, argPtr: 2 }],
      [`${otherPid}:0`, { fnPtr: 3, argPtr: 4 }],
    ]);
    worker.processes = new Map([
      [pid, { channels: [channel], memory }],
      [otherPid, { channels: [otherChannel], memory: otherMemory }],
    ]);
    worker.execHandoffPids = new Set([pid]);
    worker.stdinFinite = new Set([pid]);
    worker.stdinBuffers = new Map([[pid, new Uint8Array()]]);
    worker.hostReaped = new Set([pid]);

    worker.deactivateProcess(pid);

    expect(Array.from(worker.channelTids.entries())).toEqual([
      [`${otherPid}:0`, 2001],
    ]);
    expect(Array.from(worker.threadForkContexts.entries())).toEqual([
      [`${otherPid}:0`, { fnPtr: 3, argPtr: 4 }],
    ]);
    expect(worker.processes.has(pid)).toBe(false);
    expect(worker.activeChannels).toEqual([otherChannel]);
  });

  it("host-observed crashes are marked in Rust before parent notification", () => {
    const calls: string[] = [];
    const markProcessSignaled = vi.fn(() => {
      calls.push("mark");
      return 0;
    });
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markProcessSignaled,
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 0),
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map([[42, new Map()]]);
    const sendSignalToProcess = vi.fn(() => calls.push("signal"));
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.notifyHostProcessCrashed(42, 11);

    expect(markProcessSignaled).toHaveBeenCalledWith(42, 11);
    expect(sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD, true);
    expect(calls).toEqual(["mark", "signal"]);
    expect(worker.sharedMappings.has(42)).toBe(false);
  });

  it("does not publish a host crash when the kernel transition export is missing", () => {
    const worker = createWorkerHarness(
      {},
      4,
      createSharedMemory(),
      ["kernel_mark_process_signaled"],
    );
    worker.hostReaped = new Set();
    worker.stoppedPids = new Set([42]);
    worker.sharedMappings = new Map([[42, new Map()]]);

    let thrown: unknown;
    try {
      worker.notifyHostProcessCrashed(42, 11);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error & { cause?: unknown }).cause).toEqual(
      expect.objectContaining({
        message:
          "Kernel missing required kernel_mark_process_signaled export",
      }),
    );

    expect(worker.hostReaped.has(42)).toBe(false);
    expect(worker.stoppedPids.has(42)).toBe(true);
    expect(worker.sharedMappings.has(42)).toBe(true);
  });

  it("does not publish a host crash rejected by the kernel", () => {
    const markProcessSignaled = vi.fn(() => -3);
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: markProcessSignaled,
    });
    worker.hostReaped = new Set();
    worker.stoppedPids = new Set([42]);
    worker.sharedMappings = new Map([[42, new Map()]]);

    let thrown: unknown;
    try {
      worker.notifyHostProcessCrashed(42, 11);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error & { cause?: unknown }).cause).toEqual(
      expect.objectContaining({
        message:
          "Kernel rejected signal-death transition for process 42: errno 3",
      }),
    );

    expect(markProcessSignaled).toHaveBeenCalledWith(42, 11);
    expect(worker.hostReaped.has(42)).toBe(false);
    expect(worker.stoppedPids.has(42)).toBe(true);
    expect(worker.sharedMappings.has(42)).toBe(true);
  });

  it("marks a host crash reaped and releases shared state before parent notification", () => {
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: vi.fn(() => 0),
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 0),
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map([[42, new Map()]]);
    const sendSignalToProcess = vi.fn(() => {
      expect(worker.hostReaped.has(42)).toBe(true);
      expect(worker.sharedMappings.has(42)).toBe(false);
    });
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.notifyHostProcessCrashed(42, 11);

    expect(sendSignalToProcess).toHaveBeenCalledWith(7, SIGCHLD, true);
  });

  it("does not commit clean exit when the post-release check reports signal death", () => {
    const commitProcessExit = vi.fn();
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_commit_process_exit: commitProcessExit,
      kernel_get_process_exit_signal: vi.fn(() => SIGTERM),
    });
    const memory = createSharedMemory();
    const channel = createChannel(42, memory);
    worker.processes = new Map([[42, { channels: [channel], memory }]]);
    worker.hostReaped = new Set();
    worker.callbacks = { onExit };
    markPending(channel);

    dispatchLifecycleSyscall(
      worker,
      channel,
      ABI_SYSCALLS.ExitGroup,
      [0],
    );

    expect(worker.hostReaped.has(42)).toBe(true);
    expect(onExit).toHaveBeenCalledWith(42, 128 + SIGTERM);
    expect(commitProcessExit).not.toHaveBeenCalled();
    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
  });

  it("fails closed when Rust returns a different committed exit status", () => {
    const pid = 42;
    const memory = createSharedMemory();
    const channel = createChannel(pid, memory);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_commit_process_exit: vi.fn(() => 6),
      kernel_get_process_state: vi.fn(() => PROCESS_STATE_EXITED),
    });
    worker.processes = new Map([[pid, { channels: [channel], memory }]]);
    worker.hostReaped = new Set();
    worker.callbacks = { onExit };
    markPending(channel);
    let thrown: unknown;
    try {
      dispatchLifecycleSyscall(
        worker,
        channel,
        ABI_SYSCALLS.ExitGroup,
        [7],
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { cause?: unknown }).cause).toEqual(
      expect.objectContaining({
        message:
          `kernel committed exit status 6 for process ${pid}; expected 7`,
      }),
    );

    expect(worker.hostReaped.has(pid)).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
    expect(readStatus(channel)).toBe(CHANNEL_STATUS_PENDING);
  });

  it("uses the explicit termination signal instead of classifying high exit codes", () => {
    const kernelMemory = createSharedMemory();
    const exitSignals = new Map([[42, 0], [43, 15]]);
    const handleChannel = successfulKernelHandle(kernelMemory);
    const pickSignalTarget = vi.fn(() => 0);
    const onExit = vi.fn();
    const worker = createWorkerHarness({
      kernel_handle_channel: handleChannel,
      kernel_get_process_exit_signal: vi.fn((pid: number) => exitSignals.get(pid) ?? -1),
      kernel_pick_signal_target_tid: pickSignalTarget,
    }, 4, kernelMemory);
    const normalMemory = createSharedMemory();
    const signaledMemory = createSharedMemory();
    const normalChannel = createChannel(42, normalMemory);
    const signaledChannel = createChannel(43, signaledMemory);
    worker.processes = new Map([
      [42, { channels: [normalChannel], memory: normalMemory }],
      [43, { channels: [signaledChannel], memory: signaledMemory }],
    ]);
    worker.pendingSleeps = new Map();
    worker.hostReaped = new Set();
    worker.callbacks = { onExit };
    markPending(normalChannel);

    dispatchLifecycleSyscall(
      worker,
      normalChannel,
      ABI_SYSCALLS.Kill,
      [43, SIGTERM],
    );

    expect(worker.hostReaped.has(42)).toBe(false);
    expect(worker.hostReaped.has(43)).toBe(true);
    expect(pickSignalTarget).toHaveBeenCalledWith(43, SIGTERM);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(43, 128 + SIGTERM);
  });

  it("SA_NOCLDWAIT auto-reaps through Rust without SIGCHLD", () => {
    const reapExitedChild = vi.fn(() => 0);
    const worker = createWorkerHarness({
      kernel_mark_process_signaled: vi.fn(() => 0),
      kernel_get_parent_pid: vi.fn(() => 7),
      kernel_has_sa_nocldwait: vi.fn(() => 1),
      kernel_reap_exited_child: reapExitedChild,
      kernel_wait_child_poll: vi.fn(() => -10),
    });
    worker.hostReaped = new Set();
    worker.sharedMappings = new Map();
    const parentMemory = createSharedMemory();
    const parentChannel = createChannel(7, parentMemory);
    worker.processes = new Map([[7, {
      channels: [parentChannel],
      memory: parentMemory,
    }]]);
    worker.waitingForChild = [{
      parentPid: 7,
      channel: parentChannel,
      origArgs: [42, 0, 0, 0],
      pid: 42,
      options: 0,
      syscallNr: ABI_SYSCALLS.Wait4,
    }];
    const sendSignalToProcess = vi.fn();
    const completeChannel = observeMarshalledCompletions(worker);
    configureBoundaryHooks(worker, { sendSignalToProcess });

    worker.notifyHostProcessCrashed(42, 11);

    expect(reapExitedChild).toHaveBeenCalledWith(7, 42);
    expect(sendSignalToProcess).not.toHaveBeenCalled();
    expect(worker.waitingForChild).toEqual([]);
    expect(completeChannel).toHaveBeenCalledWith(
      parentChannel,
      ABI_SYSCALLS.Wait4,
      [42, 0, 0, 0],
      undefined,
      -1,
      10,
    );
  });

  it("thread exit uses Rust-owned ctid metadata for clear-tid wakeup", () => {
    const memory = createSharedMemory();
    const ctidPtr = 2048;
    new DataView(memory.buffer).setInt32(ctidPtr, 123, true);

    const mainChannel = createChannel(10, memory, 0);
    const threadChannel = createChannel(10, memory, 1024);
    const kernelThreadExit = vi.fn(() => BigInt(ctidPtr));
    const worker = createWorkerHarness({
      kernel_thread_exit: kernelThreadExit,
    });
    worker.processes = new Map([
      [10, {
        pid: 10,
        memory,
        channels: [mainChannel, threadChannel],
        ptrWidth: 4,
      }],
    ]);
    worker.activeChannels = [mainChannel, threadChannel];
    worker.channelTids = new Map([["10:1024", 77]]);
    worker.threadForkContexts = new Map([["10:1024", { fnPtr: 1, argPtr: 2 }]]);
    worker.finalizeThreadExit(10, 77, threadChannel.channelOffset);

    expect(kernelThreadExit).toHaveBeenCalledWith(10, 77);
    expect(new DataView(memory.buffer).getInt32(ctidPtr, true)).toBe(0);
    expect(worker.processes.get(10).channels).toEqual([mainChannel]);
    expect(worker.activeChannels).toEqual([mainChannel]);
    expect(worker.channelTids.has("10:1024")).toBe(false);
    expect(worker.threadForkContexts.has("10:1024")).toBe(false);
  });
});

function createWorkerHarness(
  exports: Record<string, unknown> = {},
  kernelPtrWidth: 4 | 8 = 4,
  kernelMemory = createSharedMemory(),
  excludedExports: readonly string[] = [],
): any {
  const gate = new KernelEntryGate();
  const implementations = {
    kernel_dequeue_signal: vi.fn(() => 0),
    kernel_drain_wakeup_events: vi.fn(() => 0),
    kernel_get_parent_pid: vi.fn(() => 0),
    kernel_get_process_exit_signal: vi.fn(() => -1),
    kernel_get_process_state: vi.fn(() => PROCESS_STATE_RUNNING),
    kernel_mark_process_signaled: vi.fn(() => 0),
    kernel_set_current_tid: vi.fn(() => 0),
    ...exports,
  };
  const rawInstance = createKernelScratchTestInstance(
    kernelPtrWidth,
    kernelMemory,
    () => implementations,
    () => kernelPtrWidth === 8 ? 128n : 128,
    4,
    undefined,
    excludedExports,
  );
  const kernelInstance = createKernelEntryGatedInstance(rawInstance, gate);
  const worker = Object.assign(createCentralizedKernelWorkerTestDouble(), {
    processes: new Map(),
    channelTids: new Map(),
    pendingCancels: new Set(),
    deferredProcessWorkerStarts: new Map(),
  });
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    kernelPtrWidth,
    {
      boundInstance: kernelInstance,
      gate,
    },
  );
  return worker;
}

function createSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
}

function createChannel(pid: number, memory: WebAssembly.Memory, channelOffset = 0): any {
  return {
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer, channelOffset),
    consecutiveSyscalls: 0,
  };
}

function registerMainChannel(worker: any, channel: any): any {
  worker.processes.set(channel.pid, {
    pid: channel.pid,
    memory: channel.memory,
    channels: [channel],
  });
  return channel;
}

function configureBoundaryHooks(
  worker: any,
  hooks: Record<string, unknown>,
): void {
  worker.testAuthority.configureScratchBoundaryHooksForTest(hooks);
}

function observeMarshalledCompletions(worker: any): ReturnType<typeof vi.fn> {
  const completion = vi.fn();
  configureBoundaryHooks(worker, {
    completeChannel: (
      channel: unknown,
      syscallNr: number,
      origArgs: number[],
      argDescs: unknown,
      retVal: number,
      errVal: number,
    ) => {
      completion(
        channel,
        syscallNr,
        origArgs,
        argDescs,
        retVal,
        errVal,
      );
    },
  });
  return completion;
}

function observeRelisten(worker: any): ReturnType<typeof vi.fn> {
  const relisten = vi.fn();
  configureBoundaryHooks(worker, { relistenChannel: relisten });
  return relisten;
}

function dispatchLifecycleSyscall(
  worker: any,
  channel: any,
  syscallNr: number,
  args: readonly (number | bigint)[],
  cancellationPoint = false,
  cancellationWakeAllowed = cancellationPoint,
): void {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  view.setUint32(CH_SYSCALL, syscallNr, true);
  view.setUint32(
    CH_REQUEST_FLAGS,
    (cancellationPoint
      ? CHANNEL_REQUEST_FLAG_CANCELLATION_POINT
      : 0)
      | (cancellationWakeAllowed
        ? CHANNEL_REQUEST_FLAG_CANCELLATION_WAKE_ALLOWED
        : 0),
    true,
  );
  for (let index = 0; index < 6; index++) {
    view.setBigInt64(
      CH_ARGS + index * CH_ARG_SIZE,
      BigInt(args[index] ?? 0),
      true,
    );
  }
  worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
}

function syscallArgs(...args: number[]): number[] {
  return Array.from({ length: 6 }, (_, index) => args[index] ?? 0);
}

function readCompletion(channel: any): {
  retVal: number;
  errVal: number;
  status: number;
} {
  const view = new DataView(
    channel.memory.buffer,
    channel.channelOffset,
  );
  return {
    retVal: Number(view.getBigInt64(CH_RETURN, true)),
    errVal: view.getUint32(CH_ERRNO, true),
    status: view.getUint32(CH_STATUS, true),
  };
}

async function drainLifecycleGate(): Promise<void> {
  // Resume publication is a protocol transaction that starts only after the
  // exact kernel-entry scope is revoked.
  for (let turn = 0; turn < 24; turn++) {
    await Promise.resolve();
  }
}

function successfulKernelHandle(
  memory: WebAssembly.Memory,
  observeRequest?: (view: DataView) => void,
): ReturnType<typeof vi.fn> {
  return vi.fn((channelPtr: number | bigint) => {
    const view = new DataView(memory.buffer, Number(channelPtr));
    observeRequest?.(view);
    view.setBigInt64(CH_RETURN, 0n, true);
    view.setUint32(CH_ERRNO, 0, true);
    return 0;
  });
}

function writeKernelWaitResult(
  memory: WebAssembly.Memory,
  ptr: number,
  result: {
    waitStatus: number;
    siCode: number;
    siStatus: number;
    childUid: number;
    rusage: Uint8Array;
  },
): void {
  const view = new DataView(memory.buffer);
  view.setInt32(ptr + KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET, result.waitStatus, true);
  view.setInt32(ptr + KERNEL_WAIT_RESULT_SI_CODE_OFFSET, result.siCode, true);
  view.setInt32(ptr + KERNEL_WAIT_RESULT_SI_STATUS_OFFSET, result.siStatus, true);
  view.setUint32(ptr + KERNEL_WAIT_RESULT_CHILD_UID_OFFSET, result.childUid, true);
  new Uint8Array(memory.buffer, ptr + KERNEL_WAIT_RESULT_RUSAGE_OFFSET, result.rusage.length)
    .set(result.rusage);
}

function writeWakeEvent(
  memory: WebAssembly.Memory,
  ptr: number,
  index: number,
  wakeIdx: number,
  wakeType: number,
): void {
  const offset = ptr + index * 5;
  const view = new DataView(memory.buffer);
  view.setUint32(offset, wakeIdx, true);
  view.setUint8(offset + 4, wakeType);
}

function markPending(channel: any): void {
  Atomics.store(
    new Int32Array(channel.memory.buffer, channel.channelOffset),
    CH_STATUS / 4,
    CHANNEL_STATUS_PENDING,
  );
}

function readStatus(channel: any): number {
  return Atomics.load(
    new Int32Array(channel.memory.buffer, channel.channelOffset),
    CH_STATUS / 4,
  );
}
