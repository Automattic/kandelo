'use strict';
// Actual candidate shared WebIDL/FormData/Headers owner. Native brands,
// uncloneable registration, inspection/Buffer/File/streams are control inputs.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,data:_createNodeFormDataPlatform};')();
exports.create=function create(){
 const values=factories.values({process,Buffer,util,inspection:util,os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 const worker=require('node:worker_threads');
 const clone={protocol:{markTransferMode(object,cloneable,transferable){
  if(cloneable||transferable)throw Error('Header control only accepts actual uncloneable owners');
  worker.markAsUncloneable(object);
 }}};
 return factories.data({Blob,File,ReadableStream,URL,URLSearchParams,AbortSignal,MessagePort:worker.MessagePort,Event,
  values,assert:require('node:assert'),util,crypto:require('node:crypto'),clone}).headers;
};
