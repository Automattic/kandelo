'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
assert.equal(process.version,'v26.13.0');
const mode=process.argv[2],which=process.argv[3],root=process.env.WASI_OWNER_TEST_REPO || path.resolve(__dirname,'../../../..');
let WASI;
if(mode==='native')({WASI}=require('node:wasi'));
else {
 const privateRoot=root;
 const bundle=fs.readFileSync(path.join(privateRoot,'third_party/node-core/node-core.js'),'utf8');
 const {values,create}=Function(bundle+'\nreturn {values:_createNodeValuesPlatform,create:_createNodeWasiPlatform};')();
 const binding=require(process.env.WASI_OWNER_COMPONENT);
 const getter=Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer').get;
 const Native=binding.initialize(memory=>new Uint8Array(Reflect.apply(getter,memory,[])));
 ({WASI}=create({native:{wasiConstructor:()=>Native},values:values({process,Buffer,util:require('node:util'),inspection:require('node:util'),os:{},signals:os.constants.signals})}));
}
const u=n=>{const a=[];do{const b=n&127;n>>>=7;a.push(b|(n?128:0))}while(n);return a};
const str=s=>{const a=Buffer.from(s);return [...u(a.length),...a]},sec=(id,a)=>[id,...u(a.length),...a];
function wasm(negative=false){
 const header=[0,97,115,109,1,0,0,0];
 if(negative)return new WebAssembly.Module(Uint8Array.from([...header,...sec(1,[2,96,2,127,127,1,127,96,0,1,127]),...sec(2,[1,...str('wasi_snapshot_preview1'),...str('args_sizes_get'),0,0]),...sec(3,[1,1]),...sec(5,[1,0,1]),...sec(7,[2,...str('run'),0,1,...str('memory'),2,0]),...sec(10,[1,8,0,65,127,65,0,16,0,11])]));
 const body=[0,65,0,65,4,16,0,26,65,7,16,1,11];
 return new WebAssembly.Module(Uint8Array.from([...header,...sec(1,[3,96,2,127,127,1,127,96,1,127,0,96,0,0]),...sec(2,[2,...str('wasi_snapshot_preview1'),...str('args_sizes_get'),0,0,...str('wasi_snapshot_preview1'),...str('proc_exit'),0,1]),...sec(3,[1,2]),...sec(5,[1,0,1]),...sec(7,[2,...str('_start'),0,2,...str('memory'),2,0]),...sec(10,[1,...u(body.length),...body])]));
}
const result=[];
const add=(label,fn)=>{fn();result.push(label)};
const err=(fn,code)=>assert.throws(fn,{code});
const make=options=>new WASI({version:'preview1',...options});
if(which==='lifecycle'){
 add('version-required',()=>err(()=>new WASI(), 'ERR_INVALID_ARG_TYPE'));
 add('version-unknown',()=>err(()=>new WASI({version:'nope'}),'ERR_INVALID_ARG_VALUE'));
 add('option-validation',()=>{err(()=>make({args:'x'}),'ERR_INVALID_ARG_TYPE');err(()=>make({stdin:-1}),'ERR_OUT_OF_RANGE');err(()=>make({returnOnExit:0}),'ERR_INVALID_ARG_TYPE')});
 add('slow-types-before-memory',()=>{const w=make();assert.equal(w.wasiImport.args_sizes_get(-1,0),28);assert.equal(w.wasiImport.args_sizes_get(),28);err(()=>w.wasiImport.args_sizes_get(0,4),'ERR_WASI_NOT_STARTED')});
 add('real-memory-required-retry',()=>{const w=make();err(()=>w.finalizeBindings({exports:{memory:{buffer:new ArrayBuffer(65536)}}}),'ERR_INVALID_ARG_TYPE');w.finalizeBindings({exports:{memory:new WebAssembly.Memory({initial:1})}});err(()=>w.finalizeBindings({exports:{}}),'ERR_WASI_ALREADY_STARTED')});
 add('start-and-return-exit',()=>{const w=make();let called=0;const value=w.start({exports:{memory:new WebAssembly.Memory({initial:1}),_start(){++called;w.wasiImport.proc_exit(42);++called}}});assert.equal(called,1);assert.equal(value,42);err(()=>w.start({exports:{}}),'ERR_WASI_ALREADY_STARTED')});
 add('start-validation-is-consumed',()=>{const w=make();err(()=>w.start({exports:{memory:new WebAssembly.Memory({initial:1}),_initialize(){}}}),'ERR_INVALID_ARG_TYPE');err(()=>w.initialize({exports:{}}),'ERR_WASI_ALREADY_STARTED')});
 add('initialize-real-callback',()=>{const w=make();let called=0;w.initialize({exports:{memory:new WebAssembly.Memory({initial:1}),_initialize(){called++}}});assert.equal(called,1)});
 add('user-error-preserved',()=>{const w=make(),e=new Error('real');assert.throws(()=>w.start({exports:{memory:new WebAssembly.Memory({initial:1}),_start(){throw e}}}),x=>x===e)});
 add('actual-import-object',()=>{for(const version of ['unstable','preview1']){const w=new WASI({version});assert.equal(w.getImportObject()[version==='unstable'?'wasi_unstable':'wasi_snapshot_preview1'],w.wasiImport);assert.equal(w.wasiImport.fd_write.name,'bound fd_write')}});
 add('actual-positive-Wasm-instance-start-exit',()=>{const w=make({args:['one']});const instance=new WebAssembly.Instance(wasm(),w.getImportObject());assert.equal(w.start(instance),7);assert.equal(new DataView(instance.exports.memory.buffer).getUint32(0,true),1)});
}else if(which==='direct-negative'){
 const w=make(),instance=new WebAssembly.Instance(wasm(true),w.getImportObject());w.finalizeBindings(instance);
 add('direct-JS-negative-remains-EINVAL',()=>assert.equal(w.wasiImport.args_sizes_get(-1,0),28));
 add('direct-Wasm-u32-negative-bitpattern',()=>assert.equal(instance.exports.run(),61));
}else if(which==='memory'){
 for(const shared of [false,true]){
  const memory=new WebAssembly.Memory({initial:1,maximum:3,shared}),w=make({args:['one','two\0tail','日本'],env:{A:'one',B:undefined,C:42}});w.initialize({exports:{memory}});let view=new DataView(memory.buffer),bytes=new Uint8Array(memory.buffer);
  add('args-sizes-'+shared,()=>{assert.equal(w.wasiImport.args_sizes_get(0,4),0);assert.equal(view.getUint32(0,true),3);assert.equal(view.getUint32(4,true),15)});
  add('args-actual-bytes-'+shared,()=>{assert.equal(w.wasiImport.args_get(16,100),0);assert.deepEqual(Buffer.from(bytes.subarray(100,115)),Buffer.from('one\0two\0日本\0'));assert.deepEqual([16,20,24].map(n=>view.getUint32(n,true)),[100,104,108])});
  add('env-actual-bytes-'+shared,()=>{assert.equal(w.wasiImport.environ_sizes_get(0,4),0);assert.equal(view.getUint32(0,true),2);assert.equal(w.wasiImport.environ_get(16,200),0);assert.equal(Buffer.from(bytes.subarray(200,211)).toString(),'A=one\0C=42\0')});
  add('bounds-and-unchanged-output-'+shared,()=>{view.setUint32(0,0xdeadbeef,true);assert.equal(w.wasiImport.args_sizes_get(0,65534),61);assert.equal(view.getUint32(0,true),0xdeadbeef);assert.equal(w.wasiImport.args_get(65532,100),61);assert.equal(w.wasiImport.args_sizes_get(-1,0),28)});
  add('memory-grow-refresh-'+shared,()=>{const old=memory.buffer;memory.grow(1);assert.equal(w.wasiImport.args_sizes_get(65536,65540),0);view=new DataView(memory.buffer);bytes=new Uint8Array(memory.buffer);assert.equal(view.getUint32(65536,true),3);assert.equal(old.byteLength,shared?65536:0)});
  add('clocks-random-yield-'+shared,()=>{assert.equal(w.wasiImport.clock_res_get(1,0),0);assert.equal(view.getBigUint64(0,true),1n);assert.equal(w.wasiImport.clock_time_get(1,0n,8),0);assert(view.getBigUint64(8,true)>0n);assert.equal(w.wasiImport.clock_time_get(99,0n,8),28);bytes.fill(0,300,900);assert.equal(w.wasiImport.random_get(300,600),0);assert(bytes.subarray(300,900).some(x=>x!==0));assert.equal(w.wasiImport.sched_yield(),0)});
 }
}else if(which==='fds'){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wasi-owner-')),file=path.join(directory,'file'),fd=fs.openSync(file,'w+');
 try{
  const memory=new WebAssembly.Memory({initial:1}),w=make({stdin:fd,stdout:fd,stderr:fd,preopens:{'/sandbox/../guest/':directory}});w.initialize({exports:{memory}});const b=new Uint8Array(memory.buffer),v=new DataView(memory.buffer),imp=w.wasiImport;
  add('fdstat-real-raw-flags-rights-padding',()=>{b.fill(0xab,0,24);assert.equal(imp.fd_fdstat_get(0,0),0);assert.equal(v.getUint8(0),4);assert.equal(v.getUint16(2,true),2);assert.equal(v.getBigUint64(8,true),148898303n);assert.equal(v.getBigUint64(16,true),0n);assert.equal(b[1],0xab);assert.equal(b[7],0xab)});
  add('preopen-cached-full-rights',()=>{assert.equal(imp.fd_fdstat_get(3,0),0);assert.equal(v.getUint8(0),3);assert.equal(v.getBigUint64(8,true),264240792n);assert.equal(v.getBigUint64(16,true),268435455n)});
  add('prestat-original-name-padding-errors',()=>{b.fill(0xab,32,64);assert.equal(imp.fd_prestat_get(3,32),0);assert.equal(v.getUint32(36,true),18);assert.equal(b[33],0xab);assert.equal(imp.fd_prestat_dir_name(3,64,17),42);assert.equal(imp.fd_prestat_dir_name(3,64,18),0);assert.equal(Buffer.from(b.subarray(64,82)).toString(),'/sandbox/../guest/');assert.equal(imp.fd_prestat_get(0,32),28);assert.equal(imp.fd_prestat_dir_name(0,64,20),8)});
  add('write-read-original-memory-vectors',()=>{b.set(Buffer.from('hello world'),256);v.setUint32(128,256,true);v.setUint32(132,6,true);v.setUint32(136,262,true);v.setUint32(140,5,true);assert.equal(imp.fd_write(1,128,2,160),0);assert.equal(v.getUint32(160,true),11);assert.equal(fs.readFileSync(file,'utf8'),'hello world');assert.equal(imp.fd_seek(0,0n,0,168),0);v.setUint32(128,300,true);v.setUint32(132,11,true);assert.equal(imp.fd_read(0,128,1,160),0);assert.equal(Buffer.from(b.subarray(300,311)).toString(),'hello world')});
  add('positioned-preserves-offset',()=>{assert.equal(imp.fd_pwrite(1,128,1,1n,160),0);assert.equal(imp.fd_tell(0,168),0);assert.equal(v.getBigUint64(168,true),11n);assert.equal(imp.fd_pread(0,128,1,0n,160),0);assert.equal(imp.fd_pread(0,128,1,1n<<63n,160),28)});
  add('io-bounds-before-fd-errors',()=>{v.setUint32(128,65530,true);v.setUint32(132,20,true);assert.equal(imp.fd_read(999,128,1,160),61);v.setUint32(132,0,true);assert.equal(imp.fd_read(999,128,0,160),8);assert.equal(imp.fd_read(0,128,0,160),0);assert.equal(v.getUint32(160,true),0)});
  add('filestat-real-size-padding',()=>{b.fill(0xab,512,576);assert.equal(imp.fd_filestat_get(0,512),0);assert.equal(v.getUint8(528),4);assert.equal(b[529],0xab);assert.equal(v.getBigUint64(544,true),BigInt(fs.statSync(file).size));assert.equal(imp.fd_filestat_set_size(1,3n),0);assert.equal(fs.statSync(file).size,3)});
  add('sync-and-flags',()=>{assert.equal(imp.fd_sync(1),0);assert.equal(imp.fd_datasync(1),0);assert.equal(imp.fd_fdstat_set_flags(1,1),0);assert.equal(imp.fd_fdstat_get(1,0),0);assert(v.getUint16(2,true)&fs.constants.O_APPEND);assert.equal(imp.fd_fdstat_set_flags(1,0),0)});
  add('monotonic-rights-not-masked-by-import-subset',()=>{assert.equal(imp.fd_fdstat_set_rights(0,0n,0n),0);assert.equal(imp.fd_read(0,128,0,160),76);assert.equal(imp.fd_fdstat_set_rights(0,2n,0n),76);assert.equal(imp.fd_fdstat_get(0,0),0);assert.equal(v.getBigUint64(8,true),0n)});
  add('real-close-table-removal',()=>{assert.equal(imp.fd_close(3),0);assert.equal(imp.fd_close(3),8);assert.equal(imp.fd_prestat_get(3,32),8);assert.equal(imp.fd_close(1),0);assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'})});
  add('constructor-native-errors',()=>{assert.throws(()=>make({stdin:999999}),{code:'UVWASI_EBADF',errno:8,syscall:'uvwasi_init'});assert.throws(()=>make({preopens:{'/bad':file}}),{code:'UVWASI_ENOTDIR',errno:54,syscall:'uvwasi_init'})});
 }finally{try{fs.closeSync(fd)}catch{}fs.rmSync(directory,{recursive:true,force:true})}
}else throw Error('unknown case');
console.log(JSON.stringify({mode,which,passed:result.length,cases:result}));
