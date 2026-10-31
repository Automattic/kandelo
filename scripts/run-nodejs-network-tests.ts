#!/usr/bin/env tsx
/** Cross-host real socket regression, independent of the upstream inventory. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KandeloImageFs } from '../images/vfs/lib/kandelo-image-fs';
import { writeVfsBinary, ensureDirRecursive } from '../host/src/vfs/image-helpers';
import { resolveBinary } from '../host/src/binary-resolver';
import { createNodejsGuestRunner, type GuestHost } from './nodejs-guest-runner';
import { fileHash, hash } from './nodejs-source-helper';
const host = process.argv[2] as GuestHost;
if (!['node','chromium','firefox','webkit'].includes(host)) throw Error('Usage: run-nodejs-network-tests.sh node|chromium|firefox|webkit');
const out = resolve(process.argv[3] || `.context/node-network-${host}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
if (existsSync(join(out,'result.json'))) throw Error('Report already exists; choose a fresh output directory: ' + out);
mkdirSync(out, {recursive:true});
const binary = join(out,'network-peer.wasm');
// Build only this small C fixture through the checkout's normal SDK driver.
execFileSync('wasm32posix-cc', ['host/test/fixtures/node-network-peer.c','-O2','-o',binary], {stdio:'inherit'});
const nativeTarget = execFileSync('rustc', ['-vV'], {encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];
if (!nativeTarget) throw Error('Cannot identify xtask host target');
execFileSync('cargo', ['run','-p','xtask','--target',nativeTarget,'--quiet','--','stamp-abi-contract',binary], {stdio:'inherit'});

const image = KandeloImageFs.create();
image.loadImage(new Uint8Array(readFileSync(resolveBinary('programs/wasm32/shell.vfs.zst'))));
ensureDirRecursive(image, '/node-src');
writeVfsBinary(image, '/node-src/network-peer.wasm', new Uint8Array(readFileSync(binary)), 0o755);
const testPath = 'host/test/fixtures/node-network-client.cjs';
const source = readFileSync(testPath);
writeVfsBinary(image, '/node-src/network-client.cjs', new Uint8Array(source), 0o644);
image.setExportTimestamp(0);
const imagePath = join(out,'suite.vfs');
writeFileSync(imagePath, await image.saveImage());
const runner = await createNodejsGuestRunner(host, imagePath);
try {
  const result = await runner.run({name:'network-client',relPath:testPath,hostPath:resolve(testPath),vfsPath:'/node-src/network-client.cjs',
    sha256:hash(source),flags:[],env:{},nodeTest:false}, 90_000);
  const report = {identity:runner.identity, sourceSha256:fileHash(testPath), peerSha256:fileHash(binary), result};
  writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if (result.exitCode !== 0 || result.error || result.timeout || !result.stdout.includes('node-network-client-ok')) process.exitCode = 1;
} finally { await runner.close(); }
