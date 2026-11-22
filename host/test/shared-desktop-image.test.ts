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
it('shared-desktop-node-startup: runs the canonical prepared shell and reclaims its command family', async () => {
  let stdout = '', stderr = '';
  const diagnostics: unknown[] = [];
  const host = new NodeKernelHost({
    rootfsImage: readFileSync(resolveBinary('programs/shared-desktop.vfs.zst')),
    experimentalMemoryGroup: { maximumPages: 8192 },
    onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
    onHostDiagnostic: event => diagnostics.push(event),
  });
  try {
    await host.init();
    const configBytes = await host.readFileFromVfs('/etc/kandelo/demo.json');
    expect(configBytes).not.toBeNull();
    const config = parseKandeloDemoConfig(new TextDecoder().decode(configBytes!));
    expect(config?.defaultProfile).toBe('cage');
    expect(Object.keys(config?.profiles ?? {}).sort()).toEqual(['cage', 'sway', 'sway-sfwbar']);

    const manifestBytes = await host.readFileFromVfs('/usr/share/kandelo/shared-desktop/programs.json');
    expect(manifestBytes).not.toBeNull();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!));
    expect(manifest.memoryGroup).toBe('trusted-v1');
    expect(manifest.programs.map((row: { id: string }) => row.id))
      .toEqual(sharedDesktopPackagePrograms.map(row => row.id));

    const bash = await host.readFileFromVfs('/bin/sh');
    expect(bash).not.toBeNull();
    const payload = readWasmCustomSectionPayload(Uint8Array.from(bash!).buffer, G.MEMORY_GROUP_SECTION);
    expect(payload).not.toBeNull();
    const declaration = JSON.parse(new TextDecoder().decode(payload!));
    const record = manifest.programs.find((row: { id: string }) => row.id === 'bash');
    expect(declaration).toMatchObject({ version: G.MEMORY_GROUP_VERSION,
      layout: G.MEMORY_GROUP_LAYOUT, sourceSha256: record.ordinarySha256 });
    expect(createHash('sha256').update(bash!).digest('hex')).toBe(record.groupedSha256);
    // Inspecting or reading a lazy program must not allocate an execution group.
    expect(await host.getMemoryGroupUsage()).toBeNull();

    const child = await host.spawnFromVfs('/bin/sh', ['sh', '-c', [
      'for p in /usr/bin/cage /usr/bin/foot /usr/bin/sway /usr/bin/sfwbar /usr/bin/freeciv /usr/bin/scummvm; do',
      '  test -x "$p" || exit 17;',
      'done;',
      "printf 'shared-desktop-node-startup PASS\\n' > /tmp/desktop-startup-proof;",
      '/bin/coreutils cat /tmp/desktop-startup-proof',
    ].join('\n')], { uid: 1000, gid: 1000, cwd: '/home/maker',
      env: ['PATH=/usr/bin:/bin', 'HOME=/home/maker', 'USER=maker'], stdin: new Uint8Array() });
    expect(await child.exit, stderr).toBe(0);
    expect(stdout).toBe('shared-desktop-node-startup PASS\n');
    expect({ stderr, diagnostics }).toEqual({ stderr: '', diagnostics: [] });
    expect(await host.readFileFromVfs(`/proc/${child.pid}/stat`)).toBeNull();
    const retired = await host.getMemoryGroupUsage();
    expect(retired?.admission).toMatchObject({ processes: 0, tasks: 0, quarantinedTasks: 0 });
    expect(retired?.backing).toMatchObject({ images: 0, replicas: 0, sharedObjects: 0,
      allocatedPages: 1, nativeObservers: 0 });
  } finally { await host.destroy(); }
}, 120_000);
