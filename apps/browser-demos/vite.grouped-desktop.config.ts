import { defineConfig } from 'vite';
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
  if (!image || !assets) throw Error('Select a grouped desktop image and its frozen asset manifest');
  const manifest = JSON.parse(readFileSync(assets, 'utf8'));
  const blobRoot = realpathSync(resolve(dirname(assets), 'blobs')) + sep;
  const artifact = (file: string, type: string) => ({ file, type, sha256: undefined as string | undefined });
  const routes = new Map<string, { file: string; type: string; sha256?: string }>([
    ['/__grouped_preview/kernel.wasm', artifact(resolveBinary('kernel.wasm'), 'application/wasm')],
    ['/__grouped_preview/image.vfs.zst', artifact(resolve(image), 'application/octet-stream')],
  ]);
  for (const [route, entry] of Object.entries(manifest.rows) as [string, {file: string; type: string; sha256: string}][]) {
    if (!route.startsWith('/assets/') && !route.startsWith('/binaries/')) continue;
    const file = realpathSync(entry.file);
    if (!file.startsWith(blobRoot)) throw Error('Frozen desktop asset is outside its blob directory');
    routes.set(route, { ...entry, file });
  }
  const cache = new Map<string, Buffer>();
  return { root: import.meta.dirname, server: { host: '127.0.0.1', hmr: false,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin' } },
    plugins: [{ name: 'grouped-desktop-artifacts', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        // Disposable workers reload transformed module graphs. Serve complete
        // policy-bearing responses for this development fixture on each load.
        delete request.headers['if-none-match'];
        delete request.headers['if-modified-since'];
        const row = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (!row) return next();
        try {
          let bytes = cache.get(row.file);
          if (!bytes) {
            bytes = readFileSync(row.file);
            if (row.sha256 && createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw Error('Frozen desktop asset hash mismatch');
            cache.set(row.file, bytes);
          }
          response.setHeader('Content-Type', row.type); response.setHeader('Cache-Control', 'no-store'); response.end(bytes);
        } catch (error) { next(error); }
      });
    } }],
  };
});
