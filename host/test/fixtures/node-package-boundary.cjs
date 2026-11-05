'use strict';
// Explicit native parser/record control for candidate JS. Virtual fixtures use
// target parsePackageJSON; real-file/error/cursor behavior is checked separately
// by the actual portable C++ owner. This is not guest JSAPI/byte transport.
const fs=require('node:fs'),path=require('node:path');
const globals=['internalBinding','primordials'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
const {internalBinding}=require('internal/test/binding');
for(const [key,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
const binding=internalBinding('modules'),slice=Function.call.bind(Array.prototype.slice);
exports.create=function(read){const owners=new WeakMap();
 function get(cache,name){
  if(cache.has(name))return cache.get(name);
  let raw;try{raw=read(name);}catch(e){if(['ENOENT','ENOTDIR','EISDIR'].includes(e.code)){const absent=[1,undefined,0];cache.set(name,absent);return absent;}return[3,undefined,e.errno,name];}
  try{const data=binding.parsePackageJSON(raw,name,false,undefined,undefined);const value=[0,data,0];cache.set(name,value);return value;}
  catch(e){if(e.code!=='ERR_INVALID_PACKAGE_CONFIG')throw e;return[2,undefined,0,name];}
 }
 return function packageOperation(owner,name,nearest){
  if(owner===undefined){owner={};owners.set(owner,new Map());return owner;}
  const cache=owners.get(owner);if(!cache)throw Error('Unowned package fixture cache');
  let value;
  if(nearest){let current=name;for(;;){current=path.dirname(current);if(path.dirname(current)===current||path.basename(current)==='node_modules'){value=[1,undefined,0];break;}value=get(cache,path.join(current,'package.json'));if(value[0]!==1)break;}}
  else value=get(cache,name);
  return value[0]===0?[0,slice(value[1]),0]:slice(value);
 };
};
