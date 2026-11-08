const Module=require('node:module'),base=require('./platform.cjs'),util=require('node:util');
const load=Module._load,crypto=require('node:crypto'),buffer=require('node:buffer');
Module._load=function(name,...args){
 if(name==='crypto'||name==='node:crypto')return {...crypto,...base};
 if(name==='util'||name==='node:util')return {...util,promisify:base.privateValues.util.promisify};
 if(name==='buffer'||name==='node:buffer')return {...buffer,Buffer:base.Buffer};
 return Reflect.apply(load,this,[name,...args]);
};
globalThis.Buffer=base.Buffer;
