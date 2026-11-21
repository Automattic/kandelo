import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { KandeloImageFs } from '../lib/kandelo-image-fs';

type LazyEntries = ReturnType<KandeloImageFs['lazyEntries']>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hasDigest = (digest: Uint8Array) => digest.length === 32 && digest.some(byte => byte !== 0);

/** Read only the executable named by the image, from its resolver-owned source.
 * Archive data remains deferred; extracting one program must not eagerly load
 * game assets or substitute an unrelated executable with a similar basename. */
export function readTrustedDesktopProgram(
  file: LazyEntries['files'][number],
  archives: LazyEntries['archives'],
  readSource: (uri: string) => Uint8Array,
): Uint8Array {
  let bytes: Uint8Array;
  if (file.archiveId === 0) bytes = readSource(file.uri);
  else {
    const archive = archives.find(entry => entry.archiveId === file.archiveId);
    if (!archive || !hasDigest(archive.digest)) throw Error('Trusted executable archive lacks an image-bound digest: ' + file.path);
    const compressed = readSource(archive.uri);
    if (compressed.length !== archive.bytes || hash(compressed) !== Buffer.from(archive.digest).toString('hex')) {
      throw Error('Executable archive differs from its image declaration: ' + file.path);
    }
    let matches = 0;
    const extracted = unzipSync(compressed, { filter: entry => {
      if (entry.name !== file.sourcePath) return false;
      if (++matches !== 1 || entry.originalSize !== file.size) throw Error('Executable archive member differs from its image declaration: ' + file.path);
      return true;
    } });
    const member = extracted[file.sourcePath];
    if (matches !== 1 || member === undefined) throw Error('Executable archive member is absent: ' + file.path);
    bytes = member;
  }
  if (bytes.length !== file.size || hasDigest(file.digest) && hash(bytes) !== Buffer.from(file.digest).toString('hex')) {
    throw Error('Deferred executable differs from its image declaration: ' + file.path);
  }
  return bytes;
}
