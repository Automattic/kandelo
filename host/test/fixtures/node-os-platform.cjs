'use strict';
// Actual public OS factory and compiled portable POSIX header. Native Node
// supplies engine/Buffer/UV/constants; no host data enters production guest.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const nativeFrom=globalThis.Buffer.from,nativeToString=Function.call.bind(globalThis.Buffer.prototype.toString);
const source=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,os:_createNodeOSPlatform};')();
exports.create=function create(options={}) {
 const Buffer=options.Buffer??globalThis.Buffer,control=options.process??process,nativeOS=require('node:os');
 const values=factories.values({process:control,Buffer,util,inspection:util,os:nativeOS,
  signals:nativeOS.constants.signals,getDOMException:()=>DOMException});
 const calls=[];
 const helper=process.env.KANDELO_OS_NATIVE_HELPER;
 function operatingSystem(operation,first,second) {
  calls.push({operation,first,second});
  if(options.native)return options.native.operatingSystem(operation,first,second);
  if(!helper) {
   // Normal source-only runs need no private compiled artifact. Native public
   // OS APIs supply a named dependency control; portable header evidence is
   // selected only by the explicit helper environment variable.
   const bytes=text=>nativeFrom(text,'utf8');let value;
   try {
    if(operation==='info')value=[nativeOS.type(),nativeOS.version(),nativeOS.release(),nativeOS.machine()].map(bytes);
    else if(operation==='hostname')value=bytes(nativeOS.hostname());
    else if(operation==='home')value=bytes(nativeOS.homedir());
    else if(operation==='temp')value=bytes(nativeOS.tmpdir());
    else if(operation==='user')value=nativeOS.userInfo({encoding:'buffer'});
    else if(operation==='getpriority')value=nativeOS.getPriority(first);
    else if(operation==='setpriority')value=nativeOS.setPriority(first,second);
    else if(operation==='endianness')value=nativeOS.endianness()==='BE';
    else throw Error('Unknown OS control operation');
    return {error:0,value};
   } catch(error) {if(typeof error.info?.errno==='number')return {error:error.info.errno};throw error;}
  }
  // The helper is a separate native transport process. Map self to the
  // actual Node control process for get/setpriority; production calls libc
  // in the guest process and requires no such transport adaptation.
  if ((operation==='getpriority'||operation==='setpriority') && first===0)first=process.pid;
  const args=[operation];if(first!==undefined)args.push(String(first));if(second!==undefined)args.push(String(second));
  const report=JSON.parse(execFileSync(helper,args,{encoding:'utf8',env:process.env}));
  const bytes=hex=>nativeFrom(hex,'hex');
  if(!report.error) {
   if(operation==='info')report.value=report.value.map(bytes);
   else if(['home','hostname'].includes(operation))report.value=bytes(report.value);
   else if(operation==='temp')report.value=report.value===null?undefined:bytes(report.value);
   else if(operation==='user')for(const key of ['username','homedir','shell'])report.value[key]=bytes(report.value[key]);
  }
  return report;
 }
 const codecs=options.codecs??{copyBytes:bytes=>nativeFrom(bytes),decodeBytes:(bytes,encoding)=>nativeToString(nativeFrom(bytes),encoding)};
 const owner=factories.os({process:control,codecs,values,native:{operatingSystem},constants:nativeOS.constants,
  uv:{getSystemErrorName:util.getSystemErrorName,getSystemErrorMessage:util.getSystemErrorMessage}});
 return {...owner,calls,boundary:helper?'compiled portable POSIX owner':'native Node OS dependency control'};
};
