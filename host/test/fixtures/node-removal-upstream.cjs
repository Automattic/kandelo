'use strict';
// Select only candidate removal APIs; other FS, engine and common dependencies
// remain explicit native controls. Upstream files/assertions are unchanged.
const Module=require('node:module');
const fs=require('node:fs');
const candidate=require('./node-removal-platform.cjs').create();
const promises={...fs.promises,...candidate.promises};
const api={...fs,...candidate.api,promises};
const load=Module._load;
Module._load=function(name){
 if(name==='fs'||name==='node:fs')return api;
 if(name==='fs/promises'||name==='node:fs/promises')return promises;
 return Reflect.apply(load,this,arguments);
};
