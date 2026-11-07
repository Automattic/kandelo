'use strict';
// Only the four streaming signature APIs are candidate. All other crypto,
// key generation/parsing, one-shot jobs, TLS and streams remain native controls.
const Module=require('node:module'),native=require('node:crypto');
const candidate=require('./platform.cjs').create(),subject={...native};
for(const name of ['Sign','Verify','createSign','createVerify'])subject[name]=candidate[name];
const load=Module._load;
Module._load=function(name,...args){return name==='crypto'||name==='node:crypto'?subject:Reflect.apply(load,this,[name,...args])};
