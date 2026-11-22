import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { NodeKernelHost } from '../src/node-kernel-host';
import { resolveBinary } from '../src/binary-resolver';
import { KandeloImageFs } from '../../images/vfs/lib/kandelo-image-fs';
import { compileSdkFixture } from './support/compile-sdk-fixture';
import { sharedMemoryProgramPath } from '../src/shared-memory-program';
import { ensureDirRecursive } from '../../images/vfs/scripts/vfs-image-helpers';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it.each(['identity', 'exec'] as const)('runs ordinary and grouped %s from one unchanged image', async kind => {
  const fixture = compileSdkFixture(new URL(kind === 'identity' ? './fixtures/grouped-sdk-executable-identity.c' : './fixtures/grouped-sdk-exec-handoff.c', import.meta.url), [], { forkInstrument: true });
  let host: NodeKernelHost | undefined;
  try {
    const groupedPath = fixture.programPath + '.grouped';
    execFileSync(fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url)), [fixture.programPath, '-o', groupedPath], { stdio: 'pipe' });
    const ordinary = new Uint8Array(readFileSync(fixture.programPath));
    const grouped = new Uint8Array(readFileSync(groupedPath));
    const fs = KandeloImageFs.create();
    for (const path of ['/tmp', '/bin']) fs.mkdir(path, 0o755);
    fs.writeFile('/bin/probe', ordinary, 0o755);
    if (kind === 'exec') fs.link('/bin/probe', '/bin/grouped-exec-target');
    const variantPath = sharedMemoryProgramPath(digest(ordinary));
    ensureDirRecursive(fs, variantPath.slice(0, variantPath.lastIndexOf('/')));
    fs.writeFile(variantPath, grouped, 0o755);
    const rootfsImage = await fs.saveImage(); fs.reset();
    let stdout = '', stderr = '';
    const diagnostics: unknown[] = [];
    host = new NodeKernelHost({ rootfsImage, maxPages: 2048, kernelMaxPages: 1024,
      experimentalMemoryGroup: { maximumPages: 2048 },
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event),
    });
    await host.init(Uint8Array.from(readFileSync(resolveBinary('kernel.wasm'))).buffer);
    await expect(host.spawn(Uint8Array.from(ordinary).buffer, ['probe'], { executionBackend: 'memory-group' })).rejects.toThrow('requested execution backend');
    await expect(host.spawnFromVfs(variantPath, ['probe'], { executionBackend: 'ordinary' })).rejects.toThrow('requested execution backend');
    for (const executionBackend of ['ordinary', 'memory-group', 'ordinary'] as const) {
      stdout = ''; stderr = '';
      const launched = await host.spawnFromVfs('/bin/probe', kind === 'identity' ? ['/bin/probe', '/bin/probe'] : ['/bin/probe', 'start', 'fixture'], { executionBackend, env: ['PATH=/bin'] });
      expect(await launched.exit, `${executionBackend}: ${stderr}`).toBe(0);
      if (kind === 'identity') expect(stdout.match(/grouped-sdk-executable-identity PASS/g)).toHaveLength(2);
      else expect(stdout).toContain('grouped-sdk-exec-handoff PASS 16');
      expect(stderr).toBe('');
      const usage = await host.getMemoryGroupUsage();
      expect(usage?.admission.tasks ?? 0).toBe(0);
      if (executionBackend === "memory-group") expect(usage?.backing?.quarantinedReplicas).toBe(0);
    }
    expect(diagnostics).toEqual([]);
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 120_000);
