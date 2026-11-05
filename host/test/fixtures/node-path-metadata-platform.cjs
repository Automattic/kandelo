'use strict';
const fs = require('node:fs'), util = require('node:util'), os = require('node:os'), path = require('node:path');
const { fileURLToPath } = require('node:url');
const globals = ['internalBinding','primordials'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]);
const { internalBinding } = require('internal/test/binding');
for (const [key, descriptor] of globals) {
  if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
}
const nativeFs = internalBinding('fs'), nativeUv = internalBinding('uv');
const BufferFrom = Buffer.from;
const BufferToString = Function.prototype.call.bind(Buffer.prototype.toString);
const source = fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories = Function(source + ';return { values:_createNodeValuesPlatform, stats:_createNodeFsStats, metadata:_createNodePathMetadata, errors:_createNodeFsSystemErrors };')();
const bootstrap=fs.readFileSync(path.resolve(__dirname,'../../../packages/registry/node-compat/bootstrap.js'),'utf8');
const relay=bootstrap.slice(bootstrap.indexOf('function _errnoToCode('),bootstrap.indexOf('function _checkErrno('));
const truncationSource=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/fs-truncate-adapter.js'),'utf8');
const makeErrorStart=truncationSource.indexOf('    function makeError(');
const makeErrorSource=truncationSource.slice(makeErrorStart,truncationSource.indexOf('\n    }',makeErrorStart)+6);
const argumentList = (name, path, first, second) => name === 'access' || name === 'chmod' ? [path,first] : [path,first,second];
exports.create = function create() {
  const uv = { binding:nativeUv, getSystemErrorName:util.getSystemErrorName };
  const errorOwner = factories.errors({ uv, codecs: { decodeBytes: bytes => BufferToString(BufferFrom(bytes),'utf8') } });
  const throwErrno=Function('owner',relay+';_nodeFsSystemErrors=owner;return _throwErrno;')(errorOwner);
  const makeError=Function('platform',makeErrorSource+';return makeError;')({throwErrno});
  const values = factories.values({ process, Buffer, util, inspection:util, uv, os,
    signals:os.constants.signals, getDOMException:() => DOMException });
  const truncation = { vfsState:{handlers:null}, FSReqCallback:nativeFs.FSReqCallback,
    makeError };
  const utils = factories.stats({ fs, process, Buffer, types:util.types, values, truncation, native:{},
    permissionEnabled:() => false, toPathIfFileURL:value => value instanceof URL ? fileURLToPath(value) : value });
  const calls=[];
  const native = {
    fsMetadataSync(name,path,first,second) {
      calls.push({name,async:false,first,second});
      try { nativeFs[name](...argumentList(name,path,first,second)); return 0; }
      catch(error) { if(typeof error.errno !== 'number') throw error; return error.errno; }
    },
    fsMetadataPromise(name,path,first,second,request) {
      calls.push({name,async:true,first,second});
      return nativeFs[name](...argumentList(name,path,first,second),
        typeof request === 'function' ? nativeFs.kUsePromises : request);
    },
  };
  return { ...factories.metadata({ values,utils,truncation,native,constants:fs.constants }),
    errorOwner, calls, values, truncation };
};
// This preload deliberately substitutes real native request/metadata owners.
// It tests selected public source, never the uncompiled guest JSAPI/queue.
if(process.env.KANDELO_PATH_METADATA_PRELOAD === '1') {
  const candidate=exports.create();
  Object.assign(fs,candidate.api);Object.assign(fs.promises,candidate.promises);
  require('node:module').syncBuiltinESMExports();
}
