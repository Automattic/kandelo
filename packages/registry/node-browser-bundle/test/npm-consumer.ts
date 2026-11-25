// Shared execution assertions promoted from the qualified npm consumer runner.
// No automatic retries. Invocation limits include descendant retirement.
import type { NodeKernelHost } from '../../../../host/src/node-kernel-host';
type Host = Pick<NodeKernelHost, 'init' | 'spawnFromVfs' | 'subscribeDestroyProgress' | 'destroy' | 'enumProcs' | 'readDirFromVfs' | 'readFileFromVfs'>;
type Options = ConstructorParameters<typeof NodeKernelHost>[0];
export async function runNpmCases(image: Uint8Array, kernel: Uint8Array, inventory: any, createHost: (options: Options) => Host, checkpoint: (receipt: any) => void = () => { }, readinessStartedAt?: number) {
    const receipt: any = { startedAt: new Date().toISOString(), limitsMs: inventory.limitsMs,
        automaticRetries: 0, cases: [], generations: [], diagnostics: [], processEvents: [], destroyProgress: [] };
    const persist = () => checkpoint(receipt);
    async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        try {
            return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} exceeded ${ms}ms; nonpassing; no retry`)), ms); })]);
        }
        finally {
            clearTimeout(timer!);
        }
    }
    let host: Host | undefined;
    const outputByPid = new Map<number, {
        stdout: string;
        stderr: string;
    }>();
    const outputEvents: Array<{
        pid: number;
        channel: string;
        bytes: Uint8Array;
    }> = [];
    function stream(pid: number, channel: 'stdout' | 'stderr', bytes: Uint8Array) {
        let row = outputByPid.get(pid);
        if (!row) {
            row = { stdout: '', stderr: '' };
            outputByPid.set(pid, row);
        }
        outputEvents.push({ pid, channel, bytes: Uint8Array.from(bytes) });
        row[channel] += new TextDecoder().decode(bytes);
    }
    function familyOutput(rootPid: number, outputOffset: number, eventOffset: number) {
        const pids = new Set<number>([rootPid]);
        const processEvents = receipt.processEvents.slice(eventOffset);
        let changed = true;
        while (changed) {
            changed = false;
            for (const event of processEvents) {
                if (typeof event.ppid === 'number' && pids.has(event.ppid) && !pids.has(event.pid)) {
                    pids.add(event.pid);
                    changed = true;
                }
            }
        }
        const events = outputEvents.slice(outputOffset);
        const selected = events.filter(event => pids.has(event.pid));
        const result: any = { outputFamily: {
                pids: [...pids].sort((a, b) => a - b),
                events: events.map(event => ({ pid: event.pid, channel: event.channel,
                    utf8: new TextDecoder().decode(event.bytes) })),
                unownedOutput: events.filter(event => !pids.has(event.pid)).map(event => event.pid),
            } };
        for (const channel of ['stdout', 'stderr']) {
            const chunks = selected.filter(event => event.channel === channel).map(event => event.bytes);
            const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            result[channel] = new TextDecoder().decode(bytes);
        }
        return result;
    }
    const waiters = new Map<string, (event: any) => void>();
    function retired(pid: number, executionId?: number): Promise<any> {
        executionId ??= [...receipt.generations].reverse().find((event: any) => event.kind === 'admitted' && event.pid === pid)?.executionId;
        assert(executionId !== undefined, 'No admitted generation for exited process');
        const found = receipt.generations.find((event: any) => event.kind === 'retired' && event.pid === pid && event.executionId === executionId);
        return found ? Promise.resolve(found) : new Promise(resolve => waiters.set(`${pid}:${executionId}`, resolve));
    }
    function assert(condition: unknown, message: string) {
        if (!condition)
            throw Error(message);
    }
    try {
        const readinessStart = readinessStartedAt ?? performance.now();
        host = createHost({ rootfsImage: image,
            onStdout: (pid, bytes) => stream(pid, 'stdout', bytes), onStderr: (pid, bytes) => stream(pid, 'stderr', bytes),
            onPtyOutput: (pid, bytes) => stream(pid, 'stdout', bytes),
            onHostDiagnostic: event => { receipt.diagnostics.push(event); persist(); },
            onProcessEvent: event => { receipt.processEvents.push(event); persist(); },
            onProcessGenerationEvent: event => {
                receipt.generations.push(event);
                if (event.kind === 'retired') {
                    const key = `${event.pid}:${event.executionId}`;
                    waiters.get(key)?.(event);
                    waiters.delete(key);
                }
                persist();
            },
        });
        host.subscribeDestroyProgress(event => { receipt.destroyProgress.push(event); persist(); });
        await bounded(host.init(kernel.buffer.slice(kernel.byteOffset, kernel.byteOffset + kernel.byteLength) as ArrayBuffer), Math.max(0, inventory.limitsMs.readiness - (performance.now() - readinessStart)), 'readiness');
        // /tmp is a real scratch mount and hides image /tmp entries. Create fixtures
        // through an attributed ordinary guest invocation after that mount is live.
        await bounded((async () => {
            const files = inventory.fixtureFiles;
            const setupCode = 'const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");assert.ok(fs.lstatSync("/usr/bin/spidermonkey-node").isFile());assert.ok(fs.lstatSync("/usr/bin/node").isSymbolicLink());assert.equal(fs.readlinkSync("/usr/bin/node"),"spidermonkey-node");assert.equal(fs.realpathSync("/usr/bin/node"),"/usr/bin/spidermonkey-node");for(const item of ' + JSON.stringify(files) + '){fs.mkdirSync(path.dirname(item.path),{recursive:true});fs.writeFileSync(item.path,item.utf8,{mode:item.mode});fs.chmodSync(item.path,item.mode);}';
            const argv = ['spidermonkey-node', '--eval', setupCode];
            const child = await host!.spawnFromVfs('/usr/bin/spidermonkey-node', argv, { env: ['HOME=/root', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'TZ=UTC'], cwd: '/', uid: 0, gid: 0, stdin: new Uint8Array() });
            const status = await child.exit, retirement = await retired(child.pid);
            receipt.fixtureSetup = { argv, pid: child.pid, status, retirement, ...outputByPid.get(child.pid), countedAsCliVariant: false };
            assert(status === 0 && retirement.leaseDisposition === 'quiescent' && retirement.mainFence === 'acknowledged' && retirement.acknowledgedThreads === retirement.threads, 'Fixture setup failed');
        })(), Math.min(inventory.limitsMs.invocationIncludingRetirement, inventory.limitsMs.readiness - (performance.now() - readinessStart)), 'fixture readiness');
        const gateStart = performance.now();
        for (const row of inventory.cases) {
            if (performance.now() - gateStart >= inventory.limitsMs.hostGate)
                throw Error('Host/gate deadline reached; remaining cases unrun/nonpassing');
            const actualArgv = [row.argv[0], ...inventory.profiles.candidateBaseFlags, ...row.argv.slice(1)];
            const current: any = { id: row.id, argv: actualArgv, startedAt: new Date().toISOString(), passed: false };
            receipt.cases.push(current);
            persist();
            const invocationStart = performance.now(), generationOffset = receipt.generations.length, outputOffset = outputEvents.length, processEventOffset = receipt.processEvents.length;
            let timedOut = false;
            try {
                await bounded((async () => {
                    if (row.requiresNoDiagnosticReport) {
                        const entries = await host!.readDirFromVfs(row.cwd);
                        assert(entries, 'Report-check directory missing before invocation');
                        current.reportDirectoryBefore = entries!.map((entry: any) => entry.name).sort();
                    }
                    const env: Record<string, string> = { NODE_GATE_EXPECT_UID: String(row.uid), NODE_GATE_EXPECT_GID: String(row.gid), NODE_GATE_FILE_OWNER: '0', HOME: '/root', PATH: '/usr/bin:/bin', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
                        NODE_CLI_DEFAULT_CONFIG: '/etc/ssl/openssl.cnf', ...row.environmentOverrides };
                    for (const name of row.unsetEnvironment ?? [])
                        delete env[name];
                    if (row.metadataEnvironment)
                        env[row.metadataEnvironment] = JSON.stringify({ execPath: '/usr/bin/node', execArgv: actualArgv.slice(1, actualArgv.indexOf('--')), uid: row.uid, gid: row.gid, cwd: row.cwd });
                    current.env = env;
                    current.uid = row.uid;
                    current.gid = row.gid;
                    current.cwd = row.cwd;
                    const child = await host!.spawnFromVfs(row.guestPath ?? '/usr/bin/node', actualArgv, { env: Object.entries(env).map(([k, v]) => `${k}=${v}`), cwd: row.cwd,
                        uid: row.uid, gid: row.gid, stdin: row.pty ? undefined : new TextEncoder().encode(row.stdinUtf8),
                        pty: row.pty, ptyCols: row.ptyCols, ptyRows: row.ptyRows });
                    current.pid = child.pid;
                    current.exitStatus = await child.exit;
                    current.retirement = await retired(child.pid);
                    // Child-process variants await their children. Verify every observed descendant too.
                    const admitted = receipt.generations.slice(generationOffset).filter((event: any) => event.kind === 'admitted');
                    current.retirements = await Promise.all(admitted.map((event: any) => retired(event.pid, event.executionId)));
                    current.processesAfterExit = await host!.enumProcs();
                    Object.assign(current, familyOutput(child.pid, outputOffset, processEventOffset));
                    assert(current.outputFamily.unownedOutput.length === 0, "Unattributed process output during owned invocation");
                    for (const event of current.retirements) {
                        assert(event.leaseDisposition === 'quiescent' && !event.postCommitFailed && event.mainFence === 'acknowledged', 'Missing main retirement fence');
                        assert(event.threadFences === 'acknowledged' || event.threads === 0, 'Missing thread retirement fence');
                        assert(event.acknowledgedThreads === event.threads, 'Unacknowledged threads');
                    }
                    assert(current.processesAfterExit.length === 1 && current.processesAfterExit[0].pid === 1, 'Guest descendants remain after invocation');
                    assert(row.expected.status === 'nonzero' ? current.exitStatus !== 0 : current.exitStatus === row.expected.status, 'Unexpected status');
                    for (const channel of ['stdout', 'stderr']) {
                        if (typeof row.expected[channel] === 'string')
                            assert(current[channel] === row.expected[channel], `Unexpected ${channel} bytes`);
                        for (const fragment of row[channel + 'Includes'] ?? [])
                            assert(current[channel].includes(fragment), `Missing ${channel} fragment ${fragment}`);
                        for (const fragment of row[channel + 'Excludes'] ?? [])
                            assert(!current[channel].includes(fragment), `Forbidden ${channel} fragment ${fragment}`);
                    }
                    if (row.requiredGuestFile) {
                        const bytes = await host!.readFileFromVfs(row.requiredGuestFile.path);
                        current.requiredGuestFile = { path: row.requiredGuestFile.path, actualUtf8: bytes ? new TextDecoder().decode(bytes) : null };
                        assert(current.requiredGuestFile.actualUtf8 === row.requiredGuestFile.bytesUtf8, 'Guest file bytes do not match the required effect');
                    }
                    if (row.observedGuestEnvironmentFile) {
                        const bytes = await host!.readFileFromVfs(row.observedGuestEnvironmentFile);
                        assert(bytes, 'Actual guest environment receipt missing');
                        const actual = JSON.parse(new TextDecoder().decode(bytes!));
                        current.effectiveGuestEnvironment = actual;
                        for (const [name, value] of Object.entries(current.env))
                            assert(actual[name] === value, `Effective environment differs: ${name}`);
                        for (const name of row.absentGuestEnvironmentVariables ?? [])
                            assert(actual[name] === undefined, `Ambient environment leaked: ${name}`);
                    }
                    if (row.requiresNoDiagnosticReport) {
                        const entries = await host!.readDirFromVfs(row.cwd);
                        assert(entries, 'Report-check directory missing after invocation');
                        current.reportDirectoryAfter = entries!.map((entry: any) => entry.name).sort();
                        assert(JSON.stringify(current.reportDirectoryAfter) === JSON.stringify(current.reportDirectoryBefore), 'Ordinary error created an unexpected report/file');
                    }
                    current.passed = true;
                })(), Math.min(inventory.limitsMs.invocationIncludingRetirement, inventory.limitsMs.hostGate - (performance.now() - gateStart)), 'invocation including retirement');
            }
            catch (error) {
                current.error = String(error);
                timedOut = String(error).includes('exceeded');
            }
            finally {
                current.invocationMs = performance.now() - invocationStart;
                current.finishedAt = new Date().toISOString();
                if (current.pid && !current.outputFamily)
                    Object.assign(current, familyOutput(current.pid, outputOffset, processEventOffset));
                persist();
            }
            if (timedOut)
                throw Error('Timed-out process requires session containment; remaining rows unrun/nonpassing');
        }
        receipt.gateMs = performance.now() - gateStart;
    }
    catch (error) {
        receipt.error = error instanceof Error ? error.stack : String(error);
    }
    finally {
        if (host)
            try {
                await bounded(host.destroy(), inventory.limitsMs.sessionRetirement, 'session retirement');
                receipt.sessionDestroyed = true;
            }
            catch (error) {
                receipt.destroyError = String(error);
            }
        receipt.unrun = inventory.cases.filter((row: any) => !receipt.cases.some((result: any) => result.id === row.id)).map((row: any) => row.id);
        receipt.passed = !receipt.error && !receipt.destroyError && receipt.sessionDestroyed && !receipt.diagnostics.length && !receipt.unrun.length && receipt.cases.every((row: any) => row.passed);
        receipt.finishedAt = new Date().toISOString();
        persist();
    }
    return receipt;
}
