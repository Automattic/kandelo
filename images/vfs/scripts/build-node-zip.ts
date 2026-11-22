#!/usr/bin/env -S npx tsx
/** Package the normal Node executable, native Amaro and unchanged bundled npm. */
import {execFileSync} from 'node:child_process';
import {chmodSync,copyFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
const [nodePath,npmSource,amaroPath,undiciPath,outputZip]=process.argv.slice(2);
if(!nodePath||!npmSource||!amaroPath||!undiciPath||!outputZip)throw Error('usage: build-node-zip.ts NODE_WASM NPM_SOURCE AMARO_LIBRARY UNDICI_LIBRARY OUTPUT_ZIP');
const pkg=JSON.parse(readFileSync(join(npmSource,'package.json'),'utf8'));
if(pkg.name!=='npm'||pkg.version!=='11.20.0')throw Error('Expected pinned Node26.13.0 bundled npm11.20.0');
const work=mkdtempSync(join(process.env.WASM_POSIX_DEP_WORK_DIR||tmpdir(),'node-zip.'));
try {
 mkdirSync(join(work,'bin'),{recursive:true});mkdirSync(join(work,'lib'),{recursive:true});
 copyFileSync(nodePath,join(work,'bin/spidermonkey-node'));chmodSync(join(work,'bin/spidermonkey-node'),0o755);
 // Keep standard Node shebangs and npm working while naming the actual engine.
 symlinkSync('spidermonkey-node',join(work,'bin/node'));
 copyFileSync(amaroPath,join(work,'lib/libnode-amaro.so'));chmodSync(join(work,'lib/libnode-amaro.so'),0o755);
 copyFileSync(undiciPath,join(work,'lib/libnode-undici-llhttp.so'));chmodSync(join(work,'lib/libnode-undici-llhttp.so'),0o755);
 cpSync(npmSource,join(work,'lib/npm'),{recursive:true,verbatimSymlinks:true,filter:(path)=>{
  const rel=relative(npmSource,path).replaceAll('\\','/');
  // The separate npm-docs archive owns these upstream pages.
  return !['man','docs'].some(dir=>rel===dir||rel.startsWith(dir+'/'));
 }});
 makeDirectoriesWritable(work);
 symlinkSync('../lib/npm/bin/npm-cli.js',join(work,'bin/npm'));
 symlinkSync('../lib/npm/bin/npx-cli.js',join(work,'bin/npx'));
 const helper=fileURLToPath(new URL('./create-deterministic-zip.sh',import.meta.url));
 execFileSync('bash',[helper,work,outputZip],{stdio:'inherit'});
}finally{makeDirectoriesWritable(work);rmSync(work,{recursive:true,force:true});}
// Resolver source trees are sealed read-only. Change only our private copy,
// leaving verified inputs untouched and preserving symlinks and file bytes.
function makeDirectoriesWritable(directory:string):void {
 chmodSync(directory,0o755);
 for(const entry of readdirSync(directory,{withFileTypes:true})) {
  if(entry.isDirectory()&&!entry.isSymbolicLink())makeDirectoriesWritable(join(directory,entry.name));
 }
}

