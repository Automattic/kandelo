import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { NodeKernelHost } from '../src/node-kernel-host';
import { resolveBinary } from '../src/binary-resolver';
import { readWasmCustomSectionPayload } from '../src/constants';
import * as G from '../src/generated/program-extensions';
import { parseKandeloDemoConfig } from '../../web-libs/kandelo-session/src/demo-config';
import { sharedDesktopPackagePrograms } from '../../images/vfs/scripts/shared-desktop-package-contract';

// This is a prepared-product check: absent canonical output must fail. It
// proves real VFS/SDK shell startup; rendered desktop behavior belongs to the
// normal browser gallery checks, not this non-graphical Node consumer.
it('shared-desktop-node-startup: runs ordinary and grouped commands from the canonical shell and reclaims their families', async () => {
  let stdout = '', stderr = '';
  const diagnostics: unknown[] = [];
  const host = new NodeKernelHost({
    rootfsImage: readFileSync(resolveBinary('programs/shell.vfs.zst')),
    experimentalMemoryGroup: { maximumPages: 8192, preparedPrograms: {
      catalogPath: '/usr/share/kandelo/shared-desktop/programs.json', artifactRoot: '/usr/libexec/kandelo/shared-desktop/',
    } },
    onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    onHostDiagnostic: event => diagnostics.push(event),
  });
  try {
    await host.init();
    const configBytes = await host.readFileFromVfs('/etc/kandelo/demo.json');
    expect(configBytes).not.toBeNull();
    const config = parseKandeloDemoConfig(new TextDecoder().decode(configBytes!));
    expect(config?.defaultProfile).toBe('shell');
    expect(Object.keys(config?.profiles ?? {})).toEqual(expect.arrayContaining(['cage', 'sway', 'sway-sfwbar']));

    const manifestBytes = await host.readFileFromVfs('/usr/share/kandelo/shared-desktop/programs.json');
    expect(manifestBytes).not.toBeNull();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!));
    expect(manifest.memoryGroup).toBe('trusted-v1');
    expect(manifest.programs.map((row: { id: string }) => row.id))
      .toEqual(sharedDesktopPackagePrograms.map(row => row.id));

    const bash = await host.readFileFromVfs('/bin/sh');
    expect(bash).not.toBeNull();
    expect(readWasmCustomSectionPayload(Uint8Array.from(bash!).buffer, G.MEMORY_GROUP_SECTION)).toBeNull();
    const record = manifest.programs.find((row: { id: string }) => row.id === 'bash');
    expect(createHash('sha256').update(bash!).digest('hex')).toBe(record.ordinarySha256);
    const variant = await host.readFileFromVfs('/usr/libexec/kandelo/shared-desktop/bash/program.wasm');
    expect(variant).not.toBeNull();
    const payload = readWasmCustomSectionPayload(Uint8Array.from(variant!).buffer, G.MEMORY_GROUP_SECTION)!;
    expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({ version: G.MEMORY_GROUP_VERSION,
      layout: G.MEMORY_GROUP_LAYOUT, sourceSha256: record.ordinarySha256 });
    expect(createHash('sha256').update(variant!).digest('hex')).toBe(record.groupedSha256);
    // Inspecting or reading a lazy program must not allocate an execution group.
    expect(await host.getMemoryGroupUsage()).toBeNull();

    for (const executionBackend of ['ordinary', 'memory-group'] as const) {
    stdout = ''; stderr = '';
    const child = await host.spawnFromVfs('/bin/sh', ['sh', '-c', [
      'for p in /usr/bin/cage /usr/bin/foot /usr/bin/sway /usr/bin/sfwbar /usr/bin/freeciv /usr/bin/scummvm-static; do',
      '  test -x "$p" || exit 17;',
      'done;',
      "printf 'shared-desktop-node-startup PASS\\n' > /tmp/desktop-startup-proof;",
      '/bin/ps -A -o pid,comm > /tmp/desktop-process-proof || exit 18;',
      '/bin/grep -q ps /tmp/desktop-process-proof || exit 19;',
      '/bin/cat /tmp/desktop-startup-proof',
    ].join('\n')], { executionBackend, uid: 1000, gid: 1000, cwd: '/home/maker',
      env: ['PATH=/usr/bin:/bin', 'HOME=/home/maker', 'USER=maker'], stdin: new Uint8Array() });
    expect(await child.exit, stderr).toBe(0);
    expect(stdout).toBe('shared-desktop-node-startup PASS\n');
    expect({ stderr, diagnostics }).toEqual({ stderr: '', diagnostics: [] });
    if (executionBackend === 'ordinary') {
      // Ordinary exit promises publish the guest status before asynchronous
      // Worker retirement and host-owned reaping. Observe that completion.
      await expect.poll(() => host.readFileFromVfs(`/proc/${child.pid}/stat`),
        { timeout: 10_000 }).toBeNull();
    } else {
      // Grouped exit publication already includes the exact retirement fence.
      expect(await host.readFileFromVfs(`/proc/${child.pid}/stat`)).toBeNull();
    }
    }
    const retired = await host.getMemoryGroupUsage();
    expect(retired?.admission).toMatchObject({ processes: 0, tasks: 0, quarantinedTasks: 0 });
    expect(retired?.backing).toMatchObject({ images: 0, replicas: 0, sharedObjects: 0,
      allocatedPages: 1, nativeObservers: 0 });
  } finally { await host.destroy(); }
}, 120_000);
