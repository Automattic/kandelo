'use strict';
// Six actual candidate signature methods only. Key generation/import transport,
// TLS, streams and other crypto APIs remain explicit native control dependencies.
const Module=require('node:module'),native=require('node:crypto');
const candidate=require('./platform.cjs').create(),subject={...native};
for(const name of ['Sign','Verify','createSign','createVerify','sign','verify'])subject[name]=candidate[name];
const load=Module._load;
Module._load=function(name,...args){return name==='crypto'||name==='node:crypto'?subject:Reflect.apply(load,this,[name,...args])};
