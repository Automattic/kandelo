/** Compose upstream data into the normal packaged shell image. No compilation. */
import { readFileSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KandeloImageFs } from '../images/vfs/lib/kandelo-image-fs';
import { ensureDirRecursive, writeVfsBinary } from '../host/src/vfs/image-helpers';
import { resolveBinary } from '../host/src/binary-resolver';
import { hash, sourceFiles } from './nodejs-source-helper';
export async function buildNodejsTestImage(sourceRoot: string, output: string) {
  const basePath = resolveBinary('programs/wasm32/shell.vfs.zst');
  const base = new Uint8Array(readFileSync(basePath));
  const image = KandeloImageFs.create();
  image.loadImage(base);
  // Preserve the product's capacity and mount contract. Do not raise a memory
  // ceiling to fit test fixtures. ENOSPC remains a preparation failure.
  ensureDirRecursive(image, '/node-src');
  const inputs: Array<{ path: string; sha256: string }> = [];
  for (const top of ['test', 'lib', 'tools']) {
    for (const name of sourceFiles(join(sourceRoot, top))) {
      const host = join(sourceRoot, top, name), guest = `/node-src/${top}/${name}`;
      ensureDirRecursive(image, dirname(guest));
      const stat = lstatSync(host);
      if (stat.isSymbolicLink()) image.symlink(readlinkSync(host), guest);
      else {
        const bytes = new Uint8Array(readFileSync(host));
        writeVfsBinary(image, guest, bytes, stat.mode & 0o777);
        inputs.push({ path: guest, sha256: hash(bytes) });
      }
    }
  }
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
  writeVfsBinary(image, '/node-src/.kandelo-target-probe.cjs', new TextEncoder().encode("console.log('KANDELO_NODE_TARGET:'+process.version+':'+process.platform+':'+process.arch);\n"), 0o644);
  image.setExportTimestamp(0);
  const bytes = await image.saveImage();
  writeFileSync(output, bytes);
  return { baseImageSha256: hash(base), imageSha256: hash(bytes), inputsSha256: hash(JSON.stringify(inputs)) };
}
