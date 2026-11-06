'use strict';
const vm = require('node:vm');
const target = require('node:worker_threads');
const loaded = () => process.moduleLoadList.includes('NativeModule internal/locks');
const mode = process.argv[2], trace = { mode, initial: loaded() };
const receiver = Object.create(target);
try {
 switch (mode) {
 case 'navigatorAlias': trace.value = navigator.locks === target.locks; break;
 case 'navigatorShadow': target.locks = 1; trace.value = navigator.locks !== target.locks; trace.manager = navigator.locks.constructor.name; break;
 case 'navigatorDisabled': trace.value = [typeof Navigator, typeof navigator]; break;
 case 'keys': trace.value = Object.keys(target).includes('locks'); break;
 case 'has': trace.value = 'locks' in target; break;
 case 'descriptor': { const d=Object.getOwnPropertyDescriptor(target,'locks'); trace.descriptor={keys:Object.keys(d),enumerable:d.enumerable,configurable:d.configurable,writable:d.writable,type:typeof d.value}; break; }
 case 'seal': Object.seal(target); break;
 case 'freeze': Object.freeze(target); break;
 case 'prevent': Object.preventExtensions(target); break;
 case 'inherited': { const v=receiver.locks; trace.own=Object.hasOwn(receiver,'locks'); trace.same=v===target.locks; break; }
 case 'foreign': trace.value=vm.runInNewContext('obj.locks', {obj:target})===target.locks; break;
 case 'inheritedSet': receiver.locks=1; trace.own=Object.hasOwn(receiver,'locks'); trace.value=receiver.locks; break;
 case 'set': target.locks=1; trace.value=target.locks; break;
 case 'define': Object.defineProperty(target,'locks',{value:1}); trace.value=target.locks; break;
 case 'delete': trace.value=delete target.locks; break;
 }
 trace.after=loaded();
 if (['seal','freeze','prevent'].includes(mode)) { trace.beforeRead=loaded();trace.value=typeof target.locks;trace.afterRead=loaded(); trace.descriptor=Object.getOwnPropertyDescriptor(target,'locks'); trace.descriptor.value=typeof trace.descriptor.value; }
} catch(e){trace.error={name:e.name,code:e.code,message:e.message};}
const assert = require('node:assert/strict');
assert.equal(process.version, 'v26.13.0');
assert.equal(trace.initial, false);
assert.equal(trace.error, undefined);
if (['keys','has','seal','freeze','prevent','inheritedSet','set','delete'].includes(mode)) assert.equal(trace.after, false);
if (['descriptor','define','inherited','foreign','navigatorAlias','navigatorShadow'].includes(mode)) assert.equal(trace.after, true);
if (['seal','freeze','prevent'].includes(mode)) {
 assert.equal(trace.beforeRead, false); assert.equal(trace.afterRead, true);
 assert.equal(trace.descriptor.configurable, mode === 'prevent');
 assert.equal(trace.descriptor.writable, mode !== 'freeze');
}
if (mode === 'inherited') { assert.equal(trace.own, false); assert.equal(trace.same, true); }
if (mode === 'descriptor') assert.deepEqual(trace.descriptor.keys, ['value','writable','enumerable','configurable']);
if (mode === 'navigatorAlias' || mode === 'navigatorShadow') assert.equal(trace.value, true);
if (mode === 'navigatorDisabled') assert.deepEqual(trace.value, ['undefined','undefined']);
console.log(JSON.stringify(trace));
