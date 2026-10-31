#!/usr/bin/env tsx
/** Normal-image TCP listener regressions, including an independent C peer. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KandeloImageFs } from '../images/vfs/lib/kandelo-image-fs';
import { writeVfsBinary, ensureDirRecursive } from '../host/src/vfs/image-helpers';
import { resolveBinary } from '../host/src/binary-resolver';
import { createNodejsGuestRunner, type GuestHost } from './nodejs-guest-runner';
import { fileHash, hash } from './nodejs-source-helper';
import { nodeTcpServerCases, nodeTcpServerPeerSource } from '../host/test/fixtures/node-tcp-server';

const host = process.argv[2] as GuestHost;
if (!['node', 'chromium', 'firefox', 'webkit'].includes(host)) throw Error('Specify node|chromium|firefox|webkit and a fresh output directory');
const out = resolve(process.argv[3] || `.context/node-tcp-server-${host}-${Date.now()}`);
if (existsSync(join(out, 'result.json'))) throw Error('Report already exists; use a fresh directory');
mkdirSync(out, { recursive: true });
const binary = join(out, 'server-peer.wasm');
execFileSync('wasm32posix-cc', ['host/test/fixtures/node-tcp-server-peer.c', '-O2', '-o', binary], { stdio: 'inherit' });
const nativeTarget = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
if (!nativeTarget) throw Error('Missing native target');
execFileSync('cargo', ['run', '-p', 'xtask', '--target', nativeTarget, '--quiet', '--', 'stamp-abi-contract', binary], { stdio: 'inherit' });
const image = KandeloImageFs.create();
image.loadImage(new Uint8Array(readFileSync(resolveBinary('programs/wasm32/shell.vfs.zst'))));
ensureDirRecursive(image, '/node-src');
writeVfsBinary(image, '/node-src/server-peer.wasm', new Uint8Array(readFileSync(binary)), 0o755);
const cases = [...nodeTcpServerCases, { name: 'independent-peer', source: nodeTcpServerPeerSource }];
for (const c of cases) writeVfsBinary(image, `/node-src/${c.name}.cjs`, new TextEncoder().encode(c.source), 0o644);
image.setExportTimestamp(0);
const imagePath = join(out, 'suite.vfs');
writeFileSync(imagePath, await image.saveImage());
const runner = await createNodejsGuestRunner(host, imagePath);
const results = [];
try {
  for (const c of cases) {
    const result = await runner.run({ name: c.name, relPath: c.name, hostPath: '', vfsPath: `/node-src/${c.name}.cjs`,
      sha256: hash(c.source), flags: [], env: {}, nodeTest: false }, 45_000);
    results.push({ name: c.name, sourceSha256: hash(c.source), result });
    writeFileSync(join(out, 'result.json'), JSON.stringify({ identity: runner.identity, peerSourceSha256: fileHash('host/test/fixtures/node-tcp-server-peer.c'),
      peerSha256: fileHash(binary), complete: results.length === cases.length, results }, null, 2) + '\n');
    console.log(JSON.stringify({ host, name: c.name, ...result }));
    if (result.exitCode !== 0 || result.error || result.timeout || !result.stdout.includes('-ok')) process.exitCode = 1;
  }
} finally { await runner.close(); }
