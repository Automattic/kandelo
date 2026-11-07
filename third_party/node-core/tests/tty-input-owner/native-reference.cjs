'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),tty=require('node:tty');
assert.equal(process.version,'v26.13.0');
const supplied=Number(process.argv[2]),replacementName=process.argv[3];
const attributes=require(process.env.KANDELO_TTY_ATTRIBUTES);
const alias=attributes.duplicate(supplied),initialTermiosWords=attributes.attributes(alias);
let normalTermiosWords;
const input=new tty.ReadStream(supplied);input.setRawMode('io');
const captured=input._handle.fd;assert.notEqual(captured,supplied);
fs.closeSync(supplied);const replacement=fs.openSync(replacementName,'r+');assert.equal(replacement,supplied);
const deadline=setTimeout(()=>{input.destroy();throw Error('Native captured TTY read timeout');},3000);
input.once('error',error=>{throw error;});
input.once('data',bytes=>{
 assert.equal(String(bytes),'A');clearTimeout(deadline);input.setRawMode(false);normalTermiosWords=attributes.attributes(alias);
 console.log('NORMAL');
 process.stdin.once('data',()=>{
 input.once('close',()=>{
  const closedTermiosWords=attributes.attributes(alias);fs.closeSync(alias);
  assert(fs.fstatSync(replacement).isCharacterDevice());fs.closeSync(replacement);
  console.log(JSON.stringify({nativeNode:process.version,supplied,captured,actualInput:'A',replacementPreserved:true,publicTTYIsActualNative:true,initialTermiosWords,normalTermiosWords,closedTermiosWords}));
 });input.destroy();
 });
});
input.resume();console.log('READY');
