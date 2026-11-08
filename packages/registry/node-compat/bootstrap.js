// Shared Node.js API compatibility layer for Kandelo JavaScript runtimes.
// Provides require(), process, Buffer, and core Node.js modules
// Built on top of qjs-shaped os/std/native adapter modules.
//
// This is NOT Node.js. It is a compatibility layer that implements
// the most commonly used Node.js APIs using POSIX syscalls.

import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as _nodeNative from 'qjs:node';

const _nodeMonotonicStart = os.timerNow();
const _nodeParsedEvalSource = _nodeNative.workerEnvironment ? undefined : _nodeNative.cliOptions?.evalSource;
const _nodeHasEvalSource = !_nodeNative.workerEnvironment && _nodeNative.cliOptions?.hasEvalSource === true;
const _nodeDispose = Symbol.dispose;
let _nodeEventPlatform;
let _nodeValues;
let _nodeWarnings;

// ============================================================
// TextEncoder/TextDecoder polyfill for engines that do not provide it.
// ============================================================

if (typeof globalThis.TextEncoder === 'undefined') {
    const ByteArray = Uint8Array;
    const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
    const typedArray = Object.getPrototypeOf(ByteArray.prototype);
    const typedArrayName = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag).get;
    const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;
    function pointAt(source, index) {
        const first = charCodeAt(source, index);
        if (first < 0xd800 || first > 0xdfff) return first;
        const second = charCodeAt(source, index + 1);
        if (first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
            return 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00;
        }
        return 0xfffd;
    }
    function width(point) { return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4; }
    function write(source, target) {
        const capacity = byteLength.call(target);
        let read = 0, written = 0;
        while (read < source.length) {
            const point = pointAt(source, read), size = width(point);
            if (written + size > capacity) break;
            if (size === 1) target[written++] = point;
            else {
                if (size === 2) target[written++] = 0xc0 | (point >> 6);
                else if (size === 3) {
                    target[written++] = 0xe0 | (point >> 12);
                    target[written++] = 0x80 | ((point >> 6) & 0x3f);
                } else {
                    target[written++] = 0xf0 | (point >> 18);
                    target[written++] = 0x80 | ((point >> 12) & 0x3f);
                    target[written++] = 0x80 | ((point >> 6) & 0x3f);
                }
                target[written++] = 0x80 | (point & 0x3f);
            }
            read += point > 0xffff ? 2 : 1;
        }
        return { read, written };
    }
    globalThis.TextEncoder = class TextEncoder {
        #encoding = 'utf-8';
        get encoding() { return this.#encoding; }
        #encode(input) {
            const source = `${input}`;
            let length = 0;
            for (let i = 0; i < source.length;) {
                const point = pointAt(source, i);
                length += width(point);
                i += point > 0xffff ? 2 : 1;
            }
            const bytes = new ByteArray(length);
            write(source, bytes);
            return bytes;
        }
        encode(input = '') { return this.#encode(input); }
        #encodeInto(source, destination) { return write(source, _nodeBufferSourceBytes(destination)); }
        encodeInto(source, destination) {
            if (typeof source !== 'string' || typedArrayName.call(destination) !== 'Uint8Array') {
                const error = new TypeError('encodeInto requires a string source and Uint8Array destination');
                error.code = 'ERR_INVALID_ARG_TYPE';
                throw error;
            }
            return this.#encodeInto(source, destination);
        }
    };
    for (const name of ['encoding', 'encode', 'encodeInto']) {
        Object.defineProperty(globalThis.TextEncoder.prototype, name, { enumerable: true });
    }
    Object.defineProperty(globalThis.TextEncoder.prototype, Symbol.toStringTag, { value: 'TextEncoder', configurable: true });
}

function _nodeBufferSourceBytes(input, allowRaw = false) {
    const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
    if (ArrayBuffer.isView(input)) {
        let buffer, offset, length;
        try {
            buffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get.call(input);
            offset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get.call(input);
            length = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get.call(input);
        } catch (_) {
            buffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get.call(input);
            try {
                offset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get.call(input);
                length = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get.call(input);
            } catch (_) { return new Uint8Array(0); } // Detached/out-of-bounds views are empty to Node's decoder.
        }
        return length === 0 ? new Uint8Array(0) : new Uint8Array(buffer, offset, length);
    }
    if (allowRaw) for (const constructor of [ArrayBuffer, typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null]) {
        if (!constructor) continue;
        let length;
        try { length = Object.getOwnPropertyDescriptor(constructor.prototype, 'byteLength').get.call(input); }
        catch (_) { continue; }
        return length === 0 ? new Uint8Array(0) : new Uint8Array(input);
    }
    const received = input == null ? String(input) : typeof input === 'object'
        ? 'an instance of ' + (Array.isArray(input) ? 'Array' : 'Object')
        : 'type ' + typeof input + ' (' + String(input) + ')';
    const accepted = allowRaw ? 'ArrayBuffer, SharedArrayBuffer, or ArrayBufferView' : 'Buffer, TypedArray, or DataView';
    const error = new TypeError('The "' + (allowRaw ? 'input' : 'buf') + '" argument must be an instance of ' + accepted + '. Received ' + received);
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
}

if (typeof globalThis.TextDecoder === 'undefined') {
    const states = new WeakMap();
    const bufferOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
    const sharedLength = typeof SharedArrayBuffer === 'function'
        ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get : null;
    function isShared(bytes) {
        if (!sharedLength) return false;
        try { sharedLength.call(bufferOf.call(bytes)); return true; } catch (_) { return false; }
    }
    const labels = Object.create(null);
    for (const [encoding, aliases] of [
        ['utf-8', 'unicode-1-1-utf-8 unicode11utf8 unicode20utf8 utf-8 utf8 x-unicode20utf8'],
        ['utf-16le', 'csunicode iso-10646-ucs-2 ucs-2 unicode unicodefeff utf-16 utf-16le'],
        ['utf-16be', 'unicodefffe utf-16be'],
        ['windows-1252', 'ansi_x3.4-1968 ascii cp1252 cp819 csisolatin1 ibm819 iso-8859-1 iso-ir-100 iso8859-1 iso88591 iso_8859-1 iso_8859-1:1987 l1 latin1 us-ascii windows-1252 x-cp1252'],
    ]) for (const label of aliases.split(' ')) labels[label] = encoding;
    const windows1252 = [0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,
        0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,
        0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,
        0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
    function invalidType(message) {
        const error = new TypeError(message);
        error.code = 'ERR_INVALID_ARG_TYPE';
        return error;
    }
    function stateOf(receiver) {
        const state = states.get(receiver);
        if (state) return state;
        const error = new TypeError('Value of this must be of type TextDecoder');
        error.code = 'ERR_INVALID_THIS';
        throw error;
    }
    function validateOptions(options) {
        if (options != null && typeof options !== 'object') throw invalidType('The options argument must be an object');
    }
    function reset(state) {
        state.bomSeen = false;
        state.needed = state.seen = state.point = 0;
        state.lower = 0x80; state.upper = 0xbf;
        state.byte = state.surrogate = undefined;
    }
    globalThis.TextDecoder = class TextDecoder {
        constructor(label = 'utf-8', options) {
            const labelText = `${label}`;
            validateOptions(options);
            const name = labelText
                .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
            if (!labels[name]) {
                const error = new RangeError('The encoding label provided is invalid: ' + name);
                error.code = 'ERR_ENCODING_NOT_SUPPORTED';
                throw error;
            }
            const state = { encoding: labels[name], fatal: !!options?.fatal,
                ignoreBOM: !!options?.ignoreBOM, stream: false };
            reset(state);
            states.set(this, state);
        }
        decode(input = undefined, options) {
            const state = stateOf(this);
            validateOptions(options);
            const bytes = input === undefined ? new Uint8Array(0) : _nodeBufferSourceBytes(input, true);
            if (!state.stream) reset(state);
            // A failed conversion publishes no current-call output/BOM state.
            // Established stream BOM state survives fatal errors, while the
            // actual pending decoder bytes/code point are retired below.
            // The stream getter can reenter and publish newer decoder state.
            state.stream = !!options?.stream;
            const previousBomSeen = state.bomSeen;
            // Native conversion is valid only for a complete UTF-8 span with no
            // pending sequence. Incomplete or malformed input needs the state
            // machine below; the adapter's one-shot converter cannot retain it.
            // Shared spans may change between validation and conversion, so
            // decode each observed byte directly instead of trusting that check.
            if (state.encoding === 'utf-8' && state.needed === 0 &&
                typeof _nodeNative.decodeUtf8 === 'function' && !isShared(bytes) && _bufferIsUtf8(bytes)) {
                let result = _nodeNative.decodeUtf8(bytes);
                if (!state.bomSeen && result.length) {
                    state.bomSeen = true;
                    if (!state.ignoreBOM && result.charCodeAt(0) === 0xfeff) result = result.slice(1);
                }
                // A completed nonstream call retires its decoder state now,
                // before a later options getter can reenter the same owner.
                if (!state.stream) reset(state);
                return result;
            }
            const parts = [];
            let units = [];
            function emit(point) {
                if (!state.bomSeen) {
                    state.bomSeen = true;
                    if (!state.ignoreBOM && point === 0xfeff) return;
                }
                if (point > 0xffff) {
                    point -= 0x10000;
                    units.push(0xd800 + (point >> 10), 0xdc00 + (point & 0x3ff));
                } else units.push(point);
                if (units.length >= 8192) { parts.push(String.fromCharCode(...units)); units = []; }
            }
            function error() {
                if (state.fatal) {
                    // Keep this call's stream/flush policy and retire partial
                    // decoder ownership. Only streaming failure preserves the
                    // BOM state committed before this conversion.
                    reset(state);
                    if (state.stream) state.bomSeen = previousBomSeen;
                    const failure = new TypeError('The encoded data was not valid for encoding ' + state.encoding);
                    failure.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
                    throw failure;
                }
                emit(0xfffd);
            }
            if (state.encoding === 'utf-8') {
                for (let i = 0; i < bytes.length; i++) {
                    const byte = bytes[i];
                    if (state.needed === 0) {
                        if (byte <= 0x7f) { emit(byte); continue; }
                        if (byte >= 0xc2 && byte <= 0xdf) { state.needed = 1; state.point = byte & 0x1f; }
                        else if (byte >= 0xe0 && byte <= 0xef) {
                            state.needed = 2; state.point = byte & 0xf;
                            if (byte === 0xe0) state.lower = 0xa0;
                            if (byte === 0xed) state.upper = 0x9f;
                        } else if (byte >= 0xf0 && byte <= 0xf4) {
                            state.needed = 3; state.point = byte & 7;
                            if (byte === 0xf0) state.lower = 0x90;
                            if (byte === 0xf4) state.upper = 0x8f;
                        } else error();
                    } else if (byte < state.lower || byte > state.upper) {
                        state.needed = state.seen = state.point = 0;
                        state.lower = 0x80; state.upper = 0xbf;
                        error();
                        i--; // An invalid continuation may start a new sequence.
                    } else {
                        state.lower = 0x80; state.upper = 0xbf;
                        state.point = (state.point << 6) | (byte & 0x3f);
                        if (++state.seen === state.needed) {
                            emit(state.point);
                            state.needed = state.seen = state.point = 0;
                        }
                    }
                }
                if (!state.stream && state.needed !== 0) { state.needed = 0; error(); }
            } else if (state.encoding === 'windows-1252') {
                for (const byte of bytes) emit(byte >= 0x80 && byte <= 0x9f ? windows1252[byte - 0x80] : byte);
            } else {
                for (const byte of bytes) {
                    if (state.byte === undefined) { state.byte = byte; continue; }
                    const unit = state.encoding === 'utf-16le' ? state.byte | (byte << 8) : (state.byte << 8) | byte;
                    state.byte = undefined;
                    if (state.surrogate !== undefined) {
                        const lead = state.surrogate;
                        state.surrogate = undefined;
                        if (unit >= 0xdc00 && unit <= 0xdfff) {
                            emit(0x10000 + ((lead - 0xd800) << 10) + unit - 0xdc00);
                            continue;
                        }
                        error();
                    }
                    if (unit >= 0xd800 && unit <= 0xdbff) state.surrogate = unit;
                    else if (unit >= 0xdc00 && unit <= 0xdfff) error();
                    else emit(unit);
                }
                if (!state.stream && (state.byte !== undefined || state.surrogate !== undefined)) {
                    state.byte = state.surrogate = undefined;
                    error();
                }
            }
            if (units.length) parts.push(String.fromCharCode(...units));
            const result = parts.join('');
            if (!state.stream) reset(state);
            return result;
        }
        get encoding() { return stateOf(this).encoding; }
        get fatal() { return stateOf(this).fatal; }
        get ignoreBOM() { return stateOf(this).ignoreBOM; }
    };
    for (const name of ['decode', 'encoding', 'fatal', 'ignoreBOM']) {
        Object.defineProperty(globalThis.TextDecoder.prototype, name, { enumerable: true });
    }
    Object.defineProperty(globalThis.TextDecoder.prototype, Symbol.toStringTag, { value: 'TextDecoder', configurable: true });
}

// Some JavaScript engine parsers are very slow on multi-MB npm packuments.
// Use the native JSON parser hook when present; fall back otherwise.
if (typeof _nodeNative.jsonParse === 'function') {
    const _origJsonParse = JSON.parse;
    JSON.parse = function(text, reviver) {
        if (reviver !== undefined || typeof text !== 'string') {
            return _origJsonParse.call(JSON, text, reviver);
        }
        return _nodeNative.jsonParse(text);
    };
}

// ============================================================
// atob/btoa polyfill for engines that do not provide it.
// ============================================================

if (typeof globalThis.atob === 'undefined') {
    const _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const _b64lookup = new Uint8Array(256);
    for (let i = 0; i < _b64chars.length; i++) _b64lookup[_b64chars.charCodeAt(i)] = i;

    globalThis.btoa = function(str) {
        let result = '';
        const len = str.length;
        for (let i = 0; i < len; i += 3) {
            const a = str.charCodeAt(i);
            const b = i + 1 < len ? str.charCodeAt(i + 1) : 0;
            const c = i + 2 < len ? str.charCodeAt(i + 2) : 0;
            const triple = (a << 16) | (b << 8) | c;
            result += _b64chars[(triple >> 18) & 0x3F];
            result += _b64chars[(triple >> 12) & 0x3F];
            result += i + 1 < len ? _b64chars[(triple >> 6) & 0x3F] : '=';
            result += i + 2 < len ? _b64chars[triple & 0x3F] : '=';
        }
        return result;
    };

    globalThis.atob = function(str) {
        str = str.replace(/=+$/, '');
        let result = '';
        let i = 0;
        while (i < str.length) {
            const a = _b64lookup[str.charCodeAt(i++)];
            const b = _b64lookup[str.charCodeAt(i++)];
            const c = _b64lookup[str.charCodeAt(i++)];
            const d = _b64lookup[str.charCodeAt(i++)];
            const triple = (a << 18) | (b << 12) | (c << 6) | d;
            result += String.fromCharCode((triple >> 16) & 0xFF);
            if (c !== undefined) result += String.fromCharCode((triple >> 8) & 0xFF);
            if (d !== undefined) result += String.fromCharCode(triple & 0xFF);
        }
        return result;
    };
}

// ============================================================
// Internal helpers
// ============================================================

const _SLASH = '/';
const _DOT = '.';

function _errnoToCode(errno) {
    const map = {
        1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR',
        5: 'EIO', 7: 'E2BIG', 8: 'ENOEXEC', 9: 'EBADF', 10: 'ECHILD', 11: 'EAGAIN', 12: 'ENOMEM',
        13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR',
        22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE', 27: 'EFBIG', 28: 'ENOSPC', 29: 'ESPIPE',
        30: 'EROFS', 31: 'EMLINK', 32: 'EPIPE', 36: 'ENAMETOOLONG',
        38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 61: 'ENODATA', 75: 'EOVERFLOW', 95: 'ENOTSUP',
        88: 'ENOTSOCK', 89: 'EDESTADDRREQ', 90: 'EMSGSIZE', 93: 'EPROTONOSUPPORT',
        97: 'EAFNOSUPPORT', 100: 'ENETDOWN', 103: 'ECONNABORTED', 105: 'ENOBUFS',
        108: 'ESHUTDOWN', 113: 'EHOSTUNREACH', 114: 'EALREADY', 115: 'EINPROGRESS', 125: 'ECANCELED',
        98: 'EADDRINUSE', 99: 'EADDRNOTAVAIL', 101: 'ENETUNREACH',
        107: 'ENOTCONN', 110: 'ETIMEDOUT',
        111: 'ECONNREFUSED', 104: 'ECONNRESET',
    };
    return map[Math.abs(errno)] || `E${Math.abs(errno)}`;
}

function _makeNodeError(message, code, errno, syscall, path) {
    const err = new Error(message);
    err.code = code;
    if (errno !== undefined) err.errno = -Math.abs(errno);
    if (syscall) err.syscall = syscall;
    if (path) err.path = path;
    return err;
}

let _nodeFsSystemErrors;
function _throwErrno(errno, syscall, path, dest) {
    if (_nodeFsSystemErrors !== undefined) throw _nodeFsSystemErrors.fromErrno(errno, syscall, path, dest);
    const code = _errnoToCode(errno);
    const msg = `${code}: ${syscall}` + (path ? ` '${path}'` : '');
    throw _makeNodeError(msg, code, errno, syscall, path);
}

function _checkErrno(errno, syscall, path) {
    if (errno < 0) _throwErrno(-errno, syscall, path);
    if (errno !== 0) _throwErrno(errno, syscall, path);
}

// Honest throwing stub for builtin surface we expose for link-time
// completeness but have not implemented. Calling it fails loudly instead
// of silently succeeding — see docs/posix-status.md for the tracked gap.
function _notImpl(mod, name) {
    return function () {
        throw new Error(mod + '.' + name + ' is not implemented on spidermonkey-node');
    };
}

// ============================================================
// path module
// ============================================================

// ============================================================
// events module (EventEmitter)
// ============================================================

const events = (() => {
'use strict';
// Adapted from Node.js v26.13.0 lib/events.js, source commit
// 18b32a3b1552e199a01f1a8d9fd64aa756d3b75b. The listener core is shared
// behavior. EventTarget metadata is linked to the pinned event platform;
// Async-resource integration is linked to the pinned async platform below.
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
const { Reflect, Object, Array, Function, Symbol, Boolean, Error, TypeError,
        RangeError, String, Number } = globalThis;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const ObjectDefineProperty = Object.defineProperty;
const ObjectDefineProperties = Object.defineProperties;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ArrayPrototypeSlice = Function.prototype.call.bind(Array.prototype.slice);
const ArrayPrototypePush = Function.prototype.call.bind(Array.prototype.push);
function spliceOne(list, index) {
  for (; index + 1 < list.length; index++)
    list[index] = list[index + 1];
  list.pop();
}
const kRejection = Symbol.for('nodejs.rejection');
const kCapture = Symbol('kCapture');
const kErrorMonitor = Symbol('events.errorMonitor');
const kShapeMode = Symbol('shapeMode');
const kEmitting = Symbol('events.emitting');
const kMaxEventTargetListeners = Symbol('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned = Symbol('events.maxEventTargetListenersWarned');
const inspect = (...args) => util.inspect(...args);
function invalidType(name, expected, value) {
  if (_nodeValues) return new _nodeValues.errors.codes.ERR_INVALID_ARG_TYPE(name, expected, value);
  let received;
  if (value === null) received = 'null';
  else if (value === undefined) received = 'undefined';
  else if (typeof value === 'object' || typeof value === 'function') received = `an instance of ${value.constructor?.name || 'Object'}`;
  else received = `type ${typeof value} (${inspect(value)})`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = 'ERR_INVALID_ARG_TYPE';
  return error;
}
function ERR_INVALID_ARG_TYPE(name, expected, value) {
  return invalidType(name, expected, value);
}
function validateFunction(value, name) {
  if (_nodeValues) return _nodeValues.validators.validateFunction(value, name);
  if (typeof value !== 'function') throw invalidType(name, 'function', value);
}
function validateBoolean(value, name) {
  if (_nodeValues) return _nodeValues.validators.validateBoolean(value, name);
  if (typeof value !== 'boolean') throw invalidType(name, 'boolean', value);
}
function validateNumber(value, name, minimum) {
  if (_nodeValues) return _nodeValues.validators.validateNumber(value, name, minimum);
  if (typeof value !== 'number') throw invalidType(name, 'number', value);
  if (Number.isNaN(value) || value < minimum) {
    const error = new RangeError(`The value of "${name}" is out of range. It must be >= ${minimum}. Received ${inspect(value)}`);
    error.code = 'ERR_OUT_OF_RANGE'; throw error;
  }
}
function genericNodeError(message, properties) {
  if (_nodeValues) return _nodeValues.errors.genericNodeError(message, properties);
  return Object.assign(new Error(message), properties);
}
function isPublicEventTarget(value) {
  return _nodeEventPlatform ? _nodeEventPlatform.eventTarget.isEventTarget(value) : false;
}
function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.usingDomains = false;
EventEmitter.captureRejectionSymbol = kRejection;
EventEmitter.errorMonitor = kErrorMonitor;
ObjectDefineProperty(EventEmitter, 'captureRejections', {
  get() { return EventEmitter.prototype[kCapture]; },
  set(value) { validateBoolean(value, 'EventEmitter.captureRejections'); EventEmitter.prototype[kCapture] = value; },
  enumerable: true,
});
ObjectDefineProperty(EventEmitter.prototype, kCapture, {value:false, writable:true});
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
let defaultMaxListeners = 10;
let isEventTarget;

function checkListener(listener) {
  validateFunction(listener, 'listener');
}

ObjectDefineProperty(EventEmitter, 'defaultMaxListeners', {
  __proto__: null,
  enumerable: true,
  get: function() {
    return defaultMaxListeners;
  },
  set: function(arg) {
    validateNumber(arg, 'defaultMaxListeners', 0);
    defaultMaxListeners = arg;
  },
});

ObjectDefineProperties(EventEmitter, {
  kMaxEventTargetListeners: {
    __proto__: null,
    value: kMaxEventTargetListeners,
    enumerable: false,
    configurable: false,
    writable: false,
  },
  kMaxEventTargetListenersWarned: {
    __proto__: null,
    value: kMaxEventTargetListenersWarned,
    enumerable: false,
    configurable: false,
    writable: false,
  },
});

/**
 * Sets the max listeners.
 * @param {number} n
 * @param {EventTarget[] | EventEmitter[]} [eventTargets]
 * @returns {void}
 */
EventEmitter.setMaxListeners =
  function(n = defaultMaxListeners, ...eventTargets) {
    validateNumber(n, 'setMaxListeners', 0);
    if (eventTargets.length === 0) {
      defaultMaxListeners = n;
    } else {
      if (isEventTarget === undefined)
        isEventTarget = isPublicEventTarget;

      for (let i = 0; i < eventTargets.length; i++) {
        const target = eventTargets[i];
        if (isEventTarget(target)) {
          target[kMaxEventTargetListeners] = n;
          target[kMaxEventTargetListenersWarned] = false;
        } else if (typeof target.setMaxListeners === 'function') {
          target.setMaxListeners(n);
        } else {
          throw new ERR_INVALID_ARG_TYPE(
            'eventTargets',
            ['EventEmitter', 'EventTarget'],
            target);
        }
      }
    }
  };

// If you're updating this function definition, please also update any
// re-definitions, such as the one in the Domain module (lib/domain.js).
EventEmitter.init = function(opts) {

  if (this._events === undefined ||
      this._events === ObjectGetPrototypeOf(this)._events) {
    this._events = { __proto__: null };
    this._eventsCount = 0;
    this[kShapeMode] = false;
  } else {
    this[kShapeMode] = true;
  }

  this._maxListeners ||= undefined;


  if (opts?.captureRejections) {
    validateBoolean(opts.captureRejections, 'options.captureRejections');
    this[kCapture] = Boolean(opts.captureRejections);
  } else {
    // Assigning the kCapture property directly saves an expensive
    // prototype lookup in a very sensitive hot path.
    this[kCapture] = EventEmitter.prototype[kCapture];
  }
};

function addCatch(that, promise, type, args) {
  if (!that[kCapture]) {
    return;
  }

  // Handle Promises/A+ spec, then could be a getter
  // that throws on second use.
  try {
    const then = promise.then;

    if (typeof then === 'function') {
      then.call(promise, undefined, function(err) {
        // The callback is called with nextTick to avoid a follow-up
        // rejection from this promise.
        process.nextTick(emitUnhandledRejectionOrErr, that, err, type, args);
      });
    }
  } catch (err) {
    that.emit('error', err);
  }
}

function emitUnhandledRejectionOrErr(ee, err, type, args) {
  if (typeof ee[kRejection] === 'function') {
    ee[kRejection](err, type, ...args);
  } else {
    // We have to disable the capture rejections mechanism, otherwise
    // we might end up in an infinite loop.
    const prev = ee[kCapture];

    // If the error handler throws, it is not catchable and it
    // will end up in 'uncaughtException'. We restore the previous
    // value of kCapture in case the uncaughtException is present
    // and the exception is handled.
    try {
      ee[kCapture] = false;
      ee.emit('error', err);
    } finally {
      ee[kCapture] = prev;
    }
  }
}

/**
 * Increases the max listeners of the event emitter.
 * @param {number} n
 * @returns {EventEmitter}
 */
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  validateNumber(n, 'setMaxListeners', 0);
  this._maxListeners = n;
  return this;
};

function _getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

/**
 * Returns the current max listener value for the event emitter.
 * @returns {number}
 */
EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return _getMaxListeners(this);
};

function getUnhandledErrorException(ee, args) {
  const value = args.length > 0 ? args[0] : undefined;
  if (value instanceof Error) return value;
  let rendered;
  try { rendered = _nodeInspection.inspect(value); } catch { rendered = value; }
  const error = new _nodeValues.errors.codes.ERR_UNHANDLED_ERROR(rendered);
  error.context = value;
  return error;
}

/**
 * Synchronously calls each of the listeners registered
 * for the event.
 * @param {string | symbol} type
 * @param {...any} [args]
 * @returns {boolean}
 */
EventEmitter.prototype.emit = function emit(type, ...args) {
  let doError = (type === 'error');

  const events = this._events;
  if (events !== undefined) {
    if (doError && events[kErrorMonitor] !== undefined)
      this.emit(kErrorMonitor, ...args);
    doError &&= events.error === undefined;
  } else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    const er = getUnhandledErrorException(this, args);
    // Note: The comments on the `throw` lines are intentional, they show
    // up in Node's output if this results in an unhandled exception.
    throw er; // Unhandled 'error' event
  }

  const handler = events[type];

  if (handler === undefined)
    return false;

  if (typeof handler === 'function') {
    const result = ReflectApply(handler, this, args);

    // We check if result is undefined first because that
    // is the most common case so we do not pay any perf
    // penalty
    if (result !== undefined && result !== null) {
      addCatch(this, result, type, args);
    }
  } else {
    handler[kEmitting]++;
    try {
      for (let i = 0; i < handler.length; ++i) {
        const result = ReflectApply(handler[i], this, args);

        // We check if result is undefined first because that
        // is the most common case so we do not pay any perf
        // penalty.
        // This code is duplicated because extracting it away
        // would make it non-inlineable.
        if (result !== undefined && result !== null) {
          addCatch(this, result, type, args);
        }
      }
    } finally {
      handler[kEmitting]--;
    }
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  let m;
  let events;
  let existing;

  checkListener(listener);

  events = target._events;
  if (events === undefined) {
    events = target._events = { __proto__: null };
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener !== undefined) {
      target.emit('newListener', type,
                  listener.listener ?? listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (existing === undefined) {
    // Optimize the case of one listener. Don't need the extra array object.
    events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = prepend ? [listener, existing] : [existing, listener];
      existing[kEmitting] = 0;
      events[type] = existing;
      // If we've already got an array, just append.
    } else {
      existing = ensureMutableListenerArray(events, type, existing);
      if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
    }

    // Check for listener leak
    m = _getMaxListeners(target);
    if (m > 0 && existing.length > m && !existing.warned)
      warnMaxListenersExceeded(target, type, existing, m);
  }

  return target;
}

function warnMaxListenersExceeded(target, type, existing, m) {
  existing.warned = true;
  // No error code for this since it is a Warning
  const w = genericNodeError(
    `Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners ` +
    `added to ${inspect(target, { depth: -1 })}. MaxListeners is ${m}. Use emitter.setMaxListeners() to increase limit`,
    { name: 'MaxListenersExceededWarning', emitter: target, type: type, count: existing.length });
  process.emitWarning(w);
}

/**
 * Adds a listener to the event emitter.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

/**
 * Adds the `listener` function to the beginning of
 * the listeners array.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function _onceWrap(target, type, listener) {
  let fired = false;
  function wrapper(...args) {
    if (fired) return;
    fired = true;
    target.removeListener(type, wrapper);
    return ReflectApply(listener, target, args);
  }
  wrapper.listener = listener;
  return wrapper;
}

/**
 * Adds a one-time `listener` function to the event emitter.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.once = function once(type, listener) {
  checkListener(listener);

  this.on(type, _onceWrap(this, type, listener));
  return this;
};

/**
 * Adds a one-time `listener` function to the beginning of
 * the listeners array.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      checkListener(listener);

      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

/**
 * Removes the specified `listener` from the listeners array.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      checkListener(listener);

      const events = this._events;
      if (events === undefined)
        return this;

      let list = events[type];
      if (list === undefined)
        return this;

      if (list === listener || list.listener === listener) {
        this._eventsCount -= 1;

        if (this[kShapeMode]) {
          events[type] = undefined;
        } else if (this._eventsCount === 0) {
          this._events = { __proto__: null };
        } else {
          delete events[type];
        }

        if (events.removeListener !== undefined)
          this.emit('removeListener', type, list.listener || listener);
      } else if (typeof list !== 'function') {
        list = ensureMutableListenerArray(events, type, list);
        let position = -1;

        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else {
          spliceOne(list, position);
        }

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener !== undefined)
          this.emit('removeListener', type, listener);
      }

      return this;
    };

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

/**
 * Removes all listeners from the event emitter. (Only
 * removes listeners for a specific event name if specified
 * as `type`).
 * @param {string | symbol} [type]
 * @returns {EventEmitter}
 */
EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      const events = this._events;
      if (events === undefined)
        return this;

      // Not listening for removeListener, no need to emit
      if (events.removeListener === undefined) {
        if (arguments.length === 0) {
          this._events = { __proto__: null };
          this._eventsCount = 0;
        } else if (events[type] !== undefined) {
          if (--this._eventsCount === 0)
            this._events = { __proto__: null };
          else
            delete events[type];
        }
        this[kShapeMode] = false;
        return this;
      }

      // Emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        for (const key of ReflectOwnKeys(events)) {
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = { __proto__: null };
        this._eventsCount = 0;
        this[kShapeMode] = false;
        return this;
      }

      const listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners !== undefined) {
        // LIFO order
        for (let i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  const events = target._events;

  if (events === undefined)
    return [];

  const evlistener = events[type];
  if (evlistener === undefined)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ?
    unwrapListeners(evlistener) : arrayClone(evlistener);
}

/**
 * Returns a copy of the array of listeners for the event name
 * specified as `type`.
 * @param {string | symbol} type
 * @returns {Function[]}
 */
EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

/**
 * Returns a copy of the array of listeners and wrappers for
 * the event name specified as `type`.
 * @param {string | symbol} type
 * @returns {Function[]}
 */
EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

/**
 * Returns the number of listeners listening to event name
 * specified as `type`.
 * @param {string | symbol} type
 * @param {Function} [listener]
 * @returns {number}
 */
EventEmitter.prototype.listenerCount = function listenerCount(type, listener) {
  const events = this._events;

  if (events !== undefined) {
    const evlistener = events[type];

    if (typeof evlistener === 'function') {
      if (listener != null) {
        return listener === evlistener || listener === evlistener.listener ? 1 : 0;
      }

      return 1;
    } else if (evlistener !== undefined) {
      if (listener != null) {
        let matching = 0;

        for (let i = 0, l = evlistener.length; i < l; i++) {
          if (evlistener[i] === listener || evlistener[i].listener === listener) {
            matching++;
          }
        }

        return matching;
      }

      return evlistener.length;
    }
  }

  return 0;
};

/**
 * Returns an array listing the events for which
 * the emitter has registered listeners.
 * @returns {(string | symbol)[]}
 */
EventEmitter.prototype.eventNames = function eventNames() {
  if (this._eventsCount === 0)
    return [];
  const events = this._events;
  const names = [];
  for (const key of ReflectOwnKeys(events)) {
    // Removed listeners leave the key in place with an `undefined` value.
    if (events[key] !== undefined)
      ArrayPrototypePush(names, key);
  }
  return names;
};

function arrayClone(arr) {
  switch (arr.length) {
    case 2: return [arr[0], arr[1]];
    case 3: return [arr[0], arr[1], arr[2]];
    case 4: return [arr[0], arr[1], arr[2], arr[3]];
    case 5: return [arr[0], arr[1], arr[2], arr[3], arr[4]];
    case 6: return [arr[0], arr[1], arr[2], arr[3], arr[4], arr[5]];
  }
  return ArrayPrototypeSlice(arr);
}

function cloneEventListenerArray(arr) {
  const copy = arrayClone(arr);
  copy[kEmitting] = 0;
  if (arr.warned) {
    copy.warned = true;
  }
  return copy;
}

function ensureMutableListenerArray(events, type, handler) {
  if (handler[kEmitting] > 0) {
    const copy = cloneEventListenerArray(handler);
    events[type] = copy;
    return copy;
  }
  return handler;
}

function unwrapListeners(arr) {
  const ret = arrayClone(arr);
  for (let i = 0; i < ret.length; ++i) {
    const orig = ret[i].listener;
    if (typeof orig === 'function')
      ret[i] = orig;
  }
  return ret;
}



EventEmitter.getEventListeners = function getEventListeners(emitter, type) {
  if (typeof emitter?.listeners === 'function') return emitter.listeners(type);
  if (isPublicEventTarget(emitter)) return _nodeEventPlatform.helpers.getEventListeners(emitter, type);
  throw new ERR_INVALID_ARG_TYPE('emitter', ['EventEmitter', 'EventTarget'], emitter);
};
EventEmitter.getMaxListeners = function getMaxListeners(emitter) {
  if (typeof emitter?.getMaxListeners === 'function') return emitter.getMaxListeners();
  if (isPublicEventTarget(emitter)) return emitter[kMaxEventTargetListeners];
  throw new ERR_INVALID_ARG_TYPE('emitter', ['EventEmitter', 'EventTarget'], emitter);
};
EventEmitter.listenerCount = function listenerCount(emitter, type) {
  if (typeof emitter?.listenerCount === 'function') return emitter.listenerCount(type);
  return ReflectApply(EventEmitter.prototype.listenerCount, emitter, [type]);
};
    // Public once/on/abort helpers are linked with EventTarget below, after
    // the process, timer and inspection dependencies have been initialized.
    return EventEmitter;
})();

// events.setMaxListeners is implemented by the shared listener core above.

// ============================================================
// Buffer class
// ============================================================

const _FastBuffer = (() => {
    const _encoder = new TextEncoder();
    const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const typedLength = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(typedPrototype, 'length').get);
    const typedTag = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get);
    const hexMin = Math.min;
    const SingleByteArray = Uint8Array;
    const singleByteCharCode = Function.prototype.call.bind(String.prototype.charCodeAt);
    const normalizeSingleByteEncoding = Function.prototype.call.bind(String.prototype.toLowerCase);
    const singleByteBacking = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get);

    class FastBuffer extends Uint8Array {
        // Static factory methods
        static alloc(size, fill, encoding) {
            const buf = new FastBuffer(size);
            if (fill !== undefined) {
                if (typeof fill === 'number') {
                    buf.fill(fill);
                } else if (typeof fill === 'string') {
                    const bytes = _encoder.encode(fill);
                    for (let i = 0; i < size; i++) buf[i] = bytes[i % bytes.length];
                }
            }
            return buf;
        }

        static allocUnsafe(size) {
            return new FastBuffer(size);
        }

        static from(value, encodingOrOffset, length) {
            if (typeof value === 'string') {
                const encoding = typeof encodingOrOffset === 'string' ? normalizeSingleByteEncoding(encodingOrOffset) : 'utf8';
                if (encoding === 'latin1' || encoding === 'binary' || encoding === 'ascii') {
                    // Node's single-byte encoders retain the low eight bits
                    // of each UTF-16 code unit (ASCII decoding is separate).
                    const bytes = new SingleByteArray(value.length);
                    for (let i = 0; i < value.length; i++) bytes[i] = singleByteCharCode(value, i);
                    return new FastBuffer(singleByteBacking(bytes));
                }
                if (encoding === 'hex') {
                    const bytes = [];
                    for (let i = 0; i < value.length; i += 2) {
                        bytes.push(parseInt(value.substr(i, 2), 16));
                    }
                    return new FastBuffer(bytes);
                }
                if (encoding === 'base64') {
                    const binary = atob(value);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    return new FastBuffer(bytes.buffer);
                }
                // Other string codecs remain a separate implementation gap.
                return new FastBuffer(_encoder.encode(value));
            }
            if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
                return new FastBuffer(value, encodingOrOffset, length);
            }
            if (ArrayBuffer.isView(value)) {
                return new FastBuffer(value.buffer, value.byteOffset, value.byteLength);
            }
            if (Array.isArray(value)) {
                return new FastBuffer(value);
            }
            if (typeof value === 'object' && value.type === 'FastBuffer' && Array.isArray(value.data)) {
                return new FastBuffer(value.data);
            }
            throw new TypeError('Invalid argument for FastBuffer.from');
        }

        static concat(list, totalLength) {
            if (totalLength === undefined) {
                totalLength = 0;
                for (const buf of list) totalLength += buf.length;
            }
            const result = FastBuffer.alloc(totalLength);
            let offset = 0;
            for (const buf of list) {
                const src = buf instanceof Uint8Array ? buf : FastBuffer.from(buf);
                result.set(src, offset);
                offset += src.length;
                if (offset >= totalLength) break;
            }
            return result;
        }

        static isBuffer(obj) {
            return obj instanceof FastBuffer;
        }

        static isEncoding(encoding) {
            return ['utf8', 'utf-8', 'ascii', 'latin1', 'binary',
                    'hex', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le']
                   .includes(String(encoding).toLowerCase());
        }

        static byteLength(string, encoding) {
            if (typeof string !== 'string') return string.length;
            return _encoder.encode(string).length;
        }

        static compare(a, b) {
            const len = Math.min(a.length, b.length);
            for (let i = 0; i < len; i++) {
                if (a[i] < b[i]) return -1;
                if (a[i] > b[i]) return 1;
            }
            if (a.length < b.length) return -1;
            if (a.length > b.length) return 1;
            return 0;
        }

        toString(encoding, start, end) {
            encoding = (encoding || 'utf8').toLowerCase();
            start = start || 0;
            end = end === undefined ? this.length : end;
            const slice = this.subarray(start, end);

            if (encoding === 'hex') {
                let hex = '';
                for (let i = 0; i < slice.length; i++) {
                    hex += slice[i].toString(16).padStart(2, '0');
                }
                return hex;
            }
            if (encoding === 'base64') {
                let binary = '';
                for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
                return btoa(binary);
            }
            return _decoder.decode(slice);
        }

        hexSlice(start = 0, end) {
            if (typedTag(this) !== 'Uint8Array') throw new TypeError('hexSlice requires a Uint8Array');
            const length = typedLength(this);
            let result = '';
            start = start >>> 0;
            end = end === undefined ? length : hexMin(end >>> 0, length);
            for (let i = start; i < end; i++) {
                result += '0123456789abcdef'[this[i] >>> 4] + '0123456789abcdef'[this[i] & 15];
            }
            return result;
        }

        write(string, offset, length, encoding) {
            if (typeof offset === 'string') { encoding = offset; offset = 0; length = this.length; }
            else if (typeof length === 'string') { encoding = length; length = this.length - (offset || 0); }
            offset = offset || 0;
            length = length === undefined ? this.length - offset : length;
            const bytes = _encoder.encode(string);
            const toWrite = Math.min(bytes.length, length, this.length - offset);
            for (let i = 0; i < toWrite; i++) this[offset + i] = bytes[i];
            return toWrite;
        }

        toJSON() {
            return { type: 'FastBuffer', data: Array.from(this) };
        }

        equals(other) {
            return FastBuffer.compare(this, other) === 0;
        }

        compare(other, targetStart, targetEnd, sourceStart, sourceEnd) {
            const src = this.subarray(sourceStart || 0, sourceEnd);
            const tgt = (other instanceof Uint8Array ? other : FastBuffer.from(other))
                        .subarray(targetStart || 0, targetEnd);
            return FastBuffer.compare(src, tgt);
        }

        copy(target, targetStart, sourceStart, sourceEnd) {
            targetStart = targetStart || 0;
            sourceStart = sourceStart || 0;
            sourceEnd = sourceEnd === undefined ? this.length : sourceEnd;
            const slice = this.subarray(sourceStart, sourceEnd);
            target.set(slice, targetStart);
            return slice.length;
        }

        slice(start, end) {
            const sliced = super.subarray(start, end);
            return Object.setPrototypeOf(sliced, FastBuffer.prototype);
        }

        subarray(start, end) {
            const sliced = super.subarray(start, end);
            return Object.setPrototypeOf(sliced, FastBuffer.prototype);
        }

        indexOf(value, byteOffset, encoding) {
            byteOffset = byteOffset || 0;
            if (typeof value === 'number') {
                for (let i = byteOffset; i < this.length; i++) {
                    if (this[i] === value) return i;
                }
                return -1;
            }
            if (typeof value === 'string') value = FastBuffer.from(value, encoding);
            for (let i = byteOffset; i <= this.length - value.length; i++) {
                let found = true;
                for (let j = 0; j < value.length; j++) {
                    if (this[i + j] !== value[j]) { found = false; break; }
                }
                if (found) return i;
            }
            return -1;
        }

        includes(value, byteOffset, encoding) {
            return this.indexOf(value, byteOffset, encoding) !== -1;
        }

    }

    return FastBuffer;
})();

const _nodeBufferConstructor = _createNodeBufferConstructor({
    FastBuffer: _FastBuffer,
    isInsideNodeModules: _nodeNative.isInsideNodeModules,
    getOptionValue(name) {
        if (name === '--pending-deprecation') return _nodeBufferPendingDeprecation;
        throw new Error('Unknown Buffer constructor option: ' + name);
    },
});
const Buffer = _nodeBufferConstructor.Buffer;
const _nodeBufferPendingDeprecation = _nodeNative.environment('safeget', 'NODE_PENDING_DEPRECATION') === '1';

const _nodeBufferLimits = _nodeNative.getBufferLimits();
const _nodeBufferConstants = Object.defineProperties({}, {
    MAX_LENGTH: { value: _nodeBufferLimits.MAX_LENGTH, enumerable: true },
    MAX_STRING_LENGTH: { value: _nodeBufferLimits.MAX_STRING_LENGTH, enumerable: true },
});
const _nodeBufferModule = {
    Buffer,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    isAscii: _bufferIsAscii,
    isUtf8: _bufferIsUtf8,
    constants: _nodeBufferConstants,
    kMaxLength: _nodeBufferConstants.MAX_LENGTH,
    kStringMaxLength: _nodeBufferConstants.MAX_STRING_LENGTH,
};


// ============================================================
// process module
// ============================================================

const _nodeProcessClock = _createNodeProcessClock({ native: _nodeNative, getValues: () => _nodeValues });
const _nodeProcessState = _createNodeProcessState({ native: _nodeNative, getValues: () => _nodeValues });
const process = (() => {
    const [cwd_val] = os.getcwd();
    let _cwd = cwd_val || '/';
    const envProxy = _nodeProcessState.createEnvironment();

    // Create process as an EventEmitter instance without calling the class constructor
    const proc = new events.EventEmitter();

    Object.assign(proc, {
        title: 'node',
        arch: 'wasm32',
        platform: 'kandelo', // POSIX platform, not a Linux runtime
        env: envProxy,
        argv: [],  // Set by node-main.c
        argv0: '',
        execArgv: Array.from(_nodeNative.cliOptions?.execArgv || []),
        execPath: '/usr/bin/node',
        pid: os.getpid(),
        // Absence is observable: applications use an assigned exitCode to
        // distinguish a requested shutdown from a running process.
        exitCode: undefined,
        _exiting: false,

        cwd() {
            if (_nodeNative.workerEnvironment) {
                const [directory, error] = os.getcwd();
                if (error) _throwErrno(error, 'cwd');
                return directory;
            }
            return _cwd;
        },
        chdir(dir) {
            if (_nodeNative.workerEnvironment) throw new _nodeValues.errors.codes.ERR_WORKER_UNSUPPORTED_OPERATION('process.chdir()');
            const err = os.chdir(dir);
            if (err !== 0) _throwErrno(err, 'chdir', dir);
            const [newCwd] = os.getcwd();
            _cwd = newCwd || dir;
        },

        exit(code) {
            if (arguments.length !== 0) proc.exitCode = code;
            if (!proc._exiting) {
                proc._exiting = true;
                proc.emit('exit', proc.exitCode === undefined ? 0 : proc.exitCode);
            }
            // Exit listeners can still assign the final status.
            std.exit(proc.exitCode === undefined ? 0 : proc.exitCode);
        },

        abort: _nodeNative.processAbort,

        getuid() { return _nodeNative.credentials().uid; },
        geteuid() { return _nodeNative.credentials().euid; },
        getgid() { return _nodeNative.credentials().gid; },
        getegid() { return _nodeNative.credentials().egid; },
        _kill(pid, signum) {
            try { _nodeNative.__kandeloKill(pid, signum); return 0; }
            catch (error) {
                if (typeof error.errno !== 'number') throw error;
                return -Math.abs(error.errno);
            }
        },
        kill(pid, signal) {
            // Node accepts values equal to their int32 conversion (including
            // numeric strings), and numeric zero is a probe, never SIGTERM.
            if (pid != (pid | 0)) {
                const error = new TypeError('The "pid" argument must be an int32');
                error.code = 'ERR_INVALID_ARG_TYPE'; throw error;
            }
            let signum;
            if (signal === (signal | 0)) signum = signal;
            else {
                signal = signal || 'SIGTERM';
                signum = nodeOs.constants.signals[signal];
                if (typeof signum !== 'number') {
                    const error = new TypeError('Unknown signal: ' + String(signal));
                    error.code = 'ERR_UNKNOWN_SIGNAL'; throw error;
                }
            }
            const error = proc._kill(pid | 0, signum);
            if (error) _throwErrno(-error, 'kill');
            return true;
        },

        hrtime: _nodeProcessClock.hrtime,

        nextTick(fn, ...args) {
            _nodeAsyncPlatform.enqueueTick(fn, ...args);
        },

        uptime() {
            return _nodeNative.performanceNow() / 1000;
        },

        umask: _nodeNative.workerEnvironment ? undefined : _nodeProcessState.createUmask(),

        features: {},
        config: { variables: {} },
        release: { name: 'node', lts: _nodeCompatibilityTarget.lts },
        moduleLoadList: [],
        report: {
            getReport() { throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('process.report.getReport measurements and loaded objects'); },
        },
    });

    Object.defineProperty(proc, 'ppid', { enumerable: true, configurable: true,
        get: _nodeProcessState.parentPid });

    // Node stores a validated integer in its native int32 exit-info field.
    // Clearing with null or undefined restores absence, rather than storing
    // either value as the status passed to exit listeners.
    let exitCode;
    Object.defineProperty(proc, 'exitCode', {
        enumerable: true,
        configurable: false,
        get() { return exitCode; },
        set(code) {
            if (code === null || code === undefined) { exitCode = undefined; return; }
            let value = code;
            if (typeof code === 'string' && code !== '') value = Number(code);
            let error;
            if (typeof value !== 'number' || (typeof code === 'string' && Number.isNaN(value))) {
                error = new TypeError('The code argument must be a number');
                error.code = 'ERR_INVALID_ARG_TYPE';
            } else if (!Number.isSafeInteger(value)) {
                error = new RangeError('The code argument must be a safe integer');
                error.code = 'ERR_OUT_OF_RANGE';
            }
            if (error) throw error;
            exitCode = value | 0;
        },
    });

    // Define stdout/stderr/stdin as lazy getters (can't be in Object.assign
    // because assign evaluates getters immediately)
    Object.defineProperties(proc, {
        stdout: { get() { return _createWriteStream(1); }, configurable: true },
        stderr: { get() { return _createWriteStream(2); }, configurable: true },
        stdin: { get() { return _createReadStream(0); }, configurable: true },
    });

    // Target version states the requested API; dependency versions come from
    // the native owners and never imply complete Node conformance.
    _nodeProcessState.installVersions(proc, _nodeCompatibilityTarget.version, '140.11.0esr');
    return proc;
})();

// The pinned path module consumes the actual process cwd/environment. Both
// path variants are independent algorithms; the guest remains POSIX Kandelo.
const path = _createNodePathPlatform({ process, inspect: value => util.inspect(value), getValues: () => _nodeValues });

const _startTime = Date.now();

// Lazy stream creation for stdout/stderr/stdin
let _stdin;
let _nodeStdioOutputPlatform;
let _nodeReadlinePlatform;
function _cursorTo(...args) { return _nodeReadlinePlatform.callbacks.cursorTo(...args); }
function _moveCursor(...args) { return _nodeReadlinePlatform.callbacks.moveCursor(...args); }
function _clearLine(...args) { return _nodeReadlinePlatform.callbacks.clearLine(...args); }
function _clearScreenDown(...args) { return _nodeReadlinePlatform.callbacks.clearScreenDown(...args); }

function _createWriteStream(fd) {
    return _nodeStdioOutputPlatform.writable(fd);
}

function _createReadStream(fd) {
    if (_stdin) return _stdin;
    let retireTerminal;
    const input = _nodeFdStreamPlatform.readable(fd, undefined, () => retireTerminal?.());
    if (os.isatty(fd)) {
        input.isTTY = true;
        retireTerminal = _nodeTerminalPlatform.bindInput(input, fd);
    }
    _stdin = input;
    return input;
}

// ============================================================
// fs module
// ============================================================

const fs = (() => {
    const constants = _nodeNative.getFsConstants();

    function _pathToString(p) {
        let result;
        if (typeof p === 'string') result = p;
        else if (p instanceof URL) result = url.fileURLToPath(p);
        else if (Buffer.isBuffer(p)) result = p.toString();
        else {
            const error = new TypeError('path must be a string, Buffer, or URL');
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
        }
        // Do not let a decoded %00 truncate a pathname at the C bridge.
        if (result.indexOf('\0') !== -1) {
            const error = new TypeError('The path argument must not contain null bytes');
            error.code = 'ERR_INVALID_ARG_VALUE';
            throw error;
        }
        return result;
    }

    function _flagsToMode(flags) {
        if (typeof flags === 'number') return flags;
        const map = {
            'r': os.O_RDONLY,
            'r+': os.O_RDWR,
            'w': os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            'w+': os.O_RDWR | os.O_CREAT | os.O_TRUNC,
            'a': os.O_WRONLY | os.O_CREAT | os.O_APPEND,
            'a+': os.O_RDWR | os.O_CREAT | os.O_APPEND,
            'wx': os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_EXCL,
            'wx+': os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_EXCL,
            'ax': os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_EXCL,
            'ax+': os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_EXCL,
        };
        return map[flags] ?? os.O_RDONLY;
    }

    function existsSync(filepath) {
        const [, err] = os.stat(_pathToString(filepath));
        return err === 0;
    }

    function statSync(filepath, options) {
        return _nodeFsStats.statSync(filepath, options);
    }

    function lstatSync(filepath, options) {
        return _nodeFsStats.lstatSync(filepath, options);
    }

    function readFileSync(filepath, options) { return _nodeFileSync.readFileSync(...arguments); }

    function writeFileSync(filepath, data, options) { return _nodeFileSync.writeFileSync(...arguments); }

    function appendFileSync(filepath, data, options) { return _nodeFileSync.appendFileSync(...arguments); }

    function readdirSync(dirpath, options) {
        return _nodeReaddirPlatform.api.readdirSync(...arguments);
    }

    function mkdirSync(dirpath, options) {
        return _nodeDirectoryPlatform.api.mkdirSync(...arguments);
    }

    function rmdirSync(dirpath, options) {
        return _nodeDirectoryPlatform.api.rmdirSync(...arguments);
    }

    function rmSync(targetPath, options) {
        return _nodeRemovalPlatform.api.rmSync(...arguments);
    }

    function unlinkSync(filepath) {
        return _nodeDirectoryPlatform.api.unlinkSync(...arguments);
    }

    function renameSync(oldPath, newPath) {
        const o = _pathToString(oldPath);
        const n = _pathToString(newPath);
        const err = os.rename(o, n);
        if (err !== 0) _throwErrno(-err, 'rename', o);
    }

    function copyFileSync(src, dest, mode) {
        return _nodeCopyFile.api.copyFileSync(...arguments);
    }

    function symlinkSync(target, linkpath) {
        const err = os.symlink(_pathToString(target), _pathToString(linkpath));
        if (err !== 0) _throwErrno(-err, 'symlink', _pathToString(linkpath));
    }

    function readlinkSync(filepath) {
        const p = _pathToString(filepath);
        const [target, err] = os.readlink(p);
        if (err !== 0) _throwErrno(-err, 'readlink', p);
        return target;
    }

    function realpathSync(filepath) {
        const p = _pathToString(filepath);
        const [result, err] = os.realpath(p);
        if (err !== 0) _throwErrno(-err, 'realpath', p);
        return result;
    }

    function chmodSync(filepath, mode) {
        return _nodePathMetadata.api.chmodSync(...arguments);
    }

    function chownSync(filepath, uid, gid) {
        return _nodePathMetadata.api.chownSync(...arguments);
    }

    function utimesSync(filepath, atime, mtime) {
        return _nodePathMetadata.api.utimesSync(...arguments);
    }

    function accessSync(filepath, mode) {
        return _nodePathMetadata.api.accessSync(...arguments);
    }

    function openSync(filepath, flags, mode) { return _nodeFsStats.openSync(...arguments); }

    function closeSync(fd) {
        const result = os.close(fd);
        if (result < 0) _throwErrno(-result, 'close');
    }

    function readSync(fd, buffer, offsetOrOptions, length, position) { return _nodeFsStats.readSync(...arguments); }
    function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) { return _nodeFsStats.writeSync(...arguments); }

    // fs-minipass guards on `if (!fs.writev)` and falls back to
    // `process.binding('fs')` (unimplemented here) when absent.
    function writevSync(fd, buffers, position) { return _nodeFsStats.writevSync(...arguments); }

    function fsyncSync(fd) { return _nodeFsStats.fsyncSync(fd); }
    function fdatasyncSync(fd) { return _nodeFsStats.fdatasyncSync(fd); }

    function fstatSync(fd, options) {
        return _nodeFsStats.fstatSync(fd, options);
    }

    function fchmodSync(fd, mode) { return _nodeFsStats.fchmodSync(fd, mode); }

    function fchownSync(fd, uid, gid) { return _nodeFsStats.fchownSync(fd, uid, gid); }

    function futimesSync(fd, atime, mtime) { return _nodeFsStats.futimesSync(fd, atime, mtime); }

    function mkdtempSync(prefix, options) {
        return _nodeTempdirPlatform.api.mkdtempSync(prefix, options);
    }

    // Callback wrappers for sync filesystem helpers.
    function _callbackify(syncFn) {
        return function(...args) {
            const cb = args.pop();
            try {
                const result = syncFn(...args);
                if (typeof cb === 'function') queueMicrotask(() => cb(null, result));
            } catch (err) {
                if (typeof cb === 'function') queueMicrotask(() => cb(err));
            }
        };
    }

    const mod = {
        constants,
        existsSync,
        statSync,
        lstatSync,
        readFileSync,
        writeFileSync,
        appendFileSync,
        readdirSync,
        mkdirSync,
        rmdirSync,
        rmSync,
        unlinkSync,
        renameSync,
        copyFileSync,
        symlinkSync,
        readlinkSync,
        realpathSync,
        chmodSync,
        chownSync,
        utimesSync,
        accessSync,
        openSync,
        closeSync,
        readSync,
        writeSync,
        writevSync,
        writev(fd, buffers, position, cb) {
            if (typeof position === 'function') { cb = position; position = null; }
            try {
                const n = writevSync(fd, buffers, position);
                queueMicrotask(() => cb(null, n, buffers));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },
        fstatSync,
        fchmodSync,
        fchownSync,
        futimesSync,
        fsyncSync,
        fdatasyncSync,
        // No statfs primitive either; mirrors fs/promises.statfs (honest stub).
        statfsSync: _notImpl('fs', 'statfsSync'),
        mkdtempSync,

        // Async versions
        readFile: _callbackify(readFileSync),
        writeFile: _callbackify(writeFileSync),
        appendFile: _callbackify(appendFileSync),
        readdir: _callbackify(readdirSync),
        mkdir: _callbackify(mkdirSync),
        mkdtemp: _callbackify(mkdtempSync),
        rmdir: _callbackify(rmdirSync),
        unlink: _callbackify(unlinkSync),
        rename: _callbackify(renameSync),
        copyFile: _callbackify(copyFileSync),
        symlink: _callbackify(symlinkSync),
        readlink: _callbackify(readlinkSync),
        realpath: _callbackify(realpathSync),
        chmod: _callbackify(chmodSync),
        chown: _callbackify(chownSync),
        utimes: _callbackify(utimesSync),
        stat: _callbackify(statSync),
        lstat: _callbackify(lstatSync),
        access: _callbackify(accessSync),
        rm: _callbackify(rmSync),
        exists(filepath, cb) {
            cb(existsSync(filepath));
        },
        open: _callbackify(openSync),
        close: _callbackify(closeSync),
        fstat: _callbackify(fstatSync),
        fchmod: _callbackify(fchmodSync),
        fchown: _callbackify(fchownSync),
        futimes: _callbackify(futimesSync),
        fsync: _callbackify(fsyncSync),
        fdatasync: _callbackify(fdatasyncSync),
        write(fd, data, ...rest) {
            const cb = rest.pop();
            try {
                const n = writeSync(fd, data, ...rest);
                queueMicrotask(() => cb(null, n, data));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },

        watch(_path, _options, listener) {
            const w = {
                on() { return this; },
                once() { return this; },
                addListener() { return this; },
                removeListener() { return this; },
                off() { return this; },
                close() {},
                ref() { return this; },
                unref() { return this; },
            };
            if (typeof _options === 'function') listener = _options;
            // listener is never called, since we don't observe changes.
            return w;
        },
    };

    // fs.promises
    mod.promises = {};
    for (const key of Object.keys(mod)) {
        if (key === 'readFile' || key === 'writeFile' || key === 'appendFile' ||
            key.endsWith('Sync') || key === 'constants' || key === 'Stats' ||
            key === 'Dirent' || key === 'promises' || key === 'createReadStream' ||
            key === 'createWriteStream') continue;
        const syncKey = key + 'Sync';
        if (mod[syncKey]) {
            mod.promises[key] = async function(...args) {
                return mod[syncKey](...args);
            };
        }
    }
    mod.promises.mkdir = async (p, o) => mkdirSync(p, o);
    mod.promises.mkdtemp = async (p, o) => mkdtempSync(p, o);
    mod.promises.readdir = async (p, o) => readdirSync(p, o);
    mod.promises.stat = async (p, o) => statSync(p, o);
    mod.promises.lstat = async (p, o) => lstatSync(p, o);
    mod.promises.access = async (p, m) => accessSync(p, m);
    mod.promises.unlink = async (p) => unlinkSync(p);
    mod.promises.rmdir = async (p, o) => rmdirSync(p, o);
    mod.promises.rename = async (o, n) => renameSync(o, n);
    mod.promises.copyFile = async (s, d, m) => copyFileSync(s, d, m);
    mod.promises.symlink = async (t, p) => symlinkSync(t, p);
    mod.promises.readlink = async (p) => readlinkSync(p);
    mod.promises.realpath = async (p) => realpathSync(p);
    mod.promises.chmod = async (p, m) => chmodSync(p, m);
    mod.promises.chown = async (p, u, g) => chownSync(p, u, g);
    mod.promises.utimes = async (p, a, m) => utimesSync(p, a, m);
    mod.promises.fstat = async (fd) => fstatSync(fd);
    mod.promises.fchmod = async (fd, m) => fchmodSync(fd, m);
    mod.promises.fchown = async (fd, u, g) => fchownSync(fd, u, g);
    mod.promises.futimes = async (fd, a, m) => futimesSync(fd, a, m);
    mod.promises.constants = constants;
    // Throwing stubs: link-time completeness for the Claude Code import
    // surface without a real implementation. See docs/posix-status.md.
    mod.promises.link = _notImpl('fs/promises', 'link');
    mod.promises.lutimes = _notImpl('fs/promises', 'lutimes');
    mod.promises.statfs = _notImpl('fs/promises', 'statfs');

    return mod;
})();

// ============================================================
// os module (Node.js)
// ============================================================

// One environment-owned native binding supplies every OS errno/priority/dlopen
// and crypto constant consumer. FS and signals retain their real existing bags.
const _nodeConstantResult = _nodeNative.operatingSystem('constants', fs.constants, _nodeNative.signalOperation('constants'));
if (_nodeConstantResult.error !== 0) throw new Error('Native constants initialization failed: ' + _nodeConstantResult.error);
const _nodeConstantBinding = _nodeConstantResult.value;
const nodeOs = { constants: _nodeConstantBinding.os };

// ============================================================
// util module
// ============================================================

let _nodeInspectionPathToFileURL;
const _nodeInspection = _createNodeInspection({
    native: _nodeNative, Buffer,
    isBuiltin: name => _nodeBuiltinPolicy.isBuiltin(name),
    getURL: () => _nodeWebPlatform.URL,
    pathToFileURL: path => _nodeInspectionPathToFileURL(path),
});
const util = (() => {
    'use strict';
    const { inspect, format, formatWithOptions } = _nodeInspection;

    // Adapted from the pinned lib/util.js. The Node copyright/permission
    // notice is retained with the EventEmitter implementation above.
    const utilApply = Reflect.apply;
    const utilDefine = Object.defineProperty;
    const utilDefineProperties = Object.defineProperties;
    const utilDescriptors = Object.getOwnPropertyDescriptors;
    const utilSetPrototype = Object.setPrototypeOf;
    const utilValues = Object.values;
    const utilPop = Function.prototype.call.bind(Array.prototype.pop);
    const utilBind = Function.prototype.call.bind(Function.prototype.bind);
    const utilToWellFormed = Function.prototype.call.bind(String.prototype.toWellFormed);
    const UtilTypeError = TypeError, UtilError = Error;
    function invalidUtilityArgument(name, expected, value) {
        // Full shared Node error formatting remains a separate foundation.
        const received = value === null ? 'null' : typeof value === 'undefined'
            ? 'undefined' : 'type ' + typeof value + ' (' + inspect(value) + ')';
        const error = new UtilTypeError('The "' + name + '" argument must be of type ' +
            expected + '. Received ' + received);
        error.code = 'ERR_INVALID_ARG_TYPE';
        return error;
    }
    function validateUtilityFunction(value, name) {
        if (typeof value !== 'function') throw invalidUtilityArgument(name, 'function', value);
    }
    function inherits(ctor, superCtor) {
        if (ctor === undefined || ctor === null) throw invalidUtilityArgument('ctor', 'function', ctor);
        if (superCtor === undefined || superCtor === null) throw invalidUtilityArgument('superCtor', 'function', superCtor);
        if (superCtor.prototype === undefined) {
            throw invalidUtilityArgument('superCtor.prototype', 'Object', superCtor.prototype);
        }
        // Legacy util.inherits sets the instance chain and super_, while
        // leaving the constructor's static chain exactly as the caller set it.
        utilDefine(ctor, 'super_', {
            __proto__: null, value: superCtor, writable: true, configurable: true,
        });
        utilSetPrototype(ctor.prototype, superCtor.prototype);
    }

    function deprecate(fn, msg) {
        let warned = false;
        return function(...args) {
            if (!warned) {
                console.error(`DeprecationWarning: ${msg}`);
                warned = true;
            }
            return fn.apply(this, args);
        };
    }

    function callbackifyOnRejected(reason, cb) {
        // A falsy rejection must remain distinguishable from callback success.
        if (!reason) {
            const error = new UtilError('Promise was rejected with falsy value');
            error.code = 'ERR_FALSY_VALUE_REJECTION';
            error.reason = reason;
            reason = error;
        }
        return cb(reason);
    }
    function callbackify(original) {
        validateUtilityFunction(original, 'original');
        function callbackified(...args) {
            const maybeCb = utilPop(args);
            validateUtilityFunction(maybeCb, 'last argument');
            const cb = utilBind(maybeCb, this);
            // nextTick owns callback delivery: a throwing callback must reach
            // process exception policy rather than reject a discarded promise.
            utilApply(original, this, args).then(
                result => process.nextTick(cb, null, result),
                reason => process.nextTick(callbackifyOnRejected, reason, cb)
            );
        }
        const descriptors = utilDescriptors(original);
        if (typeof descriptors.length.value === 'number') descriptors.length.value++;
        if (typeof descriptors.name.value === 'string') descriptors.name.value += 'Callbackified';
        for (const descriptor of utilValues(descriptors)) utilSetPrototype(descriptor, null);
        utilDefineProperties(callbackified, descriptors);
        return callbackified;
    }

    function isDeepStrictEqual(...args) {
        return _nodeCore.comparisons.isDeepStrictEqual(...args);
    }

    const types = _createNodeCoreTypes(_nodeNative);

    // util.debuglog(set) — Node returns a stderr logger gated on the
    // NODE_DEBUG env var. undici/diagnostics calls this at module init and
    // also reads `.enabled` to short-circuit format work. We honour the env
    // var so users can opt in for debugging.
    function debuglog(set, callback) {
        const env = (process.env && process.env.NODE_DEBUG) || '';
        const enabled = env.split(/[\s,]+/).filter(Boolean).some((tok) => {
            if (tok === set) return true;
            // Wildcard match (Node supports e.g. NODE_DEBUG=undici*).
            if (tok.endsWith('*')) return set.startsWith(tok.slice(0, -1));
            return false;
        });
        const log = enabled
            ? (...args) => process.stderr.write(
                `${set.toUpperCase()} ${process.pid}: ${format(...args)}\n`)
            : () => {};
        Object.defineProperty(log, 'enabled', { value: enabled, enumerable: true });
        if (typeof callback === 'function') callback(log);
        return log;
    }

    const _callSiteIntrinsics = {
        TypeError, RangeError, Error, isInteger: Number.isInteger, isArray: Array.isArray,
    };
    function getCallSites(frameCount = 10, options) {
        function invalid(name, expected) {
            const error = new _callSiteIntrinsics.TypeError(`The "${name}" argument must be ${expected}`);
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
        }
        function validateOptions(value) {
            if (value === null || typeof value !== 'object' || _callSiteIntrinsics.isArray(value)) {
                invalid('options', 'an object');
            }
            if (value.sourceMap !== undefined && typeof value.sourceMap !== 'boolean') {
                invalid('options.sourceMap', 'a boolean');
            }
        }
        if (options === undefined) {
            if (typeof frameCount === 'object') {
                options = frameCount;
                validateOptions(options);
                frameCount = 10;
            } else options = {};
        } else validateOptions(options);
        if (typeof frameCount !== 'number') invalid('frameCount', 'a number');
        if (!_callSiteIntrinsics.isInteger(frameCount) || frameCount < 1 || frameCount > 200) {
            const error = new _callSiteIntrinsics.RangeError('The "frameCount" argument must be an integer between 1 and 200');
            error.code = 'ERR_OUT_OF_RANGE';
            throw error;
        }
        if (options.sourceMap === true) {
            const error = new _callSiteIntrinsics.Error('Source-map call sites are not implemented');
            error.code = 'ERR_NOT_IMPLEMENTED';
            throw error;
        }
        return _nodeNative.captureCallSites(frameCount);
    }

    return {
        format, formatWithOptions, inspect, inherits, deprecate, promisify: undefined, callbackify,
        isDeepStrictEqual,
        isPartialDeepStrictEqual: (a, b) => _nodeCore.comparisons.isPartialStrictEqual(a, b),
        toUSVString: input => utilToWellFormed(`${input}`),
        types,
        debuglog, debug: debuglog, getCallSites,
        TextDecoder, TextEncoder,
    };
})();

util.stripVTControlCharacters = _nodeInspection.stripVTControlCharacters;
const _nodeUv = _createNodeUvPlatform({ native: _nodeNative });
util.getSystemErrorName = _nodeUv.getSystemErrorName;
util.getSystemErrorMessage = _nodeUv.getSystemErrorMessage;
util.getSystemErrorMap = _nodeUv.getSystemErrorMap;

// ============================================================
// assert module
// ============================================================

// Core comparison brands must use the same URL constructor as the public
// module. Initialize the shared Web platform before either consumer loads.
const _nodeWebPlatform = _createNodeWebPlatform();
const _nodeCore = _createNodeCore({
    process, getValues: () => _nodeValues,
    Buffer, inspect: util.inspect, format: util.format,
    URL: _nodeWebPlatform.URL,
    isPromise: _nodeNative.isPromise,
    isNativeError: _nodeNative.isNativeError,
    isProxy: _nodeNative.isProxy,
    isKeyObject: _nodeNative.isKeyObject,
    isCryptoKey: _nodeNative.isCryptoKey,
    getCryptoKeys: () => _nodeCryptoKeys,
    hasObjectKind: _nodeNative.hasObjectKind,
});
Object.assign(util.types, _nodeCore.types);
_nodeValues = _createNodeValuesPlatform({
    process, Buffer, util, inspection: _nodeInspection, os: nodeOs, uv: _nodeUv,
    signals: nodeOs.constants.signals,
    getWarnings: () => _nodeWarnings,
    getDOMException: () => _nodeEventPlatform.dom.DOMException,
});
_nodeWarnings = _createNodeWarningPlatform({
    process, values: _nodeValues, fs, path, cliOptions: _nodeNative.cliOptions || {},
    getConsole: () => _nodeConsolePlatform.api,
});
_nodeWarnings.install();
// OS accounting currently returns placeholder getrusage data. Keep that
// owner gap explicit; do not reinterpret elapsed time or host-wide totals.
if (_nodeNative.workerEnvironment) {
    process.umask = _nodeProcessState.createUmask(false);
    process.abort = _nodeProcessState.createAbort(false);
}
Object.assign(process, _createNodeProcessUsage({
    process, values: _nodeValues, binding: _createNodeUnavailableProcessUsage(_nodeValues),
}));
_installNodeProcessLifetime({ process, values: _nodeValues });
util.promisify = _nodeValues.util.promisify;
Object.assign(util, _createNodePublicUtil({ values: _nodeValues, native: _nodeNative, util }));
_nodeBufferConstructor.initialize({ process, values: _nodeValues });
_installNodeBufferNumeric({ Buffer, values: _nodeValues });
const _nodeBufferAllocator = _installNodeBufferUnpooled({ Buffer, FastBuffer: _FastBuffer, values: _nodeValues, native: _nodeNative,
    kMaxLength: _nodeBufferModule.constants.MAX_LENGTH });
const _nodeBufferPool = _createNodeBufferPool({ Buffer, FastBuffer: _FastBuffer,
    values: _nodeValues, allocator: _nodeBufferAllocator, native: _nodeNative,
    kMaxLength: _nodeBufferModule.constants.MAX_LENGTH, getCodecs: () => _nodeBufferCodecs });
const _nodeBufferCodecs = _installNodeBufferCodecs({ Buffer, FastBuffer: _FastBuffer, pool: _nodeBufferPool, values: _nodeValues, allocator: _nodeBufferAllocator,
    kMaxLength: _nodeBufferModule.constants.MAX_LENGTH,
    kStringMaxLength: _nodeBufferModule.constants.MAX_STRING_LENGTH });
_nodeBufferModule.isLatin1 = _nodeBufferCodecs.isLatin1;
_installNodeBufferBytes({ Buffer, FastBuffer: _FastBuffer, pool: _nodeBufferPool, values: _nodeValues,
    codecs: _nodeBufferCodecs,
    kMaxLength: _nodeBufferModule.constants.MAX_LENGTH });
_nodeFsSystemErrors = _createNodeFsSystemErrors({ uv: _nodeUv, codecs: _nodeBufferCodecs });
const _nodeOSPlatform = _createNodeOSPlatform({
    process, values: _nodeValues, codecs: _nodeBufferCodecs, uv: _nodeUv, native: _nodeNative,
    constants: nodeOs.constants,
});
_nodeOSPlatform.install(nodeOs);
const _nodeClonePlatform = _createNodeClonePlatform({
    native: _nodeNative, values: _nodeValues,
    getDOMException: () => _nodeEventPlatform.dom.DOMException,
    getWebIDL: () => _nodeEventPlatform.require('internal/webidl'),
    getModule: name => name === 'internal/histogram' ? _nodeHistogram :
        name === 'internal/blob' ? _nodeBodyData :
        name === 'internal/file' ? _nodeFilePlatform :
        name === 'internal/blocklist' || name === 'internal/socketaddress' ? _nodeAddressRules.require(name) :
        _nodeStreamPlatform.require(name),
});
const _nodeDebug = _nodeValues.require('internal/util/debuglog');
_nodeDebug.initializeDebugEnv(process.env.NODE_DEBUG);
util.debug = util.debuglog = _nodeDebug.debuglog;
const _nodeAsyncPlatform = _createNodeAsyncPlatform({ native: _nodeNative, process, inspection: _nodeInspection, values: _nodeValues });
const _nodeProcessSignals = _createNodeProcessSignals({ process, values: _nodeValues, native: _nodeNative, signals: nodeOs.constants.signals });
const _nodeDiagnostics = _createNodeDiagnosticsPlatform({ process, values: _nodeValues, types: util.types });
const _nodeFsTruncation = _createNodeFsTruncation({
    fs, Buffer, process, native: _nodeNative, values: _nodeValues, throwErrno: _throwErrno,
    runInternalImmediate: _nodeAsyncPlatform.runInternalImmediate,
});
for (const name of ['truncate', 'truncateSync', 'ftruncate', 'ftruncateSync', 'close', 'closeSync']) fs[name] = _nodeFsTruncation[name];
const _nodeFsStats = _createNodeFsStats({
    fs, process, Buffer, types: util.types, values: _nodeValues,
    throwErrno: _throwErrno, native: _nodeNative, truncation: _nodeFsTruncation,
    toPathIfFileURL: value => _nodeURLPathPlatform.toPathIfFileURL(value),
    permissionEnabled: () => false,
});
const _nodeFileSync = _createNodeFileSync({
    fs, Buffer, values: _nodeValues, types: util.types, utils: _nodeFsStats,
    native: _nodeNative, truncation: _nodeFsTruncation,
    codecs: _nodeBufferCodecs, allocator: _nodeBufferAllocator,
});
fs.Stats = _nodeFsStats.publicStats;
fs.readvSync = _nodeFsStats.readvSync;
const _nodeFileJobs = _createNodeFileJobs({ Buffer, native: _nodeNative, truncation: _nodeFsTruncation });
const _nodeFsCallbacks = _createNodeFsCallbacks({
    fs, Buffer, process, native: _nodeNative, values: _nodeValues, types: util.types,
    utils: _nodeFsStats, fileJobs: _nodeFileJobs, truncation: _nodeFsTruncation, permissionEnabled: () => false,
    require: name => name === 'internal/event_target' ? _nodeEventPlatform.eventTarget : _nodeStreamPlatform.require(name),
});
Object.assign(fs, _nodeFsCallbacks);
const _nodeStatWatchers = _createNodeStatWatcherPlatform({
    process, path, events, values: _nodeValues, utils: _nodeFsStats,
    async: _nodeAsyncPlatform, truncation: _nodeFsTruncation, native: _nodeNative,
});
fs.watchFile = _nodeStatWatchers.watchFile;
fs.unwatchFile = _nodeStatWatchers.unwatchFile;
const _nodeDirectoryPlatform = _createNodeDirectoryPlatform({
    native: _nodeNative, values: _nodeValues, utils: _nodeFsStats, truncation: _nodeFsTruncation,
});
Object.assign(fs, _nodeDirectoryPlatform.api);
Object.assign(fs.promises, _nodeDirectoryPlatform.promises);
const _nodePathMetadata = _createNodePathMetadata({
    native: _nodeNative, values: _nodeValues, utils: _nodeFsStats,
    truncation: _nodeFsTruncation, constants: fs.constants,
});
Object.assign(fs, _nodePathMetadata.api);
Object.assign(fs.promises, _nodePathMetadata.promises);
const _nodeCopyFile = _createNodeCopyFile({
    native: _nodeNative, values: _nodeValues, utils: _nodeFsStats,
    truncation: _nodeFsTruncation,
});
Object.assign(fs, _nodeCopyFile.api);
Object.assign(fs.promises, _nodeCopyFile.promises);
const _nodeReaddirPlatform = _createNodeReaddirPlatform({
    fs, Buffer, process, path, values: _nodeValues, types: util.types,
    utils: _nodeFsStats, truncation: _nodeFsTruncation, native: _nodeNative,
    codecs: _nodeBufferCodecs, promisify: util.promisify, permissionEnabled: () => false,
    internalModuleStat(path) {
        const value = _nodeNative.fsStatSync(path, true, false);
        if (typeof value === 'number') return value;
        return (value[1] & fs.constants.S_IFMT) === fs.constants.S_IFDIR ? 1 : 0;
    },
});
Object.assign(fs, _nodeReaddirPlatform.api);
Object.assign(fs.promises, _nodeReaddirPlatform.promises);
const _nodeDirPlatform = _createNodeDirPlatform({
    native: _nodeNative, values: _nodeValues, utils: _nodeFsStats,
    truncation: _nodeFsTruncation, dirents: _nodeReaddirPlatform.utilities,
    Buffer, process, path, codecs: _nodeBufferCodecs,
});
Object.assign(fs, _nodeDirPlatform.api);
Object.assign(fs.promises, _nodeDirPlatform.promises);
const _nodeCopyDirectory = _createNodeCopyDirectoryPlatform({
    fs, path, process, util, types: util.types, values: _nodeValues, utils: _nodeFsStats,
    native: _nodeNative, constants: { os: { errno: nodeOs.constants.errno } },
    getAssert: () => _nodeCore.require('internal/assert'),
    // The current CLI rejects enabled permission-model activation.
    permission: { isEnabled: () => false },
    internalModuleStat(path) {
        const result = _nodeNative.fsStatSync(path, true, false);
        if (typeof result === 'number') return result;
        return (result[1] & fs.constants.S_IFMT) === fs.constants.S_IFDIR ? 1 : 0;
    },
});
Object.assign(fs, _nodeCopyDirectory.api);
Object.assign(fs.promises, _nodeCopyDirectory.promises);
const _nodeRealpathPlatform = _createNodeRealpathPlatform({
    native: _nodeNative, values: _nodeValues, fs, path, process, Buffer,
    utils: _nodeFsStats, truncation: _nodeFsTruncation, codecs: _nodeBufferCodecs,
    toPathIfFileURL: value => _nodeURLPathPlatform.toPathIfFileURL(value),
    // The current guest CLI rejects permission-model activation. Keep ordinary
    // filesystem behavior; enabled public permission policy remains separate.
    permission: { isEnabled: () => false },
});
Object.assign(fs, _nodeRealpathPlatform.api);
Object.assign(fs.promises, _nodeRealpathPlatform.promises);
const _nodeGlobPlatform = _createNodeGlobPlatform({
    fs, path, process, values: _nodeValues, dirents: _nodeReaddirPlatform.utilities,
    toPathIfFileURL: value => _nodeURLPathPlatform.toPathIfFileURL(value),
});
Object.assign(fs, _nodeGlobPlatform.api);
Object.assign(fs.promises, _nodeGlobPlatform.promises);

process.loadEnvFile = _createNodeDotenvPlatform({
    native: _nodeNative, values: _nodeValues, uv: _nodeUv, utils: _nodeFsStats,
}).loadEnvFile;
Object.defineProperty(events, 'EventEmitterAsyncResource', {
    enumerable: true, configurable: true,
    get: _createNodeEventEmitterAsyncResourceGetter(events, _nodeAsyncPlatform),
    set: undefined,
});
Object.defineProperties(globalThis, {
    __kandeloRunNextTicks: { value: _nodeAsyncPlatform.drainTicks },
    __kandeloHasNextTicks: { value: _nodeAsyncPlatform.hasTicks },
    __kandeloRunAsyncDestroys: { value: _nodeAsyncPlatform.drainDestroys },
    __kandeloRunFsGcCloseError: { value: _nodeFsTruncation.runGcCloseError },
});
globalThis.queueMicrotask = function queueMicrotask(callback) {
    if (typeof callback !== 'function') {
        const error = new TypeError('The "callback" argument must be of type function');
        error.code = 'ERR_INVALID_ARG_TYPE'; throw error;
    }
    _nodeNative.enqueueMicrotask(callback);
};

// ============================================================
// string_decoder module
// ============================================================

const string_decoder = _createNodeStringDecoder({
    Buffer, values: _nodeValues, codecs: _nodeBufferCodecs,
    kStringMaxLength: _nodeBufferConstants.MAX_STRING_LENGTH,
});

// ============================================================
// timers module
// ============================================================

let _nodeTimerInternals;
const timers = (() => {
    const { MathTrunc } = _createNodePrimordials();
    const refed = Symbol('refed'), token = Symbol('timer'), id = Symbol('timerId');
    const known = new Map();
    let nextId = 1, warnedNegative = false, warnedNaN = false;
    function invalid(name, expected) {
        const error = new TypeError('The "' + name + '" argument must be of type ' + expected);
        error.code = 'ERR_INVALID_ARG_TYPE'; return error;
    }
    function validateCallback(callback) {
        if (typeof callback !== 'function') throw invalid('callback', 'function');
    }
    function duration(after) {
        if (after === undefined) return 1;
        after *= 1;
        if (!(after >= 1 && after <= 2147483647)) {
            if (after > 2147483647) process.emitWarning(after + ' does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.', 'TimeoutOverflowWarning');
            else if (after < 0 && !warnedNegative) {
                warnedNegative = true;
                process.emitWarning(after + ' is a negative number.\nTimeout duration was set to 1.', 'TimeoutNegativeWarning');
            } else if (Number.isNaN(after) && !warnedNaN) {
                warnedNaN = true;
                process.emitWarning(after + ' is not a number.\nTimeout duration was set to 1.', 'TimeoutNaNWarning');
            }
            return 1;
        }
        return after;
    }
    function activate(timer, start = os.timerNow(), msecs = timer._idleTimeout) {
        if (timer._idleTimeout < 0 || !timer._onTimeout) return;
        os.clearTimeout(timer[token]);
        if (timer._destroyed) {
            known.delete(String(timer[id])); timer[id] = nextId++;
            timer._destroyed = false;
            _nodeAsyncPlatform.createTask(timer, 'Timeout');
            if (timer._destroyed || !timer._onTimeout) return;
        }
        timer._idleStart = start;
        timer[token] = os.setTimeout(() => {
            timer[token] = undefined;
            const entered = os.timerNow();
            try {
                if (timer._onTimeout) _nodeAsyncPlatform.runTask(
                    timer, timer._onTimeout, timer, timer._timerArgs || []);
            }
            finally {
                if (timer._repeat && timer._idleTimeout !== -1) {
                    timer._idleTimeout = timer._repeat; activate(timer, entered);
                } else if (timer[token] === undefined) {
                    timer._destroyed = true; known.delete(String(timer[id]));
                    _nodeAsyncPlatform.retireTask(timer);
                }
            }
        }, MathTrunc(msecs), !!timer[refed], start);
    }
    class Timeout {
        constructor(callback, after, args, repeat, isRefed) {
            this._idleTimeout = duration(after);
            this._onTimeout = callback; this._timerArgs = args;
            this._repeat = repeat ? this._idleTimeout : null;
            this._destroyed = false; this[refed] = isRefed; this[id] = nextId++;
            _nodeAsyncPlatform.createTask(this, 'Timeout');
        }
        refresh() { activate(this); return this; }
        unref() { if (this[refed]) { this[refed] = false; os.timerRef(this[token], false); } return this; }
        ref() { if (!this[refed]) { this[refed] = true; os.timerRef(this[token], true); } return this; }
        hasRef() { return this[refed]; }
        close() { clearTimeout(this); return this; }
        [Symbol.toPrimitive]() {
            if (!this._destroyed) known.set(String(this[id]), this);
            return this[id];
        }
        [Symbol.dispose]() { clearTimeout(this); }
    }
    function setTimeout(callback, after, ...args) {
        validateCallback(callback);
        const timeout = new Timeout(callback, after, args.length ? args : undefined, false, true);
        activate(timeout); return timeout;
    }
    function setInterval(callback, repeat, ...args) {
        validateCallback(callback);
        const timeout = new Timeout(callback, repeat, args.length ? args : undefined, true, true);
        activate(timeout); return timeout;
    }
    function clearTimeout(timer) {
        if (typeof timer === 'number' || typeof timer === 'string') timer = known.get(String(timer));
        if (!timer?._onTimeout) return;
        timer._onTimeout = undefined; timer._timerArgs = undefined;
        // A fired owner is already unenrolled. Clear its retained arguments
        // without changing the original delay or retiring the resource twice.
        if (timer._destroyed) return;
        timer._idleTimeout = -1; timer._destroyed = true;
        os.clearTimeout(timer[token]); timer[token] = undefined; known.delete(String(timer[id]));
        _nodeAsyncPlatform.retireTask(timer);
    }
    function clearInterval(timer) { clearTimeout(timer); }
    class Immediate {
        constructor(callback, args) {
            this._onImmediate = callback; this._argv = args;
            this._destroyed = false; this[refed] = true;
            _nodeAsyncPlatform.createTask(this, 'Immediate');
            if (this._destroyed) return;
            this[token] = os.setImmediate(() => {
                const fn = this._onImmediate;
                this._destroyed = true; this[refed] = null;
                this._onImmediate = null; this[token] = undefined;
                try { _nodeAsyncPlatform.runTask(this, fn, this, this._argv || []); }
                finally { this._argv = null; _nodeAsyncPlatform.retireTask(this); }
            });
        }
        ref() { if (this[refed] === false) { this[refed] = true; os.timerRef(this[token], true); } return this; }
        unref() { if (this[refed] === true) { this[refed] = false; os.timerRef(this[token], false); } return this; }
        hasRef() { return !!this[refed]; }
        [Symbol.dispose]() { clearImmediate(this); }
    }
    function setImmediate(callback, ...args) {
        validateCallback(callback); return new Immediate(callback, args.length ? args : undefined);
    }
    function clearImmediate(immediate) {
        if (!immediate?._onImmediate || immediate._destroyed) return;
        os.clearTimeout(immediate[token]); immediate[token] = undefined;
        immediate._destroyed = true; immediate[refed] = null;
        immediate._onImmediate = null; immediate._argv = null;
        _nodeAsyncPlatform.retireTask(immediate);
    }
    for (const key of ['close', Symbol.toPrimitive, Symbol.dispose]) Object.defineProperty(Timeout.prototype, key, { enumerable: true });
    Object.defineProperty(Immediate.prototype, Symbol.dispose, { enumerable: true });
    _nodeTimerInternals = { Timeout, Immediate,
        insert(timer, msecs) { activate(timer, os.timerNow(), msecs); } };
    const api = { setTimeout, clearTimeout, setImmediate, clearImmediate, setInterval, clearInterval };
    Object.defineProperty(api, 'promises', { enumerable: true, configurable: true, get() { return timersPromises; } });
    const custom = Symbol.for('nodejs.util.promisify.custom');
    Object.defineProperty(setTimeout, custom, { enumerable: true, get() { return timersPromises.setTimeout; } });
    Object.defineProperty(setImmediate, custom, { enumerable: true, get() { return timersPromises.setImmediate; } });
    return api;
})();

const _nodeRemovalPlatform = _createNodeRemovalPlatform({
    fs, Buffer, process, path, timers, values: _nodeValues, utils: _nodeFsStats,
    truncation: _nodeFsTruncation, directory: _nodeDirectoryPlatform, native: _nodeNative,
    errno: nodeOs.constants.errno, uv: _nodeUv,
});
Object.assign(fs, _nodeRemovalPlatform.api);
Object.assign(fs.promises, _nodeRemovalPlatform.promises);
const _nodeTempdirPlatform = _createNodeTempdirPlatform({
    process, path, values: _nodeValues, utils: _nodeFsStats, codecs: _nodeBufferCodecs,
    truncation: _nodeFsTruncation, native: _nodeNative, removal: _nodeRemovalPlatform,
});
Object.assign(fs, _nodeTempdirPlatform.api);
Object.assign(fs.promises, _nodeTempdirPlatform.promises);


_installNodeProcessExceptions({ process, values: _nodeValues,
    async: _nodeAsyncPlatform, timers, native: _nodeNative });

const timersPromises = _createNodeTimersPromisesPlatform({
    internals: _nodeTimerInternals, timers, values: _nodeValues,
    getEventTarget: () => _nodeEventPlatform.require('internal/event_target'),
});

_nodeEventPlatform = _createNodeEventPlatform({
    native: _nodeNative, events, inspection: _nodeInspection, process, timers, values: _nodeValues, clone: _nodeClonePlatform,
    now: () => os.timerNow() - _nodeMonotonicStart,
    queueMicrotask: globalThis.queueMicrotask,
});
Object.assign(globalThis, {
    Event: _nodeEventPlatform.eventTarget.Event,
    EventTarget: _nodeEventPlatform.eventTarget.EventTarget,
    CustomEvent: _nodeEventPlatform.eventTarget.CustomEvent,
    AbortSignal: _nodeEventPlatform.abort.AbortSignal,
    AbortController: _nodeEventPlatform.abort.AbortController,
    DOMException: _nodeEventPlatform.dom.DOMException,
    QuotaExceededError: _nodeEventPlatform.dom.QuotaExceededError,
});
// Util call-control captures the real abort helper after its owner exists.
const _nodeUtilClockFloor = _createNodePrimordials().MathFloor;
const _nodeUtilTimerBase = _nodeUtilClockFloor(_nodeMonotonicStart);
const _nodeUtilAlgorithms = _installNodeUtilAlgorithms({
    util, values: _nodeValues, process, timers,
    defineNativeLazyDataProperty: _nodeNative.defineNativeLazyDataProperty,
    addAbortListener: _nodeEventPlatform.addAbortListener,
    markPromiseAsHandled: value => _nodeNative.markPromiseAsHandled(value),
    getLibuvNow: () => _nodeUtilClockFloor(os.timerNow()) - _nodeUtilTimerBase,
    getOptionValue(name) {
        if (name === '--eval' && typeof _nodeParsedEvalSource === 'string') return _nodeParsedEvalSource;
        throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Node util option ' + name);
    },
});


for (const name of ['aborted', 'transferableAbortSignal', 'transferableAbortController']) {
    Object.defineProperty(util, name, {
        enumerable: true, configurable: true, get: () => _nodeEventPlatform.abort[name],
    });
}
// Native endpoint constructors exist before streams. Pinned worker IO then
// installs its event prototypes after streams, preserving one identity.
const _nodePortsPlatform = _createNodePortsPlatform({
    native: _nodeNative, values: _nodeValues, process, clone: _nodeClonePlatform,
    eventTarget: _nodeEventPlatform.eventTarget, DOMException: _nodeEventPlatform.dom.DOMException,
    inspection: _nodeInspection, AsyncResource: _nodeAsyncPlatform.api.AsyncResource,
    markUncloneable: value => _nodeClonePlatform.protocol.markTransferMode(value, false, false),
    getMessageEvents: () => _nodeFormDataPlatform.messageEvents,
});
globalThis.__kandeloDispatchPorts = _nodePortsPlatform.dispatch;
// ============================================================
// stream modules: pinned Node state machines
// ============================================================

const _nodeCompressionConstants = _nodeNative.getCompressionConstants();
const _nodeFileHandles = _createNodeFileHandlePlatform({
    fs, process, Buffer, events, path, types: util.types, values: _nodeValues, clone: _nodeClonePlatform,
    native: _nodeNative, truncation: _nodeFsTruncation, utils: _nodeFsStats, fileJobs: _nodeFileJobs,
    getStringDecoder: string_decoder.StringDecoder,
    permissionEnabled: () => false,
    require: name => _nodeStreamPlatform.require(name),
});
fs.promises.open = _nodeFileHandles.open;
fs.promises.truncate = _nodeFileHandles.truncate;
fs.promises.readFile = _nodeFileHandles.readFile;
fs.promises.stat = _nodeFileHandles.stat;
fs.promises.lstat = _nodeFileHandles.lstat;
fs.promises.writeFile = _nodeFileHandles.writeFile;
fs.promises.appendFile = _nodeFileHandles.appendFile;
const _nodeStreamPlatform = _createNodeStreamPlatform({
    process, events, Buffer, FastBuffer: _FastBuffer, stringDecoder: string_decoder, util, ports: _nodePortsPlatform,
    buffer: _nodeBufferModule, fs, fileHandles: _nodeFileHandles, fsUtils: _nodeFsStats,
    toPathIfFileURL: value => _nodeURLPathPlatform.toPathIfFileURL(value),
    values: _nodeValues, async: _nodeAsyncPlatform, event: _nodeEventPlatform,
    clone: _nodeClonePlatform, native: _nodeNative,
    experimentalStreamIter: _nodeNative.cliOptions?.experimentalStreamIter === true,
    compressionConstants: _nodeCompressionConstants,
    TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
    queueMicrotask: globalThis.queueMicrotask, webState: _nodeWebPlatform.streamState,
    getBodyData: () => _nodeBodyData,
});
const stream = _nodeStreamPlatform.api;
// Shared stream state also carries reads from actual captured TTY owners.
const _nodeSocketStream = _createNodeSocketStream({
    Buffer, FastBuffer: _FastBuffer, async: _nodeAsyncPlatform,
    values: _nodeValues, types: util.types, native: _nodeNative, stream, uv: _nodeUv,
    markResource: receiver => _nodeClonePlatform.setMode(receiver, 0),
});

const _nodePortIO = _nodePortsPlatform.initialize(stream);
const _nodeTerminalPlatform = _createNodeTerminalPlatform({
    streamBinding: _nodeSocketStream.binding,
    native: _nodeNative, values: _nodeValues, uv: _nodeUv,
    isTTY: fd => os.isatty(fd), getReadline: () => _nodeReadlinePlatform.api,
});
const _nodeFdStreamPlatform = _createNodeFdStreamPlatform({
    stream, Buffer, FastBuffer: _FastBuffer, process, native: _nodeNative,
    openTerminalOutput: _nodeTerminalPlatform.openOutput,
    openTerminalInput: _nodeTerminalPlatform.openInput,
});
// Signal hooks, captured terminal output and shared streams are initialized
// before diagnostics first requests stderr. Worker stdio remains separate.
_nodeStdioOutputPlatform = _createNodeStdioOutputPlatform({
    process, fdStreams: _nodeFdStreamPlatform, terminal: _nodeTerminalPlatform,
    signals: _nodeProcessSignals, mainEnvironment: _nodeNative.workerEnvironment === null,
});
// Public styling consumes actual classic/Web predicates and the shared guest
// inspection, byte, stdio and color-policy owners; no host capability shim.
_installNodeUtilStyle({ util, process, Buffer, values: _nodeValues,
    streamUtils: _nodeStreamPlatform.require('internal/streams/utils') });
// Assertion diagnostics load the shared color module, which observes the real
// stderr stream immediately. Its FD owner must exist before that module loads.
const assert = _nodeCore.assert;
_nodeReadlinePlatform = _createNodeReadlinePlatform({
    process, values: _nodeValues, isTTY: fd => os.isatty(fd),
    streamUtils: _nodeStreamPlatform.require('internal/streams/utils'),
    events, stringDecoder: string_decoder, inspection: _nodeInspection,
    requireEvent: name => _nodeEventPlatform.require(name),
    path, fs, os: nodeOs, timers,
    // Persistent REPL history still needs the actual Node permission-policy
    // owner. Do not infer enabled policy from a mutable public process field.
    permission: { isEnabled() {
        throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Node permission policy for persistent REPL history');
    } },
});
const _nodeTracingOwner = _createNodeTracingOwner({ native: _nodeNative, values: _nodeValues, uv: _nodeUv });
const _nodeConsolePlatform = _createNodeConsolePlatform({
    tracing: _nodeTracingOwner, ownsProcessState: !_nodeNative.workerEnvironment,
    process, values: _nodeValues, inspection: _nodeInspection, Buffer,
    types: util.types, diagnostics: _nodeDiagnostics, readline: _nodeReadlinePlatform,
    previewEntries: (value, pairs) => _nodeNative.previewEntries(value, pairs),
    monotonicNanoseconds: () => _nodeNative.hrtime(),
});
_nodeConsolePlatform.install(globalThis);
_installNodeFileStreams({ fs, truncation: _nodeFsTruncation,
    require: name => _nodeStreamPlatform.require(name) });
_nodeWebPlatform.streams = _nodeStreamPlatform.web;
_nodeWebPlatform.streamState = _nodeStreamPlatform.webState;
_nodeClonePlatform.protocol.setup();
globalThis.structuredClone = _nodeClonePlatform.protocol.structuredClone;

// ============================================================
// url module
// ============================================================

const _nodeDomainHelpers = _createNodeDomainHelpers({ values: _nodeValues, web: _nodeWebPlatform });
const _nodeURLPathPlatform = _createNodeURLPathPlatform({
    process, path, Buffer, web: _nodeWebPlatform, values: _nodeValues,
    domainToUnicode: _nodeDomainHelpers.domainToUnicode,
});

const url = (() => {
    function parse(urlStr, parseQueryString) {
        // `new URL(URL_instance)` is valid in WHATWG; coerce to string so the
        // regex-based scanner doesn't throw "match is not a function".
        if (typeof urlStr !== 'string') urlStr = String(urlStr);
        // Simple URL parser
        const result = {
            protocol: null, slashes: false, auth: null, host: null,
            port: null, hostname: null, hash: null, search: null,
            query: null, pathname: null, path: null, href: urlStr,
        };

        let rest = urlStr;
        // Protocol
        const protoMatch = rest.match(/^([a-z][a-z0-9+.-]*):/i);
        if (protoMatch) {
            result.protocol = protoMatch[1].toLowerCase() + ':';
            rest = rest.slice(protoMatch[0].length);
            if (rest.startsWith('//')) {
                result.slashes = true;
                rest = rest.slice(2);
            }
        }

        // Hash
        const hashIdx = rest.indexOf('#');
        if (hashIdx !== -1) {
            result.hash = rest.slice(hashIdx);
            rest = rest.slice(0, hashIdx);
        }

        // Search
        const searchIdx = rest.indexOf('?');
        if (searchIdx !== -1) {
            result.search = rest.slice(searchIdx);
            result.query = result.search.slice(1);
            rest = rest.slice(0, searchIdx);
        }

        if (result.slashes) {
            // Split authority from pathname before scanning for '@' so that
            // a registry URL like `https://reg.example.org/@scope/foo` does
            // not treat the path's '@' as a userinfo delimiter.
            const slashIdx = rest.indexOf('/');
            let authority;
            if (slashIdx !== -1) {
                authority = rest.slice(0, slashIdx);
                result.pathname = rest.slice(slashIdx);
            } else {
                authority = rest;
                result.pathname = '/';
            }
            const atIdx = authority.lastIndexOf('@');
            if (atIdx !== -1) {
                result.auth = authority.slice(0, atIdx);
                authority = authority.slice(atIdx + 1);
            }
            result.host = authority;
            // Port
            const colonIdx = result.host.lastIndexOf(':');
            if (colonIdx !== -1) {
                result.port = result.host.slice(colonIdx + 1);
                result.hostname = result.host.slice(0, colonIdx);
            } else {
                result.hostname = result.host;
            }
        } else {
            result.pathname = rest;
        }

        result.path = result.pathname + (result.search || '');

        if (parseQueryString && result.query) {
            result.query = querystring.parse(result.query);
        }

        return result;
    }

    function format(urlObj, options) {
        if (urlObj instanceof URLClass) {
            if (options && (typeof options !== 'object' || Array.isArray(options))) {
                const error = new TypeError('The options argument must be an object');
                error.code = 'ERR_INVALID_ARG_TYPE';
                throw error;
            }
            // Work on a copy: formatting must not mutate the input URL or its
            // live searchParams. Preserve default serialization, including
            // opaque paths and empty query/fragment delimiters.
            const copy = new URLClass(urlObj.href);
            if (options) {
                if (options.auth != null && !options.auth) { copy.username = ''; copy.password = ''; }
                if (options.fragment != null && !options.fragment) copy.hash = '';
                if (options.search != null && !options.search) copy.search = '';
                if (options.unicode) {
                    const hostname = copy.hostname;
                    if (hostname && !hostname.startsWith('[')) {
                        const decoded = _nodeWebPlatform.domainToUnicode(hostname);
                        const href = copy.href;
                        const authorityStart = href.indexOf('//') + 2;
                        const hostStart = authorityStart + (copy.username || copy.password
                            ? (copy.username + (copy.password ? ':' + copy.password : '') + '@').length : 0);
                        return href.slice(0, hostStart) + decoded.domain + href.slice(hostStart + hostname.length);
                    }
                }
            }
            return copy.href;
        }
        if (typeof urlObj === 'string') urlObj = parse(urlObj);
        if (!urlObj || typeof urlObj !== 'object') {
            const error = new TypeError('The urlObject argument must be an object or string');
            error.code = 'ERR_INVALID_ARG_TYPE';
            throw error;
        }
        let result = '';
        if (urlObj.protocol) result += urlObj.protocol + '//';
        if (urlObj.auth) result += urlObj.auth + '@';
        if (urlObj.hostname) result += urlObj.hostname;
        if (urlObj.port) result += ':' + urlObj.port;
        result += urlObj.pathname || '/';
        if (urlObj.search) result += urlObj.search;
        if (urlObj.hash) result += urlObj.hash;
        return result;
    }

    function resolve(from, to) {
        const base = parse(from);
        const rel = parse(to);
        if (rel.protocol) return to;
        const result = { ...base };
        if (rel.pathname) {
            if (rel.pathname.startsWith('/')) {
                result.pathname = rel.pathname;
            } else {
                const dir = base.pathname ? base.pathname.replace(/\/[^/]*$/, '/') : '/';
                result.pathname = path.normalize(dir + rel.pathname);
            }
        }
        result.search = rel.search;
        result.hash = rel.hash;
        return format(result);
    }

    // Share a standards parser instead of maintaining a second partial URL
    // state machine here. In particular, query mutation must update href and
    // canParse must reject the same invalid input as the constructor.
    const { URL: URLClass, URLSearchParams: SearchParamsClass } = _nodeWebPlatform;
    return {
        parse, format, resolve,
        URL: URLClass,
        URLSearchParams: SearchParamsClass,
        fileURLToPath: _nodeURLPathPlatform.fileURLToPath,
        fileURLToPathBuffer: _nodeURLPathPlatform.fileURLToPathBuffer,
        pathToFileURL: _nodeURLPathPlatform.pathToFileURL,
        urlToHttpOptions: _nodeURLPathPlatform.urlToHttpOptions,
    };
})();

url.domainToASCII = _nodeDomainHelpers.domainToASCII;
url.domainToUnicode = _nodeDomainHelpers.domainToUnicode;

// ============================================================
// querystring module
// ============================================================

const _nodeQueryCodecs = _createNodeQueryCodecsPlatform({
    Buffer, values: _nodeValues, process,
    isInsideNodeModules: _nodeNative.isInsideNodeModules,
});
const querystring = _nodeQueryCodecs.require('querystring');

// ============================================================
// child_process module
// ============================================================

const child_process = (() => {
    const _childPrimordials = _createNodePrimordials();
    function syncError(code, message, range = false) {
        const error = range ? new RangeError(message) : new TypeError(message);
        error.code = code; return error;
    }
    function syncString(value, name, nonempty = false) {
        if (typeof value !== 'string') throw syncError('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type string`);
        if (value.includes('\0') || (nonempty && !value.length)) throw syncError('ERR_INVALID_ARG_VALUE', `The "${name}" argument must be a nonempty string without null bytes`);
        return value;
    }
    function syncOptions(options) {
        if (options === undefined) return {};
        if (options === null || typeof options !== 'object' || Array.isArray(options)) throw syncError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object');
        return {...options};
    }
    function syncFailure(error, file, args) {
        const code = error.code || 'UNKNOWN';
        const result = new Error(`spawnSync ${file} ${code}`);
        result.code = code;
        result.errno = -Math.abs(error.errno || 0);
        result.syscall = 'spawnSync ' + file; result.path = file; result.spawnargs = args.slice(1);
        return result;
    }
    let emittedSyncShellWarning = false;
    function spawnSync(command, args, options) {
        syncString(command, 'file', true);
        if (Array.isArray(args)) args = args.slice();
        else if (args == null) args = [];
        else if (typeof args === 'object') { options = args; args = []; }
        else throw syncError('ERR_INVALID_ARG_TYPE', 'The "args" argument must be of type object');
        options = syncOptions(options);
        for (let i = 0; i < args.length; i++) {
            if (typeof args[i] === 'string' && args[i].includes('\0')) throw syncError('ERR_INVALID_ARG_VALUE', `args[${i}] must not contain null bytes`);
            args[i] = String(args[i]);
        }
        let cwd = options.cwd;
        if (cwd != null) {
            if (cwd instanceof URL) cwd = url.fileURLToPath(cwd);
            else if (Buffer.isBuffer(cwd)) cwd = cwd.toString();
            syncString(cwd, 'options.cwd');
        }
        for (const name of ['detached', 'windowsHide', 'windowsVerbatimArguments']) {
            if (options[name] != null && typeof options[name] !== 'boolean') throw syncError('ERR_INVALID_ARG_TYPE', `options.${name} must be a boolean`);
        }
        for (const name of ['uid', 'gid']) {
            if (options[name] != null && typeof options[name] !== 'number') throw syncError('ERR_INVALID_ARG_TYPE', `options.${name} must be a number`);
            if (options[name] != null && (!Number.isInteger(options[name]) || options[name] < -2147483648 || options[name] > 2147483647)) throw syncError('ERR_OUT_OF_RANGE', `options.${name} must be an int32`, true);
        }
        if (options.shell != null && typeof options.shell !== 'boolean' && typeof options.shell !== 'string') throw syncError('ERR_INVALID_ARG_TYPE', 'options.shell must be a boolean or string');
        if (typeof options.shell === 'string') syncString(options.shell, 'options.shell');
        if (options.argv0 != null) syncString(options.argv0, 'options.argv0');
        const timeout = options.timeout;
        if (timeout != null && typeof timeout !== 'number') throw syncError('ERR_INVALID_ARG_TYPE', 'timeout must be a number');
        if (timeout != null && (!Number.isSafeInteger(timeout) || timeout < 0)) throw syncError('ERR_OUT_OF_RANGE', 'timeout must be a nonnegative safe integer', true);
        const maxBuffer = options.maxBuffer === undefined ? 1024 * 1024 : options.maxBuffer;
        if (maxBuffer != null && typeof maxBuffer !== 'number') throw syncError('ERR_INVALID_ARG_TYPE', 'maxBuffer must be a number');
        if (maxBuffer != null && !(maxBuffer >= 0)) throw syncError('ERR_OUT_OF_RANGE', 'maxBuffer must be nonnegative', true);
        let killSignal = options.killSignal == null ? nodeOs.constants.signals.SIGTERM : options.killSignal;
        if (typeof killSignal === 'string') {
            const signal = killSignal.toUpperCase(); killSignal = nodeOs.constants.signals[signal];
            if (killSignal === undefined) throw syncError('ERR_UNKNOWN_SIGNAL', 'Unknown signal: ' + options.killSignal);
        } else if (typeof killSignal !== 'number') throw syncError('ERR_INVALID_ARG_TYPE', 'killSignal must be a string or number');
        if (!Number.isInteger(killSignal) || !Object.values(nodeOs.constants.signals).includes(killSignal)) throw syncError('ERR_UNKNOWN_SIGNAL', 'Unknown signal: ' + killSignal);
        let file = command;
        if (options.shell) {
            if (args.length && !emittedSyncShellWarning) {
                emittedSyncShellWarning = true;
                process.emitWarning('Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.', 'DeprecationWarning', 'DEP0190');
            }
            const script = [file].concat(args).join(' ');
            file = typeof options.shell === 'string' ? options.shell : '/bin/sh';
            args = ['-c', script];
        }
        const argv = [options.argv0 == null ? file : options.argv0].concat(args);
        const env = [];
        const values = options.env || process.env;
        for (const key in values) {
            if (values[key] === undefined) continue;
            const value = String(values[key]);
            if (key.includes('\0') || value.includes('\0')) throw syncError('ERR_INVALID_ARG_VALUE', 'Environment must not contain null bytes');
            env.push(key + '=' + value);
        }
        let stdio = options.stdio || 'pipe';
        if (typeof stdio === 'string') {
            if (!['pipe', 'overlapped', 'ignore', 'inherit'].includes(stdio)) throw syncError('ERR_INVALID_ARG_VALUE', 'Invalid stdio: ' + stdio);
            stdio = [stdio, stdio, stdio];
        } else if (Array.isArray(stdio)) stdio = Array.from(stdio);
        else throw syncError('ERR_INVALID_ARG_VALUE', 'Invalid stdio');
        while (stdio.length < 3) stdio.push(undefined);
        stdio = Array.from(stdio, (value, i) => {
            if (value == null) return i < 3 ? 'pipe' : 'ignore';
            if (value === 'overlapped' || (typeof value === 'number' && value < 0)) return 'pipe';
            if (value === 'ipc') throw syncError('ERR_IPC_SYNC_FORK', 'IPC cannot be used with synchronous forks');
            if (value && typeof value === 'object' && typeof value.fd === 'number') value = value.fd;
            if (['pipe', 'ignore', 'inherit'].includes(value)) return value;
            if (Number.isInteger(value) && value >= 0) return value;
            throw syncError('ERR_INVALID_ARG_VALUE', `Invalid stdio[${i}]`);
        });
        let input = options.input;
        if (!input) input = Buffer.alloc(0);
        else if (typeof input === 'string') input = Buffer.from(input, options.encoding);
        else if (ArrayBuffer.isView(input)) input = new Uint8Array(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
        else throw syncError('ERR_INVALID_ARG_TYPE', 'options.input must be a string, Buffer, TypedArray, or DataView');
        if (typeof _nn.__kandeloRunChildSync !== 'function') throw new Error('native synchronous child controller is unavailable');
        const result = {status: null, signal: null, output: null, pid: 0, stdout: undefined, stderr: undefined};
        // Setting uid/gid is not implemented by the native spawn seam.
        // Return ENOSYS rather than running with the wrong credentials.
        if (options.uid != null || options.gid != null) {
            result.error = syncFailure({code:'ENOSYS', errno:38}, file, argv); return result;
        }
        const deadline = timeout > 0 ? os.timerNow() + timeout : 0;
        const actions = [], childEnds = [], legs = Array(stdio.length).fill(-1);
        let pid;
        try {
            // Validate inherited descriptors before opening temporary pipes:
            // a closed numeric fd must not become valid by aliasing a new pipe.
            for (const mode of stdio) if (typeof mode === 'number') fs.fstatSync(mode);
            for (let i = 0; i < stdio.length; i++) {
                const mode = stdio[i];
                if (mode === 'pipe') {
                    const [r, w] = _nn.__kandeloPipe(i !== 0, stdio.length);
                    legs[i] = i === 0 ? w : r;
                    const childEnd = i === 0 ? r : w; childEnds.push(childEnd);
                    actions.push({op:'dup2', from:childEnd, to:i}, {op:'close', fd:r}, {op:'close', fd:w});
                } else if (mode === 'ignore') actions.push({op:'open', fd:i, path:'/dev/null', flags:i === 0 ? 0 : 1, mode:0});
                else actions.push({op:'dup2', from:mode === 'inherit' ? i : mode, to:i});
            }
            if (cwd != null) actions.push({op:'chdir', path:cwd});
            pid = _spawnWithPath(file, argv, env, actions, cwd, {detached:!!options.detached});
            result.pid = pid;
        } catch (error) {
            // Allocation failures and protocol defects are not OS errno zero.
            // Preserve the exception; finally still closes every owned fd.
            if (!error || typeof error.errno !== 'number') throw error;
            result.error = syncFailure(error, file, argv);
        } finally {
            for (const fd of childEnds) { try { _nn.__kandeloFdClose(fd); } catch (_) {} }
            if (!pid) for (const fd of legs) if (fd >= 0) { try { _nn.__kandeloFdClose(fd); } catch (_) {} }
        }
        if (!pid) return result;
        let nativeResult;
        try { nativeResult = _nn.__kandeloRunChildSync(pid, legs, input, deadline, maxBuffer || 0, killSignal); }
        finally { for (const fd of legs) if (fd >= 0) { try { _nn.__kandeloFdClose(fd); } catch (_) {} } }
        result.status = nativeResult.status; result.signal = nativeResult.signal;
        result.output = nativeResult.output.map(value => {
            if (value === null) return null;
            const bytes = Buffer.from(value);
            return options.encoding && options.encoding !== 'buffer' ? bytes.toString(options.encoding) : bytes;
        });
        result.stdout = result.output[1]; result.stderr = result.output[2];
        if (nativeResult.errno) result.error = syncFailure(nativeResult, file, argv);
        return result;
    }
    function checkSyncResult(result, command, options) {
        if (!options.stdio && result.stderr) process.stderr.write(result.stderr);
        if (result.error) throw Object.assign(result.error, result);
        if (result.status !== 0) {
            const detail = result.stderr && result.stderr.length ? '\n' + result.stderr.toString() : '';
            throw Object.assign(new Error('Command failed: ' + command + detail), result);
        }
        return result.stdout;
    }
    function execSync(command, options) {
        syncString(command, 'command');
        options = syncOptions(options == null ? undefined : options);
        options.shell = typeof options.shell === 'string' ? options.shell : true;
        return checkSyncResult(spawnSync(command, [], options), command, options);
    }
    function execFileSync(file, args, options) {
        if (args && !Array.isArray(args) && typeof args === 'object') { options = args; args = []; }
        options = syncOptions(options == null ? undefined : options);
        args = args == null ? [] : args;
        return checkSyncResult(spawnSync(file, args, options), [options.argv0 || file].concat(args).join(' '), options);
    }

    const _nn = _nodeNative;
    function _spawnWithPath(file, argv, env, actions, cwd, attrs = {}) {
        // Anchor without lexical normalization: the kernel must still walk
        // symlinks and '..' in order. The exact-path native seam receives the
        // same target regardless of its preflight's parent working directory.
        const childCwd = cwd ? (cwd.startsWith('/') ? cwd : process.cwd() + '/' + cwd) : process.cwd();
        const absolute = path => path.startsWith('/') ? path : childCwd + '/' + path;
        if (file.includes('/')) return _nn.__kandeloSpawn(absolute(file), argv, env, actions, attrs);

        // Node searches the CHILD environment's PATH. posix_spawn takes an
        // exact path, and posix_spawnp would search the parent's environment,
        // losing npm's node_modules/.bin entries and options.env overrides.
        // Try execution directly: a stat/access precheck would race exec and
        // would resolve relative entries against the wrong cwd.
        const pathEntry = env.find(entry => entry.startsWith('PATH='));
        const searchPath = pathEntry === undefined ? '/usr/bin:/bin' : pathEntry.slice(5);
        let missing, denied;
        for (const directory of searchPath.split(':')) {
            const candidate = directory ? directory + '/' + file : file;
            try { return _nn.__kandeloSpawn(absolute(candidate), argv, env, actions, attrs); }
            catch (err) {
                if (err.code === 'EACCES') denied = err;
                else if (err.code === 'ENOENT' || err.code === 'ENOTDIR') missing = err;
                else throw err;
            }
        }
        throw denied || missing;
    }

    function _spawn(command, args, options) {
        // Preparation owns all temporary pipe ends until launch succeeds.
        // Read caller options/getters before acquiring real descriptors, as the
        // target normalizer does before libuv materializes its pipe handles.
        if (args && !Array.isArray(args)) { options = args; args = []; }
        args = Array.isArray(args) ? args : [];
        if (options === undefined) options = {};
        else _nodeValues.validators.validateObject(options, 'options');
        options = { __proto__: null, ...options };
        let cwd = options.cwd;
        if (cwd != null) cwd = _nodeFsStats.getValidatedPath(cwd, 'options.cwd');
        let file = command, argv;
        if (options.shell) { file = '/bin/sh'; argv = ['/bin/sh', '-c', [command].concat(args).join(' ')]; }
        else { argv = [command].concat(args); }
        const env = options.env
            ? Object.keys(options.env).map(k => k + '=' + options.env[k])
            : Object.keys(process.env).map(k => k + '=' + process.env[k]);

        // Pinned public-spawn validation precedes ChildProcess native stdio
        // preparation. Positive timeout enforcement remains a separate owner.
        if (options.timeout != null)
            _nodeValues.validators.validateInteger(options.timeout, 'timeout', 0);
        _nodeValues.validators.validateAbortSignal(options.signal, 'options.signal');
        const killSignal = sanitizeKillSignal(options.killSignal);
        function sanitizeKillSignal(signal) {
            if (typeof signal === 'string' || typeof signal === 'number')
                return _nodeValues.util.convertToValidSignal(signal);
            if (signal != null)
                throw new _nodeValues.errors.codes.ERR_INVALID_ARG_TYPE('options.killSignal', ['string', 'number'], signal);
        }
        function abortChildProcess(child, signal, reason) {
            if (!child) return;
            try {
                if (child.kill(signal))
                    child.emit('error', new _nodeValues.errors.AbortError(undefined, { cause: reason }));
            } catch (error) {
                child.emit('error', error);
            }
        }
        function publishAbortOwner(child) {
            if (options.signal) {
                const signal = options.signal;
                if (signal.aborted) process.nextTick(onAbortListener);
                else {
                    const disposable = _nodeEventPlatform.addAbortListener(signal, onAbortListener);
                    // Keep the target's exact actual-exit disposal policy;
                    // failed launch/wait does not fabricate an exit event.
                    child.once('exit', disposable[_nodeDispose]);
                }
                function onAbortListener() {
                    abortChildProcess(child, killSignal, options.signal.reason);
                }
            }
            return child;
        }

        let stdio = options.stdio || 'pipe';
        if (typeof stdio === 'string') {
            if (!['pipe', 'overlapped', 'ignore', 'inherit'].includes(stdio))
                throw new _nodeValues.errors.codes.ERR_INVALID_ARG_VALUE('stdio', stdio);
            stdio = [stdio, stdio, stdio];
        } else if (!Array.isArray(stdio)) {
            throw new _nodeValues.errors.codes.ERR_INVALID_ARG_VALUE('stdio', stdio);
        }
        while (stdio.length < 3) _childPrimordials.ArrayPrototypePush(stdio, undefined);
        // Normalize the supported three entries before physical pipe creation.
        // A later index/fd getter must not lose to an earlier EMFILE, or leak
        // descriptors. Extra fd/IPC/wrapped-handle support remains separate.
        const prepared = [null, null, null];
        for (let i = 0; i < 3; i++) {
            if (!(i in stdio)) continue;
            let mode = stdio[i];
            mode ??= 'pipe';
            if (mode === 'pipe' || mode === 'overlapped' || (typeof mode === 'number' && mode < 0)) {
                prepared[i] = { mode: 'pipe' };
            } else if (mode === 'ignore' || mode === 'inherit') {
                prepared[i] = { mode };
            } else if (typeof mode === 'number' || typeof mode.fd === 'number') {
                // Preserve the target's two fd-getter reads and ordinary
                // native integer conversion; do not prevalidate descriptor
                // liveness or reserve numeric descriptor identities.
                prepared[i] = { mode: 'fd', fd: typeof mode === 'number' ? mode : mode.fd };
            } else {
                throw new _nodeValues.errors.codes.ERR_INVALID_ARG_VALUE('stdio', mode);
            }
        }

        const child = new child_process.ChildProcess();
        child.exitCode = null; child.signalCode = null;
        child.spawnfile = file; child.spawnargs = argv; child.killed = false; child.connected = false;
        let openReads = 0, exited = false, exitInfo = null, closed = false;
        function _maybeClose() {
            if (exited && openReads === 0 && !closed) {
                closed = true;
                child.emit('close', exitInfo.code, exitInfo.signal);
            }
        }
        const actions = [], parentClose = [-1, -1, -1], legs = [null, null, null];
        // These fixed own data slots record both ends before any subsequent
        // allocation/callback. Do not adopt an owned native pair through a
        // user-controlled Array iterator or an allocating push operation.
        const pipeReads = [-1, -1, -1], pipeWrites = [-1, -1, -1];
        function rollbackPipes() {
            for (let i = 0; i < 3; i++) {
                const read = pipeReads[i], write = pipeWrites[i];
                pipeReads[i] = pipeWrites[i] = -1;
                if (read >= 0) { try { _nn.__kandeloFdClose(read); } catch (_) {} }
                if (write >= 0) { try { _nn.__kandeloFdClose(write); } catch (_) {} }
            }
        }
        function failedLaunch(error) {
            // Only real native Error errno data is an operation outcome.
            // Unknown JS exceptions keep their original value and identity;
            // inherited/accessor errno fields must not be invoked here.
            if (!_nn.isNativeError(error)) throw error;
            const descriptor = _childPrimordials.ObjectGetOwnPropertyDescriptor(error, 'errno');
            if (!descriptor || typeof descriptor.value !== 'number') throw error;
            const status = -Math.abs(descriptor.value);
            const code = _nodeValues.util.getSystemErrorName(status);
            if (code !== 'EACCES' && code !== 'EAGAIN' && code !== 'EMFILE' && code !== 'ENFILE' && code !== 'ENOENT')
                throw new _nodeValues.errors.ErrnoException(status, 'spawn');
            const limit = code === 'EMFILE' || code === 'ENFILE';
            if (!limit) {
                child.pid = undefined;
                child.stdin = legs[0] == null ? null : new stream.Writable({ write(_chunk, _encoding, cb) {
                    cb(new _nodeValues.errors.codes.ERR_STREAM_DESTROYED('write'));
                } });
                child.stdout = legs[1] == null ? null : new stream.Readable({ read() {} });
                child.stderr = legs[2] == null ? null : new stream.Readable({ read() {} });
                child.stdio = [child.stdin, child.stdout, child.stderr];
            }
            child.kill = function(sig) {
                if (sig !== 0) _nodeValues.util.convertToValidSignal(sig === undefined ? 'SIGTERM' : sig);
                return false;
            };
            child.ref = child.unref = function() { return this; };
            exited = true; exitInfo = { code: status, signal: null };
            process.nextTick(() => {
                child.exitCode = status;
                if (!limit) for (const owner of child.stdio) { if (owner) owner.destroy(); }
                // The target constructs runtime errors in its queued onexit
                // callback and observes the actual mutable public metadata.
                const operationError = new _nodeValues.errors.ErrnoException(status, 'spawn ' + child.spawnfile);
                if (child.spawnfile) operationError.path = child.spawnfile;
                operationError.spawnargs = _childPrimordials.ArrayPrototypeSlice(child.spawnargs, 1);
                child.emit('error', operationError); _maybeClose();
            });
            return child;
        }

        let pipeFailure = false;
        try {
            for (let i = 0; i < 3; i++) {
                const entry = prepared[i];
                if (entry === null) continue;
                if (entry.mode === 'pipe') {
                    let pair;
                    try { pair = _nn.__kandeloPipe(i !== 0, 3); }
                    catch (error) { pipeFailure = true; throw error; }
                    pipeReads[i] = pair[0]; pipeWrites[i] = pair[1];
                    const r = pipeReads[i], w = pipeWrites[i];
                    const childEnd = i === 0 ? r : w, parentEnd = i === 0 ? w : r;
                    legs[i] = parentEnd; parentClose[i] = childEnd;
                    _childPrimordials.ArrayPrototypePush(actions, { op: 'dup2', from: childEnd, to: i });
                } else if (entry.mode === 'ignore') {
                    _childPrimordials.ArrayPrototypePush(actions, { op: 'open', fd: i, path: '/dev/null', flags: i === 0 ? 0 : 1, mode: 0 });
                } else {
                    _childPrimordials.ArrayPrototypePush(actions, { op: 'dup2', from: entry.mode === 'inherit' ? i : entry.fd, to: i });
                }
            }
            // A later inherited numeric fd may genuinely alias an earlier
            // prepared pipe source. Keep all owned sources live until every
            // stdio placement action has consumed its actual descriptor.
            for (let i = 0; i < 3; i++) {
                if (pipeReads[i] < 0) continue;
                _childPrimordials.ArrayPrototypePush(actions,
                    { op: 'close', fd: pipeReads[i] }, { op: 'close', fd: pipeWrites[i] });
            }
            if (cwd) _childPrimordials.ArrayPrototypePush(actions, { op: 'chdir', path: _childPrimordials.String(cwd) });
        } catch (error) {
            rollbackPipes();
            if (pipeFailure) return publishAbortOwner(failedLaunch(error));
            throw error;
        }
        let pid;
        try { pid = _spawnWithPath(file, argv, env, actions, cwd && _childPrimordials.String(cwd), { detached: !!options.detached }); }
        catch (error) { rollbackPipes(); return publishAbortOwner(failedLaunch(error)); }
        child.pid = pid;
        child.stdin = null;
        for (let i = 0; i < 3; i++) {
            const fd = parentClose[i];
            if (fd < 0) continue;
            if (pipeReads[i] === fd) pipeReads[i] = -1;
            if (pipeWrites[i] === fd) pipeWrites[i] = -1;
            try { _nn.__kandeloFdClose(fd); } catch (_) {}
        }

        // stdin (fd 0 pipe): Writable -> fdWrite; end -> fdClose delivers EOF.
        if (legs[0] != null) {
            let wfd = legs[0];
            function closeInput() {
                if (wfd < 0) return;
                const fd = wfd; wfd = -1; _nn.__kandeloFdClose(fd);
            }
            child.stdin = new stream.Writable({
                write(chunk, enc, cb) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
                    _nn.__kandeloFdWrite(wfd, buf).then(() => cb(null), cb);
                },
                final(cb) { try { closeInput(); cb(); } catch (error) { cb(error); } },
                destroy(error, cb) { try { closeInput(); cb(error); } catch (closeError) { cb(error || closeError); } },
            });
        } else { child.stdin = null; }

        // stdout/stderr: Readable pumped by an fdRead loop; empty ArrayBuffer = EOF.
        // 'close' fires once, after the process has exited AND every opened
        // stdout/stderr read stream has reached its terminal state. openReads is
        // incremented once per opened read stream and decremented exactly once
        // (on that stream's actual close event); _maybeClose is the single gate.
        function _pumpReadable(fd) {
            openReads++;
            let pending = null, owned = true;
            const rs = new stream.Readable({
                read() {
                    if (pending || !owned) return;
                    const request = _nn.__kandeloFdRead(fd, 65536);
                    pending = request;
                    request.then(ab => {
                        if (pending !== request) return;
                        pending = null;
                        if (rs.destroyed) return;
                        if (ab.byteLength === 0) { rs.push(null); return; }
                        if (rs.push(Buffer.from(ab))) rs.read(0);
                    }, error => {
                        if (pending !== request) return;
                        pending = null; rs.destroy(error);
                    });
                },
                destroy(error, cb) {
                    if (pending) {
                        try { _nn.__kandeloFdReadControl(pending, null); }
                        catch (cancelError) { error ||= cancelError; }
                        pending = null;
                    }
                    if (owned) {
                        owned = false;
                        try { _nn.__kandeloFdClose(fd); } catch (closeError) { error ||= closeError; }
                    }
                    cb(error);
                },
            });
            rs.once('close', () => { openReads--; _maybeClose(); });
            rs.read(0);
            return rs;
        }
        child.stdout = legs[1] != null ? _pumpReadable(legs[1]) : null;
        child.stderr = legs[2] != null ? _pumpReadable(legs[2]) : null;
        child.stdio = [child.stdin, child.stdout, child.stderr];

        process.nextTick(() => child.emit('spawn'));
        const waitRequest = _nn.__kandeloWaitPid(pid);
        waitRequest.then((st) => {
            exited = true; exitInfo = st;
            child.exitCode = st.code; child.signalCode = st.signal;
            if (child.stdin) child.stdin.destroy();
            child.emit('exit', st.code, st.signal);
            // Flush unread child pipes after exit, as Node's child owner does.
            process.nextTick(() => {
                for (const readable of [child.stdout, child.stderr]) {
                    if (readable && !readable.readableFlowing) readable.resume();
                }
            });
            _maybeClose();
        }, reason => {
            // A failed wait retires the observation owner, not a fabricated
            // exit0. Status stays unknown and the actual operation is visible.
            exited = true; exitInfo = { code: null, signal: null };
            let error = reason;
            if (reason && typeof reason.errno === 'number') {
                // POSIX wait errors include ECHILD, which is not a libuv error
                // entry. Preserve the native errno name without inventing a
                // public util/libuv mapping for it.
                error = reason.code
                    ? Object.assign(new Error('waitpid ' + reason.code), {
                        errno: -Math.abs(reason.errno), code: reason.code, syscall: 'waitpid',
                    })
                    : new _nodeValues.errors.ErrnoException(-Math.abs(reason.errno), 'waitpid');
                error.pid = pid;
            }
            if (child.stdin) child.stdin.destroy();
            if (child.stdout) child.stdout.destroy();
            if (child.stderr) child.stderr.destroy();
            child.emit('error', error);
            _maybeClose();
        });

        child.kill = function (sig) {
            const signum = sig === 0 ? sig :
                _nodeValues.util.convertToValidSignal(sig === undefined ? 'SIGTERM' : sig);
            // A zero signal probes the child. Never substitute a terminating
            // signal, or signal a reused pid after this child has been reaped.
            if (exited) return false;
            try { _nn.__kandeloKill(pid, signum); }
            catch (error) {
                if (typeof error.errno !== 'number') throw error;
                // Native errno is real POSIX state. Use the pinned Node error
                // owner and its compiled UV map for the public error contract.
                const failure = new _nodeValues.errors.ErrnoException(-Math.abs(error.errno), 'kill');
                if (failure.code === 'ESRCH') return false; // The child is already gone.
                if (failure.code === 'EINVAL' || failure.code === 'ENOSYS') throw failure;
                child.emit('error', failure);
                return false;
            }
            child.killed = true;
            return true;
        };
        child.ref = function() { if (!exited) _nn.socketRef(waitRequest, true); return this; };
        child.unref = function() { if (!exited) _nn.socketRef(waitRequest, false); return this; };
        return publishAbortOwner(child);
    }

    const api = _createNodeChildExecPlatform({
        api: { execSync, execFileSync, spawnSync },
        spawn: _spawn, Buffer, timers, values: _nodeValues,
    });
    api.spawn = _spawn;
    return api;
})();

// spawn() creates this shared public class. Direct .spawn(), IPC and native
// handle/subclass integration remain open; constructor identity alone does
// not supply those contracts.
child_process.ChildProcess = (function () {
    function ChildProcess() { events.EventEmitter.call(this); }
    Object.setPrototypeOf(ChildProcess.prototype, events.EventEmitter.prototype);
    Object.setPrototypeOf(ChildProcess, events.EventEmitter);
    return ChildProcess;
})();

// ============================================================
// crypto module (minimal)
// ============================================================

const crypto = (() => {
    // Actual packaged libcrypto uses the guest SDK/kernel entropy path.
    function _fillRandomBytes(u8, byteOffset, byteLength) {
        const p = _nodeCryptoRandomPrimordials;
        const view = new p.Uint8Array(p.TypedArrayPrototypeGetBuffer(u8),
            p.TypedArrayPrototypeGetByteOffset(u8) + byteOffset, byteLength);
        const error = _nodeNative.randomFillBytes(view);
        // Native crypto owns the genuine Error, its realm and decorations.
        // Preserve its identity and setter/descriptor behavior unchanged.
        if (error !== undefined) throw error;
        return u8;
    }

    const _nodeCryptoRandomPrimordials = _createNodePrimordials();
    const { randomFillSync, getRandomValues } = _createNodeCryptoRandomSync({
        values: _nodeValues, types: util.types, dom: _nodeEventPlatform.dom,
        webidl: _nodeEventPlatform.require('internal/webidl'),
        kMaxLength: _nodeBufferModule.constants.MAX_LENGTH,
        fillBytes: bytes => _fillRandomBytes(bytes, 0, _nodeCryptoRandomPrimordials.TypedArrayPrototypeGetByteLength(bytes)),
    });

    const { randomBytes, randomFill, randomInt, randomUUID, randomUUIDv7 } = _createNodeCryptoRandomJobs({
        values: _nodeValues, types: util.types, process, native: _nodeNative,
        kMaxLength: _nodeBufferModule.constants.MAX_LENGTH,
        sync: { randomFillSync }, allocate: _nodeBufferAllocator.createUnsafeBuffer,
        makeError: _nodeFsTruncation.makeError,
    });

    return {
        randomBytes, randomFill, randomUUID, randomUUIDv7, randomInt, randomFillSync,
        // Web Crypto getRandomValues: fills an integer TypedArray in place from
        // the real CSPRNG. Node/WHATWG cap the request at 65536 bytes.
        getRandomValues,
    };
})();

let _nodeDigestHelpers;
Object.assign(crypto, _createNodeCryptoDigest({
    native: _nodeNative, values: _nodeValues, Buffer, types: util.types,
    captureHelpers(helpers) { _nodeDigestHelpers = helpers; },
}));
const _nodeKeyURLHref = Object.getOwnPropertyDescriptor(_nodeWebPlatform.URL.prototype, 'href').get;
const _nodeCryptoKeys = _createNodeCryptoKeys({
    constants: _nodeConstantBinding,
    getX509: () => _nodeX509,
    native: _nodeNative, values: _nodeValues, Buffer, types: util.types,
    codecs: _nodeBufferCodecs, inspection: _nodeInspection, digestHelpers: _nodeDigestHelpers,
    url: {
        fileURLToPath: url.fileURLToPath,
        getURLHref: value => Reflect.apply(_nodeKeyURLHref, value, []),
        isURLInstance(value) {
            try { Reflect.apply(_nodeKeyURLHref, value, []); return true; } catch (_) { return false; }
        },
    },
});
Object.assign(crypto, _nodeCryptoKeys.api);
Object.assign(crypto, _createNodeSymmetricKeygen({
    keys: _nodeCryptoKeys, values: _nodeValues, types: util.types,
    makeError: _nodeFsTruncation.makeError,
}));
Object.assign(crypto, _createNodeCryptoKdf({
    native: _nodeNative, values: _nodeValues, Buffer, digestHelpers: _nodeDigestHelpers,
    makeError: _nodeFsTruncation.makeError, keys: _nodeCryptoKeys, types: util.types,
    kMaxLength: _nodeBufferModule.constants.MAX_LENGTH,
}));
const _nodeIncrementalCrypto = _createNodeIncrementalCrypto({
    native: _nodeNative, values: _nodeValues, Buffer, types: util.types,
    codecs: _nodeBufferCodecs, streams: _nodeStreamPlatform, digestHelpers: _nodeDigestHelpers,
    keys: _nodeCryptoKeys,
});
Object.assign(crypto, _nodeIncrementalCrypto.api);
Object.assign(crypto, _createNodeCipherPlatform({
    constants: _nodeConstantBinding,
    native: _nodeNative, values: _nodeValues, keys: _nodeCryptoKeys,
    streams: _nodeStreamPlatform, types: util.types, codecs: _nodeBufferCodecs,
    digestHelpers: _nodeDigestHelpers, stringDecoder: string_decoder,
    kHandle: _nodeIncrementalCrypto.symbols.kHandle,
}));
Object.assign(crypto, _createNodeSignaturePlatform({
    native: _nodeNative, values: _nodeValues, keys: _nodeCryptoKeys,
    Buffer, types: util.types, codecs: _nodeBufferCodecs, streams: stream,
    digestHelpers: _nodeDigestHelpers, kHandle: _nodeIncrementalCrypto.symbols.kHandle,
    constants: _nodeConstantBinding,
    makeError: _nodeFsTruncation.makeError,
}));
Object.assign(crypto, _createNodeAsymmetricKeygen({
    keys: _nodeCryptoKeys, values: _nodeValues, types: util.types, codecs: _nodeBufferCodecs,
}));
const _nodeX509 = _createNodeX509Platform({
    native: _nodeNative, values: _nodeValues, keys: _nodeCryptoKeys,
    types: util.types, inspection: _nodeInspection, Buffer, codecs: _nodeBufferCodecs,
});
crypto.X509Certificate = _nodeX509.X509Certificate;

// ============================================================
// net module (TCP client policy; listening servers remain incomplete)
// ============================================================

// Public lookup uses the real libc resolver. The current libc transport still
// returns one IPv4 answer for external hostnames; it is not a full DNS client.
const _nodeNetworkIP = _createNodeNetworkIP();
const _nodeAddressRules = _createNodeAddressRules({
    native: _nodeNative, values: _nodeValues, inspection: _nodeInspection,
    clone: _nodeClonePlatform, URLParse: _nodeWebPlatform.URL.parse.bind(_nodeWebPlatform.URL),
});
const _nodeHistogram = _createNodeHistogramPlatform({
    native: _nodeNative, values: _nodeValues, types: util.types, util,
    cloneProtocol: _nodeClonePlatform.protocol,
});
const _nodeEventLoopDelay = _createNodeEventLoopDelayPlatform({
    native: _nodeNative, values: _nodeValues, cloneProtocol: _nodeClonePlatform.protocol,
    histogram: _nodeHistogram,
});
const _nodePerformance = _createNodePerformanceObserverPlatform({
    native: _nodeNative, values: _nodeValues, process, util, setImmediate: timers.setImmediate,
    event: _nodeEventPlatform, structuredClone: _nodeClonePlatform.protocol.structuredClone,
    histogram: _nodeHistogram, eventLoopDelay: _nodeEventLoopDelay,
});
const _nodeDnsPlatform = _createNodeDnsLookupPlatform({
    native: _nodeNative, values: _nodeValues, process, Buffer, ip: _nodeNetworkIP,
    hostnameToASCII: _nodeWebPlatform.hostnameToASCII,
    observation: _nodePerformance.observation, asyncProviders: _nodeAsyncPlatform.api.asyncWrapProviders,
});
const _nodeDnsLookup = _nodeDnsPlatform.api;
const _nodeDatagram = _createNodeDatagramPlatform({
    native: _nodeNative, values: _nodeValues, process, Buffer, FastBuffer: _FastBuffer,
    ip: _nodeNetworkIP, types: util.types, util, uv: _nodeUv, events,
    event: _nodeEventPlatform, async: _nodeAsyncPlatform,
    addressRules: _nodeAddressRules, diagnostics: _nodeDiagnostics.api,
    dns: _nodeDnsPlatform.api, cluster: () => _builtinModules.cluster,
});

// Shared TCP dialing policy. Defaults are consumed by actual connection
// attempts, including callers such as TLS; they are not harness overrides.
let _nodeBeginSocketConnection;

const net = (() => {
    const nat = _nodeNative;
    const clientSocketChannel = _nodeDiagnostics.registerProducer('net.client.socket');
    const serverSocketChannel = _nodeDiagnostics.registerProducer('net.server.socket');
    let autoSelectFamilyDefault = true;
    let attemptTimeoutDefault = 500;
    const toU8 = (b) => {
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof b === 'string') return Buffer.from(b, 'utf8');
        throw new TypeError('socket: chunk must be Buffer, Uint8Array, ArrayBuffer, or string');
    };
    function argumentError(code, message, range = false) {
        const error = range ? new RangeError(message) : new TypeError(message);
        error.code = code;
        return error;
    }
    function assignBlockList(owner, options) {
        if (options?.blockList) {
            if (!net.BlockList.isBlockList(options.blockList)) {
                throw new _nodeValues.errors.codes.ERR_INVALID_ARG_TYPE('options.blockList', 'net.BlockList', options.blockList);
            }
            owner.blockList = options.blockList;
        }
    }
    function received(value) {
        if (value == null) return String(value);
        if (typeof value === 'object') {
            let name = 'Object';
            try { name = Object.getPrototypeOf(value)?.constructor?.name || name; } catch (_) {}
            return 'an instance of ' + name;
        }
        return 'type ' + typeof value + ' (' + util.inspect(value) + ')';
    }
    function boolean(value, name) {
        if (typeof value !== 'boolean') throw argumentError('ERR_INVALID_ARG_TYPE',
            'The "' + name + '" argument must be of type boolean. Received ' + received(value));
        return value;
    }
    function timeout(value, name) {
        if (typeof value !== 'number') throw argumentError('ERR_INVALID_ARG_TYPE',
            'The "' + name + '" argument must be of type number. Received ' + received(value));
        const constraint = !Number.isInteger(value) ? 'an integer' : value < 1 || value > 2147483647
            ? '>= 1 && <= 2147483647' : null;
        if (constraint) throw argumentError('ERR_OUT_OF_RANGE', 'The value of "' + name +
            '" is out of range. It must be ' + constraint + '. Received ' + String(value), true);
        return Math.max(value, 10);
    }

    const { isIP, isIPv4, isIPv6 } = _nodeNetworkIP;
    function normalizeArgs(args) {
        const first = args[0];
        const options = typeof first === 'object' && first !== null ? { ...first }
            : typeof first === 'string' && Number.isNaN(Number(first)) ? { path: first }
            : { port: first, ...(typeof args[1] === 'string' ? { host: args[1] } : {}) };
        const last = args[args.length - 1];
        return [options, typeof last === 'function' ? last : null];
    }
    function normalizeOptions(options) {
        if (options.port === undefined && options.path == null) throw argumentError('ERR_MISSING_ARGS',
            'The "options" or "port" or "path" argument must be specified');
        if (options.path != null) throw new Error('net.Socket Unix paths are not implemented on spidermonkey-node');
        const host = options.host || 'localhost';
        if (typeof host !== 'string') throw argumentError('ERR_INVALID_ARG_TYPE',
            'The "options.host" property must be of type string. Received ' + received(host));
        if (host.includes('\0')) throw argumentError('ERR_INVALID_ARG_VALUE',
            'The property \'options.host\' must be a string without null bytes');
        if (typeof options.port !== 'number' && typeof options.port !== 'string') throw argumentError('ERR_INVALID_ARG_TYPE',
            'The "options.port" property must be one of type number or string. Received ' + received(options.port));
        const port = Number(options.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535 ||
            typeof options.port === 'string' && !options.port.trim()) throw argumentError('ERR_SOCKET_BAD_PORT',
            'Port should be >= 0 and < 65536. Received ' + util.inspect(options.port) + '.', true);
        const autoSelectFamily = options.autoSelectFamily == null ? autoSelectFamilyDefault
            : boolean(options.autoSelectFamily, 'options.autoSelectFamily');
        const attemptTimeout = options.autoSelectFamilyAttemptTimeout == null ? attemptTimeoutDefault
            : timeout(options.autoSelectFamilyAttemptTimeout, 'options.autoSelectFamilyAttemptTimeout');
        if (!isIP(host) && options.lookup != null && typeof options.lookup !== 'function') throw argumentError('ERR_INVALID_ARG_TYPE',
            'The "options.lookup" property must be of type function. Received ' + received(options.lookup));
        if (options.localAddress && !isIP(options.localAddress)) throw argumentError('ERR_INVALID_IP_ADDRESS',
            'Invalid IP address: ' + options.localAddress);
        if (options.localPort && typeof options.localPort !== 'number') throw argumentError('ERR_INVALID_ARG_TYPE',
            'The "options.localPort" property must be of type number. Received ' + received(options.localPort));
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const all = autoSelectFamily && family !== 4 && family !== 6 && !options.localAddress;
        const signal = options.signal;
        if (signal != null && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
            throw argumentError('ERR_INVALID_ARG_TYPE', 'The "options.signal" property must be an AbortSignal');
        }
        return { ...options, host, port, family, all, attemptTimeout, signal,
            localAddress: options.localAddress || undefined, localPort: options.localPort || undefined };
    }
    function connectError(reason, address, port, syscall = 'connect') {
        if (reason instanceof Error || nat.isNativeError?.(reason)) return reason;
        const errno = typeof reason?.errno === 'number' ? reason.errno : undefined;
        const code = reason?.code || (errno === undefined ? 'UNKNOWN' : _errnoToCode(errno));
        syscall = reason?.syscall || syscall;
        const error = new Error(syscall + ' ' + code + ' ' + address + (syscall === 'connect' ? ':' + port : ''));
        error.code = code;
        if (errno !== undefined) error.errno = errno;
        error.syscall = syscall;
        if (syscall === 'getaddrinfo') error.hostname = address;
        else { error.address = address; error.port = port; }
        return error;
    }
    function abortError(signal) {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError'; error.code = 'ABORT_ERR'; error.cause = signal?.reason;
        return error;
    }
    _nodeBeginSocketConnection = function beginConnection(rawOptions, emit = () => {}, getBlockList, owned = false, complete, prepareParent) {
        if (getBlockList === undefined) {
            const owner = {}; assignBlockList(owner, rawOptions);
            getBlockList = () => owner.blockList;
        }
        const options = normalizeOptions(rawOptions);
        let done = false, active = null, timer = null, destinations = [], current = 0, referenced = true;
        let multiple = false, lookupCalled = false, started = false, abortDisposable;
        const errors = [];
        let resolveResult, rejectResult;
        const promise = owned ? undefined : new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
        function stopTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
        function cleanup() { stopTimer(); abortDisposable?.[_nodeDispose](); abortDisposable = undefined; }
        function cancelAttempt() {
            const pending = active;
            active = null;
            if (pending) (owned ? nat.socketOwnerCancelConnect : nat.socketCancelConnect)(pending);
        }
        function fail(error) {
            if (done) return;
            done = true; cleanup(); cancelAttempt(); if (owned) complete(error); else rejectResult(error);
        }
        function onAbort() { fail(abortError(options.signal)); }
        function exhausted() {
            if (!multiple) return fail(errors[0] || connectError({ code: 'ERR_SOCKET_CONNECTION_TIMEOUT' }, options.host, options.port));
            const error = new AggregateError(errors);
            if (errors[0]?.code) error.code = errors[0].code;
            fail(error);
        }
        function attempt() {
            if (done) return;
            stopTimer();
            if (current === destinations.length) return exhausted();
            const { address, family } = destinations[current++];
            if (!multiple) {
                emit('connectionAttempt', address, options.port, family);
                if (done) return;
            }
            if (getBlockList()?.check(address, `ipv${family}`)) {
                const error = new _nodeValues.errors.codes.ERR_IP_BLOCKED(address);
                if (!multiple) return fail(error);
                errors.push(error);
                emit('connectionAttemptFailed', address, options.port, family, error);
                if (!done) attempt();
                return;
            }
            if (multiple) {
                emit('connectionAttempt', address, options.port, family);
                if (done) return;
                emit('_attemptedAddress', address + ':' + options.port);
                if (done) return;
            }
            let pending, preparedParent;
            function succeeded(fd, owner) {
                if (done || active !== pending) {
                    if (owner) nat.socketOwnerAbortAdoption(owner); else nat.socketClose(fd);
                    return;
                }
                active = null; done = true; cleanup();
                const result = { fd, owner, address, family, port: options.port };
                if (owned) complete(null, result); else resolveResult(result);
            }
            function failed(reason) {
                if (done || active !== pending) return;
                active = null; stopTimer();
                const error = connectError(reason, address, options.port);
                errors.push(error);
                emit('connectionAttemptFailed', address, options.port, family, error);
                if (!done) attempt();
            }
            try {
                // A TLS layer can already own SSL state over this actual empty
                // TCP resource. Ordinary net clients retain their existing path.
                if (owned && prepareParent) preparedParent = prepareParent();
                if (done) return;
                pending = owned ? nat.socketOwnerConnect(address, options.port, family,
                    options.localAddress, options.localPort, (status, owner) => {
                        if (status) failed({ errno: status, syscall: 'connect' });
                        else succeeded(prepareParent ? undefined : owner.fd, owner);
                    }, preparedParent) : nat.socketConnect(address, options.port, family, options.localAddress, options.localPort);
            } catch (error) { return fail(error); }
            active = pending;
            if (owned) {
                const owner = nat.socketOwnerOfConnect(pending);
                try { emit('_nativeOwner', owner || pending.owner); }
                catch (error) { fail(error); return; }
                if (!owner) { failed({ errno: pending.error, syscall: pending.syscall }); return; }
                if (!referenced) nat.socketOwnerRefConnect(pending, false);
            } else {
                if (!referenced) nat.socketRef(pending, false);
                pending.then(fd => succeeded(fd), failed);
            }
            // Like Node, a single address and the final address use the socket's
            // normal connection outcome, rather than a family-fallback timer.
            if (multiple && current < destinations.length) timer = setTimeout(() => {
                if (done || active !== pending) return;
                timer = null;
                emit('connectionAttemptTimeout', address, options.port, family);
                if (done) return;
                errors.push(connectError({ code: 'ETIMEDOUT', errno: -110 }, address, options.port));
                cancelAttempt();
                attempt();
            }, options.attemptTimeout);
        }
        function resolved(error, values, family) {
            if (done || lookupCalled) return;
            lookupCalled = true;
            if (error) {
                emit('lookup', error, undefined, undefined, options.host);
                return fail(connectError(error, options.host, options.port, 'getaddrinfo'));
            }
            const records = options.all ? values : [{ address: values, family }];
            if (!Array.isArray(records) || records.length === 0) return fail(argumentError('ERR_INVALID_IP_ADDRESS', 'Invalid IP address: undefined'));
            if (options.all) {
                const groups = [[], []], seen = new Set();
                let firstFamily;
                for (const record of records) {
                    const address = record?.address, family = record?.family;
                    emit('lookup', null, address, family, options.host);
                    if (done) return;
                    if ((family !== 4 && family !== 6) || typeof address !== 'string' || !isIP(address)) continue;
                    firstFamily ??= family;
                    const key = family + ':' + address;
                    if (!seen.has(key)) { seen.add(key); groups[family === firstFamily ? 0 : 1].push({ address, family }); }
                }
                for (let i = 0; i < Math.max(groups[0].length, groups[1].length); i++) {
                    if (groups[0][i]) destinations.push(groups[0][i]);
                    if (groups[1][i]) destinations.push(groups[1][i]);
                }
            } else {
                emit('lookup', null, values, family, options.host);
                if (done) return;
                if (typeof values === 'string' && isIP(values) && (family === 4 || family === 6)) destinations = records;
            }
            if (!destinations.length) {
                const first = records[0];
                if (typeof first?.address === 'string' && isIP(first.address)) {
                    const error = argumentError('ERR_INVALID_ADDRESS_FAMILY', 'Invalid address family: ' +
                        String(first.family) + ' ' + rawOptions.host + ':' + rawOptions.port, true);
                    error.host = rawOptions.host; error.port = rawOptions.port;
                    return fail(error);
                }
                return fail(argumentError('ERR_INVALID_IP_ADDRESS', 'Invalid IP address: ' + first?.address));
            }
            multiple = destinations.length > 1;
            if (multiple) emit('_attemptsStarted');
            attempt();
        }
        return {
            promise,
            ref(value) { referenced = value; if (active) (owned ? nat.socketOwnerRefConnect : nat.socketRef)(active, value); },
            cancel(error = connectError({ code: 'ECANCELED', errno: -125 }, options.host, options.port)) { fail(error); },
            start() {
                if (done || started) return;
                started = true;
                if (options.signal?.aborted) return onAbort();
                if (options.signal) abortDisposable = _nodeEventPlatform.addAbortListener(options.signal, onAbort);
                const literalFamily = isIP(options.host);
                if (literalFamily) {
                    destinations = [{ address: options.host, family: literalFamily }];
                    queueMicrotask(attempt);
                } else {
                    const dnsOptions = { family: options.family, hints: options.hints || 0, ...(options.all ? { all: true } : {}) };
                    if (dnsOptions.family !== 4 && dnsOptions.family !== 6 && dnsOptions.hints === 0) {
                        dnsOptions.hints = _nodeDnsLookup.ADDRCONFIG;
                    }
                    (options.lookup || _nodeDnsLookup.lookup)(options.host, dnsOptions, resolved);
                }
            },
        };
    };
    const socketTimeout = Symbol('socketTimeout');
    const socketNativeOwners = new WeakMap();
    const socketTerminalOwners = new WeakSet();
    function prepareSocketOwner() {
        // Constructor reinitialization detaches the receiver association;
        // like Node it does not close an independently retained old handle.
        socketNativeOwners.delete(this);socketTerminalOwners.delete(this);
        this._fd = -1;
        this._handle = null;
        this._socketDestroyed = false;
        this._reading = false;
        this._writeQueue = [];
        this.connecting = false;
        this[_nodeAsyncPlatform.symbols.async_id_symbol] = -1;
        this._parent = null;
        this.remoteAddress = undefined;
        this.remotePort = undefined;
        this.localAddress = undefined;
        this.localPort = undefined;
        this._connectOperation = null;
        this[socketTimeout] = null;
        this._lastWriteQueueSize = 0;
        this._referenced = true;
    }

    function initializeSocketOwner(options) {
        this.allowHalfOpen = !!options?.allowHalfOpen;
        _nodeSocketStream.initOptions(this, options || {});
        this.on('end', () => {
            if (!this.allowHalfOpen) queueMicrotask(() => {
                if (!this._socketDestroyed && !this.writableEnded) this.end();
            });
            this._maybeCloseSocket();
        });
        this.on('finish', () => this._maybeCloseSocket());
        this.once('close', () => {
            this._onServerSocketClose?.(); this._onServerSocketClose = null;
        });
        if (options.handle) {
            this._ownSocketOwner(options.handle, true);
        } else if (options.fd !== undefined) {
            if (typeof options.fd !== 'number') throw argumentError('ERR_INVALID_ARG_TYPE', 'The "fd" option must be of type number');
            if (!Number.isInteger(options.fd) || options.fd < 0 || options.fd > 2147483647) throw argumentError('ERR_OUT_OF_RANGE', 'The "fd" option must be a non-negative int32', true);
            fs.fstatSync(options.fd);
            this._ownSocketFd(options.fd);
            _nodeSocketStream.applyOptions(this);
        }
    }

    class SocketCore extends stream.Duplex {
        _ownSocketFd(fd) {
            const owner = nat.socketOwnerAdopt(fd);
            this._ownSocketOwner(owner);
        }
        _ownSocketOwner(owner, preserveReference = false) {
            // Check real native authority before any mutable JS getter/binding
            // or replacement can affect the previous transport.
            const terminalState = nat.operatingSystem('tty-stream-state', owner);
            const terminal = terminalState !== undefined;
            const referenced = terminal ? terminalState : nat.socketOwnerValidate(owner);
            const previous = socketNativeOwners.get(this);
            if (previous && previous !== owner) previous.close();
            // The private owner is installed before any fallible JS wrapper
            // publication. Cleanup never consults mutable public _handle/_fd.
            socketNativeOwners.set(this, owner);
            if (terminal) socketTerminalOwners.add(this);else socketTerminalOwners.delete(this);
            try {
                _nodeSocketStream.bind(owner, this, terminal);
                this._fd = owner.fd;
                this._handle = owner;
                this[_nodeAsyncPlatform.symbols.async_id_symbol] = owner.getAsyncId();
                // Adopting an existing handle preserves its actual native ref
                // state. Fresh connect/fd owners consume the Socket's policy.
                if (preserveReference) this._referenced = referenced;
                else if (terminal && this._referenced === false) owner.unref();
                else owner.ref(this._referenced !== false);
                if (!terminal) nat.socketOwnerCommitAdoption(owner);
            } catch (error) {
                // A caller-supplied handle remains that actual partial
                // receiver's transport on failed binding, as in Node. A new
                // internally acquired owner instead rolls back its lease.
                if (!preserveReference) {
                    if (socketNativeOwners.get(this) === owner) {
                        socketNativeOwners.delete(this);socketTerminalOwners.delete(this);
                    }
                    try {
                        if (terminal) nat.operatingSystem('tty-stream-abort', owner);
                        else nat.socketOwnerAbortAdoption(owner);
                    } catch (_) {}
                }
                throw error;
            }
        }
        _adoptAccepted(lease) {
            const owner = nat.socketOwnerAdoptAccepted(lease);
            let adopted = false;
            try { this._adoptFd(undefined, owner); adopted = true; }
            finally { if (!adopted) nat.socketOwnerAbortAdoption(owner); }
        }
        _adoptFd(fd, owner) {
            if (owner) {
                if (socketNativeOwners.get(this) !== owner) this._ownSocketOwner(owner);
            } else this._ownSocketFd(fd);
            const actual = socketNativeOwners.get(this).fd;
            const peer = nat.socketAddress(actual, true), local = nat.socketAddress(actual);
            this.remoteAddress = peer.address; this.remoteFamily = peer.family; this.remotePort = peer.port;
            this.localAddress = local.address; this.localFamily = local.family; this.localPort = local.port;
        }
        _maybeCloseSocket() {
            if (this.readableEnded && this.writableFinished) this.destroy();
        }
        _final(cb) {
            if (this.connecting) { this.once('connect', () => this._final(cb)); return; }
            const owner = socketNativeOwners.get(this);
            // No acquired native stream exists to shut down. Complete the
            // actual Writable finalization rather than issuing shutdown(-1).
            if (!owner) return cb();
            if (socketTerminalOwners.has(this)) {
                return cb(new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('TTY native shutdown request ownership'));
            }
            return _nodeSocketStream.shutdown(owner, cb);
        }

        connect(...args) {
            const [options, cb] = normalizeArgs(args);
            // Node publishes the attempted socket before callbacks and even
            // before validation can reject the connection options.
            if (clientSocketChannel.hasSubscribers) clientSocketChannel.publish({ socket: this });
            if (cb) this.once('connect', cb);
            if (this.connecting) throw argumentError('ERR_SOCKET_CONNECTION_IN_PROGRESS', 'Socket is already connecting');
            if (this._fd >= 0) throw argumentError('ERR_SOCKET_ALREADY_CONNECTED', 'Socket is already connected');
            this._socketDestroyed = false;
            this._unrefTimer();
            const onComplete = (error, result) => {
                if (error) {
                    if (!this._socketDestroyed && this._connectOperation === operation) {
                        this._connectOperation = null; this.connecting = false; this.destroy(error);
                    }
                    return;
                }
                const { fd, owner } = result;
                if (this._socketDestroyed || this._connectOperation !== operation) { nat.socketOwnerAbortAdoption(owner); return; }
                this._connectOperation = null;
                try { this._adoptFd(fd, owner); }
                catch (error) { this.destroy(error); return; }
                this.connecting = false;
                this._unrefTimer();
                _nodeSocketStream.applyOptions(this);
                this.emit('connect');
                if (this._socketDestroyed) return;
                this.emit('ready');
                this._scheduleRead();
                this._flushWriteQueue();
            };
            const operation = _nodeBeginSocketConnection(options, (event, ...values) => {
                if (event === '_nativeOwner') { this._ownSocketOwner(values[0]); return; }
                if (event === 'lookup' && values[0] === null) this._unrefTimer();
                if (event === '_attemptsStarted') this.autoSelectFamilyAttemptedAddresses = [];
                else if (event === '_attemptedAddress') this.autoSelectFamilyAttemptedAddresses.push(values[0]);
                else this.emit(event, ...values);
            }, () => this.blockList, true, onComplete);
            this._connectOperation = operation;
            operation.ref(this._referenced);
            this.connecting = true;
            try { operation.start(); }
            catch (error) {
                this._connectOperation = null; this.connecting = false; operation.cancel(); throw error;
            }
            return this;
        }

        _scheduleRead() {
            const owner = socketNativeOwners.get(this);
            if (!owner || owner.fd < 0 || this.connecting || this._socketDestroyed || owner.reading) return;
            owner.reading = true;
            const status = owner.readStart();
            if (status) { owner.reading = false; this.destroy(new _nodeValues.errors.ErrnoException(status, 'read')); }
        }

        _read() { this._scheduleRead(); }

        _write(chunk, encoding, cb) {
            // The pinned Socket constructor preserves strings. Materialize the
            // requested encoding before handing bytes to the real span owner.
            const buf = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : toU8(chunk);
            if (this.connecting || this._fd < 0) {
                this._writeQueue.push({ buf, cb });
                return;
            }
            this._writeToSocket(buf, cb);
        }

        _flushWriteQueue() {
            const q = this._writeQueue;
            this._writeQueue = [];
            for (const { buf, cb } of q) {
                this._writeToSocket(buf, cb);
            }
        }

        _writeToSocket(buf, cb) {
            this._unrefTimer();
            const owner = socketNativeOwners.get(this);
            if (!owner) { cb(new _nodeValues.errors.ErrnoException(-9, 'write')); return; }
            const result = owner.writeBuffer(null, buf);
            this._lastWriteQueueSize = owner.writeQueueSize;
            _nodeSocketStream.afterWriteDispatched(owner, result, buf, cb);
        }

        _unrefTimer() {
            for (let socket = this; socket != null; socket = socket._parent) {
                if (socket[socketTimeout]) socket[socketTimeout].refresh();
            }
        }
        _onTimeout() {
            if (this._socketDestroyed) return;
            if (this._lastWriteQueueSize > 0 && this._fd >= 0) {
                const remaining = socketNativeOwners.get(this)?.writeQueueSize ?? 0;
                if (remaining !== this._lastWriteQueueSize) {
                    this._lastWriteQueueSize = remaining;
                    this._unrefTimer();
                    return;
                }
            }
            this.emit('timeout');
        }

        _destroy(err, callback) {
            if (this._socketDestroyed) { callback(err); return; }
            for (let socket = this; socket != null; socket = socket._parent) {
                if (socket[socketTimeout]) timers.clearTimeout(socket[socketTimeout]);
            }
            this._socketDestroyed = true;
            this.connecting = false;
            const operation = this._connectOperation;
            this._connectOperation = null;
            if (operation) operation.cancel();
            const owner = socketNativeOwners.get(this);
            const terminal = socketTerminalOwners.has(this);
            socketNativeOwners.delete(this);socketTerminalOwners.delete(this);
            if (owner) {
                try { owner.close(() => this.emit('close', !!err)); }
                catch (closeError) {
                    err ||= closeError;
                    try {
                        if (terminal) nat.operatingSystem('tty-stream-abort', owner);
                        else nat.socketOwnerAbortAdoption(owner);
                    } catch (abortError) { err ||= abortError; }
                    process.nextTick(() => this.emit('close', !!err));
                }
            } else process.nextTick(() => this.emit('close', !!err));
            this._fd = -1; this._handle = null;
            for (const { cb } of this._writeQueue) cb(err || new Error('socket destroyed'));
            this._writeQueue = [];
            callback(err);
        }

        resume() { super.resume(); this._scheduleRead(); return this; }
        setEncoding(enc) { return super.setEncoding(enc); }
        setTimeout(ms, cb) {
            if (this.destroyed) return this;
            this.timeout = ms;
            if (typeof ms !== 'number') throw argumentError('ERR_INVALID_ARG_TYPE', 'The "msecs" argument must be of type number');
            if (ms < 0 || !Number.isFinite(ms)) throw argumentError('ERR_OUT_OF_RANGE', 'The "msecs" argument must be a non-negative finite number', true);
            if (ms > 2147483647) {
                process.emitWarning(ms + ' does not fit into a 32-bit signed integer.\nTimer duration was truncated to 2147483647.', 'TimeoutOverflowWarning');
                ms = 2147483647;
            }
            timers.clearTimeout(this[socketTimeout]);
            if (ms !== 0) this[socketTimeout] = timers.setTimeout(() => this._onTimeout(), ms).unref();
            if (cb !== undefined) {
                if (typeof cb !== 'function') throw argumentError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
                if (ms === 0) this.removeListener('timeout', cb);
                else this.once('timeout', cb);
            }
            return this;
        }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        address() {
            // A genuine TTY has no getsockname method, just as in pinned net.
            if (socketTerminalOwners.has(this)) return {};
            const fd = socketNativeOwners.get(this)?.fd ?? -1;
            return fd < 0 ? {} : nat.socketAddress(fd);
        }
        ref() { this._referenced = true; this._connectOperation?.ref(true); socketNativeOwners.get(this)?.ref(true); return this; }
        unref() {
            this._referenced = false;this._connectOperation?.ref(false);
            const owner = socketNativeOwners.get(this);
            if (socketTerminalOwners.has(this)) owner?.unref();else owner?.ref(false);
            return this;
        }
    }

    // Listeners own real kernel fds. A close stops accept immediately and
    // waits for accepted sockets before reporting the server's close event.
    const ServerWeakMap = _createNodePrimordials().SafeWeakMap;
    const ServerWeakSet = _createNodePrimordials().SafeWeakSet;
    const serverOwners = new ServerWeakMap(), serverOwnerTokens = new ServerWeakSet();
    function serverOwner(server) {
        const owner = serverOwners.get(server);
        if (!owner) throw new _nodeValues.errors.codes.ERR_INVALID_THIS('net.Server');
        return owner;
    }
    function publishServerOwner(server, owner) {
        serverOwners.set(server, owner);
        server._fd = owner.fd; server._generation = owner.generation;
        server._referenced = owner.referenced; server._closing = owner.closing;
    }
    function initializeServerOwner(server) {
        // Reinitialization creates a new current binding. An already active
        // listener remains owned by its actual pending accept closure, as in
        // Node's old native handle; never reset/reuse that owner's epoch/fd.
        const owner = { fd: -1, generation: 0, referenced: true,
            closing: false, opening: false, abortCleanup: null };
        serverOwnerTokens.add(owner);publishServerOwner(server, owner);
        server._connections = 0;
    }
    function acceptServer(server, owner, generation) {
        if (!serverOwnerTokens.has(owner) || owner.fd < 0 || owner.generation !== generation) return;
        const pending = nat.socketAcceptLease(owner.fd);
        if (!owner.referenced) nat.socketRef(owner.fd, false);
        pending.then(accepted => {
            // Native acceptance already owns this descriptor. Every getter,
            // constructor, listener and failure leaves only the actual lease
            // to close; successful adoption empties it without a numeric ABA.
            try {
                if (owner.fd < 0 || owner.generation !== generation) return;
                acceptServer(server, owner, generation);
                if (server.maxConnections != null && server._connections >= server.maxConnections) {
                    const local = nat.socketAddress(nat.socketAcceptedFd(accepted));
                    const remote = nat.socketAddress(nat.socketAcceptedFd(accepted), true);
                    server.emit('drop', { __proto__: null,
                        localAddress: local.address, localPort: local.port, localFamily: local.family,
                        remoteAddress: remote.address, remotePort: remote.port, remoteFamily: remote.family,
                    });
                    return;
                }
                if (server.blockList) {
                    const remote = nat.socketAddress(nat.socketAcceptedFd(accepted), true);
                    const family = isIP(remote.address);
                    if (family && server.blockList.check(remote.address, `ipv${family}`)) return;
                }
                const socket = new Socket({ allowHalfOpen: server.allowHalfOpen,
                    readableHighWaterMark: server.highWaterMark, writableHighWaterMark: server.highWaterMark,
                    noDelay: server.noDelay, keepAlive: server.keepAlive,
                    keepAliveInitialDelay: server.keepAliveInitialDelay * 1000 });
                try { socket._adoptAccepted(accepted); }
                catch (error) { socket.destroy(); server.emit('error', error); return; }
                try {
                    _nodeSocketStream.applyOptions(socket);
                    if (server.pauseOnConnect) {
                        const acceptedOwner = socketNativeOwners.get(socket);
                        acceptedOwner.readStop();acceptedOwner.reading = false;
                        socket.readableFlowing = false;
                    }
                } catch (error) {
                    // Unpublished initialization owns the actual adopted
                    // native resource. Close it without consulting mutable
                    // public handle/destroy methods, then propagate failure.
                    try { nat.socketOwnerAbortAdoption(socketNativeOwners.get(socket)); } catch (_) {}
                    throw error;
                }
                socket.server = server;
                server._connections++;
                socket._onServerSocketClose = () => { server._connections--; maybeCloseServer(server, serverOwner(server)); };
                server.emit('connection', socket);
                if (serverSocketChannel.hasSubscribers) serverSocketChannel.publish({ socket });
                if (!server.pauseOnConnect) socket._scheduleRead();
            } finally { nat.socketAcceptedClose(accepted); }
        }, reason => {
            if (owner.fd >= 0 && owner.generation === generation) server.emit('error', connectError(reason, undefined, undefined, 'accept'));
        });
    }
    function closeServerOwner(server, owner, cb) {
        if (!serverOwnerTokens.has(owner)) throw new _nodeValues.errors.codes.ERR_INVALID_THIS('net.Server');
        const running = owner.fd >= 0 || owner.opening;
        if (cb) server.once('close', () => {
            let error;
            if (!running) { error = new Error('Server is not running.'); error.code = 'ERR_SERVER_NOT_RUNNING'; }
            cb(error);
        });
        owner.generation++;owner.opening = false;owner.closing = true;
        owner.abortCleanup?.();owner.abortCleanup = null;
        const fd = owner.fd;owner.fd = -1;
        if (serverOwners.get(server) === owner) { publishServerOwner(server, owner);server._opening = false; }
        if (fd >= 0) nat.socketClose(fd);
        maybeCloseServer(server, owner);
        return server;
    }
    function maybeCloseServer(server, owner) {
        if (!serverOwnerTokens.has(owner) || !owner.closing || server._connections !== 0) return;
        owner.closing = false;
        if (serverOwners.get(server) === owner) server._closing = false;
        queueMicrotask(() => server.emit('close'));
    }
    class ServerCore extends events.EventEmitter {
        listen(...args) {
            const owner = serverOwner(this);
            if (owner.fd >= 0 || owner.opening) throw argumentError('ERR_SERVER_ALREADY_LISTEN', 'Listen method has been called more than once without closing.');
            const [options, cb] = normalizeArgs(args);
            for (const option of ['path', 'fd']) {
                if (options[option] != null) throw argumentError('ERR_NOT_IMPLEMENTED', 'net.Server ' + option + ' is not implemented');
            }
            options.port ??= 0;
            const port = Number(options.port);
            if (!['number', 'string'].includes(typeof options.port) ||
                typeof options.port === 'string' && !options.port.trim() ||
                !Number.isInteger(port) || port < 0 || port > 65535)
                throw argumentError('ERR_SOCKET_BAD_PORT', 'Port should be >= 0 and < 65536. Received ' + String(options.port), true);
            let host = options.host;
            if (host != null && typeof host !== 'string') throw argumentError('ERR_INVALID_ARG_TYPE', 'The "host" argument must be of type string');
            if (host?.includes('\0')) throw argumentError('ERR_INVALID_ARG_VALUE', 'Host must not contain null bytes');
            const backlog = options.backlog ?? (typeof args[1] === 'number' ? args[1] : typeof args[2] === 'number' ? args[2] : 511);
            if (!Number.isInteger(backlog) || backlog < -2147483648 || backlog > 2147483647)
                throw argumentError('ERR_OUT_OF_RANGE', 'The "backlog" argument must be a signed 32-bit integer', true);
            const ipv6Only = options.ipv6Only === undefined ? false : boolean(options.ipv6Only, 'options.ipv6Only');
            const reusePort = options.reusePort === undefined ? false : boolean(options.reusePort, 'options.reusePort');
            const signal = options.signal;
            if (signal != null && typeof signal.addEventListener !== 'function') throw argumentError('ERR_INVALID_ARG_TYPE', 'The "options.signal" property must be an AbortSignal');
            if (cb) this.once('listening', cb);
            const generation = ++owner.generation;
            this._generation = owner.generation;
            owner.opening = true; owner.closing = false;this._opening = true;this._closing = false;
            const fail = reason => {
                if (owner.generation !== generation || serverOwners.get(this) !== owner) return;
                owner.opening = false;
                owner.abortCleanup?.();owner.abortCleanup = null;
                if (serverOwners.get(this) === owner) this._opening = false;
                queueMicrotask(() => this.emit('error', connectError(reason, host || '::', port, 'listen')));
            };
            const bind = (address, family) => {
                if (owner.generation !== generation || serverOwners.get(this) !== owner) return;
                let fd;
                try { fd = nat.socketListen(address, port, family, backlog || 511, ipv6Only, reusePort); }
                catch (reason) { fail(reason); return; }
                owner.fd = fd;owner.opening = false;
                // Only this admitted current binding may publish its result.
                // Active prior listeners keep their captured accept owners;
                // pending resolution from a reinitialized receiver is stale.
                publishServerOwner(this, owner);this._opening = false;
                acceptServer(this, owner, generation);
                queueMicrotask(() => {
                    if (owner.generation === generation && owner.fd >= 0) this.emit('listening');
                });
            };
            if (signal) {
                const abort = () => this.close();
                if (signal.aborted) { queueMicrotask(abort); return this; }
                const disposable = _nodeEventPlatform.addAbortListener(signal, abort);
                owner.abortCleanup = () => disposable[_nodeDispose]();
            }
            host ||= '::';
            const family = isIP(host);
            if (family) bind(host, family);
            else _nodeDnsLookup.lookup(host, (error, address, resolvedFamily) => error ? fail(error) : bind(address, resolvedFamily));
            return this;
        }
        address() { const owner = serverOwner(this);return owner.fd < 0 ? null : nat.socketAddress(owner.fd); }
        getConnections(cb) { queueMicrotask(() => cb(null, this._connections)); return this; }
        close(cb) { return closeServerOwner(this, serverOwner(this), cb); }
        ref() { const owner = serverOwner(this);owner.referenced = true;this._referenced = true;if (owner.fd >= 0) nat.socketRef(owner.fd, true);return this; }
        unref() { const owner = serverOwner(this);owner.referenced = false;this._referenced = false;if (owner.fd >= 0) nat.socketRef(owner.fd, false);return this; }
    }

    // Node accepts both call and construct forms, including subclasses.
    const Socket = _nodeSocketStream.createConstructor(SocketCore.prototype,
        receiver => Reflect.apply(prepareSocketOwner, receiver, []),
        (receiver, options) => Reflect.apply(initializeSocketOwner, receiver, [options]),
        (receiver, options) => assignBlockList(receiver, options));
    _nodeSocketStream.installSocket(Socket);
    const Server = _createNodeServerConstructor({
        EventEmitter: events.EventEmitter, prototype: ServerCore.prototype, values: _nodeValues,
        getDefaultHighWaterMark: _nodeStreamPlatform.require('internal/streams/state').getDefaultHighWaterMark,
        getExports: () => net, initializeOwner: initializeServerOwner,
        // Do not advertise transfer eligibility without an actual listener
        // transfer owner. This real engine mode prohibits metadata-only copy.
        markResource: receiver => _nodeClonePlatform.setMode(receiver, 0),
        listening: receiver => serverOwners.get(receiver)?.fd >= 0,
    });
    function createConnection(...args) {
        const [options, cb] = normalizeArgs(args);
        const socket = new Socket(options);
        if (options.timeout) socket.setTimeout(options.timeout);
        return socket.connect(options, cb);
    }
    return {
        Socket, Server, _normalizeArgs: normalizeArgs,
        createServer(options, listener) { return new Server(options, listener); },
        createConnection,
        connect: createConnection,
        isIP, isIPv4, isIPv6,
        getDefaultAutoSelectFamily() { return autoSelectFamilyDefault; },
        setDefaultAutoSelectFamily(value) { autoSelectFamilyDefault = boolean(value, 'value'); },
        getDefaultAutoSelectFamilyAttemptTimeout() { return attemptTimeoutDefault; },
        setDefaultAutoSelectFamilyAttemptTimeout(value) { attemptTimeoutDefault = timeout(value, 'value'); },
    };
})();

// net.BlockList and SocketAddress retain the pinned getter-only exports.
Object.defineProperties(net, _nodeAddressRules.netDescriptors);
net.Stream = net.Socket;

// ============================================================
// tls module — TLSSocket via libssl in the wasm sysroot
// ============================================================

const _nodeTlsContextTrust = _createNodeTlsContextTrust({
    constants: _nodeConstantBinding, require: id => _builtinModules[id],
    native: _nodeNative, values: _nodeValues, types: util.types, Buffer,
});

const tls = (() => {
    const nat = _nodeNative;
    const { SafeWeakMap: TlsWeakMap, ReflectApply: tlsApply, PromisePrototypeThen: tlsThen } = _createNodePrimordials();
    const nativeTLS = new TlsWeakMap();
    const toU8 = (b) => {
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof b === 'string') return Buffer.from(b, 'utf8');
        throw new TypeError('tls: chunk must be Buffer, Uint8Array, ArrayBuffer, or string');
    };

    // A fulfilled native write is still owned through the real stream callback.
    // Its acknowledgment is a private same-owner/Promise capability, not a fd.
    function finishNativeWrite(owner, pending, callback, error) {
        let returned = false;
        try { callback(error); returned = true; }
        finally {
            if (returned) nat.tlsWriteRelease(owner, pending);
            else {
                // A cleanup failure must not replace an original callback throw.
                try { nat.tlsWriteRelease(owner, pending); } catch (_) {}
            }
        }
    }
    function writeNative(owner, bytes, callback) {
        let pending;
        try { pending = nat.tlsWrite(owner, bytes); }
        catch (error) { callback(error); return; }
        try {
            tlsThen(pending,
                () => finishNativeWrite(owner, pending, callback, null),
                error => finishNativeWrite(owner, pending, callback, error));
        } catch (error) {
            // No reaction owns this operation if species/allocation admission
            // failed. Abort SSL before releasing its pending retry material.
            try { nat.tlsWriteRelease(owner, pending, true); } catch (_) {}
            callback(error);
        }
    }

    /* SSL state is prepared before DNS/connect over an actual empty TCP
       resource. TCP retains its descriptor; the private TLS owner roots that
       parent through request retirement. This is not yet Socket/TLSWrap. */
    class TLSSocket extends stream.Duplex {
        constructor(options) {
            super(options);
            nativeTLS.set(this, { owner: null, connect: null, destroyed: false,
                reading: false, writeQueue: [], handshakePending: true, attaching: false, referenced: true });
            this.servername = options?.servername || null;
            this.authorized = false;
            this.authorizationError = null;
        }

        _attach(tcpOwner) {
            const state = nativeTLS.get(this), owner = state.owner;
            if (state.destroyed) { nat.socketOwnerAbortAdoption(tcpOwner); return; }
            if (!owner || state.attaching) throw new Error('TLS socket has no prepared transport or is already starting');
            state.attaching = true;
            let pending;
            try { pending = nat.tlsConnect(owner); }
            catch (error) {
                state.attaching = false;
                state.handshakePending = false; this.destroy(error); return;
            }
            state.attaching = false;
            if (state.destroyed) { nat.tlsClose(owner); return; }
            tlsThen(pending, () => {
                if (state.destroyed || state.owner !== owner) { nat.tlsClose(owner); return; }
                state.handshakePending = false;
                try {
                    const verifyError = nat.tlsInfo(owner, 4);
                    this.authorized = verifyError === null;
                    this.authorizationError = verifyError === null ? null : verifyError.code;
                } catch (error) { this.destroy(error); return; }
                this.emit('secureConnect');
                this._scheduleRead(); this._flushWriteQueue();
            }, error => {
                state.handshakePending = false;
                if (!state.destroyed) this.destroy(error);
            });
        }
        _scheduleRead() {
            const state = nativeTLS.get(this), owner = state.owner;
            if (!owner || state.handshakePending || state.destroyed || state.reading) return;
            state.reading = true;
            let pending;
            try { pending = nat.tlsRead(owner, 64 * 1024); }
            catch (error) { state.reading = false; throw error; }
            tlsThen(pending, bytes => {
                let buffer;
                try { if (bytes.byteLength > 0) buffer = Buffer.from(bytes); }
                catch (error) {
                    // Preserve the actual fulfilled Promise/material for retry;
                    // do not acknowledge bytes the consumer could not own.
                    state.reading = false; throw error;
                }
                // Only the actual settled Promise can retire this ticket. A
                // stale completion cannot acknowledge a newer allocation/read.
                try { nat.tlsReadRelease(owner, pending); }
                catch (error) { state.reading = false; throw error; }
                state.reading = false;
                if (state.destroyed || state.owner !== owner) return;
                if (bytes.byteLength === 0) { this.push(null); return; }
                if (this.push(buffer)) this._scheduleRead();
            }, error => {
                try { nat.tlsReadRelease(owner, pending); }
                catch (releaseError) { error ||= releaseError; }
                state.reading = false;
                if (!state.destroyed) this.destroy(error);
            });
        }
        _read() { this._scheduleRead(); }
        _write(chunk, _encoding, cb) {
            const state = nativeTLS.get(this), buf = toU8(chunk);
            if (!state.owner || state.handshakePending) { state.writeQueue.push({ buf, cb }); return; }
            writeNative(state.owner, buf, cb);
        }
        _flushWriteQueue() {
            const state = nativeTLS.get(this), queue = state.writeQueue;
            state.writeQueue = [];
            for (const { buf, cb } of queue) writeNative(state.owner, buf, cb);
        }
        _destroy(err, callback) {
            const state = nativeTLS.get(this);
            if (state.destroyed) { callback(err); return; }
            state.destroyed = true;
            const connect = state.connect; state.connect = null;
            if (connect) connect.cancel();
            const owner = state.owner; state.owner = null;
            if (owner) {
                try { nat.tlsClose(owner); }
                catch (closeError) { err ||= closeError; }
            }
            const queue = state.writeQueue; state.writeQueue = [];
            for (const { cb } of queue) cb(err || new Error('tls socket destroyed'));
            callback(err);
        }
        _metadata(operation) {
            const state = nativeTLS.get(this);
            return state.owner && !state.handshakePending ? nat.tlsInfo(state.owner, operation) : null;
        }

        setEncoding(enc) { return super.setEncoding(enc); }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        ref() {
            const state = nativeTLS.get(this); state.referenced = true;
            state.connect?.ref(true); if (state.owner) nat.tlsRef(state.owner, true);
            return this;
        }
        unref() {
            const state = nativeTLS.get(this); state.referenced = false;
            state.connect?.ref(false); if (state.owner) nat.tlsRef(state.owner, false);
            return this;
        }
        getProtocol() { return this._metadata(1); }
        getCipher() { return this._metadata(2); }
        isSessionReused() { return this._metadata(3); }
        getFinished() {
            const bytes = this._metadata(5);
            if (bytes === null) return null;
            return bytes === undefined ? undefined : Buffer.from(bytes);
        }
        getPeerFinished() {
            const bytes = this._metadata(6);
            if (bytes === null) return null;
            return bytes === undefined ? undefined : Buffer.from(bytes);
        }
        getPeerCertificate() { return {}; }
    }

    TLSSocket.prototype.getPeerX509Certificate = function(detailed) {
        'use strict';
        const state = nativeTLS.get(this);
        const cert = state ? (state.owner ? nat.tlsX509(state.owner, false, _nodeX509.nativeHandlePrototype) : undefined)
            : this._handle?.getPeerX509Certificate();
        return cert ? new _nodeX509.InternalX509Certificate(cert) : undefined;
    };
    TLSSocket.prototype.getX509Certificate = function() {
        'use strict';
        const state = nativeTLS.get(this);
        const cert = state ? (state.owner ? nat.tlsX509(state.owner, true, _nodeX509.nativeHandlePrototype) : undefined)
            : this._handle?.getX509Certificate();
        return cert ? new _nodeX509.InternalX509Certificate(cert) : undefined;
    };

    const attachTLS = TLSSocket.prototype._attach;

    function connect(options, cb) {
        _nodePublicConstants.load('tls');
        if (typeof options === 'number') {
            /* (port, host?, opts?, cb?) Node-style overloads. */
            const port = options;
            const host = (typeof arguments[1] === 'string') ? arguments[1] : 'localhost';
            const o2 = (typeof arguments[2] === 'object') ? arguments[2] : {};
            const cb2 = (typeof arguments[arguments.length - 1] === 'function')
                ? arguments[arguments.length - 1] : null;
            options = Object.assign({ host, port }, o2);
            if (cb2) cb = cb2;
        }
        // Capture trust material and verification policy before TCP startup.
        // The native handshake claims its own SSL_CTX reference.
        const context = _nodeTlsContextTrust.create(options || {});
        const nativeOptions = { context, rejectUnauthorized: options?.rejectUnauthorized !== false };
        const sock = new TLSSocket(options);
        if (cb) sock.once('secureConnect', cb);
        const servername = options.servername || options.host || 'localhost';
        const state = nativeTLS.get(sock);
        let initialParent;
        function prepareTransport() {
            if (state.destroyed) throw new Error('TLS socket is destroyed');
            const previous = state.owner; state.owner = null;
            if (previous) nat.tlsClose(previous);
            const parent = nat.socketOwnerCreate();
            let owner;
            try { owner = nat.tlsPrepare(parent, servername, nativeOptions); }
            catch (error) { nat.socketOwnerAbortAdoption(parent); throw error; }
            if (state.destroyed) { nat.tlsClose(owner); throw new Error('TLS socket is destroyed'); }
            state.owner = owner;
            nat.tlsRef(owner, state.referenced);
            return parent;
        }
        // Actual SSL/parent construction precedes lookup, rather than assigning
        // TLS metadata to a post-connect resource. Retries get fresh authority.
        initialParent = prepareTransport();
        let operation;
        try {
            operation = _nodeBeginSocketConnection(options, undefined, undefined, true, (error, result) => {
                state.connect = null;
                if (error) { if (!state.destroyed) sock.destroy(error); return; }
                if (state.destroyed) { nat.socketOwnerAbortAdoption(result.owner); return; }
                tlsApply(attachTLS, sock, [result.owner]);
            }, () => {
                if (initialParent) { const parent = initialParent; initialParent = null; return parent; }
                return prepareTransport();
            });
            state.connect = operation;
            operation.ref(state.referenced);
            operation.start();
        } catch (error) {
            state.connect = null;
            operation?.cancel();
            if (!state.destroyed) sock.destroy(error);
            throw error;
        }
        return sock;
    }

    return { connect, TLSSocket };
})();

// Trust still comes from configured guest OpenSSL paths unless explicit CA
// material replaces it. Public default-store and SecureContext APIs remain open.
tls.rootCertificates = [];
tls.checkServerIdentity = _createNodeTlsIdentity({
    values: _nodeValues, net, domainToASCII: _nodeDomainHelpers.domainToASCII,
    canonicalizeIP: _nodeNetworkIP.canonicalizeIP,
});
tls.createSecureContext = _notImpl('tls', 'createSecureContext');

// ============================================================
// http / https modules — real HTTP/1.1 over net.Socket (http) and tls.TLSSocket (https)
//
// ClientRequest inherits the complete pinned OutgoingMessage framing owner.
// IncomingMessage and the native response parser own received HTTP state;
// net.Socket/TLSSocket own actual bytes. Agent and server ownership remain
// separate incomplete contracts.
// ============================================================

const _nodeHttpOutgoing = _createNodeHttpOutgoing({
    process, Buffer, stream, events, assert, types: util.types, async: _nodeAsyncPlatform,
    streamsState: _nodeStreamPlatform.require('internal/streams/state'), values: _nodeValues,
    insecureHTTPParser: _nodeNative.cliOptions?.insecureHttpParser === true,
    setUnrefTimeout(fn, delay) { return setTimeout(fn, delay).unref(); },
});
const _nodeHttpHeaders = _createNodeHttpHeaders({
    outgoing: _nodeHttpOutgoing,
    values: _nodeValues, Buffer, insecureHTTPParser: _nodeNative.cliOptions?.insecureHttpParser === true,
});
const STATUS_CODES = _nodeHttpHeaders.STATUS_CODES;
const _nodeHttp2Settings = _createNodeHttp2Settings({
    process, Buffer, values: _nodeValues, types: util.types, allocator: _nodeBufferAllocator,
});
const _nodeHttpIncoming = _createNodeHttpIncoming({
    stream, abort: _nodeEventPlatform.abort, process,
});

const _nodeHttpServerResponse = _createNodeHttpServerResponse({
    process, Buffer, outgoing: _nodeHttpOutgoing, incoming: _nodeHttpIncoming,
    STATUS_CODES, values: _nodeValues, assert,
    observation: _nodePerformance.observation, trace: _nodeConsolePlatform.trace,
    diagnostics: _nodeDiagnostics,
});

const HTTP_METHODS = _nodeNative.httpParser('methods').toSorted();

const makeResponseParser = _createNodeHttpParser({
    native: _nodeNative, incoming: _nodeHttpIncoming, Buffer, FastBuffer: _FastBuffer,
});

const _nodeHttpAgent = _createNodeHttpAgent({
    process, Buffer, URL: url.URL, net, events, stream, values: _nodeValues,
    async: _nodeAsyncPlatform, socketStream: _nodeSocketStream, outgoing: _nodeHttpOutgoing,
    assert: assert, getTLS: () => tls,
    getOptionValue: name => name === '--use-env-proxy' ? _nodeNative.cliOptions?.useEnvProxy : undefined,
});

function makeHttpModule({ connect, defaultPort, defaultProtocol, agentOwner }) {
    const protoLower = defaultProtocol.toLowerCase();

    // Per-origin keep-alive socket pool. Sequential npm fetches against the
    // same registry reuse one TLS connection instead of paying ~28 fresh
    // handshakes during `npm install vite`.
    const pool = new Map(); // "host:port" -> [sock, ...]
    function poolKey(host, port) { return host + ':' + port; }
    const MAX_POOL_PER_ORIGIN = 4;
    // After this many ms idle, destroy the socket. node-main.c's js_node_loop
    // exits only when there are no socket/tls watches; pooled sockets keep a
    // `nat.tlsRead` outstanding which counts as a watch and would block exit.
    const POOL_IDLE_MS = 500;
    function popLiveFromPool(key) {
        const bucket = pool.get(key);
        while (bucket && bucket.length) {
            const sock = bucket.pop();
            if (sock._poolTimer) { clearTimeout(sock._poolTimer); sock._poolTimer = null; }
            const idle = sock._idleHandler;
            sock.removeListener('close', idle);
            sock.removeListener('end', idle);
            sock.removeListener('error', idle);
            sock._idleHandler = null;
            if (!sock._idleDead) return sock;
        }
        return null;
    }
    function returnToPool(key, sock) {
        let bucket = pool.get(key);
        if (!bucket) { bucket = []; pool.set(key, bucket); }
        if (bucket.length >= MAX_POOL_PER_ORIGIN) {
            try { sock.destroy(); } catch (_) { /* ignore */ }
            return;
        }
        const onIdle = () => { sock._idleDead = true; };
        sock._idleHandler = onIdle;
        sock.once('close', onIdle);
        sock.once('end', onIdle);
        sock.once('error', onIdle);
        sock._poolTimer = setTimeout(() => {
            sock._poolTimer = null;
            try { sock.destroy(); } catch (_) { /* ignore */ }
        }, POOL_IDLE_MS);
        bucket.push(sock);
    }

    /* Normalize every supported `request()` argument shape into a flat
       options object. Accepts: URL string, WHATWG URL, Node-style
       options, plus the common (urlString, options, cb) overload. */
    function normalize(input, maybeOpts, maybeCb) {
        let opts = {};
        let cb = null;
        if (typeof input === 'string') {
            const u = url.parse(input);
            opts.protocol = u.protocol;
            opts.hostname = u.hostname;
            if (u.port) opts.port = parseInt(u.port, 10);
            opts.path = (u.pathname || '/') + (u.search || '');
        } else if (input && typeof input === 'object' && typeof input.href === 'string'
                   && typeof input.pathname === 'string') {
            // WHATWG URL or url.parse() output.
            opts.protocol = input.protocol;
            opts.hostname = input.hostname;
            if (input.port) opts.port = parseInt(input.port, 10);
            opts.path = (input.pathname || '/') + (input.search || '');
        }
        if (input && typeof input === 'object' && !(typeof input.href === 'string')) {
            // Plain options object.
            Object.assign(opts, input);
        }
        if (typeof maybeOpts === 'object' && maybeOpts !== null) {
            Object.assign(opts, maybeOpts);
        }
        if (typeof maybeOpts === 'function') cb = maybeOpts;
        if (typeof maybeCb === 'function') cb = maybeCb;
        return { opts, cb };
    }

    class ClientRequest extends _nodeHttpHeaders.OutgoingMessage {
        constructor(opts, cb) {
            super();
            if (agentOwner) agentOwner.select(this, opts);
            this.path = opts.path || '/';
            this._host = agentOwner ? agentOwner.host(opts) : opts.hostname || opts.host || 'localhost';
            // WHATWG URL gives `port = ''` when default; treat that like missing.
            this._port = agentOwner ? (opts.port || opts.defaultPort || this.agent?.defaultPort || defaultPort) :
                (opts.port != null && opts.port !== '') ? parseInt(opts.port, 10) : defaultPort;
            this._protocol = this.protocol || (opts.protocol || protoLower).toLowerCase();
            _nodeHttpHeaders.initialize(this, opts);

            if (!agentOwner && opts.headers) {
                for (const k of Object.keys(opts.headers)) {
                    this.setHeader(k, opts.headers[k]);
                }
            }
            if (!agentOwner && !this.getHeader('host')) {
                const portStr = this._port === defaultPort ? '' : `:${this._port}`;
                this.setHeader('Host', this._host + portStr);
            }
            if (!agentOwner && !this.getHeader('connection')) {
                this.setHeader('Connection', 'keep-alive');
            }
            // Pass-through TLS options for redirected calls and the initial connect.
            this._tlsOpts = {
                ca: opts.ca,
                rejectUnauthorized: opts.rejectUnauthorized,
                servername: opts.servername || this._host,
            };

            // Redirect knobs are non-Node extensions but the handoff explicitly
            // calls for them; keep off-by-default to mirror standard http.request.
            this._followRedirects = opts.followRedirects === true;
            this._maxRedirects = opts.maxRedirects ?? 10;
            this._redirectCount = opts.__redirectCount || 0;

            this._socket = null;
            this._connected = false;
            this._destroyed = false;
            this._redirected = false;
            this._requestErrorEmitted = false;
            const options = opts;
            const { validateInteger, validateBoolean, validateOneOf } = _nodeValues.validators;
            const { ERR_INVALID_ARG_VALUE } = _nodeValues.errors.codes;
  const maxHeaderSize = options.maxHeaderSize;
  if (maxHeaderSize !== undefined)
    validateInteger(maxHeaderSize, 'maxHeaderSize', 0);
  this.maxHeaderSize = maxHeaderSize;

  const insecureHTTPParser = options.insecureHTTPParser;
  if (insecureHTTPParser !== undefined) {
    validateBoolean(insecureHTTPParser, 'options.insecureHTTPParser');
  }

  this.insecureHTTPParser = insecureHTTPParser;

  const httpValidation = options.httpValidation;
  if (httpValidation !== undefined) {
    validateOneOf(httpValidation, 'options.httpValidation',
                  ['strict', 'relaxed', 'insecure']);
    if (insecureHTTPParser !== undefined) {
      throw new ERR_INVALID_ARG_VALUE(
        'options.httpValidation',
        httpValidation,
        'cannot be used together with options.insecureHTTPParser',
      );
    }
  }

  this.httpValidation = httpValidation;

  if (options.joinDuplicateHeaders !== undefined) {
    validateBoolean(options.joinDuplicateHeaders, 'options.joinDuplicateHeaders');
  }

  this.joinDuplicateHeaders = options.joinDuplicateHeaders;
            this._joinDuplicateHeaders = this.joinDuplicateHeaders;
            this.maxHeadersCount = null;
            this.reusedSocket = false;
            if (agentOwner && opts.timeout !== undefined) this.timeout = agentOwner.getTimerDuration(opts.timeout, 'timeout');
            this.shouldKeepAlive = true;
            if (agentOwner) agentOwner.keepAlive(this);
            this.upgradeOrConnect = false;
            this._responseEnded = false;
            this.once('finish', () => {
                if (this._responseEnded) process.nextTick(() => this._releaseSocket());
            });

            if (cb) this.once('response', cb);
            this._origCb = cb;
            // Expect commits/flushes the header before the body, as in the
            // pinned ClientRequest constructor and OutgoingMessage store owner.
            if (agentOwner) agentOwner.prepareHeaders(this, opts, this._host, this._port, opts.defaultPort || this.agent?.defaultPort || defaultPort);
            else if (this.getHeader('expect')) this._implicitHeader();

            if (agentOwner) {
                const connectionOptions = { __proto__: null, ...opts,
                    host: this._host, port: this._port };
                delete connectionOptions.signal;
                agentOwner.admit(this, connectionOptions);
            } else queueMicrotask(() => {
                if (this._destroyed) return;
                this._openSocket();
            });
        }

        _openSocket(admittedSocket) {
            const key = poolKey(this._host, this._port);
            this._sockPoolKey = key;
            let sock = admittedSocket || popLiveFromPool(key);
            const fromPool = admittedSocket ? !sock.connecting : sock != null;
            if (!sock) {
                sock = connect({
                    host: this._host,
                    port: this._port,
                    ca: this._tlsOpts.ca,
                    rejectUnauthorized: this._tlsOpts.rejectUnauthorized,
                    servername: this._tlsOpts.servername,
                });
            }
            this._socket = sock;
            this.socket = sock;
            sock._httpMessage = this;
            sock.on('drain', _nodeHttpOutgoing.onSocketDrain);
            this._fromPool = fromPool;
            this._headersReceived = false;

            const parser = makeResponseParser({
                socket: sock,
                joinDuplicateHeaders: this._joinDuplicateHeaders,
                method: this.method, maxHeaderSize: this.maxHeaderSize,
                insecureHTTPParser: this.insecureHTTPParser ?? _nodeNative.cliOptions?.insecureHttpParser === true,
                httpValidation: this.httpValidation,
                maxHeaderPairs: typeof this.maxHeadersCount === 'number' ? this.maxHeadersCount << 1 : undefined,
                onHeaders: (msg) => { this._headersReceived = true; this._onHeaders(msg); },
                onInformation: (info) => {
                    if (info.statusCode === 100) this.emit('continue');
                    this.emit('information', info);
                },
                onUpgrade: (msg, head) => this._onUpgrade(msg, head),
                onError: (err) => this._failed(err),
                onBackpressure: () => sock.pause(),
            });
            this._parser = parser;

            // A transport failure must not replay an already-sent request.
            const onData = (chunk) => parser.feed(chunk);
            const onEnd = () => {
                parser.end();
                if (!parser.completed && !this._destroyed && !this._redirected) {
                    const error = new Error('socket hang up'); error.code = 'ECONNRESET';
                    this._failed(error);
                }
            };
            const onClose = () => {
                if (!parser.completed) onEnd();
                this.destroyed = true;
                if (this.res && !this.res.complete) this.res.destroy(new _nodeValues.errors.ConnResetException('aborted',
                    this._requestError ? { cause: this._requestError } : undefined));
                this._closeRequest();
            };
            const onError = (err) => this._failed(err);
            sock.on('data', onData);
            sock.on('end', onEnd);
            sock.on('error', onError);
            sock.on('close', onClose);
            this._sockListeners = { onData, onEnd, onError, onClose };

            // net.Socket emits 'connect'; tls.TLSSocket emits 'secureConnect'.
            // Listen for both — only one will fire per transport. Pooled
            // sockets are already connected, so jump straight to ready.
            const onReady = () => {
                if (this._destroyed) return;
                this._connected = true;
                this._flush();

            };
            if (fromPool) {
                queueMicrotask(onReady);
            } else {
                sock.once('connect', onReady);
                sock.once('secureConnect', onReady);
            }
            // Expose the real socket only after parser/listener ownership is
            // installed, so reentrant writes/destruction have a valid owner.
            this.emit('socket', sock);
        }

        _releaseSocket() {
            const sock = this._socket;
            if (!sock || !this._responseEnded || !this.writableFinished) return;
            this._socket = null;
            if (this.res) this.res.socket = null;
            const lst = this._sockListeners;
            sock.removeListener('data', lst.onData);
            sock.removeListener('end', lst.onEnd);
            sock.removeListener('error', lst.onError);
            sock.removeListener('close', lst.onClose);
            sock.removeListener('drain', _nodeHttpOutgoing.onSocketDrain);
            this.destroyed = true;
            if (!agentOwner) {
                if (sock._httpMessage === this) sock._httpMessage = null;
                process.nextTick(() => this._closeRequest());
            }
            if (this._destroyed || this._redirected || this._respConnectionClose || !this.shouldKeepAlive) {
                if (agentOwner) process.nextTick(() => this._closeRequest());
                try { sock.destroy(); } catch (_) { /* ignore */ }
                return;
            }
            // Pause the underlying Readable: removing the 'data' listener does
            // NOT clear flowing=true, so chunks pushed while idle in the pool
            // would emit('data') to zero listeners and be silently dropped.
            // With flowing=false, push buffers; the next claimer's on('data')
            // triggers a drain into the new parser.
            if (!agentOwner) { try { sock.pause(); } catch (_) { /* ignore */ } }
            // No next request has been sent: extra bytes cannot be its response.
            // Retire the connection instead of assigning unsolicited bytes to it.
            const left = this._parser && this._parser.getRemainder();
            if (left && left.length > 0) { if (agentOwner) process.nextTick(() => this._closeRequest()); sock.destroy(); return; }
            if (agentOwner) {
                // Pinned responseKeepAlive resets only a socket actually being
                // released for reuse; closing/error paths already detached
                // the request timeout listener in responseOnEnd.
                if (this.timeoutCb) {
                    sock.setTimeout(0, this.timeoutCb); this.timeoutCb = null;
                }
                const asyncId = sock._handle ? sock._handle.getAsyncId() : undefined;
                _nodeAsyncPlatform.defaultTriggerAsyncIdScope(asyncId, process.nextTick, agentOwner.emitFreeNT, this);
            } else returnToPool(this._sockPoolKey, sock);
        }

        _implicitHeader() {
            _nodeHttpHeaders.store(this, `${this.method} ${this.path} HTTP/1.1\r\n`);
        }

        _onUpgrade(msg, head) {
            const sock = this._socket;
            if (!sock || this._destroyed) return;
            const lst = this._sockListeners;
            sock.removeListener('data', lst.onData);
            sock.removeListener('end', lst.onEnd);
            sock.removeListener('drain', _nodeHttpOutgoing.onSocketDrain);
            this.res = msg; msg.req = this;
            msg[_nodeHttpIncoming.kDetachAbortSignal]();
            this._socket = null;
            const name = this.method === 'CONNECT' ? 'connect' : 'upgrade';
            if (this.listenerCount(name) > 0) {
                this.upgradeOrConnect = true;
                sock.emit('agentRemove');
                sock.removeListener('close', lst.onClose);
                sock.removeListener('error', lst.onError);
                if (sock._httpMessage === this) sock._httpMessage = null;
                sock.readableFlowing = null;
                this.emit(name, msg, sock, head);
                this.destroyed = true;
                this._closed = true;
                this.emit('close');
            } else sock.destroy();
        }

        _onHeaders(msg) {
            if (this._destroyed) return;
            this.res = msg;
            msg.req = this;
            msg.once('end', () => {
                msg[_nodeHttpIncoming.kDetachAbortSignal]();
                this._responseEnded = true;
                this._ended = true;
                if (agentOwner && this.timeoutCb && this.socket) this.socket.removeListener('timeout', this.timeoutCb);
                process.nextTick(() => this._releaseSocket());
            });
            this._respConnectionClose = /(^|,)\s*close\s*(,|$)/i.test(msg.headers.connection || '');
            if (!this._parser.shouldKeepAlive) this.shouldKeepAlive = false;
            // Auto-redirect (opt-in).
            if (this._followRedirects
                && msg.statusCode >= 300 && msg.statusCode < 400
                && msg.headers.location
                && this._redirectCount < this._maxRedirects) {
                const loc = msg.headers.location;
                this._redirectTo(loc, msg);
                return;
            }
            // Drain the parser into the message even after we hand it off.
            if (!this.emit('response', msg)) msg._dump();
        }

        _redirectTo(location, _prev) {
            // Mark first so the synchronous 'close' fired by socket.destroy()
            // doesn't surface a phantom "connection closed before body" error.
            this._redirected = true;
            try {
                if (this._socket) this._socket.destroy();
            } catch (_) { /* ignore */ }
            // Resolve relative redirects against the current request URL.
            const baseHref = `${this._protocol}//${this._host}${this._port === defaultPort ? '' : ':' + this._port}${this.path}`;
            const absUrl = url.resolve(baseHref, location);
            const u = url.parse(absUrl);
            const targetProto = (u.protocol || this._protocol).toLowerCase();
            // Same-scheme redirects only — cross-scheme (http→https) is out of scope
            // for this slice. Real CDNs do upgrade-to-https; if Phase 5 hits one,
            // wire a cross-module registry back in.
            if (targetProto !== this._protocol) {
                this._failed(new Error('http: cross-scheme redirect not supported: ' + targetProto));
                return;
            }
            // Carry the original SNI through. Same-origin redirects (the
            // common case for npm-style flows) preserve cert validity that
            // way; cross-origin redirects are not in scope for this slice.
            const newOpts = {
                protocol: targetProto,
                hostname: u.hostname || this._host,
                port: u.port ? parseInt(u.port, 10) : undefined,
                path: (u.pathname || '/') + (u.search || ''),
                method: this.method,
                headers: this.getHeaders(),
                ca: this._tlsOpts.ca,
                rejectUnauthorized: this._tlsOpts.rejectUnauthorized,
                servername: this._tlsOpts.servername,
                followRedirects: true,
                maxRedirects: this._maxRedirects,
                __redirectCount: this._redirectCount + 1,
            };
            // The Host header must update for the new origin.
            delete newOpts.headers['host'];
            const next = request(newOpts);
            next.on('response', (msg) => this.emit('response', msg));
            next.on('error', (err) => this.emit('error', err));
            next.end();
        }

        _failed(err) {
            if (this._redirected) return;
            this._requestError ||= err;
            if (!this._requestErrorEmitted) {
                this._requestErrorEmitted = true;
                // A parser/transport error retires its real socket first;
                // request destroyed/close state belongs to the close callback.
                // Do not manufacture Writable destruction before that fence.
                if (this._socket) {
                    this._socket._hadError = true;
                    this._socket.destroy();
                }
                this.emit('error', err);
            }
        }

        _closeRequest() {
            if (this._closed) return;
            this._closed = true;
            // The pinned client discards output that could not reach its
            // socket on close; completed writes keep real socket callbacks.
            this.emit('close');
            this.outputData.length = 0;
        }

        abort() { this.destroy(); }
        destroy(err) {
            if (this.destroyed) return this;
            this.destroyed = true;
            this._destroyed = true;
            if (this.res) this.res._dump();
            if (this.writableFinished && this.res?.complete) return this;
            this._requestError = err;
            if (this._socket) this._socket.destroy(err);
            else process.nextTick(() => {
                if (err && !this._requestErrorEmitted) {
                    this._requestErrorEmitted = true;
                    this.emit('error', err);
                }
                this._closeRequest();
            });
            return this;
        }

        setTimeout(_ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setSocketKeepAlive() { return this; }

    }

    _nodeHttpHeaders.install(ClientRequest.prototype);
    if (agentOwner) agentOwner.installRequestPrototype(ClientRequest);

    function request(input, maybeOpts, maybeCb) {
        const { opts, cb } = normalize(input, maybeOpts, maybeCb);
        return new ClientRequest(opts, cb);
    }
    function get(input, maybeOpts, maybeCb) {
        const req = request(input, maybeOpts, maybeCb);
        req.end();
        return req;
    }

    const namespace = {
        STATUS_CODES, METHODS: HTTP_METHODS,
        ...(protoLower === 'http:' ? {
            IncomingMessage: _nodeHttpIncoming.IncomingMessage,
            ServerResponse: _nodeHttpServerResponse.ServerResponse,
            OutgoingMessage: _nodeHttpOutgoing.module.OutgoingMessage,
            validateHeaderName: _nodeHttpHeaders.validateHeaderName,
            validateHeaderValue: _nodeHttpHeaders.validateHeaderValue,
            isValidHeaderName: _nodeHttpHeaders.isValidHeaderName,
            isValidHeaderValue: _nodeHttpHeaders.isValidHeaderValue,
        } : {}),
        request, get,
        ClientRequest,
        Agent: agentOwner ? agentOwner.module.Agent : class Agent {},
        globalAgent: agentOwner ? agentOwner.module.globalAgent : {},
        createServer() {
            throw new Error('http.createServer is not yet implemented (Phase 4 part 2 shipped client-side only)');
        },
    };
    if (agentOwner) agentOwner.decorateNamespace(namespace);
    return namespace;
}

const http = makeHttpModule({
    agentOwner: _nodeHttpAgent,
    connect: (opts) => {
        const sock = new net.Socket();
        sock.connect(opts.port || 80, opts.host || 'localhost');
        return sock;
    },
    defaultPort: 80,
    defaultProtocol: 'http:',
});

const https = makeHttpModule({
    connect: (opts) => tls.connect({
        host: opts.host || 'localhost',
        port: opts.port || 443,
        ca: opts.ca,
        rejectUnauthorized: opts.rejectUnauthorized,
        servername: opts.servername || opts.host || 'localhost',
    }),
    defaultPort: 443,
    defaultProtocol: 'https:',
});

// ============================================================
// Module system (require/module)
// ============================================================

// Validate byte input without decoding it: replacement characters would hide
// malformed UTF-8. These predicates inspect bytes directly.
function _bufferInputBytes(input) {
    const typedArrayName = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
    // The intrinsic brand getter excludes DataView, including across realms.
    if (typedArrayName.call(input) !== undefined) {
        const proto = Object.getPrototypeOf(Uint8Array.prototype);
        const get = name => Object.getOwnPropertyDescriptor(proto, name).get.call(input);
        return new Uint8Array(get('buffer'), get('byteOffset'), get('byteLength'));
    }
    for (const constructor of [ArrayBuffer,
        typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null]) {
        if (!constructor) continue;
        let isBuffer = false;
        try {
            Object.getOwnPropertyDescriptor(constructor.prototype, 'byteLength').get.call(input);
            isBuffer = true;
        } catch (_) { /* The intrinsic getter rejects other object brands. */ }
        if (isBuffer) return new Uint8Array(input);
    }
    const error = new TypeError('The input argument must be a Buffer, TypedArray, or ArrayBuffer');
    error.code = 'ERR_INVALID_ARG_TYPE';
    throw error;
}

function _bufferIsAscii(input) {
    const bytes = _bufferInputBytes(input);
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
    return true;
}

function _bufferIsUtf8(input) {
    const bytes = _bufferInputBytes(input);
    for (let i = 0; i < bytes.length;) {
        const first = bytes[i++];
        if (first <= 0x7f) continue;
        let remaining, lower = 0x80, upper = 0xbf;
        if (first >= 0xc2 && first <= 0xdf) remaining = 1;
        else if (first >= 0xe0 && first <= 0xef) {
            remaining = 2;
            if (first === 0xe0) lower = 0xa0; // shortest encoding
            if (first === 0xed) upper = 0x9f; // exclude surrogate code points
        } else if (first >= 0xf0 && first <= 0xf4) {
            remaining = 3;
            if (first === 0xf0) lower = 0x90;
            if (first === 0xf4) upper = 0x8f; // U+10FFFF maximum
        } else return false;
        if (i + remaining > bytes.length || bytes[i] < lower || bytes[i] > upper) return false;
        i++;
        while (--remaining > 0) if (bytes[i] < 0x80 || bytes[i++] > 0xbf) return false;
    }
    return true;
}

let _nodeSqlite;
let _nodeSea;
let _nodeTestingPlatform;
function _getNodeTestingPlatform() {
    return _nodeTestingPlatform ??= _createNodeTestingPlatform({
        process, values: _nodeValues, assert, comparisons: _nodeCore.comparisons, types: util.types,
        inspection: _nodeInspection, events, abort: _nodeEventPlatform.abort, async: _nodeAsyncPlatform.api,
        eventTarget: _nodeEventPlatform.eventTarget,
        assertUtils: _nodeCore.require('internal/assert/utils'),
        getCallerLocation: _nodeNative.getCallerLocation,
        getStructuredStack: _nodeNative.getStructuredStack,
        getModuleResolver: () => _nodeModuleRecords.getModuleResolver(),
        timers, timerPromises: timersPromises, path, fs, fsUtils: _nodeFsStats, os: nodeOs,
        glob: _nodeGlobPlatform.require('internal/fs/glob'), console: _nodeConsolePlatform.api,
        importModule(specifier, parentURL, attributes) {
            return _nodeESMGraph.importModule(specifier, parentURL, attributes);
        },
        url: { ...url, isURL: value => value instanceof _nodeWebPlatform.URL,
            URLParse: value => _nodeWebPlatform.URL.parse(value) },
        vm: _builtinModules.vm, Module, diagnostics: _nodeDiagnostics.api, queueMicrotask,
        stream, streamRequire: name => _nodeStreamPlatform.require(name),
        getOptionValue: _createNodeTestOptionReader({ cliOptions: _nodeNative.cliOptions, values: _nodeValues }),
    });
}


const _nodeWorkerPlatform = _createNodeWorkerPlatform({
    native: _nodeNative, environment: _nodeNative.workerEnvironment, cliOptions: _nodeNative.cliOptions,
    initializeStartup: data => _initializeNodeWorkerStartup(data),
    process, EventEmitter: events.EventEmitter, values: _nodeValues, ports: _nodePortsPlatform,
    path, url, isURL: value => util.types.isURL ? util.types.isURL(value) : value instanceof _nodeWebPlatform.URL,
});
globalThis.__kandeloDispatchWorkers = _nodeWorkerPlatform.dispatch;

const _nodeLocksPlatform = _createNodeLocksPlatform({
    native: _nodeNative, values: _nodeValues, process, worker: _nodeWorkerPlatform.internal,
    types: util.types, diagnostics: _nodeDiagnostics.api,
    runInternalImmediate: _nodeAsyncPlatform.runInternalImmediate,
    eventRequire: name => _nodeEventPlatform.require(name),
});
globalThis.__kandeloDispatchLocks = _nodeLocksPlatform.dispatch;


const _nodeSys = _createNodeSysPlatform({
    process, values: _nodeValues,
    require: id => _builtinModules[id],
    compileSource: (source, filename) => _nodeNative.evalScriptAsFunction(source, filename, 1),
});
const _nodePublicConstants = _createNodePublicConstantModules({
    process, values: _nodeValues, binding: _nodeConstantBinding, crypto, tls,
    cliOptions: _nodeNative.cliOptions,
    require: id => _builtinModules[id],
    compileSource: (source, filename) => _nodeNative.evalScriptAsFunction(source, filename, 1),
});
let _nodeDomain, _nodeFfi, _nodeVmInternal;
const _builtinModules = {
    'path': path,
    'events': events,
    'buffer': _nodeBufferModule,
    'fs': fs,
    'fs/promises': fs.promises,
    'os': nodeOs,
    'util': util,
    get sys() { return _nodeSys.load(); },
    'util/types': util.types,
    'assert': assert,
    'assert/strict': assert.strict,
    'stream': stream,
    'url': url,
    'querystring': querystring,
    'string_decoder': string_decoder,
    'timers': timers,
    'timers/promises': timersPromises,
    // Standalone protocol settings only; session/stream/server owners remain gaps.
    'http2': _nodeHttp2Settings,
    'child_process': child_process,
    get crypto() { return _nodePublicConstants.load('crypto'); },
    'net': net,
    get tls() { return _nodePublicConstants.load('tls'); },
    'http': http,
    '_http_incoming': _nodeHttpIncoming,
    '_http_outgoing': _nodeHttpOutgoing.module,
    '_http_agent': _nodeHttpAgent.module,
    get https() { _nodePublicConstants.load('tls'); return https; },
    get zlib() { return _nodeStreamPlatform.require('zlib'); },
    'tty': {
        isatty: _nodeReadlinePlatform.isatty,
        ReadStream: class ReadStream extends stream.Readable {},
        WriteStream: class WriteStream extends stream.Writable {},
    },
    'module': null, // set below
    get constants() { return _nodePublicConstants.load('constants'); },
    get punycode() { return _nodeQueryCodecs.require('punycode'); },
    'dns': _nodeDnsPlatform.api,
    'dgram': _nodeDatagram.api,
    'readline': _nodeReadlinePlatform.api,
    'readline/promises': _nodeReadlinePlatform.promises,
    'perf_hooks': _nodePerformance.api,
    'worker_threads': _nodeWorkerPlatform.api,
    'cluster': {
        isMaster: true,
        isPrimary: true,
        isWorker: false,
    },
    'console': _nodeConsolePlatform.api,
    get trace_events() { return _nodeConsolePlatform.tracing; },
    'async_hooks': _nodeAsyncPlatform.api,
    get domain() { return _nodeDomain ??= _createNodeDomainPlatform({
        process, events, values: _nodeValues, async: _nodeAsyncPlatform,
    }); },
    'diagnostics_channel': _nodeDiagnostics.api,
    'v8': {
        // Only the configured engine GC budget is measured here. The other
        // required heap-statistic fields and per-space accounting remain gaps.
        getHeapStatistics() { return { heap_size_limit: _nodeNative.engineGcHeapLimit() }; },
        getHeapSpaceStatistics() { throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('v8.getHeapSpaceStatistics measurements'); },
    },
    'vm': _createNodeVmPlatform({ native: _nodeNative, values: _nodeValues, Buffer, FastBuffer: _FastBuffer, process, global: globalThis,
        installInternal: internal => { _nodeVmInternal = internal; },
        types: util.types, inspection: _nodeInspection, assert: _nodeCore.require('internal/assert'),
        getOptionValue: option => option === '--experimental-vm-modules' &&
            _nodeNative.cliOptions?.experimentalVmModules === true }),
    get test() { return _getNodeTestingPlatform().api; },
    get 'test/reporters'() { return _getNodeTestingPlatform().reporters; },
    get sea() { return _nodeSea ??= _createNodeSeaPlatform({ native: _nodeNative, values: _nodeValues,
        TextDecoder, Blob: _nodeBodyData.Blob }); },
    get ffi() { return _nodeFfi ??= _createNodeFfiLibrary({ native: _nodeNative, values: _nodeValues,
        Buffer, FastBuffer: _FastBuffer, process, types: util.types,
        // Enabled permission-model CLI activation is rejected by the current
        // process owner. This is its real ordinary mode, not enabled policy.
        permission: { isEnabled: () => false },
        getVfsLibraryReader() {
            if (_nodeFsTruncation.vfsState.handlers !== null) {
                // The pinned constructor consults this reader only for strings.
                // Main-library/null and native type validation must still work.
                return function readVirtualLibrary() {
                    throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Node mounted VFS FFI image owner');
                };
            }
            return null;
        } }); },
    get sqlite() { return _nodeSqlite ??= _createNodeSqlitePlatform({ native: _nodeNative, values: _nodeValues,
        util, Buffer, TextDecoder, URL: _nodeWebPlatform.URL, fileURLToPath: url.fileURLToPath,
        constants: _nodeNative.sqlite('constants'),
        markUncloneable: value => _nodeClonePlatform.protocol.markTransferMode(value, false, false) }); },
    'stream/web': _nodeWebPlatform.streams,
    'stream/promises': _nodeStreamPlatform.require('stream/promises'),
    get 'stream/consumers'() { return _nodeStreamPlatform.require('stream/consumers'); },
};

// ------------------------------------------------------------
// Post-registration: builtin exports added for the Claude Code link
// surface (Milestone 2 Phase A, task 1). These mutate the module
// objects/registry entries built above rather than restructure the
// `_builtinModules` object literal, mirroring the `stream/web` patch
// further down (search for `_builtinModules['stream/web']`).
// ------------------------------------------------------------
_nodeInspectionPathToFileURL = _builtinModules.url.pathToFileURL;
Object.defineProperty(_builtinModules.buffer, 'INSPECT_MAX_BYTES', {
    enumerable: true, configurable: true,
    get: _nodeInspection.getBufferInspectMaxBytes,
    set: _nodeInspection.setBufferInspectMaxBytes,
});

// One actual performance clock/observer owner for the global and builtin.
_nodePerformance.installGlobals(globalThis);

_builtinModules['path/posix'] = path.posix;
_builtinModules['path/win32'] = path.win32;

const _dnsPromises = _nodeDnsPlatform.promises;
_builtinModules['dns/promises'] = _dnsPromises;

// `ws` — the WebSocket npm package. Bun ships a native ws-compatible module,
// so Bun-bundled apps (Claude Code) mark `ws` external and expect the runtime
// to provide it; it is not in the bundle or the package. node-compat is that
// runtime layer, so it provides `ws` here. This is a MINIMAL honest module:
// the module object IS the `WebSocket` class (real ws's `module.exports`), so
// `import WebSocket from "ws"` and `require("ws")` resolve and the class,
// static ready-state constants, `instanceof`, and subclassing all work at
// module scope; but *constructing a live WebSocket throws* -- real WebSocket
// I/O over TLS is tracked future work (docs/posix-status.md). Verified via a
// scope probe: `claude -p` imports `ws` but never opens a socket, so this
// unblocks it without faking WebSocket behavior. Graduating this to a full,
// real ws client/server is the deferred follow-up.
_builtinModules['ws'] = (() => {
    function WebSocket() {
        throw new Error('ws (WebSocket client) is not implemented on spidermonkey-node');
    }
    // Static ready-state constants (read at module scope by consumers).
    WebSocket.CONNECTING = 0;
    WebSocket.OPEN = 1;
    WebSocket.CLOSING = 2;
    WebSocket.CLOSED = 3;
    function WebSocketServer() {
        throw new Error('ws (WebSocketServer) is not implemented on spidermonkey-node');
    }
    function createWebSocketStream() {
        throw new Error('ws (createWebSocketStream) is not implemented on spidermonkey-node');
    }
    // real ws attaches these onto the exported WebSocket function.
    WebSocket.WebSocket = WebSocket;
    WebSocket.WebSocketServer = WebSocketServer;
    WebSocket.Server = WebSocketServer;
    WebSocket.createWebSocketStream = createWebSocketStream;
    return WebSocket;
})();



// Register lazy iterator sources independently of the public option gate.
// Availability checks do not evaluate these modules or emit their warnings.
for (const id of ['stream/iter', 'zlib/iter']) {
    Object.defineProperty(_builtinModules, id, {
        enumerable: true, configurable: true,
        get: () => _nodeStreamPlatform.require(id),
    });
}

// WASI's unchanged public module emits its warning only when first required.
// The native owner is guest-local; missing engine/import prerequisites remain
// visible errors and are not replaced by the embedding host's node:wasi.
let _nodeWasiPlatform;
Object.defineProperty(_builtinModules, 'wasi', {
    enumerable: true, configurable: true,
    get() {
        return _nodeWasiPlatform ??= _createNodeWasiPlatform({ native: _nodeNative, values: _nodeValues });
    },
});

// Node exposes `node:module` as the CJS Module class itself: a
// constructor that doubles as the namespace for createRequire / _cache
// / _nodeModulePaths / etc., with a self-ref `Module.Module === Module`.
// jiti's CJS loader does `new Be.Module(filename)` and
// `Be.Module._nodeModulePaths(dir)`, so the shim must be a callable
// function with that static surface attached.
const _nodeModuleURLHref = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(_nodeWebPlatform.URL.prototype, 'href').get);
const _nodePackageURL = { URL: _nodeWebPlatform.URL,
    fileURLToPath: url.fileURLToPath, pathToFileURL: url.pathToFileURL,
    isURL(value) { try { _nodeModuleURLHref(value); return true; } catch (_) { return false; } },
};
const _nodePackageReader = _createNodePackageReader({
    native: _nodeNative, values: _nodeValues, path, url: _nodePackageURL,
    permissionEnabled: () => false,
    checkPermission() {
        if (_nodeFsTruncation.vfsState.handlers !== null)
            throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Node VFS package file owner');
    },
    errorMessage: errno => _nodeUv.getSystemErrorMessage(errno),
    getResolutionRoot() {
        if (_nodeFsTruncation.vfsState.handlers !== null)
            throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Node VFS package resolution root');
        return undefined;
    },
    getESMResolver() { return _nodePackagePolicy.resolver; },
    stat(filename) {
        const [stat, errno] = os.stat(filename);
        return errno === 0 ? ((stat.mode & 0o170000) === 0o40000 ? 1 : 0) : errno;
    },
});
const _nodePackageOptions = Object.freeze({
    conditions: Object.freeze(Array.from(_nodeNative.cliOptions?.conditions || [])),
    packageMapPath: _nodeNative.cliOptions?.packageMapPath || '',
    preserveSymlinks: _nodeNative.cliOptions?.preserveSymlinks === true,
    preserveSymlinksMain: _nodeNative.cliOptions?.preserveSymlinksMain === true,
});
const _nodeModuleSyntax = _createNodeModuleSyntax({
    native: _nodeNative, packages: _nodePackageReader, path,
    getRecords: () => _nodeModuleRecords,
    getFormat: () => _nodePackagePolicy.format,
    pathToFileURL: url.pathToFileURL, normalizeSource: _stripShebang,
    getOptionValue(name) {
        if (name === '--strip-types') return true;
        // Unsupported loader/preload flags reject at CLI; ordinary configured
        // startup has no registered loader or import list.
        if (name === '--experimental-loader') return _nodeNative.cliOptions?.experimentalLoaders || [];
        if (name === '--import') return _nodeNative.cliOptions?.imports || [];
        throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Module source option: ' + name);
    },
});
const _nodePackagePolicy = _createNodePackagePolicy({
    process, values: _nodeValues, path, url: _nodePackageURL, fs, fsUtils: _nodeFsStats,
    packages: _nodePackageReader,
    getBuiltinPolicy: () => _nodeBuiltinPolicy,
    getRecords: () => _nodeModuleRecords,
    getOptionValue(name) {
        const options = _nodePackageOptions;
        switch (name) {
            case '--conditions': return options?.conditions || [];
            case '--experimental-package-map': return options.packageMapPath;
            case '--preserve-symlinks': return options?.preserveSymlinks === true;
            case '--preserve-symlinks-main': return options?.preserveSymlinksMain === true;
            // Ordinary configured modes. Their unsupported switches still
            // reject at the CLI; flags do not imply completed API behavior.
            case '--require-module': return true;
            case '--no-addons': return false;
            case '--experimental-detect-module': return true;
            case '--strip-types': return true;
            case '--experimental-addon-modules': return true;
            case '--experimental-import-text': return false;
            case '--input-type': return '';
            default: throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Package option owner: ' + name);
        }
    },
    stat(filename) { const [st, errno] = os.stat(filename); return errno === 0 ? ((st.mode & 0o170000) === 0o40000 ? 1 : 0) : errno; },
    isFile: filename => _isReg(filename), realpath: filename => _moduleRealpath(filename),
    readHeader(filename) {
        let fd;
        try { fd = fs.openSync(filename, 'r'); } catch { return undefined; }
        try {
            const bytes = Buffer.alloc(4);
            let count;
            try { count = fs.readSync(fd, bytes, 0, 4, 0); } catch { return undefined; }
            return bytes.subarray(0, count);
        } finally { fs.closeSync(fd); }
    },
    containsModuleSyntax: (source, filename) => _nodeModuleSyntax.contains(source, filename),
});
const _nodeModuleRecords = _createNodeModuleRecords({
    path, process, values: _nodeValues, packages: _nodePackageReader, policy: _nodePackagePolicy,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder, Buffer,
    getMIME: () => _nodeCore.require('internal/mime'),
    readBuffer: filename => fs.readFileSync(filename),
    stat(filename) { const [stat, errno] = os.stat(filename); return errno === 0 ? ((stat.mode & 0o170000) === 0o40000 ? 1 : 0) : errno; },
    preserveSymlinks: _nodeNative.cliOptions?.preserveSymlinks === true,
    preserveSymlinksMain: _nodeNative.cliOptions?.preserveSymlinksMain === true,
    url: { URL: _nodeWebPlatform.URL, pathToFileURL: url.pathToFileURL, fileURLToPath: url.fileURLToPath,
        isURL(value) {
            try { _nodeModuleURLHref(value); return true; } catch (_) { return false; }
        } },
    debug: _nodeValues.require('internal/util/debuglog').debuglog('module'),
    safeGetenv: name => _nodeNative.environment('safeget', name),
    pendingDeprecation: _nodeNative.environment('safeget', 'NODE_PENDING_DEPRECATION') === '1',
    noDeprecation: process.noDeprecation === true,
    getResolutionRoot() {
        if (_nodeFsTruncation.vfsState.handlers !== null)
            throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Node VFS module resolution root');
        return undefined;
    },
    normalizeBuiltin: id => _nodeBuiltinPolicy.normalizeRequirableId(id),
    canBeRequiredByUsers: id => _nodeBuiltinPolicy.canBeRequiredByUsers(id),
    loadBuiltin: id => _builtinModules[id],
    initialFormat: filename => _nodeModuleSyntax.initialCommonJsFormat(filename),
    resolveFile: (request, basedir, paths) => _resolveFile(request, basedir, paths),
    realpath: filename => _moduleRealpath(filename),
    load: (request, parent, entry) => _loadCommonJsModule(request, parent, entry),
    read: filename => fs.readFileSync(filename, 'utf8'),
    loadJavaScript: (module, filename, content, format, hookSource) => _loadCommonJsJavaScript(module, filename, content, format, hookSource),
    compile: (module, content, filename, format) => _compileCommonJsModule(module, content, filename, format),
    loadNative(module, filename) {
        if (typeof process.dlopen !== 'function')
            throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('process.dlopen');
        return process.dlopen(module, filename);
    },
});
const Module = _nodeModuleRecords.Module;
Module.Module = Module;
Module.findPackageJSON = _nodePackageReader.findPackageJSON;
Module.SourceMap = _createNodeSourceMapPlatform({ values: _nodeValues }).SourceMap;
_builtinModules.module = Module;
_builtinModules.process = process;
const _nodeBuiltinPolicy = _createNodeBuiltinPolicy({
    ids: Object.keys(_builtinModules).sort(), values: _nodeValues,
    load: id => _builtinModules[id],
    getOptionValue: option => option === '--experimental-sqlite'
        ? _nodeNative.cliOptions?.experimentalSqlite === true
        : option === '--experimental-ffi' ? _nodeNative.cliOptions?.experimentalFfi === true
        : option === '--experimental-stream-iter' && _nodeNative.cliOptions?.experimentalStreamIter === true,
});
Module.builtinModules = Object.freeze(_nodeBuiltinPolicy.getAllBuiltinModuleIds());
Module.isBuiltin = _nodeBuiltinPolicy.isBuiltin;
process.getBuiltinModule = _nodeBuiltinPolicy.getBuiltinModule;

function _nodeResolveBuiltinId(id) {
    _nodeValues.validators.validateString(id, 'id');
    if (id === '') throw new _nodeValues.errors.codes.ERR_INVALID_ARG_VALUE('id', id, 'must be a non-empty string');
    const normalized = _nodeBuiltinPolicy.normalizeRequirableId(id);
    if (normalized !== undefined) return normalized;
    if (id.startsWith('node:')) throw new _nodeValues.errors.codes.ERR_UNKNOWN_BUILTIN_MODULE(id);
    return undefined;
}
Module._load = function(request, parent, isMain) {
    return _loadCommonJsModule(request, parent, isMain);
};

// `require('process')` and `import 'node:process'` both return the same
// global. Node ships this as a real builtin module; npm's chalk dependency
// (via its vendored supports-color) does `import process from 'node:process'`.

// Mode bits for stat(): S_IFDIR / S_IFREG match os.stat() return mode field.
function _isDir(p) {
    const [st, err] = os.stat(p);
    return err === 0 && (st.mode & 0o170000) === 0o40000;
}
function _isReg(p) {
    const [st, err] = os.stat(p);
    return err === 0 && (st.mode & 0o170000) === 0o100000;
}
function _moduleRealpath(p) {
    const [resolved, err] = os.realpath(p);
    if (err !== 0) _throwErrno(-err, 'realpath', p);
    return resolved;
}

// Resolve a package directory's main entry: package.json#main → index.js.
// Returns the resolved file path, or null if neither exists.
function _resolvePackageMain(pkgDir, request) {
    return _nodeModuleRecords.packageMain(pkgDir, request);
}

function _resolveFile(id, basedir, lookupPaths) {
    if (lookupPaths !== undefined) {
        const trailingSlash = id.endsWith('/') || id === '.' || id === '..' || id.endsWith('/.') || id.endsWith('/..');
        const search = path.isAbsolute(id) ? [''] : lookupPaths;
        for (const from of search) {
            const candidate = path.resolve(from, id);
            if (!trailingSlash) {
                if (_isReg(candidate)) return candidate;
                for (const extension of Object.keys(Module._extensions)) {
                    if (_isReg(candidate + extension)) return candidate + extension;
                }
            }
            if (_isDir(candidate)) {
                const main = _resolvePackageMain(candidate, id);
                if (main) return main;
            }
        }
        return null;
    }
    // Relative or absolute id: resolve against basedir without node_modules walk.
    // Bare '.' / '..' are valid (sigstore tuf does `require(".")` for sibling index.js).
    const isRelOrAbs = id.startsWith('/') || id.startsWith('./') || id.startsWith('../') ||
        id === '.' || id === '..';
    if (isRelOrAbs) {
        const baseAbs = id.startsWith('/') ? id : basedir + '/' + id;
        const norm = path.normalize(baseAbs);
        // 1. exact file
        if (_isReg(norm)) return norm;
        // 2. file + .js / .json
        if (!id.endsWith('.js') && !id.endsWith('.json') && !id.endsWith('.mjs') && !id.endsWith('.cjs')) {
            if (_isReg(norm + '.js')) return norm + '.js';
            if (_isReg(norm + '.json')) return norm + '.json';
        }
        // 3. directory: package.json#main → index.js
        if (_isDir(norm)) {
            const main = _resolvePackageMain(norm, id);
            if (main) return main;
        }
        return null;
    }

    // Bare specifier: walk node_modules upward.
    let dir = basedir;
    while (true) {
        const nmDir = dir + '/node_modules/' + id;
        // 1. nmDir as a regular file (rare: node_modules/foo as a single file)
        if (_isReg(nmDir)) return nmDir;
        // 2. nmDir + .js / .json
        if (_isReg(nmDir + '.js')) return nmDir + '.js';
        if (_isReg(nmDir + '.json')) return nmDir + '.json';
        // 3. nmDir is a directory: package.json#main → index.js
        if (_isDir(nmDir)) {
            const main = _resolvePackageMain(nmDir, id);
            if (main) return main;
        }
        if (dir === '/' || dir === '') break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// Shared across every _makeRequire — Node's module cache is process-global,
// keyed by absolute resolved path. Without this, circular requires loop
// forever (each module gets its own cache and re-evaluates the cycle).
const _moduleCache = Module._cache;
const _moduleApply = Reflect.apply;
const _moduleJSONParse = JSON.parse;
const _moduleCharCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
const _moduleStringSlice = Function.prototype.call.bind(String.prototype.slice);
let _mainModule;

function _parseCommonJsJSON(source, filename) {
    if (_moduleCharCodeAt(source, 0) === 0xfeff) source = _moduleStringSlice(source, 1);
    try { return _moduleJSONParse(source); }
    catch (error) {
        error.message = filename + ': ' + error.message;
        throw error;
    }
}

function _stripShebang(source) {
    if (source && source.charCodeAt(0) === 35 && source.charCodeAt(1) === 33) {
        const end = source.indexOf('\n');
        if (end < 0) return '';
        return '//' + source.slice(2);
    }
    return source;
}

function _commonJsNotFound(id, parent) {
    return _nodeModuleRecords.notFound(id, parent);
}

function _makeRequire(filename, entry = false) {
    return _nodeModuleRecords.make(filename, entry);
}

function _compileCommonJsModule(mod, source, filename, format) {
    if (format === 'module' || format === 'commonjs-typescript' || format === 'module-typescript' || format === 'typescript') {
        throw new _nodeValues.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Module._compile ' + format + ' source');
    }
    const wrappedFn = _nodeModuleSyntax.compile(source, filename);
    const dirname = path.dirname(filename);
    const require = _nodeModuleRecords.make(filename, false, mod);
    // Node reads exports once: a getter must not choose a different receiver
    // from the value passed as the wrapper's first argument.
    const exports = mod.exports;
    return _moduleApply(wrappedFn, exports, [exports, require, mod, filename, dirname]);
}

function _loadCommonJsJavaScript(mod, filename, source, loadedFormat, hookSource = false) {
    const format = loadedFormat ?? _nodeModuleSyntax.commonJsFormat(filename, source);
    if (format === 'module') {
        const identifier = _nodeModuleRecords.moduleURL(mod) || url.pathToFileURL(filename).href;
        if (hookSource) _nodeESMGraph.prepare(identifier, { __proto__: null, format, source });
        _nodeModuleRecords.setFormat(mod, format);
        mod.exports = _nodeNative.__kandeloRequireModule(identifier);
        return;
    }
    return mod._compile(source, filename, format);
}

function _loadCommonJsModule(id, parent, entry = false) {
    _nodeValues.validators.validateString(id, 'id');
    if (id === '') throw new _nodeValues.errors.codes.ERR_INVALID_ARG_VALUE('id', id, 'must be a non-empty string');
    let prepared = Module._cache[id] !== undefined && !Module._cache[id].loaded
        ? _nodeModuleRecords.pendingESM(Module._cache[id]) : undefined;
    const previous = prepared === undefined ? _nodeModuleRecords.cachedResolution(parent, id) : undefined;
    if (previous !== undefined) {
        prepared = _nodeModuleRecords.pendingESM(previous.module);
        if (prepared === undefined) return _nodeModuleRecords.cached(parent, previous.module);
    }
    const resolution = prepared ?? _nodeModuleRecords.resolve(id, parent, entry);
    const resolvedPath = resolution.filename;
    const resolved = resolvedPath;
    if (prepared === undefined && Module._cache[resolved] !== undefined && !Module._cache[resolved].loaded)
        prepared = _nodeModuleRecords.pendingESM(Module._cache[resolved]);
    let resultFromHook;
    const loadBuiltin = name => {
        const result = _nodeModuleRecords.loadBuiltin(name, resolution.url, resolution.format);
        resultFromHook = result.resultFromHook;
        return result;
    };
    if (id === resolution.url && id.startsWith('node:')) {
        const name = _nodeBuiltinPolicy.normalizeRequirableId(id);
        if (name !== undefined) {
            const result = loadBuiltin(name);
            if (resultFromHook === undefined) return result.builtinExports;
        }
    }
    if (prepared === undefined && resultFromHook === undefined && Module._cache[resolved] !== undefined)
        return _nodeModuleRecords.cached(parent, Module._cache[resolved]);
    const name = _nodeBuiltinPolicy.normalizeRequirableId(resolved);
    if (resultFromHook === undefined && name !== undefined && !resolved.startsWith('node:')) {
        const result = loadBuiltin(name);
        if (resultFromHook === undefined) return result.builtinExports;
    }

    // Preserve the separately owned Claude/npm/Bun asset branch; ordinary Node
    // records below have their own real Module/cache/extension transaction.
    if (globalThis.__kandeloAssetLoaders && globalThis.__kandeloAssetLoaders[resolved]) {
        const source = std.loadFile(resolved);
        if (source === null) throw _commonJsNotFound(id, parent);
        // Bun loader dispatch (M2 Phase J). bun-run installs
        // globalThis.__kandeloAssetLoaders (abs cache path -> class) from the
        // extract manifest. Honor it BEFORE shebang-strip, the .json-extension
        // check, and the ESM/CJS dispatch, so the loader byte is authoritative.
        // With no map present this is a no-op and require() behaves as before.
        const _assetLoader = globalThis.__kandeloAssetLoaders &&
            globalThis.__kandeloAssetLoaders[resolved];
        if (_assetLoader === 'text') {
            // Bun text loader: module.exports IS the raw file contents (no
            // shebang strip -- a .txt/.md may legitimately begin "#!").
            _moduleCache[resolved] = { exports: source };
            return source;
        }
        if (_assetLoader === 'file') {
            // Bun file loader: module.exports IS the absolute on-disk path.
            _moduleCache[resolved] = { exports: resolved };
            return resolved;
        }
        if (_assetLoader === 'json') {
            const exports = JSON.parse(source);
            _moduleCache[resolved] = { exports };
            return exports;
        }
        if (_assetLoader === 'napi') {
            throw new Error(`${id}: native Node addons (.node) are not ` +
                `supported on spidermonkey-node`);
        }

    }
    const isMain = entry && (!parent || resolved === parent.filename || resolved === _moduleRealpath(parent.filename));
    const mod = prepared === undefined ? _nodeModuleRecords.create(resolved, parent, isMain, resolvedPath) : Module._cache[resolved];
    if (prepared === undefined) _nodeModuleRecords.prepare(mod, resolution, resultFromHook);
    else { _nodeModuleRecords.takeESM(mod); _nodeModuleRecords.cached(parent, mod); }
    _nodeModuleRecords.rememberResolution(parent, id, resolved);
    Module._cache[resolved] = mod;
    if (isMain) {
        mod.id = '.'; _mainModule = mod; process.mainModule = mod;
    }
    try {
        mod.load(resolved);
    } catch (error) {
        delete Module._cache[resolved];
        _nodeModuleRecords.forgetResolution(parent, id);
        _nodeModuleRecords.failed(isMain ? null : parent, mod);
        throw error;
    }
    _nodeModuleRecords.complete(mod);
    return mod.exports;
}

function _nearestPackageType(filename) {
    return _nodePackageReader.getNearestParentPackageJSON(filename).data.type;
}

function _looksLikeEsmMain(filename, source) {
    return _nodeModuleSyntax.entryIsModule(filename, source);
}

// Natural shutdown retains the pre-event status if a listener clears the
// assignment. Explicit process.exit() instead defaults an unset status to 0.
function _runNaturalExit(failureStatus = 0, returnStatus = false) {
    if (failureStatus && !process._exiting) process.exitCode = failureStatus;
    const status = process.exitCode === undefined ? failureStatus : process.exitCode;
    if (!process._exiting) {
        process._exiting = true;
        if (failureStatus === 1) {
            // Node's fatal-exception exit path suppresses a second failure
            // from exit listeners. The original failure was already reported.
            try { process.emit('exit', status); } catch (_) {}
        } else {
            process.emit('exit', status);
        }
    }
    const finalStatus = process.exitCode === undefined ? status : process.exitCode;
    if (returnStatus) return finalStatus;
    std.exit(finalStatus);
}

function _runCommonJsMain(filename) {
    const mainRequire = _makeRequire(filename, true);
    mainRequire(filename);
}

function _formatThrownFailure(failure) {
    if (!failure) return String(failure);
    const text = String(failure);
    const name = failure.name ? String(failure.name) : 'Error';
    const message = failure.message ? String(failure.message) : '';
    const headline = message ? `${name}: ${message}` : text;
    const stack = failure.stack ? String(failure.stack) : '';
    if (!stack) return headline;
    if (stack.indexOf(headline) >= 0 || (message && stack.indexOf(message) >= 0)) {
        return stack;
    }
    return headline + '\n' + stack;
}

// Module parsing, linking, cycles and top-level await belong to the engine's
// native module loader. File execution returns to the owning event loop; it
// must not quit merely because the initial script evaluation completed.
let _esmMainPending = false;
function _runEsmMain(filename) {
    _esmMainPending = true;
    _nodeNative.importModule(filename).then(
        () => { _esmMainPending = false; },
        failure => {
            _esmMainPending = false;
            // A failed entry graph is fatal even with live timers or I/O.
            // Preserve the thrown value for the engine's rejection checkpoint;
            // merely assigning exitCode would wait for all handles to drain.
            throw failure;
        },
    );
}

function _runMainScriptIfPresent() {
    if (!_mainScriptPath) return;
    const source = std.loadFile(_mainScriptPath);
    if (source === null) {
        const err = new Error(`Cannot find module '${_mainScriptPath}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
    }
    if (_looksLikeEsmMain(_mainScriptPath, source)) {
        _runEsmMain(_mainScriptPath);
    } else {
        _runCommonJsMain(_mainScriptPath);
    }
}

// ============================================================
// Set up globals
// ============================================================

// The engine adapter captures the entry point's arguments before user code.
if (typeof execArgv !== 'undefined') {
    process.argv = Array.from(execArgv);
    process.argv0 = typeof argv0 !== 'undefined' ? argv0 : (process.argv[0] || 'node');
}

// Global require. For `node script.js`, basedir is the script's directory
// so its top-level relative requires resolve against itself, matching Node's
// per-file require semantics. For -e/-p/REPL (no script in argv), basedir
// falls back to cwd.
globalThis.require = _makeRequire(
    _nodeNative.mainScriptPath || process.cwd() + '/repl'
);

// --- Native ESM bare-specifier bridge ---------------------------------------
// The SpiderMonkey shell module loader resolves every import specifier as a
// file path. A bare specifier such as `import ... from "fs"` therefore becomes
// `//fs` and fails with "can't open //fs". Node treats a bare specifier (one
// that does not start with "./", "../", or "/") as a builtin or a node_modules
// package. We route those through the existing node-compat resolver so that a
// natively-loaded ES module receives the same object `require()` would return.
//
// The C shell loader (js/src/shell/ModuleLoader.cpp, patched via
// patches/0015-kandelo-esm-bare-specifier.patch) calls __kandeloResolveBare for
// specifiers, including relative/absolute CommonJS imports. ESM paths stay in
// the native module graph. For CommonJS we return a stable synthetic path and
// stash the generated ES-module source in __kandeloBareSources under that same
// token; the loader's fetchSource() serves it instead of reading a file. The
// synthetic source reads the real module object back out of __kandeloBareModules
// so its default is the object require() produced; named exports snapshot its
// current enumerable properties. Static CommonJS export discovery remains a
// compatibility gap. Namespace generation stays here in JS.
globalThis.__kandeloBareModules = Object.create(null);
globalThis.__kandeloBareSources = Object.create(null);

// Identifiers that cannot appear after `export const` (reserved words). Own
// enumerable keys that collide with these are exposed only via the default
// export, matching the safe subset Node's ESM interop provides for CJS.
const _esmReservedNames = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
    'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
    'implements', 'interface', 'package', 'private', 'protected', 'public',
    'await',
]);

function _makeBareEsmSource(token, obj) {
    const keyJson = JSON.stringify(token);
    let src = 'const __m = globalThis.__kandeloBareModules[' + keyJson + '];\n' +
        'export default __m;\n';
    if (obj !== null && (typeof obj === 'object' || typeof obj === 'function')) {
        const seen = Object.create(null);
        let keys;
        try {
            keys = Object.keys(obj);
        } catch (_e) {
            keys = [];
        }
        for (const key of keys) {
            if (key === 'default') continue;
            if (seen[key]) continue;
            if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) continue;
            if (_esmReservedNames.has(key)) continue;
            seen[key] = true;
            src += 'export const ' + key + ' = __m[' + JSON.stringify(key) + '];\n';
        }
    }
    return src;
}

const _nodeESMGraph = _createNodeESMGraphPlatform({
    records: _nodeModuleRecords, values: _nodeValues, native: _nodeNative,
    path, process, url: { URL: _nodeWebPlatform.URL, pathToFileURL: url.pathToFileURL,
        fileURLToPath: url.fileURLToPath },
    TextDecoder: globalThis.TextDecoder, types: util.types,
    normalizeBuiltin: id => _nodeBuiltinPolicy.normalizeRequirableId(id),
    loadBuiltin: id => _builtinModules[id], parseJSON: _parseCommonJsJSON,
});
globalThis.__kandeloResolveBare = function(specifier, referrerPath, resolveOnly = false, attributes, request) {
    if (typeof specifier !== 'string') return null;
    return _nodeESMGraph.resolve(specifier, referrerPath, attributes, resolveOnly, request);
};
globalThis.__kandeloModuleRecord = _nodeESMGraph.record;
globalThis.__kandeloLoadModule = _nodeESMGraph.load;
globalThis.__kandeloModuleFailed = _nodeESMGraph.failed;

// The native hook supplies the actual new import.meta object. Native DATA
// cells initialize file path helpers on that owner without eager copying.
// Existing require extension and native resolve hook remain independent.
globalThis.__kandeloModuleMeta = _createNodeImportMetaPlatform({
    canonical: _nodeESMGraph.canonical, URL: _nodeWebPlatform.URL,
    fileURLToPath: url.fileURLToPath, makeRequire: _makeRequire, process,
    defineNativeLazyDataProperty: _nodeNative.defineNativeLazyDataProperty,
});

// Node.js globals
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.global = globalThis;

// Timer globals — overwrite the js_std_add_helpers stubs that return a
// raw int64 with the wrapped-id objects from `timers` above.
globalThis.setTimeout = timers.setTimeout;
globalThis.clearTimeout = timers.clearTimeout;
globalThis.setInterval = timers.setInterval;
globalThis.clearInterval = timers.clearInterval;
globalThis.setImmediate = timers.setImmediate;
globalThis.clearImmediate = timers.clearImmediate;

// npm and hosted-git-info instantiate URL/URLSearchParams directly without
// `require('url')`. Expose the bootstrap shims when the engine does not ship them.
globalThis.URL = url.URL;
globalThis.URLSearchParams = url.URLSearchParams;

// Web platform globals that modern Node exposes by default. undici/whatwg-
// fetch reach for these at module init (e.g. `webidl.is.ReadableStream =
// MakeTypeAssertion(ReadableStream)` in undici/lib/web/webidl/index.js).
// Streams share the vendored implementation with fetch response bodies.
const _streamWeb = _builtinModules['stream/web'];
// The interface list follows the pinned exposed-wildcard bootstrap. Module,
// globals, Blob and Fetch use the same owned Node stream constructors.
const _nodeStreamInterfaces = [
    'TransformStream', 'TransformStreamDefaultController', 'WritableStream',
    'WritableStreamDefaultController', 'WritableStreamDefaultWriter', 'ReadableStream',
    'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
    'ReadableByteStreamController', 'ReadableStreamDefaultController', 'ByteLengthQueuingStrategy',
    'CountQueuingStrategy', 'TextEncoderStream', 'TextDecoderStream',
    'CompressionStream', 'DecompressionStream',
];
for (const name of _nodeStreamInterfaces) globalThis[name] = _streamWeb[name];
// Shared byte ownership for Blob and Fetch bodies. Byte inputs are copied at
// construction; reading a returned ArrayBuffer never exposes stored bytes.
const _nodeBodyData = (() => {
    const Bytes = Uint8Array;
    const proto = Object.getPrototypeOf(Bytes.prototype);
    const get = (object, name) => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(object, name).get);
    const typedName = get(proto, Symbol.toStringTag), typedBuffer = get(proto, 'buffer');
    const typedOffset = get(proto, 'byteOffset'), typedLength = get(proto, 'byteLength');
    const dataBuffer = get(DataView.prototype, 'buffer'), dataOffset = get(DataView.prototype, 'byteOffset');
    const dataLength = get(DataView.prototype, 'byteLength'), abLength = get(ArrayBuffer.prototype, 'byteLength');
    const sharedLength = typeof SharedArrayBuffer === 'function' ? get(SharedArrayBuffer.prototype, 'byteLength') : null;
    const isView = ArrayBuffer.isView, slice = Function.prototype.call.bind(Bytes.prototype.slice);
    const blobs = new WeakMap();
    const { createSequenceConverter, converters } = _nodeEventPlatform.require('internal/webidl');
    const { validateDictionary } = _nodeValues.validators;
    const { kEmptyObject } = _nodeValues.util;
    const { ERR_INVALID_ARG_VALUE, ERR_BUFFER_TOO_LARGE } = _nodeValues.errors.codes;
    const { isAnyArrayBuffer, isArrayBufferView } = _nodeValues.require('internal/util/types');
    const kMaxLength = _nodeBufferConstants.MAX_LENGTH;
    const isBlob = value => blobs.has(value);
    const sourcesConverter = createSequenceConverter((source, opts = kEmptyObject) => {
      if (isBlob(source) || isAnyArrayBuffer(source) || isArrayBufferView(source)) {
        return source;
      }
      return converters.DOMString(source, opts);
    });
    function blobError(message, code = 'ERR_INVALID_ARG_TYPE') {
        const error = new TypeError(message); error.code = code; throw error;
    }
    function copyBytes(value) {
        if (isView(value)) {
            const typed = typedName(value) !== undefined;
            return slice(new Bytes(typed ? typedBuffer(value) : dataBuffer(value),
                typed ? typedOffset(value) : dataOffset(value), typed ? typedLength(value) : dataLength(value)));
        }
        let buffer = false;
        try { abLength(value); buffer = true; }
        catch (_) {
            if (sharedLength) try { sharedLength(value); buffer = true; } catch (_) { /* Not an ArrayBuffer. */ }
        }
        return buffer ? slice(new Bytes(value)) : null;
    }
    function byteChunk(value) {
        if (typedName(value) !== 'Uint8Array') throw new TypeError('Body stream chunk must be a Uint8Array');
        return new Bytes(typedBuffer(value), typedOffset(value), typedLength(value));
    }
    function stringBytes(value, nativeEndings = false) {
        if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
        const text = String(value);
        return new TextEncoder().encode(nativeEndings ? text.replace(/\r\n|\r/g, '\n') : text);
    }
    function options(value) {
        if (value == null) return {};
        if (typeof value !== 'object' && typeof value !== 'function') throw new TypeError('Options must be an object');
        return value;
    }
    function type(value) {
        if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
        const result = String(value);
        return /[^\x20-\x7e]/.test(result) ? '' : result.toLowerCase();
    }
    function stream(bytes) {
        let offset = 0;
        return new _nodeWebPlatform.streams.ReadableStream({ type: 'bytes', pull(controller) {
            const end = Math.min(offset + 65536, bytes.byteLength);
            if (end > offset) controller.enqueue(slice(bytes, offset, end));
            offset = end;
            if (offset === bytes.byteLength) {
                controller.close();
                if (controller.byobRequest) controller.byobRequest.respond(0);
            }
        } });
    }
    function data(blob) {
        const result = blobs.get(blob);
        if (!result) blobError('Illegal Blob receiver', 'ERR_INVALID_THIS');
        return result;
    }
    class Blob {
        constructor(parts = [], init) {
            _nodeClonePlatform.protocol.markTransferMode(this, true, false);
            // The complete pinned sequence conversion runs before dictionary
            // access and before copying any BufferSource. Strings are coerced
            // during iteration; byte sources stay real owners until that pass
            // completes, so later hooks can still mutate their stored bytes.
            const sources = sourcesConverter(parts);
            validateDictionary(init, 'options');
            let { endings = 'transparent', type: contentType = '' } = init ?? kEmptyObject;
            endings = `${endings}`;
            if (endings !== 'transparent' && endings !== 'native')
                throw new ERR_INVALID_ARG_VALUE('options.endings', endings);
            const values = [];
            let total = 0;
            for (let i = 0; i < sources.length; ++i) {
                const part = sources[i];
                const blob = blobs.get(part);
                const bytes = blob ? blob.bytes : copyBytes(part) ?? stringBytes(part, endings === 'native');
                values.push(bytes); total += bytes.byteLength;
            }
            if (total > kMaxLength) throw new ERR_BUFFER_TOO_LARGE(kMaxLength);
            const bytes = new Bytes(total);
            let offset = 0;
            for (const part of values) { bytes.set(part, offset); offset += part.byteLength; }
            // Match the pinned order: type's getter already ran, but its
            // string coercion follows actual byte storage construction.
            blobs.set(this, { bytes, type: type(contentType) });
        }
        [_nodeClonePlatform.protocol.kClone]() {
            const stored = data(this);
            // The private hook remains reflectable like Node's hook. Return
            // independent bytes so calling it cannot mutate Blob storage.
            return { data: { bytes: slice(stored.bytes), type: stored.type },
                deserializeInfo: 'internal/blob:Blob' };
        }
        [_nodeClonePlatform.protocol.kDeserialize]({ bytes, type }) {
            data(this); // Validate the actual Blob receiver before replacing storage.
            blobs.set(this, { bytes: slice(bytes), type });
        }
        get size() { return data(this).bytes.byteLength; }
        get type() { return data(this).type; }
        async arrayBuffer() { return slice(data(this).bytes).buffer; }
        async bytes() { return slice(data(this).bytes); }
        async text() { return new TextDecoder().decode(data(this).bytes); }
        stream() { return stream(data(this).bytes); }
        textStream() {
            const decoder = new TextDecoder();
            return stream(data(this).bytes).pipeThrough(new _nodeWebPlatform.streams.TransformStream({
                transform(bytes, controller) {
                    const text = decoder.decode(bytes, { stream: true });
                    if (text) controller.enqueue(text);
                },
                flush(controller) { const text = decoder.decode(); if (text) controller.enqueue(text); },
            }));
        }
        slice(start = 0, end = undefined, contentType = '') {
            const bytes = data(this).bytes, size = bytes.byteLength;
            start = converters['long long'](
                start, { __proto__: null, context: 'start', clamp: true });
            end = converters['long long'](
                end === undefined ? size : end,
                { __proto__: null, context: 'end', clamp: true });
            start = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
            end = end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
            contentType = type(contentType);
            const span = Math.max(end - start, 0);
            // The real private byte allocation supplies this slice. Public
            // TypedArray species/subarray methods do not own Blob slicing.
            return new Blob([new Bytes(typedBuffer(bytes), typedOffset(bytes) + start, span)], { type: contentType });
        }
        get [Symbol.toStringTag]() { return 'Blob'; }
    }
    Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: 'Blob', configurable: true });
    for (const name of ['size', 'type', 'slice', 'stream', 'textStream', 'text', 'arrayBuffer', 'bytes']) {
        Object.defineProperty(Blob.prototype, name, { enumerable: true });
    }
    // The clone protocol allocates an actual empty receiver, then supplies its
    // owned payload through kDeserialize. File shares this Blob storage owner.
    function TransferableBlob() {
        Object.setPrototypeOf(this, Blob.prototype);
        _nodeClonePlatform.protocol.markTransferMode(this, true, false);
        blobs.set(this, { bytes: new Bytes(0), type: '' });
    }
    Object.setPrototypeOf(TransferableBlob.prototype, Blob.prototype);
    Object.setPrototypeOf(TransferableBlob, Blob);
    return { Blob, TransferableBlob, copyBytes, byteChunk, stringBytes, stream, options, blob: value => blobs.get(value) };
})();
if (typeof globalThis.Blob === 'undefined') globalThis.Blob = _nodeBodyData.Blob;
_builtinModules['buffer'].Blob = globalThis.Blob;
const _nodeFilePlatform = _createNodeFilePlatform({
    blob: _nodeBodyData, values: _nodeValues, inspection: _nodeInspection, clone: _nodeClonePlatform,
});
globalThis.File = _nodeFilePlatform.File;
_builtinModules['buffer'].File = _nodeFilePlatform.File;
if (typeof globalThis.Headers === 'undefined') globalThis.Headers = class Headers {};
if (typeof globalThis.Request === 'undefined') globalThis.Request = class Request {};
if (typeof globalThis.Response === 'undefined') globalThis.Response = class Response {};
// Module, global, WebIDL and stream consumers share actual port constructors.
globalThis.MessagePort = _nodePortsPlatform.MessagePort;
globalThis.MessageChannel = _nodePortsPlatform.MessageChannel;
const _nodeFormDataPlatform = _createNodeFormDataPlatform({
    Blob: _nodeBodyData.Blob, File: _nodeFilePlatform.File,
    ReadableStream: _nodeStreamPlatform.web.ReadableStream,
    URL: _nodeWebPlatform.URL, URLSearchParams: _nodeWebPlatform.URLSearchParams,
    AbortSignal: globalThis.AbortSignal, MessagePort: globalThis.MessagePort, Event: globalThis.Event,
    values: _nodeValues, assert, util, crypto, clone: _nodeClonePlatform,
});
globalThis.FormData = _nodeFormDataPlatform.FormData;
globalThis.Headers = _nodeFormDataPlatform.headers.Headers;
globalThis.BroadcastChannel = _nodePortIO.BroadcastChannel;
const _nodeObjectMarks = _createNodeObjectMarks({ native: _nodeNative, isArrayBuffer: util.types.isArrayBuffer });
Object.assign(_builtinModules.worker_threads, {
    markAsUncloneable: _nodePortIO.markAsUncloneable,
    markAsUntransferable: _nodeObjectMarks.markAsUntransferable,
    isMarkedAsUntransferable: _nodeObjectMarks.isMarkedAsUntransferable,
    MessagePort: _nodePortsPlatform.MessagePort, MessageChannel: _nodePortsPlatform.MessageChannel,
    receiveMessageOnPort: _nodePortIO.receiveMessageOnPort,
    moveMessagePortToContext: _nodePortIO.moveMessagePortToContext,
    BroadcastChannel: _nodePortIO.BroadcastChannel,
});
// Match the pinned worker_threads module: install the pending native export
// after the actual ordinary Worker/port/object-mark exports have been assembled.
_nodeLocksPlatform.install(_nodeWorkerPlatform.api);
// Web Crypto global. Modern Node (19+) exposes `globalThis.crypto` separately
// from `require('crypto')`. uuid/dist-node/rng.js and many other packages
// reach for the bare `crypto.getRandomValues()` here without importing
// anything — undefined crypto → silent rejection during session init.
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {
        getRandomValues: crypto.getRandomValues,
        randomUUID: crypto.randomUUID,
        // Subtle is left unimplemented; consumers that actually need it
        // will fail loudly, which is preferable to a silent stub.
    };
}

// Node owns this realm's Web event interfaces independently of the host.
// Link the pinned listener/cancellation algorithms to the real scheduler.
Object.assign(globalThis, {
    MessageEvent: _nodeFormDataPlatform.messageEvents.MessageEvent,
    CloseEvent: _nodeFormDataPlatform.messageEvents.CloseEvent,
    ErrorEvent: _nodeFormDataPlatform.messageEvents.ErrorEvent,
});

// Some engines ship without ECMA-402 (Intl). TUIs use Intl.Segmenter for
// grapheme-based terminal-width math; a per-code-point fallback is good
// enough for ASCII / BMP — non-trivial graphemes (emoji ZWJ sequences,
// combining marks) collapse to multiple segments, which most UIs tolerate.
if (typeof globalThis.Intl === 'undefined') {
    globalThis.Intl = {
        Segmenter: class Segmenter {
            constructor(_locale, _options) {}
            segment(input) {
                const s = String(input);
                return {
                    [Symbol.iterator]: function* () {
                        let i = 0;
                        for (const ch of s) {
                            yield { segment: ch, index: i, input: s };
                            i += ch.length;
                        }
                    },
                };
            }
        },
        Collator: class Collator {
            constructor(_l, _o) {}
            compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
        },
        DateTimeFormat: class DateTimeFormat {
            constructor(_l, _o) {}
            format(date) { return new Date(date).toISOString(); }
        },
        NumberFormat: class NumberFormat {
            constructor(_l, _o) {}
            format(n) { return String(n); }
        },
    };
}

// __dirname and __filename for the main module (set when running a file)
const _mainScriptArg = _nodeNative.mainScriptPath || '';
let _mainScriptPath = _mainScriptArg ? _moduleRealpath(_mainScriptArg) : '';
globalThis.__filename = _mainScriptPath;
globalThis.__dirname = _mainScriptPath ? path.dirname(_mainScriptPath) : '';

// Module reference
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;

// ============================================================
// WHATWG fetch + Headers/Response/Request/ReadableStream
// ============================================================
//
// HTTP clients call `fetch(url, { method:'POST', body, headers })`
// and read the response via `await res.json()` or `res.body.getReader()`
// (for streaming SSE). The transport uses the existing http/https modules;
// response bodies use the same Web Streams classes as consumer-created streams.
//
(() => {
    const FetchHeaders = _nodeFormDataPlatform.headers.Headers;

    // HTTP bodies and consumer-created streams must use the same class.
    // A start-only shim strands clients that wrap a body with a pull source.
    const WebReadableStream = _nodeWebPlatform.streams.ReadableStream;

    const bodyPlatform = _createNodeFetchBodyPlatform({
        Buffer, Blob: _nodeBodyData.Blob, File: globalThis.File,
        URL: _nodeWebPlatform.URL, URLSearchParams: _nodeWebPlatform.URLSearchParams,
        AbortController: globalThis.AbortController, process, util, events, values: _nodeValues,
        TextEncoder, TextDecoder, TextDecoderStream: _nodeWebPlatform.streams.TextDecoderStream,
        stream: _nodeStreamPlatform, formData: _nodeFormDataPlatform,
        assert, types: util.types,
    });
    const FetchResponse = bodyPlatform.Response;

    const FetchRequest = bodyPlatform.Request;

    async function fetch(input, init) {
        const request = new FetchRequest(input, init);
        const requestState = bodyPlatform.getRequestState(request);
        const urlStr = request.url;
        const mergedHeaders = request.headers;
        const signal = request.signal;
        const method = request.method;
        const requestBody = requestState.body;

        const parsed = new URL(urlStr);
        const client = parsed.protocol === 'https:' ? https : http;
        const port = parsed.port ? parseInt(parsed.port, 10)
            : (parsed.protocol === 'https:' ? 443 : 80);

        // Reduce headers to plain object for http.request
        const headerObj = Object.create(null);
        const headerList = _nodeFormDataPlatform.headers.getHeadersList(mergedHeaders);
        for (const [k, v] of headerList) headerObj[k] = v;
        if (headerList.cookies !== null) headerObj['set-cookie'] = headerList.cookies.slice();

        if (requestBody !== null && requestBody.length !== null &&
            !Object.hasOwn(headerObj, 'content-length') && !Object.hasOwn(headerObj, 'transfer-encoding')) {
            headerObj['content-length'] = String(requestBody.length);
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let resStream = null;
            let responseBodyOwner = null;
            let abortDisposable;
            const cleanupAbort = () => {
                abortDisposable?.[_nodeDispose](); abortDisposable = undefined;
                bodyPlatform.removeRequestAbortListener(request);
            };
            const abortReason = () => {
                const reason = signal.reason;
                return reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason;
            };
            if (signal?.aborted) { reject(abortReason()); return; }

            const req = client.request({
                protocol: parsed.protocol,
                host: parsed.hostname,
                hostname: parsed.hostname,
                port,
                path: parsed.pathname + parsed.search,
                method,
                headers: headerObj,
            }, (res) => {
                if (settled) return;
                settled = true;

                try {
                    const hasBody = method !== 'HEAD' && ![204, 205, 304].includes(res.statusCode);
                    if (hasBody) {
                        responseBodyOwner = bodyPlatform.responseBodyFromIncoming(res, {
                            onTerminal: cleanupAbort,
                            onCancel: reason => req.destroy(reason),
                        });
                        resStream = responseBodyOwner.stream;
                    } else {
                        // Pinned Fetch null-body dump policy drains the actual
                        // message without creating an unconsumed Web byte queue.
                        res.once('end', cleanupAbort);
                        res.once('error', cleanupAbort);
                        res.resume();
                    }

                    const respHeaders = new FetchHeaders();
                    for (const k of Object.keys(res.headers || {})) {
                        const v = res.headers[k];
                        if (Array.isArray(v)) for (const x of v) respHeaders.append(k, x);
                        else if (v !== undefined) respHeaders.set(k, v);
                    }
                    // The transport publishes the same genuine Response private owner
                    // as public construction, with the actual response stream/header list.
                    const response = bodyPlatform.fromInnerResponse(bodyPlatform.makeResponse({
                        body: hasBody ? bodyPlatform.extractBody(resStream)[0] : null,
                        status: res.statusCode || 0,
                        statusText: res.statusMessage || '',
                        headersList: _nodeFormDataPlatform.headers.getHeadersList(respHeaders),
                        urlList: [new _nodeWebPlatform.URL(urlStr)],
                        type: 'basic',
                    }), 'immutable');
                    resolve(response);
                } catch (error) {
                    cleanupAbort();
                    if (responseBodyOwner) responseBodyOwner.abort(error);
                    else res.destroy(error);
                    req.destroy(error);
                    reject(error);
                }
            });

            req.on('error', (e) => {
                cleanupAbort();
                if (settled) {
                    responseBodyOwner?.error(e);
                    return;
                }
                settled = true;
                reject(e);
            });

            if (signal && typeof signal.addEventListener === 'function') {
                const onAbort = () => {
                    const reason = abortReason();
                    cleanupAbort();
                    // Publish the abort reason before synchronous destruction
                    // can finish or error the body through transport listeners.
                    if (settled) {
                        responseBodyOwner?.abort(reason);
                    } else {
                        settled = true;
                        reject(reason);
                    }
                    req.destroy();
                };
                if (signal.aborted) { onAbort(); return; }
                abortDisposable = _nodeEventPlatform.addAbortListener(signal, onAbort);
            }

            if (requestBody === null) req.end();
            else {
                // The real stream adapter owns lock, byte validation, backpressure
                // and cancellation; ClientRequest owns actual HTTP publication.
                const source = stream.Readable.fromWeb(requestBody.stream);
                stream.pipeline(source, req, error => { if (error) req.destroy(error); });
            }
        });
    }

    globalThis.fetch = fetch;
    globalThis.Headers = FetchHeaders;
    globalThis.Response = FetchResponse;
    globalThis.Request = FetchRequest;
    globalThis.ReadableStream = WebReadableStream;
    // Keep module and global constructor identity shared with response bodies.
    if (_builtinModules['stream/web']) {
        _builtinModules['stream/web'].ReadableStream = WebReadableStream;
    }
})();

// Export for the C entry point to detect successful bootstrap
globalThis.__nodeBootstrapReady = true;

// The shell owns eval/print/stdin completion. It calls this only after its
// normal job/timer/I/O loop and rejection reporting, before tearing down the
// realm. Explicit process.exit() has already finalized. An unsettled module
// graph with no remaining work exits 13, unless a nonzero status was assigned.
Object.defineProperty(globalThis, '__kandeloNodeBeforeExit', {
    value: () => process.emit('beforeExit', process.exitCode === undefined ? 0 : process.exitCode),
});

Object.defineProperty(globalThis, '__kandeloNodeFinalize', {
    value: (failureStatus, statusOnly = false) => {
        // A throwing exit listener prevents the normal return. The native
        // owner saves that exception and reads this status without emitting
        // again, then reports the original exception with its actual stack.
        if (statusOnly) return process.exitCode === undefined ? 1 : process.exitCode;
        if (_esmMainPending && !failureStatus && !process.exitCode) failureStatus = 13;
        return _runNaturalExit(failureStatus, true);
    },
});

// Public Node globals are a different namespace from an engine's command-line
// shell. Match the target's bootstrap descriptors before executing user code.
// Missing interfaces remain missing; this does not manufacture implementations.
function _installNodeGlobalScope() {
    const operations = [
        'global', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
        'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
        'atob', 'btoa', 'fetch',
    ];
    const interfaces = [
        'console', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
        ..._nodeStreamInterfaces, 'Blob', 'File',
        'FormData', 'Headers', 'Request', 'Response', 'MessagePort',
        'MessageChannel', 'BroadcastChannel', 'Event', 'EventTarget',
        'MessageEvent', 'CloseEvent', 'ErrorEvent', 'CustomEvent', 'DOMException', 'QuotaExceededError',
        'AbortSignal', 'AbortController',
    ];
    const attributes = ['process', 'Buffer', 'crypto', 'performance'];
    const publicNames = operations.concat(interfaces, attributes);
    if (typeof _nodeNative.prepareGlobalScope === 'function') {
        _nodeNative.prepareGlobalScope(publicNames);
    }
    for (const name of operations.concat(interfaces)) {
        if (Object.prototype.hasOwnProperty.call(globalThis, name)) {
            Object.defineProperty(globalThis, name, {
                value: globalThis[name], writable: true, configurable: true,
                enumerable: operations.includes(name),
            });
        }
    }
    for (const name of attributes) {
        if (!Object.prototype.hasOwnProperty.call(globalThis, name)) continue;
        let value = globalThis[name];
        Object.defineProperty(globalThis, name, {
            get() { return value; },
            set: name === 'crypto' ? undefined : function (replacement) { value = replacement; },
            enumerable: name === 'crypto' || name === 'performance',
            configurable: true,
        });
    }
    Object.defineProperty(globalThis, Symbol.toStringTag, {
        value: 'global', writable: false, enumerable: false, configurable: true,
    });
    // C++ module loading and the event loop still use these private bridges.
    for (const name of ['__kandeloRunDueTimers', '__kandeloNextTimerDelay', '__kandeloHasReferencedTimers',
        '__kandeloDispatchWorkers', '__kandeloBareModules',
        '__kandeloBareSources', '__kandeloResolveBare', '__kandeloModuleMeta',
        '__nodeBootstrapReady']) {
        if (Object.prototype.hasOwnProperty.call(globalThis, name)) {
            Object.defineProperty(globalThis, name, { enumerable: false });
        }
    }
    // File modules receive these as lexical wrapper arguments. Eval/REPL
    // entry points deliberately retain their corresponding global bindings.
    if (_mainScriptPath) {
        for (const name of ['require', 'module', 'exports', '__filename', '__dirname']) {
            delete globalThis[name];
        }
    }
}
_installNodeGlobalScope();
// Node's actual --eval entry exposes builtins through the same Module/require
// owner used by ordinary CJS. This is not standalone or public REPL activation.
if (_nodeHasEvalSource) {
    _nodeModuleRecords.addBuiltinLibsToObject(globalThis, '<eval>');
}



let _nodeWorkerStartupInitialized = false;
function _initializeNodeWorkerStartup(data) {
    if (!_nodeNative.workerEnvironment || _nodeWorkerStartupInitialized)
        throw new _nodeValues.errors.codes.ERR_INVALID_STATE('Worker startup was already initialized');
    _nodeWorkerStartupInitialized = true;
    const P = _createNodePrimordials();
    // Apply the actual decoded array-like value, including Array species
    // results. No iterator conversion/default argv substitutes for LOAD data.
    if (data.argv !== undefined) P.ArrayPrototypePushApply(process.argv, data.argv);
    if (data.doEval === 'classic') {
        P.ArrayPrototypeSplice(process.argv, 1, 0, '[worker eval]');
        return { source: data.filename, eval: true };
    }
    _mainScriptPath = _moduleRealpath(data.filename);
    _nodeNative.mainScriptPath = _mainScriptPath;
    P.ArrayPrototypeSplice(process.argv, 1, 0, data.filename);
    // File entry receives lexical wrapper bindings. Initialization before
    // LOAD deliberately used the real pre-entry require/global scope.
    for (const name of ['require', 'module', 'exports', '__filename', '__dirname'])
        delete globalThis[name];
    return { eval: false };
}
// All builtin/global/bootstrap owners are ready; mark before Worker LOAD
// deserializers or the first user main/eval entry can execute.
_nodeNative.performanceBootstrapComplete();
if (_nodeNative.workerEnvironment) {
    // Host deserializers depend on actual builtin/Blob/File/stream owners.
    // All user startup values are decoded once through that same LOAD graph.
    const startup = _nodeWorkerPlatform.initializeData(_nodeNative.worker('data'));
    _nodeNative.worker('ready');
    if (startup.eval) _nodeNative.evalScriptAsFunction(startup.source, '[worker eval]', 1);
    else _runMainScriptIfPresent();
} else _runMainScriptIfPresent();
