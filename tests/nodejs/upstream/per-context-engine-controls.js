'use strict';
// Complete original per-context scripts execute in the guest engine. These
// controls do not exercise Node's realm/bootstrap loaders or CJS/ESM startup.
const api = globalThis.__kandeloUpstreamTest;
if (!api || typeof api.initializeContext !== 'function') throw new Error('missing native context controls');
const observations = [];
let failures = 0;
let exports;
let state;
function check(name, callback) {
  try { callback(); observations.push({ name, status: 'pass' }); return true; }
  catch (error) {
    failures++;
    observations.push({ name, status: 'fail', error: {
      name: error.name, message: error.message, stack: error.stack,
    } });
    return false;
  }
}
function thrown(callback, message) {
  let caught;
  try { callback(); } catch (error) { caught = error; }
  if (!caught || !String(caught.message).includes(message)) throw new Error('expected ' + message + ', got ' + String(caught));
  return caught;
}
function report() {
  print(JSON.stringify({ kind: 'upstream-per-context-controls', plannedCases: 14,
    cases: observations.length, notRun: 14 - observations.length, failures, observations,
    limits: ['No Node realm/bootstrap loader or CJS/ESM entrypath',
      'No browser execution', 'No OOM/finalization or complete native differential proof'] }));
}
if (!check('three-original-initializers-complete', () => {
  exports = api.initializeContext();
  state = api.inspectContext();
  assertEq(state.phase, 2);
  assertEq(state.completedScripts, 3);
  assertEq(state.exports, exports);
})) { report(); quit(1); }
check('primordials-and-export-descriptors', () => {
  assertEq(Object.getPrototypeOf(exports), Object.prototype);
  assertEq(Object.getPrototypeOf(exports.primordials), null);
  assertEq(Object.isFrozen(exports.primordials), true);
  const descriptor = Object.getOwnPropertyDescriptor(exports, 'primordials');
  assertEq(descriptor.enumerable, true);
  assertEq(descriptor.configurable, true);
  assertEq(descriptor.writable, true);
  const map = new exports.primordials.SafeMap([['key', 42]]);
  assertEq(map.get('key'), 42);
});
check('complete-native-symbol-inventories-and-descriptors', () => {
  assertEq(Object.getPrototypeOf(state.privateSymbols), null);
  assertEq(Object.getPrototypeOf(state.perIsolateSymbols), null);
  assertEq(Object.keys(state.privateSymbols).length, 22);
  assertEq(Object.keys(state.perIsolateSymbols).length, 27);
  for (const table of [state.privateSymbols, state.perIsolateSymbols]) {
    for (const name of Object.keys(table)) {
      const descriptor = Object.getOwnPropertyDescriptor(table, name);
      assertEq(typeof descriptor.value, 'symbol');
      assertEq(Symbol.keyFor(descriptor.value), undefined);
      assertEq(descriptor.enumerable, true);
      assertEq(descriptor.configurable, true);
      assertEq(descriptor.writable, true);
    }
  }
  assertEq(state.perIsolateSymbols.handle_onclose_symbol.description, 'handle_onclose');
});
check('runtime-identities-shared-with-fresh-realm-tables', () => {
  const realm = newGlobal({ newCompartment: true });
  api.initializeContext(realm);
  const other = api.inspectContext(realm);
  assertEq(other.phase, 2);
  assertEq(other.completedScripts, 3);
  assertEq(other.privateSymbols === state.privateSymbols, false);
  assertEq(other.perIsolateSymbols === state.perIsolateSymbols, false);
  for (const name of Object.keys(state.privateSymbols))
    assertEq(other.privateSymbols[name], state.privateSymbols[name]);
  for (const name of Object.keys(state.perIsolateSymbols))
    assertEq(other.perIsolateSymbols[name], state.perIsolateSymbols[name]);
});
check('exports-and-constructors-owned-by-their-realms', () => {
  const realm = newGlobal({ newCompartment: true });
  const other = api.initializeContext(realm);
  assertEq(other === exports, false);
  assertEq(other.primordials === exports.primordials, false);
  assertEq(other.DOMException === exports.DOMException, false);
  assertEq(Object.getPrototypeOf(other), realm.Object.prototype);
  assertEq(Object.getPrototypeOf(other.primordials), null);
});
check('original-domexception-and-real-hidden-clone-marker', () => {
  const error = new exports.DOMException('message', 'AbortError');
  assertEq(error.name, 'AbortError');
  assertEq(error.message, 'message');
  assertEq(error.code, 20);
  const key = state.privateSymbols.transfer_mode_private_symbol;
  assertEq(error[key], 2);
  assertEq(Reflect.ownKeys(error).includes(key), false);
  assertEq(Object.create(error)[key], undefined);
  const clone = error[state.perIsolateSymbols.messaging_clone_symbol]();
  assertEq(clone.data.message, 'message');
  assertEq(clone.data.name, 'AbortError');
});
check('original-quotaexceedederror-class-private-state', () => {
  const error = new exports.QuotaExceededError('quota', { quota: 12, requested: 20 });
  assertEq(error.name, 'QuotaExceededError');
  assertEq(error.quota, 12);
  assertEq(error.requested, 20);
  assertEq(error[state.privateSymbols.transfer_mode_private_symbol], 2);
});
check('original-messageport-dispatch', () => {
  const ports = [{}];
  let event;
  const target = { onmessage(value) { event = value; } };
  exports.emitMessage.call(target, 'data', ports, 'message');
  assertEq(event.data, 'data');
  assertEq(event.target, target);
  assertEq(event.type, 'message');
  assertEq(event.ports, ports);
  const dispatch = Symbol.for('nodejs.internal.kHybridDispatch');
  const receiving = Symbol.for('nodejs.internal.kCurrentlyReceivingPorts');
  target[dispatch] = function(data, type) {
    assertEq(data, 'hybrid'); assertEq(type, 'message'); assertEq(this[receiving], ports);
    throw new Error('dispatch failure');
  };
  thrown(() => exports.emitMessage.call(target, 'hybrid', ports, 'message'), 'dispatch failure');
  assertEq(target[receiving], undefined);
});
check('canonical-exports-and-no-repeat-initialization', () => {
  assertEq(api.getContextExports(), exports);
  assertEq(api.getContextExports(globalThis), exports);
  thrown(() => api.initializeContext(), 'already initialized');
  assertEq(api.getContextExports(), exports);
  assertEq(api.inspectContext().completedScripts, 3);
});
check('uninitialized-context-does-not-return-success', () => {
  const realm = newGlobal({ newCompartment: true });
  thrown(() => api.getContextExports(realm), 'has not been initialized');
  const other = api.initializeContext(realm);
  assertEq(api.getContextExports(realm), other);
});
check('original-exception-preserved-and-failure-terminal', () => {
  const realm = newGlobal({ newCompartment: true });
  const sentinel = { identity: 'original initializer failure' };
  realm.sentinel = sentinel;
  realm.eval("globalThis.originalArray = Array; globalThis.reads = 0; Object.defineProperty(globalThis, 'Array', { configurable: true, get() { reads++; throw sentinel; } });");
  let caught;
  try { api.initializeContext(realm); } catch (error) { caught = error; }
  assertEq(caught, sentinel);
  const failed = api.inspectContext(realm);
  assertEq(failed.phase, 3);
  assertEq(failed.completedScripts, 0);
  assertEq('exports' in failed, false);
  const reads = realm.reads;
  realm.eval("Object.defineProperty(globalThis, 'Array', { configurable: true, writable: true, value: originalArray });");
  thrown(() => api.initializeContext(realm), 'Previous Node context initialization failed');
  thrown(() => api.getContextExports(realm), 'Previous Node context initialization failed');
  assertEq(realm.reads, reads);
  // Fail the second and third original scripts through real inherited setters.
  // Earlier completed scripts must stay recorded, with no usable partial exports.
  for (const [property, completed] of [['DOMException', 1], ['emitMessage', 2]]) {
    const failedRealm = newGlobal({ newCompartment: true });
    failedRealm.sentinel = sentinel;
    failedRealm.eval("Object.defineProperty(Object.prototype, '" + property +
      "', { configurable: true, set() { throw sentinel; } });");
    let original;
    try { api.initializeContext(failedRealm); } catch (error) { original = error; }
    assertEq(original, sentinel);
    const partial = api.inspectContext(failedRealm);
    assertEq(partial.phase, 3);
    assertEq(partial.completedScripts, completed);
    assertEq('exports' in partial, false);
    thrown(() => api.getContextExports(failedRealm), 'Previous Node context initialization failed');
    thrown(() => api.initializeContext(failedRealm), 'Previous Node context initialization failed');
  }
});
check('reentrant-initialization-refused-without-second-execution', () => {
  const realm = newGlobal({ newCompartment: true });
  realm.nativeControls = api;
  realm.eval("globalThis.originalArray = Array; globalThis.reentries = 0; Object.defineProperty(globalThis, 'Array', { configurable: true, get() { try { nativeControls.initializeContext(globalThis); } catch (error) { if (!String(error.message).includes('Reentrant')) throw error; reentries++; } return originalArray; } });");
  api.initializeContext(realm);
  assertEq(realm.reentries > 0, true);
  assertEq(api.inspectContext(realm).completedScripts, 3);
});
check('non-global-and-scripted-proxy-targets-refused', () => {
  thrown(() => api.initializeContext({}), 'requires a genuine global');
  thrown(() => api.initializeContext(new Proxy(globalThis, {})), 'requires a genuine global');
  assertEq(api.getContextExports(), exports);
});
check('canonical-state-and-shared-identities-survive-gc', () => {
  const realm = newGlobal({ newCompartment: true });
  const other = api.initializeContext(realm);
  const privateKey = api.inspectContext(realm).privateSymbols.transfer_mode_private_symbol;
  gc();
  assertEq(api.getContextExports(realm), other);
  assertEq(api.inspectContext(realm).privateSymbols.transfer_mode_private_symbol, privateKey);
  assertEq(privateKey, state.privateSymbols.transfer_mode_private_symbol);
});
report();
if (failures) quit(1);
