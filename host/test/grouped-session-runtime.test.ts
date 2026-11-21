import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { NodeKernelHost } from '../src/node-kernel-host';
import { resolveBinary } from '../src/binary-resolver';
import { KandeloImageFs } from '../../images/vfs/lib/kandelo-image-fs';
import { compileSdkFixture } from './support/compile-sdk-fixture';

// Exercise the public host option, not the separate internal-admission fixture.
const publicLaunchCases = [
  ['readonly-file', true], ['shared-file', true], ['fork', true], ['pthread', true],
  ['dri-mapping-fork', true], ['dri-mapping-fork', false], ['dri-direct', true],
  ['fork', false], ['pthread', false],
  ['sigchld-wnohang', true], ['sigchld-wnohang', false],
  ['admission', true], ['admission', false],
] as const;
it.each([
  ...publicLaunchCases.flatMap(([name, compatible]) =>
    (['bytes', 'vfs'] as const).map(mode => [mode, name, compatible] as const)),
  ['vfs', 'executable-identity', true], ['vfs', 'executable-identity', false],
] as const)('runs public trusted %s launch %s (compatible=%s)', async (mode, name, compatible) => {
  const fixture = compileSdkFixture(new URL(`./fixtures/${name === 'dri-mapping-fork' ? 'dri-mapping-fork.c' : `grouped-sdk-${name}.c`}`, import.meta.url), [], { forkInstrument: true });
  let host: NodeKernelHost | undefined;
  try {
    let path = fixture.programPath;
    if (compatible) {
      path += '.grouped.wasm';
      execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
        [fixture.programPath, '-o', path], { stdio: 'pipe' });
    }
    const image = KandeloImageFs.create();
    image.mkdir('/tmp', 0o1777);
    image.mkdir('/bin', 0o755);
    image.writeFile('/bin/probe', new Uint8Array(readFileSync(path)), 0o755);
    const rootfsImage = await image.saveImage(); image.reset();
    let stdout = '', stderr = '';
    const diagnostics: unknown[] = [];
    host = new NodeKernelHost({ maxPages: 2048, kernelMaxPages: 1024, rootfsImage,
      // The held child cohort needs more than 128 MiB; use the normal preview's
      // 512 MiB budget so this checks count admission rather than backing OOM.
      experimentalMemoryGroup: name === 'admission' ? { maximumPages: 8192 }
        : { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 },
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event),
    });
    await host.init(Uint8Array.from(readFileSync(resolveBinary('kernel.wasm'))).buffer);
    let rootPid: number | undefined;
    const argv = [`grouped-sdk-${name}`, name === 'executable-identity' ? '/bin/probe' : compatible ? 'grouped' : 'ordinary'];
    const status = mode === 'vfs'
      ? await (async () => {
          const child = await host!.spawnFromVfs('/bin/probe', argv, { env: ['PATH=/bin'], stdin: new Uint8Array() });
          rootPid = child.pid;
          return child.exit;
        })()
      : await host.spawn(Uint8Array.from(readFileSync(path)).buffer, argv, {
          env: ['PATH=/bin'], stdin: new Uint8Array(), onStarted: pid => { rootPid = pid; },
        });
    expect({ status, stderr, diagnostics }).toEqual({ status: 0, stderr: '', diagnostics: [] });
    expect(stdout).toContain(name === 'dri-mapping-fork'
      ? 'OK fixed PRIME replacement preserves alias storage across fork' : `grouped-sdk-${name} PASS`);
    if (compatible) {
      expect(rootPid).toBeDefined();
      // enumProcs intentionally hides zombies and cannot prove reclamation.
      expect(await host.readFileFromVfs(`/proc/${rootPid}/stat`)).toBeNull();
    }
    await host.destroy(); host = undefined;
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 90_000);

it('reclaims repeated grouped host roots while preserving their child waits', async () => {
  const fixture = compileSdkFixture(new URL('./fixtures/grouped-sdk-fork.c', import.meta.url), [], { forkInstrument: true });
  let host: NodeKernelHost | undefined;
  try {
    const path = fixture.programPath + '.grouped.wasm';
    execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
      [fixture.programPath, '-o', path], { stdio: 'pipe' });
    const image = KandeloImageFs.create(); image.mkdir('/tmp', 0o1777);
    const rootfsImage = await image.saveImage(); image.reset();
    const diagnostics: unknown[] = []; let stderr = '';
    host = new NodeKernelHost({ rootfsImage, maxPages: 2048, kernelMaxPages: 1024,
      experimentalMemoryGroup: { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event),
    });
    await host.init();
    const bytes = readFileSync(path), tail: number[] = [];
    for (let cycle = 0; cycle < 24; cycle++) {
      let rootPid: number | undefined;
      expect(await host.spawn(Uint8Array.from(bytes).buffer, ['grouped-sdk-fork', 'grouped'], {
        stdin: new Uint8Array(), onStarted: pid => { rootPid = pid; },
      })).toBe(0); // The C fixture verifies its child's exact wait status 23.
      expect(rootPid).toBeDefined();
      expect(await host.readFileFromVfs(`/proc/${rootPid}/stat`)).toBeNull();
      const report = await host.readFileFromVfs('/proc/kandelo/fs_memory');
      expect(report).not.toBeNull();
      const io = /^io live=(\d+) /m.exec(new TextDecoder().decode(report!));
      expect(io).not.toBeNull();
      if (cycle >= 4) tail.push(Number(io![1]));
    }
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(4096);
    expect({ stderr, diagnostics }).toEqual({ stderr: '', diagnostics: [] });
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 90_000);

it('rolls back repeated initial grouped image allocation refusals before a Worker exists', async () => {
  const fixture = compileSdkFixture(new URL('./fixtures/grouped-sdk-fork.c', import.meta.url), [], { forkInstrument: true });
  let host: NodeKernelHost | undefined;
  try {
    const grouped = fixture.programPath + '.grouped.wasm';
    execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
      [fixture.programPath, '-o', grouped], { stdio: 'pipe' });
    const image = KandeloImageFs.create();
    image.mkdir('/tmp', 0o1777); image.mkdir('/bin', 0o755);
    image.writeFile('/bin/grouped', new Uint8Array(readFileSync(grouped)), 0o755);
    image.writeFile('/bin/ordinary', new Uint8Array(readFileSync(fixture.programPath)), 0o755);
    const rootfsImage = await image.saveImage(); image.reset();
    let stdout = '', stderr = '';
    const diagnostics: unknown[] = [];
    host = new NodeKernelHost({ rootfsImage, maxPages: 2048, kernelMaxPages: 1024,
      experimentalMemoryGroup: { maximumPages: 2, maximumProcesses: 1, maximumTasks: 1 },
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event),
    });
    await host.init();
    for (let attempt = 0; attempt < 16; attempt++) {
      await expect(host.spawnFromVfs('/bin/grouped', ['grouped', 'grouped'], { stdin: new Uint8Array() }))
        .rejects.toThrow(/Grouped root image: errno 12/);
      expect((await host.enumProcs()).filter(process => process.pid !== 1)).toEqual([]);
    }
    const child = await host.spawnFromVfs('/bin/ordinary', ['ordinary', 'ordinary'], { stdin: new Uint8Array() });
    expect(await child.exit).toBe(0);
    expect(stdout).toContain('grouped-sdk-fork PASS');
    expect({ stderr, diagnostics }).toEqual({ stderr: '', diagnostics: [] });
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 90000);


it('records the ordinary direct-DRM-alias negative control without claiming coherent aliases', async () => {
  const fixture = compileSdkFixture(new URL('./fixtures/grouped-sdk-dri-direct.c', import.meta.url), [], {forkInstrument: true});
  let host: NodeKernelHost | undefined;
  try {
    const fs = KandeloImageFs.create(); const image = await fs.saveImage(); fs.reset();
    let stderr = ''; const diagnostics: unknown[] = [];
    host = new NodeKernelHost({rootfsImage: image, kernelMaxPages: 1024, maxPages: 2048,
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event)});
    await host.init(Uint8Array.from(readFileSync(resolveBinary('kernel.wasm'))).buffer);
    expect(await host.spawn(Uint8Array.from(readFileSync(fixture.programPath)).buffer, ['dri-direct'],
      {env: ['PATH=/bin'], stdin: new Uint8Array()})).toBe(23);
    expect(stderr).toBe('DIRECT-ALIAS-UNAVAILABLE\n');
    expect(diagnostics).toEqual([]);
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 90_000);

it('inspects independent group counters without allocation or double-counting shared aliases', async () => {
  const fixture = compileSdkFixture(new URL('./fixtures/grouped-sdk-inspection.c', import.meta.url), [], { forkInstrument: true });
  let host: NodeKernelHost | undefined;
  try {
    const grouped = fixture.programPath + '.grouped.wasm';
    execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
      [fixture.programPath, '-o', grouped], { stdio: 'pipe' });
    const image = KandeloImageFs.create(); image.mkdir('/tmp', 0o1777); image.mkdir('/bin', 0o755);
    image.writeFile('/bin/inspection', new Uint8Array(readFileSync(grouped)), 0o755);
    const rootfsImage = await image.saveImage(); image.reset();
    let stdout = '', stderr = ''; const diagnostics: unknown[] = [];
    host = new NodeKernelHost({ rootfsImage, kernelMaxPages: 1024, maxPages: 2048,
      experimentalMemoryGroup: { maximumPages: 2048, maximumProcesses: 4, maximumTasks: 8 },
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event) });
    await host.init();
    for (let read = 0; read < 3; read++) expect(await host.getMemoryGroupUsage()).toBeNull();
    const child = await host.spawnFromVfs('/bin/inspection', ['inspection'], { onStarted: () => {} });
    await expect.poll(() => stdout, { timeout: 30_000 }).toContain('inspection-ready');
    const live = await host.getMemoryGroupUsage();
    expect(live?.admission).toMatchObject({ maximumPages: 2048, maximumProcesses: 4, maximumTasks: 8,
      processes: 1, tasks: 1, images: 1, quarantinedTasks: 0 });
    expect(live?.backing).toMatchObject({ images: 1, replicas: 1, sharedObjects: 1, sharedPages: 2, sharedImageReferences: 1 });
    expect(await host.getMemoryGroupUsage()).toEqual(live);
    expect(Object.isFrozen(live) && Object.isFrozen(live!.admission)).toBe(true);
    host.appendStdinData(child.pid, new TextEncoder().encode('x'));
    expect(await child.exit, stderr).toBe(0);
    const retired = await host.getMemoryGroupUsage();
    expect(retired?.admission).toMatchObject({ group: live!.admission.group, processes: 0, tasks: 0, images: 0 });
    expect(retired?.backing).toMatchObject({ images: 0, replicas: 0, allocatedPages: 1, sharedObjects: 0, sharedPages: 0, nativeObservers: 0 });
    expect(stdout).toContain('grouped-sdk-inspection PASS');
    expect({ stderr, diagnostics }).toEqual({ stderr: '', diagnostics: [] });
    expect(await host.readFileFromVfs(`/proc/${child.pid}/stat`)).toBeNull();
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 90_000);
