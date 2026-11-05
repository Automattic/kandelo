'use strict';
// Candidate Buffer constructor/pool/codecs/bytes over exact native storage,
// alignment, detach-key/serializer, streams/ports, process and test fixtures.
// Other buffer-module exports remain native and outside this evidence claim.
const Module=require('node:module'),nativeBuffer=require('node:buffer');
const {Buffer}=require('./node-buffer-pool.cjs').create();const replacement={...nativeBuffer,Buffer};
const load=Module._load;Module._load=function(name,parent,isMain){if(name==='buffer'||name==='node:buffer')return replacement;return Reflect.apply(load,this,[name,parent,isMain]);};globalThis.Buffer=Buffer;
