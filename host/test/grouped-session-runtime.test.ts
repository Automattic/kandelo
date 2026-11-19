import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { NodeKernelHost } from '../src/node-kernel-host';
import { resolveBinary } from '../src/binary-resolver';
import { KandeloImageFs } from '../../images/vfs/lib/kandelo-image-fs';
import { compileSdkFixture } from './support/compile-sdk-fixture';

// Exercise the public host option, not the separate internal-admission fixture.
it.each([
  ['readonly-file', true], ['shared-file', true], ['fork', true], ['pthread', true],
  ['fork', false], ['pthread', false],
  ['sigchld-wnohang', true], ['sigchld-wnohang', false],
] as const)('runs public trusted launch %s (compatible=%s)', async (name, compatible) => {
  const fixture = compileSdkFixture(new URL(`./fixtures/grouped-sdk-${name}.c`, import.meta.url), [], { forkInstrument: true });
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
    const rootfsImage = await image.saveImage(); image.reset();
    let stdout = '', stderr = '';
    const diagnostics: unknown[] = [];
    host = new NodeKernelHost({ maxPages: 2048, kernelMaxPages: 1024, rootfsImage,
      experimentalMemoryGroup: { maximumPages: 2048, maximumProcesses: 8, maximumTasks: 16 },
      onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
      onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
      onHostDiagnostic: event => diagnostics.push(event),
    });
    await host.init(Uint8Array.from(readFileSync(resolveBinary('kernel.wasm'))).buffer);
    const status = await host.spawn(Uint8Array.from(readFileSync(path)).buffer,
      [`grouped-sdk-${name}`, compatible ? 'grouped' : 'ordinary'], { env: ['PATH=/bin'], stdin: new Uint8Array() });
    expect({ status, stderr, diagnostics }).toEqual({ status: 0, stderr: '', diagnostics: [] });
    expect(stdout).toContain(`grouped-sdk-${name} PASS`);
    await host.destroy(); host = undefined;
  } finally { await host?.destroy(); fixture.cleanup(); }
}, 90_000);
