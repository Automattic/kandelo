// Compose a runnable local demo from the validated filtered seed. Package and
// host artifacts stay pinned; the normal image writer checks the Wasm policy.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {KandeloImageFs} from '../../../images/vfs/lib/kandelo-image-fs';
import {saveImage,sourceDateEpochMilliseconds} from '../../../images/vfs/scripts/vfs-image-helpers';
import {writeVfsBinary,writeVfsFile} from '../../../host/src/vfs/image-helpers';
const [fixture,output]=process.argv.slice(2).map(p=>resolve(p));
const manifest=JSON.parse(readFileSync(resolve(fixture,'manifest.json'),'utf8'));
const image=readFileSync(manifest.image),fpm=readFileSync(resolve(fixture,'translated-fpm.wasm'));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
if(sha(image)!==manifest.imageSha256||sha(fpm)!==manifest.translatedFpmSha256||sha(fpm)!==manifest.seedFpmSha256)throw Error('seed/FPM identity mismatch');
if(!manifest.excludedSeedEntries?.some((e:any)=>e.script==='/etc/kandelo/wordpress-secrets.php'))throw Error('seed must exclude generated secrets');
const fs=KandeloImageFs.create();fs.loadImage(image);const metadata=fs.getImageMetadata();
const decode=(p:string)=>new TextDecoder('utf-8',{fatal:true}).decode(fs.readFile(p));
writeVfsBinary(fs,'/usr/sbin/php-fpm',fpm,0o755);
let ini=decode('/etc/php.ini');
const replacement='opcache.file_cache=/var/cache/opcache';
if((ini.match(/^opcache.file_cache=.*$/gm)??[]).length!==1)throw Error('ambiguous FILE cache configuration');
ini=ini.replace(/^opcache.file_cache=.*$/m,replacement);
for(const setting of ['opcache.file_cache_only=0','opcache.validate_timestamps=1','opcache.revalidate_freq=0']){
 if(!ini.split('\n').includes(setting))throw Error('unexpected '+setting);
}
writeVfsFile(fs,'/etc/php.ini',ini);
writeVfsFile(fs,'/srv/www/html/kandelo-seed-info.php',`<?php
header('Content-Type: application/json');header('Cache-Control: no-store');
$s=opcache_get_status(false);$c=opcache_get_configuration()['directives'];
usleep(20000);echo json_encode(['pid'=>getmypid(),'opcache_enabled'=>$s['opcache_enabled']??false,
 'file_cache_only'=>$c['opcache.file_cache_only'],'file_cache'=>$c['opcache.file_cache'],
 'validate_timestamps'=>$c['opcache.validate_timestamps'],'revalidate_freq'=>$c['opcache.revalidate_freq'],
 'cached_scripts'=>$s['opcache_statistics']['num_cached_scripts']??0]);`);
const demo=JSON.parse(decode('/etc/kandelo/demo.json'));
demo.image.title='WordPress shared OPcache with compiled seed';
for(const backend of ['sqlite','mariadb'])demo.profiles['wordpress-'+backend].identity.summary+=' Compatible compiled FILE seed, shared OPcache, timestamp checks enabled.';
writeVfsFile(fs,'/etc/kandelo/demo.json',JSON.stringify(demo,null,2)+'\n');
mkdirSync(output);
const path=resolve(output,'wordpress.vfs.zst');
const provenance={sourceSeedSha256:sha(image),fpmSha256:sha(fpm),backend:manifest.seedBackend,seedFiles:manifest.seedFiles,
 seedLogicalBytes:manifest.seedLogicalBytes,validateTimestamps:true,revalidateFrequency:0};
const bytes=await saveImage(fs,path,{normalizeTimestampsMs:sourceDateEpochMilliseconds(),
 metadata:{...metadata,createdBy:'cache-policy/build-demo.ts',commonMemoryOpcacheSeed:provenance},
 wasmArtifactPolicies:[{path:'/usr/sbin/php-fpm',forkInstrumentation:'auto',experimentalCommonMemory:'prototype-v2'}]});
writeFileSync(resolve(output,'manifest.json'),JSON.stringify({...provenance,image:path,imageSha256:sha(bytes)},null,2)+'\n');
console.log(JSON.stringify({image:path,backend:manifest.seedBackend,seedFiles:manifest.seedFiles,imageSha256:sha(bytes)}));
