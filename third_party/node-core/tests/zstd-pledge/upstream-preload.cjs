'use strict';
// Actual pinned public zlib algorithms plus the native pledge policy. Native
// codec/stream/async/ZIP dependencies are explicit component boundaries.
const Module=require('node:module'),candidate=require('./platform.cjs').create(),load=Module._load;
Module._load=function(name,...args){return name==='zlib'||name==='node:zlib'?candidate:Reflect.apply(load,this,[name,...args])};
