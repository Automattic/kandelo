'use strict';
// Full pinned public/codec source over actual native26 descriptor/allocation
// dependencies. This fixture does not execute guest JSAPI/libc/kernel code.
const nativeFs=require('node:fs'),util=require('node:util'),os=require('node:os'),path=require('node:path');
const {fileURLToPath}=require('node:url');
const globals=['internalBinding','primordials'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
const {internalBinding}=require('internal/test/binding');
for(const [key,d] of globals){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}
const raw=internalBinding('fs'),uv=internalBinding('uv');
const text=nativeFs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(text+';return {stats:_createNodeFsStats,errors:_createNodeFsSystemErrors,sync:_createNodeFileSync};')();
exports.create=function create({fsObject,publicBuffer}={}){
 const bytes=require('./node-buffer-pool.cjs').create(),{values,codecs,allocator}=bytes;
 const Buffer=publicBuffer||bytes.Buffer;
 const fs=fsObject||{...nativeFs},calls=[];
 const errors=factories.errors({uv:{binding:uv,getSystemErrorName:util.getSystemErrorName},codecs});
 const truncation={vfsState:{handlers:null},makeError:(status,syscall,path)=>errors.fromStatus(status,syscall,path)};
 const utils=factories.stats({fs,process,Buffer,types:util.types,values,truncation,native:{},permissionEnabled:()=>false,toPathIfFileURL:value=>value instanceof URL?fileURLToPath(value):value});
 function status(fn){try{return fn()}catch(error){if(typeof error.errno!=='number')throw error;return error.errno;}}
 const native={
  fsOpenSync(name,flags,mode){calls.push(['open',name]);return status(()=>raw.open(name,flags,mode));},
  fsIoSync(writing,fd,buffer,offset,length,position){
   calls.push([writing?'write':'read',fd]);
   return status(()=>{
    // Generic native read/write bindings enforce public nonnegative fds.
    // The target UTF8 binding instead sends signed fds to actual POSIX I/O.
    // Exercise that real native path for the negative-fd differential.
    if(fd<0)return writing?raw.writeFileUtf8(fd,globalThis.Buffer.from(buffer.buffer,buffer.byteOffset+offset,length).toString('utf8'),0,0o666):raw.readFileUtf8(fd,0);
    if(!writing)return raw.read(fd,buffer,offset,length,position);
    const context={},count=raw.writeBuffer(fd,buffer,offset,length,position,undefined,context);
    return context.errno??count;
   });
  },
  fsStatSync(fd,follow,bigint){calls.push(['fstat',fd]);return status(()=>raw.fstat(fd,bigint));},
  closeDescriptor(fd){calls.push(['close',fd]);return status(()=>{raw.close(fd);return 0});},
 };
 const api=factories.sync({fs,Buffer,values,utils,types:util.types,truncation,native,codecs,allocator});
 Object.assign(fs,api);return {api,fs,Buffer,codecs,allocator,calls,truncation};
};
if(process.env.KANDELO_FILE_SYNC_PRELOAD==='1'){
 exports.create({fsObject:nativeFs,publicBuffer:globalThis.Buffer});require('node:module').syncBuiltinESMExports();
}
