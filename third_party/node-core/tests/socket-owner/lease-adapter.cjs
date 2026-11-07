'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const p=path.resolve(process.argv[2]),s=fs.readFileSync(p,'utf8');
const a=s.indexOf('    const _nodeNative = {'),b=s.indexOf('\n\n    const entryPath =',a),h=s.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;'),j=s.indexOf('    // The deadline heap owns',h);assert(a>=0&&b>a&&h>=0&&j>h);
const calls=[],native={};for(const name of ['socketAccept','socketAcceptedFd','socketAcceptedClose','socketOwnerAdoptAccepted'])native[name]=(...args)=>{const item={name,args};calls.push(item);return item};
const api=Function('native','workerEnvironment',s.slice(h,j)+s.slice(a,b)+';return _nodeNative')(native,null);const token={};
for(const [method,args,expected,forwarded] of [['socketAccept',[17],'socketAccept',[17]],['socketAcceptLease',[18],'socketAccept',[18,true]],['socketAcceptedFd',[token],'socketAcceptedFd',[token]],['socketAcceptedClose',[token],'socketAcceptedClose',[token]],['socketOwnerAdoptAccepted',[token],'socketOwnerAdoptAccepted',[token]]]){const value=Reflect.apply(api[method],api,args);assert.equal(value,calls.at(-1));assert.deepEqual(value,{name:expected,args:forwarded})}
console.log(JSON.stringify({scope:'Actual adapter source over explicit recording-only native boundary; no fd/runtime claim',pass:5,calls}));
