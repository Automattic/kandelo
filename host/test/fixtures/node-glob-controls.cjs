'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const normalize=value=>typeof value==='string'?value.replaceAll('\\','/'):{name:value.name,parentPath:value.parentPath,
 file:value.isFile(),directory:value.isDirectory(),symlink:value.isSymbolicLink(),constructor:value.constructor.name,
 ownKeys:Reflect.ownKeys(value).filter(k=>typeof k==='string'),directoryDescriptor:Object.getOwnPropertyDescriptor(value,'parentPath')};
let currentRoot;
async function fixture(fn){if(currentRoot)return fn(currentRoot);const root=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-glob-'));
 try{fs.mkdirSync(path.join(root,'dir','nested'),{recursive:true});fs.mkdirSync(path.join(root,'other'));
  for(const name of ['one.txt','one.js','.hidden','dir/two.txt','dir/nested/three.txt','other/four.js'])fs.writeFileSync(path.join(root,name),name);
  fs.symlinkSync('dir',path.join(root,'alias'));fs.symlinkSync('..',path.join(root,'dir','loop'));fs.symlinkSync('missing',path.join(root,'dangling'));
  return await fn(root);
 }finally{fs.rmSync(root,{recursive:true,force:true});}}
async function collect(iterator){const result=[];for await(const value of iterator)result.push(normalize(value));return result;}
function callback(fn,pattern,options){return new Promise((resolve,reject)=>fn(pattern,options,(error,values)=>error?reject(error):resolve(values.map(normalize))));}
function errorValue(error){return {name:error.name,code:error.code,message:error.message};}
exports.patterns=owner=>fixture(async root=>{
 const output=[];for(const pattern of ['**/*.txt','*','**','{one,dir/two}.txt',['**/*.txt','one.*'],'missing*']){
  const options={cwd:root};output.push(owner.api.globSync(pattern,options).map(normalize));
  output.push(await collect(owner.promises.glob(pattern,options)));output.push(await callback(owner.api.glob,pattern,options));
 }return output;
});
exports.exclusions=owner=>fixture(async root=>{
 const output=[];for(const exclude of [['dir/**'],['**/*.txt'],name=>name.includes('other')]){
  output.push(owner.api.globSync('**',{cwd:root,exclude}));output.push(await collect(owner.promises.glob('**',{cwd:root,exclude})));
 }return output;
});
exports.dirents=owner=>fixture(async root=>{
 const options={cwd:root,withFileTypes:true,exclude:entry=>entry.name==='other'};
 return [owner.api.globSync('**',options).map(normalize),await collect(owner.promises.glob('**',options)),await callback(owner.api.glob,'**',options)];
});
exports.depthAndSymlinks=owner=>fixture(async root=>{
 const output=[];for(const options of [{maxDepth:0},{maxDepth:1},{maxDepth:2},{maxDepth:2,followSymlinks:true}]){
  output.push(owner.api.globSync('**',{cwd:root,...options}));output.push(await collect(owner.promises.glob('**',{cwd:root,...options})));
 }return output;
});
exports.urlAndEarlyReturn=owner=>fixture(async root=>{
 const output=[owner.api.globSync('**/*.txt',{cwd:pathToFileURL(root+path.sep)})];
 const iterator=owner.promises.glob('**',{cwd:root});const first=await iterator.next();output.push({done:first.done,value:normalize(first.value)});
 output.push(await iterator.return());output.push(await iterator.next());return output;
});
exports.validation=owner=>fixture(async root=>{
 const output=[];for(const [pattern,options]of [[42,{}],[null,{}],['*',null],['*',{exclude:42}],['*',{followSymlinks:42}],['*',{maxDepth:-1}],['*',{cwd:root,maxDepth:1.5}]]){
  try{owner.api.globSync(pattern,options);output.push('accepted');}catch(error){output.push(errorValue(error));}
  try{await collect(owner.promises.glob(pattern,options));output.push('accepted');}catch(error){output.push(errorValue(error));}
 }
 for(const args of [['*'],['*',{}],['*',{},42]])try{owner.api.glob(...args);output.push('accepted');}catch(error){output.push(errorValue(error));}
 return output;
});
exports.descriptors=owner=>['glob','globSync'].map(name=>({name:owner.api[name].name,length:owner.api[name].length,keys:Reflect.ownKeys(owner.api[name]).filter(k=>typeof k==='string')}));
Object.defineProperty(exports,'compare',{value:async function(run,candidate,native){return fixture(async root=>{currentRoot=root;try{return [await run(candidate),await run(native)];}finally{currentRoot=undefined;}});}});
