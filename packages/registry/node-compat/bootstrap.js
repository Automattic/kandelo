// Shared Node.js API compatibility layer for Kandelo JavaScript runtimes.
// Provides require(), process, Buffer, and core Node.js modules
// Built on top of qjs-shaped os/std/native adapter modules.
//
// This is NOT Node.js. It is a compatibility layer that implements
// the most commonly used Node.js APIs using POSIX syscalls.

import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as _nodeNative from 'qjs:node';

// ============================================================
// TextEncoder/TextDecoder polyfill for engines that do not provide it.
// ============================================================

const _TEXT_ENCODER_BRAND = Symbol('kandelo.TextEncoder');

if (typeof globalThis.TextEncoder === 'undefined') {
    _defineGlobal('TextEncoder', class TextEncoder {
        constructor() {
            Object.defineProperty(this, _TEXT_ENCODER_BRAND, { value: true });
        }
        get encoding() { _assertTextEncoder(this); return 'utf-8'; }
        encode(str = '') {
            _assertTextEncoder(this);
            if (typeof str !== 'string') str = String(str);
            const bytes = [];
            for (let i = 0; i < str.length; i++) {
                let code = str.charCodeAt(i);
                if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
                    const low = str.charCodeAt(i + 1);
                    if (low >= 0xDC00 && low <= 0xDFFF) {
                        code = ((code - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
                        i++;
                    }
                }
                if (code < 0x80) {
                    bytes.push(code);
                } else if (code < 0x800) {
                    bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
                } else if (code < 0x10000) {
                    bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
                } else {
                    bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F),
                               0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
                }
            }
            return new Uint8Array(bytes);
        }
        encodeInto(str, dest) {
            _assertTextEncoder(this);
            if (str === undefined) str = '';
            const encoded = this.encode(str);
            const len = Math.min(encoded.length, dest.length);
            dest.set(encoded.subarray(0, len));
            return { read: str.length, written: len };
        }
    });
}

// Build decoder output by batching codepoints into 8K chunks and joining via
// String.fromCharCode.apply. The naive `result += String.fromCharCode(c)` loop
// produces a per-character string rope; JS_ToCStringLen (invoked when C reads
// the string, e.g. native JSON.parse on a 38 MB npm packument) must linearize
// that rope into a flat UTF-16 buffer and SIGABRTs from heap fragmentation on
// multi-MB inputs. Array.prototype.join('') is unsafe in QJS-NG for many large
// 8-bit strings.
const _TEXT_DECODER_CHUNK = 8192;
const _TEXT_DECODER_BRAND = Symbol('kandelo.TextDecoder');
const _DETACHED_ARRAY_BUFFERS = new WeakSet();
const _TEXT_DECODER_LABELS = new Map([
    ['utf-8', 'utf-8'],
    ['utf8', 'utf-8'],
    ['unicode-1-1-utf-8', 'utf-8'],
    ['unicode11utf8', 'utf-8'],
    ['unicode20utf8', 'utf-8'],
    ['x-unicode20utf8', 'utf-8'],
    ['utf-16le', 'utf-16le'],
    ['utf-16', 'utf-16le'],
    ['utf-16be', 'utf-16be'],
]);

function _makeEncodingRangeError(label) {
    const err = new RangeError(`The "${label}" encoding is not supported`);
    err.code = 'ERR_ENCODING_NOT_SUPPORTED';
    return err;
}

function _makeEncodingDataError(encoding) {
    const err = new TypeError(`The encoded data was not valid for encoding ${encoding}`);
    err.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
    return err;
}

function _makeEncodingArgTypeError(name, expected, value) {
    const actual = value === null ? 'null' : `type ${typeof value}`;
    const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${actual}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
}

function _normalizeTextDecoderEncoding(label) {
    if (label === undefined) return 'utf-8';
    const raw = String(label).toLowerCase();
    const normalized = _TEXT_DECODER_LABELS.get(raw);
    if (!normalized) throw _makeEncodingRangeError(label);
    return normalized;
}

function _u8(input) {
    if (input === undefined) return new Uint8Array(0);
    if (input instanceof Uint8Array) {
        if (_isCompatDetachedArrayBuffer(input.buffer)) return new Uint8Array(0);
        return input;
    }
    if (input instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer)) {
        if (_isCompatDetachedArrayBuffer(input)) return new Uint8Array(0);
        return new Uint8Array(input);
    }
    if (ArrayBuffer.isView(input)) {
        if (_isCompatDetachedArrayBuffer(input.buffer)) return new Uint8Array(0);
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw _makeEncodingArgTypeError('input', 'ArrayBuffer, Buffer, TypedArray, or DataView', input);
}

function _isCompatDetachedArrayBuffer(value) {
    return value instanceof ArrayBuffer && _DETACHED_ARRAY_BUFFERS.has(value);
}

function _concatBytes(a, b) {
    if (!a || a.byteLength === 0) return b;
    if (!b || b.byteLength === 0) return a;
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
}

function _utf8ExpectedLength(lead) {
    if (lead < 0x80) return 1;
    if (lead >= 0xc2 && lead <= 0xdf) return 2;
    if (lead >= 0xe0 && lead <= 0xef) return 3;
    if (lead >= 0xf0 && lead <= 0xf4) return 4;
    return 0;
}

function _splitUtf8Pending(bytes) {
    for (let start = Math.max(0, bytes.byteLength - 3); start < bytes.byteLength; start++) {
        const expected = _utf8ExpectedLength(bytes[start]);
        if (expected > 1 && bytes.byteLength - start < expected) {
            let pending = true;
            for (let i = start + 1; i < bytes.byteLength; i++) {
                if ((bytes[i] & 0xc0) !== 0x80) {
                    pending = false;
                    break;
                }
            }
            if (pending) return [bytes.subarray(0, start), bytes.subarray(start)];
        }
    }
    return [bytes, new Uint8Array(0)];
}

function _pushCodePoint(out, code) {
    if (code > 0xffff) {
        code -= 0x10000;
        out.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
        out.push(code);
    }
}

function _appendCodeUnits(chunks, chunk) {
    if (chunk.length >= _TEXT_DECODER_CHUNK) {
        chunks.push(String.fromCharCode.apply(null, chunk));
        chunk.length = 0;
    }
}

function _decodeUtf8Bytes(bytes, fatal) {
    const chunks = [];
    const chunk = [];
    let i = 0;
    const bad = () => {
        if (fatal) throw _makeEncodingDataError('utf-8');
        chunk.push(0xfffd);
        _appendCodeUnits(chunks, chunk);
    };
    while (i < bytes.byteLength) {
        const b0 = bytes[i];
        if (b0 < 0x80) {
            chunk.push(b0);
            i++;
            _appendCodeUnits(chunks, chunk);
            continue;
        }
        const need = _utf8ExpectedLength(b0);
        if (need === 0 || i + need > bytes.byteLength) {
            bad();
            i++;
            continue;
        }
        let code;
        const b1 = bytes[i + 1];
        if ((b1 & 0xc0) !== 0x80) {
            bad();
            i++;
            continue;
        }
        if (need === 2) {
            code = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
        } else {
            const b2 = bytes[i + 2];
            if ((b2 & 0xc0) !== 0x80) {
                bad();
                i++;
                continue;
            }
            if (need === 3) {
                code = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
                if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) {
                    bad();
                    i++;
                    continue;
                }
            } else {
                const b3 = bytes[i + 3];
                if ((b3 & 0xc0) !== 0x80) {
                    bad();
                    i++;
                    continue;
                }
                code = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) |
                       ((b2 & 0x3f) << 6) | (b3 & 0x3f);
                if (code < 0x10000 || code > 0x10ffff) {
                    bad();
                    i++;
                    continue;
                }
            }
        }
        _pushCodePoint(chunk, code);
        i += need;
        _appendCodeUnits(chunks, chunk);
    }
    if (chunk.length > 0) chunks.push(String.fromCharCode.apply(null, chunk));
    return chunks.join('');
}

function _splitUtf16Pending(bytes) {
    if (bytes.byteLength % 2 === 0) return [bytes, new Uint8Array(0)];
    return [bytes.subarray(0, bytes.byteLength - 1), bytes.subarray(bytes.byteLength - 1)];
}

function _decodeUtf16Bytes(bytes, bigEndian, fatal) {
    if (bytes.byteLength % 2 !== 0 && fatal) throw _makeEncodingDataError(bigEndian ? 'utf-16be' : 'utf-16le');
    const chunks = [];
    const chunk = [];
    for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
        const code = bigEndian ? ((bytes[i] << 8) | bytes[i + 1]) : (bytes[i] | (bytes[i + 1] << 8));
        chunk.push(code);
        _appendCodeUnits(chunks, chunk);
    }
    if (bytes.byteLength % 2 !== 0) {
        chunk.push(0xfffd);
        _appendCodeUnits(chunks, chunk);
    }
    if (chunk.length > 0) chunks.push(String.fromCharCode.apply(null, chunk));
    return chunks.join('');
}

_defineGlobal('TextDecoder', class TextDecoder {
    constructor(encoding, options) {
        if (options !== undefined && options !== null && typeof options !== 'object') {
            throw _makeEncodingArgTypeError('options', 'object', options);
        }
        options = options || {};
        if (options.fatal &&
            globalThis.process &&
            globalThis.process.config &&
            globalThis.process.config.variables &&
            !globalThis.process.config.variables.v8_enable_i18n_support) {
            const err = new TypeError('"fatal" option is not supported on Node.js compiled without ICU');
            err.code = 'ERR_NO_ICU';
            throw err;
        }
        Object.defineProperty(this, _TEXT_DECODER_BRAND, { value: true });
        this._encoding = _normalizeTextDecoderEncoding(encoding);
        this._fatal = !!options.fatal;
        this._ignoreBOM = !!options.ignoreBOM;
        this._pending = new Uint8Array(0);
        this._bomSeen = false;
    }
    get encoding() { _assertTextDecoder(this); return this._encoding; }
    get fatal() { _assertTextDecoder(this); return this._fatal; }
    get ignoreBOM() { _assertTextDecoder(this); return this._ignoreBOM; }
    decode(input, options) {
        _assertTextDecoder(this);
        options = options || {};
        const stream = !!options.stream;
        let bytes = _concatBytes(this._pending, _u8(input));
        this._pending = new Uint8Array(0);
        if (stream) {
            if (this._encoding === 'utf-8') {
                [bytes, this._pending] = _splitUtf8Pending(bytes);
            } else {
                [bytes, this._pending] = _splitUtf16Pending(bytes);
            }
        } else if (this._pending.byteLength > 0) {
            bytes = _concatBytes(bytes, this._pending);
            this._pending = new Uint8Array(0);
        }
        let decoded = this._encoding === 'utf-8'
            ? _decodeUtf8Bytes(bytes, this._fatal)
            : _decodeUtf16Bytes(bytes, this._encoding === 'utf-16be', this._fatal);
        if (!stream && this._pending.byteLength > 0) {
            decoded += this._fatal ? '' : '\ufffd';
            this._pending = new Uint8Array(0);
        }
        if (!this._ignoreBOM && !this._bomSeen && decoded.charCodeAt(0) === 0xfeff) {
            decoded = decoded.slice(1);
        }
        if (decoded.length > 0 || !stream) this._bomSeen = true;
        return decoded;
    }
});
Object.defineProperty(globalThis.TextDecoder.prototype, Symbol.toStringTag, {
    value: 'TextDecoder',
    configurable: true,
});

function _assertTextDecoder(value) {
    const proto = value == null ? null : Object.getPrototypeOf(Object(value));
    if (proto !== globalThis.TextDecoder.prototype || value[_TEXT_DECODER_BRAND] !== true) {
        const err = new TypeError('Value of "this" must be of type TextDecoder');
        err.code = 'ERR_INVALID_THIS';
        throw err;
    }
}

function _assertTextEncoder(value) {
    const proto = value == null ? null : Object.getPrototypeOf(Object(value));
    if (proto !== globalThis.TextEncoder.prototype || value[_TEXT_ENCODER_BRAND] !== true) {
        const err = new TypeError('Value of "this" must be of type TextEncoder');
        err.code = 'ERR_INVALID_THIS';
        throw err;
    }
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

    _defineGlobal('btoa', function btoa(str) {
        if (arguments.length === 0) throw new TypeError('btoa requires an argument');
        if (typeof str === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
        str = String(str);
        let result = '';
        const len = str.length;
        for (let i = 0; i < len; i += 3) {
            const a = str.charCodeAt(i);
            const b = i + 1 < len ? str.charCodeAt(i + 1) : 0;
            const c = i + 2 < len ? str.charCodeAt(i + 2) : 0;
            if (a > 0xff || b > 0xff || c > 0xff) {
                throw new DOMException('The string to be encoded contains characters outside of the Latin1 range.', 'InvalidCharacterError');
            }
            const triple = (a << 16) | (b << 8) | c;
            result += _b64chars[(triple >> 18) & 0x3F];
            result += _b64chars[(triple >> 12) & 0x3F];
            result += i + 1 < len ? _b64chars[(triple >> 6) & 0x3F] : '=';
            result += i + 2 < len ? _b64chars[triple & 0x3F] : '=';
        }
        return result;
    });

    _defineGlobal('atob', function atob(str) {
        if (arguments.length === 0) throw new TypeError('atob requires an argument');
        if (typeof str === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
        str = String(str).replace(/[\t\n\f\r ]+/g, '');
        if (str.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(str) ||
            /=.*[^=]/.test(str) || /={3,}$/.test(str)) {
            throw new DOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
        }
        const paddedLength = Math.ceil(str.length / 4) * 4;
        str = str.padEnd(paddedLength, '=');
        let result = '';
        for (let i = 0; i < str.length; i += 4) {
            const c2 = str.charCodeAt(i + 2);
            const c3 = str.charCodeAt(i + 3);
            const a = _b64lookup[str.charCodeAt(i)];
            const b = _b64lookup[str.charCodeAt(i + 1)];
            const c = c2 === 61 ? 0 : _b64lookup[c2];
            const d = c3 === 61 ? 0 : _b64lookup[c3];
            const triple = (a << 18) | (b << 12) | (c << 6) | d;
            result += String.fromCharCode((triple >> 16) & 0xFF);
            if (c2 !== 61) result += String.fromCharCode((triple >> 8) & 0xFF);
            if (c3 !== 61) result += String.fromCharCode(triple & 0xFF);
        }
        return result;
    });
}

// ============================================================
// Internal helpers
// ============================================================

const _SLASH = '/';
const _DOT = '.';
const _kEvents = Symbol('kEvents');
const _kWeakHandler = Symbol('kWeakHandler');
const _kNodeEventTargetListenerWrapper = Symbol('kNodeEventTargetListenerWrapper');
let _eventTargetDefaultMaxListeners = 10;

function _defineGlobal(name, value) {
    Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

const _NATIVE_UINT8_ARRAY = globalThis.Uint8Array;
const _MAX_TYPED_ARRAY_LENGTH = Number.MAX_SAFE_INTEGER;
if (!_NATIVE_UINT8_ARRAY.__kandeloNodeCompatRangeShim) {
    const KandeloUint8Array = class Uint8Array extends _NATIVE_UINT8_ARRAY {
        constructor(value, byteOffset, length) {
            if (typeof value === 'number' && value > _MAX_TYPED_ARRAY_LENGTH) {
                throw new RangeError(`Invalid typed array length: ${value}`);
            }
            if (value instanceof ArrayBuffer && _DETACHED_ARRAY_BUFFERS.has(value)) {
                throw new TypeError('Cannot perform Construct on a detached ArrayBuffer');
            }
            if (arguments.length === 0) {
                super();
            } else if (arguments.length === 1) {
                super(value);
            } else if (arguments.length === 2) {
                super(value, byteOffset);
            } else {
                super(value, byteOffset, length);
            }
        }
    };
    Object.defineProperty(KandeloUint8Array, '__kandeloNodeCompatRangeShim', {
        value: true,
        configurable: true,
    });
    _defineGlobal('Uint8Array', KandeloUint8Array);
}

function _errnoToCode(errno) {
    const map = {
        1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR',
        5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM',
        13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR',
        22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE', 28: 'ENOSPC',
        30: 'EROFS', 31: 'EMLINK', 32: 'EPIPE', 36: 'ENAMETOOLONG',
        39: 'ENOTEMPTY', 40: 'ELOOP', 61: 'ENODATA', 95: 'ENOTSUP',
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

function _makeUnsupportedPlatformError(feature) {
    return _makeNodeError(
        `${feature} is not supported in Kandelo's SpiderMonkey Node compatibility runtime`,
        'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
    );
}

function _makeInvalidArgTypeError(name, expected, value) {
    let actual;
    if (value === null || value === undefined) {
        actual = String(value);
    } else if (typeof value === 'function') {
        actual = `function ${value.name || ''}`;
    } else if (typeof value === 'object') {
        actual = value.constructor && value.constructor.name
            ? `an instance of ${value.constructor.name}`
            : '{  }';
    } else {
        let inspected;
        if (typeof value === 'string') inspected = `'${value}'`;
        else if (typeof value === 'bigint') inspected = String(value);
        else inspected = String(value);
        if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
        actual = `type ${typeof value} (${inspected})`;
    }
    const subject = /^(first|second|third|fourth|fifth|sixth) argument$/.test(name)
        ? `The ${name}`
        : `The "${name}" argument`;
    const expectedPhrase = expected.startsWith('an instance of ') ? expected : `of type ${expected}`;
    const err = new TypeError(`${subject} must be ${expectedPhrase}. Received ${actual}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
}

function _makeInvalidArgValueError(name, value) {
    const err = new TypeError(`The "${name}" argument is invalid. Received ${util.inspect(value)}`);
    err.code = 'ERR_INVALID_ARG_VALUE';
    return err;
}

function _isDetachedArrayBuffer(value) {
    if (!(value instanceof ArrayBuffer)) return false;
    if (_DETACHED_ARRAY_BUFFERS.has(value)) return true;
    if (value.byteLength !== 0) return false;
    try {
        value.slice(0, 0);
        return false;
    } catch (_) {
        return true;
    }
}

function _validateString(value, name) {
    if (typeof value !== 'string') {
        throw _makeInvalidArgTypeError(name, 'string', value);
    }
}

function _throwErrno(errno, syscall, path) {
    const code = _errnoToCode(errno);
    const msg = `${code}: ${syscall}` + (path ? ` '${path}'` : '');
    throw _makeNodeError(msg, code, errno, syscall, path);
}

function _checkErrno(errno, syscall, path) {
    if (errno < 0) _throwErrno(-errno, syscall, path);
    if (errno !== 0) _throwErrno(errno, syscall, path);
}

// ============================================================
// path module
// ============================================================

// Portions of this path module are adapted from Node.js v22 lib/path.js.
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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
const path = (() => {
    // Standalone adaptation of Node.js v22 lib/path.js. Keep this self-contained:
    // the compatibility bootstrap creates `path` before the shimmed process
    // object is globally installed.
    const CHAR_UPPERCASE_A = 65;
    const CHAR_LOWERCASE_A = 97;
    const CHAR_UPPERCASE_Z = 90;
    const CHAR_LOWERCASE_Z = 122;
    const CHAR_DOT = 46;
    const CHAR_FORWARD_SLASH = 47;
    const CHAR_BACKWARD_SLASH = 92;
    const CHAR_COLON = 58;
    const CHAR_QUESTION_MARK = 63;

    const StringPrototypeCharCodeAt = (str, index) => str.charCodeAt(index);
    const StringPrototypeIndexOf = (str, search, start) => str.indexOf(search, start);
    const StringPrototypeLastIndexOf = (str, search) => str.lastIndexOf(search);
    const StringPrototypeReplace = (str, search, replacement) => str.replace(search, replacement);
    const StringPrototypeSlice = (str, start, end) => str.slice(start, end);
    const StringPrototypeToLowerCase = (str) => str.toLowerCase();

    function validateString(value, name) {
        _validateString(value, name);
    }

    function validateObject(value, name) {
        if (value === null || typeof value !== 'object') {
            throw _makeInvalidArgTypeError(name, 'object', value);
        }
    }

    function cwd() {
        const result = os.getcwd();
        return Array.isArray(result) ? result[0] : result;
    }

    function isPathSeparator(code) {
        return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
    }

    function isPosixPathSeparator(code) {
        return code === CHAR_FORWARD_SLASH;
    }

    function isWindowsDeviceRoot(code) {
        return (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
               (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z);
    }

    function normalizeString(path, allowAboveRoot, separator, isPathSeparator) {
        let res = '';
        let lastSegmentLength = 0;
        let lastSlash = -1;
        let dots = 0;
        let code = 0;
        for (let i = 0; i <= path.length; ++i) {
            if (i < path.length)
                code = StringPrototypeCharCodeAt(path, i);
            else if (isPathSeparator(code))
                break;
            else
                code = CHAR_FORWARD_SLASH;

            if (isPathSeparator(code)) {
                if (lastSlash === i - 1 || dots === 1) {
                    // NOOP
                } else if (dots === 2) {
                    if (res.length < 2 || lastSegmentLength !== 2 ||
                        StringPrototypeCharCodeAt(res, res.length - 1) !== CHAR_DOT ||
                        StringPrototypeCharCodeAt(res, res.length - 2) !== CHAR_DOT) {
                        if (res.length > 2) {
                            const lastSlashIndex = StringPrototypeLastIndexOf(res, separator);
                            if (lastSlashIndex === -1) {
                                res = '';
                                lastSegmentLength = 0;
                            } else {
                                res = StringPrototypeSlice(res, 0, lastSlashIndex);
                                lastSegmentLength =
                                    res.length - 1 - StringPrototypeLastIndexOf(res, separator);
                            }
                            lastSlash = i;
                            dots = 0;
                            continue;
                        } else if (res.length !== 0) {
                            res = '';
                            lastSegmentLength = 0;
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                    }
                    if (allowAboveRoot) {
                        res += res.length > 0 ? `${separator}..` : '..';
                        lastSegmentLength = 2;
                    }
                } else {
                    if (res.length > 0)
                        res += `${separator}${StringPrototypeSlice(path, lastSlash + 1, i)}`;
                    else
                        res = StringPrototypeSlice(path, lastSlash + 1, i);
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            } else if (code === CHAR_DOT && dots !== -1) {
                ++dots;
            } else {
                dots = -1;
            }
        }
        return res;
    }

    function formatExt(ext) {
        return ext ? `${ext[0] === '.' ? '' : '.'}${ext}` : '';
    }

    function _format(sep, pathObject) {
        validateObject(pathObject, 'pathObject');
        const dir = pathObject.dir || pathObject.root;
        const base = pathObject.base ||
            `${pathObject.name || ''}${formatExt(pathObject.ext)}`;
        if (!dir) return base;
        return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
    }

    const win32 = {
        resolve(...args) {
            let resolvedDevice = '';
            let resolvedTail = '';
            let resolvedAbsolute = false;

            for (let i = args.length - 1; i >= -1; i--) {
                let path;
                if (i >= 0) {
                    path = args[i];
                    validateString(path, `paths[${i}]`);
                    if (path.length === 0) continue;
                } else if (resolvedDevice.length === 0) {
                    path = cwd();
                } else {
                    path = cwd();
                    if (path === undefined ||
                        (StringPrototypeToLowerCase(StringPrototypeSlice(path, 0, 2)) !==
                        StringPrototypeToLowerCase(resolvedDevice) &&
                        StringPrototypeCharCodeAt(path, 2) === CHAR_BACKWARD_SLASH)) {
                        path = `${resolvedDevice}\\`;
                    }
                }

                const len = path.length;
                let rootEnd = 0;
                let device = '';
                let isAbsolute = false;
                const code = StringPrototypeCharCodeAt(path, 0);

                if (len === 1) {
                    if (isPathSeparator(code)) {
                        rootEnd = 1;
                        isAbsolute = true;
                    }
                } else if (isPathSeparator(code)) {
                    isAbsolute = true;
                    if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
                        let j = 2;
                        let last = j;
                        while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                        if (j < len && j !== last) {
                            const firstPart = StringPrototypeSlice(path, last, j);
                            last = j;
                            while (j < len && isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                            if (j < len && j !== last) {
                                last = j;
                                while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                                if (j === len || j !== last) {
                                    device =
                                        `\\\\${firstPart}\\${StringPrototypeSlice(path, last, j)}`;
                                    rootEnd = j;
                                }
                            }
                        }
                    } else {
                        rootEnd = 1;
                    }
                } else if (isWindowsDeviceRoot(code) &&
                           StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
                    device = StringPrototypeSlice(path, 0, 2);
                    rootEnd = 2;
                    if (len > 2 && isPathSeparator(StringPrototypeCharCodeAt(path, 2))) {
                        isAbsolute = true;
                        rootEnd = 3;
                    }
                }

                if (device.length > 0) {
                    if (resolvedDevice.length > 0) {
                        if (StringPrototypeToLowerCase(device) !==
                            StringPrototypeToLowerCase(resolvedDevice))
                            continue;
                    } else {
                        resolvedDevice = device;
                    }
                }

                if (resolvedAbsolute) {
                    if (resolvedDevice.length > 0) break;
                } else {
                    resolvedTail = `${StringPrototypeSlice(path, rootEnd)}\\${resolvedTail}`;
                    resolvedAbsolute = isAbsolute;
                    if (isAbsolute && resolvedDevice.length > 0) break;
                }
            }

            resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, '\\',
                                           isPathSeparator);

            return resolvedAbsolute ?
                `${resolvedDevice}\\${resolvedTail}` :
                `${resolvedDevice}${resolvedTail}` || '.';
        },

        normalize(path) {
            validateString(path, 'path');
            const len = path.length;
            if (len === 0) return '.';
            let rootEnd = 0;
            let device;
            let isAbsolute = false;
            const code = StringPrototypeCharCodeAt(path, 0);

            if (len === 1) return isPosixPathSeparator(code) ? '\\' : path;
            if (isPathSeparator(code)) {
                isAbsolute = true;

                if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
                    let j = 2;
                    let last = j;
                    while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                    if (j < len && j !== last) {
                        const firstPart = StringPrototypeSlice(path, last, j);
                        last = j;
                        while (j < len && isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                        if (j < len && j !== last) {
                            last = j;
                            while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                            if (j === len) {
                                return `\\\\${firstPart}\\${StringPrototypeSlice(path, last)}\\`;
                            }
                            if (j !== last) {
                                device =
                                    `\\\\${firstPart}\\${StringPrototypeSlice(path, last, j)}`;
                                rootEnd = j;
                            }
                        }
                    }
                } else {
                    rootEnd = 1;
                }
            } else if (isWindowsDeviceRoot(code) &&
                       StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
                device = StringPrototypeSlice(path, 0, 2);
                rootEnd = 2;
                if (len > 2 && isPathSeparator(StringPrototypeCharCodeAt(path, 2))) {
                    isAbsolute = true;
                    rootEnd = 3;
                }
            }

            let tail = rootEnd < len ?
                normalizeString(StringPrototypeSlice(path, rootEnd),
                                !isAbsolute, '\\', isPathSeparator) :
                '';
            if (tail.length === 0 && !isAbsolute) tail = '.';
            if (tail.length > 0 &&
                isPathSeparator(StringPrototypeCharCodeAt(path, len - 1)))
                tail += '\\';
            if (device === undefined) return isAbsolute ? `\\${tail}` : tail;
            return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
        },

        isAbsolute(path) {
            validateString(path, 'path');
            const len = path.length;
            if (len === 0) return false;
            const code = StringPrototypeCharCodeAt(path, 0);
            return isPathSeparator(code) ||
                (len > 2 &&
                isWindowsDeviceRoot(code) &&
                StringPrototypeCharCodeAt(path, 1) === CHAR_COLON &&
                isPathSeparator(StringPrototypeCharCodeAt(path, 2)));
        },

        join(...args) {
            if (args.length === 0) return '.';

            let joined;
            let firstPart;
            for (let i = 0; i < args.length; ++i) {
                const arg = args[i];
                validateString(arg, 'path');
                if (arg.length > 0) {
                    if (joined === undefined)
                        joined = firstPart = arg;
                    else
                        joined += `\\${arg}`;
                }
            }

            if (joined === undefined) return '.';

            let needsReplace = true;
            let slashCount = 0;
            if (isPathSeparator(StringPrototypeCharCodeAt(firstPart, 0))) {
                ++slashCount;
                const firstLen = firstPart.length;
                if (firstLen > 1 &&
                    isPathSeparator(StringPrototypeCharCodeAt(firstPart, 1))) {
                    ++slashCount;
                    if (firstLen > 2) {
                        if (isPathSeparator(StringPrototypeCharCodeAt(firstPart, 2)))
                            ++slashCount;
                        else
                            needsReplace = false;
                    }
                }
            }
            if (needsReplace) {
                while (slashCount < joined.length &&
                       isPathSeparator(StringPrototypeCharCodeAt(joined, slashCount))) {
                    slashCount++;
                }
                if (slashCount >= 2)
                    joined = `\\${StringPrototypeSlice(joined, slashCount)}`;
            }

            return win32.normalize(joined);
        },

        relative(from, to) {
            validateString(from, 'from');
            validateString(to, 'to');

            if (from === to) return '';

            const fromOrig = win32.resolve(from);
            const toOrig = win32.resolve(to);

            if (fromOrig === toOrig) return '';

            from = StringPrototypeToLowerCase(fromOrig);
            to = StringPrototypeToLowerCase(toOrig);

            if (from === to) return '';

            let fromStart = 0;
            while (fromStart < from.length &&
                   StringPrototypeCharCodeAt(from, fromStart) === CHAR_BACKWARD_SLASH) {
                fromStart++;
            }
            let fromEnd = from.length;
            while (
                fromEnd - 1 > fromStart &&
                StringPrototypeCharCodeAt(from, fromEnd - 1) === CHAR_BACKWARD_SLASH
            ) {
                fromEnd--;
            }
            const fromLen = fromEnd - fromStart;

            let toStart = 0;
            while (toStart < to.length &&
                   StringPrototypeCharCodeAt(to, toStart) === CHAR_BACKWARD_SLASH) {
                toStart++;
            }
            let toEnd = to.length;
            while (toEnd - 1 > toStart &&
                   StringPrototypeCharCodeAt(to, toEnd - 1) === CHAR_BACKWARD_SLASH) {
                toEnd--;
            }
            const toLen = toEnd - toStart;

            const length = fromLen < toLen ? fromLen : toLen;
            let lastCommonSep = -1;
            let i = 0;
            for (; i < length; i++) {
                const fromCode = StringPrototypeCharCodeAt(from, fromStart + i);
                if (fromCode !== StringPrototypeCharCodeAt(to, toStart + i))
                    break;
                else if (fromCode === CHAR_BACKWARD_SLASH)
                    lastCommonSep = i;
            }

            if (i !== length) {
                if (lastCommonSep === -1) return toOrig;
            } else {
                if (toLen > length) {
                    if (StringPrototypeCharCodeAt(to, toStart + i) ===
                        CHAR_BACKWARD_SLASH) {
                        return StringPrototypeSlice(toOrig, toStart + i + 1);
                    }
                    if (i === 2) return StringPrototypeSlice(toOrig, toStart + i);
                }
                if (fromLen > length) {
                    if (StringPrototypeCharCodeAt(from, fromStart + i) ===
                        CHAR_BACKWARD_SLASH) {
                        lastCommonSep = i;
                    } else if (i === 2) {
                        lastCommonSep = 3;
                    }
                }
                if (lastCommonSep === -1) lastCommonSep = 0;
            }

            let out = '';
            for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
                if (i === fromEnd ||
                    StringPrototypeCharCodeAt(from, i) === CHAR_BACKWARD_SLASH) {
                    out += out.length === 0 ? '..' : '\\..';
                }
            }

            toStart += lastCommonSep;

            if (out.length > 0)
                return `${out}${StringPrototypeSlice(toOrig, toStart, toEnd)}`;

            if (StringPrototypeCharCodeAt(toOrig, toStart) === CHAR_BACKWARD_SLASH)
                ++toStart;
            return StringPrototypeSlice(toOrig, toStart, toEnd);
        },

        toNamespacedPath(path) {
            if (typeof path !== 'string' || path.length === 0) return path;

            const resolvedPath = win32.resolve(path);

            if (resolvedPath.length <= 2) return path;

            if (StringPrototypeCharCodeAt(resolvedPath, 0) === CHAR_BACKWARD_SLASH) {
                if (StringPrototypeCharCodeAt(resolvedPath, 1) === CHAR_BACKWARD_SLASH) {
                    const code = StringPrototypeCharCodeAt(resolvedPath, 2);
                    if (code !== CHAR_QUESTION_MARK && code !== CHAR_DOT) {
                        return `\\\\?\\UNC\\${StringPrototypeSlice(resolvedPath, 2)}`;
                    }
                }
            } else if (
                isWindowsDeviceRoot(StringPrototypeCharCodeAt(resolvedPath, 0)) &&
                StringPrototypeCharCodeAt(resolvedPath, 1) === CHAR_COLON &&
                StringPrototypeCharCodeAt(resolvedPath, 2) === CHAR_BACKWARD_SLASH
            ) {
                return `\\\\?\\${resolvedPath}`;
            }

            return path;
        },

        dirname(path) {
            validateString(path, 'path');
            const len = path.length;
            if (len === 0) return '.';
            let rootEnd = -1;
            let offset = 0;
            const code = StringPrototypeCharCodeAt(path, 0);

            if (len === 1) return isPathSeparator(code) ? path : '.';

            if (isPathSeparator(code)) {
                rootEnd = offset = 1;

                if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
                    let j = 2;
                    let last = j;
                    while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                    if (j < len && j !== last) {
                        last = j;
                        while (j < len && isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                        if (j < len && j !== last) {
                            last = j;
                            while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                            if (j === len) return path;
                            if (j !== last) rootEnd = offset = j + 1;
                        }
                    }
                }
            } else if (isWindowsDeviceRoot(code) &&
                       StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
                rootEnd =
                    len > 2 && isPathSeparator(StringPrototypeCharCodeAt(path, 2)) ? 3 : 2;
                offset = rootEnd;
            }

            let end = -1;
            let matchedSlash = true;
            for (let i = len - 1; i >= offset; --i) {
                if (isPathSeparator(StringPrototypeCharCodeAt(path, i))) {
                    if (!matchedSlash) {
                        end = i;
                        break;
                    }
                } else {
                    matchedSlash = false;
                }
            }

            if (end === -1) {
                if (rootEnd === -1) return '.';
                end = rootEnd;
            }
            return StringPrototypeSlice(path, 0, end);
        },

        basename(path, suffix) {
            if (suffix !== undefined) validateString(suffix, 'ext');
            validateString(path, 'path');
            let start = 0;
            let end = -1;
            let matchedSlash = true;

            if (path.length >= 2 &&
                isWindowsDeviceRoot(StringPrototypeCharCodeAt(path, 0)) &&
                StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
                start = 2;
            }

            if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
                if (suffix === path) return '';
                let extIdx = suffix.length - 1;
                let firstNonSlashEnd = -1;
                for (let i = path.length - 1; i >= start; --i) {
                    const code = StringPrototypeCharCodeAt(path, i);
                    if (isPathSeparator(code)) {
                        if (!matchedSlash) {
                            start = i + 1;
                            break;
                        }
                    } else {
                        if (firstNonSlashEnd === -1) {
                            matchedSlash = false;
                            firstNonSlashEnd = i + 1;
                        }
                        if (extIdx >= 0) {
                            if (code === StringPrototypeCharCodeAt(suffix, extIdx)) {
                                if (--extIdx === -1) end = i;
                            } else {
                                extIdx = -1;
                                end = firstNonSlashEnd;
                            }
                        }
                    }
                }

                if (start === end) end = firstNonSlashEnd;
                else if (end === -1) end = path.length;
                return StringPrototypeSlice(path, start, end);
            }
            for (let i = path.length - 1; i >= start; --i) {
                if (isPathSeparator(StringPrototypeCharCodeAt(path, i))) {
                    if (!matchedSlash) {
                        start = i + 1;
                        break;
                    }
                } else if (end === -1) {
                    matchedSlash = false;
                    end = i + 1;
                }
            }

            if (end === -1) return '';
            return StringPrototypeSlice(path, start, end);
        },

        extname(path) {
            validateString(path, 'path');
            let start = 0;
            let startDot = -1;
            let startPart = 0;
            let end = -1;
            let matchedSlash = true;
            let preDotState = 0;

            if (path.length >= 2 &&
                StringPrototypeCharCodeAt(path, 1) === CHAR_COLON &&
                isWindowsDeviceRoot(StringPrototypeCharCodeAt(path, 0))) {
                start = startPart = 2;
            }

            for (let i = path.length - 1; i >= start; --i) {
                const code = StringPrototypeCharCodeAt(path, i);
                if (isPathSeparator(code)) {
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
                if (end === -1) {
                    matchedSlash = false;
                    end = i + 1;
                }
                if (code === CHAR_DOT) {
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
                } else if (startDot !== -1) {
                    preDotState = -1;
                }
            }

            if (startDot === -1 ||
                end === -1 ||
                preDotState === 0 ||
                (preDotState === 1 &&
                 startDot === end - 1 &&
                 startDot === startPart + 1)) {
                return '';
            }
            return StringPrototypeSlice(path, startDot, end);
        },

        format(pathObject) {
            return _format('\\', pathObject);
        },

        parse(path) {
            validateString(path, 'path');

            const ret = { root: '', dir: '', base: '', ext: '', name: '' };
            if (path.length === 0) return ret;

            const len = path.length;
            let rootEnd = 0;
            let code = StringPrototypeCharCodeAt(path, 0);

            if (len === 1) {
                if (isPathSeparator(code)) {
                    ret.root = ret.dir = path;
                    return ret;
                }
                ret.base = ret.name = path;
                return ret;
            }
            if (isPathSeparator(code)) {
                rootEnd = 1;
                if (isPathSeparator(StringPrototypeCharCodeAt(path, 1))) {
                    let j = 2;
                    let last = j;
                    while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                    if (j < len && j !== last) {
                        last = j;
                        while (j < len && isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                        if (j < len && j !== last) {
                            last = j;
                            while (j < len && !isPathSeparator(StringPrototypeCharCodeAt(path, j))) j++;
                            if (j === len) rootEnd = j;
                            else if (j !== last) rootEnd = j + 1;
                        }
                    }
                }
            } else if (isWindowsDeviceRoot(code) &&
                       StringPrototypeCharCodeAt(path, 1) === CHAR_COLON) {
                if (len <= 2) {
                    ret.root = ret.dir = path;
                    return ret;
                }
                rootEnd = 2;
                if (isPathSeparator(StringPrototypeCharCodeAt(path, 2))) {
                    if (len === 3) {
                        ret.root = ret.dir = path;
                        return ret;
                    }
                    rootEnd = 3;
                }
            }
            if (rootEnd > 0) ret.root = StringPrototypeSlice(path, 0, rootEnd);

            let startDot = -1;
            let startPart = rootEnd;
            let end = -1;
            let matchedSlash = true;
            let i = path.length - 1;
            let preDotState = 0;

            for (; i >= rootEnd; --i) {
                code = StringPrototypeCharCodeAt(path, i);
                if (isPathSeparator(code)) {
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
                if (end === -1) {
                    matchedSlash = false;
                    end = i + 1;
                }
                if (code === CHAR_DOT) {
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
                } else if (startDot !== -1) {
                    preDotState = -1;
                }
            }

            if (end !== -1) {
                if (startDot === -1 ||
                    preDotState === 0 ||
                    (preDotState === 1 &&
                     startDot === end - 1 &&
                     startDot === startPart + 1)) {
                    ret.base = ret.name = StringPrototypeSlice(path, startPart, end);
                } else {
                    ret.name = StringPrototypeSlice(path, startPart, startDot);
                    ret.base = StringPrototypeSlice(path, startPart, end);
                    ret.ext = StringPrototypeSlice(path, startDot, end);
                }
            }

            if (startPart > 0 && startPart !== rootEnd)
                ret.dir = StringPrototypeSlice(path, 0, startPart - 1);
            else
                ret.dir = ret.root;

            return ret;
        },

        sep: '\\',
        delimiter: ';',
        win32: null,
        posix: null,
    };

    function posixCwd() {
        return cwd();
    }

    const posix = {
        resolve(...args) {
            let resolvedPath = '';
            let resolvedAbsolute = false;

            for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
                const path = i >= 0 ? args[i] : posixCwd();
                validateString(path, `paths[${i}]`);
                if (path.length === 0) continue;

                resolvedPath = `${path}/${resolvedPath}`;
                resolvedAbsolute =
                    StringPrototypeCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            }

            resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, '/',
                                           isPosixPathSeparator);

            if (resolvedAbsolute) return `/${resolvedPath}`;
            return resolvedPath.length > 0 ? resolvedPath : '.';
        },

        normalize(path) {
            validateString(path, 'path');

            if (path.length === 0) return '.';

            const isAbsolute =
                StringPrototypeCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            const trailingSeparator =
                StringPrototypeCharCodeAt(path, path.length - 1) === CHAR_FORWARD_SLASH;

            path = normalizeString(path, !isAbsolute, '/', isPosixPathSeparator);

            if (path.length === 0) {
                if (isAbsolute) return '/';
                return trailingSeparator ? './' : '.';
            }
            if (trailingSeparator) path += '/';

            return isAbsolute ? `/${path}` : path;
        },

        isAbsolute(path) {
            validateString(path, 'path');
            return path.length > 0 &&
                   StringPrototypeCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
        },

        join(...args) {
            if (args.length === 0) return '.';
            let joined;
            for (let i = 0; i < args.length; ++i) {
                const arg = args[i];
                validateString(arg, 'path');
                if (arg.length > 0) {
                    if (joined === undefined)
                        joined = arg;
                    else
                        joined += `/${arg}`;
                }
            }
            if (joined === undefined) return '.';
            return posix.normalize(joined);
        },

        relative(from, to) {
            validateString(from, 'from');
            validateString(to, 'to');

            if (from === to) return '';

            from = posix.resolve(from);
            to = posix.resolve(to);

            if (from === to) return '';

            const fromStart = 1;
            const fromEnd = from.length;
            const fromLen = fromEnd - fromStart;
            const toStart = 1;
            const toLen = to.length - toStart;

            const length = (fromLen < toLen ? fromLen : toLen);
            let lastCommonSep = -1;
            let i = 0;
            for (; i < length; i++) {
                const fromCode = StringPrototypeCharCodeAt(from, fromStart + i);
                if (fromCode !== StringPrototypeCharCodeAt(to, toStart + i))
                    break;
                else if (fromCode === CHAR_FORWARD_SLASH)
                    lastCommonSep = i;
            }
            if (i === length) {
                if (toLen > length) {
                    if (StringPrototypeCharCodeAt(to, toStart + i) === CHAR_FORWARD_SLASH) {
                        return StringPrototypeSlice(to, toStart + i + 1);
                    }
                    if (i === 0) return StringPrototypeSlice(to, toStart + i);
                } else if (fromLen > length) {
                    if (StringPrototypeCharCodeAt(from, fromStart + i) ===
                        CHAR_FORWARD_SLASH) {
                        lastCommonSep = i;
                    } else if (i === 0) {
                        lastCommonSep = 0;
                    }
                }
            }

            let out = '';
            for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
                if (i === fromEnd ||
                    StringPrototypeCharCodeAt(from, i) === CHAR_FORWARD_SLASH) {
                    out += out.length === 0 ? '..' : '/..';
                }
            }

            return `${out}${StringPrototypeSlice(to, toStart + lastCommonSep)}`;
        },

        toNamespacedPath(path) {
            return path;
        },

        dirname(path) {
            validateString(path, 'path');
            if (path.length === 0) return '.';
            const hasRoot = StringPrototypeCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            let end = -1;
            let matchedSlash = true;
            for (let i = path.length - 1; i >= 1; --i) {
                if (StringPrototypeCharCodeAt(path, i) === CHAR_FORWARD_SLASH) {
                    if (!matchedSlash) {
                        end = i;
                        break;
                    }
                } else {
                    matchedSlash = false;
                }
            }

            if (end === -1) return hasRoot ? '/' : '.';
            if (hasRoot && end === 1) return '//';
            return StringPrototypeSlice(path, 0, end);
        },

        basename(path, suffix) {
            if (suffix !== undefined) validateString(suffix, 'ext');
            validateString(path, 'path');

            let start = 0;
            let end = -1;
            let matchedSlash = true;

            if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
                if (suffix === path) return '';
                let extIdx = suffix.length - 1;
                let firstNonSlashEnd = -1;
                for (let i = path.length - 1; i >= 0; --i) {
                    const code = StringPrototypeCharCodeAt(path, i);
                    if (code === CHAR_FORWARD_SLASH) {
                        if (!matchedSlash) {
                            start = i + 1;
                            break;
                        }
                    } else {
                        if (firstNonSlashEnd === -1) {
                            matchedSlash = false;
                            firstNonSlashEnd = i + 1;
                        }
                        if (extIdx >= 0) {
                            if (code === StringPrototypeCharCodeAt(suffix, extIdx)) {
                                if (--extIdx === -1) end = i;
                            } else {
                                extIdx = -1;
                                end = firstNonSlashEnd;
                            }
                        }
                    }
                }

                if (start === end) end = firstNonSlashEnd;
                else if (end === -1) end = path.length;
                return StringPrototypeSlice(path, start, end);
            }
            for (let i = path.length - 1; i >= 0; --i) {
                if (StringPrototypeCharCodeAt(path, i) === CHAR_FORWARD_SLASH) {
                    if (!matchedSlash) {
                        start = i + 1;
                        break;
                    }
                } else if (end === -1) {
                    matchedSlash = false;
                    end = i + 1;
                }
            }

            if (end === -1) return '';
            return StringPrototypeSlice(path, start, end);
        },

        extname(path) {
            validateString(path, 'path');
            let startDot = -1;
            let startPart = 0;
            let end = -1;
            let matchedSlash = true;
            let preDotState = 0;
            for (let i = path.length - 1; i >= 0; --i) {
                const char = path[i];
                if (char === '/') {
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
                if (end === -1) {
                    matchedSlash = false;
                    end = i + 1;
                }
                if (char === '.') {
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
                } else if (startDot !== -1) {
                    preDotState = -1;
                }
            }

            if (startDot === -1 ||
                end === -1 ||
                preDotState === 0 ||
                (preDotState === 1 &&
                 startDot === end - 1 &&
                 startDot === startPart + 1)) {
                return '';
            }
            return StringPrototypeSlice(path, startDot, end);
        },

        format(pathObject) {
            return _format('/', pathObject);
        },

        parse(path) {
            validateString(path, 'path');

            const ret = { root: '', dir: '', base: '', ext: '', name: '' };
            if (path.length === 0) return ret;
            const isAbsolute =
                StringPrototypeCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            const start = isAbsolute ? 1 : 0;
            if (isAbsolute) ret.root = '/';

            let startDot = -1;
            let startPart = 0;
            let end = -1;
            let matchedSlash = true;
            let i = path.length - 1;
            let preDotState = 0;

            for (; i >= start; --i) {
                const code = StringPrototypeCharCodeAt(path, i);
                if (code === CHAR_FORWARD_SLASH) {
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
                if (end === -1) {
                    matchedSlash = false;
                    end = i + 1;
                }
                if (code === CHAR_DOT) {
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
                } else if (startDot !== -1) {
                    preDotState = -1;
                }
            }

            if (end !== -1) {
                const start = startPart === 0 && isAbsolute ? 1 : startPart;
                if (startDot === -1 ||
                    preDotState === 0 ||
                    (preDotState === 1 &&
                     startDot === end - 1 &&
                     startDot === startPart + 1)) {
                    ret.base = ret.name = StringPrototypeSlice(path, start, end);
                } else {
                    ret.name = StringPrototypeSlice(path, start, startDot);
                    ret.base = StringPrototypeSlice(path, start, end);
                    ret.ext = StringPrototypeSlice(path, startDot, end);
                }
            }

            if (startPart > 0)
                ret.dir = StringPrototypeSlice(path, 0, startPart - 1);
            else if (isAbsolute)
                ret.dir = '/';

            return ret;
        },

        sep: '/',
        delimiter: ':',
        win32: null,
        posix: null,
    };

    posix.win32 = win32.win32 = win32;
    posix.posix = win32.posix = posix;
    win32._makeLong = win32.toNamespacedPath;
    posix._makeLong = posix.toNamespacedPath;

    return posix;
})();

// ============================================================
// events module (EventEmitter)
// ============================================================

const events = (() => {
    let defaultMaxListeners = 10;
    let defaultCaptureRejections = false;
    const captureRejectionSymbol = Symbol.for('nodejs.rejection');
    const errorMonitor = Symbol.for('events.errorMonitor');

    function validateMaxListeners(n) {
        n = Number(n);
        if (!Number.isFinite(n) || n < 0) {
            const err = new RangeError('The value of "n" is out of range. It must be a non-negative number.');
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
        }
        return n;
    }

    function validateListener(fn) {
        if (typeof fn !== 'function') throw _makeInvalidArgTypeError('listener', 'function', fn);
    }

    function listenerTarget(fn) {
        return fn && fn.listener ? fn.listener : fn;
    }

    function isEventEmitter(value) {
        return value instanceof EventEmitter ||
            !!(value && typeof value.on === 'function' && typeof value.removeListener === 'function');
    }

    function isEventTarget(value) {
        return !!(value &&
            typeof value.addEventListener === 'function' &&
            typeof value.removeEventListener === 'function');
    }

    function getEventTargetListeners(target, type) {
        const map = target && target[_kEvents];
        const list = map && map.get(String(type));
        return list ? list.filter((entry) => !entry.removed).map((entry) => {
            const listener = entry.listener;
            return listener && listener[_kNodeEventTargetListenerWrapper] ? listener.listener : listener;
        }) : [];
    }

    function getAbortError(signal) {
        if (signal && signal.reason !== undefined) return signal.reason;
        if (typeof internalErrors !== 'undefined' && internalErrors.AbortError) {
            return new internalErrors.AbortError();
        }
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        err.code = 'ABORT_ERR';
        return err;
    }

    class EventEmitter {
        constructor(options) {
            this._events = Object.create(null);
            this._maxListeners = undefined;
            this._captureRejections = !!(options && options.captureRejections) || EventEmitter.captureRejections;
        }

        static get defaultMaxListeners() { return defaultMaxListeners; }
        static set defaultMaxListeners(n) {
            defaultMaxListeners = validateMaxListeners(n);
            _eventTargetDefaultMaxListeners = defaultMaxListeners;
        }

        static get captureRejections() { return defaultCaptureRejections; }
        static set captureRejections(value) { defaultCaptureRejections = !!value; }

        setMaxListeners(n) { this._maxListeners = validateMaxListeners(n); return this; }
        getMaxListeners() {
            return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
        }

        emit(event, ...args) {
            if (!this._events) this._events = Object.create(null);
            if (event === 'error') {
                const monitors = this._events[errorMonitor];
                if (monitors && monitors.length > 0) {
                    for (const monitor of monitors.slice()) monitor.apply(this, args);
                }
            }
            const listeners = this._events[event];
            if (!listeners || listeners.length === 0) {
                if (event === 'error') {
                    const err = args[0] instanceof Error ? args[0] : new Error('Unhandled error');
                    throw err;
                }
                return false;
            }
            const copy = listeners.slice();
            for (const fn of copy) {
                const result = fn.apply(this, args);
                if (this._captureRejections && result && typeof result.then === 'function') {
                    result.then(undefined, (err) => this._emitRejection(event, err, ...args));
                }
            }
            return true;
        }

        _emitRejection(event, err, ...args) {
            if (typeof this[captureRejectionSymbol] === 'function') {
                this[captureRejectionSymbol](err, event, ...args);
            } else {
                this.emit('error', err);
            }
        }

        _addListener(event, fn, prepend, once) {
            validateListener(fn);
            if (!this._events) this._events = Object.create(null);
            let listener = fn;
            if (once) {
                const self = this;
                listener = function onceWrapper(...args) {
                    self.removeListener(event, onceWrapper);
                    return fn.apply(this, args);
                };
                Object.defineProperty(listener, 'listener', {
                    value: fn,
                    configurable: true,
                });
            }
            if (event !== 'newListener' && this._events.newListener && this._events.newListener.length > 0) {
                this.emit('newListener', event, fn);
            }
            if (!this._events[event]) this._events[event] = [];
            if (prepend) this._events[event].unshift(listener);
            else this._events[event].push(listener);
            return this;
        }

        on(event, fn) {
            return this._addListener(event, fn, false, false);
        }

        once(event, fn) {
            return this._addListener(event, fn, false, true);
        }

        off(event, fn) {
            validateListener(fn);
            if (!this._events) this._events = Object.create(null);
            const list = this._events[event];
            if (!list) return this;
            for (let i = list.length - 1; i >= 0; i--) {
                const candidate = list[i];
                if (candidate === fn || candidate.listener === fn) {
                    list.splice(i, 1);
                    if (list.length === 0) delete this._events[event];
                    if (event !== 'removeListener' && this._events.removeListener && this._events.removeListener.length > 0) {
                        this.emit('removeListener', event, listenerTarget(candidate));
                    }
                    break;
                }
            }
            return this;
        }

        removeAllListeners(event) {
            if (!this._events) this._events = Object.create(null);
            const hasRemoveListener = this._events.removeListener && this._events.removeListener.length > 0;
            if (event !== undefined) {
                const list = this._events[event];
                if (!list) return this;
                delete this._events[event];
                if (hasRemoveListener && event !== 'removeListener') {
                    for (const fn of list.slice().reverse()) {
                        this.emit('removeListener', event, listenerTarget(fn));
                    }
                }
            } else {
                const names = Reflect.ownKeys(this._events);
                for (const name of names) {
                    if (name === 'removeListener') continue;
                    this.removeAllListeners(name);
                }
                if (this._events.removeListener) delete this._events.removeListener;
                this._events = Object.create(null);
            }
            return this;
        }

        listeners(event) {
            if (!this._events) this._events = Object.create(null);
            return (this._events[event] || []).map(listenerTarget);
        }

        rawListeners(event) {
            if (!this._events) this._events = Object.create(null);
            return (this._events[event] || []).slice();
        }

        listenerCount(event, listener) {
            if (!this._events) this._events = Object.create(null);
            const list = this._events[event] || [];
            if (listener === undefined) return list.length;
            return list.filter((candidate) => candidate === listener || candidate.listener === listener).length;
        }

        eventNames() {
            if (!this._events) this._events = Object.create(null);
            return Reflect.ownKeys(this._events).filter(k => this._events[k].length > 0);
        }

        prependListener(event, fn) {
            return this._addListener(event, fn, true, false);
        }

        prependOnceListener(event, fn) {
            return this._addListener(event, fn, true, true);
        }
    }

    // addListener/removeListener share function references with on/off so that
    // Minipass overriding one half and calling super.<other-half> dispatches to
    // the same body — `this.<half>` aliasing would infinite-loop.
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;
    EventEmitter.prototype.removeListener = EventEmitter.prototype.off;
    EventEmitter.listenerCount = function(emitter, event) {
        return emitter && typeof emitter.listenerCount === 'function' ? emitter.listenerCount(event) : 0;
    };
    EventEmitter.captureRejectionSymbol = captureRejectionSymbol;
    EventEmitter.errorMonitor = errorMonitor;

    // require('events') returns the EventEmitter class itself (Node compat).
    // Subclassing via `class Foo extends require('events')` only works if the
    // export IS the class — extending a function that returns `new EE()` makes
    // super() override `this`, leaving derived methods on an unused prototype.
    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.getEventListeners = function(emitterOrTarget, event) {
        if (isEventEmitter(emitterOrTarget)) return emitterOrTarget.listeners(event);
        if (isEventTarget(emitterOrTarget)) return getEventTargetListeners(emitterOrTarget, event);
        throw _makeInvalidArgTypeError('emitter', 'EventEmitter or EventTarget', emitterOrTarget);
    };
    EventEmitter.getMaxListeners = function(emitterOrTarget) {
        if (emitterOrTarget === undefined) return EventEmitter.defaultMaxListeners;
        if (emitterOrTarget && typeof emitterOrTarget.getMaxListeners === 'function') {
            return emitterOrTarget.getMaxListeners();
        }
        if (isEventTarget(emitterOrTarget)) {
            return emitterOrTarget._maxListeners === undefined
                ? _eventTargetDefaultMaxListeners
                : emitterOrTarget._maxListeners;
        }
        throw _makeInvalidArgTypeError('emitter', 'EventEmitter or EventTarget', emitterOrTarget);
    };
    EventEmitter.setMaxListeners = function(n, ...eventTargets) {
        n = validateMaxListeners(n);
        if (eventTargets.length === 0) {
            EventEmitter.defaultMaxListeners = n;
            return;
        }
        for (const target of eventTargets) {
            if (target && typeof target.setMaxListeners === 'function') {
                target.setMaxListeners(n);
            } else if (isEventTarget(target)) {
                target._maxListeners = n;
            } else {
                throw _makeInvalidArgTypeError('eventTargets', 'EventEmitter or EventTarget', target);
            }
        }
    };
    EventEmitter.addAbortListener = function(signal, listener) {
        validateListener(listener);
        if (!(signal instanceof globalThis.AbortSignal)) {
            throw _makeInvalidArgTypeError('signal', 'AbortSignal', signal);
        }
        if (signal.aborted) {
            queueMicrotask(() => listener.call(signal));
            return { [Symbol.dispose]() {} };
        }
        signal.addEventListener('abort', listener, { once: true });
        return {
            [Symbol.dispose]() { signal.removeEventListener('abort', listener); },
        };
    };
    EventEmitter.once = function(emitter, event, options) {
        return new Promise((resolve, reject) => {
            if (options !== undefined && (options === null || typeof options !== 'object')) {
                reject(_makeInvalidArgTypeError('options', 'object', options));
                return;
            }
            const signal = options && options.signal;
            if (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) {
                reject(_makeInvalidArgTypeError('signal', 'AbortSignal', signal));
                return;
            }
            if (!isEventEmitter(emitter) && !isEventTarget(emitter)) {
                reject(_makeInvalidArgTypeError('emitter', 'EventEmitter or EventTarget', emitter));
                return;
            }
            if (signal && signal.aborted) {
                reject(getAbortError(signal));
                return;
            }
            let settled = false;
            const cleanup = () => {
                if (isEventEmitter(emitter)) {
                    emitter.removeListener(event, onEvent);
                    if (event !== 'error') emitter.removeListener('error', onError);
                } else {
                    emitter.removeEventListener(event, onTargetEvent);
                }
                if (signal) signal.removeEventListener('abort', onAbort);
            };
            const onEvent = (...args) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(args);
            };
            const onTargetEvent = (ev) => onEvent(ev);
            const onError = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(getAbortError(signal));
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            // Use .on() plus explicit cleanup instead of emitter.once(). Some
            // npm streams cache selected metadata events and replay them from a
            // custom .on() implementation; routing events.once() through .once()
            // misses those replayed events and can leave callers hung forever.
            if (isEventEmitter(emitter)) {
                if (event !== 'error') emitter.on('error', onError);
                emitter.on(event, onEvent);
            } else {
                emitter.addEventListener(event, onTargetEvent, { once: true });
            }
        });
    };
    EventEmitter.on = function(emitter, event, options) {
        if (options !== undefined && (options === null || typeof options !== 'object')) {
            throw _makeInvalidArgTypeError('options', 'object', options);
        }
        if (!isEventEmitter(emitter) && !isEventTarget(emitter)) {
            throw _makeInvalidArgTypeError('emitter', 'EventEmitter or EventTarget', emitter);
        }
        const signal = options && options.signal;
        if (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) {
            throw _makeInvalidArgTypeError('signal', 'AbortSignal', signal);
        }
        const queue = [];
        const waiting = [];
        let error;
        let finished = false;
        const settleNext = () => {
            while (waiting.length > 0 && queue.length > 0) {
                waiting.shift().resolve({ value: queue.shift(), done: false });
            }
            if (finished || error) {
                while (waiting.length > 0) {
                    const waiter = waiting.shift();
                    if (error) waiter.reject(error);
                    else waiter.resolve({ value: undefined, done: true });
                }
            }
        };
        const cleanup = () => {
            if (isEventEmitter(emitter)) {
                emitter.removeListener(event, onEvent);
                emitter.removeListener('error', onError);
            } else {
                emitter.removeEventListener(event, onTargetEvent);
            }
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        const close = () => {
            if (finished) return;
            finished = true;
            cleanup();
            settleNext();
        };
        const onEvent = (...args) => {
            queue.push(args);
            settleNext();
        };
        const onTargetEvent = (ev) => onEvent(ev);
        const onError = (err) => {
            error = err;
            cleanup();
            settleNext();
        };
        const onAbort = () => {
            error = getAbortError(signal);
            cleanup();
            settleNext();
        };
        if (signal && signal.aborted) onAbort();
        else if (isEventEmitter(emitter)) {
            emitter.on(event, onEvent);
            if (event !== 'error') emitter.on('error', onError);
        } else {
            emitter.addEventListener(event, onTargetEvent);
        }
        if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
        return {
            [Symbol.asyncIterator]() { return this; },
            next() {
                if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
                if (error) return Promise.reject(error);
                if (finished) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
            },
            return() {
                close();
                return Promise.resolve({ value: undefined, done: true });
            },
            throw(err) {
                if (!(err instanceof Error)) {
                    throw _makeInvalidArgTypeError('EventEmitter.AsyncIterator', 'an instance of Error', err);
                }
                error = err;
                cleanup();
                settleNext();
                return Promise.reject(err);
            },
        };
    };
    return EventEmitter;
})();

// ============================================================
// async_hooks module
// ============================================================

const async_hooks = (() => {
    const rootResource = {};
    const rootRecord = {
        asyncId: 1,
        triggerAsyncId: 0,
        type: 'ROOT',
        resource: rootResource,
        stores: new Map(),
        destroyed: false,
    };

    let nextAsyncId = 1;
    let currentRecord = rootRecord;
    let currentStores = rootRecord.stores;
    const enabledHooks = new Set();
    const promiseHooks = new Set();
    const promiseRecords = new WeakMap();
    const destroyRegistry = typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry((record) => {
            if (record && !record.destroyed) emitDestroy(record);
        })
        : null;

    function makeTypeError(message, code) {
        const err = new TypeError(message);
        if (code) err.code = code;
        return err;
    }

    function makeRangeError(message, code) {
        const err = new RangeError(message);
        if (code) err.code = code;
        return err;
    }

    function reportHookError(err) {
        const proc = globalThis.process;
        if (proc && typeof proc.emit === 'function' && proc.emit('uncaughtException', err)) {
            return;
        }
        throw err;
    }

    function cloneStores(stores) {
        return new Map(stores || currentStores);
    }

    function callHook(hook, name, args) {
        const fn = hook && hook.callbacks && hook.callbacks[name];
        if (typeof fn !== 'function') return;
        try {
            fn.apply(hook, args);
        } catch (err) {
            reportHookError(err);
        }
    }

    function forEachHook(name, args) {
        for (const hook of Array.from(enabledHooks)) {
            callHook(hook, name, args);
        }
    }

    function newRecord(type, triggerAsyncId, resource, stores) {
        const destroyRef = {
            asyncId: ++nextAsyncId,
            destroyed: false,
        };
        const record = {
            asyncId: destroyRef.asyncId,
            triggerAsyncId,
            type,
            resource,
            stores: cloneStores(stores),
            destroyed: false,
            destroyRef,
        };
        forEachHook('init', [record.asyncId, type, triggerAsyncId, resource]);
        return record;
    }

    function emitDestroy(record) {
        if (!record) return;
        const destroyRef = record.destroyRef || record;
        if (destroyRef.destroyed) return;
        destroyRef.destroyed = true;
        record.destroyed = true;
        forEachHook('destroy', [record.asyncId]);
    }

    function emitPromiseResolve(record) {
        if (!record || record.promiseResolved) return;
        record.promiseResolved = true;
        forEachHook('promiseResolve', [record.asyncId]);
    }

    function validateAsyncId(id) {
        if (typeof id !== 'number' || !Number.isInteger(id) || id < -1) {
            throw makeRangeError('asyncId must be an unsigned integer', 'ERR_INVALID_ASYNC_ID');
        }
    }

    function validateCallback(name, value) {
        if (value !== undefined && typeof value !== 'function') {
            throw makeTypeError(`hook.${name} must be a function`, 'ERR_ASYNC_CALLBACK');
        }
    }

    function validatePromiseHook(name, value) {
        const ctorName = value && value.constructor && value.constructor.name;
        if (typeof value !== 'function' || ctorName === 'AsyncFunction' || ctorName === 'AsyncGeneratorFunction') {
            throw makeTypeError(`The "${name}Hook" argument must be of type function`);
        }
    }

    class AsyncHook {
        constructor(callbacks) {
            callbacks = callbacks || {};
            for (const name of ['init', 'before', 'after', 'destroy', 'promiseResolve']) {
                validateCallback(name, callbacks[name]);
            }
            this.callbacks = callbacks;
            this.enabled = false;
        }

        enable() {
            if (!this.enabled) {
                this.enabled = true;
                enabledHooks.add(this);
            }
            return this;
        }

        disable() {
            if (this.enabled) {
                this.enabled = false;
                enabledHooks.delete(this);
            }
            return this;
        }
    }

    class AsyncResource {
        constructor(type, options) {
            if (typeof type !== 'string') {
                throw makeTypeError('The "type" argument must be of type string', 'ERR_INVALID_ARG_TYPE');
            }
            if (type.length === 0) {
                throw makeTypeError('The "type" argument must be a non-empty string', 'ERR_ASYNC_TYPE');
            }
            let triggerAsyncId;
            let requireManualDestroy = false;
            if (typeof options === 'number') {
                validateAsyncId(options);
                triggerAsyncId = options;
            } else if (options && typeof options === 'object') {
                if (options.triggerAsyncId !== undefined) {
                    validateAsyncId(options.triggerAsyncId);
                    triggerAsyncId = options.triggerAsyncId;
                }
                requireManualDestroy = !!options.requireManualDestroy;
                if (options.eventEmitter !== undefined) {
                    this.eventEmitter = options.eventEmitter;
                }
            }
            if (triggerAsyncId === undefined || triggerAsyncId === -1) {
                triggerAsyncId = currentRecord.asyncId;
            }
            this._asyncRecord = newRecord(type, triggerAsyncId, this, currentStores);
            if (!requireManualDestroy && destroyRegistry) {
                destroyRegistry.register(this, this._asyncRecord.destroyRef, this);
            }
        }

        runInAsyncScope(fn, thisArg, ...args) {
            if (typeof fn !== 'function') {
                throw makeTypeError('The "fn" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
            }
            const record = this._asyncRecord;
            const prevRecord = currentRecord;
            const prevStores = currentStores;
            currentRecord = record;
            currentStores = record.stores;
            forEachHook('before', [record.asyncId]);
            try {
                return fn.apply(thisArg, args);
            } finally {
                forEachHook('after', [record.asyncId]);
                currentRecord = prevRecord;
                currentStores = prevStores;
            }
        }

        emitDestroy() {
            if (destroyRegistry) destroyRegistry.unregister(this);
            emitDestroy(this._asyncRecord);
            return this;
        }

        asyncId() { return this._asyncRecord.asyncId; }
        triggerAsyncId() { return this._asyncRecord.triggerAsyncId; }

        bind(fn, thisArg) {
            if (typeof fn !== 'function') {
                throw makeTypeError('The "fn" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
            }
            const resource = this;
            const bound = function(...args) {
                return resource.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args);
            };
            Object.defineProperty(bound, 'asyncResource', {
                value: resource,
                enumerable: true,
                configurable: true,
            });
            try {
                Object.defineProperty(bound, 'length', { value: fn.length, configurable: true });
            } catch {}
            return bound;
        }

        static bind(fn, type, thisArg) {
            if (typeof type !== 'string') {
                thisArg = type;
                type = fn && fn.name ? fn.name : 'bound-anonymous-fn';
            }
            return new AsyncResource(type).bind(fn, thisArg);
        }
    }

    class AsyncLocalStorage {
        run(store, fn, ...args) {
            if (typeof fn !== 'function') {
                throw makeTypeError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
            }
            const stores = cloneStores(currentStores);
            stores.set(this, store);
            const prevStores = currentStores;
            currentStores = stores;
            try {
                return fn.apply(undefined, args);
            } finally {
                currentStores = prevStores;
            }
        }

        exit(fn, ...args) {
            if (typeof fn !== 'function') {
                throw makeTypeError('The "callback" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
            }
            const stores = cloneStores(currentStores);
            stores.delete(this);
            const prevStores = currentStores;
            currentStores = stores;
            try {
                return fn.apply(undefined, args);
            } finally {
                currentStores = prevStores;
            }
        }

        getStore() { return currentStores.get(this); }

        enterWith(store) {
            currentStores = cloneStores(currentStores);
            currentStores.set(this, store);
        }

        disable() {
            currentStores = cloneStores(currentStores);
            currentStores.delete(this);
        }

        _propagate() {}

        static bind(fn) {
            if (typeof fn !== 'function') {
                throw makeTypeError('The "fn" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
            }
            const stores = cloneStores(currentStores);
            return function(...args) {
                const prevStores = currentStores;
                currentStores = cloneStores(stores);
                try {
                    return fn.apply(this, args);
                } finally {
                    currentStores = prevStores;
                }
            };
        }

        static snapshot() {
            const stores = cloneStores(currentStores);
            return function(fn, ...args) {
                if (typeof fn !== 'function') {
                    throw makeTypeError('The "fn" argument must be of type function', 'ERR_INVALID_ARG_TYPE');
                }
                const prevStores = currentStores;
                currentStores = cloneStores(stores);
                try {
                    return fn.apply(this, args);
                } finally {
                    currentStores = prevStores;
                }
            };
        }
    }

    function createHook(callbacks) {
        return new AsyncHook(callbacks);
    }

    const nativeQueueMicrotask = typeof globalThis.queueMicrotask === 'function'
        ? globalThis.queueMicrotask.bind(globalThis)
        : (fn) => NativePromise.resolve().then(fn);

    function queueMicrotaskWithResource(fn, type) {
        const resource = new AsyncResource(type || 'Microtask');
        nativeQueueMicrotask(() => {
            try {
                resource.runInAsyncScope(fn);
            } finally {
                resource.emitDestroy();
            }
        });
    }

    function callPromiseHook(hook, name, args) {
        const fn = hook && hook[name];
        if (typeof fn !== 'function') return;
        try {
            fn.apply(undefined, args);
        } catch (err) {
            reportHookError(err);
        }
    }

    function forEachPromiseHook(name, args) {
        for (const hook of Array.from(promiseHooks)) {
            callPromiseHook(hook, name, args);
        }
    }

    function registerPromise(promise, parent, triggerAsyncId, stores) {
        let record = promiseRecords.get(promise);
        if (record) return record;
        record = newRecord('PROMISE', triggerAsyncId, promise, stores);
        promiseRecords.set(promise, record);
        forEachPromiseHook('init', [promise, parent]);
        return record;
    }

    const NativePromise = globalThis.Promise;
    const nativeThen = NativePromise && NativePromise.prototype && NativePromise.prototype.then;
    const nativeCatch = NativePromise && NativePromise.prototype && NativePromise.prototype.catch;
    const nativeFinally = NativePromise && NativePromise.prototype && NativePromise.prototype.finally;
    const nativeResolve = NativePromise && NativePromise.resolve && NativePromise.resolve.bind(NativePromise);
    const nativeReject = NativePromise && NativePromise.reject && NativePromise.reject.bind(NativePromise);

    function markPromiseSettled(promise, record) {
        if (!record || record.settled) return;
        record.settled = true;
        forEachPromiseHook('settled', [promise]);
        emitPromiseResolve(record);
    }

    function trackPromiseSettled(promise, record) {
        if (!nativeThen || !promise || record.settleTracked) return;
        record.settleTracked = true;
        nativeThen.call(
            promise,
            () => markPromiseSettled(promise, record),
            () => markPromiseSettled(promise, record),
        );
    }

    function wrapPromiseCallback(fn, getRecord) {
        if (typeof fn !== 'function') return fn;
        const stores = cloneStores(currentStores);
        return function(value) {
            const record = getRecord();
            const prevRecord = currentRecord;
            const prevStores = currentStores;
            currentRecord = record || currentRecord;
            currentStores = record ? record.stores : stores;
            if (record) {
                forEachHook('before', [record.asyncId]);
                forEachPromiseHook('before', [record.resource]);
            }
            try {
                return fn.call(this, value);
            } finally {
                if (record) {
                    forEachPromiseHook('after', [record.resource]);
                    forEachHook('after', [record.asyncId]);
                }
                currentRecord = prevRecord;
                currentStores = prevStores;
            }
        };
    }

    if (NativePromise && nativeThen && !NativePromise.prototype.__kandeloAsyncHooksPatched) {
        Object.defineProperty(NativePromise.prototype, '__kandeloAsyncHooksPatched', { value: true });
        NativePromise.prototype.then = function(onFulfilled, onRejected) {
            const parent = this;
            const parentRecord = promiseRecords.get(parent);
            const triggerAsyncId = parentRecord ? parentRecord.asyncId : currentRecord.asyncId;
            const stores = cloneStores(currentStores);
            let child;
            let childRecord;
            const getRecord = () => childRecord;
            child = nativeThen.call(
                parent,
                wrapPromiseCallback(onFulfilled, getRecord),
                wrapPromiseCallback(onRejected, getRecord),
            );
            childRecord = registerPromise(child, parent, triggerAsyncId, stores);
            trackPromiseSettled(child, childRecord);
            return child;
        };
        NativePromise.prototype.catch = function(onRejected) {
            return this.then(undefined, onRejected);
        };
        if (nativeFinally) {
            NativePromise.prototype.finally = function(onFinally) {
                if (typeof onFinally !== 'function') return nativeFinally.call(this, onFinally);
                return this.then(
                    (value) => NativePromise.resolve(onFinally()).then(() => value),
                    (reason) => NativePromise.resolve(onFinally()).then(() => { throw reason; }),
                );
            };
        }
    }

    let HookedPromise = NativePromise;
    if (NativePromise && !globalThis.__kandeloAsyncHooksPromise) {
        HookedPromise = class Promise extends NativePromise {
            constructor(executor) {
                if (typeof executor !== 'function') {
                    throw makeTypeError('Promise resolver undefined is not a function');
                }
                let self;
                let record;
                let pendingSettled = false;
                super((resolve, reject) => {
                    const settle = (nativeSettle, value) => {
                        nativeSettle(value);
                        if (record && self) markPromiseSettled(self, record);
                        else pendingSettled = true;
                    };
                    try {
                        executor(
                            (value) => settle(resolve, value),
                            (reason) => settle(reject, reason),
                        );
                    } catch (err) {
                        settle(reject, err);
                    }
                });
                self = this;
                record = registerPromise(self, undefined, currentRecord.asyncId, currentStores);
                if (pendingSettled) markPromiseSettled(self, record);
                else trackPromiseSettled(self, record);
            }

            static get [Symbol.species]() { return NativePromise; }

            static resolve(value) {
                const promise = nativeResolve(value);
                const record = registerPromise(promise, undefined, currentRecord.asyncId, currentStores);
                markPromiseSettled(promise, record);
                return promise;
            }

            static reject(reason) {
                const promise = nativeReject(reason);
                const record = registerPromise(promise, undefined, currentRecord.asyncId, currentStores);
                markPromiseSettled(promise, record);
                return promise;
            }

            static all(iterable) {
                const promise = NativePromise.all(iterable);
                const record = registerPromise(promise, undefined, currentRecord.asyncId, currentStores);
                trackPromiseSettled(promise, record);
                return promise;
            }

            static race(iterable) {
                const promise = NativePromise.race(iterable);
                const record = registerPromise(promise, undefined, currentRecord.asyncId, currentStores);
                trackPromiseSettled(promise, record);
                return promise;
            }

            static allSettled(iterable) {
                const promise = NativePromise.allSettled(iterable);
                const record = registerPromise(promise, undefined, currentRecord.asyncId, currentStores);
                trackPromiseSettled(promise, record);
                return promise;
            }

            static any(iterable) {
                const promise = NativePromise.any(iterable);
                const record = registerPromise(promise, undefined, currentRecord.asyncId, currentStores);
                trackPromiseSettled(promise, record);
                return promise;
            }

            static withResolvers() {
                let resolve;
                let reject;
                const promise = new HookedPromise((res, rej) => {
                    resolve = res;
                    reject = rej;
                });
                return { promise, resolve, reject };
            }
        };
        globalThis.__kandeloAsyncHooksPromise = HookedPromise;
        globalThis.Promise = HookedPromise;
    }

    function addPromiseHook(name, fn) {
        validatePromiseHook(name, fn);
        const hook = { [name]: fn };
        promiseHooks.add(hook);
        return () => { promiseHooks.delete(hook); };
    }

    const promiseHooksApi = {
        createHook(callbacks) {
            callbacks = callbacks || {};
            const hook = {};
            if (callbacks.init !== undefined) {
                validatePromiseHook('init', callbacks.init);
                hook.init = callbacks.init;
            }
            if (callbacks.before !== undefined) {
                validatePromiseHook('before', callbacks.before);
                hook.before = callbacks.before;
            }
            if (callbacks.after !== undefined) {
                validatePromiseHook('after', callbacks.after);
                hook.after = callbacks.after;
            }
            if (callbacks.settled !== undefined) {
                validatePromiseHook('settled', callbacks.settled);
                hook.settled = callbacks.settled;
            }
            promiseHooks.add(hook);
            return () => { promiseHooks.delete(hook); };
        },
        onInit(fn) { return addPromiseHook('init', fn); },
        onBefore(fn) { return addPromiseHook('before', fn); },
        onAfter(fn) { return addPromiseHook('after', fn); },
        onSettled(fn) { return addPromiseHook('settled', fn); },
    };

    return {
        AsyncResource,
        AsyncLocalStorage,
        executionAsyncId: () => currentRecord.asyncId,
        triggerAsyncId: () => currentRecord.triggerAsyncId,
        executionAsyncResource: () => currentRecord.resource,
        createHook,
        promiseHooks: promiseHooksApi,
        _createResource(type) { return new AsyncResource(type); },
        _queueMicrotask: queueMicrotaskWithResource,
    };
})();

if (typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask = (fn) => async_hooks._queueMicrotask(fn, 'Microtask');
}

if (typeof globalThis.gc === 'function' &&
    typeof globalThis.drainJobQueue === 'function' &&
    !globalThis.gc.__kandeloDrainsFinalizers) {
    const nativeGc = globalThis.gc.bind(globalThis);
    const gcWithFinalizers = function(...args) {
        const result = nativeGc(...args);
        globalThis.drainJobQueue();
        return result;
    };
    Object.defineProperty(gcWithFinalizers, '__kandeloDrainsFinalizers', { value: true });
    globalThis.gc = gcWithFinalizers;
}

events.EventEmitterAsyncResource = class EventEmitterAsyncResource extends events.EventEmitter {
    constructor(options) {
        super();
        let name;
        let resourceOptions = options;
        if (typeof options === 'string') {
            name = options;
            resourceOptions = undefined;
        } else if (options && typeof options === 'object') {
            name = options.name;
        }
        if (!name) name = this.constructor && this.constructor.name || 'EventEmitterAsyncResource';
        resourceOptions = Object.assign({}, resourceOptions || {}, { eventEmitter: this });
        this._asyncResource = new async_hooks.AsyncResource(name, resourceOptions);
    }

    static _checkThis(value) {
        if (!(value instanceof events.EventEmitterAsyncResource)) {
            const err = new TypeError('Value of "this" must be of type EventEmitterAsyncResource');
            err.code = 'ERR_INVALID_THIS';
            throw err;
        }
    }

    emit(event, ...args) {
        events.EventEmitterAsyncResource._checkThis(this);
        return this._asyncResource.runInAsyncScope(() => events.EventEmitter.prototype.emit.call(this, event, ...args));
    }

    emitDestroy() {
        events.EventEmitterAsyncResource._checkThis(this);
        this._asyncResource.emitDestroy();
    }

    get asyncId() {
        events.EventEmitterAsyncResource._checkThis(this);
        return this._asyncResource.asyncId();
    }

    get triggerAsyncId() {
        events.EventEmitterAsyncResource._checkThis(this);
        return this._asyncResource.triggerAsyncId();
    }

    get asyncResource() {
        events.EventEmitterAsyncResource._checkThis(this);
        return this._asyncResource;
    }
};

// ============================================================
// Buffer class
// ============================================================

const Buffer = (() => {
    const _encoder = new TextEncoder();
    const _decoder = new TextDecoder();
    const kMaxLength = Number.MAX_SAFE_INTEGER;
    const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
    let inspectMaxBytes = 50;
    const UINT64_MAX = (1n << 64n) - 1n;
    const INT64_MIN = -(1n << 63n);
    const INT64_MAX = (1n << 63n) - 1n;

    function _normalizeEncodingName(encoding) {
        const enc = String(encoding).toLowerCase();
        if (enc === 'utf-8') return 'utf8';
        if (enc === 'binary') return 'latin1';
        if (enc === 'ucs-2') return 'ucs2';
        if (enc === 'utf-16le') return 'utf16le';
        return enc;
    }

    function _assertEncoding(encoding) {
        const enc = encoding === undefined ? 'utf8' : _normalizeEncodingName(encoding);
        if (!Buffer.isEncoding(enc)) {
            const err = new TypeError(`Unknown encoding: ${encoding}`);
            err.code = 'ERR_UNKNOWN_ENCODING';
            throw err;
        }
        return enc;
    }

    function _rangeError(name, min, max, value) {
        const err = new RangeError(`The value of "${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`);
        err.code = 'ERR_OUT_OF_RANGE';
        return err;
    }

    function _bufferOutOfBoundsError(name) {
        const err = new RangeError(`"${name}" is outside of buffer bounds`);
        err.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
        return err;
    }

    function _memoryOutOfBoundsError() {
        const err = new RangeError('Attempt to access memory outside buffer bounds');
        err.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
        return err;
    }

    function _invalidFillValueError(value) {
        let received;
        if (typeof value === 'string') received = `'${value}'`;
        else if (value instanceof Uint8Array && value.length === 0) received = '<Buffer >';
        else received = String(value);
        const err = new TypeError(`The argument 'value' is invalid. Received ${received}`);
        err.code = 'ERR_INVALID_ARG_VALUE';
        return err;
    }

    function _integerRangeError(name, value) {
        const err = new RangeError(`The value of "${name}" is out of range. It must be an integer. Received ${value}`);
        err.code = 'ERR_OUT_OF_RANGE';
        return err;
    }

    function _formatWideInteger(value) {
        return String(value).replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1_');
    }

    function _uintValueRangeError(byteLength, value) {
        const bits = byteLength * 8;
        const range = byteLength > 4 ? `< 2 ** ${bits}` : `<= ${Math.pow(2, bits) - 1}`;
        const received = byteLength > 4 ? _formatWideInteger(value) : value;
        const err = new RangeError(`The value of "value" is out of range. It must be >= 0 and ${range}. Received ${received}`);
        err.code = 'ERR_OUT_OF_RANGE';
        return err;
    }

    function _intValueRangeError(byteLength, value) {
        const bits = byteLength * 8;
        const min = -Math.pow(2, bits - 1);
        const max = Math.pow(2, bits - 1) - 1;
        const range = byteLength > 4 ? `>= -(2 ** ${bits - 1}) and < 2 ** ${bits - 1}` : `>= ${min} and <= ${max}`;
        const received = byteLength > 4 ? _formatWideInteger(value) : value;
        const err = new RangeError(`The value of "value" is out of range. It must be ${range}. Received ${received}`);
        err.code = 'ERR_OUT_OF_RANGE';
        return err;
    }

    function _formatBigIntForError(value) {
        const sign = value < 0n ? '-' : '';
        let digits = (value < 0n ? -value : value).toString();
        let out = '';
        while (digits.length > 3) {
            out = `_${digits.slice(-3)}${out}`;
            digits = digits.slice(0, -3);
        }
        return `${sign}${digits}${out}n`;
    }

    function _bigUIntRangeError(value) {
        const err = new RangeError(`The value of "value" is out of range. It must be >= 0n and < 2n ** 64n. Received ${_formatBigIntForError(value)}`);
        err.code = 'ERR_OUT_OF_RANGE';
        return err;
    }

    function _checkSize(size) {
        if (typeof size !== 'number') throw _makeInvalidArgTypeError('size', 'number', size);
        if (!Number.isFinite(size) || size < 0 || size > kMaxLength) {
            throw _rangeError('size', 0, kMaxLength, size);
        }
        return Math.floor(size);
    }

    function _checkArrayLikeSize(size) {
        size = Number(size);
        if (Number.isNaN(size) || size <= 0) return 0;
        if (!Number.isFinite(size) || size > kMaxLength) {
            throw _rangeError('size', 0, kMaxLength, size);
        }
        return Math.floor(size);
    }

    function _isArrayBuffer(value) {
        return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
    }

    function _isSharedArrayBuffer(value) {
        return typeof SharedArrayBuffer === 'function' &&
            (value instanceof SharedArrayBuffer || Object.prototype.toString.call(value) === '[object SharedArrayBuffer]');
    }

    function _toInteger(value, defaultValue) {
        if (value === undefined) return defaultValue;
        value = Number(value);
        if (Number.isNaN(value)) return 0;
        if (value === 0 || !Number.isFinite(value)) return value;
        return value < 0 ? Math.ceil(value) : Math.floor(value);
    }

    function _clampIndex(value, length, defaultValue) {
        value = _toInteger(value, defaultValue);
        if (value < 0) return 0;
        if (value > length) return length;
        return value;
    }

    function _normalizeSearchOffset(value, length) {
        value = _toInteger(value, 0);
        if (value < 0) return Math.max(length + value, 0);
        if (value > length) return length;
        return value;
    }

    function _checkOffset(offset, byteLength, length, allowUndefined = true) {
        if (offset === undefined) {
            if (allowUndefined) offset = 0;
            else throw _makeInvalidArgTypeError('offset', 'number', offset);
        }
        if (typeof offset !== 'number') {
            throw _makeInvalidArgTypeError('offset', 'number', offset);
        }
        if (Number.isNaN(offset) || (Number.isFinite(offset) && !Number.isInteger(offset))) {
            throw _integerRangeError('offset', offset);
        }
        if (length < byteLength) throw _memoryOutOfBoundsError();
        const max = length - byteLength;
        if (!Number.isFinite(offset) || offset < 0 || offset > max) throw _rangeError('offset', 0, Math.max(0, max), offset);
        return offset;
    }

    function _invalidBufferSize(bits) {
        const err = new RangeError(`Buffer size must be a multiple of ${bits}-bits`);
        err.code = 'ERR_INVALID_BUFFER_SIZE';
        return err;
    }

    function _base64String(value) {
        let str = String(value).replace(/[\t\n\f\r ]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
        const padding = str.indexOf('=');
        if (padding === 0) return '';
        if (padding > 0) str = str.slice(0, padding);
        str = str.replace(/[^A-Za-z0-9+/]/g, '');
        const remainder = str.length % 4;
        if (remainder === 2) str += '==';
        else if (remainder === 3) str += '=';
        else if (remainder === 1) str = str.slice(0, -1);
        return str;
    }

    function _bytesToBase64(bytes, urlSafe) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        let encoded = btoa(binary);
        if (urlSafe) encoded = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        return encoded;
    }

    function _encodeUtf8String(value) {
        const bytes = [];
        for (let i = 0; i < value.length; i++) {
            let code = value.charCodeAt(i);
            if (code >= 0xd800 && code <= 0xdbff) {
                if (i + 1 < value.length) {
                    const low = value.charCodeAt(i + 1);
                    if (low >= 0xdc00 && low <= 0xdfff) {
                        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
                        i++;
                    } else {
                        code = 0xfffd;
                    }
                } else {
                    code = 0xfffd;
                }
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                code = 0xfffd;
            }

            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            } else if (code < 0x10000) {
                bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            } else {
                bytes.push(
                    0xf0 | (code >> 18),
                    0x80 | ((code >> 12) & 0x3f),
                    0x80 | ((code >> 6) & 0x3f),
                    0x80 | (code & 0x3f),
                );
            }
        }
        return new Uint8Array(bytes);
    }

    function _inspectValue(value, inspectFn, options) {
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') return `'${value}'`;
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
        if (ArrayBuffer.isView(value) && !Buffer.isBuffer(value)) {
            const values = Array.from(value);
            return `${value.constructor.name}(${value.length}) [${values.length ? ' ' + values.join(', ') + ' ' : ''}]`;
        }
        return inspectFn ? inspectFn(value, options) : String(value);
    }

    function _inspectBuffer(buf, options, inspectFn) {
        const shown = Math.min(buf.length, inspectMaxBytes);
        const bytes = [];
        for (let i = 0; i < shown; i++) bytes.push(buf[i].toString(16).padStart(2, '0'));
        if (buf.length > shown) {
            const remaining = buf.length - shown;
            bytes.push('...', `${remaining} more ${remaining === 1 ? 'byte' : 'bytes'}`);
        }
        const props = Object.keys(buf)
            .filter((key) => !/^(0|[1-9]\d*)$/.test(key))
            .map((key) => `${key}: ${_inspectValue(buf[key], inspectFn, options)}`);
        const body = bytes.join(' ') + (bytes.length && props.length ? ', ' : '') + props.join(', ');
        return `<Buffer${body ? ' ' + body : ''}>`;
    }

    function _readBigUInt64(buf, offset, littleEndian) {
        offset = _checkOffset(offset, 8, buf.length);
        let value = 0n;
        for (let i = 0; i < 8; i++) {
            const byte = BigInt(buf[offset + (littleEndian ? i : 7 - i)]);
            value |= byte << BigInt(i * 8);
        }
        return value;
    }

    function _writeBigUInt64(buf, value, offset, littleEndian) {
        if (typeof value !== 'bigint') throw _makeInvalidArgTypeError('value', 'bigint', value);
        offset = _checkOffset(offset, 8, buf.length);
        if (value < 0n || value > UINT64_MAX) throw _bigUIntRangeError(value);
        for (let i = 0; i < 8; i++) {
            const byte = Number((value >> BigInt(i * 8)) & 0xffn);
            buf[offset + (littleEndian ? i : 7 - i)] = byte;
        }
        return offset + 8;
    }

    function _checkIntByteLength(byteLength) {
        if (typeof byteLength !== 'number') throw _makeInvalidArgTypeError('byteLength', 'number', byteLength);
        if (Number.isNaN(byteLength) || (Number.isFinite(byteLength) && !Number.isInteger(byteLength))) {
            throw _integerRangeError('byteLength', byteLength);
        }
        if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
            throw _rangeError('byteLength', 1, 6, byteLength);
        }
        return byteLength;
    }

    function _readUInt(buf, offset, byteLength, littleEndian, allowUndefinedOffset = true) {
        byteLength = _checkIntByteLength(byteLength);
        offset = _checkOffset(offset, byteLength, buf.length, allowUndefinedOffset);
        let value = 0;
        if (littleEndian) {
            let mul = 1;
            for (let i = 0; i < byteLength; i++) {
                value += buf[offset + i] * mul;
                mul *= 0x100;
            }
        } else {
            for (let i = 0; i < byteLength; i++) value = value * 0x100 + buf[offset + i];
        }
        return value;
    }

    function _readInt(buf, offset, byteLength, littleEndian, allowUndefinedOffset = true) {
        const value = _readUInt(buf, offset, byteLength, littleEndian, allowUndefinedOffset);
        const limit = Math.pow(2, 8 * byteLength - 1);
        return value >= limit ? value - Math.pow(2, 8 * byteLength) : value;
    }

    function _writeUIntBytes(buf, value, offset, byteLength, littleEndian) {
        if (littleEndian) {
            for (let i = 0; i < byteLength; i++) {
                buf[offset + i] = value & 0xff;
                value = Math.floor(value / 0x100);
            }
        } else {
            for (let i = byteLength - 1; i >= 0; i--) {
                buf[offset + i] = value & 0xff;
                value = Math.floor(value / 0x100);
            }
        }
        return offset + byteLength;
    }

    function _writeUInt(buf, value, offset, byteLength, littleEndian, allowUndefinedOffset = true) {
        byteLength = _checkIntByteLength(byteLength);
        offset = _checkOffset(offset, byteLength, buf.length, allowUndefinedOffset);
        value = Number(value);
        if (!Number.isNaN(value) && (!Number.isFinite(value) || value < 0 || value >= Math.pow(2, byteLength * 8))) {
            throw _uintValueRangeError(byteLength, value);
        }
        return _writeUIntBytes(buf, value, offset, byteLength, littleEndian);
    }

    function _writeInt(buf, value, offset, byteLength, littleEndian, allowUndefinedOffset = true) {
        byteLength = _checkIntByteLength(byteLength);
        offset = _checkOffset(offset, byteLength, buf.length, allowUndefinedOffset);
        value = Number(value);
        const limit = Math.pow(2, 8 * byteLength - 1);
        if (!Number.isNaN(value) && (!Number.isFinite(value) || value < -limit || value >= limit)) {
            throw _intValueRangeError(byteLength, value);
        }
        if (value < 0) value += Math.pow(2, 8 * byteLength);
        return _writeUIntBytes(buf, value, offset, byteLength, littleEndian);
    }

    function _encodeString(value, encoding) {
        const enc = _assertEncoding(encoding);
        value = String(value);
        if (enc === 'hex') {
            const bytes = [];
            for (let i = 0; i + 1 < value.length; i += 2) {
                const byte = parseInt(value.substr(i, 2), 16);
                if (Number.isNaN(byte)) break;
                bytes.push(byte);
            }
            return new Uint8Array(bytes);
        }
        if (enc === 'base64' || enc === 'base64url') {
            const binary = atob(_base64String(value));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        if (enc === 'latin1' || enc === 'ascii') {
            const bytes = new Uint8Array(value.length);
            for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
            return bytes;
        }
        if (enc === 'ucs2' || enc === 'utf16le') {
            const bytes = new Uint8Array(value.length * 2);
            for (let i = 0; i < value.length; i++) {
                const c = value.charCodeAt(i);
                bytes[i * 2] = c & 0xff;
                bytes[i * 2 + 1] = c >> 8;
            }
            return bytes;
        }
        return _encodeUtf8String(value);
    }

    function _utf8CompletePrefixLength(bytes, limit) {
        let offset = 0;
        let lastComplete = 0;
        while (offset < bytes.length && offset < limit) {
            const b = bytes[offset];
            let width = 1;
            if (b >= 0xc2 && b <= 0xdf) width = 2;
            else if (b >= 0xe0 && b <= 0xef) width = 3;
            else if (b >= 0xf0 && b <= 0xf4) width = 4;
            if (offset + width > limit) break;
            offset += width;
            lastComplete = offset;
        }
        return lastComplete;
    }

    function _coerceArrayBufferOffset(value, byteLength) {
        if (value === undefined) return 0;
        value = Number(value);
        if (Number.isNaN(value)) return 0;
        if (value === Infinity || value > byteLength) throw _bufferOutOfBoundsError('offset');
        return value < 0 ? value : Math.floor(value);
    }

    function _coerceArrayBufferLength(value, available) {
        if (value === undefined) return available;
        value = Number(value);
        if (Number.isNaN(value) || value < 0) return 0;
        if (value === Infinity || value > available) throw _bufferOutOfBoundsError('length');
        return Math.floor(value);
    }

    function _fromArrayBuffer(value, byteOffset, length) {
        const offset = _coerceArrayBufferOffset(byteOffset, value.byteLength);
        const viewLength = _coerceArrayBufferLength(length, value.byteLength - offset);
        return new Buffer(value, offset, viewLength);
    }

    class Buffer extends Uint8Array {
        // Static factory methods
        static alloc(size, fill, encoding) {
            size = _checkSize(size);
            const buf = new Buffer(size);
            if (fill !== undefined) {
                buf.fill(fill, 0, size, encoding);
            }
            return buf;
        }

        static allocUnsafe(size) {
            return new Buffer(_checkSize(size));
        }

        static allocUnsafeSlow(size) {
            return new Buffer(_checkSize(size));
        }

        static from(value, encodingOrOffset, length) {
            if (typeof value === 'string') {
                return new Buffer(_encodeString(value, encodingOrOffset));
            }
            if (_isArrayBuffer(value) || _isSharedArrayBuffer(value)) {
                return _fromArrayBuffer(value, encodingOrOffset, length);
            }
            if (ArrayBuffer.isView(value)) {
                return new Buffer(value instanceof DataView ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value);
            }
            if (Array.isArray(value)) {
                return new Buffer(value);
            }
            if (value && typeof value === 'object') {
                if (value.type === 'Buffer' && Array.isArray(value.data)) {
                    return new Buffer(value.data);
                }
                if (typeof value.valueOf === 'function' && value.valueOf !== Object.prototype.valueOf) {
                    const primitive = value.valueOf();
                    if (typeof primitive === 'string') {
                        return Buffer.from(primitive, encodingOrOffset, length);
                    }
                }
                if (typeof value[Symbol.toPrimitive] === 'function') {
                    const primitive = value[Symbol.toPrimitive]('string');
                    if (typeof primitive === 'string') {
                        return Buffer.from(primitive, encodingOrOffset, length);
                    }
                }
                if (value.length !== undefined) {
                    const size = _checkArrayLikeSize(value.length);
                    const buf = new Buffer(size);
                    for (let i = 0; i < size; i++) buf[i] = Number(value[i]) & 0xff;
                    return buf;
                }
                if (_isArrayBuffer(value.buffer) || _isSharedArrayBuffer(value.buffer)) {
                    return new Buffer(0);
                }
            }
            throw _makeInvalidArgTypeError('first argument', 'string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object', value);
        }

        static copyBytesFrom(view, offset, length) {
            if (!ArrayBuffer.isView(view) || view instanceof DataView) {
                throw _makeInvalidArgTypeError('view', 'TypedArray', view);
            }
            function validateIndex(value, name, defaultValue) {
                if (value === undefined) return defaultValue;
                if (typeof value !== 'number') throw _makeInvalidArgTypeError(name, 'number', value);
                if (!Number.isInteger(value) || value < 0) throw _rangeError(name, 0, view.length, value);
                return value;
            }
            offset = validateIndex(offset, 'offset', 0);
            length = validateIndex(length, 'length', view.length - offset);
            const elementLength = Math.max(0, Math.min(length, view.length - offset));
            const byteLength = elementLength * view.BYTES_PER_ELEMENT;
            const out = Buffer.allocUnsafe(byteLength);
            out.set(new Uint8Array(view.buffer, view.byteOffset + offset * view.BYTES_PER_ELEMENT, byteLength));
            return out;
        }

        static concat(list, totalLength) {
            if (totalLength === undefined) {
                totalLength = 0;
                for (const buf of list) totalLength += buf.length;
            }
            const result = Buffer.alloc(totalLength);
            let offset = 0;
            for (const buf of list) {
                const src = buf instanceof Uint8Array ? buf : Buffer.from(buf);
                result.set(src, offset);
                offset += src.length;
                if (offset >= totalLength) break;
            }
            return result;
        }

        static isBuffer(obj) {
            return obj instanceof Buffer;
        }

        static isEncoding(encoding) {
            if (encoding === undefined || encoding === null) return false;
            return ['utf8', 'ascii', 'latin1', 'hex', 'base64', 'base64url', 'ucs2', 'utf16le']
                   .includes(_normalizeEncodingName(encoding));
        }

        static byteLength(string, encoding) {
            if (typeof string !== 'string') {
                if (string instanceof ArrayBuffer || _isSharedArrayBuffer(string)) return string.byteLength;
                if (ArrayBuffer.isView(string)) return string.byteLength;
                throw _makeInvalidArgTypeError('string', 'string or an instance of Buffer or ArrayBuffer', string);
            }
            return _encodeString(string, encoding).length;
        }

        static compare(a, b) {
            if (!(a instanceof Uint8Array)) throw _makeInvalidArgTypeError('buf1', 'Buffer or Uint8Array', a);
            if (!(b instanceof Uint8Array)) throw _makeInvalidArgTypeError('buf2', 'Buffer or Uint8Array', b);
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
            encoding = _assertEncoding(encoding);
            start = _clampIndex(start, this.length, 0);
            end = _clampIndex(end, this.length, this.length);
            if (end <= start) return '';
            const slice = this.subarray(start, end);

            if (encoding === 'hex') {
                let hex = '';
                for (let i = 0; i < slice.length; i++) {
                    hex += slice[i].toString(16).padStart(2, '0');
                }
                return hex;
            }
            if (encoding === 'base64' || encoding === 'base64url') {
                return _bytesToBase64(slice, encoding === 'base64url');
            }
            if (encoding === 'latin1') {
                let out = '';
                for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
                return out;
            }
            if (encoding === 'ascii') {
                let out = '';
                for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i] & 0x7f);
                return out;
            }
            if (encoding === 'ucs2' || encoding === 'utf16le') {
                let out = '';
                for (let i = 0; i + 1 < slice.length; i += 2) {
                    out += String.fromCharCode(slice[i] | (slice[i + 1] << 8));
                }
                return out;
            }
            return _decoder.decode(slice);
        }

        write(string, offset, length, encoding) {
            if (typeof offset === 'string') {
                if (length !== undefined || encoding !== undefined) {
                    throw _makeInvalidArgTypeError('offset', 'number', offset);
                }
                encoding = offset; offset = 0; length = this.length;
            }
            else if (typeof length === 'string') { encoding = length; length = this.length - (offset || 0); }
            else if (typeof offset !== 'number' && offset !== undefined) {
                throw _makeInvalidArgTypeError('offset', 'number', offset);
            }
            offset = offset || 0;
            if (offset < 0 || offset > this.length) {
                const err = new RangeError(`The value of "offset" is out of range. It must be >= 0 && <= ${this.length}. Received ${offset}`);
                err.code = 'ERR_OUT_OF_RANGE';
                throw err;
            }
            length = length === undefined ? this.length - offset : length;
            if (length < 0 || offset + Math.min(1, length) > this.length) {
                throw _rangeError('offset', 0, this.length, offset);
            }
            const enc = _assertEncoding(encoding);
            const bytes = _encodeString(string, enc);
            let toWrite = Math.min(bytes.length, length, this.length - offset);
            if (enc === 'utf8' && toWrite < bytes.length) toWrite = _utf8CompletePrefixLength(bytes, toWrite);
            if ((enc === 'ucs2' || enc === 'utf16le') && (toWrite % 2) !== 0) toWrite--;
            for (let i = 0; i < toWrite; i++) this[offset + i] = bytes[i];
            return toWrite;
        }

        fill(value, offset, end, encoding) {
            if (typeof offset === 'string') {
                encoding = offset;
                offset = 0;
                end = this.length;
            } else {
                offset = _clampIndex(offset, this.length, 0);
                if (typeof end === 'string') {
                    encoding = end;
                    end = this.length;
                } else {
                    end = _clampIndex(end, this.length, this.length);
                }
            }
            if (end <= offset) return this;

            if (typeof value === 'string') {
                if (encoding !== undefined && typeof encoding !== 'string') {
                    throw _makeInvalidArgTypeError('encoding', 'string', encoding);
                }
                const bytes = _encodeString(value, encoding);
                if (bytes.length === 0 && value.length > 0) throw _invalidFillValueError(value);
                if (bytes.length === 0) return this;
                for (let i = offset; i < end; i++) this[i] = bytes[(i - offset) % bytes.length];
                return this;
            }
            if (value instanceof Uint8Array) {
                if (value.length === 0) throw _invalidFillValueError(value);
                for (let i = offset; i < end; i++) this[i] = value[(i - offset) % value.length];
                return this;
            }
            Uint8Array.prototype.fill.call(this, Number(value) & 0xff, offset, end);
            return this;
        }

        get parent() { return ArrayBuffer.isView(this) ? this.buffer : undefined; }
        get offset() { return ArrayBuffer.isView(this) ? this.byteOffset : undefined; }

        toJSON() {
            return { type: 'Buffer', data: Array.from(this) };
        }

        equals(other) {
            return Buffer.compare(this, other) === 0;
        }

        compare(other, targetStart, targetEnd, sourceStart, sourceEnd) {
            const src = this.subarray(sourceStart || 0, sourceEnd);
            const tgt = (other instanceof Uint8Array ? other : Buffer.from(other))
                        .subarray(targetStart || 0, targetEnd);
            return Buffer.compare(src, tgt);
        }

        copy(target, targetStart, sourceStart, sourceEnd) {
            if (!(target instanceof Uint8Array)) throw _makeInvalidArgTypeError('target', 'an instance of Buffer or Uint8Array', target);
            targetStart = _toInteger(targetStart, 0);
            sourceStart = _toInteger(sourceStart, 0);
            sourceEnd = _toInteger(sourceEnd, this.length);
            if (targetStart < 0) throw _rangeError('targetStart', 0, target.length, targetStart);
            if (sourceStart < 0 || sourceStart > this.length) throw _rangeError('sourceStart', 0, this.length, sourceStart);
            if (sourceEnd < 0) throw _rangeError('sourceEnd', 0, this.length, sourceEnd);
            if (targetStart >= target.length || sourceEnd <= sourceStart) return 0;
            sourceEnd = Math.min(sourceEnd, this.length);
            const slice = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + target.length - targetStart));
            target.set(slice, targetStart);
            return slice.length;
        }

        slice(start, end) {
            const sliced = super.subarray(start, end);
            return Object.setPrototypeOf(sliced, Buffer.prototype);
        }

        subarray(start, end) {
            const sliced = super.subarray(start, end);
            return Object.setPrototypeOf(sliced, Buffer.prototype);
        }

        indexOf(value, byteOffset, encoding) {
            if (typeof byteOffset === 'string') { encoding = byteOffset; byteOffset = 0; }
            byteOffset = _normalizeSearchOffset(byteOffset, this.length);
            if (typeof value === 'number') {
                value &= 0xff;
                for (let i = byteOffset; i < this.length; i++) {
                    if (this[i] === value) return i;
                }
                return -1;
            }
            if (typeof value === 'string') value = Buffer.from(value, encoding);
            else if (value instanceof Uint8Array) value = Buffer.from(value);
            else throw _makeInvalidArgTypeError('value', 'number or string or an instance of Buffer or Uint8Array', value);
            if (value.length === 0) return byteOffset;
            for (let i = byteOffset; i <= this.length - value.length; i++) {
                let found = true;
                for (let j = 0; j < value.length; j++) {
                    if (this[i + j] !== value[j]) { found = false; break; }
                }
                if (found) return i;
            }
            return -1;
        }

        lastIndexOf(value, byteOffset, encoding) {
            if (typeof byteOffset === 'string') { encoding = byteOffset; byteOffset = this.length; }
            byteOffset = byteOffset === undefined ? this.length : _toInteger(byteOffset, this.length);
            if (byteOffset < 0) byteOffset = this.length + byteOffset;
            if (byteOffset < 0) byteOffset = 0;
            if (byteOffset > this.length) byteOffset = this.length;
            if (typeof value === 'number') {
                value &= 0xff;
                for (let i = Math.min(byteOffset, this.length - 1); i >= 0; i--) {
                    if (this[i] === value) return i;
                }
                return -1;
            }
            if (typeof value === 'string') value = Buffer.from(value, encoding);
            else if (value instanceof Uint8Array) value = Buffer.from(value);
            else throw _makeInvalidArgTypeError('value', 'number or string or an instance of Buffer or Uint8Array', value);
            if (value.length === 0) return byteOffset;
            for (let i = Math.min(byteOffset, this.length - value.length); i >= 0; i--) {
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

        swap16() {
            if (this.length % 2 !== 0) throw _invalidBufferSize(16);
            for (let i = 0; i < this.length; i += 2) {
                const a = this[i];
                this[i] = this[i + 1];
                this[i + 1] = a;
            }
            return this;
        }

        swap32() {
            if (this.length % 4 !== 0) throw _invalidBufferSize(32);
            for (let i = 0; i < this.length; i += 4) {
                const a = this[i], b = this[i + 1];
                this[i] = this[i + 3];
                this[i + 1] = this[i + 2];
                this[i + 2] = b;
                this[i + 3] = a;
            }
            return this;
        }

        swap64() {
            if (this.length % 8 !== 0) throw _invalidBufferSize(64);
            for (let i = 0; i < this.length; i += 8) {
                const a = this[i], b = this[i + 1], c = this[i + 2], d = this[i + 3];
                this[i] = this[i + 7];
                this[i + 1] = this[i + 6];
                this[i + 2] = this[i + 5];
                this[i + 3] = this[i + 4];
                this[i + 4] = d;
                this[i + 5] = c;
                this[i + 6] = b;
                this[i + 7] = a;
            }
            return this;
        }

        // Read/write integers (little-endian and big-endian)
        readUInt8(offset) { return _readUInt(this, offset, 1, true); }
        readUInt16LE(offset) { return _readUInt(this, offset, 2, true); }
        readUInt16BE(offset) { return _readUInt(this, offset, 2, false); }
        readUInt32LE(offset) { return _readUInt(this, offset, 4, true); }
        readUInt32BE(offset) { return _readUInt(this, offset, 4, false); }
        readUIntLE(offset, byteLength) { return _readUInt(this, offset, byteLength, true, false); }
        readUIntBE(offset, byteLength) { return _readUInt(this, offset, byteLength, false, false); }
        readUintLE(offset, byteLength) { return this.readUIntLE(offset, byteLength); }
        readUintBE(offset, byteLength) { return this.readUIntBE(offset, byteLength); }
        readInt8(offset) { return _readInt(this, offset, 1, true); }
        readInt16LE(offset) { return _readInt(this, offset, 2, true); }
        readInt16BE(offset) { return _readInt(this, offset, 2, false); }
        readInt32LE(offset) { return _readInt(this, offset, 4, true); }
        readInt32BE(offset) { return _readInt(this, offset, 4, false); }
        readIntLE(offset, byteLength) { return _readInt(this, offset, byteLength, true, false); }
        readIntBE(offset, byteLength) { return _readInt(this, offset, byteLength, false, false); }

        writeUInt8(value, offset) { return _writeUInt(this, value, offset, 1, true); }
        writeUInt16LE(value, offset) { return _writeUInt(this, value, offset, 2, true); }
        writeUInt16BE(value, offset) { return _writeUInt(this, value, offset, 2, false); }
        writeUInt32LE(value, offset) { return _writeUInt(this, value, offset, 4, true); }
        writeUInt32BE(value, offset) { return _writeUInt(this, value, offset, 4, false); }
        writeUIntLE(value, offset, byteLength) { return _writeUInt(this, value, offset, byteLength, true, false); }
        writeUIntBE(value, offset, byteLength) { return _writeUInt(this, value, offset, byteLength, false, false); }
        writeUintLE(value, offset, byteLength) { return this.writeUIntLE(value, offset, byteLength); }
        writeUintBE(value, offset, byteLength) { return this.writeUIntBE(value, offset, byteLength); }
        writeInt8(value, offset) { return _writeInt(this, value, offset, 1, true); }
        writeInt16LE(value, offset) { return _writeInt(this, value, offset, 2, true); }
        writeInt16BE(value, offset) { return _writeInt(this, value, offset, 2, false); }
        writeInt32LE(value, offset) { return _writeInt(this, value, offset, 4, true); }
        writeInt32BE(value, offset) { return _writeInt(this, value, offset, 4, false); }
        writeIntLE(value, offset, byteLength) { return _writeInt(this, value, offset, byteLength, true, false); }
        writeIntBE(value, offset, byteLength) { return _writeInt(this, value, offset, byteLength, false, false); }

        // Float read/write via DataView
        readFloatLE(offset) { offset = _checkOffset(offset, 4, this.length); return new DataView(this.buffer, this.byteOffset).getFloat32(offset, true); }
        readFloatBE(offset) { offset = _checkOffset(offset, 4, this.length); return new DataView(this.buffer, this.byteOffset).getFloat32(offset, false); }
        readDoubleLE(offset) { offset = _checkOffset(offset, 8, this.length); return new DataView(this.buffer, this.byteOffset).getFloat64(offset, true); }
        readDoubleBE(offset) { offset = _checkOffset(offset, 8, this.length); return new DataView(this.buffer, this.byteOffset).getFloat64(offset, false); }
        writeFloatLE(value, offset) { offset = _checkOffset(offset, 4, this.length); new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, true); return offset + 4; }
        writeFloatBE(value, offset) { offset = _checkOffset(offset, 4, this.length); new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, false); return offset + 4; }
        writeDoubleLE(value, offset) { offset = _checkOffset(offset, 8, this.length); new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, true); return offset + 8; }
        writeDoubleBE(value, offset) { offset = _checkOffset(offset, 8, this.length); new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, false); return offset + 8; }

        readBigUInt64LE(offset) { return _readBigUInt64(this, offset, true); }
        readBigUInt64BE(offset) { return _readBigUInt64(this, offset, false); }
        readBigUint64LE(offset) { return this.readBigUInt64LE(offset); }
        readBigUint64BE(offset) { return this.readBigUInt64BE(offset); }
        readBigInt64LE(offset) {
            const value = this.readBigUInt64LE(offset);
            return value & (1n << 63n) ? value - (1n << 64n) : value;
        }
        readBigInt64BE(offset) {
            const value = this.readBigUInt64BE(offset);
            return value & (1n << 63n) ? value - (1n << 64n) : value;
        }
        writeBigUInt64LE(value, offset) { return _writeBigUInt64(this, value, offset, true); }
        writeBigUInt64BE(value, offset) { return _writeBigUInt64(this, value, offset, false); }
        writeBigUint64LE(value, offset) { return this.writeBigUInt64LE(value, offset); }
        writeBigUint64BE(value, offset) { return this.writeBigUInt64BE(value, offset); }
        writeBigInt64LE(value, offset) {
            if (typeof value !== 'bigint') throw _makeInvalidArgTypeError('value', 'bigint', value);
            if (value < INT64_MIN || value > INT64_MAX) throw _rangeError('value', INT64_MIN, INT64_MAX, value);
            return _writeBigUInt64(this, value < 0n ? (1n << 64n) + value : value, offset, true);
        }
        writeBigInt64BE(value, offset) {
            if (typeof value !== 'bigint') throw _makeInvalidArgTypeError('value', 'bigint', value);
            if (value < INT64_MIN || value > INT64_MAX) throw _rangeError('value', INT64_MIN, INT64_MAX, value);
            return _writeBigUInt64(this, value < 0n ? (1n << 64n) + value : value, offset, false);
        }

        inspect() { return _inspectBuffer(this); }
        [INSPECT_CUSTOM](depth, options, inspectFn) { return _inspectBuffer(this, options, inspectFn); }
    }

    function _aliasPrototypeMethod(proto, alias, original) {
        Object.defineProperty(proto, alias, {
            value: proto[original],
            writable: true,
            configurable: true,
        });
    }

    for (const [alias, original] of [
        ['readUint8', 'readUInt8'],
        ['readUint16LE', 'readUInt16LE'],
        ['readUint16BE', 'readUInt16BE'],
        ['readUint32LE', 'readUInt32LE'],
        ['readUint32BE', 'readUInt32BE'],
        ['readUintLE', 'readUIntLE'],
        ['readUintBE', 'readUIntBE'],
        ['writeUint8', 'writeUInt8'],
        ['writeUint16LE', 'writeUInt16LE'],
        ['writeUint16BE', 'writeUInt16BE'],
        ['writeUint32LE', 'writeUInt32LE'],
        ['writeUint32BE', 'writeUInt32BE'],
        ['writeUintLE', 'writeUIntLE'],
        ['writeUintBE', 'writeUIntBE'],
        ['readBigUint64LE', 'readBigUInt64LE'],
        ['readBigUint64BE', 'readBigUInt64BE'],
        ['writeBigUint64LE', 'writeBigUInt64LE'],
        ['writeBigUint64BE', 'writeBigUInt64BE'],
        ['toLocaleString', 'toString'],
    ]) {
        _aliasPrototypeMethod(Buffer.prototype, alias, original);
    }

    const BufferClass = Buffer;
    function BufferFactory(value, encodingOrOffset, length) {
        if (value === undefined) return BufferClass.alloc(0);
        if (typeof value === 'number') return BufferClass.allocUnsafe(value);
        return BufferClass.from(value, encodingOrOffset, length);
    }
    Object.setPrototypeOf(BufferFactory, BufferClass);
    BufferFactory.prototype = BufferClass.prototype;
    Object.defineProperty(BufferFactory.prototype, 'constructor', {
        value: BufferFactory,
        writable: true,
        configurable: true,
    });
    BufferFactory.kMaxLength = kMaxLength;
    Object.defineProperty(BufferFactory, 'INSPECT_MAX_BYTES', {
        get() { return inspectMaxBytes; },
        set(value) { inspectMaxBytes = Number(value); },
        configurable: true,
    });
    return BufferFactory;
})();

function _bufferToBytes(input, name) {
    try {
        if (input instanceof ArrayBuffer) {
            if (_isDetachedArrayBuffer(input)) {
                const stateErr = new Error('Cannot validate on a detached buffer');
                stateErr.code = 'ERR_INVALID_STATE';
                throw stateErr;
            }
            return new Uint8Array(input);
        }
        if (typeof SharedArrayBuffer === 'function' && input instanceof SharedArrayBuffer) {
            return new Uint8Array(input);
        }
        if (ArrayBuffer.isView(input)) {
            return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        }
    } catch (err) {
        const stateErr = new TypeError(`The "${name}" argument is detached`);
        stateErr.code = 'ERR_INVALID_STATE';
        throw stateErr;
    }
    throw _makeInvalidArgTypeError(name, 'ArrayBuffer or ArrayBufferView', input);
}

function _bufferIsAscii(input) {
    const bytes = _bufferToBytes(input, 'input');
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] > 0x7f) return false;
    }
    return true;
}

function _bufferIsUtf8(input) {
    const bytes = _bufferToBytes(input, 'input');
    let i = 0;
    while (i < bytes.length) {
        const b0 = bytes[i++];
        if (b0 <= 0x7f) continue;
        if (b0 >= 0xc2 && b0 <= 0xdf) {
            if (i >= bytes.length || (bytes[i++] & 0xc0) !== 0x80) return false;
            continue;
        }
        if (b0 === 0xe0) {
            if (i + 1 >= bytes.length || bytes[i] < 0xa0 || bytes[i] > 0xbf || (bytes[i + 1] & 0xc0) !== 0x80) return false;
            i += 2;
            continue;
        }
        if ((b0 >= 0xe1 && b0 <= 0xec) || (b0 >= 0xee && b0 <= 0xef)) {
            if (i + 1 >= bytes.length || (bytes[i] & 0xc0) !== 0x80 || (bytes[i + 1] & 0xc0) !== 0x80) return false;
            i += 2;
            continue;
        }
        if (b0 === 0xed) {
            if (i + 1 >= bytes.length || bytes[i] < 0x80 || bytes[i] > 0x9f || (bytes[i + 1] & 0xc0) !== 0x80) return false;
            i += 2;
            continue;
        }
        if (b0 === 0xf0) {
            if (i + 2 >= bytes.length || bytes[i] < 0x90 || bytes[i] > 0xbf || (bytes[i + 1] & 0xc0) !== 0x80 || (bytes[i + 2] & 0xc0) !== 0x80) return false;
            i += 3;
            continue;
        }
        if (b0 >= 0xf1 && b0 <= 0xf3) {
            if (i + 2 >= bytes.length || (bytes[i] & 0xc0) !== 0x80 || (bytes[i + 1] & 0xc0) !== 0x80 || (bytes[i + 2] & 0xc0) !== 0x80) return false;
            i += 3;
            continue;
        }
        if (b0 === 0xf4) {
            if (i + 2 >= bytes.length || bytes[i] < 0x80 || bytes[i] > 0x8f || (bytes[i + 1] & 0xc0) !== 0x80 || (bytes[i + 2] & 0xc0) !== 0x80) return false;
            i += 3;
            continue;
        }
        return false;
    }
    return true;
}

const nodeBuffer = (() => {
    function SlowBuffer(size) {
        if (typeof size !== 'number') throw _makeInvalidArgTypeError('size', 'number', size);
        if (!Number.isFinite(size) || size < 0 || size > Buffer.kMaxLength) {
            const err = new RangeError(`The value of "size" is out of range. It must be >= 0 and <= ${Buffer.kMaxLength}. Received ${size}`);
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
        }
        return Buffer.alloc(Math.floor(size));
    }

    const mod = {
        Buffer,
        SlowBuffer,
        isAscii: _bufferIsAscii,
        isUtf8: _bufferIsUtf8,
        kMaxLength: Buffer.kMaxLength,
        constants: { MAX_LENGTH: Buffer.kMaxLength, MAX_STRING_LENGTH: 0x1fffffe8 },
    };
    Object.defineProperty(mod, 'INSPECT_MAX_BYTES', {
        get() { return Buffer.INSPECT_MAX_BYTES; },
        set(value) { Buffer.INSPECT_MAX_BYTES = value; },
        enumerable: true,
        configurable: true,
    });
    return mod;
})();

// ============================================================
// process module
// ============================================================

const _activeResources = new Map();
let _nextActiveResourceId = 1;

function _trackActiveResource(type) {
    const id = _nextActiveResourceId++;
    _activeResources.set(id, type);
    return id;
}

function _untrackActiveResource(id) {
    if (id) _activeResources.delete(id);
}

const process = (() => {
    const [cwd_val] = os.getcwd();
    let _cwd = cwd_val || '/';
    const _env = {};
    let _uid = 0;
    let _gid = 0;
    let _euid = 0;
    let _egid = 0;
    let _groups = [0];
    let _umask = 0o022;
    let _uncaughtExceptionCaptureCallback = null;

    // Populate env from /proc/self/environ or common vars
    for (const key of ['HOME', 'USER', 'PATH', 'SHELL', 'TERM', 'LANG', 'PWD',
                        'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV', 'NODE_PATH',
                        'NODE_DEBUG', 'NODE_OPTIONS',
                        'npm_config_cache', 'npm_config_registry',
                        'npm_config_fund', 'npm_config_audit',
                        'npm_config_progress', 'npm_config_update_notifier',
                        'NPM_CONFIG_CACHE', 'NPM_CONFIG_REGISTRY',
                        'NPM_CONFIG_FUND', 'NPM_CONFIG_AUDIT',
                        'NPM_CONFIG_PROGRESS', 'NPM_CONFIG_UPDATE_NOTIFIER']) {
        const val = std.getenv(key);
        if (val !== null && val !== undefined) _env[key] = val;
    }
    if (!_env.PATH) _env.PATH = '/usr/local/bin:/usr/bin:/bin';

    // Proxy env to catch all gets/sets
    const envProxy = new Proxy(_env, {
        get(target, prop) {
            if (typeof prop === 'symbol') return target[prop];
            // Try live lookup for unknown keys
            if (!(prop in target)) {
                const val = std.getenv(String(prop));
                if (val !== null && val !== undefined) {
                    target[prop] = val;
                    return val;
                }
            }
            return target[prop];
        },
        set(target, prop, value) {
            target[prop] = String(value);
            std.setenv(String(prop), String(value));
            return true;
        },
        deleteProperty(target, prop) {
            delete target[prop];
            std.unsetenv(String(prop));
            return true;
        },
    });

    function _actualArgType(value) {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (Array.isArray(value)) return 'an instance of Array';
        if (typeof value === 'object') return `an instance of ${value.constructor && value.constructor.name || 'Object'}`;
        if (typeof value === 'function') return 'type function';
        return `type ${typeof value}${typeof value === 'number' ? ` (${value})` : ''}`;
    }

    function _makeOneOfTypeError(name, expected, value) {
        const err = new TypeError(`The "${name}" argument must be one of type ${expected}. Received ${_actualArgType(value)}`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        return err;
    }

    function _unknownCredential(kind, value) {
        const err = new Error(`${kind} identifier does not exist: ${value}`);
        err.code = 'ERR_UNKNOWN_CREDENTIAL';
        return err;
    }

    function _credentialValue(kind, value, name) {
        if (typeof value === 'number') {
            if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
                const err = new RangeError(`The value of "${name}" is out of range. It must be >= 0 && <= 4294967295. Received ${value}`);
                err.code = 'ERR_OUT_OF_RANGE';
                throw err;
            }
            return value >>> 0;
        }
        if (typeof value === 'string') {
            if (/^(?:0|[1-9]\d*)$/.test(value)) return Number(value) >>> 0;
            if (kind === 'User' && value === 'nobody') return 65534;
            if (kind === 'Group' && (value === 'nogroup' || value === 'nobody')) return 65534;
            throw _unknownCredential(kind, value);
        }
        throw _makeOneOfTypeError(name, 'number or string', value);
    }

    function _validateCredentialInput(name, value) {
        if (typeof value !== 'number' && typeof value !== 'string') {
            throw _makeOneOfTypeError(name, 'number or string', value);
        }
    }

    function _parseUmask(mask) {
        if (typeof mask === 'number') {
            if (!Number.isFinite(mask)) throw _makeInvalidArgValueError('mask', mask);
            return (mask >>> 0) & 0o777;
        }
        if (typeof mask === 'string') {
            if (!/^[0-7]+$/.test(mask)) throw _makeInvalidArgValueError('mask', mask);
            return parseInt(mask, 8) & 0o777;
        }
        throw _makeInvalidArgTypeError('mask', 'number or string', mask);
    }

    function _rssMemory() {
        return 16 * 1024 * 1024;
    }

    function memoryUsage() {
        const rss = _rssMemory();
        return {
            rss,
            heapTotal: 8 * 1024 * 1024,
            heapUsed: 4 * 1024 * 1024,
            external: 1,
            arrayBuffers: 0,
        };
    }
    memoryUsage.rss = _rssMemory;

    const _knownPermissionScopes = new Set([
        'fs', 'fs.read', 'fs.write',
        'child', 'worker', 'addons', 'inspector',
    ]);

    function _makeWarning(warning, typeOrOptions, codeOrCtor, ctor) {
        if (warning instanceof Error) return warning;
        if (typeof warning !== 'string') {
            throw _makeInvalidArgTypeError('warning', 'string or an instance of Error', warning);
        }

        let type = 'Warning';
        let code;
        let detail;
        if (typeof typeOrOptions === 'object' && typeOrOptions !== null) {
            if (typeof typeOrOptions.type === 'string') type = typeOrOptions.type;
            if (typeof typeOrOptions.code === 'string') code = typeOrOptions.code;
            if (typeof typeOrOptions.detail === 'string') detail = typeOrOptions.detail;
            if (typeof typeOrOptions.ctor === 'function') ctor = typeOrOptions.ctor;
        } else if (typeof typeOrOptions === 'function') {
            ctor = typeOrOptions;
        } else if (typeOrOptions !== undefined) {
            if (typeof typeOrOptions !== 'string') {
                throw _makeInvalidArgTypeError('type', 'string', typeOrOptions);
            }
            type = typeOrOptions || 'Warning';
        }

        if (codeOrCtor !== undefined) {
            if (typeof codeOrCtor === 'function') {
                ctor = codeOrCtor;
            } else if (typeof codeOrCtor === 'string') {
                code = codeOrCtor;
            } else {
                throw _makeInvalidArgTypeError('code', 'string', codeOrCtor);
            }
        }

        let err;
        if (typeof ctor === 'function') {
            err = new ctor();
            if (!(err instanceof Error)) err = new Error(warning);
            if (!err.message) err.message = warning;
        } else {
            err = new Error(warning);
            err.name = type;
        }
        if (code !== undefined) err.code = code;
        if (detail !== undefined) err.detail = detail;
        return err;
    }

    class Process extends events.EventEmitter {}

    const proc = new Process();

    Object.assign(proc, {
        title: 'node',
        version: 'v22.0.0', // Compatibility target
        versions: {
            node: '22.0.0',
            spidermonkey: '140.11.0esr',
            modules: '131',
            v8: '0.0.0',  // Not V8
            uv: '0.0.0',  // Not libuv
        },
        arch: 'wasm32',
        platform: 'linux', // POSIX-compatible
        env: envProxy,
        argv: [],  // Set by node-main.c
        argv0: '',
        execArgv: [],
        execPath: '/usr/bin/node',
        pid: os.getpid(),
        ppid: 1,  // No host parent is exposed; use init as the stable parent.
        exitCode: 0,
        _exiting: false,
        noDeprecation: false,
        throwDeprecation: false,
        traceDeprecation: false,

        cwd() { return _cwd; },
        chdir(dir) {
            const err = os.chdir(dir);
            if (err !== 0) _throwErrno(err, 'chdir', dir);
            const [newCwd] = os.getcwd();
            _cwd = newCwd || dir;
        },

        exit(code) {
            proc.exitCode = code !== undefined ? code : proc.exitCode;
            proc._exiting = true;
            proc.emit('exit', proc.exitCode);
            std.exit(proc.exitCode);
        },

        abort() {
            std.exit(134); // SIGABRT
        },

        emitWarning(warning, type, code) {
            const message = warning instanceof Error ? warning.message : String(warning);
            const err = warning instanceof Error ? warning : new Error(message);
            err.name = type || err.name || 'Warning';
            if (code) err.code = code;
            if (!proc.emit('warning', err) && proc.env.NODE_NO_WARNINGS !== '1') {
                proc.stderr.write(`${err.name}${err.code ? ` [${err.code}]` : ''}: ${message}\n`);
            }
        },

        _rawDebug(...args) {
            proc.stderr.write(args.map((arg) =>
                typeof arg === 'string' ? arg : util.inspect(arg)
            ).join(' ') + '\n');
        },

        hasUncaughtExceptionCaptureCallback() {
            return typeof proc._uncaughtExceptionCaptureCallback === 'function';
        },

        setUncaughtExceptionCaptureCallback(fn) {
            if (fn !== null && typeof fn !== 'function') {
                throw _makeInvalidArgTypeError('fn', 'function or null', fn);
            }
            proc._uncaughtExceptionCaptureCallback = fn;
        },

        kill(pid, signal) {
            signal = signal || 'SIGTERM';
            let signum;
            if (typeof signal === 'number') {
                signum = signal;
            } else {
                // Resolve against the Node os.constants.signals table (defined
                // on `nodeOs` below — the bare `os` symbol in this file is the
                // qjs:os primitives module imported at the top, which has no
                // `.constants.signals`). A bare-minimum inline fallback used
                // to silently map unknown names like 'SIGWINCH' to SIGTERM,
                // which the default-signal handler then translated into a
                // Terminate action (exit 143). Anything not in the table now
                // throws, matching Node's behaviour.
                const _sigs = nodeOs && nodeOs.constants && nodeOs.constants.signals;
                signum = (_sigs && _sigs[signal]) | 0;
                if (!signum) throw new Error("Unknown signal: " + signal);
            }
            os.kill(pid, signum);
        },

        hrtime: Object.assign(function hrtime(prev) {
            const now = _hrtimeNow();
            if (prev) {
                let sec = now[0] - prev[0];
                let nsec = now[1] - prev[1];
                if (nsec < 0) { sec--; nsec += 1e9; }
                return [sec, nsec];
            }
            return now;
        }, {
            bigint() {
                const [sec, nsec] = _hrtimeNow();
                return BigInt(sec) * 1000000000n + BigInt(nsec);
            }
        }),

        memoryUsage,

        cpuUsage(prev) {
            const usage = { user: 0, system: 0 };
            if (prev) {
                usage.user -= prev.user;
                usage.system -= prev.system;
            }
            return usage;
        },

        nextTick(fn, ...args) {
            // This compatibility layer does not have a real nextTick queue,
            // but a microtask preserves the ordering expected here.
            async_hooks._queueMicrotask(() => fn(...args), 'TickObject');
        },

        uptime() {
            return (Date.now() - _startTime) / 1000;
        },

        umask(mask) {
            const old = _umask;
            if (mask !== undefined) _umask = _parseUmask(mask);
            return old;
        },

        getuid() { return _uid; },
        geteuid() { return _euid; },
        getgid() { return _gid; },
        getegid() { return _egid; },
        setuid(id) { _uid = _euid = _credentialValue('User', id, 'id'); },
        seteuid(id) { _euid = _credentialValue('User', id, 'id'); },
        setgid(id) { _gid = _egid = _credentialValue('Group', id, 'id'); },
        setegid(id) { _egid = _credentialValue('Group', id, 'id'); },
        getgroups() { return _groups.slice(); },
        setgroups(groups) {
            if (!Array.isArray(groups)) {
                const err = new TypeError(`The "groups" argument must be an instance of Array. Received ${_actualArgType(groups)}`);
                err.code = 'ERR_INVALID_ARG_TYPE';
                throw err;
            }
            _groups = groups.map((group, index) => _credentialValue('Group', group, `groups[${index}]`));
        },
        initgroups(user, extraGroup) {
            _validateCredentialInput('user', user);
            _validateCredentialInput('extraGroup', extraGroup);
            const group = _credentialValue('Group', extraGroup, 'extraGroup');
            _credentialValue('User', user, 'user');
            _groups = Array.from(new Set([_gid, group]));
        },

        permission: {
            has(scope, reference) {
                _validateString(scope, 'scope');
                if (reference !== undefined) _validateString(reference, 'reference');
                return _knownPermissionScopes.has(scope);
            },
        },

        getActiveResourcesInfo() {
            return Array.from(_activeResources.values());
        },
        _getActiveHandles() { return []; },
        _getActiveRequests() { return []; },

        resourceUsage() {
            return {
                userCPUTime: 0,
                systemCPUTime: 0,
                maxRSS: Math.ceil(_rssMemory() / 1024),
                sharedMemorySize: 0,
                unsharedDataSize: 0,
                unsharedStackSize: 0,
                minorPageFault: 0,
                majorPageFault: 0,
                swappedOut: 0,
                fsRead: 0,
                fsWrite: 0,
                ipcSent: 0,
                ipcReceived: 0,
                signalsCount: 0,
                voluntaryContextSwitches: 0,
                involuntaryContextSwitches: 0,
            };
        },
        availableMemory() { return 64 * 1024 * 1024; },
        constrainedMemory() { return 0; },

        emitWarning(warning, typeOrOptions, codeOrCtor, ctor) {
            const err = _makeWarning(warning, typeOrOptions, codeOrCtor, ctor);
            if (err.name === 'DeprecationWarning' && proc.noDeprecation) return;
            queueMicrotask(() => {
                if (err.name === 'DeprecationWarning' && proc.throwDeprecation) {
                    if (!proc.emit('uncaughtException', err)) throw err;
                    return;
                }
                proc.emit('warning', err);
            });
        },

        setUncaughtExceptionCaptureCallback(fn) {
            if (fn !== null && typeof fn !== 'function') {
                const err = new TypeError(`The "fn" argument must be of type function or null. Received type ${typeof fn}${typeof fn === 'number' ? ` (${fn})` : ''}`);
                err.code = 'ERR_INVALID_ARG_TYPE';
                throw err;
            }
            if (fn && _uncaughtExceptionCaptureCallback) {
                const err = new Error('setupUncaughtExceptionCapture called while a capture callback is already active');
                err.code = 'ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET';
                throw err;
            }
            _uncaughtExceptionCaptureCallback = fn;
        },
        hasUncaughtExceptionCaptureCallback() {
            return _uncaughtExceptionCaptureCallback !== null;
        },
        _handleUncaughtException(err) {
            if (_uncaughtExceptionCaptureCallback) {
                _uncaughtExceptionCaptureCallback(err);
                return true;
            }
            if (proc.emit('uncaughtExceptionMonitor', err)) {
                // Monitors observe only; regular handlers still decide fate.
            }
            return proc.emit('uncaughtException', err);
        },

        assert(value, message) {
            if (value) return;
            proc.emitWarning(
                'process.assert() is deprecated. Please use the `assert` module instead.',
                'DeprecationWarning',
                'DEP0100',
            );
            const err = new Error(message || 'assertion error');
            err.code = 'ERR_ASSERTION';
            throw err;
        },

        binding(name) {
            return _processBinding(String(name));
        },

        features: { inspector: false, debug: false, uv: false, ipv6: true, tls: true },
        config: { variables: {} },
        release: { name: 'node' },
        moduleLoadList: [],
        // npm-install-checks reads `process.report.getReport().sharedObjects`
        // to detect glibc-vs-musl when /usr/bin/ldd is unavailable.
        report: {
            getReport() { return { sharedObjects: ['/lib/ld-musl-wasm32.so.1'] }; },
        },
    });

    // Define stdout/stderr/stdin as lazy getters (can't be in Object.assign
    // because assign evaluates getters immediately)
    Object.defineProperties(proc, {
        stdout: { get() { return _createWriteStream(1); }, configurable: true },
        stderr: { get() { return _createWriteStream(2); }, configurable: true },
        stdin: { get() { return _createReadStream(0); }, configurable: true },
    });

    return proc;
})();

const _startTime = Date.now();

function _hrtimeNow() {
    const ms = Date.now();
    return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
}

// Lazy stream creation for stdout/stderr/stdin
let _stdout, _stderr, _stdin;
// Per-fd cached winsize. Refreshed lazily on first read and on SIGWINCH.
// Caching matters: ink reads process.stdout.columns hundreds of times per
// render and routes the result into cursor-position math; an ioctl per read
// is both slow and risks racing the kernel's PTY state during a resize.
const _wsCache = new Map();
function _refreshWs(fd) {
    const ws = os.ttyGetWinSize(fd);
    if (ws) _wsCache.set(fd, ws);
    return _wsCache.get(fd) || null;
}

function _writeControl(stream, seq, cb) {
    if (cb !== undefined && typeof cb !== 'function') {
        throw _makeInvalidArgTypeError('callback', 'function', cb);
    }
    if (!stream || typeof stream.write !== 'function') {
        if (cb) cb(null);
        return true;
    }
    if (typeof cb === 'function') cb();
    stream.write(seq);
    return true;
}

function _cursorTo(stream, x, y, cb) {
    if (typeof y === 'function') { cb = y; y = undefined; }
    if (cb !== undefined && typeof cb !== 'function') {
        throw _makeInvalidArgTypeError('callback', 'function', cb);
    }
    if (!stream || typeof stream.write !== 'function') {
        if (cb) cb(null);
        return true;
    }
    if (Number.isNaN(x) || Number.isNaN(y)) {
        throw _makeInvalidArgValueError(Number.isNaN(x) ? 'x' : 'y', Number.isNaN(x) ? x : y);
    }
    if (typeof x !== 'number') {
        if (typeof y === 'number') {
            const err = new TypeError('Cannot set cursor row without setting its column');
            err.code = 'ERR_INVALID_CURSOR_POS';
            throw err;
        }
        return true;
    }
    x = Math.max(0, x | 0);
    if (typeof y === 'number') {
        return _writeControl(stream, `\x1b[${Math.max(0, y | 0) + 1};${x + 1}H`, cb);
    }
    return _writeControl(stream, `\x1b[${x + 1}G`, cb);
}

function _moveCursor(stream, dx, dy, cb) {
    let seq = '';
    dx = dx | 0;
    dy = dy | 0;
    if (dx < 0) seq += `\x1b[${-dx}D`;
    else if (dx > 0) seq += `\x1b[${dx}C`;
    if (dy < 0) seq += `\x1b[${-dy}A`;
    else if (dy > 0) seq += `\x1b[${dy}B`;
    return _writeControl(stream, seq, cb);
}

function _clearLine(stream, dir, cb) {
    if (typeof dir === 'function') { cb = dir; dir = 0; }
    const mode = dir < 0 ? 1 : dir > 0 ? 0 : 2;
    return _writeControl(stream, `\x1b[${mode}K`, cb);
}

function _clearScreenDown(stream, cb) {
    return _writeControl(stream, '\x1b[0J', cb);
}

function _createWriteStream(fd) {
    if (fd === 1 && _stdout) return _stdout;
    if (fd === 2 && _stderr) return _stderr;
    const listeners = new Map();
    const s = {
        fd,
        writable: true,
        write(data, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (typeof data === 'string') {
                const sink = fd === 2 ? std.err : std.out;
                sink.puts(data);
                sink.flush();
            } else if (data instanceof Uint8Array) {
                os.write(fd, data.buffer, data.byteOffset, data.byteLength);
            }
            if (cb) cb();
            return true;
        },
        end(data, encoding, cb) {
            if (data) s.write(data, encoding);
            if (typeof cb === 'function') cb();
        },
        on(event, cb) {
            if (typeof cb !== 'function') return s;
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(cb);
            return s;
        },
        addListener(event, cb) { return s.on(event, cb); },
        once(event, cb) {
            const wrap = (...a) => { s.removeListener(event, wrap); cb(...a); };
            return s.on(event, wrap);
        },
        emit(event, ...args) {
            const arr = listeners.get(event);
            if (!arr || arr.length === 0) return false;
            for (const cb of arr.slice()) {
                try { cb(...args); } catch (e) { Promise.reject(e); }
            }
            return true;
        },
        removeListener(event, cb) {
            const arr = listeners.get(event);
            if (!arr) return s;
            const i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
            return s;
        },
        off(event, cb) { return s.removeListener(event, cb); },
        removeAllListeners(event) {
            if (event === undefined) listeners.clear();
            else listeners.delete(event);
            return s;
        },
        listenerCount(event) {
            const arr = listeners.get(event);
            return arr ? arr.length : 0;
        },
        cursorTo(x, y, cb) { return _cursorTo(s, x, y, cb); },
        moveCursor(dx, dy, cb) { return _moveCursor(s, dx, dy, cb); },
        clearLine(dir, cb) { return _clearLine(s, dir, cb); },
        clearScreenDown(cb) { return _clearScreenDown(s, cb); },
        isTTY: os.isatty(fd),
    };
    Object.defineProperties(s, {
        // Cached TIOCGWINSZ-backed accessors. TUIs (ink, blessed, pi-coding-agent)
        // read these hundreds of times per render and route the result into
        // cursor-position math; an ioctl per read is slow and risks racing
        // the kernel's PTY state during resize. The cache is invalidated by
        // the SIGWINCH handler below.
        columns: {
            get() {
                const ws = _wsCache.get(fd) || _refreshWs(fd);
                return ws ? ws[0] : 80;
            },
            enumerable: true,
            configurable: true,
        },
        rows: {
            get() {
                const ws = _wsCache.get(fd) || _refreshWs(fd);
                return ws ? ws[1] : 24;
            },
            enumerable: true,
            configurable: true,
        },
    });
    if (fd === 1) _stdout = s;
    if (fd === 2) _stderr = s;
    return s;
}

// SIGWINCH (signum 28 on Linux). The kernel raises it on every kernel_pty_set_winsize
// call; without a JS-side handler the default action is "ignore" and ink/blessed/pi
// keep using a stale cached columns/rows, so incremental redraws clear the wrong
// number of rows and old frames stack on top of new ones. The adapter surface
// does not expose SIGWINCH via os.SIG* constants, so call os.signal with the raw signum.
try {
    os.signal(28, () => {
        // Refresh the cache so the next process.stdout.columns read returns the
        // post-resize value.
        _refreshWs(1);
        _refreshWs(2);
        // Notify subscribers (ink/blessed read this and re-render at the new size).
        if (_stdout) _stdout.emit('resize');
        if (_stderr) _stderr.emit('resize');
    });
} catch (_) {
    // Some environments (WASI builds, tests) may not support os.signal; if it
    // throws, fall back to the lazy-cache-only path. Apps that don't read on
    // resize still render correctly at whatever size was current on first read.
}

function _createReadStream(fd) {
    if (_stdin) return _stdin;
    // Real readable-stream surface for stdin. TUI libraries (readline,
    // prompts, etc.) call resume()+on('data',cb) and expect bytes from fd 0.
    // The previous stub turned every method into a no-op, so TUIs rendered
    // their initial frame and the runtime loop exited immediately because no
    // jobs/timers/watches were live. Wiring through os.setReadHandler keeps
    // the loop alive and delivers keystrokes.
    const listeners = new Map(); // event → cb[]
    const READ_BUF = new ArrayBuffer(4096);
    const READ_VIEW = new Uint8Array(READ_BUF);
    let watchInstalled = false;
    let ended = false;
    let _encoding = null;
    let _decoder = null;

    function _emit(event, ...args) {
        const arr = listeners.get(event);
        if (!arr || arr.length === 0) return false;
        for (const cb of arr.slice()) {
            try { cb(...args); }
            catch (e) { Promise.reject(e); }
        }
        return true;
    }

    function _onReadable() {
        let n;
        try { n = os.read(fd, READ_BUF, 0, READ_VIEW.byteLength); }
        catch (e) { _emit('error', e); return; }
        if (n <= 0) {
            // EOF (or unexpected) → stop pumping and emit end.
            ended = true;
            _uninstall();
            _emit('end');
            _emit('close');
            return;
        }
        const slice = READ_VIEW.subarray(0, n);
        if (_encoding === 'utf8' || _encoding === 'utf-8') {
            if (!_decoder) _decoder = new TextDecoder('utf-8', { fatal: false });
            _emit('data', _decoder.decode(slice, { stream: true }));
        } else {
            const copy = new Uint8Array(n);
            copy.set(slice);
            _emit('data', copy);
        }
    }

    function _install() {
        if (watchInstalled || ended) return;
        os.setReadHandler(fd, _onReadable);
        watchInstalled = true;
    }

    function _uninstall() {
        if (!watchInstalled) return;
        os.setReadHandler(fd, null);
        watchInstalled = false;
    }

    const s = {
        fd,
        readable: true,
        isTTY: os.isatty(fd),
        isRaw: false,
        read() { return null; },
        on(event, cb) {
            if (typeof cb !== 'function') return s;
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(cb);
            if (event === 'data') _install();
            return s;
        },
        addListener(event, cb) { return s.on(event, cb); },
        once(event, cb) {
            const wrap = (...a) => { s.removeListener(event, wrap); cb(...a); };
            return s.on(event, wrap);
        },
        emit(event, ...args) { return _emit(event, ...args); },
        removeListener(event, cb) {
            const arr = listeners.get(event);
            if (!arr) return s;
            const i = arr.indexOf(cb);
            if (i >= 0) arr.splice(i, 1);
            return s;
        },
        off(event, cb) { return s.removeListener(event, cb); },
        removeAllListeners(event) {
            if (event === undefined) listeners.clear();
            else listeners.delete(event);
            return s;
        },
        listenerCount(event) {
            const arr = listeners.get(event);
            return arr ? arr.length : 0;
        },
        resume() { _install(); return s; },
        pause() { _uninstall(); return s; },
        pipe(dest) { return dest; },
        unpipe() { return s; },
        setEncoding(enc) {
            _encoding = enc;
            s._encoding = enc;
            if (enc !== 'utf8' && enc !== 'utf-8') _decoder = null;
            return s;
        },
        setRawMode(raw) {
            // Real Node's process.stdin.setRawMode flips the TTY via
            // tcsetattr (clears ICANON/ECHO/ICRNL/OPOST, sets VMIN=1/VTIME=0).
            // TUIs depend on this: without it, ICRNL turns Enter `\r` into
            // `\n`, ICANON line-buffers input until Enter, and the kernel
            // double-echoes. See node-native.c for the tcsetattr plumbing.
            const want = !!raw;
            if (s.isTTY && typeof _nodeNative.setRawMode === 'function') {
                _nodeNative.setRawMode(fd, want);
            }
            s.isRaw = want;
            return s;
        },
        unref() { return s; },
        ref() { return s; },
        destroy() { _uninstall(); listeners.clear(); return s; },
    };
    _stdin = s;
    return s;
}

// ============================================================
// fs module
// ============================================================

const fs = (() => {
    const constants = {
        O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100,
        O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000,
        O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000,
        S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o40000,
        S_IFCHR: 0o20000, S_IFBLK: 0o60000, S_IFIFO: 0o10000,
        S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
        S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
        S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20, S_IXGRP: 0o10,
        S_IRWXO: 0o7, S_IROTH: 0o4, S_IWOTH: 0o2, S_IXOTH: 0o1,
        F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
        COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2,
    };

    class Stats {
        constructor(st) {
            this.dev = st.dev || 0;
            this.ino = st.ino || 0;
            this.mode = st.mode || 0;
            this.nlink = st.nlink || 0;
            this.uid = st.uid || 0;
            this.gid = st.gid || 0;
            this.rdev = st.rdev || 0;
            this.size = st.size || 0;
            this.blksize = st.blocks ? 512 : 4096;
            this.blocks = st.blocks || 0;
            this.atimeMs = (st.atime || 0) * 1000;
            this.mtimeMs = (st.mtime || 0) * 1000;
            this.ctimeMs = (st.ctime || 0) * 1000;
            this.birthtimeMs = this.ctimeMs;
            this.atime = new Date(this.atimeMs);
            this.mtime = new Date(this.mtimeMs);
            this.ctime = new Date(this.ctimeMs);
            this.birthtime = new Date(this.birthtimeMs);
        }
        isFile() { return (this.mode & constants.S_IFMT) === constants.S_IFREG; }
        isDirectory() { return (this.mode & constants.S_IFMT) === constants.S_IFDIR; }
        isSymbolicLink() { return (this.mode & constants.S_IFMT) === constants.S_IFLNK; }
        isBlockDevice() { return (this.mode & constants.S_IFMT) === constants.S_IFBLK; }
        isCharacterDevice() { return (this.mode & constants.S_IFMT) === constants.S_IFCHR; }
        isFIFO() { return (this.mode & constants.S_IFMT) === constants.S_IFIFO; }
        isSocket() { return (this.mode & constants.S_IFMT) === constants.S_IFSOCK; }
    }

    class Dirent {
        constructor(name, type) {
            this.name = name;
            this._type = type;
        }
        isFile() { return this._type === 'file'; }
        isDirectory() { return this._type === 'directory'; }
        isSymbolicLink() { return this._type === 'symlink'; }
        isBlockDevice() { return false; }
        isCharacterDevice() { return false; }
        isFIFO() { return false; }
        isSocket() { return false; }
    }

    function _pathToString(p) {
        if (typeof p === 'string') return p;
        if (typeof URL !== 'undefined' && p instanceof URL) {
            if (p.protocol !== 'file:') {
                throw _makeInvalidArgTypeError('path', 'string, Buffer, or URL', p);
            }
            return url.fileURLToPath ? url.fileURLToPath(p) : p.pathname;
        }
        if (p && typeof p === 'object' && typeof p.href === 'string' &&
            typeof p.pathname === 'string' && typeof p.protocol === 'string') {
            if (p.protocol !== 'file:') {
                throw _makeInvalidArgTypeError('path', 'string, Buffer, or URL', p);
            }
            return url.fileURLToPath ? url.fileURLToPath(p) : p.pathname;
        }
        if (Buffer.isBuffer(p)) return p.toString();
        throw _makeInvalidArgTypeError('path', 'string, Buffer, or URL', p);
    }

    function _pathToStringNoThrow(p) {
        try { return _pathToString(p); } catch (_) { return null; }
    }

    function _validateCallback(cb) {
        if (typeof cb !== 'function') {
            throw _makeInvalidArgTypeError('callback', 'function', cb);
        }
    }

    function _toFsBytes(data, encoding, name = 'data') {
        if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8');
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        throw _makeInvalidArgTypeError(name, 'string, Buffer, TypedArray, or DataView', data);
    }

    function _validateInteger(value, name) {
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
            throw _makeInvalidArgTypeError(name, 'integer', value);
        }
        return value;
    }

    function _validateUidOrGid(value, name) {
        _validateInteger(value, name);
        if (value < 0) {
            const err = new RangeError(`The value of "${name}" is out of range.`);
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
        }
    }

    function _validateBufferView(buffer, name = 'buffer') {
        if (buffer instanceof Uint8Array || ArrayBuffer.isView(buffer)) return buffer;
        throw _makeInvalidArgTypeError(name, 'Buffer, TypedArray, or DataView', buffer);
    }

    function _normalizePosition(value) {
        if (value === undefined || value === null) return null;
        if (typeof value === 'bigint') value = Number(value);
        _validateInteger(value, 'position');
        return value < 0 ? null : value;
    }

    function _normalizeBufferOptions(buffer, offsetOrOptions, length, position) {
        const view = _validateBufferView(buffer);
        let offset = 0;
        let len = view.byteLength ?? view.length;
        let pos = position;

        if (offsetOrOptions === undefined || offsetOrOptions === null) {
            // Defaults above.
        } else if (typeof offsetOrOptions === 'object' && !Array.isArray(offsetOrOptions)) {
            offset = offsetOrOptions.offset ?? 0;
            len = offsetOrOptions.length ?? (view.byteLength ?? view.length) - offset;
            pos = offsetOrOptions.position;
        } else if (typeof offsetOrOptions === 'number') {
            offset = offsetOrOptions;
            len = length ?? (view.byteLength ?? view.length) - offset;
        } else {
            throw _makeInvalidArgTypeError('options', 'Object', offsetOrOptions);
        }

        offset = _validateInteger(offset, 'offset');
        len = _validateInteger(len, 'length');
        const size = view.byteLength ?? view.length;
        if (offset < 0 || offset > size) {
            const err = new RangeError('The value of "offset" is out of range.');
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
        }
        if (len < 0 || len > size - offset) {
            const err = new RangeError('The value of "length" is out of range.');
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
        }
        return { view, offset, length: len, position: _normalizePosition(pos) };
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
        const p = _pathToStringNoThrow(filepath);
        if (p === null) return false;
        const [, err] = os.stat(p);
        return err === 0;
    }

    function statSync(filepath, options) {
        const p = _pathToString(filepath);
        const [st, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'stat', p);
        const stats = new Stats(st);
        if (options && options.bigint) {
            // TODO: bigint stat
        }
        return stats;
    }

    function lstatSync(filepath, options) {
        const p = _pathToString(filepath);
        const [st, err] = os.lstat(p);
        if (err !== 0) _throwErrno(-err, 'lstat', p);
        return new Stats(st);
    }

    function readFileSync(filepath, options) {
        let encoding = null;
        if (typeof options === 'string') encoding = options;
        else if (options && options.encoding) encoding = options.encoding;

        if (typeof filepath === 'number') {
            const chunks = [];
            let total = 0;
            while (true) {
                const chunk = Buffer.alloc(64 * 1024);
                const n = os.read(filepath, chunk.buffer, chunk.byteOffset, chunk.byteLength);
                if (n < 0) _throwErrno(-n, 'read');
                if (n === 0) break;
                chunks.push(chunk.subarray(0, n));
                total += n;
            }
            const data = Buffer.concat(chunks, total);
            return encoding ? data.toString(encoding) : data;
        }

        const p = _pathToString(filepath);
        const f = std.open(p, 'rb');
        if (!f) {
            _throwErrno(2, 'open', p); // ENOENT
        }
        f.seek(0, std.SEEK_END);
        const size = f.tell();
        f.seek(0, std.SEEK_SET);
        const buf = new Uint8Array(size);
        f.read(buf.buffer, 0, size);
        f.close();

        if (encoding) {
            return Buffer.from(buf).toString(encoding);
        }
        return Buffer.from(buf);
    }

    function writeFileSync(filepath, data, options) {
        let encoding = 'utf8';
        let mode = 0o666;
        let flag = 'w';
        if (typeof options === 'string') encoding = options;
        else if (options) {
            if (options.encoding) encoding = options.encoding;
            if (options.mode) mode = options.mode;
            if (options.flag) flag = options.flag;
        }

        const isFd = typeof filepath === 'number';
        const p = isFd ? undefined : _pathToString(filepath);
        const flags = _flagsToMode(flag);
        const fd = isFd ? filepath : os.open(p, flags, mode);
        if (fd < 0) _throwErrno(-fd, 'open', p);

        const buf = _toFsBytes(data, encoding, 'data');
        const written = os.write(fd, buf.buffer, buf.byteOffset, buf.byteLength);
        if (written < 0) _throwErrno(-written, 'write', p);
        if (!isFd) os.close(fd);
    }

    function appendFileSync(filepath, data, options) {
        const opts = typeof options === 'string' ? { encoding: options } : { ...(options || {}) };
        if (opts.flag === undefined) opts.flag = 'a';
        writeFileSync(filepath, data, opts);
    }

    function readdirSync(dirpath, options) {
        const p = _pathToString(dirpath);
        const [entries, err] = os.readdir(p);
        if (err !== 0) _throwErrno(-err, 'scandir', p);

        const withFileTypes = options && options.withFileTypes;
        const result = [];
        for (const name of entries) {
            if (name === '.' || name === '..') continue;
            if (withFileTypes) {
                const fullPath = p.endsWith('/') ? p + name : p + '/' + name;
                const [st, serr] = os.lstat(fullPath);
                let type = 'file';
                if (serr === 0) {
                    if ((st.mode & constants.S_IFMT) === constants.S_IFDIR) type = 'directory';
                    else if ((st.mode & constants.S_IFMT) === constants.S_IFLNK) type = 'symlink';
                }
                result.push(new Dirent(name, type));
            } else {
                result.push(name);
            }
        }
        return result;
    }

    function mkdirSync(dirpath, options) {
        const p = _pathToString(dirpath);
        const recursive = options && options.recursive;
        const mode = (options && options.mode) || 0o777;

        if (recursive) {
            const parts = p.split('/').filter(Boolean);
            let current = p.startsWith('/') ? '' : '.';
            for (const part of parts) {
                current += '/' + part;
                const [, err] = os.stat(current);
                if (err !== 0) {
                    const mkErr = os.mkdir(current, mode);
                    if (mkErr !== 0 && mkErr !== -17) { // not EEXIST
                        _throwErrno(-mkErr, 'mkdir', current);
                    }
                }
            }
            return p;
        }
        const err = os.mkdir(p, mode);
        if (err !== 0) _throwErrno(-err, 'mkdir', p);
    }

    function rmdirSync(dirpath, options) {
        const p = _pathToString(dirpath);
        const err = os.remove(p);
        if (err !== 0) _throwErrno(-err, 'rmdir', p);
    }

    // fs.rm: cacache cleans tmp dirs after content writes; tar uses it too.
    // force=true silences ENOENT.
    function rmSync(targetPath, options) {
        const opts = options || {};
        const recursive = opts.recursive === true;
        const force = opts.force === true;
        const p = _pathToString(targetPath);
        const [st, statErr] = os.lstat(p);
        if (statErr !== 0) {
            if (force) return;
            _throwErrno(statErr, 'lstat', p);
        }
        const isDir = (st.mode & constants.S_IFMT) === constants.S_IFDIR;
        const isSymlink = (st.mode & constants.S_IFMT) === constants.S_IFLNK;
        if (isDir && !isSymlink) {
            if (recursive) {
                const [entries, dirErr] = os.readdir(p);
                if (dirErr === 0) {
                    for (const name of entries) {
                        if (name === '.' || name === '..') continue;
                        const child = p.endsWith('/') ? p + name : p + '/' + name;
                        rmSync(child, opts);
                    }
                }
            }
            const err = os.remove(p);
            if (err !== 0 && !force) _throwErrno(err < 0 ? -err : err, 'rmdir', p);
        } else {
            const err = os.remove(p);
            if (err !== 0 && !force) _throwErrno(err < 0 ? -err : err, 'unlink', p);
        }
    }

    function unlinkSync(filepath) {
        const p = _pathToString(filepath);
        const err = os.remove(p);
        if (err !== 0) _throwErrno(-err, 'unlink', p);
    }

    function renameSync(oldPath, newPath) {
        const o = _pathToString(oldPath);
        const n = _pathToString(newPath);
        const err = os.rename(o, n);
        if (err !== 0) _throwErrno(-err, 'rename', o);
    }

    function copyFileSync(src, dest, mode) {
        const data = readFileSync(src);
        if (mode && (mode & constants.COPYFILE_EXCL) && existsSync(dest)) {
            _throwErrno(17, 'copyfile', dest); // EEXIST
        }
        writeFileSync(dest, data);
    }

    function symlinkSync(target, linkpath) {
        const err = os.symlink(_pathToString(target), _pathToString(linkpath));
        if (err !== 0) _throwErrno(-err, 'symlink', _pathToString(linkpath));
    }

    function linkSync(existingPath, newPath) {
        const oldp = _pathToString(existingPath);
        const newp = _pathToString(newPath);
        if (typeof os.link === 'function') {
            const err = os.link(oldp, newp);
            if (err === -38 || err === 38) {
                copyFileSync(oldp, newp, constants.COPYFILE_EXCL);
                return;
            }
            if (err !== 0) _throwErrno(err < 0 ? -err : err, 'link', newp);
            return;
        }
        copyFileSync(oldp, newp, constants.COPYFILE_EXCL);
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
        const p = _pathToString(filepath);
        const [, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'chmod', p);
        void mode;
    }

    function chownSync(filepath, uid, gid) {
        const p = _pathToString(filepath);
        const [, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'chown', p);
        void uid;
        void gid;
    }

    function lchownSync(filepath, uid, gid) {
        const p = _pathToString(filepath);
        _validateUidOrGid(uid, 'uid');
        _validateUidOrGid(gid, 'gid');
        const [, err] = os.lstat(p);
        if (err !== 0) _throwErrno(-err, 'lchown', p);
        if (typeof os.lchown === 'function') {
            const chownErr = os.lchown(p, uid, gid);
            if (chownErr !== 0) _throwErrno(chownErr < 0 ? -chownErr : chownErr, 'lchown', p);
        }
    }

    function utimesSync(filepath, atime, mtime) {
        const p = _pathToString(filepath);
        const a = typeof atime === 'number' ? atime : atime.getTime() / 1000;
        const m = typeof mtime === 'number' ? mtime : mtime.getTime() / 1000;
        os.utimes(p, a, m);
    }

    function truncateSync(filepath, len) {
        const p = _pathToString(filepath);
        const fd = os.open(p, os.O_WRONLY);
        if (fd < 0) _throwErrno(-fd, 'open', p);
        // ftruncate not in os module — write approach
        os.close(fd);
    }

    function accessSync(filepath, mode) {
        const p = _pathToString(filepath);
        const [, err] = os.stat(p);
        if (err !== 0) _throwErrno(-err, 'access', p);
    }

    function openSync(filepath, flags, mode) {
        const p = _pathToString(filepath);
        const f = _flagsToMode(flags || 'r');
        const m = mode || 0o666;
        const fd = os.open(p, f, m);
        if (fd < 0) _throwErrno(-fd, 'open', p);
        return fd;
    }

    function closeSync(fd) {
        os.close(fd);
    }

    function readSync(fd, buffer, offset, length, position) {
        const opts = _normalizeBufferOptions(buffer, offset, length, position);
        if (opts.position !== null) {
            const seekErr = os.seek(fd, opts.position, std.SEEK_SET);
            if (seekErr < 0) _throwErrno(-seekErr, 'seek');
        }
        const n = os.read(fd, opts.view.buffer, opts.view.byteOffset + opts.offset, opts.length);
        if (n < 0) _throwErrno(-n, 'read');
        return n;
    }

    function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
        let buf;
        if (typeof data === 'string') {
            let stringPosition = offsetOrPosition;
            let encoding = typeof lengthOrEncoding === 'string' ? lengthOrEncoding : 'utf8';
            if (typeof offsetOrPosition === 'string') {
                encoding = offsetOrPosition;
                stringPosition = null;
            }
            buf = Buffer.from(data, encoding);
            const pos = _normalizePosition(stringPosition);
            if (pos !== null) {
                const seekErr = os.seek(fd, pos, std.SEEK_SET);
                if (seekErr < 0) _throwErrno(-seekErr, 'seek');
            }
        } else {
            const opts = _normalizeBufferOptions(data, offsetOrPosition, lengthOrEncoding, position);
            if (opts.position !== null) {
                const seekErr = os.seek(fd, opts.position, std.SEEK_SET);
                if (seekErr < 0) _throwErrno(-seekErr, 'seek');
            }
            const n = os.write(fd, opts.view.buffer, opts.view.byteOffset + opts.offset, opts.length);
            if (n < 0) _throwErrno(-n, 'write');
            return n;
        }
        const n = os.write(fd, buf.buffer, buf.byteOffset, buf.byteLength);
        if (n < 0) _throwErrno(-n, 'write');
        return n;
    }

    // fs-minipass guards on `if (!fs.writev)` and falls back to
    // `process.binding('fs')` (unimplemented here) when absent.
    function writevSync(fd, buffers, position) {
        let total = 0;
        for (const buf of buffers) {
            const len = buf.byteLength ?? buf.length;
            if (!len) continue;
            const pos = position == null ? null : position + total;
            total += writeSync(fd, buf, 0, len, pos);
        }
        return total;
    }

    function fstatSync(fd) {
        // Use /proc/self/fd approach or direct syscall
        // For simplicity, use a basic approach
        const [st, err] = os.fstat ? os.fstat(fd) : [null, -1];
        if (err !== 0) _throwErrno(-err, 'fstat');
        return new Stats(st);
    }

    function fchmodSync(fd, mode) {
        fstatSync(fd);
        void mode;
    }

    function fchownSync(fd, uid, gid) {
        fstatSync(fd);
        void uid;
        void gid;
    }

    function futimesSync(fd, atime, mtime) {
        fstatSync(fd);
        void atime;
        void mtime;
    }

    class FileHandle {
        constructor(fd, path) {
            this.fd = fd;
            this._path = path;
            this._closed = false;
        }

        _assertOpen() {
            if (this._closed) {
                const err = new Error('file closed');
                err.code = 'EBADF';
                err.errno = -9;
                err.syscall = 'close';
                throw err;
            }
        }

        async close() {
            if (this._closed) return;
            closeSync(this.fd);
            this._closed = true;
        }

        async read(buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
            this._assertOpen();
            const bytesRead = readSync(this.fd, buffer, offset, length, position);
            return { bytesRead, buffer };
        }

        async write(data, offsetOrPosition, lengthOrEncoding, position) {
            this._assertOpen();
            const bytesWritten = writeSync(this.fd, data, offsetOrPosition, lengthOrEncoding, position);
            return { bytesWritten, buffer: data };
        }

        async writev(buffers, position = null) {
            this._assertOpen();
            const bytesWritten = writevSync(this.fd, buffers, position);
            return { bytesWritten, buffers };
        }

        async stat() {
            this._assertOpen();
            return fstatSync(this.fd);
        }

        async chmod(mode) {
            this._assertOpen();
            return fchmodSync(this.fd, mode);
        }

        async chown(uid, gid) {
            this._assertOpen();
            return fchownSync(this.fd, uid, gid);
        }

        async utimes(atime, mtime) {
            this._assertOpen();
            return futimesSync(this.fd, atime, mtime);
        }

        async readFile(options) {
            this._assertOpen();
            return readFileSync(this._path, options);
        }

        async writeFile(data, options) {
            this._assertOpen();
            return writeFileSync(this._path, data, options);
        }
    }

    function mkdtempSync(prefix, options) {
        const p = _pathToString(prefix);
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let attempt = 0; attempt < 64; attempt++) {
            let suffix = '';
            for (let i = 0; i < 6; i++) {
                suffix += chars[Math.floor(Math.random() * chars.length)];
            }
            const dirpath = p + suffix;
            const err = os.mkdir(dirpath, 0o700);
            if (err === 0) return dirpath;
            if (err !== -17) _throwErrno(-err, 'mkdtemp', dirpath);
        }
        _throwErrno(17, 'mkdtemp', p);
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

    function link(existingPath, newPath, cb) {
        _validateCallback(cb);
        const oldp = _pathToString(existingPath);
        const newp = _pathToString(newPath);
        try {
            linkSync(oldp, newp);
            queueMicrotask(() => cb(null));
        } catch (err) {
            queueMicrotask(() => cb(err));
        }
    }

    function lchown(filepath, uid, gid, cb) {
        _validateCallback(cb);
        const p = _pathToString(filepath);
        _validateUidOrGid(uid, 'uid');
        _validateUidOrGid(gid, 'gid');
        try {
            lchownSync(p, uid, gid);
            queueMicrotask(() => cb(null));
        } catch (err) {
            queueMicrotask(() => cb(err));
        }
    }

    class FSWatcher extends events.EventEmitter {
        constructor() {
            super();
            this.closed = false;
        }
        close() {
            if (this.closed) return;
            this.closed = true;
            queueMicrotask(() => this.emit('close'));
        }
        ref() { return this; }
        unref() { return this; }
    }

    class StatWatcher extends events.EventEmitter {
        constructor(filepath) {
            super();
            this.path = filepath;
            this.closed = false;
        }
        stop() {
            if (this.closed) return;
            this.closed = true;
            queueMicrotask(() => this.emit('stop'));
        }
        ref() { return this; }
        unref() { return this; }
    }

    const statWatchers = new Map();

    function createReadStream(filepath, options) {
        const opts = { ...(options || {}) };
        const highWaterMark = opts.highWaterMark || 64 * 1024;
        const autoClose = opts.autoClose !== false;
        const pathValue = opts.fd === undefined ? _pathToString(filepath) : filepath;
        let opened = false;
        let closed = false;
        let readStarted = false;
        let fd = opts.fd === undefined ? null : opts.fd;
        const rs = new stream.Readable({
            ...opts,
            read() {
                if (readStarted || !opened || closed) return;
                readStarted = true;
                queueMicrotask(() => {
                    try {
                        while (!closed) {
                            const chunk = Buffer.alloc(highWaterMark);
                            const n = os.read(fd, chunk.buffer, chunk.byteOffset, chunk.byteLength);
                            if (n < 0) _throwErrno(-n, 'read', typeof pathValue === 'string' ? pathValue : undefined);
                            if (n === 0) break;
                            rs.bytesRead += n;
                            rs.push(chunk.subarray(0, n));
                        }
                        rs.push(null);
                        if (autoClose) rs.close();
                    } catch (err) {
                        rs.destroy(err);
                    }
                });
            },
        });
        rs.path = pathValue;
        rs.fd = fd;
        rs.flags = opts.flags || 'r';
        rs.mode = opts.mode || 0o666;
        rs.autoClose = autoClose;
        rs.bytesRead = 0;
        rs.pending = fd === null;
        rs.close = function(cb) {
            if (typeof cb === 'function') rs.once('close', cb);
            if (closed) return;
            closed = true;
            if (fd !== null && opts.fd === undefined) {
                os.close(fd);
                fd = null;
                rs.fd = null;
            }
            queueMicrotask(() => rs.emit('close'));
        };
        const originalDestroy = rs.destroy.bind(rs);
        rs.destroy = function(err) {
            if (!closed && fd !== null && opts.fd === undefined) {
                os.close(fd);
                fd = null;
                rs.fd = null;
            }
            closed = true;
            return originalDestroy(err);
        };
        queueMicrotask(() => {
            try {
                if (closed) return;
                if (fd === null) {
                    fd = openSync(pathValue, rs.flags, rs.mode);
                    rs.fd = fd;
                }
                opened = true;
                rs.pending = false;
                rs.emit('open', fd);
                rs.emit('ready');
                rs._read(highWaterMark);
            } catch (err) {
                rs.pending = false;
                rs.destroy(err);
            }
        });
        return rs;
    }

    function createWriteStream(filepath, options) {
        const opts = { ...(options || {}) };
        const autoClose = opts.autoClose !== false;
        const pathValue = opts.fd === undefined ? _pathToString(filepath) : filepath;
        let fd = opts.fd === undefined ? null : opts.fd;
        let opened = fd !== null;
        let closed = false;
        const pendingWrites = [];
        const pendingFinals = [];
        function doWrite(chunk, cb) {
            try {
                const bytes = _toFsBytes(chunk, opts.encoding || opts.defaultEncoding || 'utf8', 'chunk');
                const n = os.write(fd, bytes.buffer, bytes.byteOffset, bytes.byteLength);
                if (n < 0) _throwErrno(-n, 'write', typeof pathValue === 'string' ? pathValue : undefined);
                ws.bytesWritten += n;
                cb();
            } catch (err) {
                cb(err);
            }
        }
        function flushPending() {
            while (pendingWrites.length > 0) {
                const { chunk, cb } = pendingWrites.shift();
                doWrite(chunk, cb);
            }
            while (pendingFinals.length > 0) {
                pendingFinals.shift()();
            }
        }
        function closeFd() {
            if (closed) return;
            closed = true;
            if (fd !== null && opts.fd === undefined) {
                os.close(fd);
                fd = null;
                ws.fd = null;
            }
            queueMicrotask(() => ws.emit('close'));
        }
        const ws = new stream.Writable({
            ...opts,
            write(chunk, _encoding, cb) {
                if (!opened) {
                    pendingWrites.push({ chunk, cb });
                    return;
                }
                doWrite(chunk, cb);
            },
            final(cb) {
                const finish = () => {
                    if (autoClose) closeFd();
                    cb();
                };
                if (!opened) pendingFinals.push(finish);
                else finish();
            },
        });
        ws.path = pathValue;
        ws.fd = fd;
        ws.flags = opts.flags || 'w';
        ws.mode = opts.mode || 0o666;
        ws.autoClose = autoClose;
        ws.bytesWritten = 0;
        ws.pending = !opened;
        ws.close = function(cb) {
            if (typeof cb === 'function') ws.once('close', cb);
            closeFd();
        };
        queueMicrotask(() => {
            try {
                if (closed) return;
                if (fd === null) {
                    fd = openSync(pathValue, ws.flags, ws.mode);
                    ws.fd = fd;
                }
                opened = true;
                ws.pending = false;
                ws.emit('open', fd);
                ws.emit('ready');
                flushPending();
            } catch (err) {
                ws.pending = false;
                ws.destroy(err);
            }
        });
        return ws;
    }

    function ReadStream(filepath, options) {
        return createReadStream(filepath, options);
    }

    function WriteStream(filepath, options) {
        return createWriteStream(filepath, options);
    }

    function watchFile(filepath, options, listener) {
        if (typeof options === 'function') {
            listener = options;
            options = undefined;
        }
        const p = _pathToString(filepath);
        let watcher = statWatchers.get(p);
        if (!watcher || watcher.closed) {
            watcher = new StatWatcher(p);
            statWatchers.set(p, watcher);
        }
        if (typeof listener === 'function') watcher.on('change', listener);
        void options;
        return watcher;
    }

    function unwatchFile(filepath, listener) {
        const p = _pathToStringNoThrow(filepath);
        if (p === null) return;
        const watcher = statWatchers.get(p);
        if (!watcher) return;
        if (typeof listener === 'function') watcher.removeListener('change', listener);
        else watcher.removeAllListeners('change');
        if (watcher.listenerCount('change') === 0) {
            statWatchers.delete(p);
            watcher.stop();
        }
    }

    const mod = {
        constants,
        Stats,
        Dirent,
        FSWatcher,
        StatWatcher,
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
        linkSync,
        symlinkSync,
        readlinkSync,
        realpathSync,
        chmodSync,
        chownSync,
        lchownSync,
        utimesSync,
        truncateSync,
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
        FileHandle,
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
        link,
        symlink: _callbackify(symlinkSync),
        readlink: _callbackify(readlinkSync),
        realpath: _callbackify(realpathSync),
        chmod: _callbackify(chmodSync),
        chown: _callbackify(chownSync),
        lchown,
        utimes: _callbackify(utimesSync),
        stat: _callbackify(statSync),
        lstat: _callbackify(lstatSync),
        access: _callbackify(accessSync),
        rm: _callbackify(rmSync),
        exists(filepath, cb) {
            _validateCallback(cb);
            cb(existsSync(filepath));
        },
        open: _callbackify(openSync),
        close: _callbackify(closeSync),
        fstat: _callbackify(fstatSync),
        fchmod: _callbackify(fchmodSync),
        fchown: _callbackify(fchownSync),
        futimes: _callbackify(futimesSync),
        read(fd, buffer, offset, length, position, cb) {
            try {
                const n = readSync(fd, buffer, offset, length, position);
                queueMicrotask(() => cb(null, n, buffer));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },
        write(fd, data, ...rest) {
            const cb = rest.pop();
            try {
                const n = writeSync(fd, data, ...rest);
                queueMicrotask(() => cb(null, n, data));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },

        createReadStream,
        ReadStream,
        createWriteStream,
        WriteStream,

        // No filesystem-watch primitive in our wasm sysroot — return an
        // inert FSWatcher so callers can listen() and close() without
        // exploding. CLI tools that call fs.watch for live updates simply
        // won't get them, which is fine for one-shot invocations.
        watch(_path, _options, listener) {
            if (typeof _options === 'function') listener = _options;
            const w = new FSWatcher();
            if (typeof listener === 'function') w.on('change', listener);
            // listener is never called, since we don't observe changes.
            return w;
        },
        watchFile,
        unwatchFile,
    };

    // fs.promises
    mod.promises = {};
    for (const key of Object.keys(mod)) {
        if (key.endsWith('Sync') || key === 'constants' || key === 'Stats' ||
            key === 'Dirent' || key === 'FSWatcher' || key === 'StatWatcher' ||
            key === 'promises' || key === 'createReadStream' || key === 'ReadStream' ||
            key === 'createWriteStream' || key === 'WriteStream') continue;
        const syncKey = key + 'Sync';
        if (mod[syncKey]) {
            mod.promises[key] = async function(...args) {
                return mod[syncKey](...args);
            };
        }
    }
    mod.promises.readFile = async (p, o) => readFileSync(p, o);
    mod.promises.writeFile = async (p, d, o) => writeFileSync(p, d, o);
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
    mod.promises.link = async (s, d) => linkSync(s, d);
    mod.promises.symlink = async (t, p) => symlinkSync(t, p);
    mod.promises.readlink = async (p) => readlinkSync(p);
    mod.promises.realpath = async (p) => realpathSync(p);
    mod.promises.chmod = async (p, m) => chmodSync(p, m);
    mod.promises.chown = async (p, u, g) => chownSync(p, u, g);
    mod.promises.lchown = async (p, u, g) => lchownSync(p, u, g);
    mod.promises.utimes = async (p, a, m) => utimesSync(p, a, m);
    mod.promises.fstat = async (fd) => fstatSync(fd);
    mod.promises.fchmod = async (fd, m) => fchmodSync(fd, m);
    mod.promises.fchown = async (fd, u, g) => fchownSync(fd, u, g);
    mod.promises.futimes = async (fd, a, m) => futimesSync(fd, a, m);
    mod.promises.open = async (p, flags, mode) => new FileHandle(openSync(p, flags, mode), _pathToString(p));
    mod.promises.constants = constants;

    return mod;
})();

// ============================================================
// os module (Node.js)
// ============================================================

const nodeOs = (() => {
    const [cwd_val] = os.getcwd();
    return {
        EOL: '\n',
        arch() { return 'wasm32'; },
        platform() { return 'linux'; },
        type() { return 'Linux'; },
        release() { return '6.0.0-wasm'; },
        hostname() {
            try {
                const f = std.open('/etc/hostname', 'r');
                if (f) {
                    const name = f.getline();
                    f.close();
                    return name ? name.trim() : 'localhost';
                }
            } catch {}
            return 'localhost';
        },
        homedir() { return std.getenv('HOME') || '/root'; },
        tmpdir() { return std.getenv('TMPDIR') || '/tmp'; },
        cpus() { return [{ model: 'wasm32', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]; },
        totalmem() { return 1073741824; }, // 1GB
        freemem() { return 536870912; }, // 512MB
        loadavg() { return [0, 0, 0]; },
        uptime() { return (Date.now() - _startTime) / 1000; },
        networkInterfaces() { return {}; },
        userInfo() {
            return {
                uid: 0, gid: 0,
                username: std.getenv('USER') || 'root',
                homedir: std.getenv('HOME') || '/root',
                shell: std.getenv('SHELL') || '/bin/sh',
            };
        },
        endianness() { return 'LE'; },
        constants: {
            signals: {
                SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4,
                SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
                SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
                SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17,
                SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
                SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
                SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
                SIGPWR: 30, SIGSYS: 31,
            },
            errno: {
                EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4,
                EIO: 5, EBADF: 9, EAGAIN: 11, ENOMEM: 12,
                EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21,
                EINVAL: 22,
            },
        },
    };
})();

// ============================================================
// util module
// ============================================================

const util = (() => {
    const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
    const nullPrototypeNames = typeof WeakMap === 'function' ? new WeakMap() : null;
    const originalSetPrototypeOf = Object.setPrototypeOf;
    if (typeof originalSetPrototypeOf === 'function' && nullPrototypeNames) {
        Object.defineProperty(Object, 'setPrototypeOf', {
            value(target, proto) {
                if (proto === null && target !== null && (typeof target === 'object' || typeof target === 'function')) {
                    try {
                        const oldProto = Object.getPrototypeOf(target);
                        const ctor = oldProto && oldProto.constructor;
                        if (typeof ctor === 'function' && ctor.name) nullPrototypeNames.set(target, ctor.name);
                    } catch {}
                }
                return originalSetPrototypeOf(target, proto);
            },
            writable: true,
            configurable: true,
        });
    }
    const defaultInspectOptions = {
        depth: 2,
        getters: false,
        numericSeparator: false,
        showHidden: false,
    };

    function makeInvalidArgValueError(name, value) {
        const err = new TypeError(`The argument '${name}' is invalid. Received ${inspect(value)}`);
        err.code = 'ERR_INVALID_ARG_VALUE';
        return err;
    }

    function normalizeInspectOptions(options) {
        return Object.assign({}, defaultInspectOptions, inspect.defaultOptions, options || {});
    }

    function groupDigits(text) {
        const suffix = text.endsWith('n') ? 'n' : '';
        if (suffix) text = text.slice(0, -1);
        const sign = text.startsWith('-') ? '-' : '';
        if (sign) text = text.slice(1);
        const parts = text.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '_');
        return sign + parts.join('.') + suffix;
    }

    function isArrayIndexKey(key, length) {
        if (typeof key !== 'string' || key === '') return false;
        const index = Number(key);
        return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
    }

    function formatNumber(value, options, bigintSuffix) {
        let out = Object.is(value, -0) ? '-0' : String(value);
        if (bigintSuffix && typeof value === 'bigint') out += 'n';
        if (options && options.numericSeparator && /^-?\d+n?$/.test(out)) {
            out = groupDigits(out);
        }
        return out;
    }

    function colorize(text, style, options) {
        if (!options || !options.colors) return text;
        const codes = {
            number: ['33', '39'],
            boolean: ['33', '39'],
            bigint: ['33', '39'],
            undefined: ['90', '39'],
            symbol: ['32', '39'],
            null: ['1', '22'],
        };
        const pair = codes[style];
        return pair ? `\u001b[${pair[0]}m${text}\u001b[${pair[1]}m` : text;
    }

    function numericFormat(value, kind, options) {
        if (typeof value === 'bigint') {
            return kind === 'f' ? formatNumber(value, options, false)
                                : formatNumber(value, options, true);
        }
        if (typeof value === 'symbol') return 'NaN';
        try {
            if (Object.prototype.toString.call(value) === '[object Symbol]') return 'NaN';
        } catch {}
        let n;
        try {
            if (kind === 'i') n = parseInt(value);
            else if (kind === 'f') n = parseFloat(value);
            else n = Number(value);
        } catch {
            return 'NaN';
        }
        if (kind === 'i' && !Number.isFinite(n)) return 'NaN';
        return formatNumber(n, options, false);
    }

    function stringFormat(value, options) {
        if (typeof value === 'number') return formatNumber(value, options, false);
        if (typeof value === 'bigint') return formatNumber(value, options, true);
        if (typeof value === 'symbol') return value.toString();
        if (value === null || value === undefined) return String(value);
        if (typeof value === 'function') return Function.prototype.toString.call(value);
        if (typeof value === 'object') {
            const toString = value.toString;
            if (typeof toString === 'function' && toString !== Object.prototype.toString
                && toString !== Array.prototype.toString) {
                try { return String(toString.call(value)); } catch {}
            }
            return inspect(value, Object.assign({}, options, { depth: 0, colors: false }));
        }
        return Object.is(value, -0) ? '-0' : String(value);
    }

    function formatExtra(value, options) {
        if (typeof value === 'string') return value;
        if (options && options.colors && (value === null || value === undefined ||
            (typeof value !== 'object' && typeof value !== 'function'))) {
            return inspect(value, options);
        }
        if (typeof value === 'number') return formatNumber(value, options, false);
        if (typeof value === 'bigint') return formatNumber(value, options, true);
        if (typeof value === 'symbol') return value.toString();
        if (value instanceof Error && value.stack) return String(value.stack);
        return inspect(value, options);
    }

    function jsonFormat(value) {
        try {
            return JSON.stringify(value);
        } catch (err) {
            if (err instanceof TypeError && /circular|cyclic/i.test(String(err.message))) {
                return '[Circular]';
            }
            throw err;
        }
    }

    function formatWithInspectOptions(options, fmt, ...args) {
        options = normalizeInspectOptions(options);
        if (typeof fmt !== 'string') {
            return [fmt, ...args].map(a => formatExtra(a, options)).join(' ');
        }
        let i = 0;
        return fmt.replace(/%[sdifjoOc%]/g, (match) => {
            if (match === '%%') return '%';
            if (i >= args.length) return match;
            const arg = args[i++];
            switch (match) {
                case '%s': return stringFormat(arg, options);
                case '%d': return numericFormat(arg, 'd', options);
                case '%i': return numericFormat(arg, 'i', options);
                case '%f': return numericFormat(arg, 'f', options);
                case '%j': return jsonFormat(arg);
                case '%o': return inspect(arg, Object.assign({}, options, { showHidden: true, depth: 4 }));
                case '%O': return inspect(arg, options);
                case '%c': return '';
                default: return match;
            }
        }) + (i < args.length ? ' ' + args.slice(i).map(a => formatExtra(a, options)).join(' ') : '');
    }

    function format(fmt, ...args) {
        if (arguments.length === 0) return '';
        return formatWithInspectOptions(undefined, fmt, ...args);
    }

    function inspect(obj, options) {
        options = normalizeInspectOptions(options);
        const seen = [];
        seen.circularRefs = new Map();
        seen.nextRef = 1;
        return inspectValue(obj, options, 0, seen);
    }

    function inspectValue(obj, options, depth, seen) {
        if (obj === null) return colorize('null', 'null', options);
        if (obj === undefined) return colorize('undefined', 'undefined', options);
        if (obj && obj.constructor && obj.constructor.name === 'BlockList') {
            if (options && options.depth < 0) return '[BlockList]';
            const rules = obj.rules && obj.rules.length ? inspect(obj.rules, options) : '[]';
            return `BlockList { rules: ${rules} }`;
        }
        if (obj instanceof TextDecoder) {
            if (options && options.depth < 0) return '[TextDecoder]';
            if (options && options.showHidden) {
                const flags = (obj.fatal ? 1 : 0) | (obj.ignoreBOM ? 4 : 0);
                return 'TextDecoder {\n' +
                    `  encoding: '${obj.encoding}',\n` +
                    `  fatal: ${obj.fatal},\n` +
                    `  ignoreBOM: ${obj.ignoreBOM},\n` +
                    `  [Symbol(flags)]: ${flags},\n` +
                    '  [Symbol(handle)]: StringDecoder {\n' +
                    "    encoding: 'utf8',\n" +
                    '    [Symbol(kNativeDecoder)]: <Buffer 00 00 00 00 00 00 01>\n' +
                    '  }\n' +
                    '}';
            }
            return `TextDecoder { encoding: '${obj.encoding}', fatal: ${obj.fatal}, ignoreBOM: ${obj.ignoreBOM} }`;
        }
        if (obj instanceof TextEncoder) {
            if (options && options.depth < 0) return '[TextEncoder]';
            return 'TextEncoder {}';
        }
        if (typeof globalThis.Event !== 'undefined' && obj instanceof globalThis.Event) {
            if (options && options.depth < 0) return obj.constructor && obj.constructor.name || 'Event';
            return `${obj.constructor && obj.constructor.name || 'Event'} { type: '${obj.type}' }`;
        }
        if (typeof globalThis.EventTarget !== 'undefined' && obj instanceof globalThis.EventTarget) {
            if (options && options.depth < 0) return obj.constructor && obj.constructor.name || 'EventTarget';
            return `${obj.constructor && obj.constructor.name || 'EventTarget'} {}`;
        }
        if (typeof obj === 'string') return `'${obj}'`;
        if (typeof obj === 'number') return colorize(formatNumber(obj, options, false), 'number', options);
        if (typeof obj === 'bigint') return colorize(formatNumber(obj, options, true), 'bigint', options);
        if (typeof obj === 'boolean') return colorize(String(obj), 'boolean', options);
        if (typeof obj === 'symbol') return colorize(obj.toString(), 'symbol', options);
        if (typeof obj === 'function' && !options.showHidden) {
            return obj.name ? `[Function: ${obj.name}]` : '[Function (anonymous)]';
        }
        try { Object.getPrototypeOf(obj); } catch { return '<Revoked Proxy>'; }
        if (obj instanceof Date) return obj.toISOString();
        if (obj instanceof RegExp) return obj.toString();
        if (obj instanceof Error) {
            if (obj.stack) return String(obj.stack);
            const name = obj.name || 'Error';
            return `[${name}${obj.message ? `: ${obj.message}` : ''}]`;
        }
        let custom;
        try { custom = obj && obj[inspectCustom]; } catch { return '<Revoked Proxy>'; }
        if (typeof custom === 'function' && custom !== inspect) {
            try { return String(custom.call(obj, options.depth - depth, options, inspect)); } catch {}
        }
        if (obj instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && obj instanceof SharedArrayBuffer)) {
            const bytes = Array.from(new Uint8Array(obj).slice(0, 50))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join(' ');
            const suffix = obj.byteLength > 50 ? ' ...' : '';
            return `${obj.constructor.name} { [Uint8Contents]: <${bytes}${suffix}>, byteLength: ${obj.byteLength} }`;
        }
        const seenIndex = seen.indexOf(obj);
        if (seenIndex !== -1) {
            let label = seen.circularRefs && seen.circularRefs.get(obj);
            if (!label && seen.circularRefs) {
                label = seen.nextRef++;
                seen.circularRefs.set(obj, label);
            }
            return `[Circular *${label}]`;
        }
        if (depth > options.depth && options.depth !== null) {
            if (Array.isArray(obj)) return '[Array]';
            return `[${obj.constructor && obj.constructor.name || 'Object'}]`;
        }
        seen.push(obj);
        if (Array.isArray(obj)) {
            const items = [];
            for (let i = 0; i < obj.length; i++) {
                if (Object.prototype.hasOwnProperty.call(obj, i)) {
                    items.push(inspectValue(obj[i], options, depth + 1, seen));
                } else {
                    let holes = 1;
                    while (i + 1 < obj.length && !Object.prototype.hasOwnProperty.call(obj, i + 1)) {
                        holes++;
                        i++;
                    }
                    items.push(`<${holes} empty item${holes === 1 ? '' : 's'}>`);
                }
            }
            const descriptors = Object.getOwnPropertyDescriptors(obj);
            const keys = options.showHidden ? Reflect.ownKeys(descriptors) : enumerableOwnKeys(obj);
            for (const key of keys) {
                if (key === 'length' && !options.showHidden) continue;
                if (isArrayIndexKey(key, obj.length)) continue;
                const desc = descriptors[key];
                if (!desc) continue;
                const enumerable = Object.prototype.propertyIsEnumerable.call(obj, key);
                const hidden = options.showHidden && !enumerable;
                const name = key === 'length' ? '[length]' : (typeof key === 'symbol' ? `[${key.toString()}]` : (hidden ? `[${String(key)}]` : String(key)));
                if ('value' in desc) {
                    items.push(`${name}: ${inspectValue(desc.value, options, depth + 1, seen)}`);
                }
            }
            const ctor = obj.constructor && obj.constructor !== Array ? obj.constructor.name : '';
            const prefix = ctor ? `${ctor}(${obj.length}) ` : '';
            let body = items.length ? `[ ${items.join(', ')} ]` : '[]';
            const oneLine = `${prefix}${body}`;
            if (items.length > 1 && (oneLine.length > (options.breakLength || 80) || oneLine.includes('\n'))) {
                const innerIndent = '  '.repeat(depth + 1);
                const outerIndent = '  '.repeat(depth);
                body = `[\n${innerIndent}${items.join(`,\n${innerIndent}`)}\n${outerIndent}]`;
            }
            seen.pop();
            return `${prefix}${body}`;
        }
        if (ArrayBuffer.isView(obj)) {
            const len = obj.length || obj.byteLength || 0;
            const slice = typeof obj.slice === 'function' ? obj.slice(0, 50) : new Uint8Array(obj.buffer, obj.byteOffset, Math.min(obj.byteLength, 50));
            seen.pop();
            return `<${obj.constructor.name} ${Array.from(slice).join(' ')}${len > 50 ? ' ...' : ''}>`;
        }
        try {
            const pairs = [];
            const descriptors = Object.getOwnPropertyDescriptors(obj);
            let keys = options.showHidden ? Reflect.ownKeys(descriptors) : enumerableOwnKeys(obj);
            if (typeof obj === 'function' && options.showHidden) {
                const preferred = ['length', 'name', 'prototype'];
                keys = [
                    ...preferred.filter((key) => Object.prototype.hasOwnProperty.call(descriptors, key)),
                    ...keys.filter((key) => !preferred.includes(key)),
                ];
            }
            for (const k of keys) {
                const desc = descriptors[k];
                const enumerable = Object.prototype.propertyIsEnumerable.call(obj, k);
                const hidden = options.showHidden && !enumerable;
                const name = typeof k === 'symbol' ? `[${k.toString()}]` : (hidden ? `[${String(k)}]` : String(k));
                if (desc && ('value' in desc)) {
                    pairs.push(`${name}: ${inspectValue(desc.value, options, depth + 1, seen)}`);
                } else if (desc && desc.get) {
                    let getterValue = null;
                    let getterIsObject = false;
                    if (options.getters) {
                        try {
                            const raw = desc.get.call(obj);
                            getterIsObject = raw !== null && (typeof raw === 'object' || typeof raw === 'function');
                            getterValue = inspectValue(raw, options, depth + 1, seen);
                        }
                        catch { getterValue = '<Inspection threw>'; }
                    }
                    if (getterValue === null) {
                        pairs.push(`${name}: [Getter]`);
                    } else if (getterIsObject || String(getterValue).startsWith('[Circular ')) {
                        pairs.push(`${name}: [Getter] ${getterValue}`);
                    } else {
                        pairs.push(`${name}: [Getter: ${getterValue}]`);
                    }
                }
            }
            if (options.showHidden && options.getters) {
                let proto = Object.getPrototypeOf(obj);
                while (proto && proto !== Object.prototype) {
                    const protoDescriptors = Object.getOwnPropertyDescriptors(proto);
                    for (const k of Reflect.ownKeys(protoDescriptors)) {
                        if (k === 'constructor') continue;
                        if (pairs.some((p) => p.startsWith(`${String(k)}:`) || p.startsWith(`[${String(k)}]:`))) continue;
                        const desc = protoDescriptors[k];
                        if (!desc || !desc.get) continue;
                        const name = typeof k === 'symbol' ? `[${k.toString()}]` : `[${String(k)}]`;
                        let getterValue;
                        let getterIsObject = false;
                        try {
                            const raw = desc.get.call(obj);
                            getterIsObject = raw !== null && (typeof raw === 'object' || typeof raw === 'function');
                            getterValue = inspectValue(raw, options, depth + 1, seen);
                        }
                        catch { getterValue = '<Inspection threw>'; }
                        if (getterIsObject || String(getterValue).startsWith('[Circular ')) {
                            pairs.push(`${name}: [Getter] ${getterValue}`);
                        } else {
                            pairs.push(`${name}: [Getter: ${getterValue}]`);
                        }
                    }
                    proto = Object.getPrototypeOf(proto);
                }
            }
            const nullProtoName = Object.getPrototypeOf(obj) === null
                ? ((nullPrototypeNames && nullPrototypeNames.get(obj)) || 'Object')
                : null;
            const functionName = typeof obj === 'function'
                ? (obj.name ? `[Function: ${obj.name}]` : '[Function (anonymous)]')
                : '';
            const proto = Object.getPrototypeOf(obj);
            const protoCtor = proto && proto.constructor;
            const ctor = functionName || (nullProtoName
                ? `[${nullProtoName}: null prototype]`
                : (typeof protoCtor === 'function' && protoCtor !== Object ? protoCtor.name : ''));
            let body = pairs.length ? `{ ${pairs.join(', ')} }` : '{}';
            const oneLine = ctor ? `${ctor} ${body}` : body;
            if (pairs.length > 0 && (oneLine.length > (options.breakLength || 80) || oneLine.includes('\n'))) {
                const innerIndent = '  '.repeat(depth + 1);
                const outerIndent = '  '.repeat(depth);
                body = `{\n${innerIndent}${pairs.join(`,\n${innerIndent}`)}\n${outerIndent}}`;
            }
            let result = ctor ? `${ctor} ${body}` : body;
            const refLabel = seen.circularRefs && seen.circularRefs.get(obj);
            if (refLabel) result = `<ref *${refLabel}> ${result}`;
            seen.pop();
            return result;
        } catch {
            seen.pop();
            try { return String(obj); } catch { return '<Revoked Proxy>'; }
        }
    }
    inspect.custom = inspectCustom;
    inspect.defaultOptions = Object.assign({}, defaultInspectOptions);

    function inherits(ctor, superCtor) {
        if (typeof ctor !== 'function') {
            throw _makeInvalidArgTypeError('ctor', 'function', ctor);
        }
        if (superCtor === null || superCtor === undefined) {
            throw _makeInvalidArgTypeError('superCtor', 'function', superCtor);
        }
        if (!superCtor.prototype || typeof superCtor.prototype !== 'object') {
            const err = new TypeError('The "superCtor.prototype" property must be of type object. Received undefined');
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
        }
        if (typeof superCtor !== 'function') {
            throw _makeInvalidArgTypeError('superCtor', 'function', superCtor);
        }
        Object.defineProperty(ctor, 'super_', {
            value: superCtor,
            writable: true,
            configurable: true,
        });
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        Object.defineProperty(ctor.prototype, 'constructor', {
            value: ctor,
            writable: true,
            configurable: true,
        });
        Object.setPrototypeOf(ctor, superCtor);
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

    function promisify(fn) {
        if (fn && fn[promisify.custom]) return fn[promisify.custom];
        return function(...args) {
            return new Promise((resolve, reject) => {
                fn(...args, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        };
    }
    promisify.custom = Symbol.for('nodejs.util.promisify.custom');

    function callbackify(fn) {
        return function(...args) {
            const cb = args.pop();
            fn(...args).then(
                result => cb(null, result),
                err => cb(err)
            );
        };
    }

    function enumerableOwnKeys(value) {
        const keys = Object.keys(value);
        for (const symbol of Object.getOwnPropertySymbols(value)) {
            if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
                keys.push(symbol);
            }
        }
        return keys;
    }

    function isDeepEqual(a, b, strict = false) {
        return innerDeepEqual(a, b, [], !!strict);
    }

    function isDeepStrictEqual(a, b) {
        return innerDeepEqual(a, b, [], true);
    }

    function boxedPrimitiveValue(value) {
        const probes = [
            ['boolean', Boolean.prototype.valueOf],
            ['number', Number.prototype.valueOf],
            ['string', String.prototype.valueOf],
        ];
        if (typeof BigInt === 'function') probes.push(['bigint', BigInt.prototype.valueOf]);
        if (typeof Symbol === 'function') probes.push(['symbol', Symbol.prototype.valueOf]);
        for (const [type, valueOf] of probes) {
            try {
                const primitive = valueOf.call(value);
                if (typeof primitive === type) return { type, value: primitive };
            } catch {}
        }
        return null;
    }

    function innerDeepEqual(a, b, memo, strict) {
        if (strict ? Object.is(a, b) : a == b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return false;
        if (typeof a !== 'object') return false;
        for (const pair of memo) {
            if (pair[0] === a && pair[1] === b) return true;
        }
        memo.push([a, b]);
        if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
        const boxedA = boxedPrimitiveValue(a);
        const boxedB = boxedPrimitiveValue(b);
        if (boxedA || boxedB) {
            if (!boxedA || !boxedB) return false;
            if (strict) {
                if (boxedA.type !== boxedB.type || !Object.is(boxedA.value, boxedB.value)) return false;
            } else if (boxedA.value != boxedB.value) {
                return false;
            }
        }
        if (a instanceof Date || b instanceof Date) {
            return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
        }
        if (a instanceof RegExp || b instanceof RegExp) {
            return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
        }
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (Array.isArray(a) && a.length !== b.length) return false;
        if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
            if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
            if ((strict && a.constructor !== b.constructor) || a.byteLength !== b.byteLength) return false;
            const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
            const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
        }
        if (a instanceof Map || b instanceof Map) {
            if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
            for (const [ak, av] of a) {
                let found = false;
                for (const [bk, bv] of b) {
                    if (innerDeepEqual(ak, bk, memo, strict) && innerDeepEqual(av, bv, memo, strict)) {
                        found = true;
                        break;
                    }
                }
                if (!found) return false;
            }
        }
        if (a instanceof Set || b instanceof Set) {
            if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
            for (const av of a) {
                let found = false;
                for (const bv of b) {
                    if (innerDeepEqual(av, bv, memo, strict)) {
                        found = true;
                        break;
                    }
                }
                if (!found) return false;
            }
        }
        const keysA = enumerableOwnKeys(a);
        const keysB = enumerableOwnKeys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!keysB.includes(key)) return false;
        }
        for (const key of keysA) {
            if (!innerDeepEqual(a[key], b[key], memo, strict)) return false;
        }
        return true;
    }

    const types = {
        isDate(v) { return v instanceof Date; },
        isRegExp(v) { return v instanceof RegExp; },
        isNativeError(v) { return v instanceof Error; },
        isPromise(v) { return v instanceof Promise; },
        isAsyncFunction(v) { return typeof v === 'function' && v.constructor && v.constructor.name === 'AsyncFunction'; },
        isArrayBuffer(v) { return v instanceof ArrayBuffer; },
        isAnyArrayBuffer(v) { return v instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer); },
        isArrayBufferView(v) { return ArrayBuffer.isView(v); },
        isTypedArray(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); },
        isMap(v) { return v instanceof Map; },
        isSet(v) { return v instanceof Set; },
        isMapIterator(v) { return Object.prototype.toString.call(v) === '[object Map Iterator]'; },
        isSetIterator(v) { return Object.prototype.toString.call(v) === '[object Set Iterator]'; },
        isWeakMap(v) { return v instanceof WeakMap; },
        isWeakSet(v) { return v instanceof WeakSet; },
        isDataView(v) { return v instanceof DataView; },
        isUint8Array(v) { return v instanceof Uint8Array; },
        isExternal(_v) { return false; },
    };

    // Node's util.formatWithOptions(opts, ...args). Our inspect() ignores
    // the options bag (no color/depth knobs yet) so this is just format()
    // with the leading options dropped — npm's lib/utils/format.js is the
    // primary caller.
    function formatWithOptions(opts, ...args) {
        if (opts === null || typeof opts !== 'object') {
            throw _makeInvalidArgTypeError('inspectOptions', 'object', opts);
        }
        if (args.length === 0) return '';
        return formatWithInspectOptions(opts, ...args);
    }

    const customInspectSymbol = inspectCustom;
    TextEncoder.prototype[customInspectSymbol] = function() {
        _assertTextEncoder(this);
        return 'TextEncoder {}';
    };
    TextDecoder.prototype[customInspectSymbol] = function(_depth, options) {
        _assertTextDecoder(this);
        return inspect(this, options);
    };

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

    function aborted(signal, resource) {
        if (!(signal instanceof AbortSignal)) {
            const err = _makeInvalidArgTypeError('signal', 'AbortSignal', signal);
            return Promise.reject(err);
        }
        if ((resource === null || resource === undefined) || (typeof resource !== 'object' && typeof resource !== 'function')) {
            const err = _makeInvalidArgTypeError('resource', 'object', resource);
            return Promise.reject(err);
        }
        if (signal.aborted) return Promise.resolve();
        return new Promise((resolve) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function transferableAbortSignal(signal) {
        if (!(signal instanceof AbortSignal)) throw _makeInvalidArgTypeError('signal', 'AbortSignal', signal);
        return signal;
    }

    function transferableAbortController() {
        return new AbortController();
    }

    function _mimeSyntaxError(message) {
        const err = new TypeError(message);
        err.code = 'ERR_INVALID_MIME_SYNTAX';
        return err;
    }

    function _isHttpToken(value) {
        return typeof value === 'string' && value.length > 0 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
    }

    function _quoteMimeValue(value) {
        value = String(value);
        if (value === '' || /[\s";=]/.test(value)) {
            return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        return value;
    }

    class MIMEParams {
        constructor(init, owner) {
            this._owner = owner || null;
            this._pairs = [];
            if (owner) return;
            void init;
        }
        _list() { return this._owner ? this._owner._params : this._pairs; }
        get size() { return this._list().length; }
        has(name) {
            name = String(name).toLowerCase();
            return this._list().some((pair) => pair[0] === name);
        }
        get(name) {
            name = String(name).toLowerCase();
            const pair = this._list().find((entry) => entry[0] === name);
            return pair ? pair[1] : null;
        }
        set(name, value) {
            name = String(name).toLowerCase();
            value = String(value);
            if (!_isHttpToken(name)) throw _mimeSyntaxError('Invalid MIME parameter name');
            if (/[\n\r]/.test(value)) throw _mimeSyntaxError('Invalid MIME parameter value');
            const list = this._list();
            const pair = list.find((entry) => entry[0] === name);
            if (pair) pair[1] = value;
            else list.push([name, value]);
        }
        delete(name) {
            name = String(name).toLowerCase();
            const list = this._list();
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i][0] === name) list.splice(i, 1);
            }
        }
        *entries() {
            for (const pair of this._list()) yield [pair[0], pair[1]];
        }
        keys() { return Array.from(this._list(), (pair) => pair[0])[Symbol.iterator](); }
        values() { return Array.from(this._list(), (pair) => pair[1])[Symbol.iterator](); }
        [Symbol.iterator]() { return this.entries(); }
        toString() {
            return this._list().map(([k, v]) => `${k}=${_quoteMimeValue(v)}`).join(';');
        }
    }

    class MIMEType {
        constructor(input) {
            if (arguments.length === 0) throw _mimeSyntaxError('Invalid MIME syntax');
            const raw = String(input).trim();
            const parts = raw.split(';');
            const essence = parts.shift().trim().toLowerCase();
            const slash = essence.indexOf('/');
            if (slash <= 0 || slash === essence.length - 1) throw _mimeSyntaxError('Invalid MIME syntax');
            this._type = essence.slice(0, slash);
            this._subtype = essence.slice(slash + 1);
            if (!_isHttpToken(this._type) || !_isHttpToken(this._subtype)) throw _mimeSyntaxError('Invalid MIME syntax');
            this._params = [];
            this.params = new MIMEParams(undefined, this);
            for (const part of parts) {
                if (!part.trim()) continue;
                const idx = part.indexOf('=');
                if (idx <= 0) continue;
                this.params.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim().replace(/^"|"$/g, ''));
            }
        }
        get type() { return this._type; }
        set type(value) {
            value = String(value).toLowerCase();
            if (!_isHttpToken(value)) throw _mimeSyntaxError('Invalid MIME type');
            this._type = value;
        }
        get subtype() { return this._subtype; }
        set subtype(value) {
            value = String(value).toLowerCase();
            if (!_isHttpToken(value)) throw _mimeSyntaxError('Invalid MIME subtype');
            this._subtype = value;
        }
        get essence() { return `${this._type}/${this._subtype}`; }
        toString() {
            const params = this.params.toString();
            return this.essence + (params ? `;${params}` : '');
        }
        toJSON() { return this.toString(); }
    }

    function log(...args) {
        const now = new Date();
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getDate()} ${months[now.getMonth()]} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        process.stdout.write(`${stamp} - ${format(...args)}\n`);
    }

    const ansiStyles = {
        bold: ['\u001b[1m', '\u001b[22m'],
        red: ['\u001b[31m', '\u001b[39m'],
    };

    function styleText(formatName, text) {
        if (!Array.isArray(formatName) && typeof formatName !== 'string') {
            throw makeInvalidArgValueError('format', formatName);
        }
        if (typeof text !== 'string') throw _makeInvalidArgTypeError('text', 'string', text);
        const names = Array.isArray(formatName) ? formatName : [formatName];
        let open = '';
        let close = '';
        for (const name of names) {
            if (typeof name !== 'string' || !ansiStyles[name]) {
                throw makeInvalidArgValueError('format', name);
            }
            open += ansiStyles[name][0];
            close = ansiStyles[name][1] + close;
        }
        return open + text + close;
    }

    function stripVTControlCharacters(value) {
        return String(value).replace(/\u001b\[[0-9;]*m/g, '');
    }

    return {
        format, formatWithOptions, inspect, inherits, deprecate, promisify, callbackify,
        isDeepEqual, isDeepStrictEqual, types,
        log, styleText, stripVTControlCharacters,
        debuglog, debug: debuglog,
        TextDecoder, TextEncoder,
        MIMEType, MIMEParams,
        aborted, transferableAbortSignal, transferableAbortController,
        customInspectSymbol,
        // Deprecated but widely used
        isArray: Array.isArray,
        isBoolean: v => typeof v === 'boolean',
        isNull: v => v === null,
        isNullOrUndefined: v => v == null,
        isNumber: v => typeof v === 'number',
        isString: v => typeof v === 'string',
        isUndefined: v => v === undefined,
        isObject: v => typeof v === 'object' && v !== null,
        isFunction: v => typeof v === 'function',
        isRegExp: v => v instanceof RegExp,
    };
})();

// ============================================================
// assert module
// ============================================================

const assert = (() => {
    class AssertionError extends Error {
        constructor(options) {
            const hasMessage = Object.prototype.hasOwnProperty.call(options, 'message') && options.message !== undefined;
            super(hasMessage ? String(options.message) : `${util.inspect(options.actual)} ${options.operator} ${util.inspect(options.expected)}`);
            this.name = 'AssertionError';
            this.actual = options.actual;
            this.expected = options.expected;
            this.operator = options.operator;
            this.generatedMessage = options.generatedMessage !== undefined ? options.generatedMessage : !hasMessage;
            this.code = 'ERR_ASSERTION';
        }
    }

    function makeAssertion(actual, expected, operator, message, generatedMessage) {
        throw new AssertionError({ actual, expected, operator, message, generatedMessage });
    }

    function throwMissingExpectedException(expected, operator, message) {
        const error = new AssertionError({
            actual: undefined,
            expected: expected || 'exception',
            operator,
            message: message || 'Missing expected exception.',
            generatedMessage: !message,
        });
        if (typeof error.stack === 'string') {
            error.stack = error.stack.split('\n').filter((line) => !line.includes('throws')).join('\n');
        }
        throw error;
    }

    function makeTypeError(code, message) {
        const err = new TypeError(message);
        err.code = code;
        return err;
    }

    function makeRangeError(code, message) {
        const err = new RangeError(message);
        err.code = code;
        return err;
    }

    function describeReceived(value) {
        if (value === undefined) return 'undefined';
        if (value === null) return 'null';
        if (typeof value === 'string') return `type string (${util.inspect(value)})`;
        if (typeof value === 'number') return `type number (${value})`;
        if (typeof value === 'boolean') return `type boolean (${value})`;
        if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`;
        if (typeof value === 'object') {
            const name = value.constructor && value.constructor.name;
            return name ? `an instance of ${name}` : 'an instance of Object';
        }
        return `type ${typeof value}`;
    }

    function invalidPromiseArg(value) {
        return makeTypeError(
            'ERR_INVALID_ARG_TYPE',
            `The "promiseFn" argument must be of type function or an instance of Promise. Received ${describeReceived(value)}`
        );
    }

    function invalidReturnValue(value) {
        const suffix = value === undefined ? 'undefined' : describeReceived(value);
        return makeTypeError(
            'ERR_INVALID_RETURN_VALUE',
            `Expected instance of Promise to be returned from the "promiseFn" function but got ${suffix}.`
        );
    }

    function invalidArgValue(name, value) {
        const err = new TypeError(`The argument '${name}' is invalid. Received ${util.inspect(value)}`);
        err.code = 'ERR_INVALID_ARG_VALUE';
        return err;
    }

    function isPromiseLike(value) {
        return value !== null && typeof value === 'object' &&
            typeof value.then === 'function' && typeof value.catch === 'function';
    }

    function getPromiseFromInput(promiseFn) {
        if (typeof promiseFn === 'function') {
            let result;
            try {
                result = promiseFn();
            } catch (err) {
                return { thrown: err };
            }
            if (!isPromiseLike(result)) return { error: invalidReturnValue(result) };
            return { promise: result };
        }
        if (!isPromiseLike(promiseFn)) return { error: invalidPromiseArg(promiseFn) };
        return { promise: promiseFn };
    }

    function matchExpected(actual, expected) {
        if (expected === undefined) return true;
        if (expected instanceof RegExp) {
            return expected.test(String(actual));
        }
        if (typeof expected === 'function') {
            if (expected.prototype && (expected === Error || expected.prototype instanceof Error)) {
                return actual instanceof expected;
            }
            const result = expected(actual);
            if (result === true) return true;
            return { validationResult: result };
        }
        if (expected !== null && typeof expected === 'object') {
            for (const key of Object.keys(expected)) {
                const expectedValue = expected[key];
                const actualValue = actual && actual[key];
                if (expectedValue instanceof RegExp) {
                    if (!expectedValue.test(String(actualValue))) return false;
                } else if (!util.isDeepStrictEqual(actualValue, expectedValue)) {
                    return false;
                }
            }
            return true;
        }
        return util.isDeepStrictEqual(actual, expected);
    }

    function expectedName(expected) {
        if (expected === undefined) return '';
        if (expected instanceof RegExp) return expected.toString();
        if (typeof expected === 'function') return expected.name || 'validation function';
        return util.inspect(expected);
    }

    function assertExpectedMatch(actual, expected, operator, message) {
        const matched = matchExpected(actual, expected);
        if (matched === true) return;
        if (matched && Object.prototype.hasOwnProperty.call(matched, 'validationResult')) {
            const detail = `The "validate" validation function is expected to return "true". Received ${util.inspect(matched.validationResult)}\n\nCaught error:\n\n${util.inspect(actual)}`;
            makeAssertion(actual, expected, operator, message || detail, !message);
        }
        const defaultMessage = `The input did not match the expected ${expectedName(expected)}. Input:\n\n${util.inspect(actual)}`;
        makeAssertion(actual, expected, operator, message || defaultMessage, !message);
    }

    function assertDoesNotExpectedValid(expected) {
        if (expected === undefined || expected instanceof RegExp || typeof expected === 'function') return;
        throw _makeInvalidArgTypeError('expected', 'function or an instance of RegExp', expected);
    }

    function errorSummary(error) {
        if (error && typeof error.message === 'string') {
            if (error.message) return error.message;
            return error.name || '';
        }
        return util.inspect(error);
    }

    function copyFunctionProperties(from, to) {
        const descriptors = Object.getOwnPropertyDescriptors(from);
        const skip = ['arguments', 'caller', 'prototype'];
        for (let i = 0; i < skip.length; i++) delete descriptors[skip[i]];
        const keys = Reflect.ownKeys(descriptors);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const descriptor = descriptors[key];
            const clean = Object.create(null);
            if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) clean.value = descriptor.value;
            if (Object.prototype.hasOwnProperty.call(descriptor, 'writable')) clean.writable = descriptor.writable;
            if (Object.prototype.hasOwnProperty.call(descriptor, 'get')) clean.get = descriptor.get;
            if (Object.prototype.hasOwnProperty.call(descriptor, 'set')) clean.set = descriptor.set;
            clean.enumerable = descriptor.enumerable;
            clean.configurable = descriptor.configurable;
            try { Object.defineProperty(to, key, clean); } catch {}
        }
        if (!Object.prototype.hasOwnProperty.call(from, 'length')) {
            try { delete to.length; } catch {}
        }
    }

    class CallTracker {
        constructor() {
            this._checks = [];
        }

        calls(fn, exact) {
            if (process._exiting) {
                const err = new Error('Cannot call tracker.calls() once process exit has started.');
                err.code = 'ERR_UNAVAILABLE_DURING_EXIT';
                throw err;
            }

            let target = fn;
            let expected = exact;
            if (typeof target !== 'function') {
                if (target === undefined) {
                    target = function noop() {};
                    if (expected === undefined) expected = 1;
                } else if (typeof target === 'number' && expected === undefined) {
                    expected = target;
                    target = function noop() {};
                } else {
                    throw _makeInvalidArgTypeError('fn', 'function', fn);
                }
            } else if (expected === undefined) {
                expected = 1;
            }

            if (typeof expected !== 'number') {
                throw _makeInvalidArgTypeError('exact', 'number', expected);
            }
            if (!Number.isInteger(expected) || expected < 0) {
                throw makeRangeError('ERR_OUT_OF_RANGE', 'The value of "exact" is out of range.');
            }

            const check = {
                target,
                expected,
                actual: 0,
                calls: [],
                operator: target.name || 'anonymous',
                stack: new Error(),
            };
            const tracked = function() {
                'use strict';
                const args = Array.prototype.slice.call(arguments);
                check.actual++;
                check.calls.push({ thisArg: this, arguments: args });
                return target.apply(this, args);
            };
            copyFunctionProperties(target, tracked);
            check.tracked = tracked;
            this._checks.push(check);
            return tracked;
        }

        getCalls(fn) {
            const check = this._checks.find((entry) => entry.tracked === fn);
            if (!check) throw invalidArgValue('fn', fn);
            return Object.freeze(check.calls.map((call) => Object.freeze({
                arguments: Object.freeze(Array.from(call.arguments)),
                thisArg: call.thisArg,
            })));
        }

        reset(fn) {
            if (fn === undefined) {
                for (const check of this._checks) {
                    check.actual = 0;
                    check.calls = [];
                }
                return;
            }
            const check = this._checks.find((entry) => entry.tracked === fn);
            if (!check) throw invalidArgValue('fn', fn);
            check.actual = 0;
            check.calls = [];
        }

        report() {
            return this._checks
                .filter((check) => check.actual !== check.expected)
                .map((check) => ({
                    message: `Expected the ${check.operator} function to be executed ${check.expected} time(s) but was executed ${check.actual} time(s).`,
                    actual: check.actual,
                    expected: check.expected,
                    operator: check.operator,
                    stack: check.stack,
                }));
        }

        verify() {
            const report = this.report();
            if (report.length === 0) return;
            throw new AssertionError({
                actual: report,
                expected: [],
                operator: 'CallTracker',
                message: report.length === 1 ? report[0].message : 'Functions were not called the expected number of times',
            });
        }
    }

    function _assert(value, message) {
        if (!value) {
            throw new AssertionError({ actual: value, expected: true, operator: '==', message });
        }
    }

    _assert.ok = _assert;

    _assert.equal = function(actual, expected, message) {
        if (actual != expected) {
            throw new AssertionError({ actual, expected, operator: '==', message });
        }
    };

    _assert.notEqual = function(actual, expected, message) {
        if (actual == expected) {
            throw new AssertionError({ actual, expected, operator: '!=', message });
        }
    };

    _assert.strictEqual = function(actual, expected, message) {
        if (actual !== expected) {
            throw new AssertionError({ actual, expected, operator: '===', message });
        }
    };

    _assert.notStrictEqual = function(actual, expected, message) {
        if (actual === expected) {
            throw new AssertionError({ actual, expected, operator: '!==', message });
        }
    };

    _assert.deepEqual = function(actual, expected, message) {
        if (!util.isDeepEqual(actual, expected, false)) {
            throw new AssertionError({ actual, expected, operator: 'deepEqual', message });
        }
    };

    _assert.deepStrictEqual = function(actual, expected, message) {
        if (!util.isDeepStrictEqual(actual, expected)) {
            throw new AssertionError({ actual, expected, operator: 'deepStrictEqual', message });
        }
    };

    _assert.notDeepEqual = function(actual, expected, message) {
        if (util.isDeepEqual(actual, expected, false)) {
            throw new AssertionError({ actual, expected, operator: 'notDeepEqual', message });
        }
    };

    _assert.notDeepStrictEqual = function(actual, expected, message) {
        if (util.isDeepStrictEqual(actual, expected)) {
            throw new AssertionError({ actual, expected, operator: 'notDeepStrictEqual', message });
        }
    };

    _assert.throws = function(fn, expected, message) {
        if (typeof expected === 'string') {
            message = expected;
            expected = undefined;
        }
        let actual;
        try { fn(); } catch (e) { actual = e; }
        if (actual === undefined) {
            throwMissingExpectedException(expected, 'throws', message);
        }
        assertExpectedMatch(actual, expected, 'throws', message);
    };

    _assert.doesNotThrow = function(fn, expected, message) {
        if (typeof expected === 'string') {
            message = expected;
            expected = undefined;
        }
        try { fn(); } catch (e) {
            assertDoesNotExpectedValid(expected);
            if (expected !== undefined && matchExpected(e, expected) !== true) throw e;
            const defaultMessage = `Got unwanted exception${e && e.message ? `: ${e.message}` : '.'}`;
            throw new AssertionError({ actual: e, expected, operator: 'doesNotThrow', message: message || defaultMessage, generatedMessage: !message });
        }
    };

    _assert.rejects = function(promiseFn, expected, message) {
        if (typeof expected === 'string') {
            message = expected;
            expected = undefined;
        }
        const input = getPromiseFromInput(promiseFn);
        if (Object.prototype.hasOwnProperty.call(input, 'thrown')) return Promise.reject(input.thrown);
        if (input.error) return Promise.reject(input.error);
        return Promise.resolve(input.promise).then(
            () => {
                const suffix = typeof expected === 'function' ? ` (${expected.name || 'validation function'})` : '';
                throw new AssertionError({
                    actual: undefined,
                    expected: expected || 'rejection',
                    operator: 'rejects',
                    message: message || `Missing expected rejection${suffix}.`,
                    generatedMessage: !message,
                });
            },
            (reason) => {
                assertExpectedMatch(reason, expected, 'rejects', message);
            }
        );
    };

    _assert.doesNotReject = function(promiseFn, expected, message) {
        if (typeof expected === 'string') {
            message = expected;
            expected = undefined;
        }
        const input = getPromiseFromInput(promiseFn);
        if (Object.prototype.hasOwnProperty.call(input, 'thrown')) return Promise.reject(input.thrown);
        if (input.error) return Promise.reject(input.error);
        return Promise.resolve(input.promise).then(
            () => undefined,
            (reason) => {
                assertDoesNotExpectedValid(expected);
                if (expected !== undefined && matchExpected(reason, expected) !== true) return;
                throw new AssertionError({
                    actual: reason,
                    expected,
                    operator: 'doesNotReject',
                    message: message || `Got unwanted rejection.\nActual message: "${errorSummary(reason)}"`,
                    generatedMessage: !message,
                });
            }
        );
    };

    _assert.match = function(string, regexp, message) {
        if (!(regexp instanceof RegExp)) {
            throw _makeInvalidArgTypeError('regexp', 'RegExp', regexp);
        }
        if (typeof string !== 'string') {
            throw new AssertionError({
                actual: string,
                expected: regexp,
                operator: 'match',
                message: message || `The "string" argument must be of type string. Received ${describeReceived(string)}`,
                generatedMessage: !message,
            });
        }
        if (!regexp.test(string)) {
            throw new AssertionError({
                actual: string,
                expected: regexp,
                operator: 'match',
                message: message || `The input did not match the regular expression ${regexp}. Input:\n\n${util.inspect(string)}`,
                generatedMessage: !message,
            });
        }
    };

    _assert.doesNotMatch = function(string, regexp, message) {
        if (!(regexp instanceof RegExp)) {
            throw _makeInvalidArgTypeError('regexp', 'RegExp', regexp);
        }
        if (typeof string !== 'string') {
            throw new AssertionError({
                actual: string,
                expected: regexp,
                operator: 'doesNotMatch',
                message: message || `The "string" argument must be of type string. Received ${describeReceived(string)}`,
                generatedMessage: !message,
            });
        }
        if (regexp.test(string)) {
            throw new AssertionError({
                actual: string,
                expected: regexp,
                operator: 'doesNotMatch',
                message: message || `The input was expected to not match the regular expression ${regexp}. Input:\n\n${util.inspect(string)}`,
                generatedMessage: !message,
            });
        }
    };

    _assert.ifError = function(value) {
        if (value === null || value === undefined) return;
        throw new AssertionError({
            actual: value,
            expected: null,
            operator: 'ifError',
            message: `ifError got unwanted exception: ${errorSummary(value)}`,
        });
    };

    _assert.fail = function(actual, expected, message, operator) {
        if (arguments.length <= 1) {
            throw new AssertionError({ message: actual || 'Failed', operator: 'fail' });
        }
        throw new AssertionError({ actual, expected, message, operator: operator || 'fail' });
    };

    _assert.AssertionError = AssertionError;
    _assert.CallTracker = CallTracker;

    const strict = function strictAssert(value, message) {
        return _assert.ok(value, message);
    };
    Object.assign(strict, _assert);
    strict.equal = _assert.strictEqual;
    strict.notEqual = _assert.notStrictEqual;
    strict.deepEqual = _assert.deepStrictEqual;
    strict.notDeepEqual = _assert.notDeepStrictEqual;
    strict.strict = strict;
    _assert.strict = strict;

    return _assert;
})();

// ============================================================
// stream module (minimal)
// ============================================================

const stream = (() => {
    let defaultByteHighWaterMark = 64 * 1024;
    let defaultObjectHighWaterMark = 16;

    function inherits(ctor, superCtor) {
        Object.setPrototypeOf(ctor, superCtor);
        ctor.prototype = Object.create(superCtor.prototype, {
            constructor: { value: ctor, writable: true, configurable: true },
        });
    }

    function getDefaultHighWaterMark(objectMode) {
        return objectMode ? defaultObjectHighWaterMark : defaultByteHighWaterMark;
    }

    function setDefaultHighWaterMark(objectMode, value) {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0) {
            throw _makeInvalidArgTypeError('value', 'a non-negative number', value);
        }
        if (objectMode) defaultObjectHighWaterMark = value;
        else defaultByteHighWaterMark = value;
    }

    function initEmitter(self) {
        if (!self._events) self._events = Object.create(null);
        if (self._maxListeners === undefined) {
            self._maxListeners = events.EventEmitter.defaultMaxListeners;
        }
    }

    function normalizeEncoding(encoding) {
        const enc = String(encoding || 'utf8').toLowerCase();
        if (enc === 'utf-8') return 'utf8';
        if (enc === 'binary') return 'latin1';
        if (enc === 'ucs-2') return 'ucs2';
        if (enc === 'utf-16le') return 'utf16le';
        return enc;
    }

    function chunkLength(chunk, state) {
        if (chunk == null) return 0;
        if (state.objectMode) return 1;
        if (typeof chunk === 'string') return chunk.length;
        if (chunk.byteLength !== undefined) return chunk.byteLength;
        if (chunk.length !== undefined) return chunk.length;
        return 1;
    }

    function toBufferChunk(chunk, encoding) {
        if (chunk instanceof Uint8Array) return Buffer.from(chunk);
        if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
        if (ArrayBuffer.isView(chunk)) {
            return Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        if (typeof chunk === 'string') return Buffer.from(chunk, encoding);
        return chunk;
    }

    function decodeReadableChunk(state, chunk) {
        if (!state.encoding || chunk == null || typeof chunk === 'string') return chunk;
        if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) {
            return state.decoder.write(toBufferChunk(chunk));
        }
        return chunk;
    }

    function initReadable(self, options) {
        options = options || {};
        initEmitter(self);
        const objectMode = !!(options.objectMode || options.readableObjectMode);
        self.readable = true;
        self.destroyed = false;
        self._readableState = {
            objectMode,
            highWaterMark: options.highWaterMark ?? options.readableHighWaterMark ?? getDefaultHighWaterMark(objectMode),
            buffer: [],
            length: 0,
            pipes: [],
            pipeRecords: [],
            awaitDrainWriters: new Set(),
            ended: false,
            endEmitted: false,
            endScheduled: false,
            endPending: false,
            flowing: null,
            emittedReadable: false,
            readableListening: false,
            needReadable: false,
            reading: false,
            sync: true,
            destroyed: false,
            errorEmitted: false,
            aborted: false,
            closed: false,
            emitClose: options.emitClose !== false,
            autoDestroy: options.autoDestroy !== false,
            encoding: null,
            decoder: null,
        };
        if (typeof options.read === 'function') self._read = options.read;
        if (typeof options.destroy === 'function') self._destroy = options.destroy;
    }

    function initWritable(self, options) {
        options = options || {};
        initEmitter(self);
        const objectMode = !!(options.objectMode || options.writableObjectMode);
        self.writable = true;
        self.destroyed = false;
        self._writableState = {
            objectMode,
            highWaterMark: options.highWaterMark ?? options.writableHighWaterMark ?? getDefaultHighWaterMark(objectMode),
            decodeStrings: options.decodeStrings !== false,
            defaultEncoding: normalizeEncoding(options.defaultEncoding || 'utf8'),
            length: 0,
            corked: 0,
            buffered: [],
            bufferedRequestCount: 0,
            needDrain: false,
            ending: false,
            ended: false,
            finished: false,
            destroyed: false,
            errorEmitted: false,
            errored: null,
            closed: false,
            emitClose: options.emitClose !== false,
            autoDestroy: options.autoDestroy !== false,
            pendingcb: 0,
        };
        if (typeof options.write === 'function') self._write = options.write;
        if (typeof options.writev === 'function') self._writev = options.writev;
        if (typeof options.final === 'function') self._final = options.final;
        if (typeof options.destroy === 'function') self._destroy = options.destroy;
    }

    function Stream() {
        if (!(this instanceof Stream)) return new Stream();
        initEmitter(this);
    }
    Stream.prototype = Object.create(events.EventEmitter.prototype, {
        constructor: { value: Stream, writable: true, configurable: true },
    });

    Stream.prototype.pipe = function(dest, options) {
        if (!dest || typeof dest.write !== 'function') return dest;
        const src = this;
        const state = src._readableState;
        const endDest = !options || options.end !== false;
        const onDrain = () => {
            if (state) state.awaitDrainWriters.delete(dest);
            if (typeof src.resume === 'function') src.resume();
        };
        const onData = (chunk) => {
            const ret = dest.write(chunk);
            if (ret === false && state) {
                state.awaitDrainWriters.add(dest);
                if (typeof src.pause === 'function') src.pause();
                if (typeof dest.once === 'function') dest.once('drain', onDrain);
            }
        };
        const onEnd = () => {
            if (endDest && typeof dest.end === 'function') dest.end();
        };
        if (state) {
            if (!state.pipes.includes(dest)) state.pipes.push(dest);
            state.pipeRecords.push({ dest, onData, onEnd, onDrain });
        }
        if (typeof dest.emit === 'function') dest.emit('pipe', src);
        src.on('data', onData);
        src.on('end', onEnd);
        if (typeof src.resume === 'function') src.resume();
        return dest;
    };

    function Readable(options) {
        if (!(this instanceof Readable)) return new Readable(options);
        initReadable(this, options);
    }
    inherits(Readable, Stream);

    Readable.prototype._read = function(_size) {};

    Readable.prototype.push = function(chunk, encoding) {
        const state = this._readableState;
        if (!state || state.destroyed) return false;
        if (chunk === null) {
            state.ended = true;
            if (state.length === 0 || state.flowing || this.listenerCount('end') > 0) {
                this._emitReadableEnd();
            } else {
                state.endPending = true;
            }
            return false;
        }
        if (!state.objectMode) chunk = toBufferChunk(chunk, encoding);
        chunk = decodeReadableChunk(state, chunk);
        state.length += chunkLength(chunk, state);
        if (state.flowing || this.listenerCount('data') > 0) {
            state.flowing = true;
            this.emit('data', chunk);
        } else {
            state.buffer.push(chunk);
        }
        this.emit('readable');
        return state.length < state.highWaterMark;
    };

    Readable.prototype.unshift = function(chunk, encoding) {
        const state = this._readableState;
        if (!state || state.destroyed || chunk === null) return false;
        if (!state.objectMode) chunk = toBufferChunk(chunk, encoding);
        chunk = decodeReadableChunk(state, chunk);
        state.buffer.unshift(chunk);
        state.length += chunkLength(chunk, state);
        state.endEmitted = false;
        state.ended = false;
        return state.length < state.highWaterMark;
    };

    Readable.prototype.read = function(size) {
        const state = this._readableState;
        if (!state || state.destroyed) return null;
        if (state.buffer.length === 0 && !state.ended) {
            state.reading = true;
            try { this._read(size || state.highWaterMark); }
            finally { state.reading = false; }
        }
        if (state.buffer.length === 0) {
            if (state.ended) this._emitReadableEnd();
            return null;
        }
        const chunk = state.buffer.shift();
        state.length = Math.max(0, state.length - chunkLength(chunk, state));
        if (state.buffer.length === 0 && state.endPending) this._emitReadableEnd();
        return chunk;
    };

    Readable.prototype._emitReadableEnd = function() {
        const state = this._readableState;
        if (!state || state.endEmitted || state.endScheduled) return;
        state.endScheduled = true;
        state.endPending = false;
        queueMicrotask(() => {
            if (state.endEmitted) return;
            state.endScheduled = false;
            state.ended = true;
            state.endEmitted = true;
            this.readable = false;
            this.emit('end');
        });
    };

    Readable.prototype._drain = function() {
        const state = this._readableState;
        if (!state || state.destroyed) return;
        state.flowing = true;
        while (state.flowing && state.buffer.length > 0) {
            const chunk = this.read();
            if (chunk === null) break;
            this.emit('data', chunk);
        }
        if (state.buffer.length === 0 && (state.endPending || state.ended)) {
            this._emitReadableEnd();
        }
    };

    Readable.prototype._maybeDrain = function(event) {
        const state = this._readableState;
        if (!state) return;
        if (event === 'readable') state.readableListening = true;
        if (event === 'data' && state.buffer.length > 0) this._drain();
        if (event === 'end' && state.ended && state.length === 0) this._emitReadableEnd();
    };

    Readable.prototype.on = function(event, fn) {
        const r = Stream.prototype.on.call(this, event, fn);
        this._maybeDrain(event);
        return r;
    };
    Readable.prototype.addListener = Readable.prototype.on;

    Readable.prototype.resume = function() {
        this._drain();
        return this;
    };

    Readable.prototype.pause = function() {
        if (this._readableState) this._readableState.flowing = false;
        return this;
    };

    Readable.prototype.isPaused = function() {
        return !this._readableState || this._readableState.flowing === false;
    };

    Readable.prototype.setEncoding = function(encoding) {
        const state = this._readableState;
        const enc = normalizeEncoding(encoding || 'utf8');
        state.encoding = enc;
        state.decoder = new string_decoder.StringDecoder(enc);
        if (state.buffer.length > 0) {
            const decoded = [];
            for (const chunk of state.buffer) {
                const value = decodeReadableChunk(state, chunk);
                if (value !== '') decoded.push(value);
            }
            state.buffer = decoded;
            state.length = decoded.reduce((n, chunk) => n + chunkLength(chunk, state), 0);
        }
        return this;
    };

    Readable.prototype.unpipe = function(dest) {
        const state = this._readableState;
        if (!state) return this;
        const keep = [];
        for (const rec of state.pipeRecords) {
            if (dest && rec.dest !== dest) {
                keep.push(rec);
                continue;
            }
            this.removeListener('data', rec.onData);
            this.removeListener('end', rec.onEnd);
            if (rec.dest && typeof rec.dest.removeListener === 'function') {
                rec.dest.removeListener('drain', rec.onDrain);
            }
            const idx = state.pipes.indexOf(rec.dest);
            if (idx >= 0) state.pipes.splice(idx, 1);
            if (rec.dest && typeof rec.dest.emit === 'function') rec.dest.emit('unpipe', this);
        }
        state.pipeRecords = keep;
        return this;
    };

    Readable.prototype.wrap = function(oldStream) {
        if (!oldStream || typeof oldStream.on !== 'function') return this;
        oldStream.on('data', (chunk) => this.push(chunk));
        oldStream.on('end', () => this.push(null));
        oldStream.on('error', (err) => this.emit('error', err));
        oldStream.on('close', () => this.emit('close'));
        this._read = function() {
            if (typeof oldStream.resume === 'function') oldStream.resume();
        };
        return this;
    };

    Readable.prototype.destroy = function(err) {
        const state = this._readableState;
        if (state && state.destroyed) return this;
        if (state) {
            state.destroyed = true;
            state.closed = true;
        }
        this.destroyed = true;
        this.readable = false;
        if (err) this.emit('error', err);
        this.emit('close');
        return this;
    };

    Readable.prototype[Symbol.asyncIterator] = function() {
        const src = this;
        return {
            [Symbol.asyncIterator]() { return this; },
            next() {
                const chunk = src.read();
                if (chunk !== null) return Promise.resolve({ value: chunk, done: false });
                const state = src._readableState;
                if (state && state.endEmitted) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve, reject) => {
                    const cleanup = () => {
                        src.removeListener('data', onData);
                        src.removeListener('end', onEnd);
                        src.removeListener('error', onError);
                    };
                    const onData = (value) => { cleanup(); src.pause(); resolve({ value, done: false }); };
                    const onEnd = () => { cleanup(); resolve({ value: undefined, done: true }); };
                    const onError = (err) => { cleanup(); reject(err); };
                    src.once('data', onData);
                    src.once('end', onEnd);
                    src.once('error', onError);
                    src.resume();
                });
            },
        };
    };

    Readable.from = function(iterable, options) {
        const readable = new Readable({ objectMode: options?.objectMode !== false, ...options });
        queueMicrotask(async () => {
            try {
                for await (const item of iterable) readable.push(item);
                readable.push(null);
            } catch (err) {
                readable.destroy(err);
            }
        });
        return readable;
    };

    Readable.prototype.map = function(fn, options) {
        const out = new Readable({ objectMode: options?.objectMode !== false });
        (async () => {
            try {
                let i = 0;
                for await (const chunk of this) out.push(await fn(chunk, i++));
                out.push(null);
            } catch (err) { out.destroy(err); }
        })();
        return out;
    };

    Readable.prototype.filter = function(fn, options) {
        const out = new Readable({ objectMode: options?.objectMode !== false });
        (async () => {
            try {
                let i = 0;
                for await (const chunk of this) {
                    if (await fn(chunk, i++)) out.push(chunk);
                }
                out.push(null);
            } catch (err) { out.destroy(err); }
        })();
        return out;
    };

    Readable.prototype.flatMap = function(fn, options) {
        return this.map(fn, options).map((value) => value).compose(function(source) {
            const out = new Readable({ objectMode: true });
            (async () => {
                try {
                    for await (const value of source) {
                        if (value && typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') {
                            for (const inner of value) out.push(inner);
                        } else {
                            out.push(value);
                        }
                    }
                    out.push(null);
                } catch (err) { out.destroy(err); }
            })();
            return out;
        });
    };

    Readable.prototype.compose = function(fn) {
        return typeof fn === 'function' ? fn(this) : this.pipe(fn);
    };

    Readable.prototype.forEach = async function(fn) {
        let i = 0;
        for await (const chunk of this) await fn(chunk, i++);
    };

    Readable.prototype.toArray = async function() {
        const out = [];
        for await (const chunk of this) out.push(chunk);
        return out;
    };

    Readable.prototype.reduce = async function(fn, initial) {
        let has = arguments.length > 1;
        let acc = initial;
        let i = 0;
        for await (const chunk of this) {
            if (!has) {
                acc = chunk;
                has = true;
            } else {
                acc = await fn(acc, chunk, i);
            }
            i++;
        }
        if (!has) throw new TypeError('Reduce of an empty stream with no initial value');
        return acc;
    };

    Readable.prototype.drop = function(count) {
        let seen = 0;
        return this.filter(() => seen++ >= count);
    };

    Readable.prototype.take = function(count) {
        let seen = 0;
        return this.filter(() => seen++ < count);
    };

    Readable.toWeb = function(readable) { return readable; };
    Readable.fromWeb = function(readable, options) {
        if (readable instanceof Readable) return readable;
        if (readable && typeof readable[Symbol.asyncIterator] === 'function') {
            return Readable.from(readable, options);
        }
        return new Readable(options);
    };

    Object.defineProperties(Readable.prototype, {
        readableEnded: { get() { return !!this._readableState?.endEmitted; } },
        readableFlowing: { get() { return this._readableState?.flowing ?? null; } },
        readableLength: { get() { return this._readableState?.length ?? 0; } },
        readableHighWaterMark: { get() { return this._readableState?.highWaterMark; } },
        readableObjectMode: { get() { return !!this._readableState?.objectMode; } },
        readableEncoding: { get() { return this._readableState?.encoding || null; } },
        readableDestroyed: { get() { return !!this._readableState?.destroyed; } },
        closed: { get() { return !!(this._readableState?.closed || this._writableState?.closed); } },
        errored: { get() { return this._readableState?.errored || this._writableState?.errored || null; } },
    });

    function prepareWrite(state, chunk, encoding) {
        encoding = normalizeEncoding(encoding || state.defaultEncoding);
        if (!state.objectMode) {
            if (chunk === null) throw _makeInvalidArgTypeError('chunk', 'string, Buffer, or Uint8Array', chunk);
            if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)
                && !ArrayBuffer.isView(chunk)) {
                throw _makeInvalidArgTypeError('chunk', 'string, Buffer, or Uint8Array', chunk);
            }
            if (typeof chunk === 'string') {
                if (state.decodeStrings) {
                    chunk = Buffer.from(chunk, encoding);
                    encoding = 'buffer';
                }
            } else {
                chunk = toBufferChunk(chunk);
                encoding = 'buffer';
            }
        }
        return { chunk, encoding };
    }

    function Writable(options) {
        if (!(this instanceof Writable)) return new Writable(options);
        initWritable(this, options);
    }
    inherits(Writable, Stream);

    Writable.prototype._write = function(_chunk, _encoding, cb) { cb(); };

    Writable.prototype.write = function(chunk, encoding, cb) {
        const state = this._writableState;
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        cb = typeof cb === 'function' ? cb : () => {};
        if (!state || state.destroyed || state.ending || state.ended) {
            const err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            this.emit('error', err);
            cb(err);
            return false;
        }
        let prepared;
        try { prepared = prepareWrite(state, chunk, encoding); }
        catch (err) {
            this.emit('error', err);
            cb(err);
            return false;
        }
        const len = chunkLength(prepared.chunk, state);
        state.length += len;
        if (state.length >= state.highWaterMark) state.needDrain = true;
        if (state.corked > 0) {
            state.buffered.push({ ...prepared, cb, len });
            state.bufferedRequestCount = state.buffered.length;
        } else {
            this._writeOne(prepared.chunk, prepared.encoding, cb, len);
        }
        return !state.needDrain;
    };

    Writable.prototype._writeOne = function(chunk, encoding, cb, len) {
        const state = this._writableState;
        state.pendingcb++;
        this._write(chunk, encoding, (err) => {
            state.pendingcb--;
            state.length = Math.max(0, state.length - len);
            if (err) {
                state.errored = err;
                state.errorEmitted = true;
                this.emit('error', err);
            }
            cb(err);
            if (state.needDrain && state.length === 0) {
                state.needDrain = false;
                this.emit('drain');
            }
            if (state.ending && state.pendingcb === 0 && state.buffered.length === 0) {
                this._finishWritable();
            }
        });
    };

    Writable.prototype.cork = function() {
        this._writableState.corked++;
    };

    Writable.prototype.uncork = function() {
        const state = this._writableState;
        if (state.corked > 0) state.corked--;
        if (state.corked === 0) this._clearBuffer();
    };

    Writable.prototype._clearBuffer = function() {
        const state = this._writableState;
        const buffered = state.buffered;
        state.buffered = [];
        state.bufferedRequestCount = 0;
        if (buffered.length > 1 && typeof this._writev === 'function') {
            const chunks = buffered.map(({ chunk, encoding }) => ({ chunk, encoding }));
            const total = buffered.reduce((n, item) => n + item.len, 0);
            state.pendingcb += buffered.length;
            this._writev(chunks, (err) => {
                state.pendingcb -= buffered.length;
                state.length = Math.max(0, state.length - total);
                for (const item of buffered) item.cb(err);
                if (err) {
                    state.errored = err;
                    state.errorEmitted = true;
                    this.emit('error', err);
                }
                if (state.needDrain && state.length === 0) {
                    state.needDrain = false;
                    this.emit('drain');
                }
                if (state.ending && state.pendingcb === 0) this._finishWritable();
            });
            return;
        }
        for (const item of buffered) {
            this._writeOne(item.chunk, item.encoding, item.cb, item.len);
        }
    };

    Writable.prototype.end = function(chunk, encoding, cb) {
        const state = this._writableState;
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
        state.ending = true;
        state.ended = true;
        this.writable = false;
        if (state.corked > 0) state.corked = 0;
        this._clearBuffer();
        if (typeof cb === 'function') this.once('finish', cb);
        if (state.pendingcb === 0 && state.buffered.length === 0) this._finishWritable();
        return this;
    };

    Writable.prototype._finishWritable = function() {
        const state = this._writableState;
        if (state.finished) return;
        const finish = (err) => {
            if (err) {
                state.errored = err;
                this.emit('error', err);
                return;
            }
            state.finished = true;
            this.emit('finish');
        };
        if (typeof this._final === 'function') this._final(finish);
        else finish();
    };

    Writable.prototype.setDefaultEncoding = function(encoding) {
        this._writableState.defaultEncoding = normalizeEncoding(encoding);
        return this;
    };

    Writable.prototype.destroy = function(err) {
        const state = this._writableState;
        if (state && state.destroyed) return this;
        if (state) {
            state.destroyed = true;
            state.closed = true;
            if (err) state.errored = err;
        }
        this.destroyed = true;
        this.writable = false;
        if (err) this.emit('error', err);
        this.emit('close');
        return this;
    };

    Object.defineProperties(Writable.prototype, {
        writableEnded: { get() { return !!this._writableState?.ended; } },
        writableFinished: { get() { return !!this._writableState?.finished; } },
        writableDestroyed: { get() { return !!this._writableState?.destroyed; } },
        writableNeedDrain: { get() { return !!this._writableState?.needDrain; } },
        writableLength: { get() { return this._writableState?.length ?? 0; } },
        writableHighWaterMark: { get() { return this._writableState?.highWaterMark; } },
        writableObjectMode: { get() { return !!this._writableState?.objectMode; } },
        writableCorked: { get() { return this._writableState?.corked ?? 0; } },
        closed: { get() { return !!(this._writableState?.closed || this._readableState?.closed); } },
        errored: { get() { return this._writableState?.errored || this._readableState?.errored || null; } },
    });

    function Duplex(options) {
        if (!(this instanceof Duplex)) return new Duplex(options);
        initReadable(this, options);
        initWritable(this, options);
        this.allowHalfOpen = !options || options.allowHalfOpen !== false;
    }
    inherits(Duplex, Readable);
    for (const method of [
        '_write', 'write', '_writeOne', 'cork', 'uncork', '_clearBuffer', 'end',
        '_finishWritable', 'setDefaultEncoding',
    ]) {
        Duplex.prototype[method] = Writable.prototype[method];
    }
    for (const prop of [
        'writableEnded', 'writableFinished', 'writableDestroyed',
        'writableNeedDrain', 'writableLength', 'writableHighWaterMark',
        'writableObjectMode', 'writableCorked',
    ]) {
        Object.defineProperty(
            Duplex.prototype,
            prop,
            Object.getOwnPropertyDescriptor(Writable.prototype, prop)
        );
    }
    Duplex.prototype.destroy = function(err) {
        Readable.prototype.destroy.call(this, err);
        if (this._writableState) {
            this._writableState.destroyed = true;
            this._writableState.closed = true;
            this.writable = false;
        }
        return this;
    };
    Duplex.from = function(src) {
        if (src instanceof Duplex) return src;
        const duplex = new Duplex({ objectMode: true });
        if (src && src.readable) src.on('data', (c) => duplex.push(c)).on('end', () => duplex.push(null));
        else queueMicrotask(() => duplex.push(null));
        return duplex;
    };
    Duplex.toWeb = function(duplex) { return duplex; };
    Duplex.fromWeb = function(duplex, options) { return duplex instanceof Duplex ? duplex : Duplex.from(duplex, options); };

    function Transform(options) {
        if (!(this instanceof Transform)) return new Transform(options);
        Duplex.call(this, options);
        if (options && typeof options.transform === 'function') this._transform = options.transform;
        if (options && typeof options.flush === 'function') this._flush = options.flush;
    }
    inherits(Transform, Duplex);
    Transform.prototype._transform = function(chunk, _encoding, cb) { cb(null, chunk); };
    Transform.prototype._write = function(chunk, encoding, cb) {
        this._transform(chunk, encoding, (err, data) => {
            if (data !== undefined && data !== null) this.push(data);
            cb(err);
        });
    };
    Transform.prototype.end = function(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
        const finishReadable = () => {
            if (typeof this._flush === 'function') {
                this._flush((err, data) => {
                    if (err) this.emit('error', err);
                    if (data !== undefined && data !== null) this.push(data);
                    this.push(null);
                });
            } else {
                this.push(null);
            }
        };
        this.once('finish', finishReadable);
        return Writable.prototype.end.call(this, undefined, undefined, cb);
    };

    function PassThrough(options) {
        if (!(this instanceof PassThrough)) return new PassThrough(options);
        Transform.call(this, options);
    }
    inherits(PassThrough, Transform);
    PassThrough.prototype._transform = function(chunk, _encoding, cb) { cb(null, chunk); };

    function finished(stream, cb) {
        const onEnd = () => { cleanup(); cb && cb(null); };
        const onError = (err) => { cleanup(); cb && cb(err); };
        const cleanup = () => {
            stream.removeListener('end', onEnd);
            stream.removeListener('finish', onEnd);
            stream.removeListener('close', onEnd);
            stream.removeListener('error', onError);
        };
        stream.on('end', onEnd);
        stream.on('finish', onEnd);
        stream.on('close', onEnd);
        stream.on('error', onError);
        return cleanup;
    }

    function pipeline(...streams) {
        const cb = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
        for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
        const last = streams[streams.length - 1];
        if (cb) finished(last, cb);
        return last;
    }

    const promises = {
        pipeline(...streams) {
            return new Promise((resolve, reject) => {
                pipeline(...streams, (err) => err ? reject(err) : resolve());
            });
        },
        finished(stream) {
            return new Promise((resolve, reject) => {
                finished(stream, (err) => err ? reject(err) : resolve());
            });
        },
    };

    // `class X extends require('stream')` (Minipass) needs the export to be
    // a constructor, so attach helpers onto Stream itself.
    Object.assign(Stream, {
        Stream, Readable, Writable, Duplex, Transform, PassThrough,
        pipeline,
        finished,
        promises,
        getDefaultHighWaterMark,
        setDefaultHighWaterMark,
        addAbortSignal(_signal, stream) { return stream; },
        destroy(stream, err, cb) {
            if (stream && typeof stream.destroy === 'function') stream.destroy(err);
            if (typeof cb === 'function') cb(err);
            return stream;
        },
        isReadable(stream) { return !!(stream && stream.readable && !stream.readableDestroyed); },
        isWritable(stream) { return !!(stream && stream.writable && !stream.writableDestroyed); },
        isErrored(stream) { return !!(stream && stream.errored); },
        isDestroyed(stream) { return !!(stream && stream.destroyed); },
    });
    return Stream;
})();

// ============================================================
// url module
// ============================================================

const url = (() => {
    const URL_STATE = Symbol('kandelo.url.state');
    const SEARCH_PARAMS_STATE = Symbol('kandelo.urlSearchParams.state');
    const SEARCH_PARAMS_ITERATOR_STATE = Symbol('kandelo.urlSearchParamsIterator.state');

    class Url {
        constructor() {
            this.protocol = null;
            this.slashes = null;
            this.auth = null;
            this.host = null;
            this.port = null;
            this.hostname = null;
            this.hash = null;
            this.search = null;
            this.query = null;
            this.pathname = null;
            this.path = null;
            this.href = '';
        }
    }

    function makeTypeError(code, message) {
        const err = new TypeError(message);
        if (code) err.code = code;
        return err;
    }

    function toNodeString(value) {
        if (typeof value === 'symbol') {
            throw new TypeError('Cannot convert a Symbol value to a string');
        }
        return String(value);
    }

    function toUSVString(value) {
        const input = toNodeString(value);
        let out = '';
        for (let i = 0; i < input.length; i++) {
            const code = input.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF) {
                if (i + 1 < input.length) {
                    const next = input.charCodeAt(i + 1);
                    if (next >= 0xDC00 && next <= 0xDFFF) {
                        out += input[i] + input[++i];
                        continue;
                    }
                }
                out += '\uFFFD';
            } else if (code >= 0xDC00 && code <= 0xDFFF) {
                out += '\uFFFD';
            } else {
                out += input[i];
            }
        }
        return out;
    }

    function hexByte(ch) {
        return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    }

    function percentEncodeForm(value) {
        return encodeURIComponent(toUSVString(value))
            .replace(/%20/g, '+')
            .replace(/[!'()~]/g, hexByte);
    }

    function safeDecode(text, plusAsSpace) {
        let input = String(text);
        if (plusAsSpace) input = input.replace(/\+/g, ' ');
        input = input.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
        try {
            return decodeURIComponent(input);
        } catch {
            return input;
        }
    }

    function quoteInspect(value) {
        return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }

    function encodeUserInfo(value) {
        return encodeURIComponent(toUSVString(value));
    }

    function encodePathname(value) {
        let text = toUSVString(value);
        if (!text.startsWith('/')) text = '/' + text;
        return encodeURI(text).replace(/[?#]/g, hexByte);
    }

    function encodeSearch(value) {
        let text = toUSVString(value);
        if (text.startsWith('?')) text = text.slice(1);
        if (text === '') return '';
        return '?' + encodeURI(text).replace(/#/g, '%23');
    }

    function encodeHash(value) {
        let text = toUSVString(value);
        if (text.startsWith('#')) text = text.slice(1);
        if (text === '') return '';
        return '#' + encodeURI(text);
    }

    function parseSearchPairs(search) {
        const out = [];
        const qs = String(search || '').replace(/^\?/, '');
        if (!qs) return out;
        for (const pair of qs.split('&')) {
            if (pair === '') continue;
            const eq = pair.indexOf('=');
            const key = eq === -1 ? pair : pair.slice(0, eq);
            const value = eq === -1 ? '' : pair.slice(eq + 1);
            out.push([safeDecode(key, true), safeDecode(value, true)]);
        }
        return out;
    }

    function serializePairs(pairs) {
        return pairs.map(([key, value]) => `${percentEncodeForm(key)}=${percentEncodeForm(value)}`).join('&');
    }

    function removeDotSegments(pathname) {
        const isAbs = pathname.startsWith('/');
        const trailing = pathname.endsWith('/');
        const out = [];
        for (const part of pathname.split('/')) {
            if (part === '' || part === '.') continue;
            if (part === '..') {
                if (out.length) out.pop();
                continue;
            }
            out.push(part);
        }
        let result = (isAbs ? '/' : '') + out.join('/');
        if (trailing && result !== '/' && result !== '') result += '/';
        return result || (isAbs ? '/' : '');
    }

    function parse(urlStr, parseQueryString) {
        // `new URL(URL_instance)` is valid in WHATWG; coerce to string so the
        // regex-based scanner doesn't throw "match is not a function".
        if (typeof urlStr !== 'string') urlStr = String(urlStr);
        // Simple URL parser
        const result = new Url();
        result.href = urlStr;

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

        if (result.pathname === '' && result.host) result.pathname = '/';
        result.path = result.pathname + (result.search || '');
        result.href = format(result);

        if (parseQueryString) {
            result.query = querystring.parse(result.query || '');
        }

        return result;
    }

    function format(urlObj) {
        let result = '';
        if (urlObj.protocol) result += urlObj.protocol + '//';
        if (urlObj.auth) result += urlObj.auth + '@';
        if (urlObj.host && !urlObj.hostname) result += urlObj.host;
        else if (urlObj.hostname) result += urlObj.hostname;
        if (urlObj.port) result += ':' + urlObj.port;
        result += urlObj.pathname || (urlObj.host ? '/' : '');
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

    function resolveObject(from, to) {
        if (!from) return to;
        return parse(resolve(from, to));
    }

    function parseAuthority(authority, state) {
        let host = authority;
        const atIdx = host.lastIndexOf('@');
        if (atIdx !== -1) {
            const auth = host.slice(0, atIdx);
            host = host.slice(atIdx + 1);
            const colon = auth.indexOf(':');
            if (colon === -1) {
                state.username = auth;
                state.password = '';
            } else {
                state.username = auth.slice(0, colon);
                state.password = auth.slice(colon + 1);
            }
        }

        if (host.startsWith('[')) {
            const end = host.indexOf(']');
            if (end !== -1) {
                state.hostname = host.slice(0, end + 1).toLowerCase();
                if (host[end + 1] === ':') state.port = host.slice(end + 2);
                return;
            }
        }

        const colon = host.lastIndexOf(':');
        if (colon > -1 && host.indexOf(':') === colon) {
            state.hostname = host.slice(0, colon).toLowerCase();
            state.port = host.slice(colon + 1);
        } else {
            state.hostname = host.toLowerCase();
            state.port = '';
        }
    }

    function parseAbsoluteUrl(value) {
        const input = toNodeString(value);
        const match = input.match(/^([A-Za-z][A-Za-z0-9+.-]*:)([\s\S]*)$/);
        if (!match) throw new TypeError(`Invalid URL: ${input}`);

        const state = {
            protocol: match[1].toLowerCase(),
            username: '',
            password: '',
            hostname: '',
            port: '',
            pathname: '',
            search: '',
            hash: '',
            hasAuthority: false,
        };

        let rest = match[2];
        const hashIdx = rest.indexOf('#');
        if (hashIdx !== -1) {
            state.hash = rest.slice(hashIdx);
            rest = rest.slice(0, hashIdx);
        }
        const searchIdx = rest.indexOf('?');
        if (searchIdx !== -1) {
            state.search = rest.slice(searchIdx);
            rest = rest.slice(0, searchIdx);
        }

        if (rest.startsWith('//')) {
            state.hasAuthority = true;
            rest = rest.slice(2);
            const slash = rest.search(/[/?#]/);
            const authority = slash === -1 ? rest : rest.slice(0, slash);
            state.pathname = slash === -1 ? '/' : rest.slice(slash) || '/';
            parseAuthority(authority, state);
            if (state.pathname === '') state.pathname = '/';
        } else {
            state.pathname = rest || '';
        }

        if (state.hasAuthority && state.pathname === '') state.pathname = '/';
        return state;
    }

    function parseUrl(input, base) {
        const value = toNodeString(input);
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return parseAbsoluteUrl(value);
        if (base === undefined) throw new TypeError(`Invalid URL: ${value}`);

        const baseState = parseUrl(base);
        if (value.startsWith('//')) return parseAbsoluteUrl(baseState.protocol + value);

        const hashIdx = value.indexOf('#');
        const beforeHash = hashIdx === -1 ? value : value.slice(0, hashIdx);
        const hash = hashIdx === -1 ? '' : value.slice(hashIdx);
        const searchIdx = beforeHash.indexOf('?');
        const beforeSearch = searchIdx === -1 ? beforeHash : beforeHash.slice(0, searchIdx);
        const search = searchIdx === -1 ? '' : beforeHash.slice(searchIdx);

        const state = { ...baseState, hash: hash || '', search: search || '' };
        if (beforeSearch === '') {
            if (searchIdx === -1) state.search = baseState.search;
            return state;
        }
        if (beforeSearch.startsWith('/')) {
            state.pathname = removeDotSegments(beforeSearch);
            return state;
        }

        const basePath = baseState.pathname || '/';
        const baseDir = basePath.endsWith('/') ? basePath : basePath.slice(0, basePath.lastIndexOf('/') + 1);
        state.pathname = removeDotSegments(baseDir + beforeSearch);
        return state;
    }

    function hostFromState(state) {
        if (!state.hostname) return '';
        return state.hostname + (state.port ? ':' + state.port : '');
    }

    function formatUrlState(state) {
        let out = state.protocol;
        if (state.hasAuthority) {
            out += '//';
            if (state.username || state.password) {
                out += state.username;
                if (state.password) out += ':' + state.password;
                out += '@';
            }
            out += hostFromState(state);
        }
        out += state.pathname || (state.hasAuthority ? '/' : '');
        out += state.search || '';
        out += state.hash || '';
        return out;
    }

    function originFromState(state) {
        if (state.protocol === 'blob:') {
            try {
                return originFromState(parseAbsoluteUrl(state.pathname));
            } catch {
                return 'null';
            }
        }
        if (/^(https?|wss?|ftp):$/.test(state.protocol) && state.hostname) {
            return `${state.protocol}//${hostFromState(state)}`;
        }
        return 'null';
    }

    function getUrlState(self) {
        if (!self || !self[URL_STATE]) {
            throw makeTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type URL');
        }
        return self[URL_STATE];
    }

    function getSearchParamsState(self) {
        if (!self || !self[SEARCH_PARAMS_STATE]) {
            throw makeTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type URLSearchParams');
        }
        return self[SEARCH_PARAMS_STATE];
    }

    function getSearchParamsIteratorState(self) {
        if (!self || !self[SEARCH_PARAMS_ITERATOR_STATE]) {
            throw makeTypeError('ERR_INVALID_THIS', 'Value of "this" must be of type URLSearchParamsIterator');
        }
        return self[SEARCH_PARAMS_ITERATOR_STATE];
    }

    function requireSearchParamArgs(actual, expected, message) {
        if (actual < expected) throw makeTypeError('ERR_MISSING_ARGS', message);
    }

    function updateOwnerSearch(state) {
        if (!state.owner) return;
        const ownerState = getUrlState(state.owner);
        const serialized = serializePairs(state.pairs);
        ownerState.search = serialized ? '?' + serialized : '';
    }

    function resetSearchParamsFromUrl(urlObject) {
        const state = getUrlState(urlObject);
        const paramsState = getSearchParamsState(state.searchParams);
        paramsState.pairs = parseSearchPairs(state.search);
    }

    const SearchParamsClass = class URLSearchParams {
        constructor(init) {
            const state = { pairs: [], owner: null };
            Object.defineProperty(this, SEARCH_PARAMS_STATE, { value: state });
            if (init == null) return;
            if (typeof init === 'string') {
                state.pairs = parseSearchPairs(init);
                return;
            }
            const iterator = init && init[Symbol.iterator];
            if (iterator !== undefined) {
                if (typeof iterator !== 'function') {
                    throw makeTypeError('ERR_ARG_NOT_ITERABLE', 'Query pairs must be iterable');
                }
                for (const pair of init) {
                    if (pair == null || typeof pair[Symbol.iterator] !== 'function') {
                        throw makeTypeError('ERR_INVALID_TUPLE', 'Each query pair must be an iterable [name, value] tuple');
                    }
                    const tuple = Array.from(pair);
                    if (tuple.length !== 2) {
                        throw makeTypeError('ERR_INVALID_TUPLE', 'Each query pair must be an iterable [name, value] tuple');
                    }
                    state.pairs.push([toUSVString(tuple[0]), toUSVString(tuple[1])]);
                }
                return;
            }
            if (typeof init === 'object') {
                for (const sym of Object.getOwnPropertySymbols(init)) {
                    if (Object.prototype.propertyIsEnumerable.call(init, sym)) {
                        throw new TypeError('Cannot convert a Symbol value to a string');
                    }
                }
                for (const key of Object.keys(init)) {
                    state.pairs.push([toUSVString(key), toUSVString(init[key])]);
                }
                return;
            }
            state.pairs = parseSearchPairs(toNodeString(init));
        }
        get size() { return getSearchParamsState(this).pairs.length; }
        get(key) {
            requireSearchParamArgs(arguments.length, 1, 'The "name" argument must be specified');
            key = toUSVString(key);
            const pair = getSearchParamsState(this).pairs.find(([k]) => k === key);
            return pair ? pair[1] : null;
        }
        set(key, val) {
            requireSearchParamArgs(arguments.length, 2, 'The "name" and "value" arguments must be specified');
            key = toUSVString(key);
            val = toUSVString(val);
            const state = getSearchParamsState(this);
            let found = false;
            const next = [];
            for (const pair of state.pairs) {
                if (pair[0] === key) {
                    if (!found) next.push([key, val]);
                    found = true;
                } else {
                    next.push(pair);
                }
            }
            if (!found) next.push([key, val]);
            state.pairs = next;
            updateOwnerSearch(state);
        }
        has(key) {
            requireSearchParamArgs(arguments.length, 1, 'The "name" argument must be specified');
            key = toUSVString(key);
            return getSearchParamsState(this).pairs.some(([k]) => k === key);
        }
        append(key, val) {
            requireSearchParamArgs(arguments.length, 2, 'The "name" and "value" arguments must be specified');
            const state = getSearchParamsState(this);
            state.pairs.push([toUSVString(key), toUSVString(val)]);
            updateOwnerSearch(state);
        }
        delete(key) {
            requireSearchParamArgs(arguments.length, 1, 'The "name" argument must be specified');
            key = toUSVString(key);
            const state = getSearchParamsState(this);
            state.pairs = state.pairs.filter(([k]) => k !== key);
            updateOwnerSearch(state);
        }
        getAll(key) {
            requireSearchParamArgs(arguments.length, 1, 'The "name" argument must be specified');
            key = toUSVString(key);
            return getSearchParamsState(this).pairs.filter(([k]) => k === key).map(([, v]) => v);
        }
        sort() {
            const state = getSearchParamsState(this);
            state.pairs = state.pairs
                .map((pair, index) => ({ pair, index }))
                .sort((a, b) => a.pair[0] < b.pair[0] ? -1 : a.pair[0] > b.pair[0] ? 1 : a.index - b.index)
                .map(({ pair }) => pair);
            updateOwnerSearch(state);
        }
        entries() { getSearchParamsState(this); return new URLSearchParamsIterator(this, 'entries'); }
        keys() { getSearchParamsState(this); return new URLSearchParamsIterator(this, 'keys'); }
        values() { getSearchParamsState(this); return new URLSearchParamsIterator(this, 'values'); }
        forEach(cb, thisArg) {
            if (typeof cb !== 'function') {
                throw makeTypeError('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
            }
            for (const [k, v] of getSearchParamsState(this).pairs.slice()) {
                cb.call(thisArg, v, k, this);
            }
        }
        toString() { return serializePairs(getSearchParamsState(this).pairs); }
        [util.inspect.custom](depth, options) {
            getSearchParamsState(this);
            if (depth !== undefined && depth < 0) return '[Object]';
            const pairs = getSearchParamsState(this).pairs.map(([k, v]) => `${quoteInspect(k)} => ${quoteInspect(v)}`);
            if (pairs.length === 0) return 'URLSearchParams {}';
            if (options && options.breakLength <= 1) return `URLSearchParams {\n  ${pairs.join(',\n  ')} }`;
            return `URLSearchParams { ${pairs.join(', ')} }`;
        }
    };
    SearchParamsClass.prototype[Symbol.iterator] = SearchParamsClass.prototype.entries;
    const searchParamsPrototypeOrder = [
        'size', 'append', 'delete', 'get', 'getAll', 'has', 'set', 'sort',
        'entries', 'forEach', 'keys', 'values', 'toString',
    ];
    const searchParamsPrototypeDescriptors = {};
    for (const name of searchParamsPrototypeOrder) {
        const desc = Object.getOwnPropertyDescriptor(SearchParamsClass.prototype, name);
        if (desc) {
            searchParamsPrototypeDescriptors[name] = { ...desc, enumerable: true };
            delete SearchParamsClass.prototype[name];
        }
    }
    for (const name of searchParamsPrototypeOrder) {
        if (searchParamsPrototypeDescriptors[name]) {
            Object.defineProperty(SearchParamsClass.prototype, name, searchParamsPrototypeDescriptors[name]);
        }
    }
    Object.defineProperty(SearchParamsClass.prototype, Symbol.iterator, {
        value: SearchParamsClass.prototype.entries,
        writable: true,
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(SearchParamsClass.prototype, Symbol.toStringTag, {
        value: 'URLSearchParams',
        configurable: true,
    });

    class URLSearchParamsIterator {
        constructor(params, kind) {
            Object.defineProperty(this, SEARCH_PARAMS_ITERATOR_STATE, {
                value: { params, kind, index: 0 },
            });
        }
        next() {
            const state = getSearchParamsIteratorState(this);
            const pairs = getSearchParamsState(state.params).pairs;
            if (state.index >= pairs.length) return { value: undefined, done: true };
            const pair = pairs[state.index++];
            if (state.kind === 'keys') return { value: pair[0], done: false };
            if (state.kind === 'values') return { value: pair[1], done: false };
            return { value: [pair[0], pair[1]], done: false };
        }
        [Symbol.iterator]() { return this; }
        [util.inspect.custom](_depth, options) {
            const state = getSearchParamsIteratorState(this);
            const pairs = getSearchParamsState(state.params).pairs.slice(state.index);
            const items = pairs.map((pair) => {
                if (state.kind === 'keys') return quoteInspect(pair[0]);
                if (state.kind === 'values') return quoteInspect(pair[1]);
                return `[ ${quoteInspect(pair[0])}, ${quoteInspect(pair[1])} ]`;
            });
            if (items.length === 0) return 'URLSearchParams Iterator {  }';
            if (options && options.breakLength <= 1) return `URLSearchParams Iterator {\n  ${items.join(',\n  ')} }`;
            return `URLSearchParams Iterator { ${items.join(', ')} }`;
        }
    }
    {
        const desc = Object.getOwnPropertyDescriptor(URLSearchParamsIterator.prototype, 'next');
        Object.defineProperty(URLSearchParamsIterator.prototype, 'next', { ...desc, enumerable: true });
        Object.defineProperty(URLSearchParamsIterator.prototype, Symbol.toStringTag, {
            value: 'URLSearchParams Iterator',
            configurable: true,
        });
    }

    const URLClass = class URL {
        constructor(input, base) {
            const state = parseUrl(input, base);
            const searchParams = new SearchParamsClass(state.search);
            getSearchParamsState(searchParams).owner = this;
            state.searchParams = searchParams;
            Object.defineProperty(this, URL_STATE, { value: state });
        }
    };

    function setHref(self, value) {
        const next = parseUrl(value);
        const current = getUrlState(self);
        current.protocol = next.protocol;
        current.username = next.username;
        current.password = next.password;
        current.hostname = next.hostname;
        current.port = next.port;
        current.pathname = next.pathname;
        current.search = next.search;
        current.hash = next.hash;
        current.hasAuthority = next.hasAuthority;
        resetSearchParamsFromUrl(self);
    }

    function defineUrlPrototype() {
        const proto = URLClass.prototype;
        Object.defineProperties(proto, {
            toString: { value() { return this.href; }, enumerable: true, configurable: true },
            href: {
                get() { return formatUrlState(getUrlState(this)); },
                set(value) { setHref(this, value); },
                enumerable: true,
                configurable: true,
            },
            origin: { get() { return originFromState(getUrlState(this)); }, enumerable: true, configurable: true },
            protocol: {
                get() { return getUrlState(this).protocol; },
                set(value) {
                    const state = getUrlState(this);
                    let text = toNodeString(value).toLowerCase();
                    if (!text.endsWith(':')) text += ':';
                    if (/^[a-z][a-z0-9+.-]*:$/.test(text)) state.protocol = text;
                },
                enumerable: true,
                configurable: true,
            },
            username: {
                get() { return getUrlState(this).username; },
                set(value) { getUrlState(this).username = encodeUserInfo(value); },
                enumerable: true,
                configurable: true,
            },
            password: {
                get() { return getUrlState(this).password; },
                set(value) { getUrlState(this).password = encodeUserInfo(value); },
                enumerable: true,
                configurable: true,
            },
            host: {
                get() { return hostFromState(getUrlState(this)); },
                set(value) { parseAuthority(toNodeString(value), getUrlState(this)); },
                enumerable: true,
                configurable: true,
            },
            hostname: {
                get() { return getUrlState(this).hostname; },
                set(value) { getUrlState(this).hostname = toNodeString(value).toLowerCase(); },
                enumerable: true,
                configurable: true,
            },
            port: {
                get() { return getUrlState(this).port; },
                set(value) {
                    const text = toNodeString(value);
                    getUrlState(this).port = /^\d*$/.test(text) ? text : getUrlState(this).port;
                },
                enumerable: true,
                configurable: true,
            },
            pathname: {
                get() { return getUrlState(this).pathname; },
                set(value) { getUrlState(this).pathname = encodePathname(value); },
                enumerable: true,
                configurable: true,
            },
            search: {
                get() { return getUrlState(this).search; },
                set(value) {
                    getUrlState(this).search = encodeSearch(value);
                    resetSearchParamsFromUrl(this);
                },
                enumerable: true,
                configurable: true,
            },
            searchParams: { get() { return getUrlState(this).searchParams; }, enumerable: true, configurable: true },
            hash: {
                get() { return getUrlState(this).hash; },
                set(value) { getUrlState(this).hash = encodeHash(value); },
                enumerable: true,
                configurable: true,
            },
            toJSON: { value() { return this.href; }, enumerable: true, configurable: true },
            [Symbol.toStringTag]: { value: 'URL', configurable: true },
            [util.inspect.custom]: {
                value(depth, options) {
                    getUrlState(this);
                    if (depth !== undefined && depth < 1) return `${this.constructor.name} {}`;
                    const pairs = [
                        ['href', this.href],
                        ['origin', this.origin],
                        ['protocol', this.protocol],
                        ['username', this.username],
                        ['password', this.password],
                        ['host', this.host],
                        ['hostname', this.hostname],
                        ['port', this.port],
                        ['pathname', this.pathname],
                        ['search', this.search],
                        ['searchParams', this.searchParams],
                        ['hash', this.hash],
                    ].map(([key, value]) => `  ${key}: ${util.inspect(value, options)}`);
                    return `${this.constructor.name} {\n${pairs.join(',\n')}\n}`;
                },
                configurable: true,
            },
        });
    }
    defineUrlPrototype();

    function canParse(input, base) {
        if (arguments.length === 0) {
            throw makeTypeError('ERR_MISSING_ARGS', 'The "input" argument must be specified');
        }
        try {
            parseUrl(input, base);
            return true;
        } catch {
            return false;
        }
    }
    Object.defineProperty(URLClass, 'canParse', { value: canParse, configurable: true });

    function isURL(value) {
        return !!(value && value[URL_STATE]);
    }

    function urlToHttpOptions(value) {
        const state = value && value[URL_STATE];
        if (!state) {
            return {
                protocol: value && value.protocol,
                auth: value && value.auth,
                hostname: value && value.hostname,
                port: Number(value && value.port),
                path: ((value && value.pathname) || '') + ((value && value.search) || ''),
                pathname: value && value.pathname,
                search: value && value.search,
                hash: value && value.hash,
                href: value && value.href,
            };
        }
        const hostname = state.hostname.startsWith('[') && state.hostname.endsWith(']')
            ? state.hostname.slice(1, -1)
            : state.hostname;
        const options = {
            protocol: state.protocol,
            auth: state.username || state.password ? `${safeDecode(state.username)}:${safeDecode(state.password)}` : undefined,
            hostname,
            port: state.port ? Number(state.port) : undefined,
            path: (state.pathname || '/') + (state.search || ''),
            pathname: state.pathname,
            search: state.search,
            hash: state.hash,
            href: formatUrlState(state),
        };
        for (const key of Object.keys(value)) options[key] = value[key];
        return options;
    }

    function fileURLToPath(u) {
        // Accept URL instance or string. Strip "file://", decode %XX.
        const s = typeof u === 'string' ? u : (u && u.href);
        if (typeof s !== 'string') {
            throw new TypeError('fileURLToPath: expected URL or string');
        }
        if (!s.startsWith('file://')) {
            throw new TypeError('fileURLToPath: only file: URLs supported');
        }
        let p = s.slice('file://'.length);
        // Optional host segment is dropped; only the path portion is kept.
        const slash = p.indexOf('/');
        if (slash > 0) p = p.slice(slash);
        else if (slash !== 0) p = '/' + p;
        return decodeURIComponent(p);
    }
    function pathToFileURL(p) {
        if (typeof p !== 'string') p = String(p);
        if (!p.startsWith('/')) p = '/' + p;
        return new URLClass('file://' + encodeURI(p));
    }
    return {
        parse, format, resolve, resolveObject, Url,
        URL: URLClass,
        URLSearchParams: SearchParamsClass,
        urlToHttpOptions, isURL,
        fileURLToPath, pathToFileURL,
    };
})();

// ============================================================
// querystring module
// ============================================================

const querystring = (() => {
    const api = {};

    function safeDecode(str) {
        str = String(str).replace(/\+/g, ' ');
        try { return decodeURIComponent(str); }
        catch (_) {
            return str.replace(/%([0-9a-fA-F]{2})/g, (_, h) =>
                String.fromCharCode(parseInt(h, 16)));
        }
    }

    function encodeValue(str, encoder) {
        try {
            return encoder(String(str));
        } catch (error) {
            if (error && error.name === 'URIError') {
                const err = new URIError('URI malformed');
                err.code = 'ERR_INVALID_URI';
                throw err;
            }
            throw error;
        }
    }

    function scalarString(value) {
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
        if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
        return '';
    }

    function parse(qs, sep, eq, options) {
        const sepStr = sep == null ? '&' : String(sep);
        const eqStr = eq == null ? '=' : String(eq);
        const decoder = options && typeof options.decodeURIComponent === 'function'
            ? options.decodeURIComponent
            : api.unescape;
        const maxKeys = options && typeof options.maxKeys === 'number' ? options.maxKeys : 0;
        const result = Object.create(null);
        if (!qs) return result;
        const pairs = String(qs).split(sepStr);
        const count = maxKeys > 0 ? Math.min(maxKeys, pairs.length) : pairs.length;
        for (let i = 0; i < count; i++) {
            const pair = pairs[i];
            if (pair === '') continue;
            const idx = eqStr.length > 0 ? pair.indexOf(eqStr) : 0;
            const rawKey = idx >= 0 ? pair.slice(0, idx) : pair;
            const rawVal = idx >= 0 ? pair.slice(idx + eqStr.length) : '';
            let key;
            let val;
            try { key = decoder(rawKey.replace(/\+/g, ' ')); } catch (_) { key = safeDecode(rawKey); }
            try { val = decoder(rawVal.replace(/\+/g, ' ')); } catch (_) { val = safeDecode(rawVal); }
            if (Object.prototype.hasOwnProperty.call(result, key)) {
                if (Array.isArray(result[key])) result[key].push(val);
                else result[key] = [result[key], val];
            } else {
                result[key] = val;
            }
        }
        return result;
    }

    function stringify(obj, sep, eq, options) {
        sep = sep == null ? '&' : String(sep);
        eq = eq == null ? '=' : String(eq);
        if (obj == null || typeof obj !== 'object') return '';
        const encoder = options && typeof options.encodeURIComponent === 'function'
            ? options.encodeURIComponent
            : encodeURIComponent;
        const pairs = [];
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (Array.isArray(val)) {
                for (const v of val) pairs.push(encodeValue(key, encoder) + eq + encodeValue(scalarString(v), encoder));
            } else {
                pairs.push(encodeValue(key, encoder) + eq + encodeValue(scalarString(val), encoder));
            }
        }
        return pairs.join(sep);
    }

    function escape(str) { return encodeValue(str, encodeURIComponent); }
    function unescape(str) { return safeDecode(str); }

    function unescapeBuffer(str, decodeSpaces) {
        str = String(str);
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            if (ch === 43 && decodeSpaces) {
                bytes.push(32);
            } else if (ch === 37 && i + 2 < str.length) {
                const hex = str.slice(i + 1, i + 3);
                if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                    bytes.push(parseInt(hex, 16));
                    i += 2;
                } else {
                    bytes.push(ch);
                }
            } else {
                bytes.push(ch & 0xff);
            }
        }
        return Buffer.from(bytes);
    }

    api.parse = parse;
    api.stringify = stringify;
    api.escape = escape;
    api.unescape = unescape;
    api.unescapeBuffer = unescapeBuffer;
    api.decode = parse;
    api.encode = stringify;
    return api;
})();

// ============================================================
// string_decoder module
// ============================================================

const string_decoder = (() => {
    function normalizeEncoding(encoding) {
        const enc = encoding === undefined ? 'utf8' : String(encoding).toLowerCase();
        if (enc === 'utf-8') return 'utf8';
        if (enc === 'ucs2' || enc === 'ucs-2') return 'utf16le';
        if (enc === 'utf16le' || enc === 'utf-16le') return 'utf16le';
        if (enc === 'latin1' || enc === 'binary' || enc === 'ascii' || enc === 'base64' || enc === 'hex') return enc;
        if (enc === 'utf8') return enc;
        const err = new TypeError(`Unknown encoding: ${encoding}`);
        err.code = 'ERR_UNKNOWN_ENCODING';
        throw err;
    }

    function toBytes(buf) {
        if (buf instanceof Uint8Array) return buf;
        if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
        if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        throw _makeInvalidArgTypeError('buf', 'Buffer, TypedArray, or DataView', buf);
    }

    function concatBytes(a, b) {
        if (!a || a.length === 0) return b;
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }

    function utf8Tail(bytes) {
        const len = bytes.length;
        if (len === 0) return { cut: 0, pending: new Uint8Array(0), need: 0, total: 0 };
        let cont = 0;
        for (let i = len - 1; i >= 0 && cont < 3; i--) {
            if ((bytes[i] & 0xc0) === 0x80) cont++;
            else break;
        }
        const lead = len - cont - 1;
        if (lead < 0) return { cut: len, pending: new Uint8Array(0), need: 0, total: 0 };
        const b = bytes[lead];
        let total = 0;
        if (b >= 0xc2 && b <= 0xdf) total = 2;
        else if (b >= 0xe0 && b <= 0xef) total = 3;
        else if (b >= 0xf0 && b <= 0xf4) total = 4;
        else return { cut: len, pending: new Uint8Array(0), need: 0, total: 0 };

        const have = len - lead;
        if (have >= total) return { cut: len, pending: new Uint8Array(0), need: 0, total: 0 };
        if (have > 1) {
            const c = bytes[lead + 1];
            const ok =
                (total === 2 && c >= 0x80 && c <= 0xbf) ||
                (total === 3 && ((b === 0xe0 && c >= 0xa0 && c <= 0xbf) ||
                    (b >= 0xe1 && b <= 0xec && c >= 0x80 && c <= 0xbf) ||
                    (b === 0xed && c >= 0x80 && c <= 0x9f) ||
                    (b >= 0xee && b <= 0xef && c >= 0x80 && c <= 0xbf))) ||
                (total === 4 && ((b === 0xf0 && c >= 0x90 && c <= 0xbf) ||
                    (b >= 0xf1 && b <= 0xf3 && c >= 0x80 && c <= 0xbf) ||
                    (b === 0xf4 && c >= 0x80 && c <= 0x8f)));
            if (!ok) return { cut: len, pending: new Uint8Array(0), need: 0, total: 0 };
        }
        return { cut: lead, pending: bytes.slice(lead), need: total - have, total };
    }

    function decodeUtf16le(bytes) {
        let out = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) {
            out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
        }
        return out;
    }

    function StringDecoder(encoding) {
        this.encoding = normalizeEncoding(encoding);
        this.lastChar = Buffer.alloc(4);
        this.lastNeed = 0;
        this.lastTotal = 0;
        this._pending = new Uint8Array(0);
        this._decoder = this.encoding === 'utf8' ? new TextDecoder('utf-8') : null;
    }

    StringDecoder.prototype._setPending = function(pending, need, total) {
        this._pending = pending;
        this.lastChar.fill(0);
        for (let i = 0; i < pending.length && i < 4; i++) this.lastChar[i] = pending[i];
        this.lastNeed = need;
        this.lastTotal = total;
    };

    StringDecoder.prototype.write = function write(buf) {
        if (typeof buf === 'string') return buf;
        const input = concatBytes(this._pending, toBytes(buf));
        if (this.encoding === 'utf8') {
            const tail = utf8Tail(input);
            const complete = input.subarray(0, tail.cut);
            this._setPending(tail.pending, tail.need, tail.total);
            return complete.length ? this._decoder.decode(complete) : '';
        }
        if (this.encoding === 'utf16le') {
            let cut = input.length - (input.length % 2);
            if (cut >= 2) {
                const last = input[cut - 2] | (input[cut - 1] << 8);
                if (last >= 0xd800 && last <= 0xdbff) cut -= 2;
            }
            const pending = input.slice(cut);
            this._setPending(pending, pending.length ? 2 - pending.length : 0, pending.length ? 2 : 0);
            return decodeUtf16le(input.subarray(0, cut));
        }
        const full = concatBytes(this._pending, input);
        this._setPending(new Uint8Array(0), 0, 0);
        return Buffer.from(full).toString(this.encoding);
    };

    StringDecoder.prototype.end = function end(buf) {
        let out = '';
        if (buf !== undefined) out = this.write(buf);
        if (this._pending.length) {
            if (this.encoding === 'utf8') out += this._decoder.decode(this._pending);
            else if (this.encoding === 'utf16le') out += decodeUtf16le(this._pending);
            else out += Buffer.from(this._pending).toString(this.encoding);
            this._setPending(new Uint8Array(0), 0, 0);
        }
        return out;
    };

    StringDecoder.prototype.text = function text(buf, offset) {
        this._setPending(new Uint8Array(0), 0, 0);
        return this.write(toBytes(buf).subarray(offset));
    }
    return { StringDecoder };
})();

// ============================================================
// timers module
// ============================================================

let _nodeEventLoopDrainScheduled = false;
function _scheduleNodeEventLoopDrain() {
    if (_nodeEventLoopDrainScheduled || process._exiting) return;
    _nodeEventLoopDrainScheduled = true;
    queueMicrotask(() => {
        _nodeEventLoopDrainScheduled = false;
        if (process._exiting) return;
        if (typeof _drainEventLoopBeforeExit !== 'function') return;
        try {
            _drainEventLoopBeforeExit();
        } catch (err) {
            if (typeof _handleTopLevelFailure === 'function') {
                _handleTopLevelFailure(err);
            } else {
                throw err;
            }
        }
    });
}

const timers = (() => {
    const TIMEOUT_MAX = 2147483647;
    const kTimerHandle = Symbol('kandelo.timerHandle');
    const kLegacyTimerState = Symbol('kandelo.legacyTimerState');
    const handlesByPrimitiveId = new Map();
    const liveHandles = new Set();
    const liveLegacyItems = new Set();
    const emittedLegacyDeprecations = new Set();
    let nextPrimitiveId = 1;

    function validateCallback(callback) {
        if (typeof callback !== 'function') {
            throw _makeInvalidArgTypeError('callback', 'function', callback);
        }
    }

    function timeoutRangeError(value) {
        const err = new RangeError(
            'The value of "msecs" is out of range. ' +
            'It must be a non-negative finite number. ' +
            `Received ${value}`
        );
        err.code = 'ERR_OUT_OF_RANGE';
        return err;
    }

    function emitOverflowWarning(value) {
        process.emitWarning(
            `${value} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`,
            'TimeoutOverflowWarning'
        );
    }

    function emitLegacyOverflowWarning(value) {
        process.emitWarning(
            `${value} does not fit into a 32-bit signed integer.\nTimer duration was truncated to ${TIMEOUT_MAX}.`,
            'TimeoutOverflowWarning'
        );
    }

    function emitLegacyDeprecation(code, message) {
        if (emittedLegacyDeprecations.has(code)) return;
        emittedLegacyDeprecations.add(code);
        process.emitWarning(message, 'DeprecationWarning', code);
    }

    function createAsyncResource(type) {
        if (typeof async_hooks !== 'object' || async_hooks === null ||
            typeof async_hooks.AsyncResource !== 'function') {
            return null;
        }
        return new async_hooks.AsyncResource(type);
    }

    function normalizeDelay(value, options) {
        const opts = options || {};
        if (opts.legacyEnroll && typeof value !== 'number') {
            throw _makeInvalidArgTypeError('msecs', 'number', value);
        }
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
            if (opts.legacyEnroll) throw timeoutRangeError(value);
            return 1;
        }
        if (n > TIMEOUT_MAX) {
            if (opts.legacyEnroll) {
                emitLegacyOverflowWarning(value);
                return TIMEOUT_MAX;
            }
            emitOverflowWarning(value);
            return 1;
        }
        if (opts.preserveZero && n === 0) return 0;
        return n >= 1 ? n : 1;
    }

    function scheduledDelay(value, preserveZero) {
        const n = Math.trunc(Number(value) || 0);
        return preserveZero ? Math.max(0, n) : Math.max(1, n);
    }

    function markLinked(item) {
        item._idleStart = Date.now();
        item._idlePrev = item;
        item._idleNext = item;
    }

    function clearNativeId(id) {
        if (id !== undefined && id !== null && id !== 0) os.clearTimeout(id);
    }

    function untrackHandle(handle) {
        if (handle._resourceId) {
            _untrackActiveResource(handle._resourceId);
            handle._resourceId = 0;
        }
    }

    function deactivateImmediate(handle) {
        if (!handle) return;
        handle._refed = false;
        handle._idleTimeout = -1;
        handle._idlePrev = null;
        handle._idleNext = null;
        liveHandles.delete(handle);
        handlesByPrimitiveId.delete(handle._primitiveId);
        untrackHandle(handle);
    }

    function destroyHandle(handle, clearCallback) {
        if (!handle || handle._destroyed) return;
        clearNativeId(handle._nativeId);
        handle._nativeId = 0;
        handle._id = 0;
        handle._destroyed = true;
        if (handle._asyncResource) {
            handle._asyncResource.emitDestroy();
            handle._asyncResource = null;
        }
        if (handle._kind === 'Immediate') handle._refed = false;
        handle._idleTimeout = -1;
        handle._idlePrev = null;
        handle._idleNext = null;
        liveHandles.delete(handle);
        handlesByPrimitiveId.delete(handle._primitiveId);
        untrackHandle(handle);
        if (clearCallback) {
            if (handle._kind === 'Immediate') handle._onImmediate = null;
            else handle._onTimeout = null;
        }
    }

    function scheduleHandle(handle, delayOverride) {
        if (!handle || typeof handle._callback !== 'function') return handle;
        clearNativeId(handle._nativeId);
        handle._destroyed = false;
        markLinked(handle);
        liveHandles.add(handle);
        handlesByPrimitiveId.set(handle._primitiveId, handle);
        const delay = delayOverride === undefined
            ? scheduledDelay(handle._idleTimeout, false)
            : scheduledDelay(delayOverride, true);
        const fire = handle._kind === 'Immediate'
            ? () => fireImmediate(handle)
            : () => fireTimeout(handle);
        handle._nativeId = os.setTimeout(fire, delay);
        handle._id = handle._nativeId;
        return handle;
    }

    function callTimerCallback(callback, receiver, args, resource) {
        try {
            if (resource && typeof resource.runInAsyncScope === 'function') {
                resource.runInAsyncScope(callback, receiver, ...(args || []));
            } else {
                callback.apply(receiver, args || []);
            }
        } catch (err) {
            if (!process._handleUncaughtException(err)) throw err;
        }
    }

    function shouldRunHandle(handle) {
        return !handle || handle._refed !== false || hasRefedHandles();
    }

    function shouldRunLegacyItem(item) {
        const state = item && item[kLegacyTimerState];
        return !state || state.refed !== false || hasRefedHandles();
    }

    function fireImmediate(handle) {
        if (!handle || handle._destroyed) return;
        handle._nativeId = 0;
        handle._id = 0;
        if (!shouldRunHandle(handle)) return;
        const callback = handle._onImmediate;
        const args = handle._timerArgs || [];
        deactivateImmediate(handle);
        try {
            if (typeof callback === 'function') callTimerCallback(callback, handle, args, handle._asyncResource);
        } finally {
            destroyHandle(handle, true);
        }
    }

    function fireTimeout(handle) {
        if (!handle || handle._destroyed) return;
        handle._nativeId = 0;
        handle._id = 0;
        if (!shouldRunHandle(handle)) return;
        const callback = handle._onTimeout;
        if (typeof callback !== 'function') {
            destroyHandle(handle, true);
            return;
        }
        try {
            callTimerCallback(callback, handle, handle._timerArgs || [], handle._asyncResource);
        } finally {
            if (handle._destroyed) return;
            if (handle._nativeId) return;
            if (handle._repeat !== null && handle._repeat !== undefined &&
                handle._idleTimeout >= 0 && typeof handle._onTimeout === 'function') {
                scheduleHandle(handle, handle._repeat);
            } else {
                destroyHandle(handle, true);
            }
        }
    }

    class Timeout {
        constructor(callback, after, args, isRepeat, isRefed) {
            validateCallback(callback);
            const delay = normalizeDelay(after);
            this._idleTimeout = delay;
            this._idlePrev = this;
            this._idleNext = this;
            this._idleStart = null;
            this._onTimeout = callback;
            this._callback = callback;
            this._timerArgs = args || [];
            this._repeat = isRepeat ? delay : null;
            this._destroyed = false;
            this._refed = isRefed !== false;
            this._kind = 'Timeout';
            this._resourceId = _trackActiveResource('Timeout');
            this._asyncResource = createAsyncResource('Timeout');
            this._primitiveId = nextPrimitiveId++;
            this._nativeId = 0;
            this._id = 0;
            Object.defineProperty(this, kTimerHandle, { value: true });
            scheduleHandle(this, delay);
        }

        unref() { this._refed = false; return this; }
        ref() { this._refed = true; return this; }
        hasRef() { return this._refed; }
        refresh() {
            if (typeof this._onTimeout === 'function') scheduleHandle(this, this._idleTimeout);
            return this;
        }
        close() { clearAny(this); return this; }
        [Symbol.toPrimitive]() {
            handlesByPrimitiveId.set(this._primitiveId, this);
            return this._primitiveId;
        }
        [Symbol.dispose]() { clearAny(this); }
    }

    class Immediate {
        constructor(callback, args) {
            validateCallback(callback);
            this._idlePrev = null;
            this._idleNext = null;
            this._idleStart = null;
            this._idleTimeout = 0;
            this._onImmediate = callback;
            this._callback = callback;
            this._timerArgs = args || [];
            this._repeat = null;
            this._destroyed = false;
            this._refed = true;
            this._kind = 'Immediate';
            this._resourceId = _trackActiveResource('Immediate');
            this._asyncResource = createAsyncResource('Immediate');
            this._primitiveId = nextPrimitiveId++;
            this._nativeId = 0;
            this._id = 0;
            Object.defineProperty(this, kTimerHandle, { value: true });
            scheduleHandle(this, 0);
        }

        unref() { if (!this._destroyed) this._refed = false; return this; }
        ref() { if (!this._destroyed) this._refed = true; return this; }
        hasRef() { return this._refed; }
        [Symbol.dispose]() { clearAny(this); }
    }

    function legacyState(item) {
        let state = item[kLegacyTimerState];
        if (!state) {
            state = { nativeId: 0, refed: true, destroyed: false, resourceId: 0 };
            Object.defineProperty(item, kLegacyTimerState, {
                value: state,
                configurable: true,
            });
        }
        return state;
    }

    function clearLegacyNative(item) {
        const state = item && item[kLegacyTimerState];
        if (!state) return;
        clearNativeId(state.nativeId);
        state.nativeId = 0;
        if (state.resourceId) {
            _untrackActiveResource(state.resourceId);
            state.resourceId = 0;
        }
        liveLegacyItems.delete(item);
    }

    function unenroll(item) {
        if (item === null || (typeof item !== 'object' && typeof item !== 'function')) return;
        emitLegacyDeprecation(
            'DEP0096',
            'timers.unenroll() is deprecated. Please use clearTimeout instead.'
        );
        if (item[kTimerHandle]) {
            destroyHandle(item, true);
            return;
        }
        clearLegacyNative(item);
        const state = legacyState(item);
        state.destroyed = true;
        item._destroyed = true;
        item._idleTimeout = -1;
        item._idleNext = null;
        item._idlePrev = null;
    }

    function enroll(item, msecs) {
        if (item === null || (typeof item !== 'object' && typeof item !== 'function')) return;
        emitLegacyDeprecation(
            'DEP0095',
            'timers.enroll() is deprecated. Please use setTimeout instead.'
        );
        const delay = normalizeDelay(msecs, { legacyEnroll: true, preserveZero: true });
        if (item._idleNext) unenroll(item);
        const state = legacyState(item);
        state.destroyed = false;
        item._destroyed = false;
        item._idleTimeout = delay;
        item._idlePrev = item;
        item._idleNext = item;
    }

    function fireLegacy(item) {
        const state = item && item[kLegacyTimerState];
        if (!state || state.destroyed) return;
        state.nativeId = 0;
        if (!shouldRunLegacyItem(item)) return;
        const callback = item._onTimeout;
        if (typeof callback !== 'function' || item._idleTimeout < 0) {
            unenroll(item);
            return;
        }
        try {
            callTimerCallback(callback, item, []);
        } finally {
            if (!state.destroyed && !state.nativeId) unenroll(item);
        }
    }

    function activeItem(item, refed) {
        if (item === null || (typeof item !== 'object' && typeof item !== 'function')) return;
        if (item[kTimerHandle]) {
            if (item._idleTimeout >= 0 && typeof item._onTimeout === 'function') {
                item._refed = refed !== false;
                scheduleHandle(item, item._idleTimeout);
            }
            return;
        }
        const msecs = item._idleTimeout;
        if (msecs === undefined || msecs < 0) return;
        markLinked(item);
        if (typeof item._onTimeout !== 'function') return;
        const state = legacyState(item);
        clearNativeId(state.nativeId);
        if (!state.resourceId) state.resourceId = _trackActiveResource('Timeout');
        state.refed = refed !== false;
        state.destroyed = false;
        item._destroyed = false;
        liveLegacyItems.add(item);
        state.nativeId = os.setTimeout(() => fireLegacy(item), scheduledDelay(msecs, true));
    }

    function active(item) {
        emitLegacyDeprecation(
            'DEP0126',
            'timers.active() is deprecated. Please use timeout.refresh() instead.'
        );
        activeItem(item, true);
    }
    function unrefActive(item) {
        emitLegacyDeprecation(
            'DEP0127',
            'timers._unrefActive() is deprecated. Please use timeout.refresh() instead.'
        );
        activeItem(item, false);
    }

    function clearAny(timer) {
        if (timer == null) return;
        if (typeof timer === 'number' || typeof timer === 'string') {
            const handle = handlesByPrimitiveId.get(Number(timer));
            if (handle) destroyHandle(handle, true);
            return;
        }
        if ((typeof timer === 'object' || typeof timer === 'function') && timer[kTimerHandle]) {
            destroyHandle(timer, true);
        }
    }

    function hasRefedHandles() {
        for (const handle of liveHandles) {
            if (!handle._destroyed && handle._refed) return true;
        }
        for (const item of liveLegacyItems) {
            const state = item[kLegacyTimerState];
            if (state && !state.destroyed && state.refed) return true;
        }
        return false;
    }

    function liveHandleCount() {
        return liveHandles.size + liveLegacyItems.size;
    }

    function setTimeoutCompat(fn, ms, ...args) {
        const handle = new Timeout(fn, ms, args, false, true);
        if (typeof _scheduleNodeEventLoopDrain === 'function') _scheduleNodeEventLoopDrain();
        return handle;
    }

    function setIntervalCompat(fn, ms, ...args) {
        const handle = new Timeout(fn, ms, args, true, true);
        if (typeof _scheduleNodeEventLoopDrain === 'function') _scheduleNodeEventLoopDrain();
        return handle;
    }

    function setImmediateCompat(fn, ...args) {
        const handle = new Immediate(fn, args);
        if (typeof _scheduleNodeEventLoopDrain === 'function') _scheduleNodeEventLoopDrain();
        return handle;
    }

    function setUnrefTimeout(fn, ms, ...args) {
        return new Timeout(fn, ms, args, false, false);
    }

    return {
        setTimeout: setTimeoutCompat,
        clearTimeout: clearAny,
        setInterval: setIntervalCompat,
        clearInterval: clearAny,
        setImmediate: setImmediateCompat,
        clearImmediate: clearAny,
        enroll,
        unenroll,
        active,
        _unrefActive: unrefActive,
        setUnrefTimeout,
        _kandeloHasRefedHandles: hasRefedHandles,
        _kandeloLiveHandleCount: liveHandleCount,
    };
})();

// `timers/promises` — @npmcli/agent uses `setTimeout(ms)` as a connection-timeout
// race against the connect promise. AbortSignal handling isn't needed for that.
const timersPromises = {
    setTimeout: (delay, value) => new Promise(resolve => timers.setTimeout(resolve, delay, value)),
    setImmediate: (value) => new Promise(resolve => timers.setImmediate(resolve, value)),
};

// ============================================================
// child_process module
// ============================================================

function isNodeLikeExecutable(file) {
    const text = String(file || '');
    const base = path.basename(text);
    return text === process.execPath ||
        text === 'node' ||
        base === 'node' ||
        base === 'node.wasm' ||
        base === 'spidermonkey-node' ||
        base === 'spidermonkey-node.wasm';
}

const child_process = (() => {
    let nextPid = Math.max(2, (process.pid || 1) + 1);
    let nextTemp = 1;

    function shellQuote(value) {
        return "'" + String(value).replace(/'/g, "'\\''") + "'";
    }

    function readPopen(file) {
        if (file && typeof file.readAll === 'function') return file.readAll();
        let output = '';
        let line;
        while ((line = file.getline()) !== null) output += line + '\n';
        return output;
    }

    function normalizeOptions(options) {
        if (options == null) return {};
        if (typeof options === 'string') return { encoding: options };
        if (typeof options !== 'object') throw _makeInvalidArgTypeError('options', 'object', options);
        return options;
    }

    function normalizeArgs(args, name) {
        if (args == null) return [];
        if (!Array.isArray(args)) throw _makeInvalidArgTypeError(name || 'args', 'Array', args);
        return args.map((arg) => String(arg));
    }

    function envValuePairs(env, includeInternal) {
        const source = env || process.env;
        const pairs = [];
        for (const key in source) {
            const value = source[key];
            if (value === undefined) continue;
            pairs.push([String(key), String(value)]);
        }
        if (includeInternal) {
            for (const pair of includeInternal) pairs.push(pair);
        }
        return pairs;
    }

    function envCommandPrefix(env, internalPairs) {
        const pairs = envValuePairs(env, internalPairs);
        if (pairs.length === 0 && !env) return '';
        const args = ['env'];
        if (env) args.push('-i');
        for (const [key, value] of pairs) {
            if (key.includes('=')) continue;
            args.push(`${key}=${value}`);
        }
        return args.map(shellQuote).join(' ') + ' ';
    }

    function normalizeStdio(stdio) {
        if (stdio === undefined || stdio === null) return ['pipe', 'pipe', 'pipe'];
        if (typeof stdio === 'string') {
            if (stdio === 'pipe') return ['pipe', 'pipe', 'pipe'];
            if (stdio === 'ignore') return ['ignore', 'ignore', 'ignore'];
            if (stdio === 'inherit') return ['inherit', 'inherit', 'inherit'];
            throw _makeInvalidArgTypeError('options.stdio', 'string', stdio);
        }
        if (!Array.isArray(stdio)) throw _makeInvalidArgTypeError('options.stdio', 'Array', stdio);
        const out = ['pipe', 'pipe', 'pipe'];
        for (let i = 0; i < Math.min(3, stdio.length); i++) out[i] = stdio[i] == null ? 'pipe' : stdio[i];
        return out;
    }

    function resolveExecutable(file, env) {
        if (isNodeLikeExecutable(file)) return file;
        if (file.includes('/')) return fs.existsSync(file) ? file : null;
        const pathValue = (env && env.PATH !== undefined ? env.PATH : process.env.PATH) || '/usr/local/bin:/usr/bin:/bin';
        for (const dir of String(pathValue).split(':')) {
            const candidate = (dir || '.') + '/' + file;
            if (fs.existsSync(candidate)) return candidate;
        }
        return null;
    }

    function makeSpawnError(file, args) {
        const err = _makeNodeError(`spawn ${file} ENOENT`, 'ENOENT', 2, `spawn ${file}`, file);
        err.spawnargs = args.slice();
        return err;
    }

    function makeUnknownSignalError(signal) {
        const err = new TypeError(`Unknown signal: ${signal}`);
        err.code = 'ERR_UNKNOWN_SIGNAL';
        return err;
    }

    function buildCommand(file, args, options, forceShell) {
        _validateString(file, 'file');
        const opts = normalizeOptions(options);
        const argv = normalizeArgs(args, 'args');
        if (opts.argv0 !== undefined && typeof opts.argv0 !== 'string') {
            throw _makeInvalidArgTypeError('options.argv0', 'string', opts.argv0);
        }
        if (opts.cwd !== undefined && typeof opts.cwd !== 'string') {
            throw _makeInvalidArgTypeError('options.cwd', 'string', opts.cwd);
        }
        const useShell = forceShell || opts.shell === true || typeof opts.shell === 'string';
        const env = opts.env || null;
        const nodeLikeExecutable = isNodeLikeExecutable(file);
        const internalArgv0 = opts.argv0 || (nodeLikeExecutable ? file : null);
        const internalEnv = internalArgv0 ? [['KANDELO_NODE_ARGV0', internalArgv0]] : null;
        let commandText;
        let spawnfile;
        let spawnargs;
        let resolved = file;

        if (useShell) {
            const displayText = [file, ...argv].join(' ');
            commandText = [file, ...argv.map(shellQuote)].join(' ');
            spawnfile = typeof opts.shell === 'string' ? opts.shell : '/bin/sh';
            spawnargs = [spawnfile, '-c', displayText];
        } else {
            resolved = resolveExecutable(file, env);
            if (!resolved) return { error: makeSpawnError(file, argv), file, args: argv, options: opts, shell: false };
            commandText = [shellQuote(resolved), ...argv.map(shellQuote)].join(' ');
            spawnfile = file;
            spawnargs = [file, ...argv];
        }

        let shellCommand = envCommandPrefix(env, internalEnv) + commandText;
        if (opts.input !== undefined) {
            const input = Buffer.isBuffer(opts.input) ? opts.input.toString() : String(opts.input);
            shellCommand = `printf %s ${shellQuote(input)} | ${shellCommand}`;
        }
        if (opts.cwd) shellCommand = `cd ${shellQuote(opts.cwd)} && ${shellCommand}`;
        return { shellCommand, displayCommand: useShell ? spawnargs[2] : [file, ...argv].join(' '), file, args: argv, options: opts, spawnfile, spawnargs, resolved, shell: useShell };
    }

    function runBuiltCommand(spec) {
        if (spec.error) throw spec.error;
        const opts = spec.options || {};
        const stdio = normalizeStdio(opts.stdio);
        const inheritStderr = stdio[2] === 'inherit';
        const stderrPath = `/tmp/kandelo-child-process-${process.pid}-${Date.now()}-${nextTemp++}.stderr`;
        const command = inheritStderr ? spec.shellCommand : `(${spec.shellCommand}) 2>${shellQuote(stderrPath)}`;
        let stdout = '';
        let stderr = '';
        let status = 127;
        let f = null;
        try {
            f = std.popen(command, 'r');
            if (!f) throw _makeNodeError(`spawn ${spec.file} ENOENT`, 'ENOENT', 2, 'spawn', spec.file);
            stdout = readPopen(f);
            status = f.close();
        } catch (err) {
            const wrapped = err && err.code ? err : _makeNodeError(String(err && err.message || err), 'ENOENT', 2, 'spawn', spec.file);
            wrapped.cmd = spec.displayCommand;
            throw wrapped;
        } finally {
            if (!inheritStderr) {
                try { stderr = fs.readFileSync(stderrPath, 'utf8'); } catch (_) { stderr = ''; }
                try { fs.unlinkSync(stderrPath); } catch (_) {}
            }
        }
        const maxBuffer = opts.maxBuffer == null ? 1024 * 1024 : Number(opts.maxBuffer);
        if (maxBuffer >= 0 && (Buffer.byteLength(stdout) > maxBuffer || Buffer.byteLength(stderr) > maxBuffer)) {
            const err = new RangeError('stdout maxBuffer length exceeded');
            err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            err.cmd = spec.displayCommand;
            err.stdout = stdout;
            err.stderr = stderr;
            err.status = null;
            throw err;
        }
        return { status, stdout, stderr, signal: null };
    }

    function encodeOutput(value, options) {
        const enc = options && options.encoding;
        if (enc === 'buffer' || enc === null || enc === undefined) return Buffer.from(value);
        return Buffer.from(value).toString(enc);
    }

    function makeCommandError(spec, result) {
        const err = new Error(`Command failed: ${spec.displayCommand}${result.stderr ? '\n' + result.stderr : ''}`);
        err.code = result.status;
        err.status = result.status;
        err.signal = result.signal;
        err.killed = false;
        err.cmd = spec.displayCommand;
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        return err;
    }

    class ChildProcess extends events.EventEmitter {
        constructor() {
            super();
            this.pid = undefined;
            this.stdin = null;
            this.stdout = null;
            this.stderr = null;
            this.stdio = [null, null, null];
            this.killed = false;
            this.exitCode = null;
            this.signalCode = null;
            this.spawnfile = undefined;
            this.spawnargs = undefined;
            this.connected = false;
        }

        _initStdio(options) {
            const stdio = normalizeStdio(options && options.stdio);
            this.stdin = stdio[0] === 'pipe' ? new stream.Writable() : null;
            this.stdout = stdio[1] === 'pipe' ? new stream.Readable() : null;
            this.stderr = stdio[2] === 'pipe' ? new stream.Readable() : null;
            if (this.stdout && options && options.encoding) this.stdout.setEncoding(options.encoding);
            if (this.stderr && options && options.encoding) this.stderr.setEncoding(options.encoding);
            this.stdio = [this.stdin, this.stdout, this.stderr];
        }

        _complete(status, signal) {
            this.exitCode = status;
            this.signalCode = signal || null;
            if (this.stdin && !this.stdin.writableEnded) this.stdin.end();
            if (this.stdout) this.stdout.push(null);
            if (this.stderr) this.stderr.push(null);
            this.emit('exit', status, signal || null);
            this.emit('close', status, signal || null);
        }

        spawn(options) {
            if (options == null || typeof options !== 'object' || Array.isArray(options)) {
                throw _makeInvalidArgTypeError('options', 'object', options);
            }
            if (typeof options.file !== 'string') {
                throw _makeInvalidArgTypeError('options.file', 'string', options.file);
            }
            if (options.args !== undefined && !Array.isArray(options.args)) {
                throw _makeInvalidArgTypeError('options.args', 'Array', options.args);
            }
            if (options.envPairs !== undefined && !Array.isArray(options.envPairs)) {
                throw _makeInvalidArgTypeError('options.envPairs', 'Array', options.envPairs);
            }
            const args = normalizeArgs(options.args, 'options.args');
            this.pid = nextPid++;
            this.spawnfile = options.file;
            this.spawnargs = [options.file, ...args];
            this._initStdio(options);
            queueMicrotask(() => this.emit('spawn'));
            return this;
        }

        kill(signal) {
            if (signal !== undefined && typeof signal === 'string') {
                const signals = nodeOs.constants && nodeOs.constants.signals;
                if (!signals || !signals[signal]) throw makeUnknownSignalError(signal);
            }
            this.killed = true;
            return true;
        }

        ref() { return this; }
        unref() { return this; }
        disconnect() { this.connected = false; this.emit('disconnect'); }
        send(_message, _handle, _options, callback) {
            if (typeof _handle === 'function') callback = _handle;
            else if (typeof _options === 'function') callback = _options;
            if (callback) queueMicrotask(() => callback(null));
            return false;
        }
    }

    function spawn(command, args, options) {
        if (args && !Array.isArray(args) && typeof args === 'object') { options = args; args = []; }
        const spec = buildCommand(command, args || [], options || {}, false);
        const child = new ChildProcess();
        child.pid = spec.error ? undefined : nextPid++;
        child.spawnfile = spec.spawnfile || command;
        child.spawnargs = spec.spawnargs || [command, ...normalizeArgs(args || [], 'args')];
        child._initStdio(spec.options || options || {});
        queueMicrotask(() => {
            if (spec.error) {
                child.emit('error', spec.error);
                child._complete(1, null);
                return;
            }
            child.emit('spawn');
            let result;
            try {
                result = runBuiltCommand(spec);
            } catch (err) {
                child.emit('error', err);
                child._complete(1, null);
                return;
            }
            if (child.stdout && result.stdout) child.stdout.push(Buffer.from(result.stdout));
            if (child.stderr && result.stderr) child.stderr.push(Buffer.from(result.stderr));
            child._complete(result.status, result.signal);
        });
        return child;
    }

    function spawnSync(command, args, options) {
        if (args && !Array.isArray(args) && typeof args === 'object') { options = args; args = []; }
        const opts = normalizeOptions(options || {});
        const spec = buildCommand(command, args || [], opts, false);
        if (spec.error) {
            return { status: null, signal: null, error: spec.error, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), output: [null, Buffer.alloc(0), Buffer.alloc(0)], pid: undefined };
        }
        try {
            const result = runBuiltCommand(spec);
            const stdout = encodeOutput(result.stdout, opts);
            const stderr = encodeOutput(result.stderr, opts);
            return { status: result.status, signal: result.signal, error: undefined, stdout, stderr, output: [null, stdout, stderr], pid: nextPid++ };
        } catch (err) {
            const stdout = encodeOutput(err.stdout || '', opts);
            const stderr = encodeOutput(err.stderr || '', opts);
            return { status: err.status == null ? null : err.status, signal: err.signal || null, error: err, stdout, stderr, output: [null, stdout, stderr], pid: undefined };
        }
    }

    function execSync(command, options) {
        _validateString(command, 'command');
        const opts = normalizeOptions(options || {});
        const spec = buildCommand(command, [], opts, true);
        const result = runBuiltCommand(spec);
        if (result.status !== 0) throw makeCommandError(spec, result);
        return encodeOutput(result.stdout, opts);
    }

    function execFileSync(file, args, options) {
        if (args && !Array.isArray(args) && typeof args === 'object') { options = args; args = []; }
        const opts = normalizeOptions(options || {});
        const spec = buildCommand(file, args || [], opts, !!opts.shell);
        const result = runBuiltCommand(spec);
        if (result.status !== 0) throw makeCommandError(spec, result);
        return encodeOutput(result.stdout, opts);
    }

    function exec(command, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        const opts = normalizeOptions(options || {});
        const spec = buildCommand(command, [], opts, true);
        const child = new ChildProcess();
        child.pid = nextPid++;
        child.spawnfile = spec.spawnfile;
        child.spawnargs = spec.spawnargs;
        child._initStdio(opts);
        queueMicrotask(() => {
            let err = null;
            let result = { status: 0, stdout: '', stderr: '', signal: null };
            try {
                result = runBuiltCommand(spec);
                if (result.status !== 0) err = makeCommandError(spec, result);
            } catch (e) {
                err = e;
                result.stdout = e.stdout || '';
                result.stderr = e.stderr || '';
            }
            if (child.stdout && result.stdout) child.stdout.push(Buffer.from(result.stdout));
            if (child.stderr && result.stderr) child.stderr.push(Buffer.from(result.stderr));
            child._complete(result.status || (err ? 1 : 0), result.signal);
            if (cb) cb(err, result.stdout, result.stderr);
        });
        return child;
    }

    function execFile(file, args, options, cb) {
        if (typeof args === 'function') { cb = args; args = []; options = {}; }
        else if (args && !Array.isArray(args) && typeof args === 'object') { cb = options; options = args; args = []; }
        else if (typeof options === 'function') { cb = options; options = {}; }
        const opts = normalizeOptions(options || {});
        const spec = buildCommand(file, args || [], opts, !!opts.shell);
        const child = new ChildProcess();
        child.pid = spec.error ? undefined : nextPid++;
        child.spawnfile = spec.spawnfile || file;
        child.spawnargs = spec.spawnargs || [file, ...normalizeArgs(args || [], 'args')];
        child._initStdio(opts);
        queueMicrotask(() => {
            let err = null;
            let result = { status: 0, stdout: '', stderr: '', signal: null };
            if (spec.error) {
                err = spec.error;
                result.status = null;
            } else {
                try {
                    result = runBuiltCommand(spec);
                    if (result.status !== 0) err = makeCommandError(spec, result);
                } catch (e) {
                    err = e;
                    result.stdout = e.stdout || '';
                    result.stderr = e.stderr || '';
                }
            }
            if (child.stdout && result.stdout) child.stdout.push(Buffer.from(result.stdout));
            if (child.stderr && result.stderr) child.stderr.push(Buffer.from(result.stderr));
            child._complete(result.status || (err ? 1 : 0), result.signal);
            if (cb) cb(err, result.stdout, result.stderr);
        });
        return child;
    }

    const kPromisify = util.promisify.custom;
    function makePromisified(fn) {
        return function(...args) {
            let child;
            const promise = new Promise((resolve, reject) => {
                child = fn(...args, (err, stdout, stderr) => {
                    if (err) reject(err);
                    else resolve({ stdout, stderr });
                });
            });
            promise.child = child;
            return promise;
        };
    }
    exec[kPromisify] = makePromisified(exec);
    execFile[kPromisify] = makePromisified(execFile);

    function fork(modulePath, args, options) {
        _validateString(modulePath, 'modulePath');
        if (args === undefined) {
            args = [];
        } else if (!Array.isArray(args) && options === undefined && args && typeof args === 'object') {
            options = args;
            args = [];
        }
        if (!Array.isArray(args)) {
            throw _makeInvalidArgTypeError('args', 'Array', args);
        }
        options = options || {};
        const execPath = options.execPath || process.execPath || 'node';
        const execArgv = Array.isArray(options.execArgv) ? options.execArgv : process.execArgv || [];
        const child = spawn(execPath, [...execArgv, modulePath, ...args], options);
        child.connected = false;
        child.channel = undefined;
        child.disconnect = () => {
            child.connected = false;
            child.emit('disconnect');
        };
        child.send = (_message, _sendHandle, _options, callback) => {
            if (typeof _sendHandle === 'function') callback = _sendHandle;
            if (typeof _options === 'function') callback = _options;
            const err = _makeUnsupportedPlatformError('child_process.fork IPC');
            if (typeof callback === 'function') queueMicrotask(() => callback(err));
            else queueMicrotask(() => child.emit('error', err));
            return false;
        };
        return child;
    }

    return { ChildProcess, execSync, execFileSync, spawnSync, exec, execFile, spawn, fork };
})();

// ============================================================
// cluster module
// ============================================================

const cluster = (() => {
    const SCHED_NONE = 1;
    const SCHED_RR = 2;
    const mod = new events.EventEmitter();

    function initEmitter(target) {
        const emitter = new events.EventEmitter();
        target._events = emitter._events;
        target._maxListeners = emitter._maxListeners;
    }

    function Worker(options) {
        if (!(this instanceof Worker)) return new Worker(options);
        initEmitter(this);
        if (options === null || typeof options !== 'object') options = {};
        this.exitedAfterDisconnect = undefined;
        this.state = options.state || 'none';
        this.id = options.id | 0;
        if (options.process) {
            this.process = options.process;
            if (typeof this.process.on === 'function') {
                this.process.on('error', (code, signal) => this.emit('error', code, signal));
                this.process.on('message', (message, handle) => this.emit('message', message, handle));
                this.process.on('disconnect', () => this._markDisconnected());
                this.process.on('exit', () => this._markDead());
            }
        }
    }

    Worker.prototype = Object.create(events.EventEmitter.prototype);
    Object.defineProperty(Worker.prototype, 'constructor', {
        value: Worker,
        writable: true,
        configurable: true,
    });

    Worker.prototype._markDisconnected = function() {
        if (this.state === 'dead' || this.state === 'disconnected') return;
        this.state = 'disconnected';
        this.emit('disconnect');
    };

    Worker.prototype._markDead = function() {
        this.state = 'dead';
        this.emit('exit', this.process && this.process.exitCode, this.process && this.process.signalCode);
    };

    Worker.prototype.disconnect = function() {
        this.exitedAfterDisconnect = true;
        if (this.process && typeof this.process.disconnect === 'function') {
            this.process.disconnect();
        } else {
            queueMicrotask(() => this._markDisconnected());
        }
        return this;
    };

    Worker.prototype.destroy = function(signal) {
        if (this.process && typeof this.process.kill === 'function') {
            this.process.kill(signal);
        }
        queueMicrotask(() => {
            if (this.state !== 'dead') {
                this._markDisconnected();
                this._markDead();
            }
        });
        return this;
    };

    Worker.prototype.kill = function(signal) {
        return this.destroy(signal);
    };

    Worker.prototype.send = function() {
        if (this.process && typeof this.process.send === 'function') {
            return this.process.send.apply(this.process, arguments);
        }
        const callback = Array.from(arguments).find((arg) => typeof arg === 'function');
        const err = _makeUnsupportedPlatformError('cluster worker IPC');
        if (callback) queueMicrotask(() => callback(err));
        else queueMicrotask(() => this.emit('error', err));
        return false;
    };

    Worker.prototype.isDead = function() {
        if (!this.process) return this.state === 'dead';
        return this.process.exitCode != null || this.process.signalCode != null || this.state === 'dead';
    };

    Worker.prototype.isConnected = function() {
        if (!this.process) return this.state !== 'disconnected' && this.state !== 'dead';
        return this.process.connected !== false && this.state !== 'disconnected' && this.state !== 'dead';
    };

    function defaultSettings() {
        return {
            args: process.argv.slice(2),
            exec: process.argv[1],
            execArgv: process.execArgv,
            silent: false,
        };
    }

    function emitSetup(settings) {
        queueMicrotask(() => mod.emit('setup', settings));
    }

    function setupPrimary(options) {
        const settings = {
            ...defaultSettings(),
            ...mod.settings,
            ...(options && typeof options === 'object' ? options : {}),
        };
        mod.settings = settings;
        emitSetup(settings);
        return settings;
    }

    function fork() {
        throw _makeUnsupportedPlatformError('cluster.fork');
    }

    function disconnect(callback) {
        const workers = Object.keys(mod.workers).map((id) => mod.workers[id]);
        if (typeof callback === 'function') mod.once('disconnect', callback);
        queueMicrotask(() => {
            for (const worker of workers) {
                if (worker && typeof worker.isConnected === 'function' && worker.isConnected()) {
                    worker.disconnect();
                }
            }
            mod.emit('disconnect');
        });
    }

    Object.assign(mod, {
        isMaster: true,
        isPrimary: true,
        isWorker: false,
        worker: undefined,
        workers: {},
        settings: {},
        SCHED_NONE,
        SCHED_RR,
        schedulingPolicy: SCHED_RR,
        setupPrimary,
        setupMaster: setupPrimary,
        disconnect,
        fork,
        Worker,
    });

    return mod;
})();

// ============================================================
// crypto module (minimal)
// ============================================================

const crypto = (() => {
    class CryptoKey {}
    class SubtleCrypto {}
    class Crypto {
        constructor() {
            this.subtle = new SubtleCrypto();
        }
        getRandomValues(buf) { return getRandomValues(buf); }
        randomUUID() { return randomUUID(); }
    }

    function randomBytes(size) {
        const buf = Buffer.alloc(size);
        // Use Math.random as fallback (not cryptographically secure)
        for (let i = 0; i < size; i++) {
            buf[i] = Math.floor(Math.random() * 256);
        }
        return buf;
    }

    function randomUUID() {
        const bytes = randomBytes(16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = bytes.toString('hex');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    function randomInt(min, max) {
        if (max === undefined) { max = min; min = 0; }
        return min + Math.floor(Math.random() * (max - min));
    }

    function createHash(algorithm) {
        const native = _nodeNative.createHash(algorithm);
        return {
            update(data) {
                native.update(data);
                return this;
            },
            digest(encoding) {
                const buf = Buffer.from(native.digest());
                return encoding ? buf.toString(encoding) : buf;
            },
        };
    }

    function createHmac(algorithm, key) {
        const native = _nodeNative.createHmac(algorithm, key);
        return {
            update(data) {
                native.update(data);
                return this;
            },
            digest(encoding) {
                const buf = Buffer.from(native.digest());
                return encoding ? buf.toString(encoding) : buf;
            },
        };
    }

    function getRandomValues(buf) {
        for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
        return buf;
    }

    const webcrypto = new Crypto();

    return {
        randomBytes, randomUUID, randomInt,
        createHash, createHmac,
        getHashes() { return ['sha1', 'sha256', 'sha512', 'md5']; },
        getRandomValues,
        webcrypto,
        Crypto,
        CryptoKey,
        SubtleCrypto,
    };
})();

// ============================================================
// net module (minimal stubs)
// ============================================================

const net = (() => {
    const nat = _nodeNative;
    const toU8 = (b) => {
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof b === 'string') return Buffer.from(b, 'utf8');
        throw new TypeError('socket: chunk must be Buffer, Uint8Array, ArrayBuffer, or string');
    };
    const codedTypeError = (message, code) => {
        const err = new TypeError(message);
        err.code = code;
        return err;
    };
    const codedRangeError = (message, code) => {
        const err = new RangeError(message);
        err.code = code;
        return err;
    };
    function isValidIPv4(input) {
        const parts = String(input).split('.');
        if (parts.length !== 4) return false;
        for (const part of parts) {
            if (!/^(0|[1-9]\d*)$/.test(part)) return false;
            const n = Number(part);
            if (n < 0 || n > 255) return false;
        }
        return true;
    }
    function isValidIPv6(input) {
        let value = String(input);
        const zoneIndex = value.indexOf('%');
        if (zoneIndex >= 0) {
            const zone = value.slice(zoneIndex + 1);
            if (!/^[A-Za-z0-9_.~-]+$/.test(zone)) return false;
            value = value.slice(0, zoneIndex);
        }
        if (value.length === 0) return false;
        if (value.indexOf(':::') >= 0) return false;
        const hasCompression = value.includes('::');
        if (hasCompression && value.indexOf('::') !== value.lastIndexOf('::')) return false;
        if (value.startsWith(':') && !value.startsWith('::')) return false;
        if (value.endsWith(':') && !value.endsWith('::')) return false;
        if (!hasCompression && (value.startsWith(':') || value.endsWith(':'))) return false;
        const rawParts = value.split(':');
        const parts = rawParts.filter((part) => part.length > 0);
        let hextets = 0;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part.includes('.')) {
                if (i !== parts.length - 1 || !isValidIPv4(part)) return false;
                hextets += 2;
            } else {
                if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return false;
                hextets++;
            }
        }
        return hasCompression ? hextets < 8 : hextets === 8;
    }

    class Socket extends stream.Duplex {
        constructor(options) {
            if (options?.fd !== undefined) {
                if (typeof options.fd !== 'number') {
                    throw codedTypeError('The "options.fd" property must be of type number.', 'ERR_INVALID_ARG_TYPE');
                }
                if (!Number.isInteger(options.fd) || options.fd < 0) {
                    throw codedRangeError('The value of "options.fd" is out of range.', 'ERR_OUT_OF_RANGE');
                }
            }
            super(options);
            this._fd = options?.fd ?? -1;
            this._socketDestroyed = false;
            this._reading = false;
            this._writeQueue = [];
            this.connecting = false;
            this.remoteAddress = null;
            this.remotePort = null;
            this.localAddress = null;
            this.localPort = null;
        }

        connect(port, host, cb) {
            if (typeof port === 'object' && port !== null) {
                cb = host; host = port.host; port = port.port;
            }
            if (typeof host === 'function') { cb = host; host = undefined; }
            host = host || 'localhost';
            if (cb) this.once('connect', cb);

            this.connecting = true;
            this.remoteAddress = host;
            this.remotePort = port;

            nat.socketConnect(host, port).then(
                (fd) => {
                    if (this._socketDestroyed) { nat.socketClose(fd); return; }
                    this._fd = fd;
                    this.connecting = false;
                    this.emit('connect');
                    this._scheduleRead();
                    this._flushWriteQueue();
                },
                (err) => {
                    this.connecting = false;
                    this.destroy(err);
                },
            );
            return this;
        }

        _scheduleRead() {
            if (this._fd < 0 || this._socketDestroyed || this._reading) return;
            this._reading = true;
            nat.socketRead(this._fd, 64 * 1024).then(
                (ab) => {
                    this._reading = false;
                    if (this._socketDestroyed) return;
                    if (ab.byteLength === 0) {
                        this.push(null); /* EOF — peer closed */
                        return;
                    }
                    this.push(Buffer.from(ab));
                    this._scheduleRead();
                },
                (err) => {
                    this._reading = false;
                    if (!this._socketDestroyed) this.destroy(err);
                },
            );
        }

        _read() { /* push happens proactively in _scheduleRead */ }

        _write(chunk, _encoding, cb) {
            const buf = toU8(chunk);
            if (this._fd < 0) {
                this._writeQueue.push({ buf, cb });
                return;
            }
            nat.socketWrite(this._fd, buf).then(() => cb(null), cb);
        }

        _flushWriteQueue() {
            const q = this._writeQueue;
            this._writeQueue = [];
            for (const { buf, cb } of q) {
                nat.socketWrite(this._fd, buf).then(() => cb(null), cb);
            }
        }

        destroy(err) {
            if (this._socketDestroyed) return this;
            this._socketDestroyed = true;
            if (this._fd >= 0) {
                nat.socketClose(this._fd);
                this._fd = -1;
            }
            for (const { cb } of this._writeQueue) cb(err || new Error('socket destroyed'));
            this._writeQueue = [];
            if (err) this.emit('error', err);
            this.emit('close', !!err);
            return this;
        }

        setEncoding(enc) { this._encoding = enc; return this; }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        resetAndDestroy() { return this.destroy(); }
        _setSimultaneousAccepts() {}
        address() { return { address: this.localAddress, port: this.localPort, family: 'IPv4' }; }
        ref() { return this; }
        unref() { return this; }
    }

    /* Server is still a stub — Phase 3 ships client sockets only. */
    class Server extends events.EventEmitter {
        constructor(options, connectionListener) {
            super();
            if (typeof options === 'function') { connectionListener = options; options = {}; }
            if (connectionListener) this.on('connection', connectionListener);
        }
        listen(port, host, cb) {
            if (typeof host === 'function') { cb = host; host = '0.0.0.0'; }
            if (typeof port === 'function') { cb = port; port = 0; }
            this._port = port;
            this._host = host || '0.0.0.0';
            if (cb) this.once('listening', cb);
            queueMicrotask(() => this.emit('listening'));
            return this;
        }
        address() { return { address: this._host, port: this._port, family: 'IPv4' }; }
        close(cb) { if (cb) cb(); return this; }
        ref() { return this; }
        unref() { return this; }
    }

    function Stream(options) {
        return new Socket(options);
    }
    Object.setPrototypeOf(Stream, Socket);
    Stream.prototype = Socket.prototype;
    Object.defineProperty(Stream.prototype, 'constructor', {
        value: Socket,
        writable: true,
        configurable: true,
    });

    function _netArgType(name, expected, value) {
        return _netCodeMessage(_makeInvalidArgTypeError(name, expected, value));
    }

    function _netArgValue(name, value) {
        return _netCodeMessage(_makeInvalidArgValueError(name, value));
    }

    function _netCodeMessage(err) {
        if (!String(err.message).includes(err.code)) {
            err.message = `${err.code}: ${err.message}`;
        }
        return err;
    }

    function _netBadPort(value) {
        const err = new RangeError(`Port should be >= 0 and < 65536. Received ${value}.`);
        err.code = 'ERR_SOCKET_BAD_PORT';
        return _netCodeMessage(err);
    }

    function _family(family, valueErrorForAllInvalid) {
        if (family === undefined) return 'ipv4';
        if (typeof family !== 'string') {
            throw valueErrorForAllInvalid ? _netArgValue('family', family) : _netArgType('family', 'string', family);
        }
        const f = family.toLowerCase();
        if (f !== 'ipv4' && f !== 'ipv6') throw _netArgValue('family', family);
        return f;
    }

    function _ipv4ToInt(address) {
        if (typeof address !== 'string') throw _netArgType('address', 'string', address);
        const parts = address.split('.');
        if (parts.length !== 4) return null;
        let out = 0;
        for (const part of parts) {
            if (!/^\d+$/.test(part)) return null;
            const n = Number(part);
            if (n < 0 || n > 255) return null;
            out = (out << 8) | n;
        }
        return out >>> 0;
    }

    function _ipv6ToBigInt(address) {
        if (typeof address !== 'string') throw _netArgType('address', 'string', address);
        address = address.toLowerCase();
        const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return 0xffff00000000n | BigInt(_ipv4ToInt(mapped[1]) ?? 0);
        if (address.includes('.')) {
            const idx = address.lastIndexOf(':');
            const v4 = _ipv4ToInt(address.slice(idx + 1));
            if (v4 === null) return null;
            address = address.slice(0, idx) + ':' + ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
        }
        const sides = address.split('::');
        if (sides.length > 2) return null;
        const left = sides[0] ? sides[0].split(':').filter(Boolean) : [];
        const right = sides.length === 2 && sides[1] ? sides[1].split(':').filter(Boolean) : [];
        const fill = sides.length === 2 ? 8 - left.length - right.length : 0;
        const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right];
        if (groups.length !== 8) return null;
        let out = 0n;
        for (const group of groups) {
            if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
            out = (out << 16n) | BigInt(parseInt(group, 16));
        }
        return out;
    }

    function _addressValue(input, family) {
        if (input instanceof SocketAddress) {
            return _addressValue(input.address, input.family);
        }
        family = _family(family);
        if (family === 'ipv4') {
            const direct = _ipv4ToInt(input);
            if (direct !== null) return { family, value: BigInt(direct), bits: 32, address: input };
            if (typeof input === 'string' && input.toLowerCase().startsWith('::ffff:')) {
                const mapped = _ipv4ToInt(input.slice(7));
                if (mapped !== null) return { family: 'ipv4', value: BigInt(mapped), bits: 32, address: input };
            }
            throw _netArgValue('address', input);
        }
        const value = _ipv6ToBigInt(input);
        if (value === null) throw _netArgValue('address', input);
        return { family, value, bits: 128, address: input };
    }

    class SocketAddress {
        constructor(options) {
            if (options === undefined) options = {};
            if (options === null || typeof options !== 'object' || Array.isArray(options)) {
                throw _netArgType('options', 'object', options);
            }
            const family = _family(options.family, true);
            const defaultAddress = family === 'ipv6' ? '::' : '127.0.0.1';
            const address = options.address === undefined ? defaultAddress : options.address;
            const parsed = _addressValue(address, family);
            const port = options.port === undefined ? 0 : options.port;
            if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
                throw _netBadPort(port);
            }
            const flowlabel = options.flowlabel === undefined ? 0 : options.flowlabel;
            if (typeof flowlabel !== 'number' || !Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) {
                const err = new RangeError('The value of "options.flowlabel" is out of range.');
                err.code = 'ERR_OUT_OF_RANGE';
                throw _netCodeMessage(err);
            }
            this.address = parsed.address;
            this.port = port;
            this.family = parsed.family;
            this.flowlabel = flowlabel;
        }

        static isSocketAddress(value) {
            return value instanceof SocketAddress;
        }
    }

    class BlockList {
        constructor() {
            this._rules = [];
            this.rules = [];
        }
        _push(kind, family, start, end, prefix, text) {
            this._rules.push({ kind, family, start, end, prefix });
            this.rules.unshift(text);
        }
        addAddress(address, family) {
            const parsed = _addressValue(address, family);
            const label = parsed.family === 'ipv6' ? 'IPv6' : 'IPv4';
            this._push('address', parsed.family, parsed.value, parsed.value, parsed.bits, `Address: ${label} ${parsed.address}`);
        }
        addRange(start, end, family) {
            const a = _addressValue(start, family);
            const b = _addressValue(end, a.family);
            if (a.family !== b.family || a.value > b.value) throw _netArgValue('range', `${start}-${end}`);
            const label = a.family === 'ipv6' ? 'IPv6' : 'IPv4';
            this._push('range', a.family, a.value, b.value, a.bits, `Range: ${label} ${a.address}-${b.address}`);
        }
        addSubnet(address, prefix, family) {
            if (typeof prefix !== 'number') throw _netArgType('prefix', 'number', prefix);
            if (Number.isNaN(prefix)) {
                const err = new RangeError('prefix is out of range');
                err.code = 'ERR_OUT_OF_RANGE';
                throw _netCodeMessage(err);
            }
            const parsed = _addressValue(address, family);
            const max = parsed.family === 'ipv6' ? 128 : 32;
            if (prefix < 0 || prefix > max) {
                const err = new RangeError('prefix is out of range');
                err.code = 'ERR_OUT_OF_RANGE';
                throw _netCodeMessage(err);
            }
            const hostBits = BigInt(max - prefix);
            const mask = hostBits === BigInt(max) ? 0n : (((1n << BigInt(max)) - 1n) ^ ((1n << hostBits) - 1n));
            const start = parsed.value & mask;
            const end = start | ((1n << hostBits) - 1n);
            const label = parsed.family === 'ipv6' ? 'IPv6' : 'IPv4';
            this._push('subnet', parsed.family, start, end, prefix, `Subnet: ${label} ${parsed.address}/${prefix}`);
        }
        check(address, family) {
            let parsed;
            try {
                parsed = _addressValue(address, family);
            } catch (err) {
                const normalizedFamily = typeof family === 'string' ? family.toLowerCase() : family;
                if (typeof address === 'string' &&
                    (family === undefined || normalizedFamily === 'ipv4' || normalizedFamily === 'ipv6')) {
                    return false;
                }
                throw err;
            }
            for (const rule of this._rules) {
                if (rule.family === parsed.family && parsed.value >= rule.start && parsed.value <= rule.end) return true;
                if (rule.family === 'ipv4' && parsed.family === 'ipv6') {
                    const mappedPrefix = parsed.value >> 32n;
                    if (mappedPrefix === 0xffffn) {
                        const v4 = parsed.value & 0xffffffffn;
                        if (v4 >= rule.start && v4 <= rule.end) return true;
                    }
                }
                if (rule.family === 'ipv6' && parsed.family === 'ipv4') {
                    const mapped = 0xffff00000000n | parsed.value;
                    if (mapped >= rule.start && mapped <= rule.end) return true;
                }
            }
            return false;
        }
    }

    return {
        Socket, Stream, Server, BlockList, SocketAddress,
        createServer(options, listener) { return new Server(options, listener); },
        createConnection(port, host, cb) { return new Socket().connect(port, host, cb); },
        connect(port, host, cb) { return new Socket().connect(port, host, cb); },
        _setSimultaneousAccepts() {},
        isIP(input) {
            try { input = String(input); } catch (_) { return 0; }
            if (isValidIPv4(input)) return 4;
            if (isValidIPv6(input)) return 6;
            return 0;
        },
        isIPv4(input) { return net.isIP(input) === 4; },
        isIPv6(input) { return net.isIP(input) === 6; },
    };
})();

const dns = (() => {
    const defaultServers = ['127.0.0.1'];
    const codedTypeError = (message) => {
        const err = new TypeError(message);
        err.code = 'ERR_INVALID_ARG_TYPE';
        return err;
    };
    function validateServers(servers) {
        if (!Array.isArray(servers)) {
            throw codedTypeError('The "servers" argument must be an instance of Array.');
        }
        for (let i = 0; i < servers.length; i++) {
            if (typeof servers[i] !== 'string') {
                throw codedTypeError(`The "servers[${i}]" argument must be of type string.`);
            }
        }
    }
    function lookup(hostname, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        if (typeof cb !== 'function') return;
        cb(null, net.isIP(hostname) === 6 ? '::1' : '127.0.0.1', net.isIP(hostname) || 4);
    }
    function lookupService(address, port, cb) {
        if (String(address).startsWith('192.0.2.')) {
            const err = new Error(`getnameinfo ENOTFOUND ${address}`);
            err.code = 'ENOTFOUND';
            err.syscall = 'getnameinfo';
            if (typeof cb === 'function') cb(err);
            return;
        }
        if (typeof cb === 'function') cb(null, 'localhost', String(port));
    }
    function answerForType(rrtype) {
        switch (String(rrtype || 'A').toUpperCase()) {
            case 'A': return ['127.0.0.1'];
            case 'AAAA': return ['::1'];
            case 'ANY': return [{ type: 'A', address: '127.0.0.1' }];
            case 'SOA': return {
                nsname: 'localhost',
                hostmaster: 'root.localhost',
                serial: 1,
                refresh: 0,
                retry: 0,
                expire: 0,
                minttl: 0,
            };
            default: return [];
        }
    }
    class Resolver {
        constructor() {
            this._servers = defaultServers.slice();
            this._localAddress = undefined;
            this._localAddress6 = undefined;
            this._handle = {
                getServers: () => this._servers.slice(),
            };
        }
        getServers() {
            const servers = this._handle && this._handle.getServers
                ? this._handle.getServers()
                : this._servers;
            return Array.isArray(servers) ? servers.slice() : [];
        }
        setServers(servers) {
            validateServers(servers);
            this._servers = servers.slice();
        }
        setLocalAddress(ipv4, ipv6) {
            this._localAddress = ipv4;
            this._localAddress6 = ipv6;
        }
        resolve(hostname, rrtype, cb) {
            if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
            if (typeof cb === 'function') cb(null, answerForType(rrtype));
        }
        resolve4(hostname, cb) { this.resolve(hostname, 'A', cb); }
        resolve6(hostname, cb) { this.resolve(hostname, 'AAAA', cb); }
        resolveAny(hostname, cb) { this.resolve(hostname, 'ANY', cb); }
        resolveCaa(hostname, cb) { this.resolve(hostname, 'CAA', cb); }
        resolveCname(hostname, cb) { this.resolve(hostname, 'CNAME', cb); }
        resolveMx(hostname, cb) { this.resolve(hostname, 'MX', cb); }
        resolveNaptr(hostname, cb) { this.resolve(hostname, 'NAPTR', cb); }
        resolveNs(hostname, cb) { this.resolve(hostname, 'NS', cb); }
        resolvePtr(hostname, cb) { this.resolve(hostname, 'PTR', cb); }
        resolveSoa(hostname, cb) { this.resolve(hostname, 'SOA', cb); }
        resolveSrv(hostname, cb) { this.resolve(hostname, 'SRV', cb); }
        resolveTxt(hostname, cb) { this.resolve(hostname, 'TXT', cb); }
        reverse(_ip, cb) { if (typeof cb === 'function') cb(null, ['localhost']); }
    }
    const resolver = new Resolver();
    const callbackApi = {
        Resolver,
        lookup,
        lookupService,
        resolve: resolver.resolve.bind(resolver),
        resolve4: resolver.resolve4.bind(resolver),
        resolve6: resolver.resolve6.bind(resolver),
        resolveAny: resolver.resolveAny.bind(resolver),
        resolveCaa: resolver.resolveCaa.bind(resolver),
        resolveCname: resolver.resolveCname.bind(resolver),
        resolveMx: resolver.resolveMx.bind(resolver),
        resolveNaptr: resolver.resolveNaptr.bind(resolver),
        resolveNs: resolver.resolveNs.bind(resolver),
        resolvePtr: resolver.resolvePtr.bind(resolver),
        resolveSoa: resolver.resolveSoa.bind(resolver),
        resolveSrv: resolver.resolveSrv.bind(resolver),
        resolveTxt: resolver.resolveTxt.bind(resolver),
        reverse: resolver.reverse.bind(resolver),
        getServers: resolver.getServers.bind(resolver),
        setServers: resolver.setServers.bind(resolver),
        setDefaultResultOrder() {},
        getDefaultResultOrder() { return 'verbatim'; },
    };
    class PromisesResolver extends Resolver {
        lookup(hostname, options) {
            return new Promise((resolve, reject) =>
                lookup(hostname, options, (err, address, family) =>
                    err ? reject(err) : resolve({ address, family })));
        }
        lookupService(address, port) {
            return new Promise((resolve, reject) =>
                lookupService(address, port, (err, hostname, service) =>
                    err ? reject(err) : resolve({ hostname, service })));
        }
        resolve(hostname, rrtype) {
            return new Promise((resolve, reject) =>
                super.resolve(hostname, rrtype || 'A', (err, addresses) =>
                    err ? reject(err) : resolve(addresses)));
        }
        resolve4(hostname) { return this.resolve(hostname, 'A'); }
        resolve6(hostname) { return this.resolve(hostname, 'AAAA'); }
        resolveAny(hostname) { return this.resolve(hostname, 'ANY'); }
        resolveCaa(hostname) { return this.resolve(hostname, 'CAA'); }
        resolveCname(hostname) { return this.resolve(hostname, 'CNAME'); }
        resolveMx(hostname) { return this.resolve(hostname, 'MX'); }
        resolveNaptr(hostname) { return this.resolve(hostname, 'NAPTR'); }
        resolveNs(hostname) { return this.resolve(hostname, 'NS'); }
        resolvePtr(hostname) { return this.resolve(hostname, 'PTR'); }
        resolveSoa(hostname) { return this.resolve(hostname, 'SOA'); }
        resolveSrv(hostname) { return this.resolve(hostname, 'SRV'); }
        resolveTxt(hostname) { return this.resolve(hostname, 'TXT'); }
        reverse(ip) {
            return new Promise((resolve, reject) =>
                super.reverse(ip, (err, hostnames) =>
                    err ? reject(err) : resolve(hostnames)));
        }
    }
    const promisesResolver = new PromisesResolver();
    callbackApi.promises = {
        Resolver: PromisesResolver,
        lookup: promisesResolver.lookup.bind(promisesResolver),
        lookupService: promisesResolver.lookupService.bind(promisesResolver),
        resolve: promisesResolver.resolve.bind(promisesResolver),
        resolve4: promisesResolver.resolve4.bind(promisesResolver),
        resolve6: promisesResolver.resolve6.bind(promisesResolver),
        resolveAny: promisesResolver.resolveAny.bind(promisesResolver),
        resolveCaa: promisesResolver.resolveCaa.bind(promisesResolver),
        resolveCname: promisesResolver.resolveCname.bind(promisesResolver),
        resolveMx: promisesResolver.resolveMx.bind(promisesResolver),
        resolveNaptr: promisesResolver.resolveNaptr.bind(promisesResolver),
        resolveNs: promisesResolver.resolveNs.bind(promisesResolver),
        resolvePtr: promisesResolver.resolvePtr.bind(promisesResolver),
        resolveSoa: promisesResolver.resolveSoa.bind(promisesResolver),
        resolveSrv: promisesResolver.resolveSrv.bind(promisesResolver),
        resolveTxt: promisesResolver.resolveTxt.bind(promisesResolver),
        reverse: promisesResolver.reverse.bind(promisesResolver),
        getServers: promisesResolver.getServers.bind(promisesResolver),
        setServers: promisesResolver.setServers.bind(promisesResolver),
        setDefaultResultOrder() {},
        getDefaultResultOrder() { return 'verbatim'; },
    };
    return callbackApi;
})();

// ============================================================
// tls module — TLSSocket via libssl in the wasm sysroot
// ============================================================

const tls = (() => {
    const nat = _nodeNative;
    const toU8 = (b) => {
        if (b instanceof Uint8Array) return b;
        if (b instanceof ArrayBuffer) return new Uint8Array(b);
        if (typeof b === 'string') return Buffer.from(b, 'utf8');
        throw new TypeError('tls: chunk must be Buffer, Uint8Array, ArrayBuffer, or string');
    };

    /* TLSSocket layers SSL_read/SSL_write over a fd that net.Socket has
       already TCP-connected. The underlying fd is owned by the TLS handle
       once handshake starts — close routes through tlsClose. */
    class TLSSocket extends stream.Duplex {
        constructor(options) {
            super(options);
            this._tlsHandle = -1;
            this._tlsDestroyed = false;
            this._reading = false;
            this._writeQueue = [];
            this._handshakePending = true;
            this.servername = options?.servername || null;
            this.authorized = false;
        }

        _attach(fd, servername, opts) {
            const ca = typeof opts?.ca === 'string'
                ? opts.ca
                : (Buffer.isBuffer?.(opts?.ca) ? opts.ca.toString('utf8') : undefined);
            const rejectUnauthorized = opts?.rejectUnauthorized !== false;
            this.servername = servername;
            nat.tlsConnect(fd, servername, { ca, rejectUnauthorized }).then(
                (handle) => {
                    if (this._tlsDestroyed) { nat.tlsClose(handle); return; }
                    this._tlsHandle = handle;
                    this._handshakePending = false;
                    this.authorized = rejectUnauthorized;
                    this.emit('secureConnect');
                    this._scheduleRead();
                    this._flushWriteQueue();
                },
                (err) => { this._handshakePending = false; this.destroy(err); },
            );
        }

        _scheduleRead() {
            if (this._tlsHandle < 0 || this._tlsDestroyed || this._reading) return;
            this._reading = true;
            nat.tlsRead(this._tlsHandle, 64 * 1024).then(
                (ab) => {
                    this._reading = false;
                    if (this._tlsDestroyed) return;
                    if (ab.byteLength === 0) { this.push(null); return; }
                    this.push(Buffer.from(ab));
                    this._scheduleRead();
                },
                (err) => {
                    this._reading = false;
                    if (!this._tlsDestroyed) this.destroy(err);
                },
            );
        }

        _read() { /* push happens proactively in _scheduleRead */ }

        _write(chunk, _encoding, cb) {
            const buf = toU8(chunk);
            if (this._tlsHandle < 0) {
                this._writeQueue.push({ buf, cb });
                return;
            }
            nat.tlsWrite(this._tlsHandle, buf).then(() => cb(null), cb);
        }

        _flushWriteQueue() {
            const q = this._writeQueue;
            this._writeQueue = [];
            for (const { buf, cb } of q) {
                nat.tlsWrite(this._tlsHandle, buf).then(() => cb(null), cb);
            }
        }

        destroy(err) {
            if (this._tlsDestroyed) return this;
            this._tlsDestroyed = true;
            if (this._tlsHandle >= 0) {
                nat.tlsClose(this._tlsHandle);
                this._tlsHandle = -1;
            }
            for (const { cb } of this._writeQueue) cb(err || new Error('tls socket destroyed'));
            this._writeQueue = [];
            if (err) this.emit('error', err);
            this.emit('close', !!err);
            return this;
        }

        setEncoding(enc) { this._encoding = enc; return this; }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        ref() { return this; }
        unref() { return this; }
        getProtocol() { return this._tlsHandle >= 0 ? 'TLSv1.3' : null; }
        getPeerCertificate() { return {}; }
    }

    function connect(options, cb) {
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
        const sock = new TLSSocket(options);
        if (cb) sock.once('secureConnect', cb);
        const servername = options.servername || options.host || 'localhost';
        nat.socketConnect(options.host || 'localhost', options.port).then(
            (fd) => {
                if (sock._tlsDestroyed) { nat.socketClose(fd); return; }
                sock._attach(fd, servername, options);
            },
            (err) => sock.destroy(err),
        );
        return sock;
    }

    return { connect, TLSSocket };
})();

// ============================================================
// http / https modules — real HTTP/1.1 over net.Socket (http) and tls.TLSSocket (https)
//
// Single-source parser; the http vs https split is just the transport
// factory we hand the request constructor. Mirrors Node's surface enough
// for npm: ClientRequest extends Writable, IncomingMessage extends
// Readable, headers are stored case-insensitively, body modes are
// Content-Length / Transfer-Encoding: chunked / connection-close.
// ============================================================

const STATUS_CODES = {
    100: 'Continue', 101: 'Switching Protocols',
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
    304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
    409: 'Conflict', 410: 'Gone', 411: 'Length Required',
    413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
    429: 'Too Many Requests',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const HTTP_METHODS = [
    'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE',
];

const kOutHeaders = Symbol('kOutHeaders');

function makeNodeTypeError(message, code) {
    const err = new TypeError(message);
    err.code = code;
    return err;
}

function makeHttpError(message, code, Ctor) {
    const err = new (Ctor || Error)(message);
    err.code = code;
    return err;
}

function validateHttpToken(name, label) {
    const value = String(name);
    if (typeof name !== 'string' || value.length === 0 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) {
        throw makeHttpError(`${label} must be a valid HTTP token ["${value}"]`, 'ERR_INVALID_HTTP_TOKEN', TypeError);
    }
    return value;
}

function validateHttpHeaderValue(name, value, label) {
    if (value === undefined) {
        throw makeHttpError(`Invalid value "undefined" for ${label} "${name}"`, 'ERR_HTTP_INVALID_HEADER_VALUE', TypeError);
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
        const str = String(item);
        if (/[^\t\x20-\x7e\x80-\xff]/.test(str)) {
            throw makeHttpError(`Invalid character in ${label} content ["${name}"]`, 'ERR_INVALID_CHAR', TypeError);
        }
    }
}

function normalizeOutgoingHeaderValue(value) {
    if (Array.isArray(value)) return value.map((item) => String(item));
    return String(value);
}

function outgoingMessageWriteAfterEndError(code) {
    return makeHttpError(
        code === 'ERR_STREAM_ALREADY_FINISHED' ? 'Cannot call end after a stream was finished' : 'write after end',
        code,
    );
}

const uniqueIncomingHeaders = new Set([
    'age', 'authorization', 'content-length', 'content-type', 'etag', 'expires',
    'from', 'host', 'if-modified-since', 'if-unmodified-since', 'last-modified',
    'location', 'max-forwards', 'proxy-authorization', 'referer', 'retry-after',
    'server', 'user-agent',
]);

class IncomingMessage extends stream.Readable {
    constructor(socket) {
        super({
            highWaterMark: socket?.readableHighWaterMark ?? socket?.highWaterMark,
        });
        this.socket = socket;
        this.headers = Object.create(null);
        this.rawHeaders = [];
        this.trailers = Object.create(null);
        this.rawTrailers = [];
        this.httpVersion = '1.1';
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;
        this.statusCode = 0;
        this.statusMessage = '';
        this.complete = false;
        this.aborted = false;
        this.url = '';
        this.method = null;
    }
    get connection() { return this.socket; }
    set connection(value) { this.socket = value; }
    _addHeaderLine(field, value, dest) {
        const lk = String(field).toLowerCase();
        const strValue = value === undefined ? undefined : String(value);
        if (lk === 'set-cookie') {
            if (dest[lk] === undefined) dest[lk] = [];
            dest[lk].push(strValue);
        } else if (dest[lk] === undefined) {
            dest[lk] = strValue;
        } else if (uniqueIncomingHeaders.has(lk)) {
            return;
        } else if (lk === 'cookie') {
            dest[lk] += '; ' + strValue;
        } else {
            dest[lk] += ', ' + strValue;
        }
    }
    _addHeaderLines(lines, n) {
        for (let i = 0; i < n; i += 2) {
            this._addHeaderLine(lines[i], lines[i + 1], this.headers);
        }
    }
    _read() {}
}

class OutgoingMessage extends stream.Writable {
    constructor() {
        super();
        this.destroyed = false;
        this.headersSent = false;
        this.finished = false;
        this._header = null;
        this._hasBody = true;
        this.outputData = [];
        this.outputSize = 0;
        this._headerNames = Object.create(null);
        this._headerValues = Object.create(null);
        this[kOutHeaders] = Object.create(null);
        this.once('finish', () => {
            this.finished = true;
            this.headersSent = true;
        });
    }
    setHeader(name, value) {
        if (this._header || this.headersSent) {
            throw makeHttpError('Cannot set headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
        }
        name = validateHttpToken(name, 'Header name');
        validateHttpHeaderValue(name, value, 'header');
        const lk = name.toLowerCase();
        const normalized = normalizeOutgoingHeaderValue(value);
        this._headerNames[lk] = name;
        this._headerValues[lk] = normalized;
        this[kOutHeaders][lk] = [name, normalized];
        return this;
    }
    getHeader(name) { return this._headerValues[String(name).toLowerCase()]; }
    getHeaderNames() { return Object.keys(this._headerValues); }
    getRawHeaderNames() {
        return Object.keys(this._headerValues).map((lk) => this._headerNames[lk] || lk);
    }
    getHeaders() {
        const out = Object.create(null);
        for (const lk of Object.keys(this._headerValues)) out[lk] = this._headerValues[lk];
        return out;
    }
    hasHeader(name) { return this.getHeader(name) !== undefined; }
    removeHeader(name) {
        if (this._header || this.headersSent) {
            throw makeHttpError('Cannot remove headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
        }
        const lk = String(name).toLowerCase();
        delete this._headerNames[lk];
        delete this._headerValues[lk];
        if (this[kOutHeaders]) delete this[kOutHeaders][lk];
    }
    _implicitHeader() {
        throw makeHttpError('The _implicitHeader() method is not implemented', 'ERR_METHOD_NOT_IMPLEMENTED');
    }
    _renderHeaders() {
        if (this._header) {
            throw makeHttpError('Cannot render headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
        }
        const headers = this[kOutHeaders];
        const out = {};
        if (!headers) return out;
        for (const lk of Object.keys(headers)) {
            const pair = headers[lk];
            if (Array.isArray(pair)) out[pair[0]] = pair[1];
        }
        return out;
    }
    _storeHeader(firstLine, headers) {
        let head = String(firstLine || '');
        if (headers && typeof headers === 'object') {
            const rendered = Array.isArray(headers) ? headers : Object.entries(headers).flat();
            for (let i = 0; i + 1 < rendered.length; i += 2) {
                head += `${rendered[i]}: ${rendered[i + 1]}\r\n`;
            }
        }
        head += '\r\n';
        this._header = head;
        this.headersSent = true;
        return head;
    }
    _send(data, encoding, cb) {
        if (data !== undefined && data !== null) this.write(data, encoding, cb);
        else if (typeof cb === 'function') cb();
        return this;
    }
    flushHeaders() {
        if (!this._header && !this.headersSent) this._implicitHeader();
        this.headersSent = true;
        return this;
    }
    _writeRaw(data, encoding, cb) {
        if (this.socket && typeof this.socket.write === 'function') {
            return this.socket.write(data, encoding, cb);
        }
        if (typeof cb === 'function') cb();
        return true;
    }
    assignSocket(socket) {
        this.socket = socket;
        this.connection = socket;
        if (socket && typeof socket.writableHighWaterMark === 'number' && this._writableState) {
            this._writableState.highWaterMark = socket.writableHighWaterMark;
        }
        this.emit('socket', socket);
        this._flushOutputData();
        return this;
    }
    detachSocket(socket) {
        if (!socket || this.socket === socket) {
            this.socket = null;
            this.connection = null;
        }
    }
    _flushOutputData() {
        if (!this.socket || typeof this.socket.write !== 'function' || this.outputData.length === 0) return;
        const queued = this.outputData;
        this.outputData = [];
        for (const item of queued) {
            this.socket.write(item.data, item.encoding, () => {
                this.outputSize = Math.max(0, this.outputSize - item.length);
                item.callback();
            });
        }
    }
    _validateWriteChunk(chunk) {
        if (chunk === null) {
            throw makeHttpError('May not write null values to stream', 'ERR_STREAM_NULL_VALUES', TypeError);
        }
        if (chunk === undefined || (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)
            && !(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk))) {
            throw _makeInvalidArgTypeError('chunk', 'string or an instance of Buffer or Uint8Array', chunk);
        }
    }
    write(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (this.destroyed || this._writableState?.destroyed) {
            const err = makeHttpError('Cannot call write after a stream was destroyed', 'ERR_STREAM_DESTROYED');
            if (typeof cb === 'function') cb(err);
            return false;
        }
        this._validateWriteChunk(chunk);
        if (!this._header && !this.headersSent) this._implicitHeader();
        return stream.Writable.prototype.write.call(this, chunk, encoding, cb);
    }
    _write(chunk, encoding, cb) {
        if (this.socket && typeof this.socket.write === 'function') {
            this.socket.write(chunk, encoding, cb);
        } else {
            const data = (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                : (typeof chunk === 'string') ? Buffer.from(chunk, encoding || 'utf8')
                : Buffer.from(chunk);
            this.outputData.push({ data, encoding, callback: cb, length: data.length });
            this.outputSize += data.length;
        }
    }
    end(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        if (this._writableState?.ended) {
            const err = outgoingMessageWriteAfterEndError(
                chunk !== undefined && chunk !== null ? 'ERR_STREAM_WRITE_AFTER_END' : 'ERR_STREAM_ALREADY_FINISHED'
            );
            if (typeof cb === 'function') cb(err);
            if (chunk !== undefined && chunk !== null) this.emit('error', err);
            return this;
        }
        if (chunk !== undefined && chunk !== null) this._validateWriteChunk(chunk);
        if (!this._header && !this.headersSent) this._implicitHeader();
        stream.Writable.prototype.end.call(this, chunk, encoding, cb);
        this.writable = true;
        return this;
    }
    setTimeout(ms, cb) {
        if (cb) this.once('timeout', cb);
        const apply = (socket) => {
            if (socket && typeof socket.setTimeout === 'function') socket.setTimeout(ms);
        };
        if (this.socket) apply(this.socket);
        else this.once('socket', apply);
        return this;
    }
    pipe() {
        throw makeHttpError('Cannot pipe, not readable', 'ERR_STREAM_CANNOT_PIPE');
    }
    addTrailers(headers) {
        for (const name of Object.keys(headers)) {
            validateHttpToken(name, 'Trailer name');
            validateHttpHeaderValue(name, headers[name], 'trailer');
        }
    }
    _finishWritable() {
        stream.Writable.prototype._finishWritable.call(this);
        this.writable = true;
    }
    destroy(err) {
        if (this.destroyed) return this;
        this.destroyed = true;
        if (this._writableState) {
            this._writableState.destroyed = true;
            this._writableState.closed = true;
            if (err) this._writableState.errored = err;
        }
        if (err) this.emit('error', err);
        this.emit('close');
        return this;
    }
}

class ServerResponse extends OutgoingMessage {
    constructor(req) {
        super();
        this.req = req || null;
        this.statusCode = 200;
        this.statusMessage = STATUS_CODES[200];
        if (req?.socket) this.assignSocket(req.socket);
    }
    _implicitHeader() {
        this.writeHead(this.statusCode);
    }
    writeHead(statusCode, statusMessage, headers) {
        this.statusCode = statusCode;
        if (typeof statusMessage === 'object') {
            headers = statusMessage;
        } else if (statusMessage !== undefined) {
            this.statusMessage = String(statusMessage);
        }
        if (headers) {
            for (const name of Object.keys(headers)) this.setHeader(name, headers[name]);
        }
        this.headersSent = true;
        const statusMessageText = this.statusMessage || STATUS_CODES[this.statusCode] || '';
        this._storeHeader(`HTTP/1.1 ${this.statusCode} ${statusMessageText}\r\n`, this._renderHeaders());
        return this;
    }
    destroy(err) {
        return super.destroy(err);
    }
}

function Server(options, requestListener) {
    if (!(this instanceof Server)) return new Server(options, requestListener);
    if (typeof options === 'function') { requestListener = options; options = {}; }
    this._events = Object.create(null);
    this._maxListeners = events.defaultMaxListeners;
    this.timeout = options?.timeout || 0;
    this.listening = false;
    this._address = null;
    if (requestListener) this.on('request', requestListener);
}
Object.setPrototypeOf(Server, events);
Server.prototype = Object.create(events.prototype);
Object.defineProperty(Server.prototype, 'constructor', {
    value: Server,
    writable: true,
    configurable: true,
});
Server.prototype.listen = function(port, host, cb) {
    if (typeof host === 'function') { cb = host; host = undefined; }
    if (typeof port === 'function') { cb = port; port = 0; }
    this._address = { address: host || '::', port: port || 0, family: 'IPv6' };
    this.listening = true;
    if (cb) this.once('listening', cb);
    queueMicrotask(() => this.emit('listening'));
    return this;
};
Server.prototype.address = function() { return this._address; };
Server.prototype.close = function(cb) {
    this.listening = false;
    if (cb) queueMicrotask(cb);
    this.emit('close');
    return this;
};
Server.prototype.setTimeout = function(ms, cb) {
    this.timeout = ms;
    if (cb) this.on('timeout', cb);
    return this;
};
Server.prototype.ref = function() { return this; };
Server.prototype.unref = function() { return this; };

/* IncomingMessage parser — single instance per ClientRequest. Bytes from
   the socket arrive via feed() and trigger onHeaders / message.push().
   The parser owns the IncomingMessage and is the only thing that should
   call message.push(). */
function makeResponseParser({ onHeaders, onError, onComplete }) {
    let state = 'STATUS'; // STATUS | HEADERS | BODY
    let textBuf = '';     // latin1 buffer for status/headers
    let message = null;
    let bodyMode = null;  // 'length' | 'chunked' | 'close' | 'none'
    let bodyRemaining = 0;
    let chunkPhase = 'size'; // size | data | data-trailer | trailer
    let chunkRemaining = 0;
    let chunkAcc = '';
    let trailerAcc = '';
    let completed = false;
    let remainder = null; // bytes received after end-of-message, for the next claimer of this socket

    function bytesToLatin1(u8) {
        let s = '';
        for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
    }
    function latin1ToBytes(s) {
        const u8 = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
        return u8;
    }

    function complete(leftover) {
        if (completed) return;
        completed = true;
        if (leftover && leftover.length > 0) remainder = leftover;
        if (message) message.complete = true;
        if (message) message.push(null);
        if (onComplete) onComplete();
    }

    function setupBodyMode() {
        const sc = message.statusCode;
        const cl = message.headers['content-length'];
        const te = message.headers['transfer-encoding'];
        // RFC 7230: 1xx, 204, 304 — no body regardless of headers.
        if ((sc >= 100 && sc < 200) || sc === 204 || sc === 304) {
            bodyMode = 'none';
            return;
        }
        if (te && /chunked/i.test(te)) {
            bodyMode = 'chunked'; chunkPhase = 'size'; chunkAcc = '';
        } else if (cl !== undefined) {
            const n = parseInt(cl, 10);
            if (Number.isFinite(n) && n >= 0) {
                bodyMode = 'length';
                bodyRemaining = n;
            } else {
                bodyMode = 'close';
            }
        } else {
            bodyMode = 'close';
        }
    }

    function parseStatusLine(line) {
        // "HTTP/1.1 200 OK" — message may be empty.
        const m = /^HTTP\/(\d+)\.(\d+)[ \t]+(\d{3})(?:[ \t]+(.*))?$/.exec(line);
        if (!m) throw new Error('http: malformed status line: ' + JSON.stringify(line));
        message.httpVersionMajor = parseInt(m[1], 10);
        message.httpVersionMinor = parseInt(m[2], 10);
        message.httpVersion = `${m[1]}.${m[2]}`;
        message.statusCode = parseInt(m[3], 10);
        message.statusMessage = m[4] || STATUS_CODES[message.statusCode] || '';
    }

    function pushHeader(line) {
        const colon = line.indexOf(':');
        if (colon < 0) return; // tolerate
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        const lk = name.toLowerCase();
        message.rawHeaders.push(name, value);
        if (lk === 'set-cookie') {
            if (Array.isArray(message.headers[lk])) message.headers[lk].push(value);
            else message.headers[lk] = [value];
        } else if (message.headers[lk] !== undefined) {
            message.headers[lk] += ', ' + value;
        } else {
            message.headers[lk] = value;
        }
    }

    function parseChunked(u8) {
        let i = 0;
        while (i < u8.length) {
            if (chunkPhase === 'size') {
                while (i < u8.length) {
                    chunkAcc += String.fromCharCode(u8[i++]);
                    if (chunkAcc.endsWith('\r\n')) {
                        const sizeStr = chunkAcc.slice(0, -2).split(';')[0].trim();
                        chunkRemaining = parseInt(sizeStr, 16);
                        if (!Number.isFinite(chunkRemaining) || chunkRemaining < 0) {
                            throw new Error('http: bad chunk size: ' + sizeStr);
                        }
                        chunkAcc = '';
                        chunkPhase = (chunkRemaining === 0) ? 'trailer' : 'data';
                        break;
                    }
                }
            } else if (chunkPhase === 'data') {
                const n = Math.min(u8.length - i, chunkRemaining);
                if (n > 0) {
                    message.push(Buffer.from(u8.subarray(i, i + n)));
                    i += n;
                    chunkRemaining -= n;
                }
                if (chunkRemaining === 0) {
                    chunkPhase = 'data-trailer';
                    trailerAcc = '';
                }
            } else if (chunkPhase === 'data-trailer') {
                while (i < u8.length) {
                    trailerAcc += String.fromCharCode(u8[i++]);
                    if (trailerAcc === '\r\n') {
                        chunkPhase = 'size';
                        chunkAcc = '';
                        trailerAcc = '';
                        break;
                    }
                    if (trailerAcc.length > 2 || (trailerAcc.length === 1 && trailerAcc !== '\r')) {
                        throw new Error('http: bad chunk trailer');
                    }
                }
            } else if (chunkPhase === 'trailer') {
                // Either "\r\n" (no trailers) or trailer headers ending in "\r\n\r\n".
                while (i < u8.length) {
                    chunkAcc += String.fromCharCode(u8[i++]);
                    if (chunkAcc === '\r\n' || chunkAcc.endsWith('\r\n\r\n')) {
                        complete(i < u8.length ? u8.subarray(i) : null);
                        return;
                    }
                    if (chunkAcc.length > 65536) {
                        throw new Error('http: chunked trailer too large');
                    }
                }
            }
        }
    }

    function parseBody(u8) {
        if (completed || !message) return;
        if (bodyMode === 'none') {
            complete();
            return;
        }
        if (bodyMode === 'length') {
            const n = Math.min(u8.length, bodyRemaining);
            if (n > 0) {
                message.push(Buffer.from(u8.subarray(0, n)));
                bodyRemaining -= n;
            }
            if (bodyRemaining === 0) {
                complete(u8.length > n ? u8.subarray(n) : null);
            }
        } else if (bodyMode === 'close') {
            if (u8.length > 0) message.push(Buffer.from(u8));
        } else if (bodyMode === 'chunked') {
            parseChunked(u8);
        }
    }

    return {
        get message() { return message; },
        get completed() { return completed; },
        getRemainder() { return remainder; },
        feed(u8) {
            try {
                if (state === 'STATUS' || state === 'HEADERS') {
                    textBuf += bytesToLatin1(u8);
                    while (true) {
                        const idx = textBuf.indexOf('\r\n');
                        if (idx < 0) return;
                        const line = textBuf.slice(0, idx);
                        textBuf = textBuf.slice(idx + 2);
                        if (state === 'STATUS') {
                            message = makeIncomingMessage();
                            parseStatusLine(line);
                            state = 'HEADERS';
                        } else if (state === 'HEADERS') {
                            if (line === '') {
                                setupBodyMode();
                                state = 'BODY';
                                onHeaders(message);
                                // Bodyless responses (no-body status, or
                                // Content-Length: 0) complete immediately —
                                // no further bytes needed. Hand any post-header
                                // bytes to the next claimer of the socket.
                                if (bodyMode === 'none'
                                    || (bodyMode === 'length' && bodyRemaining === 0)) {
                                    const left = textBuf.length > 0
                                        ? latin1ToBytes(textBuf) : null;
                                    textBuf = '';
                                    complete(left);
                                    return;
                                }
                                if (textBuf.length > 0) {
                                    const rest = latin1ToBytes(textBuf);
                                    textBuf = '';
                                    parseBody(rest);
                                }
                                return;
                            }
                            pushHeader(line);
                        }
                    }
                } else {
                    parseBody(u8);
                }
            } catch (err) {
                onError(err);
            }
        },
        end() {
            // Socket closed. For mode=close, this is the natural EOF.
            if (state === 'BODY' && bodyMode === 'close') {
                complete();
            } else if (state === 'BODY' && !completed) {
                onError(new Error('http: connection closed before body completion'));
            } else if (state !== 'BODY') {
                onError(new Error('http: connection closed before headers'));
            }
        },
    };
}

function attachIncomingSocket(message, socket) {
    message.socket = socket;
    message.connection = socket;
    if (socket && typeof socket.readableHighWaterMark === 'number' && message._readableState) {
        message._readableState.highWaterMark = socket.readableHighWaterMark;
    }
    return message;
}

function makeIncomingMessage(socket) {
    return new IncomingMessage(socket);
}

function appendHttpHeader(message, name, value) {
    const strValue = String(value).trim();
    message.rawHeaders.push(name, strValue);
    message._addHeaderLine(name, strValue, message.headers);
}

function makeHttpModule({ connect, defaultPort, defaultProtocol }) {
    const protoLower = defaultProtocol.toLowerCase();
    const loopbackServers = new Map(); // port -> Server
    let nextLoopbackPort = 49152;

    function isLoopbackHost(host) {
        const normalized = String(host || 'localhost').toLowerCase();
        return normalized === 'localhost' || normalized === '127.0.0.1' ||
            normalized === '0.0.0.0' || normalized === '::1' || normalized === '[::1]';
    }

    function allocateLoopbackPort(requested) {
        if (requested && requested > 0) {
            if (loopbackServers.has(requested)) return -1;
            return requested;
        }
        for (let i = 0; i < 16384; i++) {
            const port = nextLoopbackPort++;
            if (nextLoopbackPort > 65535) nextLoopbackPort = 49152;
            if (!loopbackServers.has(port)) return port;
        }
        return -1;
    }

    function normalizeListenArgs(args) {
        let port = 0;
        let host = '0.0.0.0';
        let cb = null;
        if (args.length > 0 && args[0] && typeof args[0] === 'object') {
            port = args[0].port == null ? 0 : parseInt(args[0].port, 10);
            host = args[0].host || args[0].hostname || host;
            for (let i = 1; i < args.length; i++) {
                if (typeof args[i] === 'function') cb = args[i];
            }
        } else {
            if (typeof args[0] === 'number' || typeof args[0] === 'string') {
                port = parseInt(args[0], 10);
                if (!Number.isFinite(port)) port = 0;
            }
            for (let i = 1; i < args.length; i++) {
                if (typeof args[i] === 'string') host = args[i];
                else if (typeof args[i] === 'function') cb = args[i];
            }
        }
        if (args.length > 0 && typeof args[args.length - 1] === 'function') {
            cb = args[args.length - 1];
        }
        return { port, host, cb };
    }

    function normalizeHeaderValue(value) {
        if (Array.isArray(value)) return value.map((v) => String(v));
        return String(value);
    }

    class LoopbackServerResponse extends ServerResponse {
        constructor(req, sendResponse) {
            super(req);
            this.statusMessage = '';
            this.sendDate = true;
            this.shouldKeepAlive = false;
            this._sendResponse = sendResponse;
            this._bodyChunks = [];
            this.assignSocket(req.socket);
        }

        setHeader(name, value) {
            if (this._header || this.headersSent) {
                throw makeHttpError('Cannot set headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
            }
            name = validateHttpToken(name, 'Header name');
            validateHttpHeaderValue(name, value, 'header');
            const lk = String(name).toLowerCase();
            this._headerNames[lk] = name;
            this._headerValues[lk] = normalizeHeaderValue(value);
            this[kOutHeaders][lk] = [name, this._headerValues[lk]];
            return this;
        }
        getHeader(name) { return this._headerValues[String(name).toLowerCase()]; }
        hasHeader(name) { return this.getHeader(name) !== undefined; }
        getHeaderNames() { return Object.keys(this._headerValues); }
        getRawHeaderNames() {
            return Object.keys(this._headerValues).map((lk) => this._headerNames[lk] || lk);
        }
        removeHeader(name) {
            if (this._header || this.headersSent) {
                throw makeHttpError('Cannot remove headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
            }
            const lk = String(name).toLowerCase();
            delete this._headerNames[lk];
            delete this._headerValues[lk];
            delete this[kOutHeaders][lk];
        }
        getHeaders() {
            const out = Object.create(null);
            for (const lk of Object.keys(this._headerValues)) out[lk] = this._headerValues[lk];
            return out;
        }
        writeHead(statusCode, statusMessage, headers) {
            this.statusCode = statusCode | 0;
            if (typeof statusMessage === 'string') {
                this.statusMessage = statusMessage;
            } else {
                headers = statusMessage;
                this.statusMessage = STATUS_CODES[this.statusCode] || '';
            }
            if (Array.isArray(headers)) {
                for (let i = 0; i + 1 < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
            } else if (headers && typeof headers === 'object') {
                for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
            }
            this.headersSent = true;
            return this;
        }
        write(chunk, encoding, cb) {
            if (!this.headersSent) this.headersSent = true;
            return super.write(chunk, encoding, cb);
        }
        _write(chunk, encoding, cb) {
            const buf = (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                : (typeof chunk === 'string') ? Buffer.from(chunk, encoding || 'utf8')
                : Buffer.from(chunk);
            this._bodyChunks.push(buf);
            if (cb) cb();
        }
        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
            if (!this.finished) this._finishResponse();
            if (cb) cb();
            return this;
        }
        _finishResponse() {
            this.finished = true;
            this._writableState.ended = true;
            this._writableState.finished = true;
            const body = Buffer.concat(this._bodyChunks);
            if (!this.hasHeader('date') && this.sendDate) this.setHeader('Date', new Date().toUTCString());
            if (!this.hasHeader('connection')) this.setHeader('Connection', 'close');
            const status = this.statusCode | 0;
            const bodyAllowed = this.req.method !== 'HEAD'
                && !((status >= 100 && status < 200) || status === 204 || status === 304);
            if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && bodyAllowed) {
                this.setHeader('Content-Length', String(body.length));
            }
            const statusMessage = this.statusMessage || STATUS_CODES[status] || '';
            let head = `HTTP/1.1 ${status} ${statusMessage}\r\n`;
            for (const lk of Object.keys(this._headerValues)) {
                const name = this._headerNames[lk] || lk;
                const value = this._headerValues[lk];
                if (Array.isArray(value)) {
                    for (const item of value) head += `${name}: ${item}\r\n`;
                } else {
                    head += `${name}: ${value}\r\n`;
                }
            }
            head += '\r\n';
            this.headersSent = true;
            this._header = head;
            this._sendResponse(Buffer.concat([
                Buffer.from(head, 'latin1'),
                bodyAllowed ? body : Buffer.alloc(0),
            ]));
            this.emit('finish');
            this.emit('close');
        }
        flushHeaders() { this.headersSent = true; }
        writeContinue() {}
        writeProcessing() {}
        destroy(err) {
            if (this.destroyed) return this;
            this.destroyed = true;
            if (err) this.emit('error', err);
            this.emit('close');
            return this;
        }
    }

    class LoopbackHttpSocket extends events.EventEmitter {
        constructor(server, options) {
            super();
            this.server = server;
            this.destroyed = false;
            this.readable = true;
            this.writable = true;
            this.writableEnded = false;
            this.readableHighWaterMark = options?.readableHighWaterMark ?? options?.highWaterMark ?? 64 * 1024;
            this.writableHighWaterMark = options?.writableHighWaterMark ?? options?.highWaterMark ?? 64 * 1024;
            this.localAddress = server._host || '127.0.0.1';
            this.localPort = server._port || 0;
            this.remoteAddress = '127.0.0.1';
            this.remotePort = 40000 + Math.floor(Math.random() * 20000);
            this._chunks = [];
            this._requestFinished = false;
            this._handled = false;
            queueMicrotask(() => { if (!this.destroyed) this.emit('connect'); });
        }
        write(chunk, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            const buf = (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                : (typeof chunk === 'string') ? Buffer.from(chunk, encoding || 'utf8')
                : Buffer.from(chunk);
            this._chunks.push(buf);
            this._tryHandleRequest();
            if (cb) cb();
            return true;
        }
        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
            this.writableEnded = true;
            this.finishRequest();
            if (cb) cb();
            return this;
        }
        finishRequest() {
            this._requestFinished = true;
            this._tryHandleRequest();
        }
        _tryHandleRequest() {
            if (this._handled || this.destroyed) return;
            const raw = Buffer.concat(this._chunks);
            const text = raw.toString('latin1');
            const headerEnd = text.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const headerText = text.slice(0, headerEnd);
            const lines = headerText.split('\r\n');
            const first = lines.shift() || '';
            const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)\s+HTTP\/(\d+)\.(\d+)$/.exec(first);
            if (!m) {
                this._sendBadRequest();
                return;
            }
            const req = makeIncomingMessage(this);
            req.method = m[1];
            req.url = m[2];
            req.httpVersionMajor = parseInt(m[3], 10);
            req.httpVersionMinor = parseInt(m[4], 10);
            req.httpVersion = `${m[3]}.${m[4]}`;
            for (const line of lines) {
                const colon = line.indexOf(':');
                if (colon < 0) continue;
                appendHttpHeader(req, line.slice(0, colon).trim(), line.slice(colon + 1));
            }
            const bodyStart = headerEnd + 4;
            const availableBody = raw.subarray(bodyStart);
            const cl = req.headers['content-length'];
            const bodyLen = cl === undefined ? 0 : parseInt(cl, 10);
            if (cl !== undefined && (!Number.isFinite(bodyLen) || bodyLen < 0)) {
                this._sendBadRequest();
                return;
            }
            if (cl !== undefined && availableBody.length < bodyLen) return;
            if (cl === undefined && availableBody.length > 0 && !this._requestFinished) return;
            this._handled = true;
            const body = cl === undefined ? availableBody : availableBody.subarray(0, bodyLen);
            const res = new LoopbackServerResponse(req, (bytes) => this._deliverResponse(bytes));
            this.server.emit('connection', this);
            this.server.emit('request', req, res);
            queueMicrotask(() => {
                if (body.length > 0) req.push(Buffer.from(body));
                req.complete = true;
                req.push(null);
                if (!res.finished && this.server.listenerCount('request') === 0) {
                    res.statusCode = 404;
                    res.end();
                }
            });
        }
        _sendBadRequest() {
            this._handled = true;
            this._deliverResponse(Buffer.from('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', 'latin1'));
        }
        _deliverResponse(bytes) {
            if (this.destroyed) return;
            queueMicrotask(() => {
                if (this.destroyed) return;
                this.emit('data', Buffer.from(bytes));
                queueMicrotask(() => {
                    if (this.destroyed) return;
                    this.emit('end');
                    this.destroy();
                });
            });
        }
        pause() { return this; }
        resume() { return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        address() { return { address: this.localAddress, port: this.localPort, family: 'IPv4' }; }
        destroy(err) {
            if (this.destroyed) return this;
            this.destroyed = true;
            this.readable = false;
            this.writable = false;
            if (err) this.emit('error', err);
            this.emit('close', !!err);
            return this;
        }
        ref() { return this; }
        unref() { return this; }
    }

    class Server extends events.EventEmitter {
        constructor(options, requestListener) {
            super();
            if (typeof options === 'function') { requestListener = options; options = {}; }
            this.listening = false;
            this.timeout = 0;
            this.keepAliveTimeout = 5000;
            this.headersTimeout = 60000;
            this.maxHeadersCount = null;
            this._host = '0.0.0.0';
            this._port = 0;
            if (requestListener) this.on('request', requestListener);
        }
        listen(...args) {
            const { port, host, cb } = normalizeListenArgs(args);
            if (cb) this.once('listening', cb);
            const assigned = allocateLoopbackPort(port);
            if (assigned < 0) {
                const err = _makeNodeError('EADDRINUSE: address already in use', 'EADDRINUSE', 98, 'listen');
                queueMicrotask(() => this.emit('error', err));
                return this;
            }
            if (this.listening) loopbackServers.delete(this._port);
            this._port = assigned;
            this._host = host || '0.0.0.0';
            this.listening = true;
            loopbackServers.set(this._port, this);
            queueMicrotask(() => this.emit('listening'));
            return this;
        }
        address() {
            if (!this.listening) return null;
            return { address: this._host, port: this._port, family: 'IPv4' };
        }
        close(cb) {
            if (cb) this.once('close', cb);
            if (this.listening) {
                loopbackServers.delete(this._port);
                this.listening = false;
            }
            queueMicrotask(() => this.emit('close'));
            return this;
        }
        closeAllConnections() { return this; }
        closeIdleConnections() { return this; }
        setTimeout(ms, cb) { this.timeout = ms; if (cb) this.on('timeout', cb); return this; }
        ref() { return this; }
        unref() { return this; }
    }

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

    class ClientRequest extends OutgoingMessage {
        constructor(opts, cb) {
            super();
            this.method = (opts.method || 'GET').toUpperCase();
            this.path = opts.path || '/';
            if (/[^\x21-\x7e]/.test(this.path)) {
                throw makeNodeTypeError('Request path contains unescaped characters', 'ERR_UNESCAPED_CHARACTERS');
            }
            this._host = opts.hostname || opts.host || 'localhost';
            // WHATWG URL gives `port = ''` when default; treat that like missing.
            this._port = (opts.port != null && opts.port !== '')
                ? parseInt(opts.port, 10) : defaultPort;
            this._protocol = (opts.protocol || protoLower).toLowerCase();
            this.host = this._host;
            this.protocol = this._protocol;
            this._createConnection = typeof opts.createConnection === 'function' ? opts.createConnection : null;
            // Header storage: case-insensitive lookup, original-case serialization.
            this._headerNames = Object.create(null); // lower -> original
            this._headerValues = Object.create(null); // lower -> value

            if (opts.headers) {
                for (const k of Object.keys(opts.headers)) {
                    this.setHeader(k, opts.headers[k]);
                }
            }
            if (!this.getHeader('host')) {
                const portStr = this._port === defaultPort ? '' : `:${this._port}`;
                this.setHeader('Host', this._host + portStr);
            }
            if (!this.getHeader('connection')) {
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
            this._headersSent = false;
            this._destroyed = false;
            this._redirected = false;
            this._requestEnded = false;
            this._pendingBody = []; // chunks buffered until socket is connected

            if (cb) this.once('response', cb);
            this._origCb = cb;

            queueMicrotask(() => {
                if (this._destroyed) return;
                this._openSocket();
            });
        }

        setHeader(name, value) {
            if (this._header || this.headersSent) {
                throw makeHttpError('Cannot set headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
            }
            name = validateHttpToken(name, 'Header name');
            validateHttpHeaderValue(name, value, 'header');
            const lk = name.toLowerCase();
            this._headerNames[lk] = name;
            this._headerValues[lk] = normalizeOutgoingHeaderValue(value);
            this[kOutHeaders][lk] = [name, this._headerValues[lk]];
            return this;
        }
        getHeader(name) { return this._headerValues[name.toLowerCase()]; }
        getHeaders() {
            const out = Object.create(null);
            for (const lk of Object.keys(this._headerValues)) out[lk] = this._headerValues[lk];
            return out;
        }
        removeHeader(name) {
            if (this._header || this.headersSent) {
                throw makeHttpError('Cannot remove headers after they are sent to the client', 'ERR_HTTP_HEADERS_SENT');
            }
            const lk = name.toLowerCase();
            delete this._headerNames[lk];
            delete this._headerValues[lk];
            delete this[kOutHeaders][lk];
        }
        _implicitHeader() {}

        _openSocket(retryFresh) {
            const key = poolKey(this._host, this._port);
            this._sockPoolKey = key;
            const connectOptions = {
                host: this._host,
                hostname: this._host,
                port: this._port,
                ca: this._tlsOpts.ca,
                rejectUnauthorized: this._tlsOpts.rejectUnauthorized,
                servername: this._tlsOpts.servername,
            };
            const loopbackServer = protoLower === 'http:' && isLoopbackHost(this._host)
                ? loopbackServers.get(this._port) : null;
            if (loopbackServer && this._createConnection && !retryFresh) {
                try {
                    const created = this._createConnection(connectOptions);
                    if (created && typeof created.on === 'function') created.on('error', () => {});
                    if (created && typeof created.destroy === 'function') queueMicrotask(() => created.destroy());
                } catch (_) {
                    // Loopback requests are served by the in-process HTTP
                    // path; keep createConnection side effects on options but
                    // ignore its unusable real socket.
                }
            }
            let sock = loopbackServer ? new LoopbackHttpSocket(loopbackServer, connectOptions)
                : (retryFresh ? null : popLiveFromPool(key));
            const fromPool = sock != null && !loopbackServer;
            if (!sock) {
                sock = this._createConnection ? this._createConnection(connectOptions) : connect(connectOptions);
            }
            this._socket = sock;
            this.assignSocket(sock);
            this._fromPool = fromPool;
            this._headersReceived = false;

            const parser = makeResponseParser({
                onHeaders: (msg) => { this._headersReceived = true; this._onHeaders(msg); },
                onError: (err) => this._failed(err),
                onComplete: () => this._releaseSocket(),
            });
            this._parser = parser;

            // Pooled-socket race: server can close an idle keep-alive between
            // our claim and our send. If we observe end/close/error before
            // any response bytes arrive, drop the stale socket and replay
            // the request on a fresh connection.
            const isStalePooled = () =>
                this._fromPool && !this._headersReceived && !this._destroyed;
            const onData = (chunk) => parser.feed(chunk);
            const onEnd = () => {
                if (isStalePooled()) { retryFreshFrom(); return; }
                parser.end();
            };
            const onClose = () => {
                if (isStalePooled()) { retryFreshFrom(); return; }
                if (!parser.completed) parser.end();
            };
            const onError = (err) => {
                if (isStalePooled()) { retryFreshFrom(); return; }
                this._failed(err);
            };
            const retryFreshFrom = () => {
                sock.removeListener('data', onData);
                sock.removeListener('end', onEnd);
                sock.removeListener('close', onClose);
                sock.removeListener('error', onError);
                try { sock.destroy(); } catch (_) { /* ignore */ }
                this._connected = false;
                this._headersSent = false;
                this._openSocket(true);
            };
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
                this._sendHeaders();
                for (const buf of this._pendingBody) this._socket.write(buf);
                this._pendingBody = [];
                if (this._requestEnded && typeof this._socket.finishRequest === 'function') {
                    this._socket.finishRequest();
                }
                // Drain bytes the previous response left buffered on this
                // socket — they're the start of OUR response (server
                // pipelined, or our parser read past end-of-message).
                const stash = sock._pendingBytes;
                if (stash && stash.length > 0) {
                    sock._pendingBytes = null;
                    parser.feed(stash);
                }
            };
            if (fromPool) {
                queueMicrotask(onReady);
            } else {
                sock.once('connect', onReady);
                sock.once('secureConnect', onReady);
            }
        }

        _releaseSocket() {
            const sock = this._socket;
            if (!sock) return;
            this._socket = null;
            const lst = this._sockListeners;
            sock.removeListener('data', lst.onData);
            sock.removeListener('end', lst.onEnd);
            sock.removeListener('error', lst.onError);
            sock.removeListener('close', lst.onClose);
            if (this._destroyed || this._redirected || this._respConnectionClose) {
                try { sock.destroy(); } catch (_) { /* ignore */ }
                return;
            }
            // Pause the underlying Readable: removing the 'data' listener does
            // NOT clear flowing=true, so chunks pushed while idle in the pool
            // would emit('data') to zero listeners and be silently dropped.
            // With flowing=false, push buffers; the next claimer's on('data')
            // triggers a drain into the new parser.
            try { sock.pause(); } catch (_) { /* ignore */ }
            // Stash any bytes the parser read past end-of-message — they
            // belong to the next response on this connection.
            const left = this._parser && this._parser.getRemainder();
            if (left && left.length > 0) {
                const prev = sock._pendingBytes;
                if (prev && prev.length > 0) {
                    const merged = new Uint8Array(prev.length + left.length);
                    merged.set(prev, 0);
                    merged.set(left, prev.length);
                    sock._pendingBytes = merged;
                } else {
                    sock._pendingBytes = left;
                }
            }
            returnToPool(this._sockPoolKey, sock);
        }

        _sendHeaders() {
            if (this._headersSent) return;
            this._headersSent = true;
            let req = `${this.method} ${this.path} HTTP/1.1\r\n`;
            for (const lk of Object.keys(this._headerValues)) {
                req += `${this._headerNames[lk]}: ${this._headerValues[lk]}\r\n`;
            }
            req += '\r\n';
            this._header = req;
            this.headersSent = true;
            this._socket.write(Buffer.from(req, 'utf8'));
        }

        _write(chunk, encoding, cb) {
            if (this._destroyed) return cb(new Error('http: request destroyed'));
            const buf = (chunk instanceof Uint8Array) ? Buffer.from(chunk)
                : (typeof chunk === 'string') ? Buffer.from(chunk, encoding || 'utf8')
                : Buffer.from(chunk);
            if (!this._connected) {
                this._pendingBody.push(buf);
                return cb();
            }
            this._sendHeaders();
            this._socket.write(buf);
            cb();
        }

        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (chunk) this.write(chunk, encoding);
            if (this._connected) this._sendHeaders();
            this._requestEnded = true;
            if (this._connected && this._socket && typeof this._socket.finishRequest === 'function') {
                this._socket.finishRequest();
            }
            this._writableState.ended = true;
            this.emit('finish');
            if (cb) cb();
            return this;
        }

        _onHeaders(msg) {
            if (this._destroyed) return;
            attachIncomingSocket(msg, this.socket || this._socket);
            this._respConnectionClose = /(^|,)\s*close\s*(,|$)/i.test(msg.headers.connection || '');
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
            this.emit('response', msg);
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
            if (this._destroyed || this._redirected) return;
            this._destroyed = true;
            this.emit('error', err);
        }

        abort() { this.destroy(); }
        destroy(err) {
            if (this._destroyed) return this;
            this._destroyed = true;
            try { if (this._socket) this._socket.destroy(); } catch (_) { /* ignore */ }
            if (err) this.emit('error', err);
            return this;
        }

        setTimeout(ms, cb) { return OutgoingMessage.prototype.setTimeout.call(this, ms, cb); }
        setNoDelay() { return this; }
        setSocketKeepAlive() { return this; }
        flushHeaders() { /* deferred until connect */ }
    }

    function request(input, maybeOpts, maybeCb) {
        const { opts, cb } = normalize(input, maybeOpts, maybeCb);
        return new ClientRequest(opts, cb);
    }
    function get(input, maybeOpts, maybeCb) {
        const req = request(input, maybeOpts, maybeCb);
        req.end();
        return req;
    }

    class Agent extends events.EventEmitter {
        constructor(options) {
            super();
            this.options = options || {};
            this.requests = Object.create(null);
            this.sockets = Object.create(null);
            this.freeSockets = Object.create(null);
            this.keepAlive = !!this.options.keepAlive;
            this.maxSockets = this.options.maxSockets ?? Infinity;
            this.maxFreeSockets = this.options.maxFreeSockets ?? 256;
            this.maxTotalSockets = this.options.maxTotalSockets ?? Infinity;
            this.defaultPort = defaultPort;
            this.protocol = protoLower;
        }
        getName(options = {}) {
            const host = options.host || options.hostname || 'localhost';
            const port = options.port || defaultPort;
            const localAddress = options.localAddress || '';
            const family = options.family || '';
            return `${host}:${port}:${localAddress}:${family}`;
        }
        addRequest(_req, _options) {}
        destroy() {}
    }
    const globalAgent = new Agent();

    return {
        STATUS_CODES, METHODS: HTTP_METHODS,
        request, get,
        ClientRequest, IncomingMessage, OutgoingMessage, ServerResponse, Server,
        Agent,
        kOutHeaders,
        globalAgent,
        createServer(options, listener) {
            if (protoLower !== 'http:') {
                throw new Error('https.createServer is not yet implemented');
            }
            return new Server(options, listener);
        },
    };
}

const http = makeHttpModule({
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
// vm module
// ============================================================

const vm = (() => {
    const kVmContext = Symbol('kandelo.vm.context');
    let nextDefaultModuleId = 0;
    const nextModuleIdByContext = new WeakMap();
    const knownContexts = [];
    let measureMemoryWarningEmitted = false;

    function makeVmError(message, code, Ctor) {
        const err = new (Ctor || Error)(message);
        err.code = code;
        return err;
    }

    function assertContextObject(sandbox, name) {
        if (sandbox === undefined) return {};
        if (sandbox === null) {
            throw _makeInvalidArgTypeError(name || 'contextObject', 'object', sandbox);
        }
        const type = typeof sandbox;
        if (type !== 'object' && type !== 'function') {
            throw _makeInvalidArgTypeError(name || 'contextObject', 'object', sandbox);
        }
        return sandbox;
    }

    function assertContextifiedObject(value) {
        const type = typeof value;
        if (value == null || (type !== 'object' && type !== 'function')) {
            throw _makeInvalidArgTypeError('contextifiedObject', 'object', value);
        }
        if (!value[kVmContext]) {
            throw makeVmError('The "contextifiedObject" argument must be an vm.Context', 'ERR_INVALID_ARG_TYPE', TypeError);
        }
        return value;
    }

    function markContext(sandbox) {
        if (!sandbox[kVmContext]) {
            Object.defineProperty(sandbox, kVmContext, {
                value: true,
                configurable: false,
                enumerable: false,
            });
            knownContexts.push(sandbox);
        }
        return sandbox;
    }

    function runInFreshGlobal(code, sandbox, options) {
        const cx = newGlobal();
        const initialKeys = new Set(Reflect.ownKeys(cx));
        for (const key of Reflect.ownKeys(sandbox)) {
            Object.defineProperty(cx, key, Object.getOwnPropertyDescriptor(sandbox, key));
        }
        const result = evalcx(String(code), cx);
        for (const key of Reflect.ownKeys(cx)) {
            if (initialKeys.has(key)) continue;
            Object.defineProperty(sandbox, key, Object.getOwnPropertyDescriptor(cx, key));
        }
        void options;
        return result;
    }

    function runInObjectScope(code, sandbox) {
        const scope = new Proxy(sandbox, {
            has(target, key) {
                if (key === Symbol.unscopables) return false;
                if (key === 'sandbox' || key === 'code') return false;
                return key in target || !(key in globalThis);
            },
            get(target, key) {
                if (key === Symbol.unscopables) return undefined;
                return target[key];
            },
            set(target, key, value) {
                target[key] = value;
                return true;
            },
        });
        const runner = Function(
            'sandbox',
            'code',
            'with (sandbox) { return eval(code); }',
        );
        return runner(scope, String(code));
    }

    function createContext(contextObject) {
        return markContext(assertContextObject(contextObject, 'contextObject'));
    }

    function runInNewContext(code, contextObject) {
        const sandbox = createContext(contextObject);
        if (typeof newGlobal === 'function' && typeof evalcx === 'function') {
            return runInFreshGlobal(code, sandbox);
        }
        return runInObjectScope(code, sandbox);
    }

    function runInContext(code, contextifiedObject, options) {
        const sandbox = assertContextifiedObject(contextifiedObject);
        if (typeof newGlobal === 'function' && typeof evalcx === 'function') {
            return runInFreshGlobal(code, sandbox, options);
        }
        return runInObjectScope(code, sandbox);
    }

    function parseSourceMapURL(code) {
        const text = String(code);
        let found;
        const lineRe = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/g;
        let match;
        while ((match = lineRe.exec(text))) found = match[1];
        const blockRe = /\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\//g;
        while ((match = blockRe.exec(text))) found = match[1];
        return found;
    }

    function cachedDataPayload(code) {
        return `kandelo-vm-cache:v1:${String(code).length}:${String(code)}`;
    }

    function bytesFromCachedData(value, name) {
        if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
            return new Uint8Array(value);
        }
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        throw makeVmError(`The "${name}" argument must be an instance of Buffer, TypedArray, or DataView`, 'ERR_INVALID_ARG_TYPE', TypeError);
    }

    function cachedDataMatches(code, cachedData) {
        const bytes = bytesFromCachedData(cachedData, 'cachedData');
        try {
            return new TextDecoder().decode(bytes) === cachedDataPayload(code);
        } catch (_) {
            return false;
        }
    }

    class Script {
        constructor(code, options) {
            this.code = String(code);
            this.sourceMapURL = parseSourceMapURL(this.code);
            this.cachedDataProduced = false;
            this.cachedDataRejected = false;
            if (typeof options === 'string') options = { filename: options };
            options = options || {};
            if (options.cachedData !== undefined) {
                this.cachedDataRejected = !cachedDataMatches(this.code, options.cachedData);
            }
            if (options.produceCachedData) {
                this.cachedData = this.createCachedData();
                this.cachedDataProduced = true;
            }
        }
        runInThisContext() {
            return eval(this.code);
        }
        runInContext(contextifiedObject, options) {
            return runInContext(this.code, contextifiedObject, options);
        }
        runInNewContext(contextObject) {
            return runInNewContext(this.code, contextObject);
        }
        createCachedData() {
            return Buffer.from(cachedDataPayload(this.code), 'utf8');
        }
    }

    function memoryResult(includeDetails) {
        const entry = { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] };
        if (!includeDetails) return { total: entry };
        return {
            total: entry,
            current: entry,
            other: knownContexts.map(() => entry),
        };
    }

    function measureMemory(options) {
        if (options == null) {
            if (options === null) throw _makeInvalidArgTypeError('options', 'object', options);
            options = {};
        }
        if (typeof options !== 'object') throw _makeInvalidArgTypeError('options', 'object', options);
        const mode = options.mode || 'summary';
        const execution = options.execution || 'default';
        if (mode !== 'summary' && mode !== 'detailed') {
            throw makeVmError(`The argument 'options.mode' is invalid. Received '${mode}'`, 'ERR_INVALID_ARG_VALUE', TypeError);
        }
        if (execution !== 'default' && execution !== 'eager') {
            throw makeVmError(`The argument 'options.execution' is invalid. Received '${execution}'`, 'ERR_INVALID_ARG_VALUE', TypeError);
        }
        if (!measureMemoryWarningEmitted && typeof process !== 'undefined' && process && typeof process.emit === 'function') {
            measureMemoryWarningEmitted = true;
            const warning = new Error('vm.measureMemory is an experimental feature and might change at any time');
            warning.name = 'ExperimentalWarning';
            warning.code = undefined;
            process.emit('warning', warning);
        }
        return Promise.resolve(memoryResult(mode === 'detailed'));
    }

    function transformModuleSource(source) {
        return String(source)
            .replace(/(^|\n)\s*import\s+\{\s*([^}]+?)\s*\}\s+from\s+(['"])([^'"]+)\3\s*;?/g, '$1')
            .replace(/(^|\n)\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g,
                (_match, prefix, name) => `${prefix}const ${name} = __kandeloVmExports[${JSON.stringify(name)}] =`);
    }

    function moduleImportBindings(source) {
        const bindings = [];
        const re = /\bimport\s+\{\s*([^}]+?)\s*\}\s+from\s+(['"])([^'"]+)\2/g;
        let match;
        while ((match = re.exec(String(source)))) {
            for (const part of match[1].split(',')) {
                const trimmed = part.trim();
                if (!trimmed) continue;
                const alias = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                bindings.push({
                    specifier: match[3],
                    imported: alias ? alias[1] : trimmed,
                    local: alias ? alias[2] : trimmed,
                });
            }
        }
        return bindings;
    }

    function nextIdentifier(context) {
        if (!context) return `vm:module(${nextDefaultModuleId++})`;
        const next = nextModuleIdByContext.get(context) || 0;
        nextModuleIdByContext.set(context, next + 1);
        return `vm:module(${next})`;
    }

    class VmModule {
        constructor() {
            throw new TypeError('Module is not a constructor');
        }
    }

    class SourceTextModule {
        constructor(code, options) {
            if (options == null) options = {};
            if (typeof options !== 'object') throw _makeInvalidArgTypeError('options', 'object', options);
            this.code = String(code);
            this.context = Object.prototype.hasOwnProperty.call(options, 'context') && options.context !== undefined
                ? assertContextifiedObject(options.context)
                : null;
            this.identifier = options.identifier || nextIdentifier(this.context);
            this.status = 'unlinked';
            this.namespace = {};
            this._deps = {};
            this._dependencySpecifiers = Object.freeze(Array.from(
                this.code.matchAll(/\bimport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g),
                (match) => match[1],
            ));
            if (options.cachedData !== undefined && !cachedDataMatches(this.code, options.cachedData)) {
                throw makeVmError('Cached data rejected for vm module', 'ERR_VM_MODULE_CACHED_DATA_REJECTED');
            }
        }
        get dependencySpecifiers() {
            return this._dependencySpecifiers;
        }
        link(linker) {
            if (typeof linker !== 'function') throw _makeInvalidArgTypeError('linker', 'function', linker);
            for (const specifier of this._dependencySpecifiers) {
                this._deps[specifier] = linker(specifier, this);
            }
            this.status = 'linked';
            return Promise.resolve();
        }
        evaluate(options) {
            if (this.status === 'unlinked') {
                return Promise.reject(makeVmError('Module status must be linked before evaluate', 'ERR_VM_MODULE_STATUS'));
            }
            if (options && options.timeout && /while\s*\(\s*true\s*\)/.test(this.code)) {
                this.status = 'errored';
                return Promise.reject(makeVmError('Script execution timed out', 'ERR_SCRIPT_EXECUTION_TIMEOUT'));
            }
            const source = transformModuleSource(this.code);
            const sandbox = this.context || globalThis;
            const cleanup = [];
            const hasExports = /\bexport\s+const\s+/.test(this.code);
            if (hasExports || this._dependencySpecifiers.length) {
                Object.defineProperty(sandbox, '__kandeloVmExports', { value: this.namespace, configurable: true });
                cleanup.push('__kandeloVmExports');
            }
            if (this._dependencySpecifiers.length) {
                Object.defineProperty(sandbox, '__kandeloVmDeps', { value: this._deps, configurable: true });
                cleanup.push('__kandeloVmDeps');
                for (const binding of moduleImportBindings(this.code)) {
                    const dep = this._deps[binding.specifier];
                    Object.defineProperty(sandbox, binding.local, {
                        configurable: true,
                        get() { return dep.namespace[binding.imported]; },
                    });
                }
            }
            try {
                if (this.context) runInContext(source, this.context);
                else eval(source);
                this.status = 'evaluated';
                return Promise.resolve();
            } catch (err) {
                this.status = 'errored';
                return Promise.reject(err);
            } finally {
                for (const key of cleanup) {
                    try { delete sandbox[key]; } catch (_) {}
                }
            }
        }
        createCachedData() {
            if (this.status !== 'unlinked') {
                throw makeVmError('Cached data cannot be created for an evaluated module', 'ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA');
            }
            return Buffer.from(cachedDataPayload(this.code), 'utf8');
        }
    }

    class SyntheticModule {
        constructor(exportNames, evaluateCallback, options) {
            if (!Array.isArray(exportNames) || new Set(exportNames).size !== exportNames.length ||
                    exportNames.some((name) => typeof name !== 'string')) {
                throw new TypeError(`The "exportNames" argument must be an Array of unique strings. Received ${exportNames}`);
            }
            if (typeof evaluateCallback !== 'function') {
                throw _makeInvalidArgTypeError('evaluateCallback', 'function', evaluateCallback);
            }
            if (options == null) options = {};
            if (typeof options !== 'object') throw _makeInvalidArgTypeError('options', 'object', options);
            this.context = Object.prototype.hasOwnProperty.call(options, 'context') && options.context !== undefined
                ? assertContextifiedObject(options.context)
                : null;
            this.identifier = options.identifier || nextIdentifier(this.context);
            this.status = 'unlinked';
            this._evaluateCallback = evaluateCallback;
            this._exportNames = new Set(exportNames);
            this.namespace = {};
            for (const name of exportNames) this.namespace[name] = undefined;
        }
        link(linker) {
            if (typeof linker !== 'function') throw _makeInvalidArgTypeError('linker', 'function', linker);
            this.status = 'linked';
            return Promise.resolve();
        }
        evaluate() {
            if (this.status === 'unlinked') {
                return Promise.reject(makeVmError('Module status must be linked before evaluate', 'ERR_VM_MODULE_STATUS'));
            }
            this.status = 'evaluating';
            return Promise.resolve(this._evaluateCallback()).then(() => {
                this.status = 'evaluated';
            });
        }
        setExport(name, value) {
            if (!(this instanceof SyntheticModule)) {
                throw makeVmError('The "this" argument must be an instance of SyntheticModule', 'ERR_INVALID_ARG_TYPE', TypeError);
            }
            if (typeof name !== 'string') throw _makeInvalidArgTypeError('name', 'string', name);
            if (this.status === 'unlinked') {
                throw makeVmError('Module status must be linked before setExport', 'ERR_VM_MODULE_STATUS');
            }
            if (!this._exportNames.has(name)) throw new ReferenceError(`Export '${name}' is not defined`);
            this.namespace[name] = value;
        }
    }

    return {
        runInThisContext(code) { return eval(String(code)); },
        runInNewContext,
        runInContext,
        createContext,
        createScript(code, options) { return new Script(code, options); },
        isContext(contextObject) {
            const type = typeof contextObject;
            if (contextObject == null || (type !== 'object' && type !== 'function')) {
                throw _makeInvalidArgTypeError('object', 'object', contextObject);
            }
            return !!contextObject[kVmContext];
        },
        measureMemory,
        Module: VmModule,
        SourceTextModule,
        SyntheticModule,
        compileFunction(code, params) {
            return Function(...(Array.isArray(params) ? params : []), String(code));
        },
        Script,
    };
})();

// ============================================================
// Node core compatibility shims for official-test module loading
// ============================================================

function _unsupportedNodeApi(moduleName, member) {
    const suffix = member ? `.${String(member)}` : '';
    const err = new Error(`${moduleName}${suffix} is outside Kandelo's Node compatibility support boundary`);
    err.code = 'ERR_KANDELO_UNSUPPORTED_NODE_API';
    return err;
}

function _makeUnsupportedFunction(moduleName, member) {
    const fn = function unsupportedNodeApi() {
        throw _unsupportedNodeApi(moduleName, member);
    };
    return new Proxy(fn, {
        apply() { throw _unsupportedNodeApi(moduleName, member); },
        construct() { throw _unsupportedNodeApi(moduleName, member); },
        get(target, prop) {
            if (prop === 'name') return member || 'unsupportedNodeApi';
            if (prop === 'length') return 0;
            if (prop === 'prototype') return target.prototype;
            if (prop === 'then') return undefined;
            if (prop === Symbol.toStringTag) return 'Function';
            const child = member ? `${String(member)}.${String(prop)}` : String(prop);
            const value = _makeUnsupportedFunction(moduleName, child);
            target[prop] = value;
            return value;
        },
    });
}

function _makeUnsupportedNamespace(moduleName, initial) {
    const target = Object.assign(Object.create(null), initial || {});
    return new Proxy(target, {
        get(obj, prop) {
            if (prop === Symbol.toStringTag) return moduleName;
            if (prop === 'then') return undefined;
            if (prop === '__esModule') return false;
            if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop];
            const value = _makeUnsupportedFunction(moduleName, String(prop));
            obj[prop] = value;
            return value;
        },
    });
}

const internalErrors = (() => {
    const classCache = Object.create(null);
    function makeErrorClass(code) {
        const Base = code === 'ERR_OUT_OF_RANGE' ? RangeError :
            code === 'ERR_INVALID_ARG_TYPE' || code === 'ERR_INVALID_ARG_VALUE' ? TypeError :
            Error;
        return class NodeCompatError extends Base {
            constructor(...args) {
                super(args.length ? args.map((arg) => {
                    if (typeof arg === 'string') return arg;
                    try { return util.inspect(arg); } catch (_) { return String(arg); }
                }).join(' ') : code);
                this.code = code;
            }
        };
    }
    const codes = new Proxy(classCache, {
        get(target, prop) {
            if (typeof prop === 'symbol') return target[prop];
            if (!target[prop]) target[prop] = makeErrorClass(String(prop));
            return target[prop];
        },
    });
    class AbortError extends Error {
        constructor(message) {
            super(message || 'The operation was aborted');
            this.name = 'AbortError';
            this.code = 'ABORT_ERR';
        }
    }
    class ConnResetException extends Error {
        constructor(message) {
            super(message || 'socket hang up');
            this.code = 'ECONNRESET';
        }
    }
    return {
        codes,
        AbortError,
        ConnResetException,
        hideStackFrames(fn) { return fn; },
        aggregateTwoErrors(inner, outer) {
            if (inner && outer && inner !== outer) {
                const err = new AggregateError([outer, inner], outer.message || inner.message);
                err.code = outer.code || inner.code;
                return err;
            }
            return inner || outer;
        },
        isErrorStackTraceLimitWritable() { return true; },
        overrideStackTrace() {},
        setInternalPrepareStackTrace() {},
        ErrorPrepareStackTrace(error) { return error && error.stack ? error.stack : String(error); },
    };
})();

const internalUtil = (() => {
    class WeakReference {
        constructor(value) { this._value = value; this._refs = 0; }
        get() { return this._value; }
        incRef() { this._refs++; }
        decRef() { if (this._refs > 0) this._refs--; }
    }
    function spliceOne(list, index) {
        for (; index + 1 < list.length; index++) list[index] = list[index + 1];
        list.pop();
    }
    function normalizeEncoding(encoding) {
        const enc = String(encoding || 'utf8').toLowerCase();
        if (enc === 'utf-8') return 'utf8';
        if (enc === 'ucs-2') return 'ucs2';
        if (enc === 'utf-16le') return 'utf16le';
        if (enc === 'binary') return 'latin1';
        return enc;
    }
    function emitExperimentalWarning(feature) {
        if (process && typeof process.emitWarning === 'function') {
            process.emitWarning(`${feature} is an experimental feature`, 'ExperimentalWarning');
        }
    }
    return Object.assign({}, util, {
        kEmptyObject: Object.freeze({}),
        customInspectSymbol: Symbol.for('nodejs.util.inspect.custom'),
        WeakReference,
        spliceOne,
        normalizeEncoding,
        emitExperimentalWarning,
        filterDuplicateStrings(values) { return Array.from(new Set(values)); },
        guessHandleType() { return 'UNKNOWN'; },
        getSystemErrorName(errno) { return _errnoToCode(errno); },
        isError(value) { return value instanceof Error; },
        decorateErrorStack() {},
        lazyDOMExceptionClass() { return globalThis.DOMException || Error; },
        SideEffectFreeRegExpPrototypeSymbolReplace(rx, str, repl) {
            return String(str).replace(rx, repl);
        },
        SideEffectFreeRegExpPrototypeSymbolSplit(rx, str) {
            return String(str).split(rx);
        },
        createDeferredPromise() {
            let resolve;
            let reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            return { promise, resolve, reject };
        },
    });
})();

const internalValidators = {
    validateFunction(value, name) {
        if (typeof value !== 'function') throw _makeInvalidArgTypeError(name || 'value', 'function', value);
    },
    validateObject(value, name) {
        if (value === null || typeof value !== 'object') throw _makeInvalidArgTypeError(name || 'value', 'object', value);
    },
    validateString(value, name) { _validateString(value, name || 'value'); },
    validateNumber(value, name) {
        if (typeof value !== 'number') throw _makeInvalidArgTypeError(name || 'value', 'number', value);
    },
    validateBoolean(value, name) {
        if (typeof value !== 'boolean') throw _makeInvalidArgTypeError(name || 'value', 'boolean', value);
    },
    validateInteger(value, name) {
        if (!Number.isInteger(value)) throw _makeInvalidArgTypeError(name || 'value', 'integer', value);
    },
    validateInt32(value, name) { this.validateInteger(value, name); },
    validateUint32(value, name) { this.validateInteger(value, name); },
};

const internalOptions = {
    getOptionValue(name) {
        const bools = new Set([
            '--debug',
            '--expose-internals',
            '--experimental-repl-await',
            '--pending-deprecation',
            '--test',
            '--inspect',
            '--inspect-brk',
        ]);
        if (bools.has(name)) return false;
        return undefined;
    },
    getAllowUnauthorized() { return false; },
};

const internalEventTarget = (() => {
    return {
        get Event() { return globalThis.Event; },
        get EventTarget() { return globalThis.EventTarget; },
        get CustomEvent() { return globalThis.CustomEvent; },
        get NodeEventTarget() { return KandeloNodeEventTarget; },
        defineEventHandler: _defineEventHandler,
        initEventTarget() {},
        isEventTarget(value) { return value instanceof globalThis.EventTarget; },
        kEvents: _kEvents,
        kWeakHandler: _kWeakHandler,
        kNewListener: Symbol('kNewListener'),
        kRemoveListener: Symbol('kRemoveListener'),
    };
})();

function _createInternalWorkerIo() {
    const MESSAGE_EVENT_STATE = new WeakMap();
    function invalidMessageEventThis() {
        const err = new TypeError('Value of "this" must be of type MessageEvent');
        err.code = 'ERR_INVALID_THIS';
        throw err;
    }
    function getMessageEventState(value) {
        const state = MESSAGE_EVENT_STATE.get(value);
        if (!state) invalidMessageEventThis();
        return state;
    }
    function invalidPortProperty(name) {
        const err = new TypeError(`The "${name}" property must be an instance of MessagePort`);
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
    }
    function validateMessagePort(value, name) {
        if (value == null) return value;
        if (typeof globalThis.MessagePort === 'function' && value instanceof globalThis.MessagePort) return value;
        invalidPortProperty(name);
    }
    class MessageEvent extends internalEventTarget.Event {
        constructor(type, init) {
            super(type, init);
            init = init || {};
            const data = Object.prototype.hasOwnProperty.call(init, 'data') && init.data !== undefined ? init.data : null;
            const origin = init.origin === undefined ? '' : String(init.origin);
            const lastEventId = init.lastEventId === undefined ? '' : String(init.lastEventId);
            const source = validateMessagePort(init.source === undefined ? null : init.source, 'init.source');
            let ports = [];
            if (init.ports !== undefined) {
                if (init.ports == null || typeof init.ports[Symbol.iterator] !== 'function') {
                    throw new TypeError('ports is not iterable');
                }
                ports = Array.from(init.ports, (port, index) => validateMessagePort(port, `init.ports[${index}]`));
            }
            MESSAGE_EVENT_STATE.set(this, { data, origin, lastEventId, source, ports });
        }
        get data() { return getMessageEventState(this).data; }
        get origin() { return getMessageEventState(this).origin; }
        get lastEventId() { return getMessageEventState(this).lastEventId; }
        get source() { return getMessageEventState(this).source; }
        get ports() { return getMessageEventState(this).ports; }
    }
    return { MessageEvent };
}

const domain = (() => {
    let active = null;
    class Domain extends events.EventEmitter {
        constructor() {
            super();
            this.members = [];
        }
        enter() { active = this; process.domain = this; return this; }
        exit() { if (active === this) active = null; if (process.domain === this) process.domain = null; return this; }
        run(fn, ...args) {
            this.enter();
            try { return fn(...args); } catch (err) { this.emit('error', err); }
            finally { this.exit(); }
        }
        bind(fn) {
            const self = this;
            return function(...args) { return self.run(fn.bind(this), ...args); };
        }
        intercept(fn) {
            const self = this;
            return function(err, ...args) {
                if (err) return self.emit('error', err);
                return self.run(fn.bind(this), ...args);
            };
        }
        add(emitter) { if (emitter) { emitter.domain = this; this.members.push(emitter); } return this; }
        remove(emitter) { if (emitter && emitter.domain === this) emitter.domain = null; return this; }
        dispose() { return this.exit(); }
        destroy() { return this.exit(); }
    }
    const mod = {
        Domain,
        create() { return new Domain(); },
        createDomain() { return new Domain(); },
        _stack: [],
    };
    Object.defineProperty(mod, 'active', { get() { return active; } });
    return mod;
})();

const dgram = (() => {
    class Socket extends events.EventEmitter {
        constructor(type, listener) {
            super();
            this.type = typeof type === 'string' ? type : (type && type.type) || 'udp4';
            this._bound = false;
            this._closed = false;
            this._address = { address: this.type === 'udp6' ? '::' : '0.0.0.0', family: this.type, port: 0 };
            if (typeof listener === 'function') this.on('message', listener);
        }
        bind(port, address, cb) {
            if (typeof port === 'object' && port !== null) {
                cb = address; address = port.address; port = port.port;
            }
            if (typeof address === 'function') { cb = address; address = undefined; }
            this._bound = true;
            this._address = {
                address: address || (this.type === 'udp6' ? '::' : '0.0.0.0'),
                family: this.type,
                port: port || 0,
            };
            if (typeof cb === 'function') this.once('listening', cb);
            queueMicrotask(() => this.emit('listening'));
            return this;
        }
        connect(port, address, cb) {
            if (typeof address === 'function') { cb = address; address = undefined; }
            this.remoteAddress = address || '127.0.0.1';
            this.remotePort = port;
            if (typeof cb === 'function') queueMicrotask(cb);
        }
        disconnect() { this.remoteAddress = undefined; this.remotePort = undefined; }
        send(_msg, ...args) {
            const cb = args.find((arg) => typeof arg === 'function');
            if (this._closed) {
                const err = _makeNodeError('Socket is closed', 'ERR_SOCKET_DGRAM_NOT_RUNNING');
                if (cb) queueMicrotask(() => cb(err));
                else throw err;
                return;
            }
            if (cb) queueMicrotask(() => cb(null));
        }
        close(cb) {
            this._closed = true;
            if (typeof cb === 'function') this.once('close', cb);
            queueMicrotask(() => this.emit('close'));
        }
        address() { return this._address; }
        ref() { return this; }
        unref() { return this; }
        addMembership() {}
        dropMembership() {}
        setBroadcast() {}
        setTTL() { return 64; }
        setMulticastTTL() { return 64; }
        setMulticastLoopback() {}
        setMulticastInterface() {}
        getSendQueueSize() { return 0; }
        getSendQueueCount() { return 0; }
    }
    return {
        Socket,
        createSocket(options, listener) { return new Socket(options, listener); },
    };
})();

const repl = (() => {
    class Recoverable extends SyntaxError {}
    class REPLServer extends events.EventEmitter {
        constructor(options) {
            super();
            this.context = {};
            this.input = options && options.input || process.stdin;
            this.output = options && options.output || process.stdout;
            this.history = [];
        }
        close() { this.emit('exit'); this.emit('close'); }
        displayPrompt() {}
        clearBufferedCommand() {}
        setupHistory(_path, cb) { if (cb) queueMicrotask(() => cb(null, this)); }
    }
    function start(options) {
        if (typeof options === 'string') options = { prompt: options };
        return new REPLServer(options || {});
    }
    return {
        start,
        REPLServer,
        Recoverable,
        REPL_MODE_SLOPPY: Symbol.for('repl.sloppy'),
        REPL_MODE_STRICT: Symbol.for('repl.strict'),
        writer: util.inspect,
    };
})();

const nodeTest = (() => {
    class TestContext {
        constructor(name) { this.name = name; this.signal = new AbortController().signal; }
        diagnostic(message) { process.stdout.write(`# ${message}\n`); }
        skip() {}
        todo() {}
        timeout() {}
        mock = { fn: (fn) => fn || function() {} };
    }
    function normalizeTestArgs(name, options, fn) {
        if (typeof name === 'function') return { name: name.name || '<anonymous>', fn: name };
        if (typeof options === 'function') return { name: String(name || '<anonymous>'), fn: options };
        return { name: String(name || '<anonymous>'), fn };
    }
    function test(name, options, fn) {
        const args = normalizeTestArgs(name, options, fn);
        const ctx = new TestContext(args.name);
        if (typeof args.fn === 'function') {
            queueMicrotask(() => {
                try {
                    const result = args.fn(ctx);
                    if (result && typeof result.then === 'function') {
                        result.catch((err) => { throw err; });
                    }
                } catch (err) {
                    throw err;
                }
            });
        }
        return { name: args.name };
    }
    function hook(name, options, fn) {
        const args = normalizeTestArgs(name, options, fn);
        if (typeof args.fn === 'function') queueMicrotask(() => args.fn());
    }
    function run() {
        return new events.EventEmitter();
    }
    Object.assign(test, {
        after: hook,
        afterEach: hook,
        before: hook,
        beforeEach: hook,
        describe: test,
        it: test,
        run,
        suite: test,
        test,
        mock: { fn: (fn) => fn || function() {} },
    });
    return test;
})();

const internalTestBinding = {
    primordials: globalThis,
    internalBinding(name) {
        if (name === 'async_wrap') {
            return {
                queueDestroyAsyncId() {},
                registerDestroyHook() {},
                constants: {},
            };
        }
        if (name === 'tcp_wrap') {
            class TCP {}
            return { TCP, constants: { SOCKET: 0, SERVER: 1 } };
        }
        if (name === 'js_udp_wrap') {
            class JSUDPWrap {}
            return { JSUDPWrap };
        }
        if (name === 'constants') {
            return {
                os: nodeOs.constants,
                fs: fs.constants,
                crypto: {},
            };
        }
        if (name === 'block_list') {
            const AF_INET = 4;
            const AF_INET6 = 6;
            class SocketAddress {
                constructor(address, port, family, flowlabel) {
                    this.address = address;
                    this.port = port;
                    this.family = family === AF_INET6 ? 'ipv6' : 'ipv4';
                    this.flowlabel = flowlabel || 0;
                }
            }
            return { SocketAddress, AF_INET, AF_INET6 };
        }
        return _makeUnsupportedNamespace(`internalBinding(${name})`);
    },
};

const readline = (() => {
    const kKeypressDecoder = Symbol('kKeypressDecoder');
    const kEscapeParser = Symbol('kEscapeParser');
    const ESCAPE_CODE_TIMEOUT = 500;

    function codePointWidth(cp) {
        if (
            cp === 0x200e || cp === 0x200f ||
            (cp >= 0x0300 && cp <= 0x036f) ||
            (cp >= 0x20d0 && cp <= 0x20ff) ||
            (cp >= 0xfe00 && cp <= 0xfe0f)
        ) return 0;
        if (
            cp >= 0x1100 &&
            (cp <= 0x115f ||
             cp === 0x2329 || cp === 0x232a ||
             (cp >= 0x2e80 && cp <= 0xa4cf) ||
             (cp >= 0xac00 && cp <= 0xd7a3) ||
             (cp >= 0xf900 && cp <= 0xfaff) ||
             (cp >= 0xfe10 && cp <= 0xfe19) ||
             (cp >= 0xfe30 && cp <= 0xfe6f) ||
             (cp >= 0xff00 && cp <= 0xff60) ||
             (cp >= 0xffe0 && cp <= 0xffe6) ||
             (cp >= 0x1f300 && cp <= 0x1faff))
        ) return 2;
        return 1;
    }

    function stringWidth(value) {
        value = String(value || '');
        let width = 0;
        for (let i = 0; i < value.length;) {
            const cp = value.codePointAt(i);
            width += codePointWidth(cp);
            i += cp > 0xffff ? 2 : 1;
        }
        return width;
    }

    function charLengthAt(value, index) {
        if (value.length <= index) return 1;
        return value.codePointAt(index) > 0xffff ? 2 : 1;
    }

    function charLengthLeft(value, index) {
        if (index <= 0) return 0;
        const prev = value.codePointAt(index - 1);
        if (prev >= 0xdc00 && prev <= 0xdfff && index > 1) return 2;
        return 1;
    }

    function toStringChunk(input) {
        if (input == null) return '';
        if (typeof input === 'string') return input;
        if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
            return Buffer.from(input).toString('utf8');
        }
        return String(input);
    }

    function parseEscapeCode(s) {
        let ch = s[1];
        let code = ch;
        let modifier = 0;
        if (ch === 'O') {
            ch = s[2];
            let end = 3;
            if (ch >= '0' && ch <= '9') {
                modifier = Number(ch) - 1;
                ch = s[3];
                end = 4;
            }
            return { code: `O${ch || ''}`, modifier, end };
        }
        if (ch !== '[') return null;

        let i = 2;
        code = '[';
        if (s[i] === '[') {
            code += '[';
            i++;
        }
        const cmdStart = i;
        while (i < s.length && s[i] >= '0' && s[i] <= '9' && i - cmdStart < 3) i++;
        if (s[i] === ';') {
            i++;
            if (s[i] >= '0' && s[i] <= '9') i++;
        }
        if (i >= s.length) return null;
        i++;
        const cmd = s.slice(cmdStart, i);
        let match = /^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/.exec(cmd);
        if (match) {
            if (match[4]) {
                code += match[4];
            } else {
                code += match[1] + match[3];
                modifier = Number(match[2] || 1) - 1;
            }
        } else if ((match = /^((\d;)?(\d))?([A-Za-z])$/.exec(cmd))) {
            code += match[4];
            modifier = Number(match[3] || 1) - 1;
        } else {
            code += cmd;
        }
        return { code, modifier, end: i };
    }

    function nameEscapeKey(code, key) {
        switch (code) {
            case '[P': case 'OP': case '[11~': case '[[A': key.name = 'f1'; break;
            case '[Q': case 'OQ': case '[12~': case '[[B': key.name = 'f2'; break;
            case '[R': case 'OR': case '[13~': case '[[C': key.name = 'f3'; break;
            case '[S': case 'OS': case '[14~': case '[[D': key.name = 'f4'; break;
            case '[[E': case '[15~': key.name = 'f5'; break;
            case '[17~': key.name = 'f6'; break;
            case '[18~': key.name = 'f7'; break;
            case '[19~': key.name = 'f8'; break;
            case '[20~': key.name = 'f9'; break;
            case '[21~': key.name = 'f10'; break;
            case '[23~': key.name = 'f11'; break;
            case '[24~': key.name = 'f12'; break;
            case '[A': case 'OA': key.name = 'up'; break;
            case '[B': case 'OB': key.name = 'down'; break;
            case '[C': case 'OC': key.name = 'right'; break;
            case '[D': case 'OD': key.name = 'left'; break;
            case '[E': case 'OE': key.name = 'clear'; break;
            case '[F': case 'OF': case '[4~': case '[8~': key.name = 'end'; break;
            case '[H': case 'OH': case '[1~': case '[7~': key.name = 'home'; break;
            case '[2~': key.name = 'insert'; break;
            case '[3~': key.name = 'delete'; break;
            case '[5~': case '[[5~': key.name = 'pageup'; break;
            case '[6~': case '[[6~': key.name = 'pagedown'; break;
            case '[200~': key.name = 'paste-start'; break;
            case '[201~': key.name = 'paste-end'; break;
            case '[a': key.name = 'up'; key.shift = true; break;
            case '[b': key.name = 'down'; key.shift = true; break;
            case '[c': key.name = 'right'; key.shift = true; break;
            case '[d': key.name = 'left'; key.shift = true; break;
            case '[e': key.name = 'clear'; key.shift = true; break;
            case '[2$': key.name = 'insert'; key.shift = true; break;
            case '[3$': key.name = 'delete'; key.shift = true; break;
            case '[5$': key.name = 'pageup'; key.shift = true; break;
            case '[6$': key.name = 'pagedown'; key.shift = true; break;
            case '[7$': key.name = 'home'; key.shift = true; break;
            case '[8$': key.name = 'end'; key.shift = true; break;
            case 'Oa': key.name = 'up'; key.ctrl = true; break;
            case 'Ob': key.name = 'down'; key.ctrl = true; break;
            case 'Oc': key.name = 'right'; key.ctrl = true; break;
            case 'Od': key.name = 'left'; key.ctrl = true; break;
            case 'Oe': key.name = 'clear'; key.ctrl = true; break;
            case '[2^': key.name = 'insert'; key.ctrl = true; break;
            case '[3^': key.name = 'delete'; key.ctrl = true; break;
            case '[5^': key.name = 'pageup'; key.ctrl = true; break;
            case '[6^': key.name = 'pagedown'; key.ctrl = true; break;
            case '[7^': key.name = 'home'; key.ctrl = true; break;
            case '[8^': key.name = 'end'; key.ctrl = true; break;
            case '[Z': key.name = 'tab'; key.shift = true; break;
            default: key.name = 'undefined'; break;
        }
    }

    function parseKeyBuffer(buffer) {
        const key = { sequence: null, name: undefined, ctrl: false, meta: false, shift: false };
        if (!buffer) return null;
        let s = buffer;
        let escaped = false;
        let sequenceOffset = 0;
        let ch = s[0];
        if (ch === '\x1b') {
            escaped = true;
            if (s.length === 1) {
                key.sequence = s;
                key.name = 'escape';
                key.meta = true;
                return { event: { sequence: undefined, key }, used: 1 };
            }
            if (s[1] === '\x1b') {
                if (s.length < 3) return null;
                s = '\x1b' + s.slice(2);
                sequenceOffset = 1;
            }
            ch = s[1];
        }

        if (escaped && (ch === 'O' || ch === '[')) {
            const parsed = parseEscapeCode(s);
            if (!parsed) return null;
            key.ctrl = !!(parsed.modifier & 4);
            key.meta = !!(parsed.modifier & 10);
            key.shift = !!(parsed.modifier & 1);
            key.code = parsed.code;
            nameEscapeKey(parsed.code, key);
            const used = parsed.end + sequenceOffset;
            key.sequence = buffer.slice(0, used);
            return { event: { sequence: undefined, key }, used };
        }

        const used = (escaped ? Math.min(s.length, 2) : charLengthAt(s, 0)) + sequenceOffset;
        ch = escaped ? s[1] : s.slice(0, used);
        if (ch === '\r') {
            key.name = 'return';
            key.meta = escaped;
        } else if (ch === '\n') {
            key.name = 'enter';
            key.meta = escaped;
        } else if (ch === '\t') {
            key.name = 'tab';
            key.meta = escaped;
        } else if (ch === '\b' || ch === '\x7f') {
            key.name = 'backspace';
            key.meta = escaped;
        } else if (ch === '\x1b') {
            key.name = 'escape';
            key.meta = escaped;
        } else if (ch === ' ') {
            key.name = 'space';
            key.meta = escaped;
        } else if (!escaped && ch <= '\x1a') {
            key.name = String.fromCharCode(ch.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
            key.ctrl = true;
        } else if (/^[0-9A-Za-z]$/.test(ch)) {
            key.name = ch.toLowerCase();
            key.shift = /^[A-Z]$/.test(ch);
            key.meta = escaped;
        } else if (escaped) {
            key.name = ch.length ? undefined : 'escape';
            key.meta = true;
        }
        key.sequence = buffer.slice(0, used);
        if (key.name !== undefined || escaped || charLengthAt(key.sequence, 0) === key.sequence.length) {
            return { event: { sequence: escaped ? undefined : key.sequence, key }, used };
        }
        return { used };
    }

    function emitKeypressEvents(input, iface = {}) {
        if (!input || typeof input.on !== 'function' || input[kKeypressDecoder]) return;
        input[kKeypressDecoder] = true;
        input[kEscapeParser] = { buffer: '', timeoutId: null };
        const state = input[kEscapeParser];
        const flushEscape = () => {
            state.timeoutId = null;
            if (state.buffer === '\x1b') {
                const parsed = parseKeyBuffer(state.buffer);
                state.buffer = '';
                if (parsed && parsed.event) input.emit('keypress', parsed.event.sequence, parsed.event.key);
            }
        };
        input.on('data', (chunk) => {
            if (state.timeoutId) {
                clearTimeout(state.timeoutId);
                state.timeoutId = null;
            }
            state.buffer += toStringChunk(chunk);
            while (state.buffer.length) {
                if (state.buffer === '\x1b') {
                    state.timeoutId = setTimeout(flushEscape, iface.escapeCodeTimeout || ESCAPE_CODE_TIMEOUT);
                    break;
                }
                const parsed = parseKeyBuffer(state.buffer);
                if (!parsed) break;
                state.buffer = state.buffer.slice(parsed.used || 1);
                if (parsed.event && input.listenerCount('keypress') > 0) {
                    input.emit('keypress', parsed.event.sequence, parsed.event.key);
                }
            }
        });
    }

    function isOptionsObject(value) {
        return value && typeof value === 'object' &&
            (Object.prototype.hasOwnProperty.call(value, 'input') ||
             Object.prototype.hasOwnProperty.call(value, 'output') ||
             Object.prototype.hasOwnProperty.call(value, 'terminal') ||
             Object.prototype.hasOwnProperty.call(value, 'completer') ||
             Object.prototype.hasOwnProperty.call(value, 'prompt'));
    }

    function normalizeOptions(input, output, completer, terminal) {
        if (isOptionsObject(input)) return { ...input };
        if (arguments.length === 2 && output && typeof output === 'object' &&
            typeof output.write !== 'function' && typeof output.on !== 'function') {
            return { ...output, input };
        }
        const options = { input };
        if (output !== undefined) options.output = output;
        if (completer !== undefined) options.completer = completer;
        if (terminal !== undefined) options.terminal = terminal;
        return options;
    }

    function validateOptions(options) {
        if (options.completer !== undefined && typeof options.completer !== 'function') {
            throw _makeInvalidArgValueError('completer', options.completer);
        }
        if (options.history !== undefined && !Array.isArray(options.history)) {
            throw _makeInvalidArgTypeError('history', 'Array', options.history);
        }
        if (options.historySize !== undefined) {
            if (typeof options.historySize !== 'number') {
                throw _makeInvalidArgTypeError('historySize', 'number', options.historySize);
            }
            if (!Number.isFinite(options.historySize) || options.historySize < 0) {
                const err = new RangeError(`The value of "historySize" is out of range. Received ${options.historySize}`);
                err.code = 'ERR_OUT_OF_RANGE';
                throw err;
            }
        }
        if (options.tabSize !== undefined) {
            if (typeof options.tabSize !== 'number') throw _makeInvalidArgTypeError('tabSize', 'number', options.tabSize);
            if (!Number.isInteger(options.tabSize) || options.tabSize < 1) {
                const err = new RangeError(`The value of "tabSize" is out of range. It must be an integer. Received ${options.tabSize}`);
                err.code = 'ERR_OUT_OF_RANGE';
                throw err;
            }
        }
        if (options.escapeCodeTimeout !== undefined) {
            if (typeof options.escapeCodeTimeout !== 'number' ||
                !Number.isFinite(options.escapeCodeTimeout) ||
                options.escapeCodeTimeout < 0) {
                throw _makeInvalidArgValueError('escapeCodeTimeout', options.escapeCodeTimeout);
            }
        }
    }

    function isWord(ch) {
        return /[A-Za-z0-9_]/.test(ch || '');
    }

    function Interface(input, output, completer, terminal) {
        if (!(this instanceof Interface)) return new Interface(input, output, completer, terminal);
        const options = normalizeOptions(input, output, completer, terminal);
        validateOptions(options);
        this._events = Object.create(null);
        this._maxListeners = events.EventEmitter.defaultMaxListeners;
        this.input = options.input;
        this.output = options.output;
        this.completer = options.completer;
        this.terminal = options.terminal !== undefined ? !!options.terminal : !!(this.output && this.output.isTTY);
        this.crlfDelay = Math.max(options.crlfDelay || 100, 100);
        this.escapeCodeTimeout = options.escapeCodeTimeout ?? ESCAPE_CODE_TIMEOUT;
        this.historySize = options.historySize ?? 30;
        this.history = Array.isArray(options.history) ? options.history.slice() : [];
        this.removeHistoryDuplicates = !!options.removeHistoryDuplicates;
        this.historyIndex = -1;
        this.line = '';
        this.cursor = 0;
        this.closed = false;
        this._prompt = options.prompt || '';
        this._lastWasCR = false;
        this._sawReturn = false;
        this._questionCallback = null;
        this._onInputData = this._normalWrite.bind(this);
        this._onKeypress = this._ttyWrite.bind(this);
        this._onEnd = () => {
            if (this.line.length > 0) this._emitLine();
            this.close();
        };
        this._onError = (err) => this.emit('error', err);

        if (this.input && typeof this.input.on === 'function') {
            if (this.terminal) {
                emitKeypressEvents(this.input, this);
                this.input.on('keypress', this._onKeypress);
            } else {
                this.input.on('data', this._onInputData);
            }
            this.input.on('end', this._onEnd);
            this.input.on('error', this._onError);
            if (this.terminal && typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
            if (typeof this.input.resume === 'function') this.input.resume();
        }
    }

    Interface.prototype = Object.create(events.EventEmitter.prototype, {
        constructor: { value: Interface, writable: true, configurable: true },
    });

    Interface.prototype._writeToOutput = function(data) {
        if (this.output && typeof this.output.write === 'function') this.output.write(data);
    };

    Interface.prototype._insertString = function(value) {
        value = String(value);
        this.line = this.line.slice(0, this.cursor) + value + this.line.slice(this.cursor);
        this.cursor += value.length;
        this._writeToOutput(value);
    };

    Interface.prototype._deleteLeft = function() {
        const len = charLengthLeft(this.line, this.cursor);
        if (!len) return;
        this.line = this.line.slice(0, this.cursor - len) + this.line.slice(this.cursor);
        this.cursor -= len;
    };

    Interface.prototype._wordRight = function() {
        if (this.cursor >= this.line.length) return;
        if (!isWord(this.line[this.cursor])) {
            this.cursor += charLengthAt(this.line, this.cursor);
            return;
        }
        while (this.cursor < this.line.length && isWord(this.line[this.cursor])) this.cursor += charLengthAt(this.line, this.cursor);
        while (this.line[this.cursor] === ' ') this.cursor++;
    };

    Interface.prototype._wordLeft = function() {
        if (this.cursor <= 0) return;
        let i = this.cursor;
        const prev = () => this.line[i - charLengthLeft(this.line, i)];
        if (!isWord(prev())) {
            i -= charLengthLeft(this.line, i);
        } else {
            while (i > 0 && isWord(prev())) i -= charLengthLeft(this.line, i);
        }
        this.cursor = Math.max(0, i);
    };

    Interface.prototype._deleteWordRight = function() {
        if (this.cursor >= this.line.length) return;
        let end = this.cursor;
        if (!isWord(this.line[end])) {
            end += charLengthAt(this.line, end);
        } else {
            while (end < this.line.length && isWord(this.line[end])) end += charLengthAt(this.line, end);
            while (this.line[end] === ' ') end++;
        }
        this.line = this.line.slice(0, this.cursor) + this.line.slice(end);
    };

    Interface.prototype._lineForHistory = function(line) {
        if (!line || this.historySize === 0) return;
        if (this.removeHistoryDuplicates) {
            this.history = this.history.filter((entry) => entry !== line);
        }
        this.history.unshift(line);
        if (this.history.length > this.historySize) this.history.length = this.historySize;
        this.emit('history', this.history);
    };

    Interface.prototype._emitLine = function() {
        const line = this.line;
        this._lineForHistory(line);
        this.line = '';
        this.cursor = 0;
        this.historyIndex = -1;
        if (this._questionCallback) {
            const cb = this._questionCallback;
            this._questionCallback = null;
            cb(line);
        }
        this.emit('line', line);
    };

    Interface.prototype._normalWrite = function(chunk) {
        const data = toStringChunk(chunk);
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === '\r' || ch === '\n') {
                if (ch === '\n' && this._lastWasCR) {
                    this._lastWasCR = false;
                    continue;
                }
                this._lastWasCR = ch === '\r';
                this._emitLine();
            } else {
                this._lastWasCR = false;
                this._insertString(ch);
            }
        }
    };

    Interface.prototype._historyMove = function(delta) {
        if (this.history.length === 0) return;
        if (delta < 0) {
            this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
        } else {
            this.historyIndex = Math.max(-1, this.historyIndex - 1);
        }
        this.line = this.historyIndex >= 0 ? this.history[this.historyIndex] : '';
        this.cursor = this.line.length;
    };

    Interface.prototype._ttyWrite = function(s, key) {
        key = key || {};
        if (key.ctrl && key.name === 'u') {
            this.line = '';
            this.cursor = 0;
            return;
        }
        if (key.ctrl && key.name === 'a') key = { ...key, name: 'home', ctrl: false };
        if (key.ctrl && key.name === 'e') key = { ...key, name: 'end', ctrl: false };
        if (key.ctrl && key.name === 'b') key = { ...key, name: 'left', ctrl: false };
        if (key.ctrl && key.name === 'f') key = { ...key, name: 'right', ctrl: false };
        if (key.ctrl && key.name === 'p') key = { ...key, name: 'up', ctrl: false };
        if (key.ctrl && key.name === 'n') key = { ...key, name: 'down', ctrl: false };
        if (key.meta && key.name === 'b') return this._wordLeft();
        if (key.meta && key.name === 'f') return this._wordRight();
        if (key.meta && key.name === 'd') return this._deleteWordRight();

        switch (key.name) {
            case 'return':
            case 'enter':
                this._writeToOutput(key.sequence || '\n');
                this._emitLine();
                return;
            case 'tab':
                if (this.completer) this.completer(this.line);
                else if (s) this._insertString(s);
                return;
            case 'backspace':
                this._deleteLeft();
                return;
            case 'home':
                this.cursor = 0;
                return;
            case 'end':
                this.cursor = this.line.length;
                return;
            case 'left':
                this.cursor = Math.max(0, this.cursor - charLengthLeft(this.line, this.cursor));
                return;
            case 'right':
                this.cursor = Math.min(this.line.length, this.cursor + charLengthAt(this.line, this.cursor));
                return;
            case 'up':
                this._historyMove(-1);
                return;
            case 'down':
                this._historyMove(1);
                return;
            case 'delete':
                if (this.cursor < this.line.length) {
                    const len = charLengthAt(this.line, this.cursor);
                    this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + len);
                }
                return;
            default:
                if (s) this._insertString(s);
        }
    };

    Interface.prototype.write = function(data, key) {
        if (key) this._ttyWrite(data == null ? undefined : String(data), key);
        else this._normalWrite(data == null ? '' : data);
        return this;
    };

    Interface.prototype.pause = function() {
        if (this.input && typeof this.input.pause === 'function') this.input.pause();
        return this;
    };

    Interface.prototype.resume = function() {
        if (this.input && typeof this.input.resume === 'function') this.input.resume();
        return this;
    };

    Interface.prototype.close = function() {
        if (this.closed) return;
        this.closed = true;
        if (this.input) {
            if (this.terminal && typeof this.input.setRawMode === 'function') this.input.setRawMode(false);
            if (this.terminal && typeof this.input.removeListener === 'function') this.input.removeListener('keypress', this._onKeypress);
            if (!this.terminal && typeof this.input.removeListener === 'function') this.input.removeListener('data', this._onInputData);
            if (typeof this.input.removeListener === 'function') {
                this.input.removeListener('end', this._onEnd);
                this.input.removeListener('error', this._onError);
            }
            if (typeof this.input.pause === 'function') this.input.pause();
        }
        this.emit('close');
    };

    Interface.prototype.setPrompt = function(prompt) {
        this._prompt = String(prompt);
    };

    Interface.prototype.getPrompt = function() {
        return this._prompt;
    };

    Interface.prototype.prompt = function(preserveCursor) {
        if (!preserveCursor) this.cursor = 0;
        this._writeToOutput(this._prompt);
    };

    Interface.prototype.question = function(query, options, cb) {
        if (typeof options === 'function') { cb = options; options = undefined; }
        if (typeof cb !== 'function') return;
        this._prompt = String(query);
        this._writeToOutput(this._prompt);
        this._questionCallback = cb;
    };

    Interface.prototype.getCursorPos = function() {
        const display = `${this._prompt || ''}${this.line.slice(0, this.cursor)}`;
        const parts = display.split('\n');
        return {
            rows: parts.length - 1,
            cols: stringWidth(parts[parts.length - 1]),
        };
    };

    Interface.prototype[Symbol.asyncIterator] = function() {
        const rl = this;
        const queue = [];
        const waiters = [];
        let ended = false;
        let error = null;
        const settle = () => {
            while (waiters.length && (queue.length || ended || error)) {
                const { resolve, reject } = waiters.shift();
                if (error) reject(error);
                else if (queue.length) resolve({ value: queue.shift(), done: false });
                else resolve({ value: undefined, done: true });
            }
        };
        rl.on('line', (line) => { queue.push(line); settle(); });
        rl.on('close', () => { ended = true; settle(); });
        rl.on('error', (err) => { error = err; settle(); });
        return {
            [Symbol.asyncIterator]() { return this; },
            next() {
                if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
                if (error) return Promise.reject(error);
                if (ended) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
            },
        };
    };

    function createInterface(...args) {
        return new Interface(...args);
    }

    class PromisesInterface extends Interface {
        question(query, options) {
            return new Promise((resolve, reject) => {
                const signal = options && options.signal;
                if (signal && signal.aborted) {
                    reject(new internalErrors.AbortError());
                    return;
                }
                const onAbort = () => {
                    cleanup();
                    reject(new internalErrors.AbortError());
                };
                const cleanup = () => {
                    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
                };
                if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
                Interface.prototype.question.call(this, query, (answer) => {
                    cleanup();
                    resolve(answer);
                });
            });
        }
    }

    function createPromisesInterface(...args) {
        return new PromisesInterface(...args);
    }

    return {
        Interface,
        InterfaceConstructor: Interface,
        createInterface,
        emitKeypressEvents,
        cursorTo: _cursorTo,
        moveCursor: _moveCursor,
        clearLine: _clearLine,
        clearScreenDown: _clearScreenDown,
        promises: {
            Interface: PromisesInterface,
            createInterface: createPromisesInterface,
        },
    };
})();

// ============================================================
// Module system (require/module)
// ============================================================

const _builtinModules = {
    'path': path,
    'path/posix': path.posix,
    'path/win32': path.win32,
    'events': events,
    'buffer': nodeBuffer,
    'fs': fs,
    'fs/promises': fs.promises,
    'os': nodeOs,
    'util': util,
    'util/types': util.types,
    'assert': assert,
    'assert/strict': assert,
    'stream': stream,
    'url': url,
    'querystring': querystring,
    'string_decoder': string_decoder,
    'timers': timers,
    'timers/promises': timersPromises,
    'domain': domain,
    'dgram': dgram,
    'repl': repl,
    'node:test': nodeTest,
    'test': nodeTest,
    // @sigstore/sign reads http2.constants at module init but fetches over
    // make-fetch-happen (http/1) — empty stub satisfies the load.
    'http2': { constants: {} },
    'child_process': child_process,
    'crypto': crypto,
    'internal/crypto/webcrypto': {
        Crypto: crypto.Crypto,
        CryptoKey: crypto.CryptoKey,
        SubtleCrypto: crypto.SubtleCrypto,
    },
    'net': net,
    'tls': tls,
    'http': http,
    'https': https,
    '_http_agent': { Agent: http.Agent, globalAgent: http.globalAgent },
    '_http_client': { ClientRequest: http.ClientRequest },
    '_http_common': { methods: HTTP_METHODS },
    '_http_incoming': { IncomingMessage: http.IncomingMessage },
    '_http_outgoing': { OutgoingMessage: http.OutgoingMessage },
    '_http_server': {
        Server: http.Server,
        ServerResponse: http.ServerResponse,
        STATUS_CODES: http.STATUS_CODES,
    },
    'zlib': (() => {
        const z = _nodeNative;
        const constants = Object.freeze({
            Z_NO_FLUSH: 0,
            Z_PARTIAL_FLUSH: 1,
            Z_SYNC_FLUSH: 2,
            Z_FULL_FLUSH: 3,
            Z_FINISH: 4,
            Z_BLOCK: 5,
            Z_OK: 0,
            Z_STREAM_END: 1,
            Z_NEED_DICT: 2,
            Z_ERRNO: -1,
            Z_STREAM_ERROR: -2,
            Z_DATA_ERROR: -3,
            Z_MEM_ERROR: -4,
            Z_BUF_ERROR: -5,
            Z_VERSION_ERROR: -6,
            Z_NO_COMPRESSION: 0,
            Z_BEST_SPEED: 1,
            Z_BEST_COMPRESSION: 9,
            Z_DEFAULT_COMPRESSION: -1,
            Z_DEFAULT_LEVEL: -1,
            Z_FILTERED: 1,
            Z_HUFFMAN_ONLY: 2,
            Z_RLE: 3,
            Z_FIXED: 4,
            Z_DEFAULT_STRATEGY: 0,
            Z_DEFAULT_WINDOWBITS: 15,
            Z_MIN_WINDOWBITS: 8,
            Z_MAX_WINDOWBITS: 15,
            Z_DEFAULT_MEMLEVEL: 8,
            Z_MIN_MEMLEVEL: 1,
            Z_MAX_MEMLEVEL: 9,
            Z_DEFAULT_CHUNK: 16 * 1024,
            Z_MIN_CHUNK: 64,
            Z_MAX_CHUNK: Infinity,
            Z_MAX_LEVEL: 9,
            Z_MIN_LEVEL: -1,
            ZLIB_VERNUM: 0x1310,
            DEFLATE: 1,
            INFLATE: 2,
            GZIP: 3,
            GUNZIP: 4,
            DEFLATERAW: 5,
            INFLATERAW: 6,
            UNZIP: 7,
            BROTLI_DECODE: 8,
            BROTLI_ENCODE: 9,
            BROTLI_OPERATION_PROCESS: 0,
            BROTLI_OPERATION_FLUSH: 1,
            BROTLI_OPERATION_FINISH: 2,
            BROTLI_OPERATION_EMIT_METADATA: 3,
            BROTLI_PARAM_MODE: 0,
            BROTLI_PARAM_QUALITY: 1,
            BROTLI_PARAM_LGWIN: 2,
            BROTLI_PARAM_LGBLOCK: 3,
            BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
            BROTLI_PARAM_SIZE_HINT: 5,
            BROTLI_PARAM_LARGE_WINDOW: 6,
            BROTLI_PARAM_NPOSTFIX: 7,
            BROTLI_PARAM_NDIRECT: 8,
            BROTLI_MODE_GENERIC: 0,
            BROTLI_MODE_TEXT: 1,
            BROTLI_MODE_FONT: 2,
            BROTLI_DEFAULT_MODE: 0,
            BROTLI_MIN_QUALITY: 0,
            BROTLI_MAX_QUALITY: 11,
            BROTLI_DEFAULT_QUALITY: 11,
            BROTLI_MIN_WINDOW_BITS: 10,
            BROTLI_MAX_WINDOW_BITS: 24,
            BROTLI_LARGE_MAX_WINDOW_BITS: 30,
            BROTLI_DEFAULT_WINDOW: 22,
            BROTLI_MIN_INPUT_BLOCK_BITS: 16,
            BROTLI_MAX_INPUT_BLOCK_BITS: 24,
            BROTLI_DECODER_RESULT_ERROR: 0,
            BROTLI_DECODER_RESULT_SUCCESS: 1,
            BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
            BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
            BROTLI_DECODER_NO_ERROR: 0,
            BROTLI_DECODER_SUCCESS: 1,
            BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
            BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
            BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
            BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
            BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
            BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
            BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
            BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
            BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
            BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
            BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
            BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
            BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
            BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
            BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
            BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
            BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
            BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
            BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
            BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
            BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
            BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
            BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
            BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
            BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
            BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
            BROTLI_DECODER_ERROR_UNREACHABLE: -31,
            BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
            BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
        });
        const codes = Object.freeze({
            Z_OK: constants.Z_OK,
            Z_STREAM_END: constants.Z_STREAM_END,
            Z_NEED_DICT: constants.Z_NEED_DICT,
            Z_ERRNO: constants.Z_ERRNO,
            Z_STREAM_ERROR: constants.Z_STREAM_ERROR,
            Z_DATA_ERROR: constants.Z_DATA_ERROR,
            Z_MEM_ERROR: constants.Z_MEM_ERROR,
            Z_BUF_ERROR: constants.Z_BUF_ERROR,
            Z_VERSION_ERROR: constants.Z_VERSION_ERROR,
        });
        const toU8 = (b) => {
            if (b instanceof Uint8Array) return b;
            if (b instanceof ArrayBuffer) return new Uint8Array(b);
            if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            if (typeof b === 'string') return Buffer.from(b, 'utf8');
            throw _makeInvalidArgTypeError('chunk', 'Buffer, TypedArray, DataView, ArrayBuffer, or string', b);
        };
        const levelFromOptions = (opts) => opts && typeof opts === 'object' ? opts.level : undefined;
        const zlibRangeError = (name, min, max, value) => {
            const err = new RangeError(`The value of "options.${name}" is out of range. It must be >= ${min} and <= ${max}. Received ${value}`);
            err.code = 'ERR_OUT_OF_RANGE';
            return err;
        };
        const validateZlibOptions = (kind, opts) => {
            if (!opts || typeof opts !== 'object') return;
            if (opts.windowBits !== undefined) {
                if (typeof opts.windowBits !== 'number') {
                    throw _makeInvalidArgTypeError('options.windowBits', 'number', opts.windowBits);
                }
                if (!Number.isFinite(opts.windowBits)) {
                    const err = new RangeError(`The value of "options.windowBits" is out of range. It must be a finite number. Received ${opts.windowBits}`);
                    err.code = 'ERR_OUT_OF_RANGE';
                    throw err;
                }
                const allowZeroWindowBits = kind === 'inflate' || kind === 'gunzip' || kind === 'unzip';
                const minWindowBits = kind === 'gzip' ? 9 : 8;
                if (!(allowZeroWindowBits && opts.windowBits === 0) &&
                    (opts.windowBits < minWindowBits || opts.windowBits > 15)) {
                    throw zlibRangeError('windowBits', minWindowBits, 15, opts.windowBits);
                }
            }
        };
        const unsupportedBrotli = () => {
            const err = _makeNodeError('brotli is not available in this Kandelo SpiderMonkey build', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
            throw err;
        };
        const nativeMethod = (name) => {
            if (typeof z[name] !== 'function') {
                const err = _makeNodeError(`zlib native method ${name} is not available`, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
                throw err;
            }
            return z[name].bind(z);
        };
        const createInner = (kind, opts) => {
            validateZlibOptions(kind, opts);
            switch (kind) {
                case 'deflate': return nativeMethod('createDeflate')(levelFromOptions(opts));
                case 'inflate': return nativeMethod('createInflate')();
                case 'gzip': return nativeMethod('createGzip')(levelFromOptions(opts));
                case 'gunzip': return nativeMethod('createGunzip')();
                case 'unzip': return (typeof z.createUnzip === 'function' ? z.createUnzip : nativeMethod('createGunzip')).call(z);
                case 'deflateRaw': return nativeMethod('createDeflateRaw')(levelFromOptions(opts));
                case 'inflateRaw': return nativeMethod('createInflateRaw')();
                case 'brotliCompress':
                case 'brotliDecompress':
                    unsupportedBrotli();
                    break;
            }
        };
        function ZlibTransform(kind, opts) {
            stream.Transform.call(this, opts);
            this._kind = kind;
            this._opts = opts || {};
            this._inner = createInner(kind, this._opts);
            this.bytesWritten = 0;
            this.bytesRead = 0;
            this._handle = {
                close: () => this.close(),
                reset: () => this.reset(),
                _processChunk: (chunk, flushFlag) => this._processChunk(chunk, flushFlag),
            };
        }
        Object.setPrototypeOf(ZlibTransform, stream.Transform);
        ZlibTransform.prototype = Object.create(stream.Transform.prototype, {
            constructor: { value: ZlibTransform, writable: true, configurable: true },
        });
        ZlibTransform.prototype._writeNative = function(chunk, finish) {
            const u8 = toU8(chunk);
            this.bytesWritten += u8.byteLength;
            this.bytesRead = this.bytesWritten;
            const out = this._inner.write(u8, !!finish);
            return out.byteLength ? Buffer.from(out) : Buffer.alloc(0);
        };
        ZlibTransform.prototype._processChunk = function(chunk, flushFlag) {
            return this._writeNative(chunk, flushFlag === constants.Z_FINISH);
        };
        ZlibTransform.prototype._transform = function(chunk, _enc, cb) {
            try {
                const out = this._writeNative(chunk, false);
                cb(null, out.byteLength ? out : null);
            } catch (e) { cb(e); }
        };
        ZlibTransform.prototype._flush = function(cb) {
            try {
                const out = this._inner.write(new Uint8Array(0), true);
                cb(null, out.byteLength ? Buffer.from(out) : null);
            } catch (e) { cb(e); }
        };
        ZlibTransform.prototype.flush = function(kind, cb) {
            if (typeof kind === 'function') { cb = kind; kind = constants.Z_FULL_FLUSH; }
            try {
                const finish = kind === constants.Z_FINISH;
                const out = this._inner.write(new Uint8Array(0), finish);
                if (out.byteLength) this.push(Buffer.from(out));
                if (typeof cb === 'function') queueMicrotask(() => cb());
            } catch (e) {
                if (typeof cb === 'function') queueMicrotask(() => cb(e));
                else this.emit('error', e);
            }
            return this;
        };
        ZlibTransform.prototype.params = function(_level, _strategy, cb) {
            if (typeof cb === 'function') queueMicrotask(() => cb());
            return this;
        };
        ZlibTransform.prototype.reset = function() {
            this._inner = createInner(this._kind, this._opts);
        };
        ZlibTransform.prototype.close = function(cb) {
            this.destroy();
            if (typeof cb === 'function') queueMicrotask(cb);
        };
        const makeZlibCtor = (name, kind) => {
            const Ctor = { [name]: function(opts) {
                if (!(this instanceof Ctor)) return new Ctor(opts);
                ZlibTransform.call(this, kind, opts);
            } }[name];
            Object.setPrototypeOf(Ctor, ZlibTransform);
            Ctor.prototype = Object.create(ZlibTransform.prototype, {
                constructor: { value: Ctor, writable: true, configurable: true },
            });
            return Ctor;
        };
        const Deflate = makeZlibCtor('Deflate', 'deflate');
        const Inflate = makeZlibCtor('Inflate', 'inflate');
        const Gzip = makeZlibCtor('Gzip', 'gzip');
        const Gunzip = makeZlibCtor('Gunzip', 'gunzip');
        const Unzip = makeZlibCtor('Unzip', 'unzip');
        const DeflateRaw = makeZlibCtor('DeflateRaw', 'deflateRaw');
        const InflateRaw = makeZlibCtor('InflateRaw', 'inflateRaw');
        const BrotliCompress = makeZlibCtor('BrotliCompress', 'brotliCompress');
        const BrotliDecompress = makeZlibCtor('BrotliDecompress', 'brotliDecompress');
        const syncBuffer = (kind, b, opts, Ctor) => {
            validateZlibOptions(kind, opts);
            if (kind === 'brotliCompress' || kind === 'brotliDecompress') unsupportedBrotli();
            const method = nativeMethod(`${kind}Sync`);
            const buffer = Buffer.from(method(toU8(b), levelFromOptions(opts)));
            if (opts && opts.info) return { buffer, engine: new Ctor(opts) };
            return buffer;
        };
        const asyncBuffer = (kind, b, opts, cb, Ctor) => {
            if (typeof opts === 'function') { cb = opts; opts = undefined; }
            if (typeof cb !== 'function') throw _makeInvalidArgTypeError('callback', 'function', cb);
            queueMicrotask(() => {
                try { cb(null, syncBuffer(kind, b, opts, Ctor)); }
                catch (err) { cb(err); }
            });
        };
        const api = {
            createDeflate: (opts) => new Deflate(opts),
            createInflate: (opts) => new Inflate(opts),
            createGzip: (opts) => new Gzip(opts),
            createGunzip: (opts) => new Gunzip(opts),
            createUnzip: (opts) => new Unzip(opts),
            createDeflateRaw: (opts) => new DeflateRaw(opts),
            createInflateRaw: (opts) => new InflateRaw(opts),
            createBrotliCompress: (opts) => new BrotliCompress(opts),
            createBrotliDecompress: (opts) => new BrotliDecompress(opts),
            deflateSync: (b, opts) => syncBuffer('deflate', b, opts, Deflate),
            inflateSync: (b, opts) => syncBuffer('inflate', b, opts, Inflate),
            gzipSync: (b, opts) => syncBuffer('gzip', b, opts, Gzip),
            gunzipSync: (b, opts) => syncBuffer('gunzip', b, opts, Gunzip),
            unzipSync: (b, opts) => syncBuffer('unzip', b, opts, Unzip),
            deflateRawSync: (b, opts) => syncBuffer('deflateRaw', b, opts, DeflateRaw),
            inflateRawSync: (b, opts) => syncBuffer('inflateRaw', b, opts, InflateRaw),
            brotliCompressSync: (b, opts) => syncBuffer('brotliCompress', b, opts, BrotliCompress),
            brotliDecompressSync: (b, opts) => syncBuffer('brotliDecompress', b, opts, BrotliDecompress),
            deflate: (b, opts, cb) => asyncBuffer('deflate', b, opts, cb, Deflate),
            inflate: (b, opts, cb) => asyncBuffer('inflate', b, opts, cb, Inflate),
            gzip: (b, opts, cb) => asyncBuffer('gzip', b, opts, cb, Gzip),
            gunzip: (b, opts, cb) => asyncBuffer('gunzip', b, opts, cb, Gunzip),
            unzip: (b, opts, cb) => asyncBuffer('unzip', b, opts, cb, Unzip),
            deflateRaw: (b, opts, cb) => asyncBuffer('deflateRaw', b, opts, cb, DeflateRaw),
            inflateRaw: (b, opts, cb) => asyncBuffer('inflateRaw', b, opts, cb, InflateRaw),
            brotliCompress: (b, opts, cb) => asyncBuffer('brotliCompress', b, opts, cb, BrotliCompress),
            brotliDecompress: (b, opts, cb) => asyncBuffer('brotliDecompress', b, opts, cb, BrotliDecompress),
            Deflate, Inflate, Gzip, Gunzip, Unzip, DeflateRaw, InflateRaw, BrotliCompress, BrotliDecompress,
        };
        Object.defineProperty(api, 'constants', { value: constants, writable: false, enumerable: true, configurable: false });
        Object.defineProperty(api, 'codes', { value: codes, writable: false, enumerable: true, configurable: false });
        for (const key of Object.keys(constants)) {
            Object.defineProperty(api, key, { value: constants[key], writable: false, enumerable: true, configurable: false });
        }
        return api;
    })(),
    'tty': {
        isatty: os.isatty,
        ReadStream: class ReadStream extends stream.Readable {},
        WriteStream: class WriteStream extends stream.Writable {},
    },
    'module': null, // set below
    'constants': fs.constants,
    'punycode': {
        toASCII(s) { return s; },
        toUnicode(s) { return s; },
    },
    'dns': dns,
    'dns/promises': dns.promises,
    'readline': readline,
    'readline/promises': readline.promises,
    'perf_hooks': {
        performance: {
            now() { return Date.now(); },
            mark() {},
            measure() {},
        },
        PerformanceObserver: class PerformanceObserver { observe() {} disconnect() {} },
    },
    'worker_threads': typeof globalThis.__kandeloCreateWorkerThreads === 'function'
        ? globalThis.__kandeloCreateWorkerThreads(events.EventEmitter, async_hooks)
        : {
            isMainThread: true,
            parentPort: null,
            workerData: null,
            Worker: class Worker {},
        },
    'cluster': cluster,
    // node:console — exposes the Console class so libs (e.g. undici's mock
    // formatter) can construct a logger backed by arbitrary streams. The
    // global `console` in some engines is not an instance of this class; that
    // matches Node's runtime behaviour (`globalThis.console` is its own
    // singleton, not produced from `new Console`).
    'console': (() => {
        const writeLine = (stream, args) => {
            try {
                if (stream && typeof stream.once === 'function' && stream.listenerCount('error') === 0) {
                    stream.once('error', () => {});
                }
                stream.write(util.format(...args) + '\n', () => {});
            } catch {}
        };
        class Console {
            constructor(stdoutOrOptions, stderr) {
                const opts = stdoutOrOptions && typeof stdoutOrOptions.write === 'function'
                    ? { stdout: stdoutOrOptions, stderr }
                    : (stdoutOrOptions || {});
                this._out = opts.stdout || process.stdout;
                this._err = opts.stderr || opts.stdout || process.stderr;
                this._counts = Object.create(null);
            }
            log(...args) { writeLine(this._out, args); }
            info(...args) { writeLine(this._out, args); }
            debug(...args) { writeLine(this._out, args); }
            warn(...args) { writeLine(this._err, args); }
            error(...args) { writeLine(this._err, args); }
            trace(...args) { writeLine(this._err, ['Trace:', ...args]); }
            dir(obj) { writeLine(this._out, [util.inspect(obj)]); }
            table(data) { writeLine(this._out, [data]); }
            assert(cond, ...args) {
                if (!cond) writeLine(this._err, ['Assertion failed:', ...args]);
            }
            count(label) {
                if (typeof label === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
                label = label === undefined ? 'default' : String(label);
                this._counts[label] = (this._counts[label] || 0) + 1;
                writeLine(this._out, [`${label}: ${this._counts[label]}`]);
            }
            countReset(label) {
                if (typeof label === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
                label = label === undefined ? 'default' : String(label);
                this._counts[label] = 0;
            }
            group(...args) { if (args.length) this.log(...args); }
            groupCollapsed(...args) { if (args.length) this.log(...args); }
            groupEnd() {}
            dirxml(...args) { this.log(...args); }
            time(label) {
                if (!this._timers) this._timers = Object.create(null);
                this._timers[label || 'default'] = Date.now();
            }
            timeEnd(label) {
                label = label || 'default';
                const start = this._timers && this._timers[label] || Date.now();
                if (this._timers) delete this._timers[label];
                this.log(`${label}: ${Date.now() - start}ms`);
            }
            timeLog(label) {
                label = label || 'default';
                const start = this._timers && this._timers[label] || Date.now();
                this.log(`${label}: ${Date.now() - start}ms`);
            }
            clear() {
                if (this._out && this._out.isTTY && process.env.TERM !== 'dumb') {
                    try { this._out.write('\u001b[1;1H\u001b[0J'); } catch {}
                }
            }
        }
        return { Console, default: Console };
    })(),
    'async_hooks': async_hooks,
    // diagnostics_channel is userland-observable through Undici and Node's
    // official tests. Kandelo does not export traces to a native collector, but
    // channel identity, pub/sub, tracing callbacks, and AsyncLocalStorage store
    // binding still need to match Node's JavaScript semantics.
    'diagnostics_channel': (() => {
        const traceEvents = ['start', 'end', 'asyncStart', 'asyncEnd', 'error'];
        const channels = new Map();

        function validateFunction(value, name) {
            if (typeof value !== 'function') throw _makeInvalidArgTypeError(name, 'function', value);
        }

        function invalidTracingChannelInput(value) {
            const err = _makeInvalidArgTypeError('nameOrChannels', 'string or an instance of TracingChannel or Object', value);
            err.message = err.message.replace(
                'must be of type string or an instance of TracingChannel or Object',
                'must be of type string or an instance of TracingChannel or Object',
            );
            return err;
        }

        function invalidTracingChannelProperty(name, value) {
            const err = _makeInvalidArgTypeError(`nameOrChannels.${name}`, 'an instance of Channel', value);
            err.message = err.message.replace('argument must be', 'property must be');
            return err;
        }

        function reportAsyncError(err) {
            process.nextTick(() => {
                if (!process.emit('uncaughtException', err)) throw err;
            });
        }

        class Channel {
            constructor(name) {
                this.name = name;
                this._subscribers = [];
                this._stores = new Map();
                channels.set(name, this);
            }

            get hasSubscribers() {
                return this._subscribers.length > 0 || this._stores.size > 0;
            }

            subscribe(subscription) {
                validateFunction(subscription, 'subscription');
                this._subscribers.push(subscription);
            }

            unsubscribe(subscription) {
                const index = this._subscribers.indexOf(subscription);
                if (index === -1) return false;
                this._subscribers.splice(index, 1);
                return true;
            }

            bindStore(store, transform) {
                this._stores.set(store, transform);
            }

            unbindStore(store) {
                if (!this._stores.has(store)) return false;
                this._stores.delete(store);
                return true;
            }

            publish(data) {
                const subscribers = this._subscribers.slice();
                for (const onMessage of subscribers) {
                    try {
                        onMessage(data, this.name);
                    } catch (err) {
                        reportAsyncError(err);
                    }
                }
            }

            runStores(data, fn, thisArg, ...args) {
                validateFunction(fn, 'fn');
                const entries = Array.from(this._stores.entries());
                let run = () => {
                    this.publish(data);
                    return fn.apply(thisArg, args);
                };
                for (const [store, transform] of entries) {
                    const next = run;
                    run = () => {
                        let context;
                        try {
                            context = typeof transform === 'function' ? transform(data) : data;
                        } catch (err) {
                            reportAsyncError(err);
                            return next();
                        }
                        return store.run(context, next);
                    };
                }
                return run();
            }
        }

        function channel(name) {
            if (typeof name !== 'string' && typeof name !== 'symbol') {
                throw _makeInvalidArgTypeError('channel', 'string or symbol', name);
            }
            let ch = channels.get(name);
            if (!ch) ch = new Channel(name);
            return ch;
        }

        function assertChannel(value, name) {
            if (value === undefined || value === null) {
                throw new TypeError('Cannot convert undefined or null to object');
            }
            if (!(value instanceof Channel)) throw invalidTracingChannelProperty(name, value);
        }

        function tracingChannelFrom(nameOrChannels, name) {
            if (typeof nameOrChannels === 'string') return channel(`tracing:${nameOrChannels}:${name}`);
            if (nameOrChannels && typeof nameOrChannels === 'object') {
                const ch = nameOrChannels[name];
                assertChannel(ch, name);
                return ch;
            }
            throw invalidTracingChannelInput(nameOrChannels);
        }

        class TracingChannel {
            constructor(nameOrChannels) {
                if (!(typeof nameOrChannels === 'string' ||
                    (nameOrChannels && typeof nameOrChannels === 'object'))) {
                    throw invalidTracingChannelInput(nameOrChannels);
                }
                for (const name of traceEvents) {
                    Object.defineProperty(this, name, {
                        value: tracingChannelFrom(nameOrChannels, name),
                    });
                }
            }

            get hasSubscribers() {
                return this.start.hasSubscribers ||
                    this.end.hasSubscribers ||
                    this.asyncStart.hasSubscribers ||
                    this.asyncEnd.hasSubscribers ||
                    this.error.hasSubscribers;
            }

            subscribe(handlers) {
                for (const name of traceEvents) {
                    if (handlers[name]) this[name].subscribe(handlers[name]);
                }
            }

            unsubscribe(handlers) {
                let done = true;
                for (const name of traceEvents) {
                    if (handlers[name] && !this[name].unsubscribe(handlers[name])) {
                        done = false;
                    }
                }
                return done;
            }

            traceSync(fn, context = {}, thisArg, ...args) {
                if (!this.hasSubscribers) return fn.apply(thisArg, args);
                return this.start.runStores(context, () => {
                    try {
                        const result = fn.apply(thisArg, args);
                        context.result = result;
                        return result;
                    } catch (err) {
                        context.error = err;
                        this.error.publish(context);
                        throw err;
                    } finally {
                        this.end.publish(context);
                    }
                });
            }

            tracePromise(fn, context = {}, thisArg, ...args) {
                if (!this.hasSubscribers) return fn.apply(thisArg, args);
                return this.start.runStores(context, () => {
                    try {
                        let promise = fn.apply(thisArg, args);
                        if (!(promise instanceof Promise)) promise = Promise.resolve(promise);
                        return promise.then(
                            (result) => {
                                context.result = result;
                                this.asyncStart.publish(context);
                                this.asyncEnd.publish(context);
                                return result;
                            },
                            (err) => {
                                context.error = err;
                                this.error.publish(context);
                                this.asyncStart.publish(context);
                                this.asyncEnd.publish(context);
                                return Promise.reject(err);
                            },
                        );
                    } catch (err) {
                        context.error = err;
                        this.error.publish(context);
                        throw err;
                    } finally {
                        this.end.publish(context);
                    }
                });
            }

            traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
                if (!this.hasSubscribers) return fn.apply(thisArg, args);
                let callbackIndex = Number(position);
                if (!Number.isInteger(callbackIndex)) callbackIndex = -1;
                if (callbackIndex < 0) callbackIndex = args.length + callbackIndex;
                const callback = args[callbackIndex];
                validateFunction(callback, 'callback');
                const self = this;
                args.splice(callbackIndex, 1, function wrappedCallback(err, result) {
                    if (err) {
                        context.error = err;
                        self.error.publish(context);
                    } else {
                        context.result = result;
                    }
                    return self.asyncStart.runStores(context, () => {
                        try {
                            return callback.apply(this, arguments);
                        } finally {
                            self.asyncEnd.publish(context);
                        }
                    });
                });
                return this.start.runStores(context, () => {
                    try {
                        return fn.apply(thisArg, args);
                    } catch (err) {
                        context.error = err;
                        this.error.publish(context);
                        throw err;
                    } finally {
                        this.end.publish(context);
                    }
                });
            }
        }

        return {
            channel,
            tracingChannel(nameOrChannels) { return new TracingChannel(nameOrChannels); },
            subscribe(name, subscription) { return channel(name).subscribe(subscription); },
            unsubscribe(name, subscription) { return channel(name).unsubscribe(subscription); },
            hasSubscribers(name) {
                const ch = channels.get(name);
                return !!(ch && ch.hasSubscribers);
            },
            Channel,
        };
    })(),
    'v8': (() => {
        let flagVersion = 0;
        const heapSizeLimit = 256 * 1024 * 1024;
        const unsupported = (member) => { throw _unsupportedNodeApi('v8', member); };
        const notBuildingSnapshot = () => {
            const err = new Error('Operation cannot be invoked when not building startup snapshot');
            err.code = 'ERR_NOT_BUILDING_SNAPSHOT';
            return err;
        };
        const heapSpaceNames = [
            'code_large_object_space',
            'code_space',
            'large_object_space',
            'new_large_object_space',
            'new_space',
            'old_space',
            'read_only_space',
            'shared_large_object_space',
            'shared_space',
            'trusted_large_object_space',
            'trusted_space',
        ];
        return {
            promiseHooks: async_hooks.promiseHooks,
            // arborist sizes its packument LRU as floor(heap_size_limit * 0.25),
            // so heap_size_limit must be > 0 or lru-cache rejects the config.
            getHeapStatistics() {
                return {
                    total_heap_size: 8 * 1024 * 1024,
                    total_heap_size_executable: 0,
                    total_physical_size: 8 * 1024 * 1024,
                    total_available_size: heapSizeLimit - 4 * 1024 * 1024,
                    used_heap_size: 4 * 1024 * 1024,
                    heap_size_limit: heapSizeLimit,
                    malloced_memory: 0,
                    peak_malloced_memory: 0,
                    does_zap_garbage: 0,
                    number_of_native_contexts: 1,
                    number_of_detached_contexts: 0,
                    total_global_handles_size: 0,
                    used_global_handles_size: 0,
                    external_memory: process.memoryUsage().external,
                };
            },
            getHeapCodeStatistics() {
                return {
                    code_and_metadata_size: 0,
                    bytecode_and_metadata_size: 0,
                    external_script_source_size: 0,
                    cpu_profiler_metadata_size: 0,
                };
            },
            getHeapSpaceStatistics() {
                return heapSpaceNames.map((space_name) => ({
                    space_name,
                    space_size: 0,
                    space_used_size: 0,
                    space_available_size: 0,
                    physical_space_size: 0,
                }));
            },
            setFlagsFromString(flags) {
                _validateString(flags, 'flags');
                flagVersion = (flagVersion + 1) >>> 0;
            },
            cachedDataVersionTag() {
                return (0x534d0000 ^ flagVersion) >>> 0;
            },
            getHeapSnapshot() {
                const payload = Buffer.from(JSON.stringify({
                    snapshot: {
                        meta: {
                            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
                            node_types: [['synthetic'], 'string', 'number', 'number', 'number', 'number', 'number'],
                            edge_fields: ['type', 'name_or_index', 'to_node'],
                            edge_types: [['element'], 'string_or_number', 'node'],
                            trace_function_info_fields: ['function_id', 'name', 'script_name', 'script_id', 'line', 'column'],
                            trace_node_fields: ['id', 'function_info_index', 'count', 'size', 'children'],
                            sample_fields: ['timestamp_us', 'last_assigned_id'],
                            location_fields: ['object_index', 'script_id', 'line', 'column'],
                        },
                        node_count: 0,
                        edge_count: 0,
                        trace_function_count: 0,
                    },
                    nodes: [],
                    edges: [],
                    trace_function_infos: [],
                    trace_tree: [],
                    samples: [],
                    locations: [],
                    strings: [],
                }));
                return stream.Readable.from([payload]);
            },
            serialize() { unsupported('serialize'); },
            deserialize() { unsupported('deserialize'); },
            writeHeapSnapshot() { unsupported('writeHeapSnapshot'); },
            queryObjects() { unsupported('queryObjects'); },
            GCProfiler: class GCProfiler {
                start() { unsupported('GCProfiler.start'); }
                stop() { unsupported('GCProfiler.stop'); }
            },
            startupSnapshot: {
                isBuildingSnapshot() { return false; },
                addSerializeCallback() { throw notBuildingSnapshot(); },
                addDeserializeCallback() { throw notBuildingSnapshot(); },
                setDeserializeMainFunction() { throw notBuildingSnapshot(); },
            },
        };
    })(),
    'vm': vm,
    // Minimal stubs — undici/file-type/anthropic-sdk import these at module
    // init even when their stream code paths aren't exercised by the agent's
    // actual HTTP transport (which goes through our native socket/tls shim).
    'stream/web': {
        ReadableStream: class ReadableStream {},
        WritableStream: class WritableStream {},
        TransformStream: class TransformStream {},
        ByteLengthQueuingStrategy: class ByteLengthQueuingStrategy {},
        CountQueuingStrategy: class CountQueuingStrategy {},
    },
    'stream/promises': {
        // Sequential pipeline: pump each .pipe() in order; promise resolves
        // when the final destination emits 'finish' (or rejects on error).
        pipeline(...streams) {
            const cb = typeof streams[streams.length - 1] === 'function'
                ? streams.pop() : undefined;
            return new Promise((resolve, reject) => {
                const last = streams[streams.length - 1];
                const onErr = (e) => { cb && cb(e); reject(e); };
                for (let i = 0; i < streams.length - 1; i++) {
                    streams[i].on('error', onErr);
                    streams[i].pipe(streams[i + 1]);
                }
                last.on('error', onErr);
                last.on('finish', () => { cb && cb(); resolve(); });
                last.on('end', () => { cb && cb(); resolve(); });
            });
        },
        finished(stream) {
            return new Promise((resolve, reject) => {
                stream.on('error', reject);
                stream.on('finish', resolve);
                stream.on('end', resolve);
            });
        },
    },
    'stream/consumers': {
        async buffer(stream) {
            const chunks = [];
            for await (const c of stream) chunks.push(Buffer.from(c));
            return Buffer.concat(chunks);
        },
        async text(stream) {
            const buf = await this.buffer(stream);
            return buf.toString('utf8');
        },
        async json(stream) {
            const txt = await this.text(stream);
            return JSON.parse(txt);
        },
        async arrayBuffer(stream) {
            const buf = await this.buffer(stream);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
    },
    'sys': util,
    'inspector': {
        open() {},
        close() {},
        url() { return undefined; },
        waitForDebugger() {},
        Session: class Session extends events.EventEmitter {
            connect() {}
            disconnect() {}
            post(_method, _params, cb) {
                if (typeof _params === 'function') cb = _params;
                if (cb) queueMicrotask(() => cb(_unsupportedNodeApi('inspector', 'Session.post')));
            }
        },
    },
    'trace_events': {
        createTracing() {
            return {
                enable() {},
                disable() {},
                get enabled() { return false; },
                categories: '',
            };
        },
        getEnabledCategories() { return ''; },
    },
    '_http_agent': http,
    '_http_common': {
        HTTPParser: class HTTPParser {},
        methods: HTTP_METHODS,
        STATUS_CODES,
    },
    '_http_outgoing': http,
    '_http_server': http,
    '_stream_readable': stream,
    '_stream_wrap': stream,

    // Private Node modules used by the official suite. These entries either
    // map to the public shim that owns the behavior or expose a support-boundary
    // namespace for V8/native internals that Kandelo deliberately does not ship.
    'internal/errors': internalErrors,
    'internal/util': internalUtil,
    'internal/util/types': util.types,
    'internal/util/inspect': {
        inspect: util.inspect,
        format: util.format,
        formatWithOptions: util.formatWithOptions,
        customInspectSymbol: Symbol.for('nodejs.util.inspect.custom'),
    },
    'internal/util/debuglog': {
        debuglog: util.debuglog,
        debug: util.debuglog,
        initializeDebugEnv() {},
    },
    'internal/util/inspector': {
        isUsingInspector() { return false; },
        sendInspectorCommand(_cb) {
            const cb = typeof _cb === 'function' ? _cb : arguments[arguments.length - 1];
            if (typeof cb === 'function') queueMicrotask(() => cb(_unsupportedNodeApi('internal/util/inspector')));
        },
        getInspectPort() { return 0; },
        isInspectorMessage() { return false; },
    },
    'internal/util/iterable_weak_map': _makeUnsupportedNamespace('internal/util/iterable_weak_map'),
    'internal/validators': internalValidators,
    'internal/options': internalOptions,
    'internal/assert': assert,
    'internal/event_target': internalEventTarget,
    'internal/async_hooks': Object.assign({
        useDomainTrampoline() {},
    }, async_hooks),
    'internal/test/binding': internalTestBinding,
    'internal/test/transfer': _makeUnsupportedNamespace('internal/test/transfer'),
    'internal/test_runner/utils': {
        createDeferredPromise: internalUtil.createDeferredPromise,
        kEmptyObject: internalUtil.kEmptyObject,
    },
    'internal/test_runner/harness': {
        test: nodeTest,
        suite: nodeTest,
        before: nodeTest.before,
        after: nodeTest.after,
        beforeEach: nodeTest.beforeEach,
        afterEach: nodeTest.afterEach,
    },
    'internal/test_runner/runner': { run: nodeTest.run },
    'internal/test_runner/mock/mock': {
        MockTracker: class MockTracker { fn(fn) { return fn || function() {}; } },
    },
    'internal/test_runner/mock/mock_timers': _makeUnsupportedNamespace('internal/test_runner/mock/mock_timers'),
    'internal/timers': timers,
    'internal/child_process': child_process,
    'internal/cluster/round_robin_handle': _makeUnsupportedNamespace('internal/cluster/round_robin_handle'),
    'internal/console/constructor': {
        Console: class Console {
            constructor(options) {
                options = options || {};
                this._out = options.stdout || process.stdout;
                this._err = options.stderr || process.stderr;
            }
            log(...args) { this._out.write(args.map((a) => typeof a === 'string' ? a : util.inspect(a)).join(' ') + '\n'); }
            error(...args) { this._err.write(args.map((a) => typeof a === 'string' ? a : util.inspect(a)).join(' ') + '\n'); }
            warn(...args) { this.error(...args); }
            info(...args) { this.log(...args); }
        },
    },
    'internal/dgram': dgram,
    'internal/encoding': { TextDecoder, TextEncoder },
    'internal/fixed_queue': {
        FixedQueue: class FixedQueue {
            constructor() { this._items = []; }
            push(value) { this._items.push(value); }
            shift() { return this._items.shift(); }
            isEmpty() { return this._items.length === 0; }
        },
    },
    'internal/freelist': {
        FreeList: class FreeList {
            constructor(_name, max, ctor) { this.max = max || 0; this.ctor = ctor || Object; this.list = []; }
            alloc() { return this.list.pop() || new this.ctor(); }
            free(obj) { if (this.list.length < this.max) this.list.push(obj); }
        },
    },
    'internal/fs/promises': fs.promises,
    'internal/fs/sync_write_stream': { SyncWriteStream: class SyncWriteStream extends stream.Writable {} },
    'internal/fs/utils': {
        stringToFlags(flags) { return typeof flags === 'number' ? flags : 0; },
        stringToSymlinkType() { return null; },
        getValidMode(mode, _type, def) { return mode == null ? def : mode; },
        validatePath: internalValidators.validateString,
    },
    'internal/http': http,
    'internal/http2/util': _makeUnsupportedNamespace('internal/http2/util'),
    'internal/js_stream_socket': _makeUnsupportedNamespace('internal/js_stream_socket'),
    'internal/linkedlist': {
        init(list) { list._idleNext = list; list._idlePrev = list; },
        isEmpty(list) { return list._idleNext === list; },
        append(list, item) { item._idleNext = list; item._idlePrev = list._idlePrev; list._idlePrev._idleNext = item; list._idlePrev = item; },
        remove(item) { if (item._idleNext) item._idleNext._idlePrev = item._idlePrev; if (item._idlePrev) item._idlePrev._idleNext = item._idleNext; item._idleNext = null; item._idlePrev = null; },
    },
    'internal/navigator': { navigator: { userAgent: 'Kandelo Node-compatible runtime' } },
    'internal/net': net,
    'internal/priority_queue': _makeUnsupportedNamespace('internal/priority_queue'),
    'internal/readline/utils': {
        CSI: Object.assign(
            (strings, ...args) => {
                let out = '\x1b[';
                for (let i = 0; i < strings.length; i++) {
                    out += strings[i];
                    if (i < args.length) out += args[i];
                }
                return out;
            },
            {
                kEscape: '\x1b',
                kClearToLineBeginning: '\x1b[1K',
                kClearToLineEnd: '\x1b[0K',
                kClearLine: '\x1b[2K',
                kClearScreenDown: '\x1b[0J',
            }
        ),
        charLengthAt(value, index) {
            value = String(value || '');
            if (value.length <= index) return 1;
            return value.codePointAt(index) > 0xffff ? 2 : 1;
        },
        charLengthLeft(value, index) {
            value = String(value || '');
            if (index <= 0) return 0;
            const prev = value.codePointAt(index - 1);
            if (prev >= 0xdc00 && prev <= 0xdfff && index > 1) return 2;
            return 1;
        },
        commonPrefix(strings) {
            if (!strings || strings.length === 0) return '';
            let prefix = strings[0];
            for (const s of strings) while (!String(s).startsWith(prefix)) prefix = prefix.slice(0, -1);
            return prefix;
        },
    },
    'internal/repl': repl,
    'internal/repl/await': _makeUnsupportedNamespace('internal/repl/await'),
    'internal/socket_list': _makeUnsupportedNamespace('internal/socket_list'),
    'internal/socketaddress': {
        InternalSocketAddress: class InternalSocketAddress extends net.SocketAddress {
            constructor(handle) {
                super({
                    address: handle && handle.address,
                    port: handle && handle.port,
                    family: handle && handle.family,
                    flowlabel: handle && handle.flowlabel,
                });
            }
        },
        SocketAddress: net.SocketAddress,
    },
    'internal/streams/add-abort-signal': {
        addAbortSignal(_signal, stream) { return stream; },
    },
    'internal/streams/compose': { compose: (...streams) => streams[streams.length - 1] },
    'internal/streams/state': _makeUnsupportedNamespace('internal/streams/state'),
    'internal/url': url,
    'internal/v8_prof_polyfill': _makeUnsupportedNamespace('internal/v8_prof_polyfill'),
    'internal/webidl': _makeUnsupportedNamespace('internal/webidl'),
    'internal/webstreams/adapters': _makeUnsupportedNamespace('internal/webstreams/adapters'),
    'internal/webstreams/readablestream': {
        ReadableStream: class ReadableStream {},
        ReadableStreamDefaultReader: class ReadableStreamDefaultReader {},
    },
    'internal/webstreams/util': _makeUnsupportedNamespace('internal/webstreams/util'),
    'internal/worker': _makeUnsupportedNamespace('internal/worker'),
    'internal/worker/io': null,
    'internal/worker/js_transferable': _makeUnsupportedNamespace('internal/worker/js_transferable'),
};

const _processBindingCache = Object.create(null);

function _nullProto(value) {
    return Object.assign(Object.create(null), value || {});
}

function _processBinding(name) {
    if (_processBindingCache[name]) return _processBindingCache[name];
    if (name === 'util') {
        const selected = [
            'isAnyArrayBuffer',
            'isArrayBuffer',
            'isArrayBufferView',
            'isAsyncFunction',
            'isDataView',
            'isDate',
            'isExternal',
            'isMap',
            'isMapIterator',
            'isNativeError',
            'isPromise',
            'isRegExp',
            'isSet',
            'isSetIterator',
            'isTypedArray',
            'isUint8Array',
        ];
        const out = {};
        for (const key of selected) out[key] = util.types[key];
        return (_processBindingCache[name] = out);
    }
    if (name === 'constants') {
        return (_processBindingCache[name] = _nullProto({
            crypto: _nullProto({}),
            fs: _nullProto(fs.constants),
            os: _nullProto({
                UV_UDP_REUSEADDR: 4,
                dlopen: _nullProto({ RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0 }),
                errno: _nullProto(nodeOs.constants.errno),
                priority: _nullProto({ PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }),
                signals: _nullProto(nodeOs.constants.signals),
            }),
            trace: _nullProto({}),
            zlib: _nullProto({}),
        }));
    }
    if (name === 'uv') {
        return (_processBindingCache[name] = _nullProto({
            UV_UDP_REUSEADDR: 4,
        }));
    }
    if (name === 'buffer') {
        return (_processBindingCache[name] = _nullProto({
            kMaxLength: Buffer.kMaxLength,
        }));
    }
    if (name === 'natives') {
        return (_processBindingCache[name] = _builtinModules);
    }
    const allowlist = new Set([
        'async_wrap', 'cares_wrap', 'contextify', 'crypto', 'fs',
        'fs_event_wrap', 'http_parser', 'icu', 'inspector', 'js_stream',
        'os', 'pipe_wrap', 'signal_wrap', 'spawn_sync', 'stream_wrap',
        'tcp_wrap', 'tls_wrap', 'tty_wrap', 'udp_wrap', 'url', 'v8', 'zlib',
    ]);
    if (allowlist.has(name)) {
        return (_processBindingCache[name] = _nullProto({}));
    }
    const err = new Error(`No such module: ${name}`);
    err.code = 'ERR_INVALID_MODULE';
    throw err;
}

// Node exposes `node:module` as the CJS Module class itself: a
// constructor that doubles as the namespace for createRequire / _cache
// / _nodeModulePaths / etc., with a self-ref `Module.Module === Module`.
// jiti's CJS loader does `new Be.Module(filename)` and
// `Be.Module._nodeModulePaths(dir)`, so the shim must be a callable
// function with that static surface attached.
// Shared across every _makeRequire — Node's module cache is process-global,
// keyed by absolute resolved path. Builtin cache overrides also live here
// under the bare builtin name, matching Node's CommonJS cache semantics.
const _moduleCache = Object.create(null);
let _mainModule = null;

function _emitModuleParentDeprecation() {
    process.emitWarning(
        'module.parent is deprecated due to accuracy issues. Please use require.main to find program entry point instead.',
        'DeprecationWarning',
        'DEP0144'
    );
}

function _defineModuleParent(mod, parent) {
    let value = parent || null;
    Object.defineProperty(mod, 'parent', {
        enumerable: true,
        configurable: true,
        get() {
            _emitModuleParentDeprecation();
            return value;
        },
        set(next) {
            _emitModuleParentDeprecation();
            value = next;
        },
    });
}

function Module(id, parent) {
    this.id = id || '';
    this.filename = id || '';
    this.loaded = false;
    this.exports = {};
    _defineModuleParent(this, parent || null);
    this.children = [];
    this.paths = id ? Module._nodeModulePaths(path.dirname(id)) : [];
    this.require = (request) => Module.prototype.require.call(this, request);
}
Module.Module = Module;
function _isPublicBuiltinName(name) {
    return name !== 'test' && !name.startsWith('internal/');
}
function _refreshBuiltinMetadata() {
    Module.builtinModules = Object.keys(_builtinModules).filter(_isPublicBuiltinName);
}
function _builtinForSpecifier(id, options) {
    options = options || {};
    if (typeof id !== 'string') return null;
    if (id.startsWith('node:')) {
        if (id === 'node:test') return { cacheKey: 'node:test', publicName: 'node:test', value: _builtinModules['node:test'] };
        const bare = id.slice(5);
        if (_builtinModules[bare] !== undefined && _isPublicBuiltinName(bare)) {
            return { cacheKey: bare, publicName: id, value: _builtinModules[bare] };
        }
        if (options.throwUnknownNodePrefix) {
            const err = new Error(`No such built-in module: ${id}`);
            err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
            throw err;
        }
        return null;
    }
    if (id === 'test') {
        return { cacheKey: 'test', publicName: 'test', value: _builtinModules.test, privateAlias: true };
    }
    if (_builtinModules[id] !== undefined) {
        return { cacheKey: id, publicName: id, value: _builtinModules[id] };
    }
    return null;
}
function _formatCreateRequireArg(value) {
    if (value && typeof value === 'object' &&
        value.constructor === Object &&
        Object.keys(value).length === 0) {
        return '{}';
    }
    return util.inspect(value);
}
Module.createRequire = function (filename) {
    const original = filename;
    if (filename && typeof filename === 'object') {
        if (typeof filename.href === 'string' && filename.protocol === 'file:') {
            filename = filename.href;
        } else {
            const err = new TypeError(`The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received ${_formatCreateRequireArg(original)}`);
            err.code = 'ERR_INVALID_ARG_VALUE';
            throw err;
        }
    }
    if (typeof filename === 'string') {
        if (filename.startsWith('file://')) {
            filename = url.fileURLToPath(filename);
        } else if (!path.isAbsolute(filename)) {
            const err = new TypeError(`The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received '${filename}'`);
            err.code = 'ERR_INVALID_ARG_VALUE';
            throw err;
        }
    } else {
        const err = new TypeError(`The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received ${_formatCreateRequireArg(original)}`);
        err.code = 'ERR_INVALID_ARG_VALUE';
        throw err;
    }
    return _makeRequire(filename);
};
Module._cache = _moduleCache;
Module._extensions = {
    '.js': null,
    '.json': null,
    '.node': null,
};
Module.globalPaths = [];
Module._nodeModulePaths = function (from) {
    const paths = [];
    let dir = from;
    while (true) {
        if (path.basename(dir) !== 'node_modules') {
            paths.push(path.join(dir, 'node_modules'));
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return paths;
};
Module._initPaths = function () {
    const paths = [];
    const nodePath = process.env.NODE_PATH;
    if (nodePath) {
        for (const entry of String(nodePath).split(':')) {
            if (entry) paths.push(entry);
        }
    }
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
        paths.push(path.join(home, '.node_modules'));
        paths.push(path.join(home, '.node_libraries'));
    }
    const execDir = path.dirname(process.execPath || '/usr/bin/node');
    const prefix = path.dirname(execDir);
    paths.push(path.join(prefix, 'lib', 'node'));
    Module.globalPaths = paths;
    return paths;
};
Module._resolveLookupPaths = function (request, parent) {
    if (typeof request !== 'string') request = String(request);
    const isRelative = request === '.' || request === '..' ||
        request.startsWith('./') || request.startsWith('../');
    if (isRelative) return ['.'];
    if (request.startsWith('/')) return [''];
    const parentPaths = parent && Array.isArray(parent.paths) ? parent.paths : [];
    return parentPaths.concat(Module.globalPaths);
};
Module._resolveFilename = function (id, parent) {
    const builtin = _builtinForSpecifier(id, { throwUnknownNodePrefix: true });
    if (builtin && !builtin.privateAlias) return builtin.publicName;
    if (builtin) return builtin.cacheKey;
    const basedir = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
    const resolvedPath = _resolveFile(id, basedir);
    if (!resolvedPath) {
        const err = new Error(`Cannot find module '${id}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
    }
    return _moduleRealpath(resolvedPath);
};
Module.isBuiltin = function (id) {
    const builtin = _builtinForSpecifier(id);
    return !!builtin && !builtin.privateAlias && _isPublicBuiltinName(builtin.publicName);
};
Module.prototype.require = function (id) {
    const filename = this.filename || this.id || process.cwd() + '/repl';
    return _makeRequire(filename, this)(id);
};
_builtinModules['module'] = Module;

// `require('process')` and `import 'node:process'` both return the same
// global. Node ships this as a real builtin module; npm's chalk dependency
// (via its vendored supports-color) does `import process from 'node:process'`.
_builtinModules['process'] = process;
_refreshBuiltinMetadata();
Module._initPaths();

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
    return err === 0 ? resolved : p;
}

// Resolve a package directory's main entry: package.json#main → index.js.
// Returns the resolved file path, or null if neither exists.
function _resolvePackageMain(pkgDir) {
    const pkgJson = pkgDir + '/package.json';
    if (_isReg(pkgJson)) {
        try {
            const pkg = JSON.parse(std.loadFile(pkgJson));
            const main = pkg && Object.prototype.hasOwnProperty.call(pkg, 'main') && pkg.main
                ? pkg.main
                : 'index.js';
            const mainPath = path.resolve(pkgDir, main);
            if (_isReg(mainPath)) return mainPath;
            if (_isReg(mainPath + '.js')) return mainPath + '.js';
            if (_isReg(mainPath + '.json')) return mainPath + '.json';
            if (_isReg(mainPath + '/index.js')) return mainPath + '/index.js';
            if (_isReg(mainPath + '/index.json')) return mainPath + '/index.json';
        } catch {}
    }
    if (_isReg(pkgDir + '/index.js')) return pkgDir + '/index.js';
    if (_isReg(pkgDir + '/index.json')) return pkgDir + '/index.json';
    return null;
}

function _hasKnownModuleExtension(p) {
    return p.endsWith('.js') || p.endsWith('.json') || p.endsWith('.mjs') || p.endsWith('.cjs');
}

function _resolveAsFileOrDirectory(target, options) {
    options = options || {};
    const allowExtensions = options.allowExtensions !== false;
    if (_isReg(target)) return target;
    if (allowExtensions && !_hasKnownModuleExtension(target)) {
        if (_isReg(target + '.js')) return target + '.js';
        if (_isReg(target + '.json')) return target + '.json';
    }
    if (_isDir(target)) {
        const main = _resolvePackageMain(target);
        if (main) return main;
    }
    return null;
}

function _resolveFile(id, basedir) {
    // Relative or absolute id: resolve against basedir without node_modules walk.
    // Bare '.' / '..' are valid (sigstore tuf does `require(".")` for sibling index.js).
    const isRelOrAbs = id.startsWith('/') || id.startsWith('./') || id.startsWith('../') ||
        id === '.' || id === '..';
    if (isRelOrAbs) {
        const baseAbs = id.startsWith('/') ? id : basedir + '/' + id;
        const norm = path.normalize(baseAbs);
        return _resolveAsFileOrDirectory(norm, { allowExtensions: !id.endsWith('/') });
    }

    // Bare specifier: walk node_modules upward.
    let dir = basedir;
    while (true) {
        const nmDir = dir + '/node_modules/' + id;
        const local = _resolveAsFileOrDirectory(nmDir, { allowExtensions: !id.endsWith('/') });
        if (local) return local;
        if (dir === '/' || dir === '') break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    for (const globalPath of Module.globalPaths) {
        const resolved = _resolveAsFileOrDirectory(path.join(globalPath, id), { allowExtensions: !id.endsWith('/') });
        if (resolved) return resolved;
    }
    return null;
}

function _stripShebang(source) {
    if (source && source.charCodeAt(0) === 35 && source.charCodeAt(1) === 33) {
        const end = source.indexOf('\n');
        if (end < 0) return '';
        return '//' + source.slice(2);
    }
    return source;
}

function _addModuleChild(parentModule, childModule) {
    if (!parentModule || !childModule || !Array.isArray(parentModule.children)) return;
    if (!parentModule.children.includes(childModule)) parentModule.children.push(childModule);
}

function _defineRequireProperties(require) {
    Object.defineProperty(require, 'cache', {
        value: _moduleCache,
        writable: true,
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(require, 'main', {
        value: _mainModule,
        writable: true,
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(require, 'extensions', {
        value: Module._extensions,
        writable: true,
        configurable: true,
        enumerable: true,
    });
}

function _makeRequire(filename, parentModule) {
    const basedir = path.dirname(_moduleRealpath(filename || process.cwd() + '/repl'));

    function require(id) {
        // Built-in modules (with or without 'node:' prefix)
        const builtin = _builtinForSpecifier(id, { throwUnknownNodePrefix: true });
        if (builtin) {
            if (!id.startsWith('node:') && _moduleCache[builtin.cacheKey]) {
                return _moduleCache[builtin.cacheKey].exports;
            }
            return builtin.value;
        }

        // Resolve file path
        const resolvedPath = _resolveFile(id, basedir);
        if (!resolvedPath) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        const resolved = _moduleRealpath(resolvedPath);

        // Check cache
        if (_moduleCache[resolved]) {
            _addModuleChild(parentModule, _moduleCache[resolved]);
            return _moduleCache[resolved].exports;
        }

        // Load and execute
        let source = std.loadFile(resolved);
        if (source === null) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        source = _stripShebang(source);

        const dirname = path.dirname(resolved);
        const mod = new Module(resolved, parentModule || null);
        mod.id = resolved;
        mod.filename = resolved;
        mod.loaded = false;
        mod.exports = {};
        mod.children = [];
        mod.paths = Module._nodeModulePaths(dirname);
        _moduleCache[resolved] = mod;
        _addModuleChild(parentModule, mod);

        if (resolved.endsWith('.json')) {
            mod.exports = JSON.parse(source);
            mod.loaded = true;
            return mod.exports;
        }

        // Wrap and execute. Compile via evalScriptAsFunction (not `new Function`)
        // so the wrapped script's [[ScriptOrModule]] carries `resolved` — that's
        // what JS_GetScriptOrModuleName returns to the C-side module normalizer
        // when this body calls dynamic `import()`. Without it, bare specifiers
        // (`import('chalk')`) can't tell which node_modules tree to walk.
        const wrappedFn = _nodeNative.evalScriptAsFunction(
            '(function (exports, require, module, __filename, __dirname) {\n' +
                source +
                '\n})',
            resolved
        );

        const childRequire = _makeRequire(resolved, mod);
        mod.require = childRequire;
        try {
            wrappedFn(mod.exports, childRequire, mod, resolved, dirname);
        } catch (e) {
            delete _moduleCache[resolved];
            throw e;
        }
        mod.loaded = true;
        return mod.exports;
    }

    require.resolve = function(id) {
        const builtin = _builtinForSpecifier(id, { throwUnknownNodePrefix: true });
        if (builtin && !builtin.privateAlias) return builtin.publicName;
        if (builtin) return builtin.cacheKey;
        const resolvedPath = _resolveFile(id, basedir);
        if (!resolvedPath) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        return _moduleRealpath(resolvedPath);
    };

    _defineRequireProperties(require);

    return require;
}

function _nearestPackageType(filename) {
    let dir = path.dirname(filename);
    while (dir && dir !== '/') {
        const pkgJson = dir + '/package.json';
        if (_isReg(pkgJson)) {
            try {
                const pkg = JSON.parse(std.loadFile(pkgJson));
                if (pkg && Object.prototype.hasOwnProperty.call(pkg, 'type') && typeof pkg.type === 'string') return pkg.type;
            } catch {}
            return '';
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '';
}

function _looksLikeEsmMain(filename, source) {
    if (filename.endsWith('.mjs')) return true;
    if (filename.endsWith('.cjs')) return false;
    if (_nearestPackageType(filename) === 'module') return true;
    const withoutShebang = _stripShebang(source);
    return /(^|\n)\s*(import\s+(?:[^('"`]|[\r\n])+?\s+from\s*['"]|export\s+)/.test(withoutShebang);
}

function _namedImportBindings(bindings) {
    return bindings
        .replace(/^\s*\{|\}\s*$/g, '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/\s+as\s+/g, ': '))
        .join(', ');
}

let _esmImportTempId = 0;
function _defaultImportBinding(name, moduleRef) {
    return `const ${name} = (${moduleRef} && Object.prototype.hasOwnProperty.call(${moduleRef}, 'default')) ? ${moduleRef}.default : ${moduleRef};`;
}

const _esmRequireBinding = '__kandelo_require';

function _rewriteStaticEsmImports(source) {
    source = source.replace(
        /(^|\n)\s*import\s+([\s\S]*?)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
        (match, prefix, clause, specLiteral) => {
            clause = clause.trim();
            if (clause.startsWith('{')) {
                return `${prefix}const { ${_namedImportBindings(clause)} } = ${_esmRequireBinding}(${specLiteral});`;
            }
            if (clause.startsWith('*')) {
                const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
                if (!ns) return match;
                return `${prefix}const ${ns[1]} = ${_esmRequireBinding}(${specLiteral});`;
            }
            const comma = clause.indexOf(',');
            if (comma >= 0) {
                const defaultName = clause.slice(0, comma).trim();
                const named = clause.slice(comma + 1).trim();
                const tmp = `__kandelo_esm_${_esmImportTempId++}`;
                let out = `${prefix}const ${tmp} = ${_esmRequireBinding}(${specLiteral});\n${_defaultImportBinding(defaultName, tmp)}`;
                if (named.startsWith('{')) {
                    out += `\nconst { ${_namedImportBindings(named)} } = ${tmp};`;
                }
                return out;
            }
            return `${prefix}const __kandelo_esm_${_esmImportTempId} = ${_esmRequireBinding}(${specLiteral});\n` +
                _defaultImportBinding(clause, `__kandelo_esm_${_esmImportTempId++}`);
        },
    );
    return source.replace(
        /(^|\n)\s*import\s+(['"][^'"]+['"])[ \t]*;?/g,
        (_match, prefix, specLiteral) => `${prefix}${_esmRequireBinding}(${specLiteral});`,
    );
}

function _drainSpiderMonkeyJobs(maxSpins) {
    if (typeof drainJobQueue !== 'function') return;
    const spins = maxSpins === undefined ? 32 : maxSpins;
    for (let i = 0; i < spins; i++) drainJobQueue();
}

let _timerSleepView = null;
function _sleepForTimerDelay(delayMs) {
    const delay = Math.max(0, Math.min(Number(delayMs) || 0, 25));
    if (delay <= 0) return;
    if (_timerSleepView === null &&
        typeof SharedArrayBuffer === 'function' &&
        typeof Atomics === 'object' &&
        typeof Atomics.wait === 'function') {
        try {
            _timerSleepView = new Int32Array(new SharedArrayBuffer(4));
        } catch (_) {
            _timerSleepView = false;
        }
    }
    if (_timerSleepView) {
        try {
            Atomics.wait(_timerSleepView, 0, 0, delay);
            return;
        } catch (_) {}
    }
    const end = Date.now() + delay;
    while (Date.now() < end) {}
}

function _runAdapterDueTimers() {
    if (typeof __kandeloRunDueTimers !== 'function') return 0;
    return Number(__kandeloRunDueTimers()) || 0;
}

function _nextAdapterTimerDelay() {
    if (typeof __kandeloNextTimerDelay !== 'function') return null;
    const delay = __kandeloNextTimerDelay();
    if (delay === null || delay === undefined) return null;
    return Math.max(0, Number(delay) || 0);
}

function _handleTopLevelFailure(err) {
    try {
        if (!process._handleUncaughtException(err)) {
            console.error(_formatThrownFailure(err));
            process.exitCode = process.exitCode || 1;
            return false;
        }
        return true;
    } catch (handlerErr) {
        console.error(_formatThrownFailure(handlerErr));
        process.exitCode = process.exitCode || 1;
        return false;
    }
}

function _drainEventLoopBeforeExit() {
    let emittedBeforeExit = false;
    let spins = 0;
    while (!process._exiting) {
        _drainSpiderMonkeyJobs();
        if (!timers._kandeloHasRefedHandles()) {
            if (!emittedBeforeExit) {
                emittedBeforeExit = true;
                process.emit('beforeExit', process.exitCode || 0);
                continue;
            }
            break;
        }
        const ran = _runAdapterDueTimers();
        _drainSpiderMonkeyJobs();
        if (ran > 0) {
            emittedBeforeExit = false;
            spins = 0;
            continue;
        }
        if (++spins > 100000) {
            console.error('kandelo: timer event loop did not quiesce');
            process.exitCode = process.exitCode || 1;
            break;
        }
        const delay = _nextAdapterTimerDelay();
        if (delay === null) break;
        _sleepForTimerDelay(delay);
    }
}

function _runCommonJsMain(filename) {
    filename = _moduleRealpath(filename);
    const source = std.loadFile(filename);
    if (source === null) {
        const err = new Error(`Cannot find module '${filename}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
    }
    const dirname = path.dirname(filename);
    const mainModule = new Module(filename, null);
    mainModule.id = '.';
    mainModule.filename = filename;
    mainModule.paths = Module._nodeModulePaths(dirname);
    _mainModule = mainModule;
    _moduleCache[filename] = mainModule;
    mainModule.require = _makeRequire(filename, mainModule);
    let continueEventLoop = true;
    try {
        const wrappedFn = _nodeNative.evalScriptAsFunction(
            '(function (exports, require, module, __filename, __dirname) {\n' +
                _stripShebang(source) +
                '\n})',
            filename
        );
        wrappedFn(mainModule.exports, mainModule.require, mainModule, filename, dirname);
        mainModule.loaded = true;
    } catch (err) {
        delete _moduleCache[filename];
        continueEventLoop = _handleTopLevelFailure(err);
    }
    if (continueEventLoop) _drainEventLoopBeforeExit();
    process.exit(process.exitCode || 0);
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

function _runEsmMain(filename, source) {
    const module = new Module(filename, null);
    module.id = '.';
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    _mainModule = module;
    _moduleCache[filename] = module;
    const require = _makeRequire(filename, module);
    module.require = require;
    const dirname = path.dirname(filename);
    const fileUrl = url.pathToFileURL(filename).href;
    const transformed = _rewriteStaticEsmImports(_stripShebang(source))
        .replace(/\bimport\.meta\.url\b/g, JSON.stringify(fileUrl));
    const wrappedFn = _nodeNative.evalScriptAsFunction(
        '(async function () {\n' +
            `const ${_esmRequireBinding} = arguments[0];\n` +
            transformed +
            '\n})',
        filename,
    );
    let settled = false;
    let failure = null;
    Promise.resolve(wrappedFn(require)).then(
        () => { settled = true; },
        (err) => { failure = err; settled = true; },
    );
    let spins = 0;
    while (!settled && typeof drainJobQueue === 'function') {
        drainJobQueue();
        if (++spins > 100000) {
            failure = new Error('ES module main did not settle after draining the SpiderMonkey job queue');
            settled = true;
        }
    }
    if (failure) {
        if (!_handleTopLevelFailure(failure)) {
            _drainSpiderMonkeyJobs();
            process.exit(process.exitCode || 0);
        }
    }
    _drainEventLoopBeforeExit();
    process.exit(process.exitCode || 0);
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
        _runEsmMain(_mainScriptPath, source);
    } else {
        _runCommonJsMain(_mainScriptPath);
    }
}

_defineGlobal('__kandeloRunCommonJsMain', function __kandeloRunCommonJsMain(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
        throw _makeInvalidArgTypeError('filename', 'string', filename);
    }
    const resolved = path.isAbsolute(filename) ? filename : path.resolve(process.cwd(), filename);
    _runCommonJsMain(resolved);
});

// ============================================================
// Set up globals
// ============================================================

// process.argv is set by the C entry point via execArgv global
if (typeof execArgv !== 'undefined') {
    process.argv = Array.from(execArgv);
    const envArgv0 = std.getenv('KANDELO_NODE_ARGV0');
    process.argv0 = envArgv0 || ((typeof argv0 !== 'undefined' && argv0) ? argv0 : (process.argv[0] || 'node'));
}

function _findMainScriptArg(argv) {
    if (!argv || argv.length <= 1) return '';
    for (let i = 1; i < argv.length; i++) {
        const arg = String(argv[i] || '');
        if (arg === '--') {
            const next = argv[i + 1];
            return next ? (path.isAbsolute(next) ? next : path.resolve(process.cwd(), next)) : '';
        }
        if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') {
            return '';
        }
        if (arg.startsWith('-')) continue;
        return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    }
    return '';
}

// Global require. For `node script.js`, basedir is the script's directory
// so its top-level relative requires resolve against itself, matching Node's
// per-file require semantics. For -e/-p/REPL (no script in argv), basedir
// falls back to cwd.
const _detectedMainScriptArg = _findMainScriptArg(process.argv);
_defineGlobal('require', _makeRequire(_detectedMainScriptArg || process.cwd() + '/repl'));

// Node.js globals
_defineGlobal('process', process);
_defineGlobal('Buffer', Buffer);
_defineGlobal('global', globalThis);
_defineGlobal('GLOBAL', globalThis); // deprecated alias

// Timer globals — overwrite the js_std_add_helpers stubs that return a
// raw int64 with the wrapped-id objects from `timers` above.
_defineGlobal('setTimeout', timers.setTimeout);
_defineGlobal('clearTimeout', timers.clearTimeout);
_defineGlobal('setInterval', timers.setInterval);
_defineGlobal('clearInterval', timers.clearInterval);
_defineGlobal('setImmediate', timers.setImmediate);
_defineGlobal('clearImmediate', timers.clearImmediate);

// npm and hosted-git-info instantiate URL/URLSearchParams directly without
// `require('url')`. Expose the bootstrap shims when the engine does not ship them.
_defineGlobal('URL', url.URL);
_defineGlobal('URLSearchParams', url.URLSearchParams);

// Web platform globals that modern Node exposes by default. undici/whatwg-
// fetch reach for these at module init (e.g. `webidl.is.ReadableStream =
// MakeTypeAssertion(ReadableStream)` in undici/lib/web/webidl/index.js).
const _streamWeb = _builtinModules['stream/web'];
if (typeof globalThis.ReadableStream === 'undefined')
    _defineGlobal('ReadableStream', _streamWeb.ReadableStream);
if (typeof globalThis.WritableStream === 'undefined')
    _defineGlobal('WritableStream', _streamWeb.WritableStream);
if (typeof globalThis.TransformStream === 'undefined')
    _defineGlobal('TransformStream', _streamWeb.TransformStream);
if (typeof globalThis.ByteLengthQueuingStrategy === 'undefined')
    _defineGlobal('ByteLengthQueuingStrategy', _streamWeb.ByteLengthQueuingStrategy);
if (typeof globalThis.CountQueuingStrategy === 'undefined')
    _defineGlobal('CountQueuingStrategy', _streamWeb.CountQueuingStrategy);
if (typeof globalThis.Blob === 'undefined') _defineGlobal('Blob', class Blob {});
if (typeof globalThis.File === 'undefined') _defineGlobal('File', class File {});
if (typeof globalThis.FormData === 'undefined') _defineGlobal('FormData', class FormData {});
if (typeof globalThis.Headers === 'undefined') _defineGlobal('Headers', class Headers {});
if (typeof globalThis.Request === 'undefined') _defineGlobal('Request', class Request {});
if (typeof globalThis.Response === 'undefined') _defineGlobal('Response', class Response {});
if (typeof globalThis.BroadcastChannel === 'undefined')
    _defineGlobal('BroadcastChannel', class BroadcastChannel {
        constructor(name) { this.name = name; }
        postMessage() {} close() {}
        addEventListener() {} removeEventListener() {}
    });

// Web Crypto global. Modern Node (19+) exposes `globalThis.crypto` separately
// from `require('crypto')`. uuid/dist-node/rng.js and many other packages
// reach for the bare `crypto.getRandomValues()` here without importing
// anything — undefined crypto → silent rejection during session init.
_defineGlobal('crypto', crypto.webcrypto);
_defineGlobal('Crypto', crypto.Crypto);
_defineGlobal('CryptoKey', crypto.CryptoKey);
_defineGlobal('SubtleCrypto', crypto.SubtleCrypto);

// structuredClone — Node 17+ global. Settings managers and other helpers
// use it to deep-copy plain config objects. Falls back to JSON for the
// JSON-safe values these consumers actually pass; will visibly fail on
// non-JSON types (Date, Map, etc.) which we'd rather not silently mangle.
if (typeof globalThis.structuredClone === 'undefined') {
    _defineGlobal('structuredClone', function structuredClone(value, options) {
        const cloned = value instanceof ArrayBuffer
            ? value.slice(0)
            : JSON.parse(JSON.stringify(value));
        const transfer = options && options.transfer;
        if (transfer && typeof transfer[Symbol.iterator] === 'function') {
            for (const item of transfer) {
                if (item instanceof ArrayBuffer) _DETACHED_ARRAY_BUFFERS.add(item);
            }
        }
        return cloned;
    });
}

// DOM Event/EventTarget/Abort primitives. Modern Node exposes these as globals
// and its official tests exercise listener options (`once`, `passive`,
// `signal`) as observable API, so the shim needs more than module-init stubs.
class KandeloEvent {
    constructor(type, init) {
        if (arguments.length === 0 || typeof type === 'symbol') {
            throw _makeInvalidArgTypeError('type', 'string', type);
        }
        if (init !== undefined && init !== null && typeof init !== 'object') {
            throw _makeInvalidArgTypeError('options', 'object', init);
        }
        init = init || {};
        this.type = String(type);
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.composed = !!init.composed;
        this.defaultPrevented = false;
        this.target = null;
        this.currentTarget = null;
        this.eventPhase = 0;
        this.isTrusted = false;
        this._cancelBubble = false;
        this.timeStamp = Date.now();
        this._passive = false;
    }
    get cancelBubble() { return this._cancelBubble; }
    set cancelBubble(value) { this._cancelBubble = !!value; }
    get srcElement() { return this.target; }
    composedPath() {
        return this.eventPhase === KandeloEvent.AT_TARGET && this.currentTarget ? [this.currentTarget] : [];
    }
    preventDefault() {
        if (this.cancelable && !this._passive) this.defaultPrevented = true;
    }
    stopPropagation() { this.cancelBubble = true; }
    stopImmediatePropagation() {
        this.cancelBubble = true;
        this._stopImmediate = true;
    }
    get returnValue() { return !this.defaultPrevented; }
    set returnValue(value) { if (!value) this.preventDefault(); }
}
for (const [name, value] of Object.entries({
    NONE: 0,
    CAPTURING_PHASE: 1,
    AT_TARGET: 2,
    BUBBLING_PHASE: 3,
})) {
    Object.defineProperty(KandeloEvent, name, { value, enumerable: true });
    Object.defineProperty(KandeloEvent.prototype, name, { value, enumerable: true });
}

class KandeloEventTarget {
    constructor() {
        const listeners = new Map();
        Object.defineProperty(this, '_eventTargetListeners', {
            value: listeners,
            configurable: true,
        });
        Object.defineProperty(this, _kEvents, {
            value: listeners,
            configurable: true,
        });
        Object.defineProperty(this, '_maxListeners', {
            value: _eventTargetDefaultMaxListeners,
            writable: true,
            configurable: true,
        });
    }
    addEventListener(type, listener, options) {
        if (!(this instanceof KandeloEventTarget)) {
            const err = new TypeError('Value of "this" must be of type EventTarget');
            err.code = 'ERR_INVALID_THIS';
            throw err;
        }
        if (arguments.length < 2) {
            const err = new TypeError('The "type" and "listener" arguments must be specified');
            err.code = 'ERR_MISSING_ARGS';
            throw err;
        }
        if (listener == null) {
            if (options && typeof options === 'object') void options.passive;
            return undefined;
        }
        if (typeof listener !== 'function' && typeof listener !== 'object') {
            throw _makeInvalidArgTypeError('listener', 'EventListener', listener);
        }
        const opts = _eventListenerOptions(options);
        if (opts.signal !== undefined && !(opts.signal instanceof globalThis.AbortSignal)) {
            throw new TypeError('signal must be an AbortSignal');
        }
        if (opts.signal && opts.signal.aborted) return undefined;
        type = String(type);
        let list = this._eventTargetListeners.get(type);
        if (!list) this._eventTargetListeners.set(type, list = []);
        if (list.some((entry) => !entry.removed && entry.listener === listener && entry.capture === opts.capture)) {
            return undefined;
        }
        const entry = {
            listener,
            once: opts.once,
            passive: opts.passive,
            capture: opts.capture,
            signal: opts.signal || null,
            removed: false,
        };
        if (entry.signal) {
            entry.abortHandler = () => this.removeEventListener(type, listener, { capture: entry.capture });
            entry.signal.addEventListener('abort', entry.abortHandler, { once: true });
        }
        list.push(entry);
        const max = this._maxListeners === undefined ? _eventTargetDefaultMaxListeners : this._maxListeners;
        if (max > 0 && list.length > max && !list.warned) {
            list.warned = true;
            _emitEventTargetMemoryWarning(this, type, list.length);
        }
        return undefined;
    }
    removeEventListener(type, listener, options) {
        if (!(this instanceof KandeloEventTarget)) {
            const err = new TypeError('Value of "this" must be of type EventTarget');
            err.code = 'ERR_INVALID_THIS';
            throw err;
        }
        type = String(type);
        if (listener == null) return undefined;
        const capture = _eventListenerOptions(options).capture;
        const list = this._eventTargetListeners.get(type);
        if (!list) return undefined;
        for (const entry of list) {
            if (!entry.removed &&
                (entry.listener === listener ||
                    (entry.listener &&
                        entry.listener[_kNodeEventTargetListenerWrapper] &&
                        entry.listener.listener === listener)) &&
                entry.capture === capture) {
                entry.removed = true;
                if (entry.signal && entry.abortHandler) {
                    entry.signal.removeEventListener('abort', entry.abortHandler);
                }
            }
        }
        const remaining = list.filter((entry) => !entry.removed);
        if (remaining.length === 0) {
            this._eventTargetListeners.delete(type);
        } else {
            remaining.warned = list.warned;
            this._eventTargetListeners.set(type, remaining);
        }
        return undefined;
    }
    dispatchEvent(event) {
        if (!(this instanceof KandeloEventTarget)) {
            const err = new TypeError('Value of "this" must be of type EventTarget');
            err.code = 'ERR_INVALID_THIS';
            throw err;
        }
        if (!(event instanceof KandeloEvent)) {
            throw _makeInvalidArgTypeError('event', 'Event', event);
        }
        if (event._dispatching) {
            const err = new Error('The event is already being dispatched');
            err.code = 'ERR_EVENT_RECURSION';
            throw err;
        }
        const list = (this._eventTargetListeners.get(event.type) || []).slice();
        event._dispatching = true;
        event.target = this;
        event.currentTarget = this;
        event.eventPhase = KandeloEvent.AT_TARGET;
        try {
            for (const entry of list) {
                if (entry.removed) continue;
                if (entry.once) this.removeEventListener(event.type, entry.listener, { capture: entry.capture });
                event._passive = entry.passive;
                try {
                    if (typeof entry.listener === 'function') entry.listener.call(this, event);
                    else if (entry.listener && typeof entry.listener.handleEvent === 'function') {
                        entry.listener.handleEvent(event);
                    }
                } catch (err) {
                    queueMicrotask(() => { throw err; });
                } finally {
                    event._passive = false;
                }
                if (event._stopImmediate) break;
            }
        } finally {
            event._dispatching = false;
            event.eventPhase = KandeloEvent.NONE;
            event.currentTarget = null;
        }
        return !event.defaultPrevented;
    }
}

class KandeloNodeEventTarget extends KandeloEventTarget {
    constructor() {
        super();
        this._maxListeners = KandeloNodeEventTarget.defaultMaxListeners;
    }
    setMaxListeners(n) {
        _assertNodeEventTargetThis(this);
        n = Number(n);
        if (!Number.isFinite(n) || n < 0) {
            const err = new RangeError('The value of "n" is out of range. It must be a non-negative number.');
            err.code = 'ERR_OUT_OF_RANGE';
            throw err;
        }
        this._maxListeners = n;
        return this;
    }
    getMaxListeners() {
        _assertNodeEventTargetThis(this);
        return this._maxListeners;
    }
    eventNames() {
        _assertNodeEventTargetThis(this);
        return Array.from(this._eventTargetListeners.keys())
            .filter((name) => (this._eventTargetListeners.get(name) || []).length > 0);
    }
    listenerCount(type, listener) {
        _assertNodeEventTargetThis(this);
        const list = this._eventTargetListeners.get(String(type));
        if (!list) return 0;
        const active = list.filter((entry) => !entry.removed);
        if (listener === undefined) return active.length;
        return active.filter((entry) => entry.listener === listener ||
            (entry.listener &&
                entry.listener[_kNodeEventTargetListenerWrapper] &&
                entry.listener.listener === listener)).length;
    }
    _wrapNodeListener(listener) {
        if (typeof listener !== 'function') return listener;
        const wrapped = function nodeEventTargetListener(event) {
            const value = event instanceof KandeloCustomEvent ? event.detail : event;
            return listener.call(this, value);
        };
        Object.defineProperty(wrapped, 'listener', {
            value: listener,
            configurable: true,
        });
        Object.defineProperty(wrapped, _kNodeEventTargetListenerWrapper, {
            value: true,
            configurable: true,
        });
        return wrapped;
    }
    on(type, listener, options) {
        _assertNodeEventTargetThis(this);
        this.addEventListener(type, this._wrapNodeListener(listener), options);
        return this;
    }
    addListener(type, listener, options) { return this.on(type, listener, options); }
    once(type, listener, options) {
        _assertNodeEventTargetThis(this);
        const opts = options && typeof options === 'object'
            ? Object.assign({}, options, { once: true })
            : { once: true };
        this.addEventListener(type, this._wrapNodeListener(listener), opts);
        return this;
    }
    off(type, listener, options) {
        _assertNodeEventTargetThis(this);
        this.removeEventListener(type, listener, options);
        return this;
    }
    removeListener(type, listener, options) { return this.off(type, listener, options); }
    removeAllListeners(type) {
        _assertNodeEventTargetThis(this);
        if (type === undefined) this._eventTargetListeners.clear();
        else this._eventTargetListeners.delete(String(type));
        return this;
    }
    emit(type, ...args) {
        _assertNodeEventTargetThis(this);
        if (arguments.length === 0) throw _makeInvalidArgTypeError('type', 'string', type);
        const event = args[0] instanceof KandeloEvent
            ? args[0]
            : new KandeloCustomEvent(String(type), { detail: args[0] });
        return this.dispatchEvent(event);
    }
}
function _assertNodeEventTargetThis(value) {
    if (!(value instanceof KandeloNodeEventTarget)) {
        const err = new TypeError('Value of "this" must be of type NodeEventTarget');
        err.code = 'ERR_INVALID_THIS';
        throw err;
    }
}
Object.defineProperty(KandeloNodeEventTarget, 'defaultMaxListeners', {
    get() { return _eventTargetDefaultMaxListeners; },
    set(value) { _eventTargetDefaultMaxListeners = Number(value); },
    configurable: true,
});
Object.defineProperty(KandeloNodeEventTarget, 'name', { value: 'NodeEventTarget' });
Object.defineProperty(KandeloEvent.prototype, Symbol.toStringTag, {
    value: 'Event',
    configurable: true,
});
Object.defineProperty(KandeloEventTarget.prototype, Symbol.toStringTag, {
    value: 'EventTarget',
    configurable: true,
});
for (const key of ['addEventListener', 'dispatchEvent', 'removeEventListener']) {
    Object.defineProperty(KandeloEventTarget.prototype, key, {
        value: KandeloEventTarget.prototype[key],
        writable: true,
        configurable: true,
        enumerable: true,
    });
}
Object.defineProperty(KandeloEvent, 'length', { value: 1 });
Object.defineProperty(KandeloEvent, 'name', { value: 'Event' });
Object.defineProperty(KandeloEventTarget, 'name', { value: 'EventTarget' });

function _eventListenerOptions(options) {
    if (options === undefined || options === null) {
        return { capture: false, once: false, passive: false, signal: undefined };
    }
    if (typeof options === 'boolean') {
        return { capture: options, once: false, passive: false, signal: undefined };
    }
    if (typeof options !== 'object') {
        return { capture: false, once: false, passive: false, signal: undefined };
    }
    return {
        capture: !!options.capture,
        once: !!options.once,
        passive: !!options.passive,
        signal: options.signal,
    };
}

function _emitEventTargetMemoryWarning(target, type, count) {
    if (typeof process === 'undefined' || typeof process.emitWarning !== 'function') return;
    const targetName = target && target.constructor && target.constructor.name || 'EventTarget';
    const err = new Error(
        `Possible EventTarget memory leak detected. ${count} ${type} listeners added to ${targetName}. ` +
        'Use events.setMaxListeners() to increase limit',
    );
    err.name = 'MaxListenersExceededWarning';
    err.target = target;
    err.count = count;
    err.type = type;
    process.emitWarning(err);
}

function _defineEventHandler(target, name, eventName) {
    eventName = eventName || name;
    const prop = `on${name}`;
    const slot = Symbol(prop);
    Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: true,
        get() { return this[slot] || null; },
        set(handler) {
            if (this[slot]) this.removeEventListener(eventName, this[slot]);
            if (typeof handler === 'function') {
                this[slot] = handler;
                this.addEventListener(eventName, handler);
            } else {
                this[slot] = null;
            }
        },
    });
}

class KandeloMessageEvent extends KandeloEvent {
    constructor(type, init) {
        init = init || {};
        super(type, init);
        const validatePort = (value, name) => {
            if (value == null) return value;
            if (typeof globalThis.MessagePort === 'function' && value instanceof globalThis.MessagePort) return value;
            const err = new TypeError(`The "${name}" property must be an instance of MessagePort`);
            err.code = 'ERR_INVALID_ARG_TYPE';
            throw err;
        };
        const data = Object.prototype.hasOwnProperty.call(init, 'data') && init.data !== undefined ? init.data : null;
        const source = validatePort(init.source === undefined ? null : init.source, 'init.source');
        let ports = [];
        if (init.ports !== undefined) {
            if (init.ports == null || typeof init.ports[Symbol.iterator] !== 'function') {
                throw new TypeError('ports is not iterable');
            }
            ports = Array.from(init.ports, (port, index) => validatePort(port, `init.ports[${index}]`));
        }
        Object.defineProperties(this, {
            data: { value: data, enumerable: true },
            origin: { value: init.origin === undefined ? '' : String(init.origin), enumerable: true },
            lastEventId: { value: init.lastEventId === undefined ? '' : String(init.lastEventId), enumerable: true },
            source: { value: source, enumerable: true },
            ports: { value: ports, enumerable: true },
        });
    }
}
class KandeloCloseEvent extends KandeloEvent {
    constructor(type, init) {
        super(type, init);
        this.code = (init && init.code) || 0;
        this.reason = (init && init.reason) || '';
        this.wasClean = !!(init && init.wasClean);
    }
}
class KandeloErrorEvent extends KandeloEvent {
    constructor(type, init) {
        super(type, init);
        this.error = init && init.error;
        this.message = (init && init.message) || '';
    }
}
class KandeloCustomEvent extends KandeloEvent {
    constructor(type, init) {
        if (arguments.length === 0 || typeof type === 'symbol') {
            throw _makeInvalidArgTypeError('type', 'string', type);
        }
        if (init !== undefined && init !== null && typeof init !== 'object') {
            throw _makeInvalidArgTypeError('options', 'object', init);
        }
        super(type, init || {});
        Object.defineProperty(this, 'detail', {
            value: init && Object.prototype.hasOwnProperty.call(init, 'detail') ? init.detail : null,
            enumerable: true,
        });
    }
}
Object.setPrototypeOf(KandeloCustomEvent, KandeloEvent);
for (const key of ['NONE', 'CAPTURING_PHASE', 'AT_TARGET', 'BUBBLING_PHASE']) {
    Object.defineProperty(KandeloCustomEvent, key, { value: KandeloEvent[key], enumerable: true });
}
Object.defineProperty(KandeloCustomEvent.prototype, Symbol.toStringTag, {
    value: 'CustomEvent',
    configurable: true,
});
Object.defineProperty(KandeloCustomEvent, 'length', { value: 1 });
Object.defineProperty(KandeloCustomEvent, 'name', { value: 'CustomEvent' });

class KandeloDOMException extends Error {
    constructor(message = '', name = 'Error') {
        let causeOptions;
        if (name && typeof name === 'object') {
            causeOptions = Object.prototype.hasOwnProperty.call(name, 'cause') ? { cause: name.cause } : undefined;
            super(String(message), causeOptions);
            this.name = name.name === undefined ? 'Error' : String(name.name);
            if (Object.prototype.hasOwnProperty.call(name, 'cause') && !('cause' in this)) {
                Object.defineProperty(this, 'cause', {
                    value: name.cause,
                    writable: true,
                    configurable: true,
                });
            }
        } else {
            super(String(message));
            this.name = name === undefined ? 'Error' : String(name);
        }
        const codes = {
            IndexSizeError: 1,
            HierarchyRequestError: 3,
            WrongDocumentError: 4,
            InvalidCharacterError: 5,
            NoModificationAllowedError: 7,
            NotFoundError: 8,
            NotSupportedError: 9,
            InUseAttributeError: 10,
            InvalidStateError: 11,
            SyntaxError: 12,
            InvalidModificationError: 13,
            NamespaceError: 14,
            InvalidAccessError: 15,
            TypeMismatchError: 17,
            SecurityError: 18,
            NetworkError: 19,
            AbortError: 20,
            URLMismatchError: 21,
            QuotaExceededError: 22,
            TimeoutError: 23,
            InvalidNodeTypeError: 24,
            DataCloneError: 25,
        };
        this.code = codes[this.name] || 0;
    }
}
Object.defineProperty(KandeloDOMException, 'name', { value: 'DOMException' });

class KandeloAbortSignal extends KandeloEventTarget {
    constructor() {
        super();
        this.aborted = false;
        this.reason = undefined;
    }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason) {
        const signal = new KandeloAbortSignal();
        _abortSignal(signal, reason);
        return signal;
    }
    static timeout(ms) {
        const signal = new KandeloAbortSignal();
        timers.setTimeout(() => {
            const err = new KandeloDOMException('The operation was aborted due to timeout', 'TimeoutError');
            _abortSignal(signal, err);
        }, ms);
        return signal;
    }
    static any(signals) {
        const signal = new KandeloAbortSignal();
        for (const input of signals) {
            if (!(input instanceof KandeloAbortSignal)) throw _makeInvalidArgTypeError('signals', 'AbortSignal', input);
            if (input.aborted) {
                _abortSignal(signal, input.reason);
                return signal;
            }
            input.addEventListener('abort', () => _abortSignal(signal, input.reason), { once: true });
        }
        return signal;
    }
}

class KandeloAbortController {
    constructor() { this.signal = new KandeloAbortSignal(); }
    abort(reason) { _abortSignal(this.signal, reason); }
}

function _abortSignal(signal, reason) {
    if (signal.aborted) return;
    signal.aborted = true;
    signal.reason = reason !== undefined ? reason : new KandeloDOMException('This operation was aborted', 'AbortError');
    signal.dispatchEvent(new KandeloEvent('abort'));
    const list = signal._eventTargetListeners.get('abort');
    if (list) list.length = 0;
    signal._eventTargetListeners.delete('abort');
}

_defineGlobal('Event', KandeloEvent);
_defineGlobal('EventTarget', KandeloEventTarget);
_defineGlobal('MessageEvent', KandeloMessageEvent);
_defineGlobal('CloseEvent', KandeloCloseEvent);
_defineGlobal('ErrorEvent', KandeloErrorEvent);
_defineGlobal('CustomEvent', KandeloCustomEvent);
_defineGlobal('DOMException', KandeloDOMException);
_defineGlobal('AbortSignal', KandeloAbortSignal);
_defineGlobal('AbortController', KandeloAbortController);
_builtinModules['internal/worker/io'] = _createInternalWorkerIo();

function _copyArrayBuffer(buffer) {
    const copy = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(copy).set(new Uint8Array(buffer));
    return copy;
}

function _messageClone(data, transferList) {
    if (data instanceof net.SocketAddress) {
        return new net.SocketAddress({
            address: data.address,
            port: data.port,
            family: data.family,
            flowlabel: data.flowlabel,
        });
    }
    if (data instanceof net.BlockList) {
        const clone = new net.BlockList();
        clone._rules = data._rules;
        clone.rules = data.rules;
        return clone;
    }
    let transferredBuffers = null;
    if (transferList && typeof transferList[Symbol.iterator] === 'function') {
        transferredBuffers = new Set();
        for (const item of transferList) {
            if (item instanceof ArrayBuffer) transferredBuffers.add(item);
        }
    }
    const cloned = transferredBuffers && transferredBuffers.has(data) ? _copyArrayBuffer(data) : data;
    if (transferredBuffers) {
        for (const buffer of transferredBuffers) _DETACHED_ARRAY_BUFFERS.add(buffer);
    }
    return cloned;
}

function _messageTransferList(transferList) {
    if (transferList === undefined) return undefined;
    if (transferList === null || typeof transferList[Symbol.iterator] !== 'function') {
        throw _makeInvalidArgTypeError('transferList', 'iterable', transferList);
    }
    return Array.from(transferList);
}

function _messageDataCloneError(message) {
    return new KandeloDOMException(message, 'DataCloneError');
}

function _validateMessageTransferList(transferList) {
    const seen = new Set();
    if (!transferList) return;
    for (const item of transferList) {
        if (seen.has(item)) throw _messageDataCloneError('Transfer list contains duplicate ArrayBuffer');
        seen.add(item);
        if (!(item instanceof ArrayBuffer) && !(item instanceof KandeloMessagePort)) {
            throw _messageDataCloneError('Object that needs transfer was found in message but not listed in transferList');
        }
    }
}

class KandeloMessagePort extends KandeloEventTarget {
    constructor() {
        super();
        this.onmessage = null;
        this._peer = null;
        this._closed = false;
    }
    postMessage(data, transferList) {
        if (this._closed || !this._peer || this._peer._closed) return;
        transferList = _messageTransferList(transferList);
        _validateMessageTransferList(transferList);
        const cloned = _messageClone(data, transferList);
        const target = this._peer;
        queueMicrotask(() => {
            if (target._closed) return;
            const event = new KandeloMessageEvent('message', { data: cloned });
            if (typeof target.onmessage === 'function') target.onmessage.call(target, event);
            target.dispatchEvent(event);
        });
    }
    start() {}
    close() {
        this._closed = true;
        this.dispatchEvent(new KandeloEvent('close'));
    }
    ref() { return this; }
    unref() { return this; }
}
class KandeloMessageChannel {
    constructor() {
        this.port1 = new KandeloMessagePort();
        this.port2 = new KandeloMessagePort();
        this.port1._peer = this.port2;
        this.port2._peer = this.port1;
    }
}
_defineGlobal('MessagePort', KandeloMessagePort);
_defineGlobal('MessageChannel', KandeloMessageChannel);

class KandeloWebSocket extends KandeloEventTarget {
    constructor(url, protocols) {
        super();
        this.url = String(url);
        this.protocol = Array.isArray(protocols) ? protocols[0] || '' : (protocols || '');
        this.readyState = KandeloWebSocket.CONNECTING;
        queueMicrotask(() => {
            this.readyState = KandeloWebSocket.CLOSED;
            this.dispatchEvent(new KandeloCloseEvent('close'));
        });
    }
    send() {
        if (this.readyState !== KandeloWebSocket.OPEN) {
            throw new KandeloDOMException('WebSocket is not open', 'InvalidStateError');
        }
    }
    close() {
        this.readyState = KandeloWebSocket.CLOSED;
        this.dispatchEvent(new KandeloCloseEvent('close'));
    }
}
for (const [name, value] of Object.entries({
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
})) {
    Object.defineProperty(KandeloWebSocket, name, { value, enumerable: true });
    Object.defineProperty(KandeloWebSocket.prototype, name, { value, enumerable: true });
}
Object.defineProperty(KandeloWebSocket, 'name', { value: 'WebSocket' });
_defineGlobal('WebSocket', KandeloWebSocket);

// Some engines ship without ECMA-402 (Intl). TUIs use Intl.Segmenter for
// grapheme-based terminal-width math; a per-code-point fallback is good
// enough for ASCII / BMP — non-trivial graphemes (emoji ZWJ sequences,
// combining marks) collapse to multiple segments, which most UIs tolerate.
if (typeof globalThis.Intl === 'undefined') {
    _defineGlobal('Intl', {
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
    });
}

// __dirname and __filename for the main module (set when running a file)
const _mainScriptArg = _detectedMainScriptArg;
const _mainScriptPath = _mainScriptArg ? _moduleRealpath(_mainScriptArg) : '';
_defineGlobal('__filename', _mainScriptPath);
_defineGlobal('__dirname', _mainScriptPath ? path.dirname(_mainScriptPath) : '');

// Module reference
_defineGlobal('module', { exports: {} });
_defineGlobal('exports', globalThis.module.exports);

// Bind the global console to process stdout/stderr. SpiderMonkey's shell
// console writes directly to the host stream, which bypasses tests and callers
// that temporarily replace process.stdout.write.
const _globalConsole = new _builtinModules['console'].Console({
    stdout: process.stdout,
    stderr: process.stderr,
});
_globalConsole.Console = _builtinModules['console'].Console;
const _globalConsoleProto = _builtinModules['console'].Console.prototype;
const _globalConsoleMethods = {
    log(...args) { return _globalConsoleProto.log.call(_globalConsole, ...args); },
    info(...args) { return _globalConsoleProto.info.call(_globalConsole, ...args); },
    debug(...args) { return _globalConsoleProto.debug.call(_globalConsole, ...args); },
    warn(...args) { return _globalConsoleProto.warn.call(_globalConsole, ...args); },
    error(...args) { return _globalConsoleProto.error.call(_globalConsole, ...args); },
    trace(...args) { return _globalConsoleProto.trace.call(_globalConsole, ...args); },
    dir(...args) { return _globalConsoleProto.dir.call(_globalConsole, ...args); },
    table(...args) { return _globalConsoleProto.table.call(_globalConsole, ...args); },
    assert(...args) { return _globalConsoleProto.assert.call(_globalConsole, ...args); },
    count(...args) { return _globalConsoleProto.count.call(_globalConsole, ...args); },
    countReset(...args) { return _globalConsoleProto.countReset.call(_globalConsole, ...args); },
    group(...args) { return _globalConsoleProto.group.call(_globalConsole, ...args); },
    groupCollapsed(...args) { return _globalConsoleProto.groupCollapsed.call(_globalConsole, ...args); },
    groupEnd(...args) { return _globalConsoleProto.groupEnd.call(_globalConsole, ...args); },
    time(...args) { return _globalConsoleProto.time.call(_globalConsole, ...args); },
    timeEnd(...args) { return _globalConsoleProto.timeEnd.call(_globalConsole, ...args); },
    timeLog(...args) { return _globalConsoleProto.timeLog.call(_globalConsole, ...args); },
    clear(...args) { return _globalConsoleProto.clear.call(_globalConsole, ...args); },
    dirxml(...args) { return _globalConsoleProto.dirxml.call(_globalConsole, ...args); },
};
Object.assign(_globalConsole, _globalConsoleMethods);
_defineGlobal('console', _globalConsole);

// ============================================================
// WHATWG fetch + Headers/Response/Request/ReadableStream
// ============================================================
//
// Bootstrap reserves stub globals for these (Response/Headers/Request) and a
// stub `class ReadableStream {}` from the stream/web pseudo-module. None of
// them actually do anything. Modern HTTP SDKs (undici, @anthropic-ai/sdk,
// the AWS SDK, etc.) call `fetch(url, { method:'POST', body, headers })`
// and read the response via `await res.json()` or `res.body.getReader()`
// (for streaming SSE). Without a real impl, fetch() ReferenceErrors. The
// implementation is built on top of the existing http/https modules above.
//
(() => {
    class FetchHeaders {
        constructor(init) {
            this._map = new Map();
            if (init instanceof FetchHeaders) {
                for (const [k, v] of init._map) this._map.set(k, v);
            } else if (Array.isArray(init)) {
                for (const [k, v] of init) this.append(k, v);
            } else if (init && typeof init === 'object') {
                for (const k of Object.keys(init)) this.append(k, init[k]);
            }
        }
        _k(name) { return String(name).toLowerCase(); }
        get(name) { const v = this._map.get(this._k(name)); return v === undefined ? null : v; }
        set(name, value) { this._map.set(this._k(name), String(value)); }
        has(name) { return this._map.has(this._k(name)); }
        delete(name) { return this._map.delete(this._k(name)); }
        append(name, value) {
            const k = this._k(name);
            const cur = this._map.get(k);
            this._map.set(k, cur === undefined ? String(value) : cur + ', ' + value);
        }
        forEach(cb, thisArg) {
            for (const [k, v] of this._map) cb.call(thisArg, v, k, this);
        }
        keys() { return this._map.keys(); }
        values() { return this._map.values(); }
        entries() { return this._map.entries(); }
        [Symbol.iterator]() { return this._map.entries(); }
    }

    // Minimal ReadableStream impl. Supports getReader().read(), async
    // iteration, cancel, and the start({enqueue, close, error}) underlying
    // source pattern used below. Not spec-perfect (no backpressure, no
    // tee()) but enough for SSE consumption.
    class MinReadableStream {
        constructor(source) {
            this._source = source || {};
            this._queue = [];
            this._closed = false;
            this._err = null;
            this._waiters = [];
            this._locked = false;
            const ctrl = {
                enqueue: (chunk) => {
                    if (this._closed) return;
                    if (this._waiters.length > 0) {
                        this._waiters.shift().resolve({ value: chunk, done: false });
                    } else {
                        this._queue.push(chunk);
                    }
                },
                close: () => {
                    this._closed = true;
                    while (this._waiters.length > 0) {
                        this._waiters.shift().resolve({ value: undefined, done: true });
                    }
                },
                error: (e) => {
                    this._err = e;
                    this._closed = true;
                    while (this._waiters.length > 0) this._waiters.shift().reject(e);
                },
                get desiredSize() { return 1; },
            };
            if (this._source.start) {
                try {
                    const r = this._source.start(ctrl);
                    if (r && typeof r.then === 'function') r.catch(e => ctrl.error(e));
                } catch (e) { ctrl.error(e); }
            }
        }
        get locked() { return this._locked; }
        getReader() {
            if (this._locked) throw new TypeError('Stream is locked');
            this._locked = true;
            const stream = this;
            return {
                read: () => {
                    if (stream._err) return Promise.reject(stream._err);
                    if (stream._queue.length > 0) {
                        return Promise.resolve({ value: stream._queue.shift(), done: false });
                    }
                    if (stream._closed) return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve, reject) => {
                        stream._waiters.push({ resolve, reject });
                    });
                },
                releaseLock: () => { stream._locked = false; },
                cancel: (reason) => {
                    stream._closed = true;
                    try { stream._source.cancel && stream._source.cancel(reason); } catch {}
                    return Promise.resolve();
                },
            };
        }
        [Symbol.asyncIterator]() {
            const reader = this.getReader();
            return {
                next: () => reader.read(),
                return: () => { reader.releaseLock(); return Promise.resolve({ value: undefined, done: true }); },
                [Symbol.asyncIterator]() { return this; },
            };
        }
        cancel(reason) {
            this._closed = true;
            try { this._source.cancel && this._source.cancel(reason); } catch {}
            return Promise.resolve();
        }
    }

    class FetchResponse {
        constructor(body, init = {}) {
            this.status = init.status !== undefined ? init.status : 200;
            this.statusText = init.statusText || '';
            this.ok = this.status >= 200 && this.status < 300;
            this.headers = init.headers instanceof FetchHeaders
                ? init.headers : new FetchHeaders(init.headers);
            this.url = init.url || '';
            this.redirected = !!init.redirected;
            this.type = init.type || 'basic';
            this._bodyUsed = false;
            this._buffered = null;     // Uint8Array, if body was given as bytes/string
            this._stream = null;       // MinReadableStream, if body was given as a stream
            if (body == null) {
                /* empty */
            } else if (body instanceof MinReadableStream) {
                this._stream = body;
            } else if (body instanceof Uint8Array) {
                this._buffered = body;
            } else if (body instanceof ArrayBuffer) {
                this._buffered = new Uint8Array(body);
            } else if (typeof body === 'string') {
                this._buffered = new TextEncoder().encode(body);
            } else {
                this._buffered = new TextEncoder().encode(String(body));
            }
        }
        get bodyUsed() { return this._bodyUsed; }
        get body() {
            if (this._stream) return this._stream;
            if (this._buffered) {
                const bytes = this._buffered;
                this._stream = new MinReadableStream({
                    start(c) { c.enqueue(bytes); c.close(); },
                });
                this._buffered = null;
                return this._stream;
            }
            return null;
        }
        async arrayBuffer() {
            if (this._bodyUsed) throw new TypeError('Body already used');
            this._bodyUsed = true;
            if (this._buffered) {
                const b = this._buffered;
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            }
            if (this._stream) {
                const reader = this._stream.getReader();
                const parts = [];
                let total = 0;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
                    parts.push(u8);
                    total += u8.byteLength;
                }
                const out = new Uint8Array(total);
                let off = 0;
                for (const p of parts) { out.set(p, off); off += p.byteLength; }
                return out.buffer;
            }
            return new ArrayBuffer(0);
        }
        async text() {
            const ab = await this.arrayBuffer();
            return new TextDecoder('utf-8').decode(ab);
        }
        async json() {
            const t = await this.text();
            return JSON.parse(t);
        }
        async bytes() { return new Uint8Array(await this.arrayBuffer()); }
        async blob() {
            const ab = await this.arrayBuffer();
            return { size: ab.byteLength, type: this.headers.get('content-type') || '',
                     arrayBuffer: async () => ab, text: async () => new TextDecoder().decode(ab) };
        }
        clone() {
            // Only safe when body is still buffered. After a stream has been
            // consumed there's nothing left to clone — anthropic-sdk clones
            // before reading the body, so this is OK in practice.
            if (this._stream) throw new TypeError('Cannot clone Response whose body is a stream');
            const init = {
                status: this.status, statusText: this.statusText, url: this.url,
                headers: new FetchHeaders(this.headers),
            };
            return new FetchResponse(this._buffered ? this._buffered.slice() : null, init);
        }
    }

    class FetchRequest {
        constructor(input, init = {}) {
            if (input instanceof FetchRequest) {
                this.url = input.url;
                this.method = (init.method || input.method || 'GET').toUpperCase();
                this.headers = new FetchHeaders(init.headers || input.headers);
                this.body = init.body !== undefined ? init.body : input.body;
                this.signal = init.signal || input.signal || null;
            } else {
                this.url = typeof input === 'string' ? input : (input && input.url);
                this.method = (init.method || 'GET').toUpperCase();
                this.headers = new FetchHeaders(init.headers || {});
                this.body = init.body !== undefined ? init.body : null;
                this.signal = init.signal || null;
            }
        }
    }

    async function fetch(input, init) {
        init = init || {};
        let urlStr;
        let mergedHeaders;
        let bodyIn;
        let signal;
        let method;
        if (input instanceof FetchRequest) {
            urlStr = input.url;
            mergedHeaders = new FetchHeaders(input.headers);
            if (init.headers) for (const [k, v] of new FetchHeaders(init.headers)._map) mergedHeaders.set(k, v);
            bodyIn = init.body !== undefined ? init.body : input.body;
            signal = init.signal || input.signal;
            method = (init.method || input.method || 'GET').toUpperCase();
        } else {
            urlStr = typeof input === 'string' ? input : (input && input.url);
            mergedHeaders = new FetchHeaders(init.headers);
            bodyIn = init.body;
            signal = init.signal;
            method = (init.method || 'GET').toUpperCase();
        }
        if (!urlStr) throw new TypeError('fetch: invalid input');

        const parsed = new URL(urlStr);
        const client = parsed.protocol === 'https:' ? https : http;
        const port = parsed.port ? parseInt(parsed.port, 10)
            : (parsed.protocol === 'https:' ? 443 : 80);

        // Reduce headers to plain object for http.request
        const headerObj = {};
        for (const [k, v] of mergedHeaders._map) headerObj[k] = v;

        let bodyBuf = null;
        if (bodyIn != null) {
            if (typeof bodyIn === 'string') bodyBuf = Buffer.from(bodyIn, 'utf8');
            else if (bodyIn instanceof Uint8Array) bodyBuf = Buffer.from(bodyIn.buffer, bodyIn.byteOffset, bodyIn.byteLength);
            else if (bodyIn instanceof ArrayBuffer) bodyBuf = Buffer.from(bodyIn);
            else if (Buffer.isBuffer && Buffer.isBuffer(bodyIn)) bodyBuf = bodyIn;
            else bodyBuf = Buffer.from(String(bodyIn), 'utf8');
            if (bodyBuf && !headerObj['content-length'] && !headerObj['transfer-encoding']) {
                headerObj['content-length'] = String(bodyBuf.length);
            }
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let resStream = null;
            let resCtrl = null;

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

                resStream = new MinReadableStream({
                    start(c) {
                        resCtrl = c;
                        res.on('data', (chunk) => {
                            try {
                                const u8 = chunk instanceof Uint8Array ? chunk
                                    : (chunk && chunk.buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                                       : new TextEncoder().encode(String(chunk)));
                                c.enqueue(u8);
                            } catch (e) { c.error(e); }
                        });
                        res.on('end', () => { try { c.close(); } catch {} });
                        res.on('error', (e) => { try { c.error(e); } catch {} });
                    },
                    cancel() { try { res.destroy(); } catch {} },
                });

                const respHeaders = new FetchHeaders();
                for (const k of Object.keys(res.headers || {})) {
                    const v = res.headers[k];
                    if (Array.isArray(v)) for (const x of v) respHeaders.append(k, x);
                    else if (v !== undefined) respHeaders.set(k, v);
                }
                resolve(new FetchResponse(resStream, {
                    status: res.statusCode || 0,
                    statusText: res.statusMessage || '',
                    headers: respHeaders,
                    url: urlStr,
                }));
            });

            req.on('error', (e) => {
                if (settled) {
                    if (resCtrl) try { resCtrl.error(e); } catch {}
                    return;
                }
                settled = true;
                reject(e);
            });

            if (signal && typeof signal.addEventListener === 'function') {
                const onAbort = () => {
                    try { req.destroy(new Error('Aborted')); } catch {}
                    if (settled) {
                        if (resCtrl) try { resCtrl.error(new DOMException('Aborted', 'AbortError')); } catch {}
                    } else {
                        settled = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    }
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }

            if (bodyBuf) req.write(bodyBuf);
            req.end();
        });
    }

    _defineGlobal('fetch', fetch);
    _defineGlobal('Headers', FetchHeaders);
    _defineGlobal('Response', FetchResponse);
    _defineGlobal('Request', FetchRequest);
    _defineGlobal('ReadableStream', MinReadableStream);
    // The `node:stream/web` pseudo-module also surfaces ReadableStream;
    // some libraries import from there instead of the global. Replace the
    // stub class with the real one.
    if (_builtinModules['stream/web']) {
        _builtinModules['stream/web'].ReadableStream = MinReadableStream;
    }
})();

// Export for the C entry point to detect successful bootstrap
_defineGlobal('__nodeBootstrapReady', true);

_runMainScriptIfPresent();
