'use strict';
const Module=require('node:module'),native=require('node:util');
const candidate=require('./node-util-algorithms.cjs').create();
// ESM parseArgs uses the native builtin namespace; update that one data value.
// CJS receives candidate lazy control getters so timer mocks run before loading.
const api=Object.create(Object.getPrototypeOf(native),Object.getOwnPropertyDescriptors(native));
Object.defineProperties(api,Object.getOwnPropertyDescriptors(candidate));
native.parseArgs=candidate.parseArgs;
Module.syncBuiltinESMExports();
const load=Module._load;
Module._load=function(name){if(name==='util'||name==='node:util')return api;return Reflect.apply(load,this,arguments);};
