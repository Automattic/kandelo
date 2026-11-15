import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { writeVfsFile } from '../../../host/src/vfs/image-helpers';
import { renderWordPressConfig } from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import { checkFreshness } from './freshness.mjs';

const [profile, image, output] = process.argv.slice(2).map(p => resolve(p));
const kernelPath = resolve(process.argv[5] ?? 'local-binaries/source-only-v1/kernel.wasm');
process.env.WASM_POSIX_RESOLUTION_POLICY = 'source-only-v1';
process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT ??= resolve('local-binaries/source-only-v1');
const { NodeKernelHost } = await import(pathToFileURL(resolve(profile, 'node-kernel-host.mjs')).href);
mkdirSync(output, { recursive: true });
for (const backend of ['sqlite', 'mariadb']) {
  const result: any = { backend, stdout: [], stderr: [], diagnostics: [] };
  const fs = KandeloImageFs.create(); fs.loadImage(readFileSync(image));
  writeVfsFile(fs, '/srv/www/html/wp-config.php', renderWordPressConfig('selectable', '/', 'http'));
  const host = new NodeKernelHost({ rootfsImage: await fs.saveImage(), maxWorkers: 24,
    onStdout: (pid: number, b: Uint8Array) => result.stdout.push({ pid, text: new TextDecoder().decode(b) }),
    onStderr: (pid: number, b: Uint8Array) => result.stderr.push({ pid, text: new TextDecoder().decode(b) }),
    onHostDiagnostic: (e: unknown) => result.diagnostics.push(e),
  });
  const watchdog = setTimeout(() => { console.error('WordPress Node deadline'); void host.destroy(); }, 240000);
  try {
    await host.init(Uint8Array.from(readFileSync(kernelPath)).buffer);
    const init = await host.spawnFromVfs('/sbin/dinit', ['dinit', '--container', '-p', '/tmp/dinitctl', `wordpress-${backend}`], {
      cwd: '/', uid: 0, gid: 0, env: ['HOME=/root', 'PATH=/usr/bin:/bin:/sbin:/usr/sbin', 'TMPDIR=/tmp', 'WP_APP_PATH=/', 'WP_PROTO=http'],
    });
    let exit: number | undefined; init.exit.then((code: number) => { exit = code; });
    const deadline = performance.now() + 180000;
    while (!await host.pickListenerTarget(8080)) {
      assert.equal(exit, undefined, 'dinit exited before nginx readiness');
      assert.ok(performance.now() < deadline, 'nginx readiness deadline');
      await new Promise(r => setTimeout(r, 50));
    }
    const get = (url: string) => host.fetchInKernel(8080, { method: 'GET', url, headers: { Host: 'localhost' }, body: null }, { timeoutMs: 120000 });
    let home = await get('/');
    result.readinessStatuses = [home.status];
    // A listening nginx precedes FPM child readiness; observe a real response.
    while (home.status >= 500 && performance.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      home = await get('/'); result.readinessStatuses.push(home.status);
    }
    result.home = { status: home.status, bytes: home.body.length };
    assert.equal(home.status, 200);
    assert.match(new TextDecoder().decode(home.body), /Hello world/i);
    result.statuses = await Promise.all(Array.from({ length: 8 }, async (_, n) => {
      const response = await get(`/common-memory-status.php?probe=${n}`);
      assert.equal(response.status, 200);
      return JSON.parse(new TextDecoder().decode(response.body));
    }));
    for (const s of result.statuses) {
      assert.equal(s.opcache_enabled, true); assert.equal(s.file_cache_only, '0');
      assert.equal(s.file_cache, ''); assert.ok(s.statistics.num_cached_scripts > 50);
    }
    assert.equal(new Set(result.statuses.map((s: any) => s.pid)).size, 2);
    result.freshness = await checkFreshness(host);
    result.memory = await host.commonMemoryPrototypeStats();
    assert.equal(result.memory.groups, 1);
    result.inspection = await host.inspectProcesses();
    const shared = result.inspection.memoryGroups.filter((g: any) => g.kind === 'shared-group');
    assert.equal(shared.length, 1);
    assert.equal(shared[0].processCount, 3, 'FPM master and two workers');
    const fpm = result.inspection.processes.filter((p: any) => p.memoryAccounting?.groupId === shared[0].id);
    assert.equal(fpm.length, 3);
    assert.ok(fpm.every((p: any) => p.memoryAccounting.sharedBytes >= 32 * 1024 ** 2));
    const attributed = fpm.reduce((n: number, p: any) => n + p.memoryAccounting.attributedBytes, 0);
    assert.ok(Math.abs(attributed - shared[0].uniqueMappedBytes) < 0.01, 'attribution reconciles');
    for (const group of result.inspection.memoryGroups) {
      assert.equal(group.uniqueMappedBytes + group.runtimeOverheadBytes + group.retainedBytes
        + group.reusableBytes + group.unaccountedBytes + group.unallocatedBytes, group.backingBufferBytes);
    }
    // The old diagnostic counts sharing by PTE flags. Only its deduplicated
    // union is comparable with process-reference accounting.
    assert.equal(shared[0].uniqueMappedBytes, result.memory.privatePteBytes + result.memory.sharedPteBytes);
    result.passed = true;
    console.log(`WordPress ${backend} Node homepage/shared OPcache passed`);
  } catch (error) { result.error = String(error); throw error; }
  finally {
    clearTimeout(watchdog);
    await host.destroy(); result.destroyed = true;
    writeFileSync(resolve(output, `${backend}.json`), JSON.stringify(result, null, 2) + '\n');
  }
}
