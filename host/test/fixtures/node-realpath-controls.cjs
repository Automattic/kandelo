'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),url=require('node:url');
let activeRoot;
async function fixture(fn){if(activeRoot)return await fn(activeRoot);const root=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-realpath-control-'));try{
 fs.mkdirSync(path.join(root,'dir'));fs.writeFileSync(path.join(root,'dir','file'),'actual');
 fs.symlinkSync('dir/file',path.join(root,'link'));fs.symlinkSync('link',path.join(root,'chain'));
 fs.symlinkSync('missing',path.join(root,'dangling'));fs.symlinkSync('loop',path.join(root,'loop'));
 return await fn(root);
}finally{fs.rmSync(root,{recursive:true,force:true});}}
function outcome(fn,root){try{const value=fn();return {value:Buffer.isBuffer(value)?{hex:value.toString('hex').replace(Buffer.from(root).toString('hex'),'<ROOTHEX>')}:typeof value==='string'?value.replace(root,'<ROOT>').replace(fs.realpathSync(root),'<REALROOT>'):value};}catch(error){return errorValue(error,root);}}
function errorValue(error,root){return {name:error.name,code:error.code,errno:error.errno,syscall:error.syscall,path:typeof error.path==='string'?error.path.replace(root,'<ROOT>'):error.path,message:error.message.replaceAll(root,'<ROOT>')};}
function callback(fn,args,root){return new Promise(resolve=>fn(...args,(error,value)=>resolve(error?errorValue(error,root):outcome(()=>value,root))));}
exports.syncResolution=owner=>fixture(async root=>['realpathSync','native'].flatMap(kind=>{
 const fn=kind==='native'?owner.api.realpathSync.native:owner.api.realpathSync;
 return ['dir/file','link','chain','.','dangling','loop','missing'].map(name=>outcome(()=>fn(path.join(root,name)),root));
}));
exports.encodingsAndURLs=owner=>fixture(async root=>{
 const input=path.join(root,'chain');return [owner.api.realpathSync,owner.api.realpathSync.native].flatMap(fn=>[
  outcome(()=>fn(Buffer.from(input),{encoding:'buffer'}),root),outcome(()=>fn(url.pathToFileURL(input)),root),
  outcome(()=>fn(input,'hex'),root),outcome(()=>fn(input,{encoding:'base64'}),root),
 ]);
});
exports.readlink=owner=>fixture(async root=>{
 const result=[];for(const input of ['link','chain','dangling','loop','dir/file','missing']){
  const name=path.join(root,input);result.push(outcome(()=>owner.api.readlinkSync(name),root));
  result.push(outcome(()=>owner.api.readlinkSync(Buffer.from(name),'buffer'),root));
  result.push(await callback(owner.api.readlink,[name],root));
  try{result.push(outcome(()=>undefined,root),await owner.promises.readlink(name,'hex'));}catch(error){result.push(errorValue(error,root));}
 }return result;
});
exports.asyncResolution=owner=>fixture(async root=>{
 const result=[];for(const input of ['dir/file','link','chain','dangling','loop','missing']){
  const name=path.join(root,input);result.push(await callback(owner.api.realpath,[name],root));
  result.push(await callback(owner.api.realpath.native,[name,{encoding:'buffer'}],root));
  try{const value=await owner.promises.realpath(name,'buffer');result.push(outcome(()=>value,root));}catch(error){result.push(errorValue(error,root));}
 }return result;
});
exports.urlPredicateAndPrivateConsumer=owner=>fixture(async root=>{
 const input=url.pathToFileURL(path.join(root,'chain'));
 const like={href:input.href,protocol:input.protocol,pathname:input.pathname,hostname:input.hostname};
 const records=[outcome(()=>owner.api.realpathSync(like),root),outcome(()=>owner.api.realpathSync.native(like),root)];
 const original=url.fileURLToPath;
 try{
  url.fileURLToPath=()=>path.join(root,'must-not-be-used');
  records.push(outcome(()=>owner.api.realpathSync(input),root));
  records.push(outcome(()=>owner.api.realpathSync.native(input),root));
  records.push(await callback(owner.api.realpath,[input],root));
 }finally{url.fileURLToPath=original;}
 return records;
});
exports.validation=owner=>fixture(async root=>{
 const result=[];for(const fn of [owner.api.realpathSync,owner.api.realpathSync.native,owner.api.readlinkSync])
  for(const args of [[42],[null],[{}],['a\0b'],[root,{encoding:'bogus'}],[root,42]])result.push(outcome(()=>fn(...args),root));
 for(const fn of [owner.api.realpath,owner.api.realpath.native,owner.api.readlink])
  for(const args of [[root],[root,{}],[root,{},42]])result.push(outcome(()=>fn(...args),root));
 return result;
});
exports.descriptors=owner=>{
 const output={};for(const key of ['realpath','realpathSync','readlink','readlinkSync']){
  const fn=owner.api[key];output[key]={name:fn.name,length:fn.length,keys:Object.keys(fn),native:typeof fn.native};
  if(fn.native){const d=Object.getOwnPropertyDescriptor(fn,'native');output[key].nativeDescriptor={writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,length:fn.native.length,name:fn.native.name};}
 }return output;
};
exports.ordering=owner=>fixture(async root=>{
 const result=[];await new Promise(resolve=>{owner.api.realpath(path.join(root,'link'),()=>{result.push('callback');resolve();});result.push('sync');Promise.resolve().then(()=>result.push('promise'));});return result;
});

Object.defineProperty(exports,'compare',{value:async function compare(run,candidate,native){
 return fixture(async root=>{activeRoot=root;try{return [await run(candidate),await run(native)];}finally{activeRoot=undefined;}});
}});
