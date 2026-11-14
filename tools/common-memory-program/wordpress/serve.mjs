import { createServer, loadConfigFromFile } from 'vite';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';

const [profileDir, imagePath, portArg='0',kernelPath] = process.argv.slice(2);
if (!profileDir || !imagePath) throw Error('Usage: serve.mjs PROFILE_DIR IMAGE.vfs.zst [PORT] [KERNEL.wasm]');
const profile = resolve(profileDir), image = resolve(imagePath);
process.env.WASM_POSIX_RESOLUTION_POLICY ??= 'source-only-v1';
process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT ??= resolve('local-binaries/source-only-v1');
// Use Vite's normal config bundler: importing this config through tsx would
// add closure helpers to functions later serialized into the service worker.
const loaded = await loadConfigFromFile({command:'serve',mode:'development'}, resolve('apps/browser-demos/vite.config.ts'));
if (!loaded) throw Error('browser Vite configuration was not loaded');
const base = loaded.config;
// Match the normal Vite alias contract while selecting this preview's kernel.
// Other servers keep their own configuration and selected binary tier.
const aliases=Array.isArray(base.resolve?.alias)?base.resolve.alias:
  Object.entries(base.resolve?.alias??{}).map(([find,replacement])=>({find,replacement}));
// Vite resolves the full import specifier, including `?url`. A string alias
// only matches an exact name or slash suffix, so use an explicit query match.
const explicitAliases=kernelPath?[{find:/^@kernel-wasm(?=\?|$)/,replacement:resolve(kernelPath)},...aliases]:aliases;
const workerUrls = new Map([
  ['./browser-kernel-worker-entry.ts?worker&url', 'browser-kernel-worker-entry'],
  ['./worker-entry-browser.ts?worker&url', 'worker-entry-browser'],
]);
const artifacts = new Map(['browser-kernel-host','browser-kernel-worker-entry','worker-entry-browser']
  .map(name=>[`/__common-memory/artifacts/${name}.mjs`,join(profile,`${name}.mjs`)]));
const plugin={name:'explicit-common-memory-wordpress',enforce:'pre',
  // Keep the ordinary main-thread host and its opaque lease/input registries
  // in the app's module graph. Only disposable workers own virtual memory.
  resolveId(source, importer){
    if(importer?.endsWith('/host/src/browser-kernel-host.ts') && workerUrls.has(source))
      return '\0common-memory-worker-url:'+workerUrls.get(source);
  },
  load(id){if(id.startsWith('\0common-memory-worker-url:'))
    return `export default ${JSON.stringify('/__common-memory/artifacts/'+id.split(':').at(-1)+'.mjs')};`;},
  configureServer(server){server.middlewares.use((req,res,next)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    const file=path==='/__common-memory/wordpress.vfs.zst'?image:artifacts.get(path);
    if(!file) return next();
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    res.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':'application/octet-stream');
    const bytes=readFileSync(file);res.setHeader('Content-Length',bytes.length);
    if(req.method==='HEAD') res.end(); else res.end(bytes);
  });},
};
const server=await createServer({...base, configFile:false, root:resolve('apps/browser-demos'),
  resolve:{...base.resolve,alias:explicitAliases},
  plugins:[plugin,...base.plugins],server:{...base.server,host:'127.0.0.1',port:Number(portArg),strictPort:true,hmr:false},
});
await server.listen();
const port=server.httpServer.address().port;
for(const backend of ['sqlite','mariadb']) console.log(`WORDPRESS_${backend.toUpperCase()}_URL=http://127.0.0.1:${port}/kandelo/?vfs=${encodeURIComponent('/__common-memory/wordpress.vfs.zst')}&profile=wordpress-${backend}`);
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await server.close();process.exit(0);});
