// Focused native differential / genuine portable-owner NAPI controls.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
assert.equal(process.version,'v26.13.0');
const mode=process.argv[2],which=process.argv[3];
assert(process.env.WASI_FD_CONTROL_DIR&&process.env.WASI_FD_CORE&&process.env.WASI_FD_COMPONENT);
const privateRoot=fs.realpathSync(process.env.WASI_FD_CONTROL_DIR);
function check(p){p=path.resolve(p);assert(p===privateRoot||p.startsWith(privateRoot+path.sep));let parent=path.dirname(p);while(!fs.existsSync(parent))parent=path.dirname(parent);assert(fs.realpathSync(parent)===parent&&(parent===privateRoot||parent.startsWith(privateRoot+path.sep)));if(fs.existsSync(p))assert(!fs.lstatSync(p).isSymbolicLink());return p}
function mkdir(p){fs.mkdirSync(check(p),{recursive:true});return p}
const run=process.env.WASI_FD_RUN||'r1';assert(/^[a-z0-9-]+$/.test(run));const work=mkdir(path.join(privateRoot,'runs',run,mode+'-'+which));
let WASI;
if(mode==='native')({WASI}=require('node:wasi'));
else {
 assert.equal(mode,'candidate');
 const bundle=fs.readFileSync(process.env.WASI_FD_CORE,'utf8');
 const {values,create}=Function(bundle+'\nreturn {values:_createNodeValuesPlatform,create:_createNodeWasiPlatform};')();
 const binding=require(process.env.WASI_FD_COMPONENT);
 const getter=Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer').get;
 const Native=binding.initialize(memory=>new Uint8Array(Reflect.apply(getter,memory,[])));
 ({WASI}=create({native:{wasiConstructor:()=>Native},values:values({process,Buffer,util:require('node:util'),inspection:require('node:util'),os:{},signals:os.constants.signals})}));
}
let count=0;const result=[];
function group(name,fn){const value=fn();result.push({name,value});}
function make(tag,{preopen=true}={}){
 const dir=mkdir(path.join(work,tag+'-'+count++));const files=[0,1,2].map(i=>path.join(dir,'fd'+i));
 const fds=files.map(file=>fs.openSync(check(file),'w+'));const pre=preopen?mkdir(path.join(dir,'preopen')):undefined;
 const wasi=new WASI({version:'preview1',stdin:fds[0],stdout:fds[1],stderr:fds[2],preopens:pre?{'/sandbox':pre}:{},returnOnExit:true});
 const memory=new WebAssembly.Memory({initial:1});wasi.initialize({exports:{memory}});
 const m=new Uint8Array(memory.buffer),dv=new DataView(memory.buffer);const w=wasi.wasiImport;
 return {dir,pre,fds,files,w,m,dv,cleanup(){for(let i=0;i<4;i++)w.fd_close(i)}};
}
function ownFile(p,data='data'){fs.writeFileSync(check(p),data);}
if(which==='allocate'){
 group('real-extend-never-shrink-zero-length',()=>{const x=make('alloc');try{const {w,fds}=x;const ret=[];ret.push(w.fd_allocate(0,3n,5n));assert.equal(fs.fstatSync(fds[0]).size,8);ret.push(w.fd_allocate(0,1n,1n));assert.equal(fs.fstatSync(fds[0]).size,8);ret.push(w.fd_allocate(0,0n,0n));assert.deepEqual(ret,[0,0,0]);return {ret,size:8,targetObservedZeroLengthFallback:true}}finally{x.cleanup()}});
 group('allocate-rights-and-invalid',()=>{const x=make('rights');try{const r=[x.w.fd_allocate(999,0n,1n),x.w.fd_fdstat_set_rights(0,0n,0n),x.w.fd_allocate(0,0n,1n),x.w.fd_allocate(3,0n,1n)];assert.deepEqual(r,[8,0,76,76]);return r}finally{x.cleanup()}});
 group('unsigned-wrap-and-real-negative-ftruncate',()=>{const x=make('wrap');try{const r=[x.w.fd_allocate(0,0xffffffffffffffffn,1n),x.w.fd_allocate(0,0xffffffffffffffffn,0n)];assert.deepEqual(r,[0,28]);assert.equal(fs.fstatSync(x.fds[0]).size,0);return r}finally{x.cleanup()}});
 group('allocate-type-chronology',()=>{const x=make('types');try{const r=[x.w.fd_allocate(0,0,1n),x.w.fd_allocate(0,0n,1),x.w.fd_allocate(0,0n),x.w.fd_allocate(-1,0n,1n)];assert.deepEqual(r,[28,28,28,28]);return r}finally{x.cleanup()}});
}else if(which==='times'){
 const AT=1,ATNOW=2,MT=4,MTNOW=8;
 group('explicit-nanoseconds-quantized',()=>{const x=make('explicit');try{const r=x.w.fd_filestat_set_times(0,1700000000123456789n,1700000123987654321n,AT|MT);assert.equal(r,0);const st=fs.fstatSync(x.fds[0],{bigint:true});assert.equal(st.atimeNs,1700000000000000000n);assert.equal(st.mtimeNs,1700000123000000000n);return [r,st.atimeNs.toString(),st.mtimeNs.toString()]}finally{x.cleanup()}});
 group('omitted-also-whole-seconds',()=>{const x=make('omitted');try{fs.futimesSync(x.fds[0],1700000100.25,1700000200.75);assert.equal(x.w.fd_filestat_set_times(0,0n,0n,0),0);const st=fs.fstatSync(x.fds[0],{bigint:true});assert.equal(st.atimeNs,1700000100000000000n);assert.equal(st.mtimeNs,1700000200000000000n);return [st.atimeNs.toString(),st.mtimeNs.toString()]}finally{x.cleanup()}});
 group('single-now-snapshot',()=>{const x=make('now');try{const begin=BigInt(Math.floor(Date.now()/1000));assert.equal(x.w.fd_filestat_set_times(0,0n,0n,ATNOW|MTNOW),0);const end=BigInt(Math.floor(Date.now()/1000));const st=fs.fstatSync(x.fds[0],{bigint:true});assert.equal(st.atimeNs,st.mtimeNs);assert.equal(st.atimeNs%1000000000n,0n);assert(st.atimeNs/1000000000n>=begin&&st.atimeNs/1000000000n<=end);return {same:true,whole:true,inRange:true}}finally{x.cleanup()}});
 group('flags-before-fd-rights-u16',()=>{const x=make('flags');try{const r=[x.w.fd_filestat_set_times(999,0n,0n,AT|ATNOW),x.w.fd_filestat_set_times(999,0n,0n,16),x.w.fd_filestat_set_times(999,0n,0n,0),x.w.fd_fdstat_set_rights(0,0n,0n),x.w.fd_filestat_set_times(0,0n,0n,AT|ATNOW),x.w.fd_filestat_set_times(0,0n,0n,AT)];assert.deepEqual(r,[28,28,8,0,28,76]);assert.equal(x.w.fd_filestat_set_times(1,0n,0n,65536),0);return {r,u16HighBitIgnored:true}}finally{x.cleanup()}});
}else if(which==='renumber'){
 group('same-invalid-before-lookup',()=>{const x=make('same');try{const r=[x.w.fd_renumber(999,999),x.w.fd_renumber(0xffffffff,0xffffffff),x.w.fd_renumber(999,1),x.w.fd_renumber(0,999)];assert.deepEqual(r,[0,0,8,8]);assert.equal(fs.fstatSync(x.fds[0]).size,0);return r}finally{x.cleanup()}});
 group('real-row-move-rights-offset-close',()=>{const x=make('move');try{ownFile(x.files[0],'abcdef');fs.readSync(x.fds[0],Buffer.alloc(2),0,2,null);assert.equal(x.w.fd_fdstat_set_rights(0,6n,0n),0);assert.equal(x.w.fd_renumber(0,1),0);assert.throws(()=>fs.fstatSync(x.fds[1]),{code:'EBADF'});assert.equal(x.w.fd_fdstat_get(0,0),8);assert.equal(x.w.fd_fdstat_get(1,0),0);assert.equal(x.dv.getBigUint64(8,true),6n);assert.equal(fs.readSync(x.fds[0],Buffer.alloc(2),0,2,null),2);assert.equal(x.w.fd_tell(1,32),76);return {moved:true,sourceInvalid:true,rights:'6',actualSourceOpen:true}}finally{x.cleanup()}});
 group('failed-destination-close-preserves-source',()=>{const x=make('failed');try{fs.closeSync(x.fds[1]);const r=x.w.fd_renumber(0,1);assert.equal(r,8);assert.equal(x.w.fd_fdstat_get(0,0),0);assert.equal(x.w.fd_fdstat_get(1,0),8);assert.equal(fs.fstatSync(x.fds[0]).size,0);return [r,true]}finally{x.cleanup()}});
 group('preopen-metadata-moves-no-destination-fd-alias',()=>{const x=make('preopen');let reused;try{assert.equal(x.w.fd_renumber(3,1),0);assert.equal(x.w.fd_prestat_get(3,0),8);assert.equal(x.w.fd_prestat_get(1,0),0);assert.equal(x.dv.getUint32(4,true),8);assert.equal(x.w.fd_prestat_dir_name(1,16,8),0);assert.equal(Buffer.from(x.m.subarray(16,24)).toString(),'/sandbox');reused=fs.openSync(check(path.join(x.dir,'reuse')),'w+');assert.equal(reused,x.fds[1]);assert.equal(x.w.fd_close(1),0);assert.equal(fs.fstatSync(reused).size,0);return {name:'/sandbox',sourceInvalid:true,recycledDestinationSurvives:true}}finally{x.cleanup();if(reused!==undefined)fs.closeSync(reused)}});
}else if(which==='readdir'){
 function populate(x){ownFile(path.join(x.pre,'alpha'),'x');ownFile(path.join(x.pre,'longer-name'),'y');mkdir(path.join(x.pre,'directory'));fs.symlinkSync('alpha',check(path.join(x.pre,'symbolic')));}
 function read(x,len,cookie=0n,out=16,buffer=128){x.m.fill(0xa5);const code=x.w.fd_readdir(3,buffer,len,cookie,out);return {code,used:x.dv.getUint32(out,true),bytes:Buffer.from(x.m.subarray(buffer,buffer+len))}}
 function decode(b,used){const entries=[];let p=0;while(p+24<=used){const next=b.readBigUInt64LE(p),inode=b.readBigUInt64LE(p+8),length=b.readUInt32LE(p+16),type=b[p+20];assert.equal(inode,0n);assert(b.subarray(p+21,p+24).every(x=>x===0xa5));assert(p+24+length<=used);entries.push({next:Number(next),name:b.subarray(p+24,p+24+length).toString(),type});p+=24+length;}assert.equal(p,used);return entries;}
 group('actual-entries-rewind-cookie',()=>{const x=make('entries');try{populate(x);const r=read(x,2048);assert.equal(r.code,0);const rows=decode(r.bytes,r.used);assert.deepEqual(rows.map(x=>x.name).sort(),['alpha','directory','longer-name','symbolic']);assert.deepEqual(rows.map(x=>x.next),[1,2,3,4]);const types=Object.fromEntries(rows.map(x=>[x.name,x.type]));assert.deepEqual(types,{alpha:4,directory:3,'longer-name':4,symbolic:7});const rest=read(x,2048,2n);assert.equal(rest.code,0);assert.deepEqual(decode(rest.bytes,rest.used),rows.slice(2));const again=read(x,2048);assert.equal(again.code,0);assert.deepEqual(decode(again.bytes,again.used),rows);return rows}catch(e){throw e}finally{x.cleanup()}});
 group('partial-header-name-empty-out-alias',()=>{const x=make('partial');try{populate(x);const full=read(x,2048);const row=decode(full.bytes,full.used)[0];for(const len of[0,1,20,23]){const v=read(x,len);assert.equal(v.code,0);assert.equal(v.used,len);assert(v.bytes.every(b=>b===0xa5));}const v=read(x,25);assert.equal(v.code,0);assert.equal(v.used,25);assert.equal(v.bytes.readBigUInt64LE(0),1n);assert.equal(v.bytes[24],row.name.charCodeAt(0));const eof=read(x,50,0xffffffffffffffffn);assert.equal(eof.code,0);assert.equal(eof.used,0);const aliased=read(x,25,0n,128,128);assert.equal(aliased.code,0);assert.equal(aliased.bytes.readUInt32LE(0),25);return {partialHeaderUntouched:true,partialName:true,eof:true,resultPublishedLast:true}}finally{x.cleanup()}});
 group('bounds-before-rights-unchanged-failure-output',()=>{const x=make('bounds');try{x.m.fill(0xa5);const r=[x.w.fd_readdir(999,65535,2,0n,0),x.w.fd_readdir(999,0,0,0n,65535),x.w.fd_readdir(999,0,0,0n,0),x.w.fd_fdstat_set_rights(3,0n,0n),x.w.fd_readdir(3,0,10,0n,32)];assert.deepEqual(r,[61,61,8,0,76]);assert.equal(x.dv.getUint32(32,true),0xa5a5a5a5);return r}finally{x.cleanup()}});
 group('retained-realpath-lookup-failure',()=>{const x=make('rename');try{fs.renameSync(check(x.pre),check(path.join(x.dir,'renamed')));x.m.fill(0xa5);const r=x.w.fd_readdir(3,128,10,0n,0);assert.equal(r,44);assert.equal(x.dv.getUint32(0,true),0xa5a5a5a5);return [r,true]}finally{x.cleanup()}});
}else throw Error('unknown case');
console.log(JSON.stringify({mode,which,groups:result.length,result}));
