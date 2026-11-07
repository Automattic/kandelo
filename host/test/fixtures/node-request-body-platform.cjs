'use strict';
// Actual current candidate sources over explicit native Node stream, codec,
// clone/event and HTTP boundaries. No guest/engine/GC/transport acceptance.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert'),util=require('node:util'),crypto=require('node:crypto'),stream=require('node:stream'),web=require('node:stream/web'),events=require('node:events');
const {MessagePort,markAsUncloneable}=require('node:worker_threads');
const root=path.resolve(__dirname,'../../..');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const source=fs.readFileSync(process.env.WEB_REQUEST_BOOTSTRAP_FILE||path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const factories=Function(bundle+';return {values:_createNodeValuesPlatform,file:_createNodeFilePlatform,formData:_createNodeFormDataPlatform,body:_createNodeFetchBodyPlatform};')();
const values=factories.values({process,Buffer,util,inspection:util,os:{},signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
const modes=new WeakMap();const clone={protocol:{kClone:Symbol('clone'),kDeserialize:Symbol('deserialize'),markTransferMode(object,cloneable,transferable){modes.set(object,Number(cloneable)*2+Number(transferable));if(!cloneable&&!transferable)markAsUncloneable(object);}}};
const slice=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);};
const state={isReadable:value=>{try{Reflect.apply(Object.getOwnPropertyDescriptor(web.ReadableStream.prototype,'locked').get,value,[]);return true;}catch{return false;}},isDisturbed:stream.isDisturbed,isLocked:value=>Reflect.apply(Object.getOwnPropertyDescriptor(web.ReadableStream.prototype,'locked').get,value,[]),isByteStream:value=>{try{value.getReader({mode:'byob'}).releaseLock();return true;}catch{return false;}}};
const webPlatform={streams:web,URL,URLSearchParams,streamState:state};
const bodyData=Function('_nodeClonePlatform','_nodeWebPlatform',slice('const _nodeBodyData =',"if (typeof globalThis.Blob === 'undefined')")+';return _nodeBodyData;')(clone,webPlatform);
const file=factories.file({blob:bodyData,values,inspection:util,clone});
const formData=factories.formData({Blob:bodyData.Blob,File:file.File,ReadableStream:web.ReadableStream,URL,URLSearchParams,AbortSignal,MessagePort,Event,values,assert,util,crypto,clone});
const globals={File:file.File,FormData:formData.FormData,AbortController};
Function('_nodeWebPlatform','_nodeBodyData','_nodeNative','_nodeFormDataPlatform','_nodeClonePlatform','_createNodeFetchBodyPlatform','_nodeStreamPlatform','_nodeValues','assert','util','events','process','stream','http','https','_nodeEventPlatform','_nodeDispose','globalThis',slice('    const FetchHeaders =','    globalThis.Request = FetchRequest;')+'globalThis.Request = FetchRequest;')(webPlatform,bodyData,{cloneValue:structuredClone},formData,clone,factories.body,{api:stream,web},values,assert,util,events,process,stream,require('node:http'),require('node:https'),{addAbortListener:events.addAbortListener},Symbol.dispose,globals);
module.exports={...globals,fixtureSourceIdentity:crypto.createHash('sha256').update(source).digest('hex'),Blob:bodyData.Blob,Headers:formData.headers.Headers,ReadableStream:web.ReadableStream,TransformStream:web.TransformStream,TextDecoderStream:web.TextDecoderStream,URLSearchParams,URL};
