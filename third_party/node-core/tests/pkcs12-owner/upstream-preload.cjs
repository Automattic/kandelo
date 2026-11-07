'use strict';
// Supply explicit candidate crypto entry points only to the unchanged upstream
// test. Dependencies keep native modules; assertions and fixture bytes unchanged.
const Module=require('node:module'),path=require('node:path'),native=require('node:crypto');
const previous=Object.getOwnPropertyDescriptors(globalThis);
const candidate=require('./key-platform.cjs').create({component:require(process.env.PKCS12_COMPONENT)});
// internal/test/binding installs fixture globals. Restore precisely that
// setup before upstream's unchanged global-leak assertion executes.
for(const name of ['internalBinding','primordials']){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}
const subject={...native,parsePKCS12:candidate.parsePKCS12};
Object.defineProperty(subject,'X509Certificate',{enumerable:true,get:()=>candidate.X509Certificate});
const original=Module._load,target=path.resolve(process.env.PKCS12_UPSTREAM_TEST);
Module._load=function(request,parent,...rest){if((request==='crypto'||request==='node:crypto')&&parent?.filename===target)return subject;return Reflect.apply(original,this,[request,parent,...rest]);};
