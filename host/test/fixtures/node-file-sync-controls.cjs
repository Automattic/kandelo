'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function root(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-sync-file-'));try{return run(dir)}finally{fs.rmSync(dir,{recursive:true,force:true})}}
function failure(run,dir){try{return {value:run()}}catch(e){return {name:e.name,code:e.code,syscall:e.syscall,path:e.path?.replaceAll(dir,'$ROOT'),message:e.message.replaceAll(dir,'$ROOT')}}}
exports.controls={
 encodingsModesAndImmutableOptions(api){return root(dir=>{
  const out=[];for(const [i,data,options] of [[0,'hé\ud800',{encoding:'utf8'}],[1,'ff0081',{encoding:'hex'}],[2,'€',{encoding:'utf16le'}],[3,new DataView(new Uint8Array([0,1,2,0]).buffer,1,2),{}],[4,new Uint16Array([0x1234]),{}],[5,'',{mode:0}]]){
   const file=path.join(dir,String(i));api.writeFileSync(file,data,options);const mode=fs.statSync(file).mode&0o777;
   if(!mode)fs.chmodSync(file,0o600);out.push([fs.readFileSync(file).toString('hex'),mode]);
  }
  const file=path.join(dir,'append'),options=Object.freeze({encoding:'hex',mode:0o600});api.writeFileSync(file,'61',{encoding:'hex'});api.appendFileSync(file,'62',options);
  out.push(fs.readFileSync(file).toString('hex'),options);return out;
 });},
 descriptorsFlagsAndOffsets(api){return root(dir=>{
  const file=path.join(dir,'file');fs.writeFileSync(file,'abcdef');const fd=fs.openSync(file,'r+');
  try{
   fs.readSync(fd,Buffer.alloc(2),0,2,null);api.writeFileSync(fd,'XY');api.appendFileSync(fd,new Uint8Array([90]),{flush:true});
   assert(fs.fstatSync(fd).isFile());const text=api.readFileSync(fd,'utf8');assert.equal(text,'f');
   return [text,fs.readFileSync(file,'utf8'),fs.fstatSync(fd).isFile()];
  }finally{fs.closeSync(fd)}
 });},
 readsBytesBuffersAndFactories(api){return root(dir=>{
  const file=path.join(dir,'file');const bytes=Buffer.concat([Buffer.alloc(8191,0x61),Buffer.from('😀\ufeffx\0'),Buffer.from([0xe2,0x82])]);fs.writeFileSync(file,bytes);
  const text=api.readFileSync(file,'utf8');assert.equal(text,bytes.toString('utf8'));
  const chosen=Buffer.alloc(bytes.length+10,0x71),calls=[];
  const view=api.readFileSync(new URL('file://'+file),{buffer:size=>{calls.push(size);return new DataView(chosen.buffer,chosen.byteOffset,chosen.length)}});
  assert.equal(view.buffer,chosen.buffer);assert.deepEqual(Buffer.from(view),bytes);
  const result=[text,calls,chosen.subarray(bytes.length).toString('hex')];
  result.push(failure(()=>api.readFileSync(file,{buffer:Buffer.alloc(2)}),dir));return result;
 });},
 errorsValidationAndFdRetention(api){return root(dir=>{
  const missing=path.join(dir,'missing','file'),file=path.join(dir,'file');fs.writeFileSync(file,'data');
  const rows=[failure(()=>api.readFileSync(missing,'utf8'),dir),failure(()=>api.writeFileSync(missing,'x'),dir),failure(()=>api.readFileSync(dir,'utf8'),dir),failure(()=>api.writeFileSync(dir,'x'),dir),failure(()=>api.readFileSync(-1),dir),failure(()=>api.readFileSync(-1,'utf8'),dir),failure(()=>api.writeFileSync(-1,'x'),dir)];
  for(const data of [{toString(){throw Error('coercion must not run')}},null,1])rows.push(failure(()=>api.writeFileSync(file,data),dir));
  rows.push(failure(()=>api.writeFileSync(file,'x',{flush:'yes'}),dir),failure(()=>api.writeFileSync(file,'x',{flag:'bad'}),dir));
  const fd=fs.openSync(file,'r');try{rows.push(failure(()=>api.writeFileSync(fd,'x'),dir));assert(fs.fstatSync(fd).isFile())}finally{fs.closeSync(fd)}
  assert.equal(fs.readFileSync(file,'utf8'),'data');return rows;
 });},
};
