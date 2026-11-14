import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
export async function serve(artifacts) {
  const source = fileURLToPath(new URL('.', import.meta.url));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const artifact = url.pathname.startsWith('/artifacts/');
      const base = resolve(artifact ? artifacts : source);
      const path = resolve(base, artifact ? url.pathname.slice(11) : url.pathname.slice(1) || 'index.html');
      if (!path.startsWith(base + sep) || !/\.(mjs|wasm|html)$/.test(path)) throw Error('refused path');
      res.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.html') ? 'text/html' : 'text/javascript');
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
