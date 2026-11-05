// Shared intrinsic brands for the assertion and inspection adapters.
function _createNodeCoreTypes(platform) {
    const uncurry = fn => Function.prototype.call.bind(fn);
    const getter = (object, name) => uncurry(Object.getOwnPropertyDescriptor(object, name).get);
    const tag = getter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
    const brand = fn => value => {
        if (value === null || typeof value !== 'object') return false;
        try { fn(value); return true; } catch (_) { return false; }
    };
    const arrayBuffer = brand(getter(ArrayBuffer.prototype, 'byteLength'));
    const sharedBuffer = typeof SharedArrayBuffer === 'function'
        ? brand(getter(SharedArrayBuffer.prototype, 'byteLength')) : () => false;
    const types = {
        isArrayBuffer: arrayBuffer,
        isSharedArrayBuffer: sharedBuffer,
        isAnyArrayBuffer: v => arrayBuffer(v) || sharedBuffer(v),
        isArrayBufferView: ArrayBuffer.isView,
        isTypedArray: v => tag(v) !== undefined,
        isDataView: brand(getter(DataView.prototype, 'buffer')),
        isDate: brand(uncurry(Date.prototype.getTime)),
        isRegExp: brand(getter(RegExp.prototype, 'source')),
        isMap: brand(getter(Map.prototype, 'size')),
        isSet: brand(getter(Set.prototype, 'size')),
        isWeakMap: brand(uncurry(WeakMap.prototype.has)),
        isWeakSet: brand(uncurry(WeakSet.prototype.has)),
        isBigIntObject: brand(uncurry(BigInt.prototype.valueOf)),
        isBooleanObject: brand(uncurry(Boolean.prototype.valueOf)),
        isNumberObject: brand(uncurry(Number.prototype.valueOf)),
        isStringObject: brand(uncurry(String.prototype.valueOf)),
        isSymbolObject: brand(uncurry(Symbol.prototype.valueOf)),
        // Production probes use actual engine slots. Explicit dependency
        // fixtures without a key owner cannot construct branded instances.
        isKeyObject: platform.isKeyObject || (() => false),
        isCryptoKey: platform.isCryptoKey || (() => false),
        isPromise: platform.isPromise,
        isNativeError: platform.isNativeError,
        isProxy: platform.isProxy,
        isArgumentsObject: v => platform.hasObjectKind(v, 'Arguments'),
        isAsyncFunction: v => platform.hasObjectKind(v, 'AsyncFunction'),
        isGeneratorFunction: v => platform.hasObjectKind(v, 'GeneratorFunction'),
        isGeneratorObject: v => platform.hasObjectKind(v, 'GeneratorObject'),
        isMapIterator: v => platform.hasObjectKind(v, 'MapIterator'),
        isSetIterator: v => platform.hasObjectKind(v, 'SetIterator'),
        isModuleNamespaceObject: v => platform.hasObjectKind(v, 'ModuleNamespace'),
        // Node External values have no constructor or representation here.
        // FFI integration must define their real ownership before adding one.
        isExternal: () => false,
    };
    const checks = ['isNumberObject', 'isStringObject', 'isBooleanObject', 'isBigIntObject', 'isSymbolObject']
        .map(name => types[name]);
    const some = uncurry(Array.prototype.some);
    types.isBoxedPrimitive = value => some(checks, check => check(value));
    for (const name of ['Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
        'Int8Array', 'Int16Array', 'Int32Array', 'Float16Array', 'Float32Array',
        'Float64Array', 'BigInt64Array', 'BigUint64Array']) {
        types['is' + name] = value => tag(value) === name;
    }
    return types;
}

// Portable boundaries for the unmodified, pinned Node assertion algorithms.
// No test harness APIs or assertion replacements are installed here.
function _createNodeCore(platform) {
    const Uint8 = Uint8Array;
    const arrayBufferIsView = ArrayBuffer.isView;
    const number = Number, string = String, integer = Number.isInteger;
    const own = Object.hasOwn, define = Object.defineProperty, min = Math.min;
    const uncurry = fn => Function.prototype.call.bind(fn);
    const getter = (object, name) => uncurry(Object.getOwnPropertyDescriptor(object, name).get);
    const tag = getter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag);
    const brand = fn => value => {
        if (value === null || typeof value !== 'object') return false;
        try { fn(value); return true; } catch (_) { return false; }
    };
    const types = _createNodeCoreTypes(platform);
    const isError = v => types.isNativeError(v) || v instanceof Error;
    const primordials = _createNodePrimordials();
    const modules = {
        // Expression extraction is a diagnostic feature; SpiderMonkey does not
        // supply Node's source-location binding. Assertions still always fail.
        'internal/errors/error_source': { getErrorSourceExpression: () => undefined },
        'internal/util/types': types,
        'internal/util/inspect': { inspect: platform.inspect, format: platform.format },
        'internal/util': { isError, setOwnProperty: (object, key, value) =>
            define(object, key, { value, enumerable: true, writable: true, configurable: true }) },
        'internal/url': { isURL: brand(getter(platform.URL.prototype, 'href')) },
        'buffer': { Buffer: platform.Buffer },
        'internal/assert': Object.assign(value => { if (!value) throw new Error('Node comparison invariant failed'); },
            { fail: message => { throw new Error(message); } }),
    };
    const ownKeys = Reflect.ownKeys, enumerable = uncurry(Object.prototype.propertyIsEnumerable);
    const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const typedBuffer = getter(typedPrototype, 'buffer'), typedOffset = getter(typedPrototype, 'byteOffset');
    const dataBuffer = getter(DataView.prototype, 'buffer'), dataOffset = getter(DataView.prototype, 'byteOffset');
    const dataLength = getter(DataView.prototype, 'byteLength');
    const bytes = value => tag(value) === undefined
        ? new Uint8(dataBuffer(value), dataOffset(value), dataLength(value))
        : new Uint8(typedBuffer(value), typedOffset(value), primordials.TypedArrayPrototypeGetByteLength(value));
    const internalBinding = name => {
        if (name === 'buffer') return { compare: (a, b) => {
            if (!arrayBufferIsView(a) || !arrayBufferIsView(b)) {
                throw new (platform.getValues().errors.codes.ERR_INVALID_ARG_TYPE)('buffer', ['Buffer', 'TypedArray', 'DataView'], a);
            }
            a = bytes(a); b = bytes(b);
            for (let i = 0; i < min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
            return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
        } };
        if (name === 'util') return {
            constants: { ONLY_ENUMERABLE: 1, SKIP_SYMBOLS: 2 },
            getOwnNonIndexProperties: (value, filter) => ownKeys(value).filter(key => {
                if (typeof key === 'symbol') return !(filter & 2) && (!(filter & 1) || enumerable(value, key));
                const index = number(key);
                if (string(index) === key && integer(index) && index >= 0 && index < 0xffffffff) return false;
                return !(filter & 1) || enumerable(value, key);
            }),
        };
        throw new Error(`Unsupported Node assertion binding: ${name}`);
    };
    const factories = {
        /* UPSTREAM_MODULES */
    };
    function require(name) {
        if (name === 'internal/errors') return platform.getValues().errors;
        if (name === 'internal/validators') return platform.getValues().validators;
        if (name === 'internal/util/colors') return platform.getValues().require(name);
        if (name === 'internal/crypto/keys' && typeof platform.getCryptoKeys === 'function')
            return platform.getCryptoKeys();
        if (own(modules, name)) return modules[name];
        if (!own(factories, name)) throw new Error(`Unsupported Node assertion module: ${name}`);
        const module = { exports: {} };
        modules[name] = module.exports;
        try { factories[name](module, module.exports, require, primordials, internalBinding, platform.process); }
        catch (error) { delete modules[name]; throw error; }
        return modules[name] = module.exports;
    }
    // Types establish the shared values owner before assertion modules load.
    // Lazy construction avoids a second validator/error hierarchy or a
    // partially initialized module being retained after a dependency throws.
    return { get assert() { return require('assert'); },
        get comparisons() { return require('internal/util/comparisons'); }, types, require };
}
