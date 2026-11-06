'use strict';
const assert=require('node:assert/strict'),wt=require('node:worker_threads');
assert.equal(process.version,'v26.13.0');
assert.equal(wt,require('worker_threads'));
const loaded=()=>process.moduleLoadList.includes('NativeModule internal/locks');
assert.equal(loaded(),false);
const names=Object.keys(wt);assert.equal(names.includes('locks'),true);
assert.equal(loaded(),false);
const attrs=Object.fromEntries(names.filter(k=>k!=='locks').map(k=>{
 const d=Object.getOwnPropertyDescriptor(wt,k);return[k,{type:typeof d.value,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable}];
}));
wt.locks={publicShadow:true};assert.equal(loaded(),false);
const singleton=navigator.locks;assert.equal(singleton.constructor.name,'LockManager');
assert.notEqual(singleton,wt.locks);assert.equal(singleton,require('internal/locks').locks);
assert.equal(navigator.locks,singleton);
console.log(JSON.stringify({scope:'Exact pinned native inventory/aliases/Navigator routing only; no candidate global claim',names,attrs,nativeAliases:true,navigatorIndependent:true},null,2));
