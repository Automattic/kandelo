/**
 * Rust-owned parks must retire before a host teardown publishes its terminal
 * mailbox result. These controls run the real host handler and canonical gate
 * against generated scratch/wake/completion wires; bounded Wasm exports model
 * Rust decisions. They do not claim an actual application/browser reproduction.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createCentralizedKernelWorkerTestDouble } from '../src/kernel-worker';
import { installKernelWorkerTestScratch, emptyProcessTimerCleanup } from './kernel-worker-test-scratch';
import { ABI_SYSCALLS, HOST_INTERCEPTED_SYSCALLS, PROCESS_STATE_EXITED, CH_STATUS, CH_SYSCALL, CH_ARGS, CH_ARG_SIZE, CH_RETURN, CH_ERRNO, CH_SIG_SIGNUM, CH_SIG_FLAGS, CH_SIG_SI_CODE, CH_REQUEST_FLAGS, CHANNEL_STATUS_PENDING, CHANNEL_STATUS_COMPLETE, KERNEL_WAIT_PARKED_ERRNO, WAIT_COMPLETION_FIELDS, WAIT_COMPLETION_FLAGS, WAKEUP_EVENT_FIELDS, WAKEUP_EVENT_TYPES } from '../src/generated/abi';
import { EXEC_RETIRE_SIGNAL_CODE, EXIT_RETIRE_SIGNAL_CODE } from '../src/worker-protocol';
afterEach(() => vi.restoreAllMocks());
function harness(width: 4 | 8, cleanupResult: {
    ret: bigint;
    errno: number;
} = { ret: 0n, errno: 0 }, includeExecCaller = false) {
    const pid = 41, parkGeneration = 701n, offset = 6 * 65536;
    const kernelMemory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
    const memory = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
    let queued = false, wakeQueued = false, drainCount = 0, dequeued = 0, dispatches = 0, cancelled = 0, completionFlags = 0, execGeneration = 1n, exited = false, cancelMarker = -1, drainedFlags = -1;
    const exports: Record<string, any> = {
        kernel_get_process_exec_generation: (_pid: number, p: number | bigint) => { new DataView(kernelMemory.buffer).setBigUint64(Number(p), execGeneration, true); return 8; },
        kernel_get_process_state: () => exited ? PROCESS_STATE_EXITED : 0, kernel_get_process_exit_signal: () => exited ? 0 : -1, kernel_get_process_exit_status: () => exited ? 137 : -1,
        kernel_commit_process_exit: (status: number) => { exited = true; return status & 0xff; },
        kernel_get_parent_pid: () => 0,
        kernel_take_process_timer_cleanup: emptyProcessTimerCleanup(kernelMemory),
        kernel_set_current_tid: () => 0, kernel_drain_wakeup_events: (p: number | bigint) => {
            if (!wakeQueued)
                return 0;
            wakeQueued = false;
            const v = new DataView(kernelMemory.buffer, Number(p));
            v.setUint32(WAKEUP_EVENT_FIELDS.idx.offset, 0, true);
            v.setUint8(WAKEUP_EVENT_FIELDS.wakeType.offset, WAKEUP_EVENT_TYPES.waitComplete);
            return 1;
        },
        kernel_wait_next_timeout_ns: () => -1n,
        kernel_dequeue_signal: () => { dequeued++; return 0; },
        kernel_handle_channel: (p: number | bigint) => {
            const v = new DataView(kernelMemory.buffer, Number(p));
            if (v.getUint32(CH_SYSCALL, true) === ABI_SYSCALLS.ThreadCancel) {
                expect(Number(v.getBigInt64(CH_ARGS, true))).toBe(pid);
                cancelled++;
                cancelMarker = new DataView(memory.buffer, offset).getUint32(CH_SIG_SIGNUM, true);
                v.setBigInt64(CH_RETURN, cleanupResult.ret, true);
                v.setUint32(CH_ERRNO, cleanupResult.errno, true);
                if (cleanupResult.ret === 0n && cleanupResult.errno === 0) {
                    queued = true;
                    wakeQueued = true;
                    completionFlags = WAIT_COMPLETION_FLAGS.cancelled;
                }
            }
            else {
                dispatches++;
                v.setBigInt64(CH_RETURN, parkGeneration, true);
                v.setUint32(CH_ERRNO, KERNEL_WAIT_PARKED_ERRNO, true);
            }
            return 0;
        },
        kernel_drain_wait_completions: (p: number | bigint) => {
            if (!queued)
                return 0;
            queued = false;
            drainCount++;
            drainedFlags = completionFlags;
            const v = new DataView(kernelMemory.buffer, Number(p)), f = WAIT_COMPLETION_FIELDS;
            v.setBigUint64(f.generation.offset, parkGeneration, true);
            v.setUint32(f.pid.offset, pid, true);
            v.setUint32(f.tid.offset, pid, true);
            v.setInt32(f.value.offset, -4, true);
            v.setUint32(f.flags.offset, completionFlags, true);
            return 1;
        },
    };
    const errors = vi.spyOn(console, 'error');
    const fatal = vi.fn(), worker: any = createCentralizedKernelWorkerTestDouble({ callbacks: { onKernelFatal: fatal } });
    installKernelWorkerTestScratch(worker, kernelMemory, 4096, width, { kernelExports: exports, kernelExportNames: Object.keys(exports) });
    const relisten = vi.fn();
    worker.testAuthority.configureScratchBoundaryHooksForTest({ relistenChannel: relisten, synchronizeSharedMemoryForBoundary: vi.fn() });
    const channel = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid, memory, channelOffsets: includeExecCaller ? [offset, 3 * 65536] : [offset], pointerWidth: width })[0];
    const view = new DataView(memory.buffer, offset);
    // Publication's canonical relisten hook counts actual logical completions;
    // kernel-worker captures native Atomics.notify at module initialization.
    function request(syscall: number = ABI_SYSCALLS.Sigsuspend, args: readonly bigint[] = [8192n]) {
        view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
        view.setUint32(CH_SYSCALL, syscall, true);
        view.setUint32(CH_REQUEST_FLAGS, 0, true);
        for (let i = 0; i < 6; i++)
            view.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, args[i] ?? 0n, true);
    }
    const snapshot = () => ({ status: view.getUint32(CH_STATUS, true), signal: view.getUint32(CH_SIG_SIGNUM, true), signalCode: view.getUint32(CH_SIG_SI_CODE, true), flags: view.getUint32(CH_SIG_FLAGS, true), return: String(view.getBigInt64(CH_RETURN, true)), errno: view.getUint32(CH_ERRNO, true), park: channel.kernelWaitGeneration ?? null, publications: relisten.mock.calls.length, dequeued, dispatches, drainCount, cancelled, cancelMarker, drainedFlags });
    function queueAndDrain() { queued = true; wakeQueued = true; worker.drainAndProcessWakeupEvents(); }
    function arm() { request(); worker.handleSyscall(channel); expect(channel.kernelWaitGeneration).toBe(Number(parkGeneration)); expect(dispatches).toBe(1); expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_PENDING); }
    return { pid, width, worker, channel, memory, view, errors, request, snapshot, queueAndDrain, arm, fatal, relisten, setGeneration: (value: bigint) => { execGeneration = value; }, setExited: () => { exited = true; } };
}
for (const width of [4, 8] as const) {
    it(`preserves teardown's terminal marker against a late previously armed park (width${width})`, async () => {
        const h = harness(width);
        h.arm();
        const armed = h.snapshot();
        expect(await h.worker.killAllBlockedForTeardown()).toEqual(new Set([h.pid]));
        const woken = h.snapshot();
        expect(woken.status).toBe(CHANNEL_STATUS_COMPLETE);
        expect(woken.signal).toBe(9);
        expect(woken.return).toBe('-1');
        expect(woken.errno).toBe(4);
        h.queueAndDrain();
        const late = h.snapshot();
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
        expect(late.signal, 'Old kernel park must not erase terminal marker').toBe(9);
        expect(woken.cancelled).toBe(1);
        expect(woken.park).toBe(null);
        expect(late.dequeued).toBe(0);
        expect(woken.cancelMarker).toBe(0);
        expect(woken.drainedFlags).toBe(WAIT_COMPLETION_FLAGS.cancelled);
        expect(h.errors).not.toHaveBeenCalled();
        expect(late.publications, 'Old park must not publish a second completion').toBe(woken.publications);
        expect(late.return).toBe('-1');
        expect(late.errno).toBe(4);
    });
    it(`does not let a prior park complete a successor registration (width${width})`, async () => {
        const h = harness(width);
        h.arm();
        await h.worker.killAllBlockedForTeardown();
        const nextMemory = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
        const replacement = h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid: h.pid, memory: nextMemory, channelOffsets: [6 * 65536], pointerWidth: width })[0];
        const next = new DataView(nextMemory.buffer, 6 * 65536);
        next.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
        next.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);
        next.setBigInt64(CH_RETURN, 0x55n, true);
        next.setUint32(CH_SIG_SIGNUM, 10, true);
        h.queueAndDrain();
        expect(next.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_PENDING);
        expect(next.getBigInt64(CH_RETURN, true)).toBe(0x55n);
        expect(next.getUint32(CH_SIG_SIGNUM, true)).toBe(10);
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
    });
    it(`publishes an ordinary live park once (width${width})`, () => {
        const h = harness(width);
        h.arm();
        h.queueAndDrain();
        const first = h.snapshot();
        h.queueAndDrain();
        const second = h.snapshot();
        expect(first.status).toBe(CHANNEL_STATUS_COMPLETE);
        expect(first.return).toBe('-4');
        expect(first.errno).toBe(4);
        expect(first.park).toBe(null);
        expect(second.publications).toBe(first.publications);
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
    });
}
for (const width of [4, 8] as const) {
    it(`scoped teardown retires the same exact park before its cancelled record (width${width})`, async () => {
        const h = harness(width);
        h.arm();
        expect(await h.worker.killBlockedProcessForTeardown(h.pid)).toEqual(new Set([h.pid]));
        const first = h.snapshot();
        h.queueAndDrain();
        const last = h.snapshot();
        expect(first).toMatchObject({ signal: 9, park: null, cancelled: 1, publications: 1, dequeued: 0 });
        expect(last).toMatchObject({ signal: 9, park: null, cancelled: 1, publications: 1, dequeued: 0 });
    });
    for (const cleanup of [{ ret: -1n, errno: 5 }, { ret: -1n, errno: 0 }, { ret: 1n, errno: 0 }, { ret: 0n, errno: 5 }]) {
        it(`fails loudly without terminal publication after cleanup(${cleanup.ret},${cleanup.errno}) width${width}`, async () => {
            const h = harness(width, cleanup);
            h.arm();
            await expect(h.worker.killAllBlockedForTeardown()).rejects.toThrow('could not retire teardown park');
            expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_PENDING, signal: 0, park: 701, cancelled: 1, publications: 0 });
            expect(h.fatal).toHaveBeenCalledOnce();
            expect(h.errors).toHaveBeenCalledOnce();
            expect(String(h.errors.mock.calls[0]?.[0])).toContain("wake failed");
        });
    }
    it(`does not cancel a successor Rust image while old host registration remains (width${width})`, async () => {
        const h = harness(width);
        h.arm();
        h.setGeneration(2n);
        expect(await h.worker.killAllBlockedForTeardown()).toEqual(new Set());
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_PENDING, signal: 0, park: 701, cancelled: 0, publications: 0 });
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
    });
    it(`uses existing exit authority without cancelling an already exited task (width${width})`, async () => {
        const h = harness(width);
        h.arm();
        h.setExited();
        expect(await h.worker.killAllBlockedForTeardown()).toEqual(new Set([h.pid]));
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, signal: 9, cancelled: 0 });
        h.queueAndDrain();
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, signal: 9, signalCode: EXIT_RETIRE_SIGNAL_CODE, return: '-1', cancelled: 0, park: null, dequeued: 0 });
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
    });
}
for (const width of [4, 8] as const) {
    it(`retires a queued old park before exec markers without cancelling successor TIDs (width${width})`, () => {
        // The old process leader parks through the real handler. A distinct old
        // channel stands for the exec-calling pthread at the committed handoff;
        // this control judges the host retirement protocol, not Rust TID allocation.
        const h = harness(width, { ret: 0n, errno: 0 }, true);
        h.arm();
        const execOffset = 3 * 65536, exec = new DataView(h.memory.buffer, execOffset);
        exec.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
        exec.setUint32(CH_SYSCALL, HOST_INTERCEPTED_SYSCALLS.SYS_EXECVE, true);
        h.setGeneration(2n);
        expect(h.worker.wakeProcessWorkersForExecRetirement(h.pid, h.memory)).toEqual(new Set([6 * 65536, execOffset]));
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, signal: 9, signalCode: EXEC_RETIRE_SIGNAL_CODE, cancelled: 0, return: '-1' });
        h.queueAndDrain();
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, signal: 9, signalCode: EXEC_RETIRE_SIGNAL_CODE, park: null, cancelled: 0, return: '-1', dequeued: 0 });
        expect(exec.getUint32(CH_SIG_SIGNUM, true)).toBe(9);
        expect(exec.getUint32(CH_SIG_SI_CODE, true)).toBe(EXEC_RETIRE_SIGNAL_CODE);
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
        const successor = new WebAssembly.Memory({ initial: 8, maximum: 8, shared: true });
        h.worker.testAuthority.replaceProcessRegistrationForLifecycleTest({ pid: h.pid, memory: successor, channelOffsets: [6 * 65536], pointerWidth: width });
        const next = new DataView(successor.buffer, 6 * 65536);
        next.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
        next.setBigInt64(CH_RETURN, 85n, true);
        expect(() => h.worker.wakeProcessWorkersForExecRetirement(h.pid, h.memory)).toThrow('generation changed');
        h.queueAndDrain();
        expect(next.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_PENDING);
        expect(next.getBigInt64(CH_RETURN, true)).toBe(85n);
    });
}
for (const width of [4, 8] as const) {
    it(`preserves an authoritative exit handshake against an independently completed old park (width${width})`, () => {
        const h = harness(width);
        h.arm();
        // Exercise a real host completion without manually assigning a generation.
        // The queued-result fixture is deliberately retained across the later Rust
        // exit commit: kernel queue cleanup cannot revoke an already detached wire.
        // This judges the terminal publication invariant, not a browser race claim.
        h.worker.completeChannelRaw(h.channel, -1, 4);
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, park: 701, return: '-1' });
        h.request(ABI_SYSCALLS.Exit, [7n]);
        h.worker.handleSyscall(h.channel);
        expect(h.worker.hostReaped.has(h.pid)).toBe(true);
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, return: '0', errno: 0, cancelled: 0 });
        const publications = h.snapshot().publications;
        h.queueAndDrain();
        expect(h.snapshot()).toMatchObject({ status: CHANNEL_STATUS_COMPLETE, return: '0', errno: 0, park: null, cancelled: 0, dequeued: 0, publications });
        expect(h.fatal).not.toHaveBeenCalled();
        expect(h.errors).not.toHaveBeenCalled();
    });
}
