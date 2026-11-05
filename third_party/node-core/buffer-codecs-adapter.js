// Byte/string primitives for the pinned public Buffer algorithms. These own
// real branded storage; DOM atob/TextDecoder have different error/BOM policies.
function _installNodeBufferCodecs(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Array, ArrayBufferIsView, MathCeil, MathFloor, MathMax, MathMin, MathTrunc,
        Number, NumberIsNaN, NumberPrototypeToString, ObjectCreate, ObjectGetOwnPropertyDescriptor,
        RangeError, ReflectApply, ReflectDeleteProperty, StringFromCharCode, TypeError,
        StringPrototypeCharCodeAt, StringPrototypeToLowerCase, TypedArrayPrototypeFill,
        TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteLength,
        TypedArrayPrototypeGetByteOffset, TypedArrayPrototypeGetLength, TypedArrayPrototypeSet,
        Uint8Array, uncurryThis } = primordials;
    const Buffer = platform.Buffer, FastBuffer = platform.FastBuffer || Buffer, kMaxLength = platform.kMaxLength;
    const kStringMaxLength = platform.kStringMaxLength;
    const { isAnyArrayBuffer, isDataView, isSharedArrayBuffer, isTypedArray, isUint8Array } =
        platform.values.require('internal/util/types');
    const { normalizeEncoding } = platform.values.util;
    const { validateBuffer, validateInteger, validateNumber, validateString } = platform.values.validators;
    const { codes: { ERR_BUFFER_OUT_OF_BOUNDS, ERR_INVALID_ARG_TYPE,
        ERR_INVALID_ARG_VALUE, ERR_UNKNOWN_ENCODING } } = platform.values.errors;
    const isArrayBufferView = ArrayBufferIsView;
    const validateOffset = (value, name, min = 0, max = kMaxLength) =>
        validateInteger(value, name, min, max);
    // Protocol encoding tags, from the pinned src/node.h enum. They describe
    // this private codec interface, not an installed V8/native Buffer binding.
    const encodingsMap = { ascii: 0, utf8: 1, base64: 2, utf16le: 3,
        latin1: 4, hex: 5, base64url: 7 };
    const dvBuffer = uncurryThis(ObjectGetOwnPropertyDescriptor(DataView.prototype, 'buffer').get);
    const dvOffset = uncurryThis(ObjectGetOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get);
    const dvLength = uncurryThis(ObjectGetOwnPropertyDescriptor(DataView.prototype, 'byteLength').get);
    function bytes(input, allowBuffer = false) {
        if (allowBuffer && isAnyArrayBuffer(input)) return new Uint8Array(input);
        if (!ArrayBufferIsView(input)) throw nativeType('argument must be a buffer');
        const dv = isDataView(input);
        const length = dv ? dvLength(input) : TypedArrayPrototypeGetByteLength(input);
        if (length === 0) return new Uint8Array(0);
        return new Uint8Array(dv ? dvBuffer(input) : TypedArrayPrototypeGetBuffer(input),
            dv ? dvOffset(input) : TypedArrayPrototypeGetByteOffset(input), length);
    }
    function nativeRange(message) {
        const error = new RangeError(message);
        error.code = 'ERR_OUT_OF_RANGE';
        return error;
    }
    function nativeType(message) {
        const error = new TypeError(message);
        error.code = 'ERR_INVALID_ARG_TYPE';
        return error;
    }
    function integer(value) { return MathTrunc(+value) || 0; }
    function index(value, fallback) {
        if (value === undefined) return fallback;
        const result = integer(value);
        if (result < 0 || result === Infinity) throw nativeRange('Index out of range');
        return result;
    }
    function stringTooLong() {
        const error = new RangeError('Cannot create a string longer than 0x' +
            NumberPrototypeToString(kStringMaxLength, 16) + ' characters');
        error.code = 'ERR_STRING_TOO_LONG';
        throw error;
    }
    function sink() {
        let result = '', used = 0, total = 0;
        const units = ObjectCreate(null);
        function flush() {
            units.length = used;
            result += ReflectApply(StringFromCharCode, undefined, units);
            used = 0;
        }
        return {
            put(unit) {
                if (++total > kStringMaxLength) stringTooLong();
                units[used++] = unit;
                if (used === 4096) flush();
            },
            finish() { if (used) flush(); return result; },
        };
    }
    function utf8Point(string, i) {
        const first = StringPrototypeCharCodeAt(string, i);
        if (first < 0xd800 || first > 0xdfff) return first;
        if (first <= 0xdbff && i + 1 < string.length) {
            const next = StringPrototypeCharCodeAt(string, i + 1);
            if (next >= 0xdc00 && next <= 0xdfff)
                return 0x10000 + ((first - 0xd800) << 10) + next - 0xdc00;
        }
        return 0xfffd;
    }
    function byteLengthUtf8(string) {
        let length = 0;
        for (let i = 0; i < string.length; i++) {
            const point = utf8Point(string, i);
            length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
            if (point > 0xffff) i++;
        }
        return length;
    }
    function hexDigit(unit) {
        unit &= 255; // Pinned nbytes HexDecode indexes its table with uint8_t.
        if (unit >= 48 && unit <= 57) return unit - 48;
        if (unit >= 65 && unit <= 70) return unit - 55;
        if (unit >= 97 && unit <= 102) return unit - 87;
        return -1;
    }
    function sextet(unit) {
        unit &= 255;
        if (unit >= 65 && unit <= 90) return unit - 65;
        if (unit >= 97 && unit <= 122) return unit - 71;
        if (unit >= 48 && unit <= 57) return unit + 4;
        return unit === 43 || unit === 45 ? 62 : unit === 47 || unit === 95 ? 63 : -1;
    }
    function encode(data, offset, capacity, string, encoding) {
        let written = 0;
        if (encoding === 'hex') {
            for (let i = 0; i + 1 < string.length && written < capacity; i += 2) {
                const a = hexDigit(StringPrototypeCharCodeAt(string, i));
                const b = hexDigit(StringPrototypeCharCodeAt(string, i + 1));
                if (a < 0 || b < 0) break;
                data[offset + written++] = (a << 4) | b;
            }
        } else if (encoding === 'base64' || encoding === 'base64url') {
            let bits = 0, count = 0;
            for (let i = 0; i < string.length && written < capacity; i++) {
                const unit = StringPrototypeCharCodeAt(string, i) & 255;
                if (unit === 61) break;
                const value = sextet(unit);
                if (value < 0) continue;
                bits = (bits << 6) | value; count += 6;
                if (count >= 8) {
                    count -= 8;
                    data[offset + written++] = (bits >>> count) & 255;
                }
            }
        } else if (encoding === 'ucs2' || encoding === 'utf16le') {
            for (let i = 0; i < string.length && written + 2 <= capacity; i++) {
                const unit = StringPrototypeCharCodeAt(string, i);
                data[offset + written++] = unit & 255;
                data[offset + written++] = unit >>> 8;
            }
        } else if (encoding === 'ascii' || encoding === 'latin1') {
            const length = MathMin(capacity, string.length);
            for (; written < length; written++)
                data[offset + written] = StringPrototypeCharCodeAt(string, written) & 255;
        } else {
            for (let i = 0; i < string.length; i++) {
                const point = utf8Point(string, i);
                const count = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
                // Native Utf8Write never emits a partial encoded character.
                if (written + count > capacity) break;
                if (count === 1) data[offset + written++] = point;
                else {
                    data[offset + written++] = (count === 2 ? 0xc0 : count === 3 ? 0xe0 : 0xf0) |
                        (point >>> ((count - 1) * 6));
                    for (let shift = (count - 2) * 6; shift >= 0; shift -= 6)
                        data[offset + written++] = 0x80 | ((point >>> shift) & 63);
                }
                if (point > 0xffff) i++;
            }
        }
        return written;
    }
    function utf8Units(data, start, end, put) {
        let units = 0;
        for (let i = start; i < end;) {
            const first = data[i++];
            let point = first, count = 0, lower = 0x80, upper = 0xbf;
            if (first < 0x80) { units++; if (put) put(first); continue; }
            if (first >= 0xc2 && first <= 0xdf) { point &= 31; count = 1; }
            else if (first >= 0xe0 && first <= 0xef) {
                point &= 15; count = 2;
                if (first === 0xe0) lower = 0xa0;
                if (first === 0xed) upper = 0x9f;
            } else if (first >= 0xf0 && first <= 0xf4) {
                point &= 7; count = 3;
                if (first === 0xf0) lower = 0x90;
                if (first === 0xf4) upper = 0x8f;
            } else point = 0xfffd;
            for (let j = 0; j < count; j++) {
                if (i === end || data[i] < lower || data[i] > upper) {
                    point = 0xfffd; break;
                }
                point = (point << 6) | (data[i++] & 63);
                lower = 0x80; upper = 0xbf;
            }
            // Consume the maximal valid prefix of an invalid sequence, then
            // retry the offending byte, as Node's UTF-8 replacement policy does.
            if (point <= 0xffff) { units++; if (put) put(point); }
            else {
                units += 2;
                if (put) { put(0xd800 + ((point - 0x10000) >>> 10)); put(0xdc00 + ((point - 0x10000) & 1023)); }
            }
        }
        return units;
    }
    function stringSlice(input, start, end, encoding) {
        let data = bytes(input), length = TypedArrayPrototypeGetLength(data);
        if (length === 0) return '';
        start = index(start, 0); end = index(end, length);
        if (end <= start) return '';
        if (end > length) throw nativeRange('Index out of range');
        if (isSharedArrayBuffer(TypedArrayPrototypeGetBuffer(data))) {
            // The native binding copies shared bytes before building a string.
            const copy = new Uint8Array(end - start);
            TypedArrayPrototypeSet(copy, new Uint8Array(TypedArrayPrototypeGetBuffer(data),
                TypedArrayPrototypeGetByteOffset(data) + start, end - start));
            data = copy; end -= start; start = 0;
        }
        const output = sink(), put = output.put;
        if (encoding === 'utf8') utf8Units(data, start, end, put);
        else if (encoding === 'ucs2') {
            for (let i = start; i + 1 < end; i += 2) put(data[i] | (data[i + 1] << 8));
        } else if (encoding === 'hex') {
            const alphabet = '0123456789abcdef';
            for (let i = start; i < end; i++) {
                put(StringPrototypeCharCodeAt(alphabet, data[i] >>> 4));
                put(StringPrototypeCharCodeAt(alphabet, data[i] & 15));
            }
        } else if (encoding === 'base64' || encoding === 'base64url') {
            const alphabet = encoding === 'base64' ?
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' :
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
            for (let i = start; i < end; i += 3) {
                const remain = end - i, bits = (data[i] << 16) |
                    (remain > 1 ? data[i + 1] << 8 : 0) | (remain > 2 ? data[i + 2] : 0);
                put(StringPrototypeCharCodeAt(alphabet, (bits >>> 18) & 63));
                put(StringPrototypeCharCodeAt(alphabet, (bits >>> 12) & 63));
                if (remain > 1) put(StringPrototypeCharCodeAt(alphabet, (bits >>> 6) & 63));
                else if (encoding === 'base64') put(61);
                if (remain > 2) put(StringPrototypeCharCodeAt(alphabet, bits & 63));
                else if (encoding === 'base64') put(61);
            }
        } else for (let i = start; i < end; i++) put(data[i] & (encoding === 'ascii' ? 127 : 255));
        return output.finish();
    }
    function stringWrite(input, string, offset, length, encoding) {
        const data = bytes(input), size = TypedArrayPrototypeGetLength(data);
        if (typeof string !== 'string') throw nativeType('argument must be a string');
        offset = index(offset, 0);
        if (offset > size) throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');
        length = MathMin(index(length, size - offset), size - offset);
        return encode(data, offset, length, string, encoding);
    }
    const asciiWriteStatic = (b, s, o, l) => stringWrite(b, s, o, l, 'ascii');
    const latin1WriteStatic = (b, s, o, l) => stringWrite(b, s, o, l, 'latin1');
    const utf8WriteStatic = (b, s, o, l) => stringWrite(b, s, o, l, 'utf8');
    const base64Write = (b, s, o, l) => stringWrite(b, s, o, l, 'base64');
    const base64urlWrite = (b, s, o, l) => stringWrite(b, s, o, l, 'base64url');
    const hexWrite = (b, s, o, l) => stringWrite(b, s, o, l, 'hex');
    const ucs2Write = (b, s, o, l) => stringWrite(b, s, o, l, 'ucs2');
    const asciiSlice = (b, s, e) => stringSlice(b, s, e, 'ascii');
    const latin1Slice = (b, s, e) => stringSlice(b, s, e, 'latin1');
    const utf8Slice = (b, s, e) => stringSlice(b, s, e, 'utf8');
    const base64Slice = (b, s, e) => stringSlice(b, s, e, 'base64');
    const base64urlSlice = (b, s, e) => stringSlice(b, s, e, 'base64url');
    const hexSlice = (b, s, e) => stringSlice(b, s, e, 'hex');
    const ucs2Slice = (b, s, e) => stringSlice(b, s, e, 'ucs2');
    const bindingStringLengthUtf8 = input => {
        const data = bytes(input, true);
        return utf8Units(data, 0, TypedArrayPrototypeGetLength(data));
    };
    const bindingIsLatin1 = string => {
        for (let i = 0; i < string.length; i++)
            if (StringPrototypeCharCodeAt(string, i) > 255) return false;
        return true;
    };
    const fromStringFast = platform.pool ? platform.pool.fromStringFast :
        (string, ops) => createFromString(string, ops);
    const createUnsafeBuffer = platform.allocator.createUnsafeBuffer;
    function bindingFill(input, value, start, end, encoding) {
        const data = bytes(input), length = TypedArrayPrototypeGetLength(data);
        if (start > end || end > length) return -2;
        if (typeof value !== 'string' && !ArrayBufferIsView(value)) {
            TypedArrayPrototypeFill(data, (+value) & 255, start, end);
            return 0;
        }
        let pattern, patternLength;
        if (typeof value === 'string') {
            const ops = encoding === undefined ? encodingOps.utf8 : getEncodingOps(encoding);
            // Native UTF-8/UTF-16 fill may repeat only the first byte of a
            // character. Encode a whole character before clipping its pattern;
            // unlike write(), fill() is allowed to end mid-character.
            const wide = ops.encodingVal === encodingsMap.utf8 || ops.encodingVal === encodingsMap.utf16le;
            const capacity = wide ? ops.byteLength(value) : MathMin(ops.byteLength(value), end - start);
            pattern = new Uint8Array(capacity);
            patternLength = encode(pattern, 0, capacity, value, ops.encoding);
        } else {
            pattern = bytes(value);
            patternLength = TypedArrayPrototypeGetLength(pattern);
        }
        const count = MathMin(patternLength, end - start);
        if (count === 0) return end === start ? 0 : -1;
        // Snapshot overlapping source bytes before repeating the pattern.
        const copy = new Uint8Array(count);
        for (let i = 0; i < count; i++) copy[i] = pattern[i];
        for (let i = start; i < end; i++) data[i] = copy[(i - start) % count];
        return 0;
    }
    function search(input, needle, offset, encoding, forward, end, stringNeedle = false) {
        const data = bytes(input), pattern = bytes(needle);
        let size = TypedArrayPrototypeGetLength(data);
        const length = TypedArrayPrototypeGetLength(pattern);
        const width = encoding === encodingsMap.utf16le ? 2 : 1;
        if (stringNeedle && width === 2) size -= size % 2;
        offset = integer(offset);
        end = MathMin(MathMax(integer(end), 0), size);
        if (width === 2) end -= end % 2;
        // Pinned IndexOfOffset uses the whole haystack for relative offsets,
        // independently of the exclusive search end.
        if (offset < 0) offset = offset + size >= 0 ? offset + size : forward || length === 0 ? 0 : -1;
        else if (offset + length > size) offset = length === 0 ? size : forward ? -1 : size - 1;
        if (length === 0) return MathMin(offset, end);
        if (size === 0 || offset < 0) return -1;
        if (!forward && offset >= end) offset = end - 1;
        else if (forward && offset >= end) return -1;
        if (stringNeedle && width === 2 && forward) offset += offset % 2;
        if (offset < 0 || (forward && length + offset > end) || length > end) return -1;
        const matchLength = width === 2 ? length - length % 2 : length;
        if (matchLength === 0) return -1;
        offset -= offset % width;
        if (!forward) offset = MathMin(offset, end - matchLength);
        for (let i = offset; forward ? i + matchLength <= end : i >= 0; i += forward ? width : -width) {
            let j = 0;
            for (; j < matchLength && data[i + j] === pattern[j]; j++);
            if (j === matchLength) return i;
        }
        return -1;
    }
    const indexOfBuffer = (b, v, o, e, d, end) => search(b, v, o, e, d, end);
    const indexOfString = (b, v, o, e, d, end) => search(b,
        fromString(v, e === encodingsMap.utf16le ? 'utf16le' : e === encodingsMap.latin1 ? 'latin1' : 'utf8'),
        o, e, d, end, true);
    const indexOfNumber = (b, v, o, d, end) => search(b, new Uint8Array([v & 255]), o, encodingsMap.utf8, d, end);
    for (const name of ['alloc', 'byteLength', 'stringLength']) ReflectDeleteProperty(Buffer, name);
    for (const name of ['toString', 'toLocaleString', 'write', 'fill', 'indexOf', 'lastIndexOf', 'includes',
        'asciiSlice', 'base64Slice', 'base64urlSlice', 'latin1Slice', 'hexSlice', 'ucs2Slice', 'utf8Slice',
        'asciiWrite', 'base64Write', 'base64urlWrite', 'latin1Write', 'hexWrite', 'ucs2Write', 'utf8Write'])
        ReflectDeleteProperty(Buffer.prototype, name);
    /* NODE_BUFFER_CODECS_WRAPPERS */
    /* NODE_BUFFER_CODECS_ALGORITHMS */
    const proto = Buffer.prototype;
    /* NODE_BUFFER_CODECS_PROTOTYPE */
    Buffer.prototype.toLocaleString = Buffer.prototype.toString;
    // Private native-consumer boundaries do not traverse mutable public
    // Buffer.from/toString/slice methods. Native records already own bytes.
    function decodeBytes(input, encoding = 'utf8') {
        const data = bytes(input);
        const normalized = normalizeEncoding(encoding) || 'utf8';
        return stringSlice(data, 0, TypedArrayPrototypeGetLength(data), normalized === 'utf16le' ? 'ucs2' : normalized);
    }
    function copyBytes(input) {
        const data = bytes(input), result = createUnsafeBuffer(TypedArrayPrototypeGetLength(data));
        TypedArrayPrototypeSet(result, data);
        return result;
    }
    function encodeUtf8(string) {
        // Native consumers must not enter replaceable public Buffer methods.
        const length = byteLengthUtf8(string), result = createUnsafeBuffer(length);
        encode(result, 0, length, string, 'utf8');
        return result;
    }
    return { fromString, createFromString, isLatin1, decodeBytes, copyBytes, encodeUtf8 };
}
