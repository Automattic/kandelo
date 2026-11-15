import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { NodeKernelHost } from '../../host/src/node-kernel-host';
import { resolveBinary } from '../../host/src/binary-resolver';

const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const imagePath = resolve('local-binaries/partial/shell-partial.vfs.zst');
const image = readFileSync(imagePath);
const kernelPath = resolveBinary('kernel.wasm');
const phpPath = resolveBinary('programs/php/php.wasm');
let stdout = '', stderr = '';
const host = new NodeKernelHost({ rootfsImage: image, maxWorkers: 4,
  onStdout: (_pid, bytes) => { stdout += new TextDecoder().decode(bytes); },
  onStderr: (_pid, bytes) => { stderr += new TextDecoder().decode(bytes); },
});
const records: object[] = [];
const options = { env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/maker', 'TMPDIR=/tmp'],
  cwd: '/home/maker', uid: 1000, gid: 1000, stdin: new Uint8Array() };
async function run(name: string, path: string, argv: string[]) {
  stdout = ''; stderr = '';
  const start = performance.now();
  const child = await host.spawnFromVfs(path, argv, options);
  const timeout = setTimeout(() => { console.error(`baseline timeout: ${name}`); void host.destroy(); }, 180000);
  try {
    const code = await child.exit;
    const result = { name, pid: child.pid, code, stdout, stderr, elapsedMs: performance.now() - start };
    records.push(result);
    writeFileSync(resolve(out, 'php-baseline.json'), JSON.stringify({ complete: false, records }, null, 2)+'\n');
    return result;
  } finally { clearTimeout(timeout); }
}
await host.init();
try {
  const version = await run('ordinary-php-cli', '/usr/bin/php', ['php', '-n', '-r',
    'echo "__VM_PHP__".json_encode(["version"=>PHP_VERSION,"opcache"=>extension_loaded("Zend OPcache"),"sum"=>array_sum(range(1,1000))])."\\n";']);
  assert.equal(version.code, 0, JSON.stringify(version));
  assert.match(version.stdout, /"sum":500500/);
  const setup = await run('file-cache-directory', '/bin/bash', ['bash', '-c', 'mkdir -p /tmp/vm-opcache-file-cache']);
  assert.equal(setup.code, 0, JSON.stringify(setup));
  await host.writeFileToVfs('/tmp/vm-opcache-probe.php', new TextEncoder().encode(
    '<?php echo "__VM_CACHE__".json_encode(["file_cache_only"=>ini_get("opcache.file_cache_only"),"sum"=>array_sum(range(1,1000))])."\\n";\n'));
  for (let i = 0; i < 2; i++) {
    const result = await run(`ordinary-file-cache-${i+1}`, '/usr/bin/php', ['php', '-n',
      '-d', 'opcache.enable=1', '-d', 'opcache.enable_cli=1', '-d', 'opcache.file_cache_only=1',
      '-d', 'opcache.file_cache=/tmp/vm-opcache-file-cache', '/tmp/vm-opcache-probe.php']);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.match(result.stdout, /"file_cache_only":"1"/);
    assert.match(result.stdout, /"sum":500500/);
  }
  const guard = await run('ordinary-shared-opcache-refusal', '/usr/bin/php', ['php', '-n',
    '-d', 'opcache.enable=1', '-d', 'opcache.enable_cli=1', '-d', 'opcache.file_cache_only=0',
    '-r', 'echo "__UNEXPECTED_SHARED_START__";']);
  assert.match(guard.stdout + guard.stderr, /requires opcache.file_cache_only=1/);
  assert.doesNotMatch(guard.stdout, /__UNEXPECTED_SHARED_START__/);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(resolve(out, 'php-baseline.json'), JSON.stringify({ complete: true, records,
    node: process.version, image: { path: imagePath, sha256: hash(imagePath) },
    kernel: { path: kernelPath, sha256: hash(kernelPath) }, php: { path: phpPath, sha256: hash(phpPath) },
    claim: 'ordinary CLI/file-cache smoke and explicit shared-mode refusal; not an FPM or performance result',
  }, null, 2)+'\n');
  console.log('PHP baseline smoke passed');
} finally { await host.destroy(); }
