'use strict';
const api = __kandeloUpstreamTest, observations = [];api.initializeContext();api.initializeRealm();
let failures = 0;
function assert(value, message = 'native data property assertion failed') {if (!value) throw Error(message)}
function check(name, body) {try {observations.push({name, status: 'pass', detail: body() ?? true})} catch (error) {failures++; observations.push({name, status: 'fail', error: {name: error.name, message: error.message, stack: error.stack}})}}
function make(setter = true) {
  const target = {}, key = 'value'; let state = 9229;
  api.defineNativeProperty(target, key, () => state, setter ? (_, __, value) => {state = Number(value)} : undefined);
  return {target, key};
}
// @shared-native-data-controls
for (const control of sharedControls) check(control[0], () => observeShared(control, make).detail);
const sharedCases = observations.length;
check('reads-and-descriptors-keep-calling-native-getter', () => {
  const target = {}; let reads = 0;
  api.defineNativeProperty(target, 'value', () => ++reads, undefined);
  assert(target.value === 1 && target.value === 2);
  const d = Object.getOwnPropertyDescriptor(target, 'value');
  assert(d.value === 3 && !('get' in d) && !('set' in d));
  gc('shrinking'); assert(target.value === 4);
});
check('assignment-calls-setter-without-getter', () => {
  const target = {}; let reads = 0, writes = 0;
  api.defineNativeProperty(target, 'value', () => ++reads, (holder, key, value) => {
    assert(holder === target && key === 'value' && value === 17); writes++;
  });
  target.value = 17; assert(reads === 0 && writes === 1);
});
check('getter-gets-holder-key-and-actual-receiver', () => {
  const target = {}, child = Object.create(target); let receiver;
  api.defineNativeProperty(target, 'value', function(holder, key) {
    assert(holder === target && key === 'value'); receiver = this; return 23;
  }, undefined);
  assert(child.value === 23 && receiver === child);
  assert(Reflect.get(target, 'value', 31) === 23 && receiver === 31);
});
check('callback-and-unreachable-payload-survive-moving-gc', () => {
  const target = {};
  (() => {const payload = new Uint8Array(4096).fill(37);
    api.defineNativeProperty(target, 'value', () => payload, undefined)})();
  for (let i = 0; i < 4; i++) gc('shrinking');
  assert(target.value[2047] === 37 && target.value.length === 4096);
});
check('getter-deletion-and-gc-keep-current-call-rooted', () => {
  const target = {};
  api.defineNativeProperty(target, 'value', () => {delete target.value; gc('shrinking'); return 41}, undefined);
  assert(target.value === 41 && !Object.hasOwn(target, 'value'));
});
check('getter-replacement-stays-replaced', () => {
  const target = {};
  api.defineNativeProperty(target, 'value', () => {
    delete target.value; api.defineNativeProperty(target, 'value', () => 43, undefined); gc('shrinking'); return 47;
  }, undefined);
  assert(target.value === 47 && target.value === 43);
});
check('getter-exceptions-propagate-and-next-read-retries', () => {
  const target = {}; let attempts = 0;
  api.defineNativeProperty(target, 'value', () => {if (++attempts === 1) throw Error('GETTER_SENTINEL'); return 53}, undefined);
  let error; try {target.value} catch (caught) {error = caught}
  assert(error.message === 'GETTER_SENTINEL' && target.value === 53 && attempts === 2);
});
check('setter-exceptions-keep-native-record-for-retry', () => {
  const target = {}; let state = 59;
  api.defineNativeProperty(target, 'value', () => state, (_, __, value) => {if (value === 0) throw Error('SETTER_SENTINEL'); state = value});
  let error; try {target.value = 0} catch (caught) {error = caught}
  assert(error.message === 'SETTER_SENTINEL' && target.value === 59);
  target.value = 61; assert(target.value === 61);
});
check('freeze-and-seal-avoid-getter-and-retain-live-value', () => {
  for (const freeze of [false, true]) {
    const target = {}; let reads = 0, state = 67;
    api.defineNativeProperty(target, 'value', () => {reads++; return state}, (_, __, v) => {state = v});
    (freeze ? Object.freeze : Object.seal)(target); assert(reads === 0);
    state = 71; assert(target.value === 71);
    if (!freeze) {target.value = 73; assert(target.value === 73)}
  }
});
check('frozen-redundant-definition-does-not-call-setter', () => {
  const target = {}; let writes = 0;
  api.defineNativeProperty(target, 'value', () => 79, () => {writes++});
  Object.freeze(target); Object.defineProperty(target, 'value', {value: 79}); assert(writes === 0);
});
check('accessor-redefinition-releases-native-behavior', () => {
  const {target, key} = make(); Object.defineProperty(target, key, {get() {return 83}});
  assert(target[key] === 83 && typeof Object.getOwnPropertyDescriptor(target, key).get === 'function');
});
check('symbols-utf16-and-indexed-slots-retain-native-callback', () => {
  const target = [], symbol = Symbol('key');
  for (const key of [symbol, '0', '__proto__', 'x\0y', '\ud800']) api.defineNativeProperty(target, key, () => 89, undefined);
  gc('shrinking');
  for (const key of [symbol, '0', '__proto__', 'x\0y', '\ud800']) assert(target[key] === 89);
  assert(target.length === 1 && Object.getPrototypeOf(target) === Array.prototype);
});
check('cross-compartment-target-and-callback-are-traced', () => {
  const other = newGlobal({newCompartment: true});api.initializeContext(other);api.initializeRealm(other);const target = other.eval('({})'); let state = 97;
  api.defineNativeProperty(target, 'value', function(holder) {assert(holder === target && this === target); return state}, (_, __, v) => {state = v});
  gc('shrinking'); assert(target.value === 97); target.value = 101; assert(other.eval('0') === 0 && target.value === 101);
});
check('proxy-target-refusal-is-an-explicit-gap', () => {
  let error; try {api.defineNativeProperty(new Proxy({}, {}), 'value', () => 0, undefined)} catch (caught) {error = caught}
  assert(error?.message.includes('native target'));
});

check('native-info-data-holder-name-and-active-context', () => {
  const target = {}, payload = {tag: Symbol('payload')}; let reads = 0, writes = 0;
  api.defineNativeProperty(target, 'value', function(holder, key, data, context) {
    assert(holder === target && key === 'value' && data === payload && context === globalThis);
    reads++; return payload;
  }, function(holder, key, input, data, context) {
    assert(holder === target && key === 'value' && input === 103 && data === payload && context === globalThis);
    writes++;
  }, payload);
  gc('shrinking'); assert(target.value === payload); target.value = 103; assert(reads === 1 && writes === 1);
});
check('native-return-slot-default-and-value-overloads', () => {
  const target = {}, symbol = Symbol('result'), object = {payload: 107};
  const values = [undefined, true, false, 109, -113.5, '', 'result', symbol, object];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];api.defineNativeProperty(target, String(i), () => value, undefined);
    assert(Object.is(target[i], value));
  }
});
check('native-property-attributes-map-all-portable-combinations', () => {
  for (let flags = 0; flags < 8; flags++) {
    const target = {}; let state = 127;
    api.defineNativeProperty(target, 'value', () => state, (_, __, input) => {state = input}, undefined, flags);
    const d = Object.getOwnPropertyDescriptor(target, 'value');
    assert(d.value === 127 && d.writable === !(flags & 1) && d.enumerable === !(flags & 2) && d.configurable === !(flags & 4));
    assert(Reflect.set(target, 'value', 131) === !(flags & 1));
    assert(target.value === (flags & 1 ? 127 : 131));
  }
});
check('native-setter-false-rejects-reflect-and-strict-assignment', () => {
  const target = {}; let writes = 0;
  api.defineNativeProperty(target, 'value', () => 137, () => {writes++;return false});
  assert(Reflect.set(target, 'value', 139) === false);
  let error;try {target.value = 149} catch (caught) {error = caught}
  assert(error?.name === 'TypeError' && writes === 2 && target.value === 137);
});
check('native-int32-coercion-preserves-errors-and-context-scope', () => {
  const other = newGlobal({newCompartment: true});
  const values = [undefined, null, false, NaN, Infinity, -Infinity, -0, 4294967296, 4294976525, -4294958067, '9229', {valueOf() {return 9229}}];
  for (const value of values) assert(api.nativeContext('int32', other, value) === Int32Array.of(value)[0]);
  const sentinel = Error('PROPERTY_INT32_SENTINEL'); let error;
  try {api.nativeContext('int32', other, {valueOf() {throw sentinel}})} catch (caught) {error = caught}
  assert(error === sentinel);
  assert(api.nativeContext('int32', other, 151) === 151);
});
check('nested-native-function-and-property-frames-restore-outer-return-slot', () => {
  const target = {}, payload = {tag: 'outer'};let calls = 0;
  api.defineNativeProperty(target, 'nested', () => {calls++;return 157}, undefined);
  api.defineNativeProperty(target, 'value', (holder, key, data, context) => {
    assert(data === payload && holder === target && key === 'value' && context === globalThis);
    const result = api.nativeContext('int32', globalThis, {valueOf() {return target.nested}});
    assert(result === 157);return payload;
  }, undefined, payload);
  assert(target.value === payload && calls === 1); assert(target.nested === 157 && calls === 2);
});
check('failed-property-owner-cannot-enter-through-live-caller', () => {
  const other = newGlobal({newCompartment: true});api.initializeContext(other);api.initializeRealm(other);
  const target = other.eval('({})');api.defineNativeProperty(target, 'value', () => 163, undefined);
  assert(target.value === 163);
  try {api.runNodeBootstrap(other)} catch (_) {}
  let error;try {target.value} catch (caught) {error = caught}
  assert(error?.message.includes('Previous Node realm initialization failed'));
  const own = {};api.defineNativeProperty(own, 'value', () => 167, undefined);assert(own.value === 167);
});
check('target-creation-context-and-payload-cross-compartment-identity', () => {
  const other = newGlobal({newCompartment: true});api.initializeContext(other);api.initializeRealm(other);
  const target = other.eval('({})'), payload = {tag: 'shared'};
  api.defineNativeProperty(target, 'value', (holder, key, data, context) => {
    assert(holder === target && data === payload && context === other && key === 'value');return payload;
  }, undefined, payload);
  gc('shrinking');assert(target.value === payload);
});
check('native-callback-payload-is-traced-without-getter-closure-capture', () => {
  const target = {};
  (() => {api.defineNativeProperty(target, 'value', (_, __, data) => data, undefined, new Uint8Array(4096).fill(173))})();
  for (let i = 0; i < 3; i++) gc('shrinking');
  assert(target.value.length === 4096 && target.value[2047] === 173);
});
print(JSON.stringify({kind: 'property-callback-property-controls', cases: observations.length, sharedCases, failures, observations, upstreamStartup: false}));
if (failures) quit(1);
