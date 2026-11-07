'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os'),tty=require('node:tty'),stream=require('node:stream'),readline=require('node:readline');
const {internalBinding}=require('internal/test/binding');
const root=path.resolve(process.env.TTY_OUTPUT_TEST_REPO);
const factory=Function(fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8')+';return {values:_createNodeValuesPlatform,terminal:_createNodeTerminalPlatform,fd:_createNodeFdStreamPlatform};')();
const windows=require(process.env.TTY_OUTPUT_COMPONENT);
exports.create=function(fd){
 const uv=internalBinding('uv');
 const values=factory.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,uv:{binding:uv,getSystemErrorName:util.getSystemErrorName},getDOMException:()=>DOMException});
 let capturedOutput;
 const terminal=factory.terminal({values,native:{operatingSystem(operation,...args){if(operation==='tty-size')return windows.windowSize(...args);if(operation==='tty-output-open'){const packet=windows.openOutput(...args);if(!packet.error)capturedOutput=packet.value;return packet;}if(operation==='tty-output-size')return windows.outputSize(...args);if(operation==='tty-output-write')return windows.writeOutput(...args);throw Error('Unexpected native terminal operation '+operation);}},uv:{getSystemErrorName:util.getSystemErrorName,getSystemErrorMessage:util.getSystemErrorMessage},isTTY:tty.isatty,getReadline:()=>readline});
 const transport=factory.fd({stream,Buffer,process,openTerminalOutput:terminal.openOutput,native:{__kandeloFdWrite(fd,input){
  const bytes=Buffer.from(input);
  return new Promise((resolve,reject)=>{let offset=0;function write(){fs.write(fd,bytes,offset,bytes.length-offset,null,(error,length)=>{if(error){reject(error);return;}if(length<=0){reject(Error('Unexpected zero write in component transport'));return;}offset+=length;if(offset<bytes.length)write();else resolve();});}if(!bytes.length)resolve();else write();});
 }}});
 const output=transport.writable(fd);terminal.bindOutput(output,fd);
 return {output,terminal,transport,closeOutput(){return windows.closeOutput(capturedOutput);}};
};
