// Bounded observable comparisons with actual native process.debugPort/ppid.
// Each native reference case runs in a fresh authenticated child process.
const sharedControls = [
  ['native-data-descriptor-and-repeated-writes', make => {
    const {target, key} = make(true), initial = target[key];
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(d.value === initial && d.writable && d.enumerable && d.configurable);
    assert(!('get' in d) && !('set' in d));
    target[key] = initial + 1; assert(target[key] === initial + 1);
    target[key] = initial + 2; assert(target[key] === initial + 2);
    return true;
  }],
  ['inherited-write-creates-ordinary-receiver-property', make => {
    const {target, key} = make(true), initial = target[key], child = Object.create(target);
    child[key] = initial + 1;
    assert(target[key] === initial && child[key] === initial + 1);
    const d = Object.getOwnPropertyDescriptor(child, key);
    assert(d.value === initial + 1 && d.writable && d.enumerable && d.configurable);
    return true;
  }],
  ['reflect-write-with-distinct-receiver', make => {
    const {target, key} = make(true), initial = target[key], child = {};
    assert(Reflect.set(target, key, initial + 1, child));
    assert(child[key] === initial + 1 && target[key] === initial);
    return true;
  }],
  ['define-value-keeps-native-setter', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {value: initial + 1});
    assert(target[key] === initial + 1);
    target[key] = {valueOf() {throw Error('NATIVE_DATA_SENTINEL')}};
  }],
  ['attribute-only-definition-keeps-native-setter', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {enumerable: false});
    target[key] = initial + 1;
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(d.value === initial + 1 && !d.enumerable);
    target[key] = {valueOf() {throw Error('NATIVE_DATA_SENTINEL')}};
  }],
  ['read-only-configurable-data-still-accepts-value-definition', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {writable: false});
    let error; try {target[key] = initial + 1} catch (caught) {error = caught}
    assert(error?.name === 'TypeError' && target[key] === initial);
    Object.defineProperty(target, key, {value: initial + 2});
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(d.value === initial + 2 && !d.writable && d.configurable);
    return true;
  }],
  ['sealed-writable-native-setter-remains-live', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {configurable: false});
    target[key] = initial + 1;
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(d.value === initial + 1 && d.writable && !d.configurable);
    target[key] = {valueOf() {throw Error('NATIVE_DATA_SENTINEL')}};
  }],
  ['frozen-data-same-and-different-definitions', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {configurable: false, writable: false});
    Object.defineProperty(target, key, {value: initial});
    assert(!Reflect.defineProperty(target, key, {value: initial + 1}));
    assert(target[key] === initial);
    return true;
  }],
  ['attributes-apply-before-throwing-native-setter', make => {
    const {target, key} = make(true), initial = target[key];
    let error;
    try {Object.defineProperty(target, key, {
      value: {valueOf() {throw Error('NATIVE_DATA_SENTINEL')}},
      enumerable: false, writable: false,
    })} catch (caught) {error = caught}
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(error?.message === 'NATIVE_DATA_SENTINEL');
    // Payload updates belong to the native setter, independently of attributes.
    assert(!d.enumerable && !d.writable && d.configurable);
    return true;
  }],
  ['native-setter-deletion-stays-deleted', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {value: {valueOf() {
      delete target[key]; return initial + 1;
    }}, enumerable: false});
    assert(!Object.hasOwn(target, key));
    return true;
  }],
  ['native-setter-replacement-is-not-overwritten', make => {
    const {target, key} = make(true), initial = target[key];
    Object.defineProperty(target, key, {value: {valueOf() {
      delete target[key]; target[key] = 'replacement'; return initial + 1;
    }}, enumerable: false});
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(d.value === 'replacement' && d.writable && d.enumerable && d.configurable);
    return true;
  }],
  ['setterless-native-data-assignment-becomes-ordinary', make => {
    const {target, key} = make(false);
    target[key] = 73;
    const d = Object.getOwnPropertyDescriptor(target, key);
    assert(d.value === 73 && d.writable && d.enumerable && d.configurable);
    target[key] = {payload: 79}; assert(target[key].payload === 79);
    return true;
  }],
];
function observeShared(control, make) {
  try {
    const detail = control[1](make);
    // Three setter-persistence controls must throw the deliberate sentinel.
    assert(![3, 4, 6].includes(sharedControls.indexOf(control)), 'native setter was lost');
    return {name: control[0], status: 'pass', detail};
  } catch (error) {
    if ([3, 4, 6].includes(sharedControls.indexOf(control)) && error.message === 'NATIVE_DATA_SENTINEL')
      return {name: control[0], status: 'pass', detail: 'native-setter-sentinel'};
    throw error;
  }
}
