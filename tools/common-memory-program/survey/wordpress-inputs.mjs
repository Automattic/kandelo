import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
export const wordpressHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function wordpressInputs(variants,profile,image,native,manifest,modes) {
  const files=[image,native,'local-binaries/source-only-v1/kernel.wasm',resolve(variants,'manifest.json'),
    ...modes.map(m=>manifest.variants[m].artifacts.fpm.path),
    ...readdirSync(profile).map(p=>resolve(profile,p)),
    ...readdirSync('tools/common-memory-program/survey').filter(p=>p.startsWith('wordpress')).map(p=>resolve('tools/common-memory-program/survey',p)),
    resolve('tools/common-memory-program/survey/summarize-wordpress.py'),
    resolve('apps/browser-demos/lib/init/wordpress-runtime-config.ts'),
    resolve('apps/browser-demos/lib/init/php-fpm-worker-count.ts')];
  return Object.fromEntries(files.map(p=>[p,wordpressHash(p)]));
}
export function verifyWordpressInputs(inputs) {
  for(const [file,digest] of Object.entries(inputs))if(wordpressHash(file)!==digest)throw Error(`input changed: ${file}`);
}
export function wordpressIdentities(inputs,image,native,manifest,modes) {
  return {imageSha256:inputs[image],kernelSha256:inputs['local-binaries/source-only-v1/kernel.wasm'],
    artifacts:{native:inputs[native],...Object.fromEntries(modes.map(m=>[m,inputs[manifest.variants[m].artifacts.fpm.path]]))}};
}
