'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const saved=['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
const {internalBinding}=require('internal/test/binding');
for(const [k,d] of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
const native=internalBinding('fs'),uv=internalBinding('uv'),nativeRun=native.WriteFileJob.prototype.run;
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,stats:_createNodeFsStats,errors:_createNodeFsSystemErrors,jobs:_createNodeFileJobs,callbacks:_createNodeFsCallbacks};')();
exports.create=function create({fsObject}={}){
  const subject=fsObject||{...fs};
  const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
  const errors=factories.errors({uv:{binding:uv,getSystemErrorName:util.getSystemErrorName},
    codecs:{decodeBytes:bytes=>Buffer.from(bytes).toString('utf8')}});
  const truncation={vfsState:{handlers:null},FSReqCallback:native.FSReqCallback,
    makeError:(status,syscall,path)=>errors.fromStatus(status,syscall,path)};
  const utils=factories.stats({fs:subject,process,Buffer,types:util.types,values,truncation,native:{},
    permissionEnabled:()=>false,toPathIfFileURL:value=>value instanceof URL?require('node:url').fileURLToPath(value):value});
  const jobs=new WeakMap();
  const jobBoundary={
    createWriteFileJob(prototype,path,flags,mode,data,complete){
      const job=new native.WriteFileJob(path,flags,mode,data);
      Object.setPrototypeOf(job,prototype);jobs.set(job,{path,complete});return job;
    },
    runWriteFileJob(job){
      const state=jobs.get(job),done=job.ondone;
      job.ondone=function(error){job.ondone=done;return state.complete.call(job,error?.errno||0,error?.syscall||'write',undefined,error?.path);};
      return nativeRun.call(job,state.path);
    },
  };
  const fileJobs=factories.jobs({Buffer,truncation,native:jobBoundary});
  const callbacks=factories.callbacks({fs:subject,process,Buffer,types:util.types,values,utils,truncation,fileJobs,
    native:{},permissionEnabled:()=>false,require:name=>require(name)});
  Object.assign(subject,{writeFile:callbacks.writeFile,appendFile:callbacks.appendFile});
  return subject;
};
// Native job/backing-store/queue and descriptor methods are explicit control
// dependencies. This does not execute the new guest C++ bridge or pin policy.
if(process.env.KANDELO_WRITE_FILE_PRELOAD==='1'){
  const candidate=exports.create({fsObject:fs});fs.writeFile=candidate.writeFile;fs.appendFile=candidate.appendFile;
  require('node:module').syncBuiltinESMExports();
}
