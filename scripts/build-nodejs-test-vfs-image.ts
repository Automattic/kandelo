/** Compose upstream data into the normal packaged shell image. No compilation. */
import { readFileSync, lstatSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KandeloImageFs } from '../images/vfs/lib/kandelo-image-fs';
import { ensureDirRecursive, writeVfsBinary } from '../host/src/vfs/image-helpers';
import { resolveBinary } from '../host/src/binary-resolver';
import { hash, sourceEntries } from './nodejs-source-helper';
export async function buildNodejsTestImage(sourceRoot: string, output: string) {
  const basePath = resolveBinary('programs/wasm32/shell.vfs.zst');
  const base = new Uint8Array(readFileSync(basePath));
  const image = KandeloImageFs.create();
  image.loadImage(base);
  // Preserve the product's capacity and mount contract. Do not raise a memory
  // ceiling to fit test fixtures. ENOSPC remains a preparation failure.
  ensureDirRecursive(image, '/node-src');
  const inputs: Array<{ path: string; kind: string; mode: number; sha256?: string; target?: string }> = [];
  const emptyDirectories: Array<{ path: string; mode: number }> = [];
  // Cases also read documentation, source headers and root files. Copy the
  // complete pinned archive rather than guessing their transitive inputs.
  for (const name of sourceEntries(sourceRoot)) {
    const host = join(sourceRoot, name), guest = `/node-src/${name}`;
    ensureDirRecursive(image, dirname(guest));
    const stat = lstatSync(host);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) {
      ensureDirRecursive(image, guest);
      image.chmod(guest, mode);
      inputs.push({ path: guest, kind: 'directory', mode });
      if (readdirSync(host).length === 0) emptyDirectories.push({ path: guest, mode });
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(host);
      image.symlink(target, guest);
      inputs.push({ path: guest, kind: 'symlink', mode, target });
    } else {
      const bytes = new Uint8Array(readFileSync(host));
      writeVfsBinary(image, guest, bytes, mode);
      inputs.push({ path: guest, kind: 'file', mode, sha256: hash(bytes) });
    }
  }
  const sourceProbes = ['doc/api/cli.md', 'deps/v8/include/v8-version.h', 'LICENSE'].map(name => {
    const bytes = new Uint8Array(readFileSync(join(sourceRoot, name)));
    return { path: '/node-src/' + name, size: bytes.length, prefix: Array.from(bytes.subarray(0, 16)) };
  });
  writeVfsBinary(image, '/node-src/.kandelo-assert-probe.cjs', new TextEncoder().encode(`
const assert = require('assert');
let rejected = 0;
for (const check of [
  () => assert.throws(() => { throw Error('actual'); }, /expected/),
  () => assert.strictEqual(0, -0),
  () => assert.deepStrictEqual(new Map([['key', 1]]), new Map([['key', 2]])),
  () => assert.deepStrictEqual({a:undefined}, {b:undefined}),
]) { try { check(); } catch (e) { if (e.code === 'ERR_ASSERTION') rejected++; else throw e; } }
if (rejected !== 4) throw Error('Unsafe assertion implementation: '+rejected+'/4 mismatches rejected');
console.log('KANDELO_ASSERT_SANITY:4');
`), 0o644);
  writeVfsBinary(image, '/node-src/.kandelo-target-probe.cjs', new TextEncoder().encode(`
// Empty directories have no file leaf from which to reconstruct them. Check
// their presence and mode before recording any upstream test outcomes.
for (const fixture of ${JSON.stringify(emptyDirectories)}) {
  const stat = require('fs').statSync(fixture.path);
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== fixture.mode) throw Error('Empty fixture directory differs: '+fixture.path);
}
for (const fixture of ${JSON.stringify(sourceProbes)}) {
  const bytes = require('fs').readFileSync(fixture.path);
  if (bytes.length !== fixture.size || fixture.prefix.some((value, index) => bytes[index] !== value)) throw Error('Source fixture differs: '+fixture.path);
}
console.log('KANDELO_NODE_TARGET:'+process.version+':'+process.platform+':'+process.arch);
`), 0o644);
  image.setExportTimestamp(0);
  const bytes = await image.saveImage();
  writeFileSync(output, bytes);
  return { baseImageSha256: hash(base), imageSha256: hash(bytes), inputsSha256: hash(JSON.stringify(inputs)) };
}
