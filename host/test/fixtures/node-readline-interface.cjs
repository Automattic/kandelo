'use strict';
// Actual pinned Interface/key/history source and candidate StringDecoder.
// Stream/events/terminal-width/timers/fs below are explicit native controls.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const events=require('node:events'),tty=require('node:tty'),stream=require('node:stream');
const root=path.resolve(__dirname,'../../..');
const source=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,readline:_createNodeReadlinePlatform};')();
exports.create=function create() {
  const inspection=require('internal/util/inspect');
  const values=factories.values({process,Buffer,util,inspection,os:require('node:os'),
    signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
  values.require('internal/util/debuglog').initializeDebugEnv(process.env.NODE_DEBUG);
  // Use the actual current shared decoder/byte owner, rather than extracting
  // the retired bootstrap IIFE. Assertions and readline source are unchanged.
  const decoder=require('./node-string-decoder-platform.cjs').create();
  return factories.readline({process,values,inspection,events,stringDecoder:decoder,
    requireEvent:name=>require(name),path,fs,os:require('node:os'),timers:require('node:timers'),
    permission:require('internal/process/permission'),isTTY:tty.isatty,streamUtils:{isWritable:stream.isWritable}});
};
