/* Node.js 26.13.0
Node.js is licensed for use as follows:

"""
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

This license applies to parts of Node.js originating from the
https://github.com/joyent/node repository:

"""
Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

*/
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
        "assert": function(module, exports, require, primordials, internalBinding) {
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayPrototypeForEach,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Error,
  FunctionPrototypeCall,
  NumberIsNaN,
  ObjectAssign,
  ObjectDefineProperty,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeIsPrototypeOf,
  RegExpPrototypeExec,
  String,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeSplit,
  Symbol,
} = primordials;

const {
  codes: {
    ERR_AMBIGUOUS_ARGUMENT,
    ERR_CONSTRUCT_CALL_REQUIRED,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE,
    ERR_MISSING_ARGS,
  },
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const { inspect } = require('internal/util/inspect');
const {
  isPromise,
  isRegExp,
} = require('internal/util/types');
const { isError, setOwnProperty } = require('internal/util');
const { innerOk, innerFail } = require('internal/assert/utils');

const {
  validateFunction,
  validateOneOf,
} = require('internal/validators');

const kOptions = Symbol('options');

let isDeepEqual;
let isDeepStrictEqual;
let isPartialStrictEqual;

function lazyLoadComparison() {
  const comparison = require('internal/util/comparisons');
  isDeepEqual = comparison.isDeepEqual;
  isDeepStrictEqual = comparison.isDeepStrictEqual;
  isPartialStrictEqual = comparison.isPartialStrictEqual;
}

// The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

module.exports = assert;

const NO_EXCEPTION_SENTINEL = {};

/**
 * Assert options.
 * @typedef {object} AssertOptions
 * @property {'full'|'simple'} [diff='simple'] - If set to 'full', shows the full diff in assertion errors.
 * @property {boolean} [strict=true] - If set to true, non-strict methods behave like their corresponding
 *   strict methods.
 * @property {boolean} [skipPrototype=false] - If set to true, skips comparing prototypes
 *   in deep equality checks.
 */

/**
 * @class Assert
 * @param {AssertOptions} [options] - Optional configuration for assertions.
 * @throws {ERR_CONSTRUCT_CALL_REQUIRED} If not called with `new`.
 */
function Assert(options) {
  if (!new.target) {
    throw new ERR_CONSTRUCT_CALL_REQUIRED('Assert');
  }

  options = ObjectAssign({ __proto__: null, strict: true, skipPrototype: false }, options);

  const allowedDiffs = ['simple', 'full'];
  if (options.diff !== undefined) {
    validateOneOf(options.diff, 'options.diff', allowedDiffs);
  }

  this.AssertionError = AssertionError;
  ObjectDefineProperty(this, kOptions, {
    __proto__: null,
    value: options,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  if (options.strict) {
    this.equal = this.strictEqual;
    this.deepEqual = this.deepStrictEqual;
    this.notEqual = this.notStrictEqual;
    this.notDeepEqual = this.notDeepStrictEqual;
  }
}

// All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided. All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

// DESTRUCTURING WARNING: All Assert.prototype methods use optional chaining
// (this?.[kOptions]) to safely access instance configuration. When methods are
// destructured from an Assert instance (e.g., const {strictEqual} = myAssert),
// they lose their `this` context and will use default behavior instead of the
// instance's custom options.

/**
 * Throws an AssertionError with the given message.
 * @param {any | Error} [message]
 */
Assert.prototype.fail = function fail(message) {
  if (isError(message)) throw message;

  let internalMessage = false;
  if (message === undefined) {
    message = 'Failed';
    internalMessage = true;
  }

  // IMPORTANT: When adding new references to `this`, ensure they use optional chaining
  // (this?.[kOptions]?.diff) to handle cases where the method is destructured from an
  // Assert instance and loses its context. Destructured methods will fall back
  // to default behavior when `this` is undefined.
  const errArgs = {
    operator: 'fail',
    stackStartFn: fail,
    message,
    diff: this?.[kOptions]?.diff,
  };
  const err = new AssertionError(errArgs);
  if (internalMessage) {
    err.generatedMessage = true;
  }
  throw err;
};

// The AssertionError is defined in internal/error.
assert.AssertionError = AssertionError;

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * @param {...any} args
 * @returns {void}
 */
function assert(...args) {
  innerOk(assert, ...args);
}

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * Duplicated as the other `ok` function is supercharged and exposed as default export.
 * @param {...any} args
 * @returns {void}
 */
Assert.prototype.ok = function ok(...args) {
  innerOk(ok, ...args);
};

/**
 * The equality assertion tests shallow, coercive equality with ==.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.equal = function equal(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!NumberIsNaN(actual) || !NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '==',
      stackStartFn: equal,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The non-equality assertion tests for whether two objects are not
 * equal with !=.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.notEqual = function notEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (NumberIsNaN(actual) && NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '!=',
      stackStartFn: notEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep equivalence assertion tests a deep equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.deepEqual = function deepEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepEqual',
      stackStartFn: deepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep non-equivalence assertion tests for any deep inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.notDeepEqual = function notDeepEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepEqual',
      stackStartFn: notDeepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict equivalence assertion tests a deep strict equality
 * relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.deepStrictEqual = function deepStrictEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepStrictEqual(actual, expected, this?.[kOptions]?.skipPrototype)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepStrictEqual',
      stackStartFn: deepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict non-equivalence assertion tests for any deep strict
 * inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepStrictEqual(actual, expected, this?.[kOptions]?.skipPrototype)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepStrictEqual',
      stackStartFn: notDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
}

/**
 * The strict equivalence assertion tests a strict equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.strictEqual = function strictEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (!ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'strictEqual',
      stackStartFn: strictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict non-equivalence assertion tests for any strict inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.notStrictEqual = function notStrictEqual(actual, expected, ...message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notStrictEqual',
      stackStartFn: notStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict equivalence assertion test between two objects
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.partialDeepStrictEqual = function partialDeepStrictEqual(
  actual,
  expected,
  ...message
) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isPartialStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'partialDeepStrictEqual',
      stackStartFn: partialDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

class Comparison {
  constructor(obj, keys, actual) {
    for (const key of keys) {
      if (key in obj) {
        if (actual !== undefined &&
            typeof actual[key] === 'string' &&
            isRegExp(obj[key]) &&
            RegExpPrototypeExec(obj[key], actual[key]) !== null) {
          this[key] = actual[key];
        } else {
          this[key] = obj[key];
        }
      }
    }
  }
}

function compareExceptionKey(actual, expected, key, message, keys, fn) {
  if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
    if (!message) {
      // Create placeholder objects to create a nice output.
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);

      const err = new AssertionError({
        actual: a,
        expected: b,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({
      actual,
      expected,
      message: [message],
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
  }
}

function expectedException(actual, expected, message, fn) {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== 'function') {
    // Handle regular expressions.
    if (isRegExp(expected)) {
      const str = String(actual);
      if (RegExpPrototypeExec(expected, str) !== null)
        return;

      if (!message) {
        generatedMessage = true;
        message = 'The input did not match the regular expression ' +
                  `${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
      // Handle primitives properly.
    } else if (typeof actual !== 'object' || actual === null) {
      const err = new AssertionError({
        actual,
        expected,
        message,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.operator = fn.name;
      throw err;
    } else {
      // Handle validation objects.
      const keys = ObjectKeys(expected);
      // Special handle errors to make sure the name and the message are
      // compared as well.
      if (expected instanceof Error) {
        ArrayPrototypePush(keys, 'name', 'message');
      } else if (keys.length === 0) {
        throw new ERR_INVALID_ARG_VALUE('error',
                                        expected, 'may not be an empty object');
      }
      if (isDeepEqual === undefined) lazyLoadComparison();
      for (const key of keys) {
        if (typeof actual[key] === 'string' &&
            isRegExp(expected[key]) &&
            RegExpPrototypeExec(expected[key], actual[key]) !== null) {
          continue;
        }
        compareExceptionKey(actual, expected, key, message, keys, fn);
      }
      return;
    }
  // Guard instanceof against arrow functions as they don't have a prototype.
  // Check for matching Error classes.
  } else if (expected.prototype !== undefined && actual instanceof expected) {
    return;
  } else if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    if (!message) {
      generatedMessage = true;
      message = 'The error is expected to be an instance of ' +
        `"${expected.name}". Received `;
      if (isError(actual)) {
        const name = (actual.constructor?.name) ||
                     actual.name;
        if (expected.name === name) {
          message += 'an error with identical name but a different prototype.';
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    throwError = true;
  } else {
    // Check validation functions return value.
    const res = FunctionPrototypeCall(expected, {}, actual);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : '';
        message = `The ${name}validation function is expected to return` +
          ` "true". Received ${inspect(res)}`;

        if (isError(actual)) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function getActual(fn) {
  validateFunction(fn, 'fn');
  try {
    fn();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj) {
  // Accept native ES6 promises and promises that are implemented in a similar
  // way. Do not accept thenables that use a function as `obj` and that have no
  // `catch` handler.
  return isPromise(obj) ||
    (obj !== null && typeof obj === 'object' &&
    typeof obj.then === 'function' &&
    typeof obj.catch === 'function');
}

async function waitForActual(promiseFn) {
  let resultPromise;
  if (typeof promiseFn === 'function') {
    // Return a rejected promise if `promiseFn` throws synchronously.
    resultPromise = promiseFn();
    // Fail in case no promise is returned.
    if (!checkIsPromise(resultPromise)) {
      throw new ERR_INVALID_RETURN_VALUE('instance of Promise',
                                         'promiseFn', resultPromise);
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw new ERR_INVALID_ARG_TYPE(
      'promiseFn', ['Function', 'Promise'], promiseFn);
  }

  try {
    await resultPromise;
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function expectsError(stackStartFn, actual, error, message) {
  if (typeof error === 'string') {
    if (arguments.length === 4) {
      throw new ERR_INVALID_ARG_TYPE('error',
                                     ['Object', 'Error', 'Function', 'RegExp'],
                                     error);
    }
    if (typeof actual === 'object' && actual !== null) {
      if (actual.message === error) {
        throw new ERR_AMBIGUOUS_ARGUMENT(
          'error/message',
          `The error message "${actual.message}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        'error/message',
        `The error "${actual}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (error != null &&
             typeof error !== 'object' &&
             typeof error !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('error',
                                   ['Object', 'Error', 'Function', 'RegExp'],
                                   error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = '';
    if (error?.name) {
      details += ` (${error.name})`;
    }
    details += message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.rejects ? 'rejection' : 'exception';
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: [`Missing expected ${fnType}${details}`],
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }

  if (!error)
    return;

  expectedException.call(this, actual, error, message, stackStartFn);
}

function hasMatchingError(actual, expected) {
  if (typeof expected !== 'function') {
    if (isRegExp(expected)) {
      const str = String(actual);
      return RegExpPrototypeExec(expected, str) !== null;
    }
    throw new ERR_INVALID_ARG_TYPE(
      'expected', ['Function', 'RegExp'], expected,
    );
  }
  // Guard instanceof against arrow functions as they don't have a prototype.
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    return false;
  }
  return FunctionPrototypeCall(expected, {}, actual) === true;
}

function expectsNoError(stackStartFn, actual, error, message) {
  if (actual === NO_EXCEPTION_SENTINEL)
    return;

  if (typeof error === 'string') {
    message = error;
    error = undefined;
  }

  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.doesNotReject ?
      'rejection' : 'exception';
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: [`Got unwanted ${fnType}${details}\n` +
               `Actual message: "${actual?.message}"`],
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }
  throw actual;
}

/**
 * Expects the function `promiseFn` to throw an error.
 * @param {() => any} promiseFn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.throws = function throws(promiseFn, ...args) {
  expectsError(throws, getActual(promiseFn), ...args);
};

/**
 * Expects `promiseFn` function or its value to reject.
 * @param {() => Promise<any>} promiseFn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.rejects = async function rejects(promiseFn, ...args) {
  expectsError(rejects, await waitForActual(promiseFn), ...args);
};

/**
 * Asserts that the function `fn` does not throw an error.
 * @param {() => any} fn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.doesNotThrow = function doesNotThrow(fn, ...args) {
  expectsNoError(doesNotThrow, getActual(fn), ...args);
};

/**
 * Expects `fn` or its value to not reject.
 * @param {() => Promise<any>} fn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.doesNotReject = async function doesNotReject(fn, ...args) {
  expectsNoError(doesNotReject, await waitForActual(fn), ...args);
};

/**
 * Throws `AssertionError` if the value is not `null` or `undefined`.
 * @param {any} err
 * @returns {void}
 */
Assert.prototype.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    let message = 'ifError got unwanted exception: ';
    if (typeof err === 'object' && typeof err.message === 'string') {
      if (err.message.length === 0 && err.constructor) {
        message += err.constructor.name;
      } else {
        message += err.message;
      }
    } else {
      message += inspect(err);
    }

    const newErr = new AssertionError({
      actual: err,
      expected: null,
      operator: 'ifError',
      message,
      stackStartFn: ifError,
      diff: this?.[kOptions]?.diff,
    });

    // Make sure we actually have a stack trace!
    const origStack = err.stack;

    if (typeof origStack === 'string') {
      // This will remove any duplicated frames from the error frames taken
      // from within `ifError` and add the original error frames to the newly
      // created ones.
      const origStackStart = StringPrototypeIndexOf(origStack, '\n    at');
      if (origStackStart !== -1) {
        const originalFrames = StringPrototypeSplit(
          StringPrototypeSlice(origStack, origStackStart + 1),
          '\n',
        );
        // Filter all frames existing in err.stack.
        let newFrames = StringPrototypeSplit(newErr.stack, '\n');
        for (const errFrame of originalFrames) {
          // Find the first occurrence of the frame.
          const pos = ArrayPrototypeIndexOf(newFrames, errFrame);
          if (pos !== -1) {
            // Only keep new frames.
            newFrames = ArrayPrototypeSlice(newFrames, 0, pos);
            break;
          }
        }
        const stackStart = ArrayPrototypeJoin(newFrames, '\n');
        const stackEnd = ArrayPrototypeJoin(originalFrames, '\n');
        newErr.stack = `${stackStart}\n${stackEnd}`;
      }
    }

    throw newErr;
  }
};

function internalMatch(string, regexp, message, fn) {
  if (!isRegExp(regexp)) {
    throw new ERR_INVALID_ARG_TYPE(
      'regexp', 'RegExp', regexp,
    );
  }
  const match = fn === Assert.prototype.match;
  if (typeof string !== 'string' ||
      RegExpPrototypeExec(regexp, string) !== null !== match) {

    const generatedMessage = message.length === 0;

    // 'The input was expected to not match the regular expression ' +
    message[0] ||= (typeof string !== 'string' ?
      'The "string" argument must be of type string. Received type ' +
        `${typeof string} (${inspect(string)})` :
      (match ?
        'The input did not match the regular expression ' :
        'The input was expected to not match the regular expression ') +
          `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    innerFail({
      actual: string,
      expected: regexp,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
      generatedMessage: generatedMessage,
    });
  }
}

/**
 * Expects the `string` input to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.match = function match(string, regexp, ...message) {
  internalMatch(string, regexp, message, match);
};

/**
 * Expects the `string` input not to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error | MessageFactory} [message]
 * @returns {void}
 */
Assert.prototype.doesNotMatch = function doesNotMatch(string, regexp, ...message) {
  internalMatch(string, regexp, message, doesNotMatch);
};

/**
 * Expose a strict only variant of assert.
 * @param {...any} args
 * @returns {void}
 */
function strict(...args) {
  innerOk(strict, ...args);
}

ArrayPrototypeForEach([
  'ok', 'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
  'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual',
  'notStrictEqual', 'partialDeepStrictEqual', 'match', 'doesNotMatch',
  'throws', 'rejects', 'doesNotThrow', 'doesNotReject', 'ifError',
], (name) => {
  setOwnProperty(assert, name, Assert.prototype[name]);
});

assert.strict = ObjectAssign(strict, assert, {
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
});

assert.strict.Assert = Assert;
assert.strict.strict = assert.strict;

assert.Assert = Assert;

},
"internal/util/comparisons": function(module, exports, require, primordials, internalBinding) {
'use strict';

const {
  Array,
  ArrayBuffer,
  ArrayIsArray,
  ArrayPrototypePush,
  BigInt,
  BigInt64Array,
  BigIntPrototypeValueOf,
  BigUint64Array,
  Boolean,
  BooleanPrototypeValueOf,
  DataView,
  Date,
  DatePrototypeGetTime,
  Error,
  Float16Array,
  Float32Array,
  Float64Array,
  Function,
  Int16Array,
  Int32Array,
  Int8Array,
  Map,
  Number,
  NumberPrototypeValueOf,
  Object,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetOwnPropertySymbols: getOwnSymbols,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty: hasOwn,
  ObjectPrototypePropertyIsEnumerable: hasEnumerable,
  ObjectPrototypeToString,
  Promise,
  RegExp,
  SafeSet,
  Set,
  String,
  StringPrototypeValueOf,
  Symbol,
  SymbolPrototypeValueOf,
  SymbolToStringTag,
  TypedArrayPrototypeGetByteLength: getByteLength,
  TypedArrayPrototypeGetSymbolToStringTag,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
  WeakMap,
  WeakSet,
} = primordials;

const { compare } = internalBinding('buffer');
const assert = require('internal/assert');
const { isURL } = require('internal/url');
const { isError } = require('internal/util');
const { Buffer } = require('buffer');

const wellKnownConstructors = new SafeSet()
  .add(Array)
  .add(ArrayBuffer)
  .add(BigInt)
  .add(BigInt64Array)
  .add(BigUint64Array)
  .add(Boolean)
  .add(Buffer)
  .add(DataView)
  .add(Date)
  .add(Error)
  .add(Float16Array)
  .add(Float32Array)
  .add(Float64Array)
  .add(Function)
  .add(Int16Array)
  .add(Int32Array)
  .add(Int8Array)
  .add(Map)
  .add(Number)
  .add(Object)
  .add(Promise)
  .add(RegExp)
  .add(Set)
  .add(String)
  .add(Symbol)
  .add(Uint16Array)
  .add(Uint32Array)
  .add(Uint8Array)
  .add(Uint8ClampedArray)
  .add(WeakMap)
  .add(WeakSet);

const types = require('internal/util/types');
const {
  isAnyArrayBuffer,
  isArrayBufferView,
  isBigIntObject,
  isBooleanObject,
  isBoxedPrimitive,
  isCryptoKey,
  isDate,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isKeyObject,
  isMap,
  isNativeError,
  isNumberObject,
  isPromise,
  isRegExp,
  isSet,
  isStringObject,
  isSymbolObject,
  isWeakMap,
  isWeakSet,
} = types;
const {
  constants: {
    ONLY_ENUMERABLE,
    SKIP_SYMBOLS,
  },
  getOwnNonIndexProperties,
} = internalBinding('util');

let getCryptoKeyHandle;
let getCryptoKeyType;
let getCryptoKeyExtractable;
let getCryptoKeyAlgorithm;
let getCryptoKeyUsagesMask;
let getCryptoKeySecondaryHandle;
let getCryptoKeySeedData;
let getKeyObjectHandle;
let getKeyObjectType;

const kStrict = 2;
const kStrictWithoutPrototypes = 3;
const kLoose = 0;
const kPartial = 1;

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

// Check if they have the same source and flags
function areSimilarRegExps(a, b) {
  return a.source === b.source &&
         a.flags === b.flags &&
         a.lastIndex === b.lastIndex;
}

function isPartialUint8Array(a, b) {
  const lenA = getByteLength(a);
  const lenB = getByteLength(b);
  if (lenA < lenB) {
    return false;
  }
  let offsetA = 0;
  for (let offsetB = 0; offsetB < lenB; offsetB++) {
    while (a[offsetA] !== b[offsetB]) {
      offsetA++;
      if (offsetA > lenA - lenB + offsetB) {
        return false;
      }
    }
    offsetA++;
  }
  return true;
}

function isPartialArrayBufferView(a, b) {
  if (a.byteLength < b.byteLength) {
    return false;
  }
  return isPartialUint8Array(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
  );
}

function areSimilarFloatArrays(a, b) {
  const len = getByteLength(a);
  if (len !== getByteLength(b)) {
    return false;
  }
  for (let offset = 0; offset < len; offset++) {
    if (a[offset] !== b[offset]) {
      return false;
    }
  }
  return true;
}

function areSimilarTypedArrays(a, b) {
  return a.byteLength === b.byteLength && compare(a, b) === 0;
}

function areEqualArrayBuffers(buf1, buf2) {
  return buf1.byteLength === buf2.byteLength &&
    compare(new Uint8Array(buf1), new Uint8Array(buf2)) === 0;
}

function isEqualBoxedPrimitive(val1, val2) {
  if (isNumberObject(val1)) {
    return isNumberObject(val2) &&
           ObjectIs(NumberPrototypeValueOf(val1),
                    NumberPrototypeValueOf(val2));
  }
  if (isStringObject(val1)) {
    return isStringObject(val2) &&
           StringPrototypeValueOf(val1) === StringPrototypeValueOf(val2);
  }
  if (isBooleanObject(val1)) {
    return isBooleanObject(val2) &&
           BooleanPrototypeValueOf(val1) === BooleanPrototypeValueOf(val2);
  }
  if (isBigIntObject(val1)) {
    return isBigIntObject(val2) &&
           BigIntPrototypeValueOf(val1) === BigIntPrototypeValueOf(val2);
  }
  if (isSymbolObject(val1)) {
    return isSymbolObject(val2) &&
          SymbolPrototypeValueOf(val1) === SymbolPrototypeValueOf(val2);
  }
  /* c8 ignore next */
  assert.fail(`Unknown boxed type ${val1}`);
}

function isEnumerableOrIdentical(val1, val2, prop, mode, memos) {
  return hasEnumerable(val2, prop) || // This is handled by Object.keys()
      (mode === kPartial && (val2[prop] === undefined || (prop === 'message' && val2[prop] === ''))) ||
      innerDeepEqual(val1[prop], val2[prop], mode, memos);
}

function innerDeepEqual(val1, val2, mode, memos) {
  // All identical values are equivalent, as determined by ===.
  if (val1 === val2) {
    return val1 !== 0 || ObjectIs(val1, val2) || mode === kLoose;
  }

  // Check more closely if val1 and val2 are equal.
  if (mode !== kLoose) {
    if (typeof val1 === 'number') {
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      return val1 !== val1 && val2 !== val2;
    }
    if (typeof val2 !== 'object' ||
        typeof val1 !== 'object' ||
        val1 === null ||
        val2 === null) {
      return false;
    }
  } else {
    if (val1 === null || typeof val1 !== 'object') {
      return (val2 === null || typeof val2 !== 'object') &&
             // Check for NaN
             // eslint-disable-next-line eqeqeq, no-self-compare
             (val1 == val2 || (val1 !== val1 && val2 !== val2));
    }
    if (val2 === null || typeof val2 !== 'object') {
      return false;
    }
  }
  return objectComparisonStart(val1, val2, mode, memos);
}

function hasUnequalTag(val1, val2) {
  return val1[SymbolToStringTag] !== val2[SymbolToStringTag];
}

function slowHasUnequalTag(val1Tag, val1, val2) {
  if (val1[SymbolToStringTag] !== undefined && val2[SymbolToStringTag] !== undefined) {
    return val1[SymbolToStringTag] !== val2[SymbolToStringTag];
  }
  return val1Tag !== ObjectPrototypeToString(val2);
}

function objectComparisonStart(val1, val2, mode, memos) {
  if (mode === kStrict) {
    if (wellKnownConstructors.has(val1.constructor) ||
        (val1.constructor !== undefined && !hasOwn(val1, 'constructor'))) {
      if (val1.constructor !== val2.constructor) {
        return false;
      }
    } else if (ObjectGetPrototypeOf(val1) !== ObjectGetPrototypeOf(val2)) {
      return false;
    }
  }

  if (ArrayIsArray(val1)) {
    if (!ArrayIsArray(val2) ||
        (val1.length !== val2.length && (mode !== kPartial || val1.length < val2.length)) ||
        hasUnequalTag(val1, val2)) {
      return false;
    }

    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsArray, keys2);
  }

  let val1Tag;
  if (val1[SymbolToStringTag] === undefined &&
      (val1Tag = ObjectPrototypeToString(val1)) === '[object Object]') {
    if (slowHasUnequalTag(val1Tag, val1, val2)) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator);
  } else if (isSet(val1)) {
    if (!isSet(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size)) ||
        hasUnequalTag(val1, val2)) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsSet);
  } else if (isMap(val1)) {
    if (!isMap(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size)) ||
        hasUnequalTag(val1, val2)) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsMap);
  } else if (isArrayBufferView(val1)) {
    if (TypedArrayPrototypeGetSymbolToStringTag(val1) !==
        TypedArrayPrototypeGetSymbolToStringTag(val2)) {
      return false;
    }
    if (mode === kPartial && val1.byteLength !== val2.byteLength) {
      if (!isPartialArrayBufferView(val1, val2)) {
        return false;
      }
    } else if (mode === kLoose &&
               (isFloat32Array(val1) || isFloat64Array(val1) || isFloat16Array(val1))) {
      if (!areSimilarFloatArrays(val1, val2)) {
        return false;
      }
    } else if (!areSimilarTypedArrays(val1, val2)) {
      return false;
    }
    // Buffer.compare returns true, so val1.length === val2.length. If they both
    // only contain numeric keys, we don't need to exam further than checking
    // the symbols.
    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator, keys2);
  } else if (isDate(val1)) {
    if (!isDate(val2) || hasUnequalTag(val1, val2)) {
      return false;
    }
    const time1 = DatePrototypeGetTime(val1);
    const time2 = DatePrototypeGetTime(val2);
    // eslint-disable-next-line no-self-compare
    if (time1 !== time2 && (time1 === time1 || time2 === time2)) {
      return false;
    }
  } else if (isRegExp(val1)) {
    if (!isRegExp(val2) || !areSimilarRegExps(val1, val2) || hasUnequalTag(val1, val2)) {
      return false;
    }
  } else if (isAnyArrayBuffer(val1)) {
    if (!isAnyArrayBuffer(val2) || hasUnequalTag(val1, val2)) {
      return false;
    }
    if (mode !== kPartial || val1.byteLength === val2.byteLength) {
      if (!areEqualArrayBuffers(val1, val2)) {
        return false;
      }
    } else if (!isPartialUint8Array(new Uint8Array(val1), new Uint8Array(val2))) {
      return false;
    }
  } else if (slowHasUnequalTag(val1Tag ?? ObjectPrototypeToString(val1), val1, val2) ||
            ArrayIsArray(val2) ||
            isArrayBufferView(val2) ||
            isSet(val2) ||
            isMap(val2) ||
            isDate(val2) ||
            isRegExp(val2) ||
            isAnyArrayBuffer(val2)) {
    return false;
  } else if (isError(val1)) {
    // Do not compare the stack as it might differ even though the error itself
    // is otherwise identical.
    if (!isError(val2) ||
        !isEnumerableOrIdentical(val1, val2, 'message', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'name', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'cause', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'errors', mode, memos)) {
      return false;
    }
    const hasOwnVal2Cause = hasOwn(val2, 'cause');
    if ((hasOwnVal2Cause !== hasOwn(val1, 'cause') && (mode !== kPartial || hasOwnVal2Cause))) {
      return false;
    }
  } else if (isBoxedPrimitive(val1)) {
    if (!isEqualBoxedPrimitive(val1, val2)) {
      return false;
    }
  } else if (isURL(val1)) {
    if (!isURL(val2) || val1.href !== val2.href) {
      return false;
    }
  } else if (isKeyObject(val1)) {
    if (getKeyObjectHandle === undefined) {
      ({
        getKeyObjectHandle,
        getKeyObjectType,
      } = require('internal/crypto/keys'));
    }
    if (!isKeyObject(val2) ||
      getKeyObjectType(val1) !== getKeyObjectType(val2) ||
      !getKeyObjectHandle(val1).equals(getKeyObjectHandle(val2))
    ) {
      return false;
    }
  } else if (isCryptoKey(val1)) {
    if (getCryptoKeyHandle === undefined) {
      ({
        getCryptoKeyHandle,
        getCryptoKeyType,
        getCryptoKeyExtractable,
        getCryptoKeyAlgorithm,
        getCryptoKeyUsagesMask,
        getCryptoKeySecondaryHandle,
        getCryptoKeySeedData,
      } = require('internal/crypto/keys'));
    }
    const val1SecondaryHandle = getCryptoKeySecondaryHandle(val1);
    const val2SecondaryHandle = isCryptoKey(val2) ?
      getCryptoKeySecondaryHandle(val2) : undefined;
    const val1SeedData = getCryptoKeySeedData(val1);
    const val2SeedData = isCryptoKey(val2) ?
      getCryptoKeySeedData(val2) : undefined;
    if (!isCryptoKey(val2) ||
      getCryptoKeyType(val1) !== getCryptoKeyType(val2) ||
      getCryptoKeyExtractable(val1) !== getCryptoKeyExtractable(val2) ||
      !innerDeepEqual(getCryptoKeyAlgorithm(val1), getCryptoKeyAlgorithm(val2), mode, memos) ||
      getCryptoKeyUsagesMask(val1) !== getCryptoKeyUsagesMask(val2) ||
      !getCryptoKeyHandle(val1).equals(getCryptoKeyHandle(val2)) ||
      (val1SecondaryHandle === undefined) !== (val2SecondaryHandle === undefined) ||
      (val1SecondaryHandle !== undefined &&
        !val1SecondaryHandle.equals(val2SecondaryHandle)) ||
      (val1SeedData === undefined) !== (val2SeedData === undefined) ||
      (val1SeedData !== undefined &&
        !innerDeepEqual(val1SeedData, val2SeedData, mode, memos))
    ) {
      return false;
    }
  } else if (isBoxedPrimitive(val2) ||
      isNativeError(val2) ||
      val2 instanceof Error ||
      isWeakMap(val1) ||
      isWeakSet(val1) ||
      isPromise(val1)) {
    return false;
  }

  return keyCheck(val1, val2, mode, memos, kNoIterator);
}

function partialSymbolEquiv(val1, val2, keys2) {
  const symbolKeys = getOwnSymbols(val2);
  if (symbolKeys.length !== 0) {
    for (const key of symbolKeys) {
      if (hasEnumerable(val2, key)) {
        ArrayPrototypePush(keys2, key);
      }
    }
  }
  return true;
}

function keyCheck(val1, val2, mode, memos, iterationType, keys2) {
  // For all remaining Object pairs, including Array, objects and Maps,
  // equivalence is determined by having:
  // a) The same number of owned enumerable properties
  // b) The same set of keys/indexes (although not necessarily the same order)
  // c) Equivalent values for every corresponding key/index
  // d) For Sets and Maps, equal contents
  // Note: this accounts for both named and indexed properties on Arrays.
  const isArrayLikeObject = keys2 !== undefined;

  if (keys2 === undefined) {
    keys2 = ObjectKeys(val2);
  }
  let keys1;

  if (!isArrayLikeObject) {
    // The pair must have the same number of owned properties.
    if (mode === kPartial) {
      if (!partialSymbolEquiv(val1, val2, keys2)) {
        return false;
      }
    } else if (keys2.length !== (keys1 = ObjectKeys(val1)).length) {
      return false;
    } else if (mode === kStrict || mode === kStrictWithoutPrototypes) {
      for (const key of getOwnSymbols(val1)) {
        if (hasEnumerable(val1, key)) {
          ArrayPrototypePush(keys1, key);
        }
      }
      for (const key of getOwnSymbols(val2)) {
        if (hasEnumerable(val2, key)) {
          ArrayPrototypePush(keys2, key);
        }
      }
      if (keys1.length !== keys2.length) {
        return false;
      }
    }
  }

  if (keys2.length === 0 &&
      (iterationType === kNoIterator ||
        (iterationType === kIsArray && val2.length === 0) ||
        val2.size === 0)) {
    return true;
  }

  if (memos === null) {
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }
  return handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType);
}

function handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType) {
  // Use memos to handle cycles.
  if (memos === undefined) {
    memos = {
      set: undefined,
      a: val1,
      b: val2,
      c: undefined,
      d: undefined,
      deep: false,
    };
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }

  if (memos.set === undefined) {
    if (memos.deep === false) {
      if (memos.a === val1) {
        return memos.b === val2;
      }
      if (memos.b === val2) {
        return false;
      }
      memos.c = val1;
      memos.d = val2;
      memos.deep = true;
      const result = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
      memos.deep = false;
      if (memos.set !== undefined) {
        memos.set.delete(memos.c);
        memos.set.delete(memos.d);
      }
      return result;
    }
    memos.set = new SafeSet();
    memos.set.add(memos.a);
    memos.set.add(memos.b);
    memos.set.add(memos.c);
    memos.set.add(memos.d);
  }

  const { set } = memos;

  const originalSize = set.size;
  set.add(val1);
  set.add(val2);
  if (originalSize !== set.size - 2) {
    return originalSize === set.size;
  }

  const areEq = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);

  set.delete(val1);
  set.delete(val2);

  return areEq;
}

// See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness#Loose_equality_using
// Sadly it is not possible to detect corresponding values properly in case the
// type is a string, number, bigint or boolean. The reason is that those values
// can match lots of different string values (e.g., 1n == '+00001').
function findLooseMatchingPrimitives(prim) {
  switch (typeof prim) {
    case 'undefined':
      return null;
    case 'object': // Only pass in null as object!
      return undefined;
    case 'symbol':
      return false;
    case 'string':
      prim = +prim;
      // Loose equal entries exist only if the string is possible to convert to
      // a regular number and not NaN.
      // Fall through
    case 'number':
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      if (prim !== prim) {
        return false;
      }
  }
  return true;
}

function setMightHaveLoosePrim(a, b, prim) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null)
    return altValue;

  return !b.has(altValue) && a.has(altValue);
}

function mapMightHaveLoosePrim(a, b, prim, item2, memo) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null) {
    return altValue;
  }
  const item1 = a.get(altValue);
  if ((item1 === undefined && !a.has(altValue)) ||
      !innerDeepEqual(item1, item2, kLoose, memo)) {
    return false;
  }
  return !b.has(altValue) && innerDeepEqual(item1, item2, kLoose, memo);
}

function partialObjectSetEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const val1 of a) {
    aPos++;
    if (!b.has(val1)) {
      let innerStart = start;
      if (direction === 1) {
        if (innerDeepEqual(val1, array[start], mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of set b might match a later element in set a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      if (!innerDeepEqual(val1, array[end], mode, memo)) {
        direction = 1;
        matched = arrayHasEqualElement(array, val1, mode, memo, innerDeepEqual, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualElement(array, val1, mode, memo, comparator, start, end) {
  for (let i = end - 1; i >= start; i--) {
    if (comparator(val1, array[i], mode, memo)) {
      // Move the matching element to make sure we do not check that again.
      array[i] = array[end];
      return true;
    }
  }
  return false;
}

function setObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;
  const extraChecks = mode === kLoose || array.length !== a.size;
  for (const val1 of a) {
    // Primitive and null members can only match by identity, and must never
    // reach objectComparisonStart (which throws on `val.constructor` for
    // null/undefined). Resolve them directly for every such member.
    if (typeof val1 !== 'object' || val1 === null) {
      if (b.has(val1)) {
        continue;
      }
      if (mode !== kLoose) {
        return false;
      }
    } else if (extraChecks && b.has(val1)) {
      continue;
    }

    let innerStart = start;
    if (direction === 1) {
      if (comparator(val1, array[start], mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    if (!comparator(val1, array[end], mode, memo)) {
      direction = 1;
      if (!arrayHasEqualElement(array, val1, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function compareSmallSets(a, b, val, iteratorB, mode, memo) {
  const iteratorA = a.values();
  const firstA = iteratorA.next().value;
  const first = innerDeepEqual(firstA, val, mode, memo);
  if (first) {
    if (b.size === 1) { // Partial mode && a.size === 1 || b.size === 1
      return true;
    }
    const secondA = iteratorA.next().value;
    return b.has(secondA) || innerDeepEqual(secondA, iteratorB.next().value, mode, memo);
  }
  return a.size !== 1 && innerDeepEqual(iteratorA.next().value, val, mode, memo) && (
    b.size === 1 || // Partial mode
    b.has(firstA) || // Primitive or reference equal
    innerDeepEqual(firstA, iteratorB.next().value, mode, memo)
  );
}

function setEquiv(a, b, mode, memo) {
  // This is a lazily initiated Set of entries which have to be compared
  // pairwise.
  let array;

  const iteratorB = b.values();
  for (const val of iteratorB) {
    if (!a.has(val)) {
      if ((typeof val !== 'object' || val === null) &&
          (mode !== kLoose || !setMightHaveLoosePrim(a, b, val))) {
        return false;
      }

      if (array === undefined) {
        if (a.size < 3) {
          return compareSmallSets(a, b, val, iteratorB, mode, memo);
        }
        array = [];
      }
      // If the specified value doesn't exist in the second set it's a object
      // (or in loose mode: a non-matching primitive). Find the
      // deep-(mode-)equal element in a set copy to reduce duplicate checks.
      ArrayPrototypePush(array, val);
    }
  }

  if (array === undefined) {
    return true;
  }
  if (mode === kPartial) {
    return partialObjectSetEquiv(array, a, b, mode, memo);
  }
  return setObjectEquiv(array, a, b, mode, memo);
}

function partialObjectMapEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const { 0: key1, 1: item1 } of a) {
    aPos++;
    if (typeof key1 === 'object' && key1 !== null) {
      let innerStart = start;
      if (direction === 1) {
        const key2 = array[start];
        if (objectComparisonStart(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of map b might match a later element in map a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      const key2 = array[end];
      if (!objectComparisonStart(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo)) {
        direction = 1;
        matched = arrayHasEqualMapElement(array, key1, item1, b, mode, memo, objectComparisonStart, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, start, end) {
  for (let i = end - 1; i >= start; i--) {
    const key2 = array[i];
    if (comparator(key1, key2, mode, memo) &&
        innerDeepEqual(item1, b.get(key2), mode, memo)) {
      // Move the matching element to make sure we do not check that again.
      array[i] = array[end];
      return true;
    }
  }
  return false;
}

function mapObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;

  for (const { 0: key1, 1: item1 } of a) {
    // Primitive and `null` keys can never match an object key collected in
    // `array`, so resolve them directly against `b`. `null` is `typeof
    // 'object'`, so without this it would reach the object comparator, which
    // reads `key1.constructor` and throws a `TypeError`.
    if (typeof key1 !== 'object' || key1 === null) {
      if (b.has(key1)) {
        if (mode !== kLoose || innerDeepEqual(item1, b.get(key1), mode, memo)) {
          continue;
        }
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      const key2 = array[start];
      if (comparator(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    const key2 = array[end];
    if ((!comparator(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo))) {
      direction = 1;
      if (!arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function mapEquiv(a, b, mode, memo) {
  let array;

  for (const { 0: key2, 1: item2 } of b) {
    if (typeof key2 === 'object' && key2 !== null) {
      if (array === undefined) {
        if (a.size === 1) {
          const { 0: key1, 1: item1 } = a.entries().next().value;
          return innerDeepEqual(key1, key2, mode, memo) &&
                  innerDeepEqual(item1, item2, mode, memo);
        }
        array = [];
      }
      ArrayPrototypePush(array, key2);
    } else {
      // By directly retrieving the value we prevent another b.has(key2) check in
      // almost all possible cases.
      const item1 = a.get(key2);
      if (((item1 === undefined && !a.has(key2)) ||
          !innerDeepEqual(item1, item2, mode, memo))) {
        if (mode !== kLoose)
          return false;
        // Fast path to detect missing string, symbol, undefined and null
        // keys.
        if (!mapMightHaveLoosePrim(a, b, key2, item2, memo))
          return false;
        if (array === undefined) {
          array = [];
        }
        ArrayPrototypePush(array, key2);
      }
    }
  }

  if (array === undefined) {
    return true;
  }

  if (mode === kPartial) {
    return partialObjectMapEquiv(array, a, b, mode, memo);
  }

  return mapObjectEquiv(array, a, b, mode, memo);
}

function partialSparseArrayEquiv(a, b, mode, memos, startA, startB) {
  let aPos = startA;
  const keysA = ObjectKeys(a);
  const keysB = ObjectKeys(b);
  const lenA = keysA.length - startA;
  const lenB = keysB.length - startB;
  if (lenA < lenB) {
    return false;
  }
  for (let i = 0; i < lenB; i++) {
    const keyB = keysB[startB + i];
    while (!innerDeepEqual(a[keysA[aPos]], b[keyB], mode, memos)) {
      aPos++;
      if (aPos > keysA.length - lenB + i) {
        return false;
      }
    }
    aPos++;
  }
  return true;
}

function partialArrayEquiv(a, b, mode, memos) {
  let aPos = 0;
  for (let i = 0; i < b.length; i++) {
    let isSparse = b[i] === undefined && !hasOwn(b, i);
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    while (!(isSparse = a[aPos] === undefined && !hasOwn(a, aPos)) &&
           !innerDeepEqual(a[aPos], b[i], mode, memos)) {
      aPos++;
      if (aPos > a.length - b.length + i) {
        return false;
      }
    }
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    aPos++;
  }
  return true;
}

function sparseArrayEquiv(a, b, mode, memos, i) {
  const keysA = ObjectKeys(a);
  const keysB = ObjectKeys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (; i < keysB.length; i++) {
    const key = keysB[i];
    if ((a[key] === undefined && !hasOwn(a, key)) || !innerDeepEqual(a[key], b[key], mode, memos)) {
      return false;
    }
  }
  return true;
}

function objEquiv(a, b, mode, keys1, keys2, memos, iterationType) {
  // The pair must have equivalent values for every corresponding key.
  if (keys2.length > 0) {
    let i = 0;
    // Ordered keys
    if (keys1 !== undefined) {
      for (; i < keys2.length; i++) {
        const key = keys2[i];
        if (keys1[i] !== key) {
          break;
        }
        if (!innerDeepEqual(a[key], b[key], mode, memos)) {
          return false;
        }
      }
    }
    // Unordered keys
    for (; i < keys2.length; i++) {
      const key = keys2[i];
      // It is faster to get the whole descriptor and to check it's enumerable
      // property in V8 13.0 compared to calling Object.propertyIsEnumerable()
      // and accessing the property regularly.
      const descriptor = ObjectGetOwnPropertyDescriptor(a, key);
      if (descriptor === undefined || descriptor.enumerable !== true) {
        return false;
      }
      const value = descriptor.writable !== undefined ? descriptor.value : a[key];
      if (!innerDeepEqual(value, b[key], mode, memos)) {
        return false;
      }
    }
  }

  if (iterationType === kIsArray) {
    if (mode === kPartial) {
      return partialArrayEquiv(a, b, mode, memos);
    }
    for (let i = 0; i < a.length; i++) {
      if (b[i] === undefined) {
        if (!hasOwn(b, i))
          return sparseArrayEquiv(a, b, mode, memos, i);
        if ((a[i] !== undefined || !hasOwn(a, i)) && (mode !== kLoose || a[i] !== null))
          return false;
      } else if ((a[i] === undefined || !innerDeepEqual(a[i], b[i], mode, memos)) &&
                 (mode !== kLoose || b[i] !== null)) {
        return false;
      }
    }
  } else if (iterationType === kIsSet) {
    if (!setEquiv(a, b, mode, memos)) {
      return false;
    }
  } else if (iterationType === kIsMap) {
    if (!mapEquiv(a, b, mode, memos)) {
      return false;
    }
  }

  return true;
}

// Only handle cycles when they are detected.
// eslint-disable-next-line func-style
let detectCycles = function(val1, val2, mode) {
  try {
    return innerDeepEqual(val1, val2, mode, null);
  } catch {
    detectCycles = innerDeepEqual;
    return innerDeepEqual(val1, val2, mode, undefined);
  }
};

module.exports = {
  isDeepEqual(val1, val2) {
    return detectCycles(val1, val2, kLoose);
  },
  isDeepStrictEqual(val1, val2, skipPrototype) {
    return detectCycles(val1, val2, skipPrototype ? kStrictWithoutPrototypes : kStrict);
  },
  isPartialStrictEqual(val1, val2) {
    return detectCycles(val1, val2, kPartial);
  },
};

},
"internal/assert/utils": function(module, exports, require, primordials, internalBinding) {
'use strict';

const {
  Error,
  ErrorCaptureStackTrace,
  ErrorPrototypeToString,
  StringPrototypeCharCodeAt,
  StringPrototypeReplace,
} = primordials;

const {
  codes: {
    ERR_AMBIGUOUS_ARGUMENT,
    ERR_INVALID_ARG_TYPE,
  },
  isErrorStackTraceLimitWritable,
} = require('internal/errors');
const AssertionError = require('internal/assert/assertion_error');
const { isError } = require('internal/util');
const { format } = require('internal/util/inspect');

const {
  getErrorSourceExpression,
} = require('internal/errors/error_source');

// Escape control characters but not \n and \t to keep the line breaks and
// indentation intact.
// eslint-disable-next-line no-control-regex
const escapeSequencesRegExp = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const meta = [
  '\\u0000', '\\u0001', '\\u0002', '\\u0003', '\\u0004',
  '\\u0005', '\\u0006', '\\u0007', '\\b', '',
  '', '\\u000b', '\\f', '', '\\u000e',
  '\\u000f', '\\u0010', '\\u0011', '\\u0012', '\\u0013',
  '\\u0014', '\\u0015', '\\u0016', '\\u0017', '\\u0018',
  '\\u0019', '\\u001a', '\\u001b', '\\u001c', '\\u001d',
  '\\u001e', '\\u001f',
];

const escapeFn = (str) => meta[StringPrototypeCharCodeAt(str, 0)];

/**
 * A function that derives the failure message from the actual and expected values.
 * It is invoked only when the assertion fails.
 *
 * Other return values than a string are ignored.
 * @callback MessageFactory
 * @param {any} actual
 * @param {any} expected
 * @returns {string}
 */

/**
 * Raw message input is always passed internally as a tuple array.
 * Accepted shapes:
 *  - []
 *  - [string]
 *  - [string, ...any[]] (printf-like substitutions)
 *  - [Error]
 *  - [MessageFactory]
 *
 * Additional elements after [Error] or [MessageFactory] are rejected with ERR_AMBIGUOUS_ARGUMENT.
 * A first element that is neither string, Error nor function is rejected with ERR_INVALID_ARG_TYPE.
 * @typedef {[] | [string] | [string, ...any[]] | [Error] | [MessageFactory]} MessageTuple
 */

/**
 * Options consumed by innerFail to construct and throw the AssertionError.
 * @typedef {object} InnerFailOptions
 * @property {any} actual Actual value
 * @property {any} expected Expected value
 * @property {MessageTuple} message Message
 * @property {string} operator Operator
 * @property {Function} stackStartFn Stack start function
 * @property {'simple' | 'full'} [diff] Diff mode
 * @property {boolean} [generatedMessage] Generated message
 */

function getErrMessage(fn) {
  const tmpLimit = Error.stackTraceLimit;
  const errorStackTraceLimitIsWritable = isErrorStackTraceLimitWritable();
  // Make sure the limit is set to 1. Otherwise it could fail (<= 0) or it
  // does to much work.
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = 1;
  // We only need the stack trace. To minimize the overhead use an object
  // instead of an error.
  const err = {};
  ErrorCaptureStackTrace(err, fn);
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = tmpLimit;

  let source = getErrorSourceExpression(err);
  if (source) {
    source = StringPrototypeReplace(source, escapeSequencesRegExp, escapeFn);
    return `The expression evaluated to a falsy value:\n\n  ${source}\n`;
  }
}

/**
 * @param {InnerFailOptions} obj
 */
function innerFail(obj) {
  if (obj.message.length === 0) {
    obj.message = undefined;
  } else if (typeof obj.message[0] === 'string') {
    if (obj.message.length > 1) {
      obj.message = format(...obj.message);
    } else {
      obj.message = obj.message[0];
    }
  } else if (isError(obj.message[0])) {
    if (obj.message.length > 1) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        'message',
        `The error message was passed as error object "${ErrorPrototypeToString(obj.message[0])}" has trailing arguments that would be ignored.`,
      );
    }
    throw obj.message[0];
  } else if (typeof obj.message[0] === 'function') {
    if (obj.message.length > 1) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        'message',
        `The error message with function "${obj.message[0].name || 'anonymous'}" has trailing arguments that would be ignored.`,
      );
    }
    try {
      obj.message = obj.message[0](obj.actual, obj.expected);
      if (typeof obj.message !== 'string') {
        obj.message = undefined;
      }
    } catch {
      // Ignore and use default message instead
      obj.message = undefined;
    }
  } else {
    throw new ERR_INVALID_ARG_TYPE(
      'message',
      ['string', 'function'],
      obj.message[0],
    );
  }

  const error = new AssertionError(obj);
  if (obj.generatedMessage !== undefined) {
    error.generatedMessage = obj.generatedMessage;
  }
  throw error;
}

/**
 * Internal ok handler delegating to innerFail for message handling.
 * @param {Function} fn
 * @param {...any} args
 */
function innerOk(fn, ...args) {
  if (!args[0]) {
    let generatedMessage = false;
    let messageArgs;

    if (args.length === 0) {
      generatedMessage = true;
      messageArgs = ['No value argument passed to `assert.ok()`'];
    } else if (args.length === 1 || args[1] == null) {
      generatedMessage = true;
      const expression = getErrMessage(fn);
      messageArgs = expression === undefined ? [] : [expression];
    } else {
      messageArgs = args.slice(1);
    }

    innerFail({
      actual: args[0],
      expected: true,
      message: messageArgs,
      operator: '==',
      stackStartFn: fn,
      generatedMessage,
    });
  }
}

module.exports = {
  innerOk,
  innerFail,
};

}
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
