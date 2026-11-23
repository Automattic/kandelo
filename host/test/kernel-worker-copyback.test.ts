import { describe, expect, it, vi } from "vitest";
import * as G from "../src/generated/program-extensions";
import { groupMemoryObservationFixture } from './support/group-memory-layout';
import { processDataView, type ProcessMemorySource } from "../src/process-memory-views";
import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import { KernelReentrantEntryError } from "../src/kernel-entry-gate";
import { retryKernelEntryResult } from '../src/kernel-entry-retry';
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  SYSCALL_ARGS,
  PROCESS_STATE_RUNNING,
  PROCESS_STATE_STOPPED,
} from "../src/generated/abi";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";

interface TestChannel {
  pid: number;
  memory: WebAssembly.Memory;
  source: ProcessMemorySource;
  channelOffset: number;
  i32View: Int32Array;
  consecutiveSyscalls: number;
  handling: boolean;
}

type CopybackHarnessWorker =
  ReturnType<typeof createCentralizedKernelWorkerTestDouble>;

interface MutableCopybackWorkerState {
  processes: Map<number, {
    pid: number;
    memory: WebAssembly.Memory;
    source: ProcessMemorySource;
    channels: TestChannel[];
    ptrWidth: 4 | 8;
    explicitMaxAddr: boolean;
  }>;
  activeChannels: TestChannel[];
  usePolling: boolean;
}

function createTestChannel(
  pid: number,
  memory: WebAssembly.Memory,
  source: ProcessMemorySource = memory,
  channelOffset = 0,
): TestChannel {
  return {
    source,
    pid,
    memory,
    channelOffset,
    i32View: new Int32Array(memory.buffer),
    consecutiveSyscalls: 0,
    handling: true,
  };
}

function makeCopybackHarness(ptrWidth: 4 | 8 = 4, grouped = false, channelOffset = 0,
  lifecycle?: { exitSignal?: () => number; state?: () => number; threadExit?: (pid: number, tid: number, ran: number) => bigint }) {
  const pid = 100;
  const kernelMemory = new WebAssembly.Memory({ initial: 2 });
  const task = { group: 7, pid, tid: pid, serial: 1n, generation: 0n };
  const store = grouped ? groupMemoryObservationFixture({ receipt: task, initialPages: 3 }) : undefined;
  const launch = store ? { ...store.launch, source: store.source } : undefined;
  if (launch) {
    const ptes = new Uint32Array(launch.envelope.memory.buffer, launch.expectation.root + 64, 16);
    [ptes[0], ptes[2]] = [ptes[2], ptes[0]];
  }
  const processMemory = launch?.envelope.memory ?? new WebAssembly.Memory({
    initial: 2,
    maximum: 2,
    shared: true,
  });
  const channel = createTestChannel(pid, processMemory, launch?.source, channelOffset);
  const worker = createCentralizedKernelWorkerTestDouble();
  installKernelWorkerTestScratch(
    worker,
    kernelMemory,
    128,
    ptrWidth,
    { kernelExports: {
      kernel_get_process_exit_signal: lifecycle?.exitSignal ?? (() => -1),
      kernel_get_process_state: lifecycle?.state ?? (() => PROCESS_STATE_RUNNING),
      kernel_dequeue_signal: () => 0,
      kernel_drain_wakeup_events: () => 0,
      kernel_get_parent_pid: () => -1,
      kernel_set_current_tid: () => 0,
      kernel_thread_exit: lifecycle?.threadExit ?? (() => 0n),
    } },
  );
  const state = worker as unknown as MutableCopybackWorkerState;
  state.processes = new Map([
    [
      pid,
      {
        pid,
        memory: processMemory, source: channel.source,
        grouped: store ? { handle: store.handle, store: store.transport } : undefined,
        channels: [channel],
        ptrWidth,
        explicitMaxAddr: false,
      },
    ],
  ]);
  state.activeChannels = [channel];
  // Completion normally relistens the mailbox. Polling mode keeps this
  // focused harness synchronous without replacing a worker method.
  state.usePolling = true;
  if (launch) launch.source.atomicStoreI32(channelOffset + CH_STATUS, CHANNEL_STATUS_PENDING);
  else Atomics.store(channel.i32View, CH_STATUS / Int32Array.BYTES_PER_ELEMENT, CHANNEL_STATUS_PENDING);

  return {
    worker,
    channel,
    state,
    store, launch,
    processMem: new Uint8Array(processMemory.buffer),
  };
}

describe("CentralizedKernelWorker syscall copy-back", () => {
  it("settles the retired pthread observer when teardown cancels its queued EXIT response", async () => {
    const { worker, channel, launch, store, state } = makeCopybackHarness(4, true);
    const source = launch!.source, words = new Int32Array(channel.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const main = createTestChannel(channel.pid, channel.memory, source, 8192);
    state.processes.get(channel.pid)!.channels.unshift(main);
    state.activeChannels.unshift(main);
    (worker as any).channelTids.set(`${channel.pid}:${channel.channelOffset}`, 101);
    processDataView(source).setUint32(CH_SYSCALL, ABI_SYSCALLS.Exit, true);
    Atomics.store(words, q, 1);
    try {
      (worker as any).handleSyscall(channel);
      expect((worker as any).parkedChannelCompletions.size).toBe(1);
      // Process teardown discards already-decided old-image publications.
      // Its actual engine observation must settle before its token can end.
      (worker as any).discardStoppedChannelStateForProcess(channel.pid);
      Atomics.store(words, q, 0); Atomics.notify(words, q);
      await expect.poll(() => store!.pending.size).toBe(0);
      expect((worker as any).pendingChannelNativeObservations.size).toBe(0);
      expect((worker as any).retiredChannelListeners.has(channel)).toBe(false);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect(state.processes.get(channel.pid)!.channels).toEqual([main]);
    } finally { Atomics.store(words, q, 0); Atomics.notify(words, q); store!.close(); }
  });

  it.each(['notify', 'timeout', 'resume'] as const)("finishes the exact removed pthread EXIT transport after notification queue contention (%s)", async mode => {
    let processState: number = PROCESS_STATE_RUNNING;
    const threadExit = vi.fn(() => 0n);
    const { worker, channel, launch, store, state } = makeCopybackHarness(4, true, 0, { threadExit, state: () => processState });
    const source = launch!.source, words = new Int32Array(channel.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const main = createTestChannel(channel.pid, channel.memory, source, 8192);
    const waits = vi.spyOn(Atomics, 'waitAsync');
    state.processes.get(channel.pid)!.channels.unshift(main);
    state.activeChannels.unshift(main);
    (worker as any).channelTids.set(`${channel.pid}:${channel.channelOffset}`, 101);
    processDataView(source).setUint32(CH_SYSCALL, ABI_SYSCALLS.Exit, true);
    Atomics.store(words, q, 1);
    try {
      (worker as any).handleSyscall(channel);
      expect(threadExit).toHaveBeenCalledExactlyOnceWith(channel.pid, 101, 1);
      expect(state.processes.get(channel.pid)!.channels).toEqual([main]);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect((worker as any).parkedChannelCompletions.size).toBe(1);
      await expect.poll(() => waits.mock.calls.filter(([word]) => word.byteOffset === G.MEMORY_GROUP_WAIT_HEADER).length).toBeGreaterThan(1);
      expect((worker as any).retiredChannelListeners.has(channel)).toBe(true);
      if (mode === 'resume') {
        processState = PROCESS_STATE_STOPPED;
        (worker as any).stoppedPids.add(channel.pid);
        expect(worker.testAuthority.resumeStoppedProcessForTest(channel.pid)).toBe(false);
        processState = PROCESS_STATE_RUNNING;
        expect(worker.testAuthority.resumeStoppedProcessForTest(channel.pid)).toBe(true);
      }
      Atomics.store(words, q, 0);
      if (mode !== 'timeout') Atomics.notify(words, q);
      await expect.poll(() => source.atomicLoadI32(CH_STATUS), { timeout: 1000 }).toBe(CHANNEL_STATUS_COMPLETE);
      expect(processDataView(source).getBigInt64(CH_RETURN, true)).toBe(0n);
      expect(threadExit).toHaveBeenCalledTimes(1);
      expect(state.processes.get(channel.pid)!.channels).toEqual([main]);
      expect((worker as any).parkedChannelCompletions.size).toBe(0);
      expect((worker as any).pendingChannelNativeObservations.size).toBe(0);
      expect(store!.pending.size).toBe(0);
      expect((worker as any).retiredChannelListeners.has(channel)).toBe(false);
      expect(source.atomicLoadI32(main.channelOffset + CH_STATUS)).toBe(0);
    } finally { Atomics.store(words, q, 0); Atomics.notify(words, q); waits.mockRestore(); store!.close(); }
  });

  it("keeps the kernel available while grouped completion notification Q is held", async () => {
    const { worker, channel, launch, store, state } = makeCopybackHarness(4, true);
    const words = new Int32Array(channel.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    const source = launch!.source;
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw Error('Kernel completion must not block on guest Q'); });
    Atomics.store(words, q, 1);
    try {
      worker.testAuthority.completeDetachedCopybackForTest({ pid: channel.pid, registrationWitness: channel,
        operation: 'read', fd: 0, destination: 8192, requestedLength: 4, returnValue: 4, outputBytes: Uint8Array.of(1,2,3,4) });
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect([...source.readBytes(8192, 4)]).toEqual([1,2,3,4]);
      expect(channel.handling).toBe(true);
      const peerMemory = new WebAssembly.Memory({initial:2, maximum:2, shared:true});
      const peer = createTestChannel(101, peerMemory);
      Atomics.store(peer.i32View, CH_STATUS / 4, CHANNEL_STATUS_PENDING);
      state.processes.set(peer.pid, {pid:peer.pid,memory:peerMemory,source:peerMemory,channels:[peer],ptrWidth:4,explicitMaxAddr:false} as any);
      state.activeChannels.push(peer);
      await retryKernelEntryResult(() => worker.testAuthority.completeDetachedCopybackForTest({ pid:peer.pid,registrationWitness:peer,
        operation:'read',fd:0,destination:8192,requestedLength:1,returnValue:1,outputBytes:Uint8Array.of(9) }));
      expect(Atomics.load(peer.i32View,CH_STATUS / 4)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(wait).not.toHaveBeenCalled();
      // Outputs were already materialized. Retrying queue publication must
      // not recopy them over another participant's subsequent change.
      source.writeBytes(8192,Uint8Array.of(7));
      Atomics.store(words,q,0);Atomics.notify(words,q);
      await expect.poll(()=>source.atomicLoadI32(CH_STATUS),{timeout:1000}).toBe(CHANNEL_STATUS_COMPLETE);
      expect(processDataView(source).getBigInt64(CH_RETURN,true)).toBe(4n);
      expect([...source.readBytes(8192,4)]).toEqual([7,2,3,4]);
      expect((worker as any).parkedChannelCompletions.size).toBe(0);
      expect((worker as any).pendingChannelNativeObservations.size).toBe(0);
    } finally { Atomics.store(words,q,0);Atomics.notify(words,q);wait.mockRestore();store!.close(); }
  });

  it("discards a queued grouped completion after exact channel replacement", async () => {
    const { worker, channel, launch, store, state } = makeCopybackHarness(4,true);
    const source=launch!.source,words=new Int32Array(channel.memory.buffer),q=G.MEMORY_GROUP_WAIT_HEADER / 4;
    const wait=vi.spyOn(Atomics,'wait').mockImplementation(()=>{throw Error('Kernel completion must not block on guest Q');});
    Atomics.store(words,q,1);
    try {
      worker.testAuthority.completeDetachedCopybackForTest({pid:channel.pid,registrationWitness:channel,
        operation:'read',fd:0,destination:8192,requestedLength:1,returnValue:1,outputBytes:Uint8Array.of(3)});
      const replacementMemory=new WebAssembly.Memory({initial:2,maximum:2,shared:true});
      const replacement=createTestChannel(channel.pid,replacementMemory);
      Atomics.store(replacement.i32View,CH_STATUS / 4,CHANNEL_STATUS_PENDING);
      state.processes.set(channel.pid,{pid:channel.pid,memory:replacementMemory,source:replacementMemory,channels:[replacement],ptrWidth:4,explicitMaxAddr:false} as any);
      state.activeChannels=[replacement];
      Atomics.store(words,q,0);Atomics.notify(words,q);
      await expect.poll(()=>(worker as any).pendingChannelNativeObservations.size,{timeout:1000}).toBe(0);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect(Atomics.load(replacement.i32View,CH_STATUS / 4)).toBe(CHANNEL_STATUS_PENDING);
      expect((worker as any).parkedChannelCompletions.size).toBe(0);
    } finally { Atomics.store(words,q,0);Atomics.notify(words,q);wait.mockRestore();store!.close(); }
  });

  it("rechecks Q after actual engine timeouts without requiring an unlock notification", async () => {
    const {worker,channel,launch,store}=makeCopybackHarness(4,true);
    const source=launch!.source,words=new Int32Array(channel.memory.buffer),q=G.MEMORY_GROUP_WAIT_HEADER / 4;
    const waits=vi.spyOn(Atomics,'waitAsync');
    Atomics.store(words,q,1);
    try {
      worker.testAuthority.completeDetachedCopybackForTest({pid:channel.pid,registrationWitness:channel,
        operation:'read',fd:0,destination:8192,requestedLength:1,returnValue:1,outputBytes:Uint8Array.of(3)});
      await expect.poll(()=>waits.mock.calls.filter(([word])=>word.byteOffset===G.MEMORY_GROUP_WAIT_HEADER).length).toBeGreaterThan(1);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      await vi.waitFor(() => expect(store!.pending.size).toBe(1));
      // A competing native observer can consume the unlock notification.
      // Neither that loss nor the finite progress wait may lose this result.
      Atomics.store(words,q,0);
      await expect.poll(()=>source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(store!.pending.size).toBe(0);
      expect((worker as any).parkedChannelCompletions.size).toBe(0);
    } finally { Atomics.store(words,q,0);Atomics.notify(words,q);waits.mockRestore();store!.close(); }
  });

  it.each([ABI_SYSCALLS.Exit, ABI_SYSCALLS.ExitGroup, ABI_SYSCALLS.Getpid])(
    "publishes the exact retired transport handshake for an already exited Process (%i)", async syscall => {
      const {worker,channel,launch,store}=makeCopybackHarness(4,true,0,{exitSignal:()=>0});
      const source=launch!.source,words=new Int32Array(channel.memory.buffer),q=G.MEMORY_GROUP_WAIT_HEADER / 4;
      (worker as any).hostReaped.add(channel.pid);
      processDataView(source).setUint32(CH_SYSCALL,syscall,true);
      Atomics.store(words,q,1);
      try {
        (worker as any).handleSyscall(channel);
        expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
        expect((worker as any).parkedChannelCompletions.size).toBe(1);
        Atomics.store(words,q,0);Atomics.notify(words,q);
        await expect.poll(()=>source.atomicLoadI32(CH_STATUS),{timeout:1000}).toBe(CHANNEL_STATUS_COMPLETE);
        expect(processDataView(source).getBigInt64(CH_RETURN,true)).toBe(syscall===ABI_SYSCALLS.Getpid ? -1n : 0n);
        expect((worker as any).pendingChannelNativeObservations.size).toBe(0);
        expect((worker as any).parkedChannelCompletions.size).toBe(0);
      } finally {Atomics.store(words,q,0);Atomics.notify(words,q);store!.close();}
    });

  it.each([0, -3])("does not publish queued completion for a dead or reaped kernel Process (%i)", async exitSignal => {
    let signal = -1;
    const { worker, channel, launch, store, state } = makeCopybackHarness(4, true, 0,
      { exitSignal: () => signal });
    const source = launch!.source, words = new Int32Array(channel.memory.buffer), q = G.MEMORY_GROUP_WAIT_HEADER / 4;
    Atomics.store(words, q, 1);
    try {
      worker.testAuthority.completeDetachedCopybackForTest({ pid:channel.pid,registrationWitness:channel,
        operation:'read',fd:0,destination:8192,requestedLength:1,returnValue:1,outputBytes:Uint8Array.of(3) });
      signal = exitSignal;
      Atomics.store(words,q,0); Atomics.notify(words,q);
      await expect.poll(() => (worker as any).parkedChannelCompletions.size).toBe(0);
      expect(state.processes.get(channel.pid)?.channels[0]).toBe(channel);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect((worker as any).pendingChannelNativeObservations.size).toBe(0);
    } finally { Atomics.store(words,q,0);Atomics.notify(words,q);store!.close(); }
  });

  it("keeps a queued result parked through STOP until real resume preflight", async () => {
    let processState: number = PROCESS_STATE_RUNNING;
    const { worker, channel, launch, store } = makeCopybackHarness(4, true, 0,
      { state: () => processState });
    const source=launch!.source,words=new Int32Array(channel.memory.buffer),q=G.MEMORY_GROUP_WAIT_HEADER / 4;
    Atomics.store(words,q,1);
    try {
      worker.testAuthority.completeDetachedCopybackForTest({pid:channel.pid,registrationWitness:channel,
        operation:'read',fd:0,destination:8192,requestedLength:1,returnValue:1,outputBytes:Uint8Array.of(3)});
      processState=PROCESS_STATE_STOPPED;
      (worker as any).stoppedPids.add(channel.pid);
      Atomics.store(words,q,0);Atomics.notify(words,q);
      await expect.poll(()=>(worker as any).pendingChannelNativeObservations.size).toBe(0);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect((worker as any).parkedChannelCompletions.size).toBe(1);
      expect(worker.testAuthority.resumeStoppedProcessForTest(channel.pid)).toBe(false);
      processState=PROCESS_STATE_RUNNING;
      expect(worker.testAuthority.resumeStoppedProcessForTest(channel.pid)).toBe(true);
      await expect.poll(()=>source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(processDataView(source).getBigInt64(CH_RETURN,true)).toBe(1n);
      expect((worker as any).parkedChannelCompletions.size).toBe(0);
    } finally { Atomics.store(words,q,0);Atomics.notify(words,q);store!.close(); }
  });

  it("retains the exact queue observer until actual retired-listener settlement", async () => {
    const {worker,channel,launch,store}=makeCopybackHarness(4,true);
    const source=launch!.source,words=new Int32Array(channel.memory.buffer),q=G.MEMORY_GROUP_WAIT_HEADER / 4;
    Atomics.store(words,q,1);
    try {
      worker.testAuthority.completeDetachedCopybackForTest({pid:channel.pid,registrationWitness:channel,
        operation:'read',fd:0,destination:8192,requestedLength:1,returnValue:1,outputBytes:Uint8Array.of(3)});
      await vi.waitFor(() => expect(store!.pending.size).toBe(1));
      (worker as any).retireChannelListener(channel);
      expect(()=>worker.settleRetiredChannelListeners(channel.pid,channel.memory,0)).toThrow('exact image source');
      const settled=worker.settleRetiredChannelListeners(channel.pid,channel.memory,0,source);
      expect(store!.pending.size).toBe(1);
      expect((worker as any).pendingChannelListenerCounts.get(channel)).toBe(1);
      await settled;
      expect(store!.pending.size).toBe(0);
      expect((worker as any).pendingChannelNativeObservations.size).toBe(0);
      expect((worker as any).pendingChannelListenerCounts.size).toBe(0);
      expect((worker as any).parkedChannelCompletions.size).toBe(0);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_PENDING);
      expect(Atomics.load(words,q)).toBe(1);
    } finally { Atomics.store(words,q,0);Atomics.notify(words,q);store!.close(); }
  });

  it("copies a split virtual output through the channel's captured image source", () => {
    const { worker, channel, launch, store } = makeCopybackHarness(4, true);
    try {
      const source = launch!.source, destination = 65536 - 2;
      source.fillBytes(destination, 8, 0xa5);
      worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid, registrationWitness: channel, operation: "read", fd: 0,
        destination, requestedLength: 8, returnValue: 4, outputBytes: Uint8Array.of(1, 2, 3, 4),
      });
      expect([...source.readBytes(destination, 8)]).toEqual([1, 2, 3, 4, 0xa5, 0xa5, 0xa5, 0xa5]);
      expect(source.atomicLoadI32(CH_STATUS)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(processDataView(source).getBigInt64(CH_RETURN, true)).toBe(4n);
    } finally { store!.close(); }
  });
  it("publishes a result and status across two virtual pages without touching physical offsets", () => {
    const offset = 65536 - 60;
    const { worker, channel, launch, store } = makeCopybackHarness(4, true, offset);
    try {
      const source = launch!.source;
      worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid, registrationWitness: channel, operation: "read", fd: 0,
        destination: 8192, requestedLength: 4, returnValue: 4, outputBytes: Uint8Array.of(5, 6, 7, 8),
      });
      expect([...source.readBytes(8192, 4)]).toEqual([5, 6, 7, 8]);
      expect(source.atomicLoadI32(offset + CH_STATUS)).toBe(CHANNEL_STATUS_COMPLETE);
      expect(processDataView(source, offset).getBigInt64(CH_RETURN, true)).toBe(4n);
      expect(processDataView(source, offset).getUint32(CH_ERRNO, true)).toBe(0);
    } finally { store!.close(); }
  });
  it("leaves the destination unchanged when read reports EOF", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const dest = 1024;
    const original = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);

    processMem.set(original, dest);
    worker.testAuthority.completeDetachedCopybackForTest({
      pid: channel.pid,
      registrationWitness: channel,
      operation: "read",
      fd: 0,
      destination: dest,
      requestedLength: original.length,
      returnValue: 0,
    });

    expect(processMem.slice(dest, dest + original.length)).toEqual(original);
    const channelView = new DataView(processMem.buffer);
    expect(channelView.getBigInt64(CH_RETURN, true)).toBe(0n);
    expect(channelView.getUint32(CH_ERRNO, true)).toBe(0);
    expect(Atomics.load(channel.i32View, CH_STATUS / 4)).toBe(
      CHANNEL_STATUS_COMPLETE,
    );
  });

  it("copies only the byte count reported by read", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const dest = 2048;
    const original = Uint8Array.from({ length: 8 }, (_, i) => 0xc0 + i);

    processMem.set(original, dest);
    worker.testAuthority.completeDetachedCopybackForTest({
      pid: channel.pid,
      registrationWitness: channel,
      operation: "read",
      fd: 0,
      destination: dest,
      requestedLength: original.length,
      returnValue: 3,
      outputBytes: Uint8Array.of(1, 2, 3),
    });

    expect(Array.from(processMem.slice(dest, dest + original.length))).toEqual([
      1,
      2,
      3,
      ...original.slice(3),
    ]);
  });

  it("rejects a stale registered-channel generation witness", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const destination = 3072;
    processMem.fill(0x7c, destination, destination + 4);

    expectEntryCause(
      () => worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid,
        registrationWitness: { ...channel },
        operation: "read",
        fd: 0,
        destination,
        requestedLength: 4,
        returnValue: 0,
      }),
      "requires one exact process-owned main channel",
    );
    expect(Array.from(processMem.slice(destination, destination + 4)))
      .toEqual([0x7c, 0x7c, 0x7c, 0x7c]);
  });

  it.each([4, 8] as const)(
    "copies the complete 112-byte stat record for a wasm%s caller",
    (ptrWidth) => {
      const { worker, channel, processMem } =
        makeCopybackHarness(ptrWidth);
      const dest = 4096;
      const size = 112;
      const canary = 0x5a;
      const output = Uint8Array.from(
        { length: size },
        (_, index) => (index * 29 + 7) & 0xff,
      );
      const descriptors = SYSCALL_ARGS[ABI_SYSCALLS.Fstat];
      const statOutput = descriptors?.find((desc) => desc.argIndex === 1);

      expect(statOutput?.size).toEqual({ type: "fixed", size });
      expect(statOutput?.required).toBe(true);
      processMem.fill(canary, dest - 1, dest + size + 1);
      worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid,
        registrationWitness: channel,
        operation: "fstat",
        fd: 3,
        destination: dest,
        outputBytes: output,
      });

      expect(processMem.slice(dest, dest + size)).toEqual(output);
      expect(processMem[dest - 1]).toBe(canary);
      expect(processMem[dest + size]).toBe(canary);
    },
  );

  it.each([4, 8] as const)(
    "copies the complete initialized 48-byte sched_param for a wasm%s caller",
    (ptrWidth) => {
      const { worker, channel, processMem } =
        makeCopybackHarness(ptrWidth);
      const dest = 8192;
      const size = 48;
      const canary = 0xa6;
      const output = Uint8Array.from(
        { length: size },
        (_, index) => (index * 17 + 3) & 0xff,
      );
      const descriptors = SYSCALL_ARGS[ABI_SYSCALLS.SchedGetparam];
      const schedOutput = descriptors?.find((desc) => desc.argIndex === 1);

      expect(schedOutput?.size).toEqual({ type: "fixed", size });
      expect(schedOutput?.required).toBe(true);
      processMem.fill(canary, dest - 1, dest + size + 1);
      worker.testAuthority.completeDetachedCopybackForTest({
        pid: channel.pid,
        registrationWitness: channel,
        operation: "sched-getparam",
        targetPid: 0,
        destination: dest,
        outputBytes: output,
      });

      expect(processMem.slice(dest, dest + size)).toEqual(output);
      expect(processMem[dest - 1]).toBe(canary);
      expect(processMem[dest + size]).toBe(canary);
    },
  );

  it("carries detached poll output through an immediate timeout without rereading scratch", () => {
    const { worker, channel, processMem } = makeCopybackHarness();
    const pollfd = 12_000;
    const detached = Uint8Array.of(
      3, 0, 0, 0,
      1, 0,
      0, 0,
    );
    processMem.fill(0xa5, pollfd, pollfd + detached.byteLength);
    worker.testAuthority.completeImmediatePollTimeoutForCopybackTest({
      pid: channel.pid,
      registrationWitness: channel,
      pollfdPointer: pollfd,
      outputBytes: detached,
    });

    expect(processMem.slice(pollfd, pollfd + detached.byteLength))
      .toEqual(detached);
    expect(processMem[pollfd]).not.toBe(0xee);
  });

  it("rejects a busy copy-back operation without reading or replaying it", async () => {
    const { worker, channel, state } = makeCopybackHarness();
    const nestedPid = 101;
    const nestedMemory = new WebAssembly.Memory({
      initial: 2,
      maximum: 2,
      shared: true,
    });
    const nestedChannel = createTestChannel(nestedPid, nestedMemory);
    state.processes.set(nestedPid, {
      pid: nestedPid,
      memory: nestedMemory, source: nestedMemory,
      channels: [nestedChannel],
      ptrWidth: 4,
      explicitMaxAddr: false,
    });
    state.activeChannels.push(nestedChannel);
    Atomics.store(
      nestedChannel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
      CHANNEL_STATUS_PENDING,
    );
    const nestedPollfd = 4096;
    const nestedProcessBytes = new Uint8Array(nestedMemory.buffer);
    nestedProcessBytes.fill(
      0xa5,
      nestedPollfd,
      nestedPollfd + 8,
    );
    let nestedOptionsRead = false;
    const nestedOptions = {
      get pid(): number {
        nestedOptionsRead = true;
        return nestedPid;
      },
      registrationWitness: nestedChannel,
      pollfdPointer: nestedPollfd,
      outputBytes: Uint8Array.of(3, 0, 0, 0, 1, 0, 0, 0),
    };
    let reentrantError: unknown;
    const statOutput = Uint8Array.from(
      { length: 112 },
      (_, index) => index,
    );

    worker.testAuthority.completeDetachedCopybackForTest({
      pid: channel.pid,
      registrationWitness: channel,
      operation: "fstat",
      fd: 3,
      destination: 8192,
      get outputBytes(): Uint8Array {
        try {
          worker.testAuthority
            .completeImmediatePollTimeoutForCopybackTest(nestedOptions);
        } catch (error) {
          reentrantError = error;
        }
        return statOutput;
      },
    });

    expect(reentrantError).toBeInstanceOf(KernelReentrantEntryError);
    expect(nestedOptionsRead).toBe(false);
    expect(Atomics.load(
      nestedChannel.i32View,
      CH_STATUS / Int32Array.BYTES_PER_ELEMENT,
    )).toBe(CHANNEL_STATUS_PENDING);

    // Allow any gate drain microtasks to run. The rejected options must never
    // be retained for a later turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(nestedOptionsRead).toBe(false);
    expect(Array.from(
      nestedProcessBytes.slice(nestedPollfd, nestedPollfd + 8),
    )).toEqual(new Array(8).fill(0xa5));
  });
});

function expectEntryCause(
  operation: () => unknown,
  expectedMessage: string,
): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const cause = (thrown as { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain(expectedMessage);
}
