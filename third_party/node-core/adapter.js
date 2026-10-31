// Portable boundaries for the unmodified, pinned Node assertion algorithms.
// No test harness APIs or assertion replacements are installed here.
function _createNodeCore(platform) {
    const NativeSet = Set, Uint8 = Uint8Array;
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
        // There are no KeyObject or CryptoKey instances in this runtime.
        // Their constructors remain unsupported; no synthetic keys are made.
        isKeyObject: () => false,
        isCryptoKey: () => false,
        isPromise: platform.isPromise,
        isNativeError: platform.isNativeError,
        isProxy: platform.isProxy,
    };
    for (const name of ['Uint8', 'Uint8Clamped', 'Uint16', 'Uint32', 'Int8', 'Int16', 'Int32',
        'Float16', 'Float32', 'Float64', 'BigInt64', 'BigUint64']) {
        types['is' + name + 'Array'] = value => tag(value) === name + 'Array';
    }
    types.isBoxedPrimitive = v => types.isNumberObject(v) || types.isStringObject(v) ||
        types.isBooleanObject(v) || types.isBigIntObject(v) || types.isSymbolObject(v);
    const isError = v => types.isNativeError(v) || v instanceof Error;
    const setAdd = uncurry(Set.prototype.add), setHas = uncurry(Set.prototype.has);
    const setDelete = uncurry(Set.prototype.delete), setSize = getter(Set.prototype, 'size');
    class SafeSet {
        #set = new NativeSet();
        add(value) { setAdd(this.#set, value); return this; }
        has(value) { return setHas(this.#set, value); }
        delete(value) { return setDelete(this.#set, value); }
        get size() { return setSize(this.#set); }
    }
    Object.freeze(SafeSet.prototype);
    const primordials = { SafeSet };
    for (const name of ['Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array',
        'Boolean', 'DataView', 'Date', 'Error', 'Float16Array', 'Float32Array', 'Float64Array',
        'Function', 'Int16Array', 'Int32Array', 'Int8Array', 'Map', 'Number', 'Object', 'Promise',
        'RegExp', 'Set', 'String', 'Symbol', 'Uint16Array', 'Uint32Array', 'Uint8Array',
        'Uint8ClampedArray', 'WeakMap', 'WeakSet']) primordials[name] = globalThis[name];
    for (const [name, ctor, methods] of [
        ['Array', Array, ['forEach', 'indexOf', 'join', 'push', 'slice']],
        ['BigInt', BigInt, ['valueOf']], ['Boolean', Boolean, ['valueOf']],
        ['Date', Date, ['getTime']], ['Error', Error, ['toString']],
        ['Function', Function, ['call']], ['Number', Number, ['valueOf']],
        ['Object', Object, ['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toString']],
        ['RegExp', RegExp, ['exec']],
        ['String', String, ['charCodeAt', 'indexOf', 'replace', 'slice', 'split', 'valueOf']],
        ['Symbol', Symbol, ['valueOf']],
    ]) for (const method of methods) {
        primordials[name + 'Prototype' + method[0].toUpperCase() + method.slice(1)] = uncurry(ctor.prototype[method]);
    }
    Object.assign(primordials, {
        ArrayIsArray: Array.isArray, NumberIsNaN: Number.isNaN,
        ObjectAssign: Object.assign, ObjectDefineProperty: Object.defineProperty,
        ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
        ObjectGetOwnPropertySymbols: Object.getOwnPropertySymbols,
        ObjectGetPrototypeOf: Object.getPrototypeOf, ObjectIs: Object.is, ObjectKeys: Object.keys,
        SymbolToStringTag: Symbol.toStringTag,
        TypedArrayPrototypeGetByteLength: getter(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength'),
        TypedArrayPrototypeGetSymbolToStringTag: tag,
        ErrorCaptureStackTrace: typeof Error.captureStackTrace === 'function'
            ? Error.captureStackTrace : target => { target.stack = new Error().stack; },
    });
    const codeError = (Base, code) => class extends Base {
        constructor(...args) { super(args.map(value => platform.inspect(value)).join(' ')); this.code = code; }
    };
    const codes = {};
    for (const code of ['ERR_AMBIGUOUS_ARGUMENT', 'ERR_CONSTRUCT_CALL_REQUIRED', 'ERR_INVALID_ARG_TYPE',
        'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_RETURN_VALUE', 'ERR_MISSING_ARGS']) {
        codes[code] = codeError(TypeError, code);
    }
    class AssertionError extends Error {
        constructor(options) {
            if (options === null || typeof options !== 'object') throw new codes.ERR_INVALID_ARG_TYPE('options', 'Object', options);
            const { message, actual, expected, operator, stackStartFn } = options;
            super(message == null ? `${platform.inspect(actual)} ${operator} ${platform.inspect(expected)}` : String(message));
            this.name = 'AssertionError';
            this.code = 'ERR_ASSERTION';
            this.actual = actual;
            this.expected = expected;
            this.operator = operator;
            this.generatedMessage = message == null;
            this.diff = options.diff === undefined ? 'simple' : options.diff;
            if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(this, stackStartFn || AssertionError);
        }
        toString() { return `${this.name} [${this.code}]: ${this.message}`; }
    }
    const modules = {
        'internal/errors': { codes, isErrorStackTraceLimitWritable: () => false },
        // Expression extraction is a diagnostic feature; SpiderMonkey does not
        // supply Node's source-location binding. Assertions still always fail.
        'internal/errors/error_source': { getErrorSourceExpression: () => undefined },
        'internal/assert/assertion_error': AssertionError,
        'internal/util/types': types,
        'internal/util/inspect': { inspect: platform.inspect, format: platform.format },
        'internal/util': { isError, setOwnProperty: (object, key, value) =>
            define(object, key, { value, enumerable: true, writable: true, configurable: true }) },
        'internal/url': { isURL: brand(getter(platform.URL.prototype, 'href')) },
        'buffer': { Buffer: platform.Buffer },
        'internal/validators': {
            validateFunction: (value, name) => {
                if (typeof value !== 'function') throw new codes.ERR_INVALID_ARG_TYPE(name, 'Function', value);
            },
            validateOneOf: (value, name, values) => {
                if (!values.includes(value)) throw new codes.ERR_INVALID_ARG_VALUE(name, value);
            },
        },
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
                throw new codes.ERR_INVALID_ARG_TYPE('buffer', ['Buffer', 'TypedArray', 'DataView']);
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
        if (own(modules, name)) return modules[name];
        if (!own(factories, name)) throw new Error(`Unsupported Node assertion module: ${name}`);
        const module = { exports: {} };
        modules[name] = module.exports;
        factories[name](module, module.exports, require, primordials, internalBinding);
        return modules[name] = module.exports;
    }
    return { assert: require('assert'), comparisons: require('internal/util/comparisons'), types };
}
