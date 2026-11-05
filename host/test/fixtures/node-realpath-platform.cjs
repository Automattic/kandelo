'use strict';
// Actual selected realpath/Stats/error policies; native Node supplies the
// POSIX bindings, FS requests, scheduler and filesystem metadata boundaries.
const fs = require('node:fs'),util=require('node:util'),path=require('node:path');
const { fileURLToPath }=require('node:url');
const globals=['internalBinding','primordials'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
const {internalBinding}=require('internal/test/binding');
for(const [key,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
const nativeFs=internalBinding('fs');
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {realpath:_createNodeRealpathPlatform,stats:_createNodeFsStats};')();
exports.create=function(){
 const base=require('./node-path-metadata-platform.cjs').create();
 const target={...fs,promises:{...fs.promises}};
 const convertPath=require('./node-url-path-platform.cjs').create().toPathIfFileURL;
 const native={
  fsStatSync(name,follow,bigint){try{return nativeFs[follow?'stat':'lstat'](name,bigint,undefined,true);}catch(error){if(typeof error.errno!=='number')throw error;return error.errno;}},
  fsMetadataSync(name,path,_first,_second,convert){
   let bytes;try{bytes=nativeFs[name](path,'buffer');}catch(error){if(typeof error.errno!=='number')throw error;return error.errno;}
   return convert(bytes);
  },
  fsMetadataPromise(name,path,_first,_second,request,convert){
   if(typeof request==='function')return nativeFs[name](path,'buffer',nativeFs.kUsePromises).then(convert);
   const complete=request.oncomplete;
   request.oncomplete=function(error,bytes){
    if(error)return Reflect.apply(complete,this,[error]);
    let value;try{value=convert(bytes);}catch(error){return Reflect.apply(complete,this,[error]);}
    return Reflect.apply(complete,this,[null,value]);
   };
   return nativeFs[name](path,'buffer',request);
  },
 };
 const utils=factories.stats({fs:target,process,Buffer,types:util.types,values:base.values,truncation:base.truncation,
  native,throwErrno:(errno,syscall,path)=>{throw base.truncation.makeError(-errno,syscall,path);},permissionEnabled:()=>false,toPathIfFileURL:convertPath});
 const owner=factories.realpath({fs:target,process,path,Buffer,values:base.values,utils,truncation:base.truncation,native,
  codecs:{copyBytes:bytes=>Buffer.from(bytes),decodeBytes:(bytes,encoding)=>Buffer.from(bytes).toString(encoding||'utf8')},
  toPathIfFileURL:convertPath,permission:{isEnabled:()=>false}});
 Object.assign(target,owner.api);Object.assign(target.promises,owner.promises);
 return {api:target,promises:target.promises,utils,publicAPI:owner.api,publicPromises:owner.promises,toPathIfFileURL:convertPath};
};
if(process.env.KANDELO_REALPATH_PRELOAD==='1'){
 const owner=exports.create();Object.assign(fs,owner.publicAPI);Object.assign(fs.promises,owner.publicPromises);
 require('node:module').syncBuiltinESMExports();
}
