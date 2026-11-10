'use strict';
// Privileged JS-shell controls, enabled only by --kandelo-test-upstream.
// These exercise the actual embedding-private primitive, not upstream startup.
const native = globalThis.__kandeloUpstreamTest;
if (!native || typeof native.newPrivateKey !== 'function' ||
    typeof native.initializePrivateKey !== 'function') {
  throw new Error('Missing privileged native upstream test controls');
}
const key = native.newPrivateKey('node:engine-private-control');
const observations = [];
let failures = 0;
function check(name, fn) {
  try {
    fn();
    observations.push({ name, status: 'pass' });
  } catch (error) {
    failures++;
    observations.push({ name, status: 'fail', error: {
      name: error.name, message: error.message, stack: error.stack,
    } });
  }
}
function throws(fn, Constructor = Error) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  if (!(caught instanceof Constructor)) {
    throw new Error('Expected ' + Constructor.name + ', got ' + String(caught));
  }
}
function emptyReflection(object) {
  assertEq(Reflect.ownKeys(object).length, 0);
  assertEq(Object.getOwnPropertySymbols(object).length, 0);
  assertEq(Object.getOwnPropertyNames(object).length, 0);
  assertEq(Object.keys(object).length, 0);
}
check('fresh-hidden-symbol-identity', () => {
  assertEq(typeof key, 'symbol');
  assertEq(Symbol.keyFor(key), undefined);
  assertEq(key === Symbol('node:engine-private-control'), false);
  assertEq(key === native.newPrivateKey('node:engine-private-control'), false);
});
check('hidden-from-reflection-and-copy', () => {
  const object = {};
  object[key] = 2;
  assertEq(object[key], 2);
  emptyReflection(object);
  emptyReflection(Object.assign({}, object));
  emptyReflection({ ...object });
});
check('missing-native-read', () => {
  assertEq(({})[key], undefined);
  assertEq(key in {}, false);
  assertEq(Object.hasOwn({}, key), false);
});
check('own-only-read-has-and-write', () => {
  const parent = {};
  parent[key] = 2;
  const child = Object.create(parent);
  assertEq(child[key], undefined);
  assertEq(key in child, false);
  assertEq(Object.hasOwn(child, key), false);
  child[key] = 3;
  assertEq(parent[key], 2);
  assertEq(child[key], 3);
  assertEq(Object.hasOwn(child, key), true);
});
check('own-only-lookup-ignores-prototype-proxy', () => {
  let calls = 0;
  const prototype = new Proxy({}, {
    get() { calls++; throw new Error('get trap'); },
    set() { calls++; throw new Error('set trap'); },
    has() { calls++; throw new Error('has trap'); },
  });
  const object = Object.create(prototype);
  assertEq(object[key], undefined);
  assertEq(key in object, false);
  object[key] = 4;
  assertEq(object[key], 4);
  assertEq(calls, 0);
});
for (const [name, restrict] of [
  ['prevent-extensions', Object.preventExtensions],
  ['seal', Object.seal],
  ['freeze', Object.freeze],
]) {
  check('new-write-after-' + name, () => {
    const object = restrict({});
    object[key] = 2;
    object[key] = 3;
    assertEq(object[key], 3);
    assertEq(Object.isExtensible(object), false);
    emptyReflection(object);
    if (name === 'freeze') assertEq(Object.isFrozen(object), true);
  });
  check('existing-write-after-' + name, () => {
    const object = {};
    object[key] = 2;
    restrict(object);
    object[key] = 3;
    assertEq(object[key], 3);
    assertEq(delete object[key], true);
    assertEq(object[key], undefined);
  });
}
check('ordinary-assignment-descriptor', () => {
  const object = {};
  object[key] = 2;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  assertEq(descriptor.value, 2);
  assertEq(descriptor.enumerable, false);
  assertEq(descriptor.writable, true);
  assertEq(descriptor.configurable, true);
});
check('native-initialization-on-frozen-object', () => {
  const object = Object.freeze({});
  native.initializePrivateKey(object, key, 8);
  assertEq(object[key], 8);
  assertEq(Object.isFrozen(object), true);
  assertEq(Object.getOwnPropertyDescriptor(object, key).enumerable, false);
});
check('missing-proxy-read-has-delete-bypass-traps', () => {
  let calls = 0;
  const proxy = new Proxy({}, {
    get() { calls++; throw new Error('get trap'); },
    has() { calls++; throw new Error('has trap'); },
    getOwnPropertyDescriptor() { calls++; throw new Error('descriptor trap'); },
    deleteProperty() { calls++; throw new Error('delete trap'); },
  });
  assertEq(proxy[key], undefined);
  assertEq(key in proxy, false);
  assertEq(Object.hasOwn(proxy, key), false);
  assertEq(Object.getOwnPropertyDescriptor(proxy, key), undefined);
  assertEq(delete proxy[key], true);
  assertEq(calls, 0);
});
check('first-ordinary-proxy-write-rejected', () => {
  let calls = 0;
  const proxy = new Proxy({}, {
    set() { calls++; return true; },
    defineProperty() { calls++; return true; },
  });
  throws(() => { proxy[key] = 2; }, TypeError);
  assertEq(calls, 0);
});
check('native-proxy-initialize-read-update-descriptor-has-delete', () => {
  let calls = 0;
  const proxy = new Proxy({}, {
    get() { calls++; throw new Error('get trap'); },
    set() { calls++; throw new Error('set trap'); },
    defineProperty() { calls++; throw new Error('define trap'); },
    getOwnPropertyDescriptor() { calls++; throw new Error('descriptor trap'); },
    has() { calls++; throw new Error('has trap'); },
    deleteProperty() { calls++; throw new Error('delete trap'); },
  });
  native.initializePrivateKey(proxy, key, 2);
  assertEq(proxy[key], 2);
  proxy[key] = 3;
  assertEq(proxy[key], 3);
  assertEq(key in proxy, true);
  assertEq(Object.hasOwn(proxy, key), true);
  const descriptor = Object.getOwnPropertyDescriptor(proxy, key);
  assertEq(descriptor.value, 3);
  assertEq(descriptor.enumerable, false);
  assertEq(descriptor.writable, true);
  assertEq(descriptor.configurable, true);
  assertEq(proxy[native.newPrivateKey('absent')], undefined);
  assertEq(delete proxy[key], true);
  assertEq(proxy[key], undefined);
  assertEq(Object.hasOwn(proxy, key), false);
  throws(() => { proxy[key] = 4; }, TypeError);
  assertEq(calls, 0);
});
check('proxy-private-entry-is-not-a-target-property', () => {
  const target = {};
  const proxy = new Proxy(target, {});
  native.initializePrivateKey(proxy, key, 2);
  assertEq(target[key], undefined);
  emptyReflection(proxy);
  emptyReflection(target);
  Object.freeze(proxy);
  proxy[key] = 3;
  assertEq(proxy[key], 3);
  assertEq(Object.isFrozen(proxy), true);
});
check('native-private-on-revoked-scripted-proxy', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  native.initializePrivateKey(proxy, key, 2);
  revoke();
  assertEq(proxy[key], 2);
  proxy[key] = 3;
  assertEq(proxy[key], 3);
  assertEq(Object.hasOwn(proxy, key), true);
  assertEq(delete proxy[key], true);
  assertEq(proxy[key], undefined);
});
check('cross-compartment-forwarding-retains-target-ownership', () => {
  const realm = newGlobal({ newCompartment: true });
  const object = realm.eval('Object.freeze({})');
  native.initializePrivateKey(object, key, 2);
  object[key] = 3;
  assertEq(object[key], 3);
  const child = Object.create(object);
  assertEq(child[key], undefined);
  child[key] = 4;
  assertEq(object[key], 3);
  assertEq(child[key], 4);
  emptyReflection(object);
  assertEq(delete object[key], true);
  assertEq(object[key], undefined);
});
check('hidden-proxy-value-survives-gc', () => {
  const proxy = new Proxy({}, {});
  native.initializePrivateKey(proxy, key, { token: 42 });
  gc();
  assertEq(proxy[key].token, 42);
  assertEq(delete proxy[key], true);
});
check('ordinary-symbol-semantics-preserved', () => {
  const ordinary = Symbol('control');
  const parent = { [ordinary]: 2 };
  assertEq(Object.create(parent)[ordinary], 2);
  assertEq(Object.getOwnPropertySymbols(parent)[0], ordinary);
  assertEq(Object.getOwnPropertyDescriptor(parent, ordinary).enumerable, true);
  throws(() => { Object.freeze({})[ordinary] = 3; }, TypeError);
});
check('language-class-private-semantics-preserved', () => {
  class Private {
    #value = 2;
    read(other) { return other.#value; }
    write(value) { this.#value = value; }
    static has(other) { return #value in other; }
  }
  const object = Object.freeze(new Private());
  object.write(3);
  assertEq(object.read(object), 3);
  assertEq(Private.has(object), true);
  const child = Object.create(object);
  assertEq(Private.has(child), false);
  throws(() => object.read(child), TypeError);
  throws(() => object.read(new Proxy(object, {})), TypeError);
});
check('native-initializer-refuses-public-symbol', () => {
  throws(() => native.initializePrivateKey({}, Symbol('wrong-kind'), 2));
});
print(JSON.stringify({
  kind: 'engine-private-key-controls-only', cases: observations.length,
  failures, observations,
  limits: ['No upstream startup', 'No complete native-V8 differential proof',
    'No security-wrapper policy or OOM/GC-finalization proof',
    'No per-runtime symbol owner or per-context initializer coverage'],
}));
if (failures) quit(1);
