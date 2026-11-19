import { readFileSync, realpathSync } from 'node:fs';
import { resolveBinary, resolveLazyAssetPaths } from '../../../host/src/binary-resolver';
import { normalizeImageOwnedLazyReference } from '../../../host/src/vfs/vfs-asset-group-reference';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';

export interface DesktopPreviewAsset {
  file: string;
  type: string;
  sha256?: string;
  bytes?: number;
}

/** Serve only the selected image's declared lazy closure, through the same
 * validated package resolver used by the ordinary Node/browser paths. */
export function desktopImageAssets(image: Uint8Array): Map<string, DesktopPreviewAsset> {
  const fs = KandeloImageFs.create(new Uint8Array(readFileSync(resolveBinary('kandelo_image_module32.wasm'))));
  let entries: { uri: string; bytes: number; digest: Uint8Array }[];
  try {
    fs.loadImage(image);
    const lazy = fs.lazyEntries();
    entries = [
      ...lazy.files.filter(entry => entry.archiveId === 0).map(entry => ({ ...entry, bytes: entry.size })),
      ...lazy.archives,
    ];
  } finally { fs.reset(); }
  const paths = resolveLazyAssetPaths(entries.map(entry => entry.uri));
  const assets = new Map<string, DesktopPreviewAsset>();
  for (const entry of entries) {
    const route = '/' + normalizeImageOwnedLazyReference(entry.uri);
    const resolved = paths.get(entry.uri);
    if (!resolved || 'error' in resolved) throw resolved?.error ?? Error('Missing desktop asset: ' + entry.uri);
    const file = realpathSync(resolved.path);
    const sha256 = entry.digest.some(byte => byte !== 0) ? Buffer.from(entry.digest).toString('hex') : undefined;
    const asset = { file, bytes: entry.bytes, sha256,
      type: file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' };
    const previous = assets.get(route);
    if (previous && (previous.file !== file || previous.bytes !== asset.bytes || previous.sha256 !== sha256)) {
      throw Error('Conflicting desktop asset declarations: ' + entry.uri);
    }
    assets.set(route, asset);
  }
  return assets;
}
