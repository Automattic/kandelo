import { defineConfig, type Plugin } from 'vite';
import { dropWorkerEntryExports } from './vite/worker-entry-exports';
import { desktopImageAssets, type DesktopPreviewAsset } from './vite/grouped-desktop-assets';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBinary } from '../../host/src/binary-resolver';

// Development consumer of the normal SDK, image writer and host backend.
// A frozen asset manifest lets existing compatible desktop data be reused
// during incremental runtime work, without changing a published preview.
export default defineConfig(() => {
  const image = process.env.KANDELO_GROUPED_DESKTOP_IMAGE;
  const assets = process.env.KANDELO_GROUPED_DESKTOP_ASSETS;
  if (!image) throw Error('Select a grouped desktop image in KANDELO_GROUPED_DESKTOP_IMAGE');
  const artifact = (file: string, type: string) => ({ file, type, sha256: undefined as string | undefined });
  const routes = new Map<string, DesktopPreviewAsset>([
    ['/__grouped_preview/kernel.wasm', artifact(resolveBinary('kernel.wasm'), 'application/wasm')],
    ['/__grouped_preview/image.vfs.zst', artifact(resolve(image), 'application/octet-stream')],
  ]);
  if (assets) {
    const manifest = JSON.parse(readFileSync(assets, 'utf8'));
    const blobRoot = realpathSync(resolve(dirname(assets), 'blobs')) + sep;
    for (const [route, entry] of Object.entries(manifest.rows) as [string, {file: string; type: string; sha256: string}][]) {
      if (!route.startsWith('/assets/') && !route.startsWith('/binaries/')) continue;
      const file = realpathSync(entry.file);
      if (!file.startsWith(blobRoot)) throw Error('Frozen desktop asset is outside its blob directory');
      routes.set(route, { ...entry, file });
    }
  } else {
    for (const [route, entry] of desktopImageAssets(readFileSync(image))) routes.set(route, entry);
  }
  const cache = new Map<string, Buffer>();
  const load = (row: DesktopPreviewAsset) => {
    let bytes = cache.get(row.file);
    if (!bytes) {
      bytes = readFileSync(row.file);
      cache.set(row.file, bytes);
    }
    if (row.bytes !== undefined && bytes.length !== row.bytes) throw Error('Desktop asset size differs from its image declaration');
    if (row.sha256 && createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw Error('Desktop asset hash mismatch');
    return bytes;
  };
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
  const artifactPaths = new Map([['kernel.wasm', routes.get('/__grouped_preview/kernel.wasm')!.file]]);
  const artifactsAlias = (): Plugin => ({ name: 'grouped-preview-default-artifacts', enforce: 'pre', resolveId(source) {
    const [path, ...query] = source.split('?');
    const artifact = path === '@kernel-wasm' ? 'kernel.wasm'
      : path === '@rootfs-vfs' ? 'programs/wasm32/rootfs.vfs.zst' : undefined;
    if (!artifact) return null;
    let file = artifactPaths.get(artifact);
    if (!file) { file = resolveBinary(artifact); artifactPaths.set(artifact, file); }
    return file + (query.length ? '?' + query.join('?') : '');
  } });
  return { root: import.meta.dirname, publicDir: false, worker: { format: 'es', rollupOptions: { output: { inlineDynamicImports: true } },
    plugins: () => [artifactsAlias(), dropWorkerEntryExports()] },
    build: { outDir: resolve(import.meta.dirname, '../../.scratch/grouped-desktop-dist'),
      emptyOutDir: true, manifest: true, rollupOptions: { input: resolve(import.meta.dirname, 'grouped-desktop.html') } },
    preview: { host: '127.0.0.1', headers }, server: { host: '127.0.0.1', hmr: false,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
    headers },
    plugins: [artifactsAlias(), { name: 'grouped-desktop-artifacts', generateBundle() {
      const provenance: { route: string; bytes: number; sha256: string }[] = [];
      for (const [route, row] of routes) {
        const bytes = load(row);
        this.emitFile({ type: 'asset', fileName: route.slice(1), source: bytes });
        provenance.push({ route, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      this.emitFile({ type: 'asset', fileName: '__grouped_preview/artifacts.json', source: JSON.stringify(provenance, null, 2) + '\n' });
    }, configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        delete request.headers['if-none-match']; delete request.headers['if-modified-since']; next();
      });
    }, configureServer(server) {
      server.middlewares.use((request, response, next) => {
        // Disposable workers reload transformed module graphs. Serve complete
        // policy-bearing responses for this development fixture on each load.
        delete request.headers['if-none-match'];
        delete request.headers['if-modified-since'];
        const row = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (!row) return next();
        try {
          const bytes = load(row);
          response.setHeader('Content-Type', row.type); response.setHeader('Cache-Control', 'no-store'); response.end(bytes);
        } catch (error) { next(error); }
      });
    } }],
  };
});
