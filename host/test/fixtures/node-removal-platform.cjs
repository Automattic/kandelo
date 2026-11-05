'use strict';
const fs = require('node:fs');
const util = require('node:util');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {execFileSync} = require('node:child_process');
const globals = ['internalBinding', 'primordials'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const {internalBinding} = require('internal/test/binding');
for (const [key, descriptor] of globals) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
}
const binding = internalBinding('fs');
const source = fs.readFileSync(path.resolve(__dirname, '../../../third_party/node-core/node-core.js'), 'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, stats:_createNodeFsStats, directory:_createNodeDirectoryPlatform, removal:_createNodeRemovalPlatform };')();
exports.create = function create(options = {}) {
  const values = factories.values({process, Buffer, util, inspection: util, uv:{binding:internalBinding('uv')},
    os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
  const truncation = {vfsState:{handlers:null},FSReqCallback:binding.FSReqCallback,
    makeError(status, syscall, path) { return new values.errors.UVException({errno:status,syscall,path}); }};
  const owner = {...fs, ...options.fs};
  const utils = factories.stats({fs:owner,process,Buffer,types:util.types,values,truncation,native:{},
    permissionEnabled:()=>false,toPathIfFileURL:value=>value instanceof URL?fileURLToPath(value):value});
  const native = {
    fsPathSync(name,p,mode,recursive) {return name==='mkdir'?binding.mkdir(p,mode,recursive):binding[name](p);},
    fsPathPromise(name,p,mode,recursive,request) {return name==='mkdir'?binding.mkdir(p,mode,recursive,request):binding[name](p,request);},
    fsRmSync(p,retries,recursive,delay) {
      if(options.rmSync) return options.rmSync(p,retries,recursive,delay);
      const helper=process.env.KANDELO_REMOVAL_NATIVE_HELPER;
      if(!helper)return binding.rmSync(p,retries,recursive,delay);
      const result=JSON.parse(execFileSync(helper,['rm',Buffer.from(p).toString('hex'),String(retries),String(recursive),String(delay)],{encoding:'utf8',timeout:5000}));
      if(result!==null) { result[3]=Buffer.from(result[3],'latin1').toString('utf8'); result[4]=Buffer.from(result[4],'latin1').toString('utf8'); }
      return result===null?undefined:result;
    },
    fsScandir(p,req) {return binding.readdir(p,'buffer',false,req);},
  };
  const directory = factories.directory({values,utils,truncation,native});
  // The remaining filesystem metadata/requests are explicit native boundaries.
  Object.assign(owner,directory.api,options.fs);
  const removal = factories.removal({fs:owner,Buffer,process,path,timers:options.timers??require('node:timers'),
    values,utils,truncation,directory,native,errno:require('node:os').constants.errno,
    uv:{binding:internalBinding('uv')}});
  return {...removal,truncation,values};
};
