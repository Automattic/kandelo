'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os'),tty=require('node:tty'),stream=require('node:stream');
const globals=['primordials','internalBinding'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
const {internalBinding}=require('internal/test/binding');
for(const [key,d]of globals){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}
const uv=internalBinding('uv');
const factory=Function(fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8')+';return {values:_createNodeValuesPlatform,terminal:_createNodeTerminalPlatform,fd:_createNodeFdStreamPlatform};')();
exports.create=function(fd){
 const values=factory.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,uv:{binding:uv,getSystemErrorName:util.getSystemErrorName},getDOMException:()=>DOMException});
 const owners=[],closing=[];let actual;
 const native={operatingSystem(operation,first,second){
  if(operation==='tty-open'){
   try{const owner=new tty.ReadStream(first);owners.push(owner);actual=owner;return {value:owner,error:0};}
   catch(error){return {value:undefined,error:error.errno||error.info?.errno};}
  }
  if(operation==='tty-mode')return {value:undefined,error:first._handle?.setRawMode(second)??0};
  if(operation==='tty-close'){
   closing.push(new Promise(resolve=>{first.once('close',resolve);first.destroy();}));return {value:undefined,error:0};
  }
  throw Error('Unexpected terminal boundary '+operation);
 }};
 const terminal=factory.terminal({values,native,uv:{getSystemErrorName:util.getSystemErrorName,getSystemErrorMessage:util.getSystemErrorMessage}});
 let retire;const transport=factory.fd({stream,Buffer,FastBuffer:require('internal/buffer').FastBuffer,process,native:{}});
 const input=transport.readable(fd,undefined,()=>retire?.());input.isTTY=true;retire=terminal.bindInput(input,fd);
 return {input,get actual(){return actual;},async settle(){await Promise.all(closing);},async destroy(){if(!input.destroyed){const closed=new Promise(resolve=>input.once('close',resolve));input.destroy();await closed;}await Promise.all(closing);}};
};
