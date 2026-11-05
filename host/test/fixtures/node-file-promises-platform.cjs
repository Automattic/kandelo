'use strict';
// Pinned public FileHandle/promise algorithms with actual native26 jobs, fds,
// promises, callbacks and resources as explicit control dependencies.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const {fileURLToPath}=require('node:url');
const globals=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
const {internalBinding}=require('internal/test/binding');
for(const [k,d] of globals){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
const raw=internalBinding('fs'),uv=internalBinding('uv');
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,stats:_createNodeFsStats,errors:_createNodeFsSystemErrors,jobs:_createNodeFileJobs,handles:_createNodeFileHandlePlatform};')();
const readJobRun=raw.ReadFileJob.prototype.run,writeJobRun=raw.WriteFileJob.prototype.run;
exports.create=function create(){
 const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
 const errors=factories.errors({uv:{binding:uv,getSystemErrorName:util.getSystemErrorName},codecs:{decodeBytes:b=>Buffer.from(b).toString('utf8')}});
 const truncation={vfsState:{handlers:null},makeError:(status,syscall,path)=>errors.fromStatus(status,syscall,path)};
 const utils=factories.stats({fs,process,Buffer,types:util.types,values,truncation,native:{},permissionEnabled:()=>false,toPathIfFileURL:value=>value instanceof URL?fileURLToPath(value):value});
 const jobs=new WeakMap(),calls=[];
 const jobBoundary={
  createReadFileJob(prototype,path,flags,limit,trackFd,complete){
   const job=new raw.ReadFileJob(path,flags,limit,trackFd);Object.setPrototypeOf(job,prototype);jobs.set(job,{path,complete});calls.push(['readJob']);return job;
  },
  runReadFileJob(job){const record=jobs.get(job),done=job.ondone;job.ondone=function(error,buffer,fd,size,closeError){job.ondone=done;return record.complete.call(job,error?.errno||0,error?.syscall||'read',[buffer,fd,size,closeError?.errno||0],error?.path)};return readJobRun.call(job,record.path);},
  createWriteFileJob(prototype,path,flags,mode,data,complete){
   const job=new raw.WriteFileJob(path,flags,mode,data);Object.setPrototypeOf(job,prototype);jobs.set(job,{path,complete});calls.push(['writeJob']);return job;
  },
  runWriteFileJob(job){const record=jobs.get(job),done=job.ondone;job.ondone=function(error){job.ondone=done;return record.complete.call(job,error?.errno||0,error?.syscall||'write',undefined,error?.path)};return writeJobRun.call(job,record.path);},
 };
 const fileJobs=factories.jobs({Buffer,truncation,native:jobBoundary});
 const native={
  adoptFileHandle(fd){calls.push(['adopt',fd]);return new raw.FileHandle(fd)},
  fsOpenPromise(path,flags,mode){calls.push(['open',path]);return raw.openFileHandle(path,flags,mode,raw.kUsePromises)},
  fsIoPromise(writing,fd,buffer,offset,length,position){calls.push([writing?'write':'read',fd]);return writing?raw.writeBuffer(fd,buffer,offset,length,position,raw.kUsePromises):raw.read(fd,buffer,offset,length,position,raw.kUsePromises)},
  fsVectorPromise(writing,fd,buffers,position){return (writing?raw.writeBuffers:raw.readBuffers)(fd,buffers,position,raw.kUsePromises)},
  fsStatPromise(fdOrPath,bigint,_request,follow=true,throwIfNoEntry=true){return typeof fdOrPath==='number'?raw.fstat(fdOrPath,bigint,raw.kUsePromises):(follow?raw.stat:raw.lstat)(fdOrPath,bigint,raw.kUsePromises,throwIfNoEntry)},
  fsControlPromise(name,fd,first,second){calls.push([name,fd]);const args=['fsync','fdatasync'].includes(name)?[fd]:['ftruncate','fchmod'].includes(name)?[fd,first]:[fd,first,second];return raw[name](...args,raw.kUsePromises)},
 };
 const api=factories.handles({fs,process,Buffer,events:require('node:events'),path,types:util.types,values,native,truncation,utils,fileJobs,getStringDecoder:require('node:string_decoder').StringDecoder,permissionEnabled:()=>false,require:name=>require(name)});
 return {api,calls};
};
if(process.env.KANDELO_FILE_PROMISES_PRELOAD==='1'){
 const {api}=exports.create();Object.assign(fs.promises,{open:api.open,readFile:api.readFile,writeFile:api.writeFile,appendFile:api.appendFile});require('node:module').syncBuiltinESMExports();
}
