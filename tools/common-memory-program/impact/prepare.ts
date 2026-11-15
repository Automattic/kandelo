import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { saveImage } from '../../../images/vfs/scripts/vfs-image-helpers';
const [inputImage, ordinaryFpm, output] = process.argv.slice(2).map(p => resolve(p));
if (!output) throw Error('usage: prepare.ts COMMON_IMAGE ORDINARY_FPM FRESH_OUTPUT');
mkdirSync(output); const fs = KandeloImageFs.create();
const input = readFileSync(inputImage); fs.loadImage(input);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const translated = fs.readFile('/usr/sbin/php-fpm'), ordinary = readFileSync(ordinaryFpm);
const metadata = fs.getImageMetadata();
const provenance = metadata?.commonMemoryPrototype as {virtualFpmSha256?: string; originalFpmSha256?: string} | undefined;
if (provenance?.virtualFpmSha256 !== sha(translated)) throw Error('image FPM provenance mismatch');
const removed: Array<{ path: string; bytes: number }> = [];
function clear(path: string) {
  for (const name of fs.readDirNames(path)) {
    const child = `${path}/${name}`, info = fs.lstat(child);
    if ((info.mode & 0xf000) === 0x4000) clear(child);
    else { removed.push({ path: child, bytes: info.size }); fs.unlink(child); }
  }
}
clear('/var/cache/opcache');
// Every arm installs its selected admitted binary through worker-owned VFS
// before starting services. Exclude an unused baked-in FPM from all arms.
fs.unlink('/usr/sbin/php-fpm');
const imagePath = resolve(output, 'wordpress-empty-cache.vfs.zst');
const image = await saveImage(fs, imagePath, { metadata: { ...metadata, createdBy: 'common-memory-impact-fixture' } });
writeFileSync(resolve(output, 'ordinary-fpm.wasm'), ordinary);
writeFileSync(resolve(output, 'translated-fpm.wasm'), translated);
const manifest = { format: 1, sourceImage: inputImage, sourceImageSha256: sha(input),
  image: imagePath, imageSha256: sha(image), ordinaryFpmSha256: sha(ordinary), translatedFpmSha256: sha(translated),
  originalImageOrdinaryFpmSha256: provenance?.originalFpmSha256,
  removedCacheFiles: removed.length, removedCacheBytes: removed.reduce((n, f) => n + f.bytes, 0),
  cacheStartsEmpty: true, noBakedFpm: true, workers: 2, validateTimestamps: true, revalidateFrequency: 0,
  arms: { 'native-file': 'ordinary-fpm.wasm', 'vm-file': 'translated-fpm.wasm', 'vm-shared': 'translated-fpm.wasm' } };
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(output, 'removed-cache-files.json'), JSON.stringify(removed, null, 2) + '\n');
console.log(JSON.stringify(manifest));
