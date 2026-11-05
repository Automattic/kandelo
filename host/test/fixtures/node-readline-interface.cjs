'use strict';
// Actual pinned Interface/key/history source and candidate StringDecoder.
// Stream/events/terminal-width/timers/fs below are explicit native controls.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const events=require('node:events'),tty=require('node:tty'),stream=require('node:stream');
const root=path.resolve(__dirname,'../../..');
const source=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const bootstrap=fs.readFileSync(path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,readline:_createNodeReadlinePlatform};')();
function section(start,end) {
  const a=bootstrap.indexOf(start),b=bootstrap.indexOf(end,a);
  if(a<0||b<a)throw Error('Missing readline/decoder source boundary');return bootstrap.slice(a,b);
}
exports.create=function create() {
  const inspection=require('internal/util/inspect');
  const values=factories.values({process,Buffer,util,inspection,os:require('node:os'),
    signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
  values.require('internal/util/debuglog').initializeDebugEnv(process.env.NODE_DEBUG);
  const getBytes=Function(section('function _nodeBufferSourceBytes(input, allowRaw = false) {',
    "if (typeof globalThis.TextDecoder === 'undefined')")+';return _nodeBufferSourceBytes;')();
  const decoder=Function('Buffer','TextDecoder','_nodeBufferSourceBytes',
    section('const string_decoder = (() => {','// ============================================================\n// timers module')+';return string_decoder;')(Buffer,TextDecoder,getBytes);
  return factories.readline({process,values,inspection,events,stringDecoder:decoder,
    requireEvent:name=>require(name),path,fs,os:require('node:os'),timers:require('node:timers'),
    permission:require('internal/process/permission'),isTTY:tty.isatty,streamUtils:{isWritable:stream.isWritable}});
};
