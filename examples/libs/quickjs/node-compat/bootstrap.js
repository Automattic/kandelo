// Node.js API compatibility layer for QuickJS-NG
// Provides require(), process, Buffer, and core Node.js modules
// Built on top of QuickJS's qjs:os and qjs:std modules
//
// This is NOT Node.js. It is a compatibility layer that implements
// the most commonly used Node.js APIs using POSIX syscalls.

import * as std from 'qjs:std';
import * as os from 'qjs:os';

// ============================================================
// TextEncoder/TextDecoder polyfill for QuickJS
// ============================================================

if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        get encoding() { return 'utf-8'; }
        encode(str) {
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
            const encoded = this.encode(str);
            const len = Math.min(encoded.length, dest.length);
            dest.set(encoded.subarray(0, len));
            return { read: str.length, written: len };
        }
    };
}

if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(encoding) {
            this._encoding = (encoding || 'utf-8').toLowerCase();
        }
        get encoding() { return this._encoding; }
        decode(input, options) {
            if (!input) return '';
            const bytes = input instanceof Uint8Array ? input :
                          input instanceof ArrayBuffer ? new Uint8Array(input) :
                          new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            let result = '';
            let i = 0;
            while (i < bytes.length) {
                let code;
                if (bytes[i] < 0x80) {
                    code = bytes[i++];
                } else if ((bytes[i] & 0xE0) === 0xC0) {
                    code = ((bytes[i++] & 0x1F) << 6) | (bytes[i++] & 0x3F);
                } else if ((bytes[i] & 0xF0) === 0xE0) {
                    code = ((bytes[i++] & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
                } else if ((bytes[i] & 0xF8) === 0xF0) {
                    code = ((bytes[i++] & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) |
                           ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
                } else {
                    code = 0xFFFD;
                    i++;
                }
                if (code > 0xFFFF) {
                    code -= 0x10000;
                    result += String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
                } else {
                    result += String.fromCharCode(code);
                }
            }
            return result;
        }
    };
}

// ============================================================
// atob/btoa polyfill for QuickJS
// ============================================================

if (typeof globalThis.atob === 'undefined') {
    const _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const _b64lookup = new Uint8Array(256);
    for (let i = 0; i < _b64chars.length; i++) _b64lookup[_b64chars.charCodeAt(i)] = i;

    globalThis.btoa = function(str) {
        let result = '';
        let i = 0;
        while (i < str.length) {
            const a = str.charCodeAt(i++);
            const b = i < str.length ? str.charCodeAt(i++) : 0;
            const c = i < str.length ? str.charCodeAt(i++) : 0;
            const triple = (a << 16) | (b << 8) | c;
            result += _b64chars[(triple >> 18) & 0x3F];
            result += _b64chars[(triple >> 12) & 0x3F];
            result += (i > str.length + 1) ? '=' : _b64chars[(triple >> 6) & 0x3F];
            result += (i > str.length) ? '=' : _b64chars[triple & 0x3F];
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
        5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM',
        13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR',
        22: 'EINVAL', 28: 'ENOSPC', 36: 'ENAMETOOLONG',
        39: 'ENOTEMPTY', 61: 'ENODATA', 110: 'ETIMEDOUT',
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

const path = (() => {
    const sep = '/';
    const delimiter = ':';

    function normalize(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        if (p.length === 0) return '.';
        const isAbsolute = p.charCodeAt(0) === 47; // '/'
        const parts = p.split('/');
        const result = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') {
                if (result.length > 0 && result[result.length - 1] !== '..') {
                    result.pop();
                } else if (!isAbsolute) {
                    result.push('..');
                }
            } else {
                result.push(part);
            }
        }
        let out = result.join('/');
        if (isAbsolute) out = '/' + out;
        return out || (isAbsolute ? '/' : '.');
    }

    function join(...args) {
        if (args.length === 0) return '.';
        let joined = '';
        for (const arg of args) {
            if (typeof arg !== 'string') throw new TypeError('Arguments must be strings');
            if (arg.length > 0) {
                joined = joined ? joined + '/' + arg : arg;
            }
        }
        return joined ? normalize(joined) : '.';
    }

    function resolve(...args) {
        let resolved = '';
        for (let i = args.length - 1; i >= 0; i--) {
            const p = args[i];
            if (typeof p !== 'string') throw new TypeError('Arguments must be strings');
            if (p.length === 0) continue;
            resolved = p + (resolved ? '/' + resolved : '');
            if (p.charCodeAt(0) === 47) break;
        }
        if (resolved.charCodeAt(0) !== 47) {
            const [cwd] = os.getcwd();
            resolved = cwd + '/' + resolved;
        }
        return normalize(resolved);
    }

    function dirname(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        if (p.length === 0) return '.';
        const idx = p.lastIndexOf('/');
        if (idx === -1) return '.';
        if (idx === 0) return '/';
        return p.slice(0, idx);
    }

    function basename(p, ext) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        let base = p;
        const idx = p.lastIndexOf('/');
        if (idx !== -1) base = p.slice(idx + 1);
        if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
        return base;
    }

    function extname(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        const base = basename(p);
        const idx = base.lastIndexOf('.');
        if (idx <= 0) return '';
        return base.slice(idx);
    }

    function isAbsolute(p) {
        if (typeof p !== 'string') throw new TypeError('Path must be a string');
        return p.length > 0 && p.charCodeAt(0) === 47;
    }

    function relative(from, to) {
        from = resolve(from);
        to = resolve(to);
        if (from === to) return '';
        const fromParts = from.split('/').filter(Boolean);
        const toParts = to.split('/').filter(Boolean);
        let common = 0;
        while (common < fromParts.length && common < toParts.length &&
               fromParts[common] === toParts[common]) {
            common++;
        }
        const ups = fromParts.length - common;
        const result = [];
        for (let i = 0; i < ups; i++) result.push('..');
        for (let i = common; i < toParts.length; i++) result.push(toParts[i]);
        return result.join('/');
    }

    function parse(p) {
        const dir = dirname(p);
        const base = basename(p);
        const ext = extname(p);
        const name = ext ? base.slice(0, -ext.length) : base;
        const root = isAbsolute(p) ? '/' : '';
        return { root, dir, base, ext, name };
    }

    function format(obj) {
        const dir = obj.dir || obj.root || '';
        const base = obj.base || ((obj.name || '') + (obj.ext || ''));
        return dir ? (dir === obj.root ? dir + base : dir + '/' + base) : base;
    }

    return {
        sep, delimiter, normalize, join, resolve, dirname,
        basename, extname, isAbsolute, relative, parse, format,
        posix: null, // set below
    };
})();
path.posix = path;

// ============================================================
// events module (EventEmitter)
// ============================================================

const events = (() => {
    class EventEmitter {
        constructor() {
            this._events = Object.create(null);
            this._maxListeners = EventEmitter.defaultMaxListeners;
        }

        static get defaultMaxListeners() { return 10; }
        static set defaultMaxListeners(n) { /* ignored for now */ }

        setMaxListeners(n) { this._maxListeners = n; return this; }
        getMaxListeners() { return this._maxListeners; }

        emit(event, ...args) {
            const listeners = this._events[event];
            if (!listeners || listeners.length === 0) {
                if (event === 'error') {
                    const err = args[0] instanceof Error ? args[0] : new Error('Unhandled error');
                    throw err;
                }
                return false;
            }
            const copy = listeners.slice();
            for (const { fn, once } of copy) {
                if (once) this.removeListener(event, fn);
                fn.apply(this, args);
            }
            return true;
        }

        on(event, fn) { return this.addListener(event, fn); }

        addListener(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].push({ fn, once: false });
            return this;
        }

        once(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].push({ fn, once: true });
            return this;
        }

        removeListener(event, fn) {
            const list = this._events[event];
            if (!list) return this;
            this._events[event] = list.filter(l => l.fn !== fn);
            return this;
        }

        off(event, fn) { return this.removeListener(event, fn); }

        removeAllListeners(event) {
            if (event) {
                delete this._events[event];
            } else {
                this._events = Object.create(null);
            }
            return this;
        }

        listeners(event) {
            return (this._events[event] || []).map(l => l.fn);
        }

        rawListeners(event) {
            return (this._events[event] || []).slice();
        }

        listenerCount(event) {
            return (this._events[event] || []).length;
        }

        eventNames() {
            return Object.keys(this._events).filter(k => this._events[k].length > 0);
        }

        prependListener(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].unshift({ fn, once: false });
            return this;
        }

        prependOnceListener(event, fn) {
            if (!this._events[event]) this._events[event] = [];
            this._events[event].unshift({ fn, once: true });
            return this;
        }
    }

    const mod = function() { return new EventEmitter(); };
    mod.EventEmitter = EventEmitter;
    mod.defaultMaxListeners = 10;
    mod.once = function(emitter, event) {
        return new Promise((resolve, reject) => {
            const onEvent = (...args) => {
                emitter.removeListener('error', onError);
                resolve(args);
            };
            const onError = (err) => {
                emitter.removeListener(event, onEvent);
                reject(err);
            };
            emitter.once(event, onEvent);
            if (event !== 'error') emitter.once('error', onError);
        });
    };
    return mod;
})();

// ============================================================
// Buffer class
// ============================================================

const Buffer = (() => {
    const _encoder = new TextEncoder();
    const _decoder = new TextDecoder();

    class Buffer extends Uint8Array {
        // Static factory methods
        static alloc(size, fill, encoding) {
            const buf = new Buffer(size);
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
            return new Buffer(size);
        }

        static from(value, encodingOrOffset, length) {
            if (typeof value === 'string') {
                const encoding = encodingOrOffset || 'utf8';
                if (encoding === 'hex') {
                    const bytes = [];
                    for (let i = 0; i < value.length; i += 2) {
                        bytes.push(parseInt(value.substr(i, 2), 16));
                    }
                    return new Buffer(bytes);
                }
                if (encoding === 'base64') {
                    const binary = atob(value);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    return new Buffer(bytes.buffer);
                }
                // utf8 or ascii or latin1
                return new Buffer(_encoder.encode(value));
            }
            if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
            }
            if (ArrayBuffer.isView(value)) {
                return new Buffer(value.buffer, value.byteOffset, value.byteLength);
            }
            if (Array.isArray(value)) {
                return new Buffer(value);
            }
            if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
                return new Buffer(value.data);
            }
            throw new TypeError('Invalid argument for Buffer.from');
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
            targetStart = targetStart || 0;
            sourceStart = sourceStart || 0;
            sourceEnd = sourceEnd === undefined ? this.length : sourceEnd;
            const slice = this.subarray(sourceStart, sourceEnd);
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
            byteOffset = byteOffset || 0;
            if (typeof value === 'number') {
                for (let i = byteOffset; i < this.length; i++) {
                    if (this[i] === value) return i;
                }
                return -1;
            }
            if (typeof value === 'string') value = Buffer.from(value, encoding);
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

        // Read/write integers (little-endian and big-endian)
        readUInt8(offset) { return this[offset]; }
        readUInt16LE(offset) { return this[offset] | (this[offset + 1] << 8); }
        readUInt16BE(offset) { return (this[offset] << 8) | this[offset + 1]; }
        readUInt32LE(offset) { return (this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24)) >>> 0; }
        readUInt32BE(offset) { return ((this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]) >>> 0; }
        readInt8(offset) { const v = this[offset]; return v > 127 ? v - 256 : v; }
        readInt16LE(offset) { const v = this.readUInt16LE(offset); return v > 32767 ? v - 65536 : v; }
        readInt16BE(offset) { const v = this.readUInt16BE(offset); return v > 32767 ? v - 65536 : v; }
        readInt32LE(offset) { return this[offset] | (this[offset+1] << 8) | (this[offset+2] << 16) | (this[offset+3] << 24); }
        readInt32BE(offset) { return (this[offset] << 24) | (this[offset+1] << 16) | (this[offset+2] << 8) | this[offset+3]; }

        writeUInt8(value, offset) { this[offset] = value & 0xff; return offset + 1; }
        writeUInt16LE(value, offset) { this[offset] = value & 0xff; this[offset+1] = (value >> 8) & 0xff; return offset + 2; }
        writeUInt16BE(value, offset) { this[offset] = (value >> 8) & 0xff; this[offset+1] = value & 0xff; return offset + 2; }
        writeUInt32LE(value, offset) { this[offset] = value & 0xff; this[offset+1] = (value >> 8) & 0xff; this[offset+2] = (value >> 16) & 0xff; this[offset+3] = (value >> 24) & 0xff; return offset + 4; }
        writeUInt32BE(value, offset) { this[offset] = (value >> 24) & 0xff; this[offset+1] = (value >> 16) & 0xff; this[offset+2] = (value >> 8) & 0xff; this[offset+3] = value & 0xff; return offset + 4; }
        writeInt8(value, offset) { if (value < 0) value = 256 + value; return this.writeUInt8(value, offset); }
        writeInt16LE(value, offset) { if (value < 0) value = 65536 + value; return this.writeUInt16LE(value, offset); }
        writeInt16BE(value, offset) { if (value < 0) value = 65536 + value; return this.writeUInt16BE(value, offset); }
        writeInt32LE(value, offset) { if (value < 0) value = 4294967296 + value; return this.writeUInt32LE(value, offset); }
        writeInt32BE(value, offset) { if (value < 0) value = 4294967296 + value; return this.writeUInt32BE(value, offset); }

        // Float read/write via DataView
        readFloatLE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat32(offset, true); }
        readFloatBE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat32(offset, false); }
        readDoubleLE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat64(offset, true); }
        readDoubleBE(offset) { return new DataView(this.buffer, this.byteOffset).getFloat64(offset, false); }
        writeFloatLE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, true); return offset + 4; }
        writeFloatBE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat32(offset, value, false); return offset + 4; }
        writeDoubleLE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, true); return offset + 8; }
        writeDoubleBE(value, offset) { new DataView(this.buffer, this.byteOffset).setFloat64(offset, value, false); return offset + 8; }
    }

    return Buffer;
})();

// ============================================================
// process module
// ============================================================

const process = (() => {
    const [cwd_val] = os.getcwd();
    let _cwd = cwd_val || '/';
    const _env = {};

    // Populate env from /proc/self/environ or common vars
    for (const key of ['HOME', 'USER', 'PATH', 'SHELL', 'TERM', 'LANG', 'PWD',
                        'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV', 'NODE_PATH',
                        'NODE_DEBUG', 'NODE_OPTIONS']) {
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

    // Create process as an EventEmitter instance without calling the class constructor
    const proc = new events.EventEmitter();

    Object.assign(proc, {
        title: 'node',
        version: 'v22.0.0', // Compatibility target
        versions: {
            node: '22.0.0',
            quickjs: '0.12.1',
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
        ppid: 0,  // Not easily available
        exitCode: 0,
        _exiting: false,

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

        kill(pid, signal) {
            signal = signal || 'SIGTERM';
            const signum = typeof signal === 'number' ? signal :
                          { SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1,
                            SIGUSR1: 10, SIGUSR2: 12, SIGCHLD: 17 }[signal] || 15;
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

        memoryUsage() {
            return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
        },

        cpuUsage(prev) {
            const usage = { user: 0, system: 0 };
            if (prev) {
                usage.user -= prev.user;
                usage.system -= prev.system;
            }
            return usage;
        },

        nextTick(fn, ...args) {
            // QuickJS doesn't have a real nextTick, but queueMicrotask works
            queueMicrotask(() => fn(...args));
        },

        uptime() {
            return (Date.now() - _startTime) / 1000;
        },

        umask(mask) {
            // TODO: implement via syscall
            if (mask !== undefined) return 0o022;
            return 0o022;
        },

        features: {},
        config: { variables: {} },
        release: { name: 'node' },
        moduleLoadList: [],
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
function _createWriteStream(fd) {
    if (fd === 1 && _stdout) return _stdout;
    if (fd === 2 && _stderr) return _stderr;
    const s = {
        fd,
        writable: true,
        write(data, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (typeof data === 'string') {
                std.out.puts(data);
                std.out.flush();
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
        on() { return s; },
        once() { return s; },
        emit() { return false; },
        removeListener() { return s; },
        isTTY: os.isatty(fd),
        columns: 80,
        rows: 24,
    };
    if (fd === 1) _stdout = s;
    if (fd === 2) _stderr = s;
    return s;
}

function _createReadStream(fd) {
    if (_stdin) return _stdin;
    const s = {
        fd,
        readable: true,
        read() { return null; },
        on() { return s; },
        once() { return s; },
        emit() { return false; },
        removeListener() { return s; },
        resume() { return s; },
        pause() { return s; },
        pipe(dest) { return dest; },
        isTTY: os.isatty(fd),
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
        if (p instanceof URL) return p.pathname;
        if (Buffer.isBuffer(p)) return p.toString();
        throw new TypeError('path must be a string, Buffer, or URL');
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
        const p = _pathToString(filepath);
        let encoding = null;
        if (typeof options === 'string') encoding = options;
        else if (options && options.encoding) encoding = options.encoding;

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
        const p = _pathToString(filepath);
        let encoding = 'utf8';
        let mode = 0o666;
        let flag = 'w';
        if (typeof options === 'string') encoding = options;
        else if (options) {
            if (options.encoding) encoding = options.encoding;
            if (options.mode) mode = options.mode;
            if (options.flag) flag = options.flag;
        }

        const flags = _flagsToMode(flag);
        const fd = os.open(p, flags, mode);
        if (fd < 0) _throwErrno(-fd, 'open', p);

        let buf;
        if (typeof data === 'string') {
            buf = new TextEncoder().encode(data);
        } else if (data instanceof Uint8Array) {
            buf = data;
        } else {
            buf = new TextEncoder().encode(String(data));
        }
        os.write(fd, buf.buffer, buf.byteOffset, buf.byteLength);
        os.close(fd);
    }

    function appendFileSync(filepath, data, options) {
        const opts = typeof options === 'string' ? { encoding: options } : (options || {});
        opts.flag = opts.flag || 'a';
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
        // QuickJS os module may not have chmod, use syscall
        const p = _pathToString(filepath);
        // Use std.popen or direct approach
        // For now, this is a stub
    }

    function chownSync(filepath, uid, gid) {
        // Stub
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
        if (position !== null && position !== undefined) {
            os.seek(fd, position, std.SEEK_SET);
        }
        return os.read(fd, buffer.buffer, buffer.byteOffset + (offset || 0), length || buffer.length);
    }

    function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
        let buf;
        if (typeof data === 'string') {
            buf = new TextEncoder().encode(data);
            if (typeof offsetOrPosition === 'number') {
                os.seek(fd, offsetOrPosition, std.SEEK_SET);
            }
        } else {
            buf = data;
            const offset = offsetOrPosition || 0;
            const length = lengthOrEncoding || (buf.length - offset);
            if (position !== null && position !== undefined) {
                os.seek(fd, position, std.SEEK_SET);
            }
            return os.write(fd, buf.buffer, buf.byteOffset + offset, length);
        }
        return os.write(fd, buf.buffer, 0, buf.length);
    }

    function fstatSync(fd) {
        // Use /proc/self/fd approach or direct syscall
        // For simplicity, use a basic approach
        const [st, err] = os.fstat ? os.fstat(fd) : [null, -1];
        if (err !== 0) _throwErrno(-err, 'fstat');
        return new Stats(st);
    }

    function mkdtempSync(prefix) {
        // Simple implementation
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let suffix = '';
        for (let i = 0; i < 6; i++) {
            suffix += chars[Math.floor(Math.random() * chars.length)];
        }
        const dirpath = prefix + suffix;
        mkdirSync(dirpath);
        return dirpath;
    }

    // Async wrappers (callback-based)
    function _asyncify(syncFn) {
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
        Stats,
        Dirent,
        existsSync,
        statSync,
        lstatSync,
        readFileSync,
        writeFileSync,
        appendFileSync,
        readdirSync,
        mkdirSync,
        rmdirSync,
        rmSync: rmdirSync,
        unlinkSync,
        renameSync,
        copyFileSync,
        symlinkSync,
        readlinkSync,
        realpathSync,
        chmodSync,
        chownSync,
        utimesSync,
        truncateSync,
        accessSync,
        openSync,
        closeSync,
        readSync,
        writeSync,
        fstatSync,
        mkdtempSync,

        // Async versions
        readFile: _asyncify(readFileSync),
        writeFile: _asyncify(writeFileSync),
        appendFile: _asyncify(appendFileSync),
        readdir: _asyncify(readdirSync),
        mkdir: _asyncify(mkdirSync),
        rmdir: _asyncify(rmdirSync),
        unlink: _asyncify(unlinkSync),
        rename: _asyncify(renameSync),
        copyFile: _asyncify(copyFileSync),
        symlink: _asyncify(symlinkSync),
        readlink: _asyncify(readlinkSync),
        realpath: _asyncify(realpathSync),
        stat: _asyncify(statSync),
        lstat: _asyncify(lstatSync),
        access: _asyncify(accessSync),
        exists(filepath, cb) {
            cb(existsSync(filepath));
        },
        open: _asyncify(openSync),
        close: _asyncify(closeSync),
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
                queueMicrotask(() => cb(null, n));
            } catch (err) {
                queueMicrotask(() => cb(err));
            }
        },

        createReadStream(filepath, options) {
            const data = readFileSync(filepath, options);
            // Return a minimal readable stream
            return {
                data,
                on(ev, fn) {
                    if (ev === 'data') queueMicrotask(() => fn(data));
                    if (ev === 'end') queueMicrotask(() => fn());
                    return this;
                },
                pipe(dest) {
                    dest.write(data);
                    dest.end();
                    return dest;
                },
            };
        },

        createWriteStream(filepath, options) {
            const chunks = [];
            return {
                writable: true,
                write(data, encoding, cb) {
                    chunks.push(typeof data === 'string' ? Buffer.from(data, encoding) : data);
                    if (typeof cb === 'function') cb();
                    return true;
                },
                end(data, encoding, cb) {
                    if (data) this.write(data, encoding);
                    writeFileSync(filepath, Buffer.concat(chunks));
                    if (typeof cb === 'function') cb();
                },
                on() { return this; },
            };
        },
    };

    // fs.promises
    mod.promises = {};
    for (const key of Object.keys(mod)) {
        if (key.endsWith('Sync') || key === 'constants' || key === 'Stats' ||
            key === 'Dirent' || key === 'promises' || key === 'createReadStream' ||
            key === 'createWriteStream') continue;
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
                SIGTTOU: 22,
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
    function format(fmt, ...args) {
        if (typeof fmt !== 'string') {
            return [fmt, ...args].map(a => inspect(a)).join(' ');
        }
        let i = 0;
        return fmt.replace(/%[sdifjoO%]/g, (match) => {
            if (match === '%%') return '%';
            if (i >= args.length) return match;
            const arg = args[i++];
            switch (match) {
                case '%s': return String(arg);
                case '%d': return Number(arg).toString();
                case '%i': return parseInt(arg).toString();
                case '%f': return parseFloat(arg).toString();
                case '%j': try { return JSON.stringify(arg); } catch { return '[Circular]'; }
                case '%o': case '%O': return inspect(arg);
                default: return match;
            }
        }) + (i < args.length ? ' ' + args.slice(i).map(a => inspect(a)).join(' ') : '');
    }

    function inspect(obj, options) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        if (typeof obj === 'string') return `'${obj}'`;
        if (typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'bigint') return String(obj);
        if (typeof obj === 'symbol') return obj.toString();
        if (typeof obj === 'function') return `[Function: ${obj.name || 'anonymous'}]`;
        if (obj instanceof Date) return obj.toISOString();
        if (obj instanceof RegExp) return obj.toString();
        if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
        if (Array.isArray(obj)) {
            const items = obj.map(v => inspect(v, options));
            return `[ ${items.join(', ')} ]`;
        }
        if (ArrayBuffer.isView(obj)) {
            return `<${obj.constructor.name} ${Array.from(obj.slice(0, 50)).join(' ')}${obj.length > 50 ? ' ...' : ''}>`;
        }
        try {
            const keys = Object.keys(obj);
            const pairs = keys.map(k => `${k}: ${inspect(obj[k], options)}`);
            return `{ ${pairs.join(', ')} }`;
        } catch {
            return String(obj);
        }
    }
    inspect.defaultOptions = {};

    function inherits(ctor, superCtor) {
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
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
        return function(...args) {
            return new Promise((resolve, reject) => {
                fn(...args, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        };
    }

    function callbackify(fn) {
        return function(...args) {
            const cb = args.pop();
            fn(...args).then(
                result => cb(null, result),
                err => cb(err)
            );
        };
    }

    function isDeepStrictEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return false;
        if (typeof a !== 'object') return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!isDeepStrictEqual(a[key], b[key])) return false;
        }
        return true;
    }

    const types = {
        isDate(v) { return v instanceof Date; },
        isRegExp(v) { return v instanceof RegExp; },
        isNativeError(v) { return v instanceof Error; },
        isPromise(v) { return v instanceof Promise; },
        isArrayBuffer(v) { return v instanceof ArrayBuffer; },
        isTypedArray(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); },
        isMap(v) { return v instanceof Map; },
        isSet(v) { return v instanceof Set; },
        isWeakMap(v) { return v instanceof WeakMap; },
        isWeakSet(v) { return v instanceof WeakSet; },
        isDataView(v) { return v instanceof DataView; },
        isUint8Array(v) { return v instanceof Uint8Array; },
    };

    return {
        format, inspect, inherits, deprecate, promisify, callbackify,
        isDeepStrictEqual, types,
        TextDecoder, TextEncoder,
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
            super(options.message || `${options.actual} ${options.operator} ${options.expected}`);
            this.name = 'AssertionError';
            this.actual = options.actual;
            this.expected = options.expected;
            this.operator = options.operator;
            this.generatedMessage = !options.message;
            this.code = 'ERR_ASSERTION';
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

    _assert.deepEqual = _assert.deepStrictEqual = function(actual, expected, message) {
        if (!util.isDeepStrictEqual(actual, expected)) {
            throw new AssertionError({ actual, expected, operator: 'deepStrictEqual', message });
        }
    };

    _assert.throws = function(fn, expected, message) {
        let threw = false;
        try { fn(); } catch (e) { threw = true; }
        if (!threw) {
            throw new AssertionError({ actual: 'no error', expected: 'error', operator: 'throws', message });
        }
    };

    _assert.doesNotThrow = function(fn, message) {
        try { fn(); } catch (e) {
            throw new AssertionError({ actual: e, expected: 'no error', operator: 'doesNotThrow', message });
        }
    };

    _assert.fail = function(message) {
        throw new AssertionError({ message: message || 'Failed', operator: 'fail' });
    };

    _assert.AssertionError = AssertionError;
    _assert.strict = _assert;

    return _assert;
})();

// ============================================================
// stream module (minimal)
// ============================================================

const stream = (() => {
    class Stream extends events.EventEmitter {
        pipe(dest, options) {
            this.on('data', (chunk) => dest.write(chunk));
            this.on('end', () => { if (!options || options.end !== false) dest.end(); });
            return dest;
        }
    }

    class Readable extends Stream {
        constructor(options) {
            super();
            this.readable = true;
            this._readableState = { ended: false, flowing: null, buffer: [] };
            if (options && options.read) this._read = options.read;
        }
        _read(size) {}
        push(chunk) {
            if (chunk === null) {
                this._readableState.ended = true;
                this.emit('end');
                return false;
            }
            this._readableState.buffer.push(chunk);
            this.emit('data', chunk);
            return true;
        }
        read(size) {
            if (this._readableState.buffer.length === 0) return null;
            return this._readableState.buffer.shift();
        }
        resume() { this._readableState.flowing = true; return this; }
        pause() { this._readableState.flowing = false; return this; }
        destroy() { this.emit('close'); return this; }
    }

    class Writable extends Stream {
        constructor(options) {
            super();
            this.writable = true;
            this._writableState = { ended: false };
            if (options && options.write) this._write = options.write;
        }
        _write(chunk, encoding, cb) { cb(); }
        write(chunk, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            this._write(chunk, encoding || 'utf8', (err) => {
                if (err) this.emit('error', err);
                if (cb) cb(err);
            });
            return true;
        }
        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (chunk) this.write(chunk, encoding);
            this._writableState.ended = true;
            this.emit('finish');
            if (cb) cb();
            return this;
        }
        destroy() { this.emit('close'); return this; }
    }

    class Duplex extends Readable {
        constructor(options) {
            super(options);
            Writable.call(this, options);
            this.writable = true;
            this._writableState = { ended: false };
            if (options && options.write) this._write = options.write;
        }
    }
    // Mixin Writable methods
    for (const method of ['write', 'end', 'destroy']) {
        if (!Duplex.prototype[method] || method === 'destroy') {
            Duplex.prototype[method] = Writable.prototype[method];
        }
    }

    class Transform extends Duplex {
        constructor(options) {
            super(options);
            if (options && options.transform) this._transform = options.transform;
        }
        _transform(chunk, encoding, cb) { cb(null, chunk); }
        _write(chunk, encoding, cb) {
            this._transform(chunk, encoding, (err, data) => {
                if (data) this.push(data);
                cb(err);
            });
        }
    }

    class PassThrough extends Transform {
        _transform(chunk, encoding, cb) { cb(null, chunk); }
    }

    return {
        Stream, Readable, Writable, Duplex, Transform, PassThrough,
        pipeline(...streams) {
            const cb = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null;
            for (let i = 0; i < streams.length - 1; i++) {
                streams[i].pipe(streams[i + 1]);
            }
            if (cb) {
                const last = streams[streams.length - 1];
                last.on('finish', () => cb(null));
                last.on('error', cb);
            }
            return streams[streams.length - 1];
        },
        finished(stream, cb) {
            const onEnd = () => { cleanup(); cb(null); };
            const onError = (err) => { cleanup(); cb(err); };
            const cleanup = () => {
                stream.removeListener('end', onEnd);
                stream.removeListener('finish', onEnd);
                stream.removeListener('error', onError);
            };
            stream.on('end', onEnd);
            stream.on('finish', onEnd);
            stream.on('error', onError);
        },
    };
})();

// ============================================================
// url module
// ============================================================

const url = (() => {
    function parse(urlStr, parseQueryString) {
        // Simple URL parser
        const result = {
            protocol: null, slashes: false, auth: null, host: null,
            port: null, hostname: null, hash: null, search: null,
            query: null, pathname: null, path: null, href: urlStr,
        };

        let rest = urlStr;
        // Protocol
        const protoMatch = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (protoMatch) {
            result.protocol = protoMatch[1].toLowerCase() + ':';
            result.slashes = true;
            rest = rest.slice(protoMatch[0].length);
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
            // Auth
            const atIdx = rest.indexOf('@');
            if (atIdx !== -1) {
                result.auth = rest.slice(0, atIdx);
                rest = rest.slice(atIdx + 1);
            }
            // Host
            const slashIdx = rest.indexOf('/');
            if (slashIdx !== -1) {
                result.host = rest.slice(0, slashIdx);
                result.pathname = rest.slice(slashIdx);
            } else {
                result.host = rest;
                result.pathname = '/';
            }
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

    function format(urlObj) {
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

    return {
        parse, format, resolve,
        URL: globalThis.URL || class URL {
            constructor(input, base) {
                const parsed = parse(base ? resolve(base, input) : input);
                Object.assign(this, parsed);
            }
        },
        URLSearchParams: globalThis.URLSearchParams || class URLSearchParams {
            constructor(init) {
                this._params = {};
                if (typeof init === 'string') {
                    const qs = init.startsWith('?') ? init.slice(1) : init;
                    for (const pair of qs.split('&')) {
                        const [k, v] = pair.split('=').map(decodeURIComponent);
                        this._params[k] = v;
                    }
                }
            }
            get(key) { return this._params[key]; }
            set(key, val) { this._params[key] = val; }
            has(key) { return key in this._params; }
            toString() {
                return Object.entries(this._params)
                    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
                    .join('&');
            }
        },
    };
})();

// ============================================================
// querystring module
// ============================================================

const querystring = (() => {
    function parse(qs, sep, eq) {
        sep = sep || '&';
        eq = eq || '=';
        const result = {};
        if (!qs) return result;
        const pairs = qs.split(sep);
        for (const pair of pairs) {
            const idx = pair.indexOf(eq);
            const key = idx >= 0 ? decodeURIComponent(pair.slice(0, idx)) : decodeURIComponent(pair);
            const val = idx >= 0 ? decodeURIComponent(pair.slice(idx + 1)) : '';
            if (key in result) {
                if (Array.isArray(result[key])) result[key].push(val);
                else result[key] = [result[key], val];
            } else {
                result[key] = val;
            }
        }
        return result;
    }

    function stringify(obj, sep, eq) {
        sep = sep || '&';
        eq = eq || '=';
        const pairs = [];
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (Array.isArray(val)) {
                for (const v of val) pairs.push(encodeURIComponent(key) + eq + encodeURIComponent(v));
            } else {
                pairs.push(encodeURIComponent(key) + eq + encodeURIComponent(val));
            }
        }
        return pairs.join(sep);
    }

    function escape(str) { return encodeURIComponent(str); }
    function unescape(str) { return decodeURIComponent(str); }

    return { parse, stringify, escape, unescape, decode: parse, encode: stringify };
})();

// ============================================================
// string_decoder module
// ============================================================

const string_decoder = (() => {
    class StringDecoder {
        constructor(encoding) {
            this.encoding = (encoding || 'utf8').toLowerCase();
            this._decoder = new TextDecoder(this.encoding === 'utf-8' ? 'utf-8' : this.encoding);
        }
        write(buf) {
            if (typeof buf === 'string') return buf;
            return this._decoder.decode(buf, { stream: true });
        }
        end(buf) {
            if (buf) return this.write(buf);
            return '';
        }
    }
    return { StringDecoder };
})();

// ============================================================
// timers module
// ============================================================

const timers = (() => {
    // QuickJS has os.setTimeout
    return {
        setTimeout: globalThis.setTimeout || ((fn, ms, ...args) => os.setTimeout(() => fn(...args), ms || 0)),
        clearTimeout: globalThis.clearTimeout || os.clearTimeout,
        setInterval: globalThis.setInterval || ((fn, ms, ...args) => {
            let id;
            const repeat = () => { fn(...args); id = os.setTimeout(repeat, ms || 0); };
            id = os.setTimeout(repeat, ms || 0);
            return id;
        }),
        clearInterval: globalThis.clearInterval || os.clearTimeout,
        setImmediate: globalThis.setImmediate || ((fn, ...args) => os.setTimeout(() => fn(...args), 0)),
        clearImmediate: globalThis.clearImmediate || os.clearTimeout,
    };
})();

// ============================================================
// child_process module
// ============================================================

const child_process = (() => {
    function execSync(command, options) {
        const opts = options || {};
        const f = std.popen(command, 'r');
        if (!f) throw new Error(`execSync failed: ${command}`);
        let output = '';
        let line;
        while ((line = f.getline()) !== null) {
            output += line + '\n';
        }
        const status = f.close();
        if (status !== 0 && !opts.stdio) {
            const err = new Error(`Command failed: ${command}`);
            err.status = status;
            err.output = [null, output, ''];
            err.stdout = output;
            err.stderr = '';
            throw err;
        }
        if (opts.encoding === 'buffer' || !opts.encoding) {
            return Buffer.from(output);
        }
        return output;
    }

    function execFileSync(file, args, options) {
        const cmd = file + ' ' + (args || []).map(a => `'${a}'`).join(' ');
        return execSync(cmd, options);
    }

    function spawnSync(command, args, options) {
        const cmd = command + ' ' + (args || []).map(a => `'${a}'`).join(' ');
        try {
            const stdout = execSync(cmd, { ...options, encoding: 'buffer' });
            return { status: 0, stdout, stderr: Buffer.alloc(0), output: [null, stdout, Buffer.alloc(0)], pid: 0, signal: null, error: null };
        } catch (e) {
            return { status: e.status || 1, stdout: Buffer.from(e.stdout || ''), stderr: Buffer.from(e.stderr || ''), output: [null, Buffer.from(e.stdout || ''), Buffer.from(e.stderr || '')], pid: 0, signal: null, error: e };
        }
    }

    function exec(command, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        try {
            const result = execSync(command, { ...options, encoding: 'utf8' });
            queueMicrotask(() => cb(null, result, ''));
        } catch (e) {
            queueMicrotask(() => cb(e, e.stdout || '', e.stderr || ''));
        }
    }

    function spawn(command, args, options) {
        // Return a minimal ChildProcess-like object
        const child = new events.EventEmitter();
        child.pid = 0;
        child.stdin = new stream.Writable();
        child.stdout = new stream.Readable();
        child.stderr = new stream.Readable();

        queueMicrotask(() => {
            try {
                const cmd = command + ' ' + (args || []).map(a => `'${a}'`).join(' ');
                const result = execSync(cmd, { encoding: 'utf8' });
                child.stdout.push(Buffer.from(result));
                child.stdout.push(null);
                child.stderr.push(null);
                child.emit('close', 0);
                child.emit('exit', 0);
            } catch (e) {
                child.emit('error', e);
                child.emit('close', 1);
                child.emit('exit', 1);
            }
        });

        return child;
    }

    return { execSync, execFileSync, spawnSync, exec, spawn };
})();

// ============================================================
// crypto module (minimal)
// ============================================================

const crypto = (() => {
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
        // Stub - would need native hash implementation
        const chunks = [];
        return {
            update(data) {
                chunks.push(typeof data === 'string' ? Buffer.from(data) : data);
                return this;
            },
            digest(encoding) {
                // TODO: implement actual hashing
                const buf = Buffer.concat(chunks);
                const hash = Buffer.alloc(32);
                for (let i = 0; i < buf.length; i++) {
                    hash[i % 32] ^= buf[i];
                }
                if (encoding) return hash.toString(encoding);
                return hash;
            },
        };
    }

    function createHmac(algorithm, key) {
        return createHash(algorithm); // Simplified
    }

    return {
        randomBytes, randomUUID, randomInt,
        createHash, createHmac,
        getHashes() { return ['sha1', 'sha256', 'sha512', 'md5']; },
        getRandomValues(buf) {
            for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
            return buf;
        },
    };
})();

// ============================================================
// net module (minimal stubs)
// ============================================================

const net = (() => {
    class Socket extends stream.Duplex {
        constructor(options) {
            super(options);
            this.connecting = false;
            this.destroyed = false;
            this.remoteAddress = null;
            this.remotePort = null;
            this.localAddress = null;
            this.localPort = null;
        }
        connect(port, host, cb) {
            if (typeof host === 'function') { cb = host; host = 'localhost'; }
            this.connecting = true;
            this.remoteAddress = host;
            this.remotePort = port;
            // TODO: implement actual socket connection via kernel
            if (cb) this.once('connect', cb);
            queueMicrotask(() => {
                this.connecting = false;
                this.emit('connect');
            });
            return this;
        }
        setEncoding(enc) { this._encoding = enc; return this; }
        setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
        setNoDelay() { return this; }
        setKeepAlive() { return this; }
        address() { return { address: this.localAddress, port: this.localPort, family: 'IPv4' }; }
        ref() { return this; }
        unref() { return this; }
    }

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

    return {
        Socket, Server,
        createServer(options, listener) { return new Server(options, listener); },
        createConnection(port, host, cb) { return new Socket().connect(port, host, cb); },
        connect(port, host, cb) { return new Socket().connect(port, host, cb); },
        isIP(input) {
            if (/^\d+\.\d+\.\d+\.\d+$/.test(input)) return 4;
            if (input.includes(':')) return 6;
            return 0;
        },
        isIPv4(input) { return net.isIP(input) === 4; },
        isIPv6(input) { return net.isIP(input) === 6; },
    };
})();

// ============================================================
// http module (minimal stubs)
// ============================================================

const http = (() => {
    const STATUS_CODES = {
        200: 'OK', 201: 'Created', 204: 'No Content',
        301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
        400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
        404: 'Not Found', 405: 'Method Not Allowed',
        500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    };

    const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

    return {
        STATUS_CODES, METHODS,
        createServer(options, handler) {
            if (typeof options === 'function') { handler = options; options = {}; }
            const server = net.createServer();
            if (handler) server.on('request', handler);
            return server;
        },
        request(options, cb) {
            // TODO: implement actual HTTP client
            return new net.Socket();
        },
        get(options, cb) {
            const req = http.request(options, cb);
            req.end();
            return req;
        },
        Agent: class Agent {},
        globalAgent: {},
    };
})();

// ============================================================
// Module system (require/module)
// ============================================================

const _builtinModules = {
    'path': path,
    'events': events,
    'buffer': { Buffer },
    'fs': fs,
    'os': nodeOs,
    'util': util,
    'assert': assert,
    'assert/strict': assert,
    'stream': stream,
    'url': url,
    'querystring': querystring,
    'string_decoder': string_decoder,
    'timers': timers,
    'child_process': child_process,
    'crypto': crypto,
    'net': net,
    'http': http,
    'https': http,  // alias (no TLS distinction in this env)
    'zlib': {
        createGzip() { return new stream.PassThrough(); },
        createGunzip() { return new stream.PassThrough(); },
        createDeflate() { return new stream.PassThrough(); },
        createInflate() { return new stream.PassThrough(); },
        gzipSync(buf) { return buf; },
        gunzipSync(buf) { return buf; },
        deflateSync(buf) { return buf; },
        inflateSync(buf) { return buf; },
    },
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
    'dns': {
        lookup(hostname, options, cb) {
            if (typeof options === 'function') { cb = options; options = {}; }
            cb(null, '127.0.0.1', 4);
        },
        resolve(hostname, rrtype, cb) {
            if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
            cb(null, ['127.0.0.1']);
        },
    },
    'readline': {
        createInterface(options) {
            const rl = new events.EventEmitter();
            rl.close = () => rl.emit('close');
            rl.question = (query, cb) => { process.stdout.write(query); cb(''); };
            rl.prompt = () => {};
            rl.setPrompt = () => {};
            return rl;
        },
    },
    'perf_hooks': {
        performance: {
            now() { return Date.now(); },
            mark() {},
            measure() {},
        },
        PerformanceObserver: class PerformanceObserver { observe() {} disconnect() {} },
    },
    'worker_threads': {
        isMainThread: true,
        parentPort: null,
        workerData: null,
        Worker: class Worker {},
    },
    'cluster': {
        isMaster: true,
        isPrimary: true,
        isWorker: false,
    },
    'v8': {
        getHeapStatistics() { return { total_heap_size: 0, used_heap_size: 0 }; },
    },
    'vm': {
        runInThisContext(code) { return eval(code); },
        createContext(sandbox) { return sandbox || {}; },
        Script: class Script { constructor(code) { this.code = code; } runInThisContext() { return eval(this.code); } },
    },
};

// 'module' self-reference
const Module = {
    builtinModules: Object.keys(_builtinModules),
    createRequire(filename) {
        return _makeRequire(filename);
    },
    _cache: {},
    _extensions: {
        '.js': null,
        '.json': null,
        '.node': null,
    },
};
_builtinModules['module'] = Module;

function _resolveFile(id, basedir) {
    // Try exact path, then with extensions
    const candidates = [id];
    if (!id.endsWith('.js') && !id.endsWith('.json') && !id.endsWith('.mjs') && !id.endsWith('.cjs')) {
        candidates.push(id + '.js', id + '.json');
    }
    // Try as directory (index.js)
    candidates.push(id + '/index.js', id + '/index.json');

    for (const candidate of candidates) {
        let fullPath;
        if (candidate.startsWith('/')) {
            fullPath = candidate;
        } else {
            fullPath = basedir + '/' + candidate;
        }
        fullPath = path.normalize(fullPath);
        const [, err] = os.stat(fullPath);
        if (err === 0) return fullPath;
    }

    // Try node_modules
    let dir = basedir;
    while (dir !== '/') {
        const nmDir = dir + '/node_modules/' + id;
        for (const ext of ['', '.js', '.json', '/index.js', '/package.json']) {
            const fullPath = nmDir + ext;
            const [, err] = os.stat(fullPath);
            if (err === 0) {
                if (ext === '/package.json') {
                    // Read package.json to find main
                    try {
                        const pkg = JSON.parse(std.loadFile(fullPath));
                        const main = pkg.main || 'index.js';
                        const mainPath = path.resolve(path.dirname(fullPath), main);
                        const [, merr] = os.stat(mainPath);
                        if (merr === 0) return mainPath;
                        // Try with .js
                        const [, merr2] = os.stat(mainPath + '.js');
                        if (merr2 === 0) return mainPath + '.js';
                    } catch {}
                } else {
                    return fullPath;
                }
            }
        }
        dir = path.dirname(dir);
    }

    return null;
}

function _makeRequire(filename) {
    const basedir = path.dirname(filename || process.cwd() + '/repl');
    const _moduleCache = {};

    function require(id) {
        // Built-in modules (with or without 'node:' prefix)
        let name = id;
        if (name.startsWith('node:')) name = name.slice(5);
        if (_builtinModules[name] !== undefined) {
            return _builtinModules[name];
        }

        // Resolve file path
        const resolved = _resolveFile(id, basedir);
        if (!resolved) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }

        // Check cache
        if (_moduleCache[resolved]) return _moduleCache[resolved].exports;

        // Load and execute
        const source = std.loadFile(resolved);
        if (source === null) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }

        if (resolved.endsWith('.json')) {
            const exports = JSON.parse(source);
            _moduleCache[resolved] = { exports };
            return exports;
        }

        // Create module object
        const mod = {
            id: resolved,
            filename: resolved,
            loaded: false,
            exports: {},
            children: [],
            paths: [],
        };
        _moduleCache[resolved] = mod;

        // Wrap and execute
        const dirname = path.dirname(resolved);
        const wrappedFn = new Function('exports', 'require', 'module', '__filename', '__dirname',
            source + '\n//# sourceURL=' + resolved);

        const childRequire = _makeRequire(resolved);
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
        let name = id;
        if (name.startsWith('node:')) name = name.slice(5);
        if (_builtinModules[name] !== undefined) return name;
        const resolved = _resolveFile(id, basedir);
        if (!resolved) {
            const err = new Error(`Cannot find module '${id}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        return resolved;
    };

    require.cache = _moduleCache;
    require.main = null;

    return require;
}

// ============================================================
// Set up globals
// ============================================================

// process.argv is set by the C entry point via execArgv global
if (typeof execArgv !== 'undefined') {
    process.argv = Array.from(execArgv);
    process.argv0 = typeof argv0 !== 'undefined' ? argv0 : (process.argv[0] || 'node');
}

// Global require
globalThis.require = _makeRequire(process.cwd() + '/repl');

// Node.js globals
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.global = globalThis;
globalThis.GLOBAL = globalThis; // deprecated alias

// Timer globals
globalThis.setTimeout = globalThis.setTimeout || timers.setTimeout;
globalThis.clearTimeout = globalThis.clearTimeout || timers.clearTimeout;
globalThis.setInterval = globalThis.setInterval || timers.setInterval;
globalThis.clearInterval = globalThis.clearInterval || timers.clearInterval;
globalThis.setImmediate = globalThis.setImmediate || timers.setImmediate;
globalThis.clearImmediate = globalThis.clearImmediate || timers.clearImmediate;

// __dirname and __filename for the main module (set when running a file)
globalThis.__filename = '';
globalThis.__dirname = '';

// Module reference
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;

// console already exists in QuickJS, but ensure it has all methods
if (!console.debug) console.debug = console.log;
if (!console.info) console.info = console.log;
if (!console.dir) console.dir = (obj) => console.log(util.inspect(obj));
if (!console.time) {
    const _timers = {};
    console.time = (label) => { _timers[label || 'default'] = Date.now(); };
    console.timeEnd = (label) => {
        label = label || 'default';
        const ms = Date.now() - (_timers[label] || Date.now());
        delete _timers[label];
        console.log(`${label}: ${ms}ms`);
    };
    console.timeLog = (label) => {
        label = label || 'default';
        const ms = Date.now() - (_timers[label] || Date.now());
        console.log(`${label}: ${ms}ms`);
    };
}
if (!console.assert) {
    console.assert = (cond, ...args) => { if (!cond) console.error('Assertion failed:', ...args); };
}
if (!console.count) {
    const _counts = {};
    console.count = (label) => { label = label || 'default'; _counts[label] = (_counts[label] || 0) + 1; console.log(`${label}: ${_counts[label]}`); };
    console.countReset = (label) => { _counts[label || 'default'] = 0; };
}
if (!console.table) {
    console.table = (data) => console.log(data);
}
if (!console.group) {
    let _depth = 0;
    console.group = (...args) => { if (args.length) console.log(...args); _depth++; };
    console.groupEnd = () => { if (_depth > 0) _depth--; };
}

// Export for the C entry point to detect successful bootstrap
globalThis.__nodeBootstrapReady = true;
