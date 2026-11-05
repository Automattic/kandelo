'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),util=require('node:util');
const target=require('../../../packages/registry/node-compat/target.json');assert.equal(process.versions.node,target.version);
const fixture=require('./node-dir-platform.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'node26-dir-'));
function error(fn){try{const value=fn();return{value};}catch(e){return{name:e.name,code:e.code,message:e.message,errno:e.errno,syscall:e.syscall,path:e.path};}}
function entry(d){return d===null?null:{name:typeof d.name==='string'?d.name:Buffer.from(d.name).toString('hex'),parent:typeof d.parentPath==='string'?d.parentPath:Buffer.from(d.parentPath).toString('hex'),kind:[d.isFile(),d.isDirectory(),d.isSymbolicLink(),d.isFIFO()]};}
async function all(dir){const out=[];for await(const d of dir)out.push(entry(d));return out;}
const cases={
 sync(){const c=fixture.create();for(const encoding of ['utf8','buffer','latin1'])for(const size of [1,2,32]){
  const a=c.api.opendirSync(root,{encoding,bufferSize:size}),b=fs.opendirSync(root,{encoding,bufferSize:size});
  try{assert.equal(a.path,b.path);let x,y;do{x=a.readSync();y=b.readSync();assert.deepEqual(entry(x),entry(y));}while(x!==null);assert.equal(a.readSync(),null);}finally{a.closeSync();b.closeSync();}
  assert.deepEqual(error(()=>a.readSync()),error(()=>b.readSync()));assert.deepEqual(error(()=>a.closeSync()),error(()=>b.closeSync()));
 }},
 async queued(){const c=fixture.create();async function run(api){const d=await util.promisify(api.opendir)(root,{bufferSize:1});const trace=[];
  const calls=[0,1,2].map(i=>new Promise((resolve,reject)=>d.read((e,value)=>{if(e)return reject(e);trace.push([i,entry(value)]);resolve();})));
  const concurrent=error(()=>d.readSync());assert.equal(concurrent.code,'ERR_DIR_CONCURRENT_OPERATION');
  const closed=new Promise((resolve,reject)=>d.close(e=>e?reject(e):resolve()));await Promise.all(calls);await closed;return{trace,concurrent,closed:error(()=>d.readSync())};}
  assert.deepEqual(await run(c.api),await run(fs));
 },
 async iterator(){const c=fixture.create();for(const recursive of [false,true]){
  const a=await c.promises.opendir(root,{recursive,bufferSize:1}),b=await fs.promises.opendir(root,{recursive,bufferSize:1});
  assert.deepEqual(await all(a),await all(b));assert.deepEqual(error(()=>a.readSync()),error(()=>b.readSync()));
 }
 const a=await c.promises.opendir(root),b=await fs.promises.opendir(root);for await(const d of a)break;for await(const d of b)break;
 assert.deepEqual(error(()=>a.readSync()),error(()=>b.readSync()));
 },
 async dispose(){const c=fixture.create();const a=c.api.opendirSync(root),b=fs.opendirSync(root);
 for(const key of ['read','readSync','close','closeSync','entries',Symbol.asyncIterator,Symbol.dispose,Symbol.asyncDispose]){
  const x=Object.getOwnPropertyDescriptor(c.api.Dir.prototype,key),y=Object.getOwnPropertyDescriptor(fs.Dir.prototype,key);
  for(const flag of ['enumerable','configurable','writable'])assert.equal(x[flag],y[flag]);assert.equal(x.value.name,y.value.name);assert.equal(x.value.length,y.value.length);
 }
 assert.deepEqual(error(()=>Reflect.get(c.api.Dir.prototype,'path',{})),error(()=>Reflect.get(fs.Dir.prototype,'path',{})));
 a[Symbol.dispose]();b[Symbol.dispose]();a[Symbol.dispose]();b[Symbol.dispose]();
 const x=await c.promises.opendir(root),y=await fs.promises.opendir(root);await x[Symbol.asyncDispose]();await y[Symbol.asyncDispose]();await x[Symbol.asyncDispose]();await y[Symbol.asyncDispose]();
 assert.deepEqual(error(()=>x.readSync()),error(()=>y.readSync()));
 },
 async validation(){const c=fixture.create();for(const bad of [null,{},[],1])assert.deepEqual(error(()=>c.api.opendirSync(bad)),error(()=>fs.opendirSync(bad)));
 for(const options of [{bufferSize:0},{bufferSize:-1},{bufferSize:1.5},{encoding:'bad'}])assert.deepEqual(error(()=>c.api.opendirSync(root,options)),error(()=>fs.opendirSync(root,options)));
 for(const p of [path.join(root,'absent'),path.join(root,'a')]){
  assert.deepEqual(error(()=>c.api.opendirSync(p)),error(()=>fs.opendirSync(p)));
  async function result(api){try{await util.promisify(api.opendir)(p);throw Error('unexpected open');}catch(e){return{name:e.name,code:e.code,message:e.message,errno:e.errno,syscall:e.syscall,path:e.path};}}
  assert.deepEqual(await result(c.api),await result(fs));
 }
 assert.deepEqual(error(()=>c.api.opendir(root,null)),error(()=>fs.opendir(root,null)));
 },
 async conversion(){const normal=fixture.create();const expected=Error('private byte conversion failed');const c=fixture.create({codecs:{...normal.environment.bytes.codecs,decodeBytes(){throw expected;}}});
 const d=await c.promises.opendir(root,{bufferSize:1});
 try{await assert.rejects(d.read(),e=>e===expected);}finally{await d.close();}
 },
};
fs.writeFileSync(path.join(root,'a'),'a');fs.writeFileSync(path.join(root,'€😀'),'utf8');fs.mkdirSync(path.join(root,'sub'));fs.writeFileSync(path.join(root,'sub','leaf'),'leaf');fs.symlinkSync('a',path.join(root,'link'));
Promise.resolve().then(()=>{const name=process.argv[2];assert(Object.hasOwn(cases,name));return cases[name]();}).then(()=>console.log('PASS',process.argv[2])).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
