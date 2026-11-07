'use strict';
// Subject only the four RSA methods; all other builtin capabilities are explicit
// native dependencies. This is not a guest whole-crypto test or support facade.
const Module=require('node:module'),native=require('node:crypto');
const candidate=require('./platform.cjs').create();
// Install the actual private Buffer owner as the guest bootstrap does; the
// upstream assertions/files remain unchanged. Native Node Buffer prototypes
// are a separate component boundary, not the candidate public Buffer class.
globalThis.Buffer=candidate.Buffer;
const subject={...native};
for(const name of ['publicEncrypt','privateDecrypt','privateEncrypt','publicDecrypt'])subject[name]=candidate[name];
const load=Module._load;
Module._load=function(name,...args){return name==='crypto'||name==='node:crypto'?subject:Reflect.apply(load,this,[name,...args])};
