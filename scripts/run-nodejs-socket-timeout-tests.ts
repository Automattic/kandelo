#!/usr/bin/env tsx
/** Real socket inactivity controls through normal Node/browser images. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KandeloImageFs } from '../images/vfs/lib/kandelo-image-fs';
import { writeVfsBinary, ensureDirRecursive } from '../host/src/vfs/image-helpers';
import { resolveBinary } from '../host/src/binary-resolver';
import { createNodejsGuestRunner, type GuestHost } from './nodejs-guest-runner';
import { fileHash, hash, nodejsTarget } from './nodejs-source-helper';
import { classifyNodejsResult } from './nodejs-test-results';
import {nodeSocketWriteProgressSource} from '../host/test/fixtures/node-socket-write-progress';
import {nodeSocketTimeoutCases} from '../host/test/fixtures/node-socket-timeouts';

const host = process.argv[2] as GuestHost;
if (!['node','chromium','firefox','webkit'].includes(host)) throw Error('Specify node|chromium|firefox|webkit and a fresh output directory');
const out = resolve(process.argv[3] || `.context/node-socket-timeouts-${host}-${Date.now()}`);
if (existsSync(join(out,'result.json'))) throw Error('Report already exists; use a fresh directory');
mkdirSync(out,{recursive:true});
const peer=join(out,'socket-write-peer.wasm');
execFileSync('wasm32posix-cc',['host/test/fixtures/node-socket-write-peer.c','-O2','-o',peer],{stdio:'inherit'});
const nativeTarget=execFileSync('rustc',['-vV'],{encoding:'utf8'}).match(/^host: (.+)$/m)?.[1];
if(!nativeTarget)throw Error('Missing native target');
execFileSync('cargo',['run','-p','xtask','--target',nativeTarget,'--quiet','--','stamp-abi-contract',peer],{stdio:'inherit'});
const cases=[...nodeSocketTimeoutCases,{name:'native-write-progress',source:nodeSocketWriteProgressSource}];
const image = KandeloImageFs.create();
image.loadImage(new Uint8Array(readFileSync(resolveBinary('programs/wasm32/shell.vfs.zst'))));
ensureDirRecursive(image,'/node-src');
writeVfsBinary(image,'/node-src/socket-write-peer.wasm',new Uint8Array(readFileSync(peer)),0o755);
for (const c of cases) writeVfsBinary(image,`/node-src/${c.name}.cjs`,new TextEncoder().encode(c.source),0o644);
image.setExportTimestamp(0);
const imagePath = join(out,'suite.vfs'); writeFileSync(imagePath,await image.saveImage());
const runner = await createNodejsGuestRunner(host,imagePath);
const provenance = {target:nodejsTarget,gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceSha256:fileHash('host/test/fixtures/node-socket-timeouts.ts'),
  progressSourceSha256:fileHash('host/test/fixtures/node-socket-write-progress.ts'),peerSourceSha256:fileHash('host/test/fixtures/node-socket-write-peer.c'),peerSha256:fileHash(peer),
  bootstrapSha256:fileHash('packages/registry/node-compat/bootstrap.js'),
  adapterSha256:fileHash('packages/registry/spidermonkey/node-compat/adapter.js')};
const results = [];
try {
  for (const c of cases) {
    const result = await runner.run({name:c.name,relPath:c.name,hostPath:'',vfsPath:`/node-src/${c.name}.cjs`,
      sha256:hash(c.source),flags:[],env:{},nodeTest:false},60_000);
    let status = classifyNodejsResult(result);
    if (status === 'pass' && result.stdout.trim() !== `node-socket-timeouts-${c.name}-ok`) status = 'fail';
    const passed = status === 'pass';
    results.push({name:c.name,sourceSha256:hash(c.source),status,passed,result});
    writeFileSync(join(out,'result.json'),JSON.stringify({provenance,identity:runner.identity,
      complete:results.length===cases.length,total:cases.length,
      counts:Object.fromEntries(['pass','fail','upstream-skip','unsupported','timeout','harness-error'].map(status => [status,results.filter(r => r.status===status).length])),results},null,2)+'\n');
    console.log(JSON.stringify({host,name:c.name,passed,...result}));
    if (!passed) process.exitCode = 1;
  }
} finally { await runner.close(); }
