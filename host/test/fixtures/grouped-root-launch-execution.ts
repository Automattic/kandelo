// Run only in a disposable dedicated kernel Worker. Results are owned scalars
// and copied diagnostics, never a guest Memory or a view into its backing.
import { CentralizedKernelWorker, CAPTURED_STDIO } from '../../src/kernel-worker';
import { GroupedSessionRuntime } from '../../src/grouped-session-runtime';
import { retryKernelEntryResult as retry } from '../../src/kernel-entry-retry';
import type { WorkerAdapter } from '../../src/worker-adapter';
import type { PlatformIO } from '../../src/types';
import { ERRNO } from '../../src/generated/abi';
export async function execute(options: {
    kernelBytes: ArrayBuffer;
    imageBytes: Uint8Array;
    io: PlatformIO;
    adapter: WorkerAdapter;
    joins: boolean;
    stage: string;
}) {
    let session!: GroupedSessionRuntime, rootPid: number | undefined, exitResolve!: (code: number) => void;
    let stdout = '', stderr = '', constructionAttempts = 0, fatal: string | undefined, destruction: Promise<void> | undefined;
    let fatalResolve!: () => void;
    const fatalReported = new Promise<void>(resolve => { fatalResolve = resolve; });
    const diagnostics: string[] = [], rollbacks: unknown[] = [];
    let fatalLedger: unknown;
    const kernel = new CentralizedKernelWorker({ maxWorkers: 16, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 }, options.io, {
        onExit: (pid, code) => { session.exit(pid, code); }, onGroupedFork: r => session.fork(r), onGroupedClone: r => session.clone(r), onGroupedExec: r => session.exec(r), onThreadExit: (pid, tid) => session.threadExit(pid, tid), onKernelFatal: e => { fatal = e.message; fatalResolve(); }, onHostDiagnostic: e => diagnostics.push(JSON.stringify(e)),
    });
    const image = options.imageBytes;
    kernel.configureRootfsOverlay(() => -2, [], false, image.byteLength, (offset, destination) => { const n = Math.min(destination.length, Math.max(0, image.length - offset)); destination.set(image.subarray(offset, offset + n)); return n; });
    await kernel.init(options.kernelBytes);
    kernel.setOutputCallbacks({ onStdout: b => stdout += new TextDecoder().decode(b), onStderr: b => stderr += new TextDecoder().decode(b) });
    const adapter: WorkerAdapter = { createWorker: data => { constructionAttempts++; if (['constructor', 'stopped-constructor'].includes(options.stage))
            throw Error('fixture uncertain root constructor'); return options.adapter.createWorker(data); } };
    const originalRegister = kernel.registerMemoryGroupProcess.bind(kernel);
    let injected = 0, inject = true;
    const originalContain = kernel.containMemoryGroupLaunchFailure.bind(kernel);
    // Production KernelWorker methods are sealed. A fixture-only bound facade
    // injects setup refusal without replacing any real method or kernel authority.
    const facade = new Proxy(kernel, { get(target, key) {
            if (key === 'runMemoryGroupRootLaunch')
                return (handle: Parameters<CentralizedKernelWorker['runMemoryGroupRootLaunch']>[0], platform: Parameters<CentralizedKernelWorker['runMemoryGroupRootLaunch']>[1]) =>
                    target.runMemoryGroupRootLaunch(handle, { ...platform,
                        waitReady: async () => { await platform.waitReady(); if (options.stage === 'readiness') throw Error('fixture root readiness effect'); },
                        deliverLaunch: () => { if (options.stage === 'launch-message') throw Error('fixture root launch delivery'); platform.deliverLaunch(); },
                    });
            if (key === 'registerMemoryGroupProcess')
                return (...args: Parameters<CentralizedKernelWorker['registerMemoryGroupProcess']>) => {
                    if (inject && options.stage === 'registration-before') {
                        injected++;
                        throw Error('fixture root registration before');
                    }
                    originalRegister(...args);
                    if (inject && options.stage === 'registration-after') {
                        injected++;
                        throw Error('fixture root registration after');
                    }
                    if (inject && options.stage === 'destroy-in-registration') {
                        inject = false;
                        destruction = session.destroy();
                    }
                };
            if (key === 'containMemoryGroupLaunchFailure')
                return (cause: unknown) => {
                    try {
                        const usage = kernel.inspectMemoryGroupUsage(group);
                        if (typeof usage === 'number') throw Error(`Inspection refused: errno ${-usage}`);
                        fatalLedger = { kernel: usage.admission, backing: usage.backing };
                    }
                    catch (error) {
                        fatalLedger = { inspectionFailure: String(error) };
                    }
                    return originalContain(cause);
                };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    session = new GroupedSessionRuntime(facade, adapter, { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 }, options.joins, (pid, code) => { if (pid === rootPid)
        exitResolve?.(code); }, (_pid, error) => diagnostics.push(error.message));
    const group = await session.initialPathGroup();
    const backing = async () => {
        for (;;) {
            const usage = await retry(() => kernel.inspectMemoryGroupUsage(group));
            if (typeof usage !== 'number') return usage.backing ?? undefined;
            if (usage !== -ERRNO.EAGAIN) throw Error(`Inspection refused: errno ${-usage}`);
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    };
    const launch = async () => {
        const pid = await retry(() => kernel.createProcess(CAPTURED_STDIO));
        rootPid = pid;
        await retry(() => kernel.installHostStdinPipe(pid));
        kernel.setStdinData(pid, new Uint8Array());
        const result = await kernel.launchInitialPath(pid, '/bin/fork-grouped', ['fork', 'grouped'], [], async (request) => ({ onCommitFailure: () => { }, startAfterCommit: async () => {
                const secureExec = kernel.takeCommittedExecSecureExec(pid);
                if (['stopped-destroy', 'stopped-constructor'].includes(options.stage))
                    await retry(() => kernel.signalProcess(pid, 19));
                await session.launch(pid, request.targetBytes, request.targetModule, request.argv, request.envp, 2048, 8, secureExec, true);
                return 0;
            } }), group);
        if (result !== 0)
            throw Error('path commit ' + result);
        return pid;
    };
    let failure: string | undefined, code: number | undefined;
    if (options.stage.startsWith('registration-')) {
        for (let attempt = 0; attempt < 16; attempt++) {
            try {
                await launch();
                throw Error('registration unexpectedly succeeded');
            }
            catch (error) {
                if (!String(error).includes('fixture root registration'))
                    throw error;
            }
            await retry(() => kernel.removeProcessFromKernelTable(rootPid!));
            rollbacks.push({ kernel: await retry(() => kernel.inspectMemoryGroup(group)), backing: await backing(), receipt: await retry(() => kernel.readMemoryGroupTaskReceipt(rootPid!, rootPid!)) });
        }
        inject = false;
        const exited = new Promise<number>(resolve => { exitResolve = resolve; });
        await launch();
        code = await exited;
        await session.destroy();
    }
    else if (options.stage === 'stopped-constructor') {
        await launch();
        await retry(() => kernel.signalProcess(rootPid!, 18));
        await fatalReported;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    else if (['constructor', 'readiness', 'launch-message'].includes(options.stage)) {
        try {
            await launch();
        }
        catch (error) {
            failure = String(error);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    else {
        const exited = new Promise<number>(resolve => { exitResolve = resolve; });
        await launch();
        await (destruction ?? session.destroy());
        code = await exited;
    }
    let inspectionRefusal: string | undefined;
    if (fatal) {
        try { kernel.inspectMemoryGroupUsage(group); }
        catch (error) { inspectionRefusal = String(error); }
    }
    const result = { stage: options.stage, constructionAttempts, injected, failure, fatal, fatalLedger,
        fatalLedgerObserved: fatalLedger ? 'before-fatal-latch' : undefined, inspectionRefusal,
        code, stdout, stderr, diagnostics, rollbacks, kernel: fatal ? undefined : await retry(() => kernel.inspectMemoryGroup(group)),
        backing: fatal ? undefined : await backing(),
        rootReceipt: fatal ? undefined : await retry(() => kernel.readMemoryGroupTaskReceipt(rootPid!, rootPid!)) };
    if (!fatal)
        kernel.stopPolling();
    return result;
}
