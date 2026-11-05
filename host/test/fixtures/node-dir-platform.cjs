'use strict';
// Actual public Dir/private byte owners, with Node native persistent cursors
// and requests substituted explicitly. No guest JSAPI/GC/ref claim.
const fs=require('node:fs'),path=require('node:path');
const {internalBinding}=require('internal/test/binding');
const dirs=internalBinding('fs_dir'),nativeRead=dirs.DirHandle.prototype.read,nativeClose=dirs.DirHandle.prototype.close;
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const create=Function(source+';return _createNodeDirPlatform;')();
exports.create=function(options={}) {
 const environment=require('./node-readdir-platform.cjs').create(options);
 const {truncation,values,utils,bytes}=environment;
 const native={
  fsDirOpen(path,prototype,request) {
   const adopt=owner=>Object.setPrototypeOf(owner,prototype);
   if(request===undefined) {
    try{return adopt(dirs.opendirSync(path));}catch(error){if(typeof error.errno!=='number')throw error;return error.errno;}
   }
   const complete=request.oncomplete;
   request.oncomplete=function(error,handle){return Reflect.apply(complete,this,error?[error]:[null,adopt(handle)]);};
   return dirs.opendir(path,'buffer',request);
  },
  fsDirRead(owner,maximum,request,convert) {
   if(request===undefined) {
    let packet;try{packet=Reflect.apply(nativeRead,owner,['buffer',maximum]);}catch(error){if(typeof error.errno!=='number')throw error;packet=error.errno;}
    return convert(packet);
   }
   const complete=request.oncomplete;
   request.oncomplete=function(error,packet){
    if(error)return Reflect.apply(complete,this,[error]);
    let value;try{value=convert(packet);}catch(error){return Reflect.apply(complete,this,[error]);}
    return Reflect.apply(complete,this,[null,value]);
   };
   return Reflect.apply(nativeRead,owner,['buffer',maximum,request]);
  },
  fsDirClose(owner,request) {
   try{return Reflect.apply(nativeClose,owner,request===undefined?[]:[request]);}
   catch(error){if(typeof error.errno!=='number')throw error;return error.errno;}
  },
 };
 const platform=create({process,path,Buffer:bytes.Buffer,values,utils,truncation,
  dirents:environment.utilities,codecs:options.codecs??bytes.codecs,native});
 return {...platform,environment};
};
