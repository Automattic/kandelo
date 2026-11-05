'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),worker=require('node:worker_threads');
const root=path.resolve(__dirname,'../../..'),bootstrap=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8'),bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(bundle+';return {ctor:_createNodeBufferConstructor,pool:_createNodeBufferPool,values:_createNodeValuesPlatform,numeric:_installNodeBufferNumeric,unpooled:_installNodeBufferUnpooled,codecs:_installNodeBufferCodecs,bytes:_installNodeBufferBytes};')();
const saved={primordials:Object.getOwnPropertyDescriptor(globalThis,'primordials'),internalBinding:Object.getOwnPropertyDescriptor(globalThis,'internalBinding')};
const binding=require('internal/test/binding').internalBinding;
for(const [key,desc] of Object.entries(saved)){if(desc)Object.defineProperty(globalThis,key,desc);else delete globalThis[key];}
const nativeBuffer=binding('buffer'),nativeUtil=binding('util'),limits=require('node:buffer').constants;
exports.create=function create(options={}){
 const a=bootstrap.indexOf('const _FastBuffer = (() => {'),b=bootstrap.indexOf('const _nodeBufferConstructor =',a);if(a<0||b<a)throw Error('Buffer source boundaries');
 const FastBuffer=Function(bootstrap.slice(a,b)+';return _FastBuffer;')();
 const ctor=factories.ctor({FastBuffer,isInsideNodeModules:options.isInsideNodeModules||nativeUtil.isInsideNodeModules,getOptionValue:name=>{if(name!=='--pending-deprecation')throw Error(name);return options.pending===true;}}),Buffer=ctor.Buffer;
 const values=factories.values({process,Buffer,util,inspection:util,os:{},signals:require('node:os').constants.signals,getDOMException:()=>DOMException});ctor.initialize({process:options.process||process,values});factories.numeric({Buffer,values});
 const native={createUnsafeArrayBuffer:nativeBuffer.createUnsafeArrayBuffer,arrayBufferAlignedOffset:nativeBuffer.arrayBufferAlignedOffset,markBufferUntransferable:worker.markAsUntransferable};
 const allocator=factories.unpooled({Buffer,FastBuffer,values,native,kMaxLength:limits.MAX_LENGTH});let codecs;
 const pool=factories.pool({Buffer,FastBuffer,values,native,allocator,kMaxLength:limits.MAX_LENGTH,getCodecs:()=>codecs});
 codecs=factories.codecs({Buffer,FastBuffer,pool,values,allocator,kMaxLength:limits.MAX_LENGTH,kStringMaxLength:limits.MAX_STRING_LENGTH});factories.bytes({Buffer,FastBuffer,pool,values,codecs,kMaxLength:limits.MAX_LENGTH});
 return {Buffer,FastBuffer,values,allocator,pool,codecs,native,isLatin1:codecs.isLatin1};
};
