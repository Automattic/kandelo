'use strict';
const api = __kandeloUpstreamTest, observations = [];
let failures = 0;
function assert(value, message = 'native data property assertion failed') {if (!value) throw Error(message)}
function check(name, body) {try {observations.push({name, status: 'pass', detail: body() ?? true})} catch (error) {failures++; observations.push({name, status: 'fail', error: {name: error.name, message: error.message, stack: error.stack}})}}
function make(setter = true) {
  const target = {}, key = 'value'; let state = 9229;
  api.defineNativeData(target, key, () => state, setter ? (_, __, value) => {state = Number(value)} : undefined);
  return {target, key};
}
// @shared-native-data-controls
for (const control of sharedControls) check(control[0], () => observeShared(control, make).detail);
const sharedCases = observations.length;
check('reads-and-descriptors-keep-calling-native-getter', () => {
  const target = {}; let reads = 0;
  api.defineNativeData(target, 'value', () => ++reads, undefined);
  assert(target.value === 1 && target.value === 2);
  const d = Object.getOwnPropertyDescriptor(target, 'value');
  assert(d.value === 3 && !('get' in d) && !('set' in d));
  gc('shrinking'); assert(target.value === 4);
});
check('assignment-calls-setter-without-getter', () => {
  const target = {}; let reads = 0, writes = 0;
  api.defineNativeData(target, 'value', () => ++reads, (holder, key, value) => {
    assert(holder === target && key === 'value' && value === 17); writes++;
  });
  target.value = 17; assert(reads === 0 && writes === 1);
});
check('getter-gets-holder-key-and-actual-receiver', () => {
  const target = {}, child = Object.create(target); let receiver;
  api.defineNativeData(target, 'value', function(holder, key) {
    assert(holder === target && key === 'value'); receiver = this; return 23;
  }, undefined);
  assert(child.value === 23 && receiver === child);
  assert(Reflect.get(target, 'value', 31) === 23 && receiver === 31);
});
check('callback-and-unreachable-payload-survive-moving-gc', () => {
  const target = {};
  (() => {const payload = new Uint8Array(4096).fill(37);
    api.defineNativeData(target, 'value', () => payload, undefined)})();
  for (let i = 0; i < 4; i++) gc('shrinking');
  assert(target.value[2047] === 37 && target.value.length === 4096);
});
check('getter-deletion-and-gc-keep-current-call-rooted', () => {
  const target = {};
  api.defineNativeData(target, 'value', () => {delete target.value; gc('shrinking'); return 41}, undefined);
  assert(target.value === 41 && !Object.hasOwn(target, 'value'));
});
check('getter-replacement-stays-replaced', () => {
  const target = {};
  api.defineNativeData(target, 'value', () => {
    delete target.value; api.defineNativeData(target, 'value', () => 43, undefined); gc('shrinking'); return 47;
  }, undefined);
  assert(target.value === 47 && target.value === 43);
});
check('getter-exceptions-propagate-and-next-read-retries', () => {
  const target = {}; let attempts = 0;
  api.defineNativeData(target, 'value', () => {if (++attempts === 1) throw Error('GETTER_SENTINEL'); return 53}, undefined);
  let error; try {target.value} catch (caught) {error = caught}
  assert(error.message === 'GETTER_SENTINEL' && target.value === 53 && attempts === 2);
});
check('setter-exceptions-keep-native-record-for-retry', () => {
  const target = {}; let state = 59;
  api.defineNativeData(target, 'value', () => state, (_, __, value) => {if (value === 0) throw Error('SETTER_SENTINEL'); state = value});
  let error; try {target.value = 0} catch (caught) {error = caught}
  assert(error.message === 'SETTER_SENTINEL' && target.value === 59);
  target.value = 61; assert(target.value === 61);
});
check('freeze-and-seal-avoid-getter-and-retain-live-value', () => {
  for (const freeze of [false, true]) {
    const target = {}; let reads = 0, state = 67;
    api.defineNativeData(target, 'value', () => {reads++; return state}, (_, __, v) => {state = v});
    (freeze ? Object.freeze : Object.seal)(target); assert(reads === 0);
    state = 71; assert(target.value === 71);
    if (!freeze) {target.value = 73; assert(target.value === 73)}
  }
});
check('frozen-redundant-definition-does-not-call-setter', () => {
  const target = {}; let writes = 0;
  api.defineNativeData(target, 'value', () => 79, () => {writes++});
  Object.freeze(target); Object.defineProperty(target, 'value', {value: 79}); assert(writes === 0);
});
check('accessor-redefinition-releases-native-behavior', () => {
  const {target, key} = make(); Object.defineProperty(target, key, {get() {return 83}});
  assert(target[key] === 83 && typeof Object.getOwnPropertyDescriptor(target, key).get === 'function');
});
check('symbols-utf16-and-indexed-slots-retain-native-callback', () => {
  const target = [], symbol = Symbol('key');
  for (const key of [symbol, '0', '__proto__', 'x\0y', '\ud800']) api.defineNativeData(target, key, () => 89, undefined);
  gc('shrinking');
  for (const key of [symbol, '0', '__proto__', 'x\0y', '\ud800']) assert(target[key] === 89);
  assert(target.length === 1 && Object.getPrototypeOf(target) === Array.prototype);
});
check('cross-compartment-target-and-callback-are-traced', () => {
  const other = newGlobal({newCompartment: true}), target = other.eval('({})'); let state = 97;
  api.defineNativeData(target, 'value', function(holder) {assert(holder === target && this === target); return state}, (_, __, v) => {state = v});
  gc('shrinking'); assert(target.value === 97); target.value = 101; assert(other.eval('0') === 0 && target.value === 101);
});
check('proxy-target-refusal-is-an-explicit-gap', () => {
  let error; try {api.defineNativeData(new Proxy({}, {}), 'value', () => 0, undefined)} catch (caught) {error = caught}
  assert(error?.message.includes('native target'));
});
print(JSON.stringify({kind: 'native-data-property-controls', cases: observations.length, sharedCases, failures, observations, upstreamStartup: false}));
if (failures) quit(1);
