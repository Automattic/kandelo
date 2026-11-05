// Incremental byte state follows the pinned src/string_decoder.cc owner.
// Character conversion is shared with Buffer's private byte codecs rather
// than WHATWG TextDecoder, whose BOM and flush rules are different.
// Derived from Node.js; see LICENSE and the retained full source references.
function _createNodeStringDecoder(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayBufferIsView, DataView, MathMin, ObjectCreate,
        ObjectGetOwnPropertyDescriptor, NumberPrototypeToString, RangeError,
        TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteLength,
        TypedArrayPrototypeGetByteOffset, Uint8Array, uncurryThis } = primordials;
    const { isDataView } = platform.values.require('internal/util/types');
    const dataBuffer = uncurryThis(ObjectGetOwnPropertyDescriptor(DataView.prototype, 'buffer').get);
    const dataOffset = uncurryThis(ObjectGetOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get);
    const dataLength = uncurryThis(ObjectGetOwnPropertyDescriptor(DataView.prototype, 'byteLength').get);
    const constants = /* NODE_STRING_DECODER_CONSTANTS */;
    const encodings = /* NODE_STRING_DECODER_ENCODINGS */;
    const { kIncompleteCharactersStart, kIncompleteCharactersEnd,
        kMissingBytes, kBufferedBytes, kEncodingField } = constants;
    const encodingsMap = ObjectCreate(null);
    for (let i = 0; i < encodings.length; i++) encodingsMap[encodings[i]] = i;
    const { normalizeEncoding } = platform.values.util;

    function bytes(input) {
        if (!ArrayBufferIsView(input)) {
            throw new platform.values.errors.codes.ERR_INVALID_ARG_TYPE(
                'buf', ['Buffer', 'TypedArray', 'DataView'], input);
        }
        let buffer, offset, length;
        if (isDataView(input)) {
            buffer = dataBuffer(input);
            try { offset = dataOffset(input); length = dataLength(input); }
            catch (_) {
                // Only intrinsic accessors run here. Node's view-contents
                // boundary treats detached and out-of-bounds views as empty.
                return new Uint8Array(0);
            }
        } else {
            buffer = TypedArrayPrototypeGetBuffer(input);
            offset = TypedArrayPrototypeGetByteOffset(input);
            length = TypedArrayPrototypeGetByteLength(input);
        }
        return length === 0 ? new Uint8Array(0) : new Uint8Array(buffer, offset, length);
    }
    function makeString(data, start, length, encoding) {
        if (encoding === encodingsMap.utf8 && length > platform.kStringMaxLength) {
            const error = new RangeError('Cannot create a string longer than 0x' +
                NumberPrototypeToString(platform.kStringMaxLength, 16) + ' characters');
            error.code = 'ERR_STRING_TOO_LONG';
            throw error;
        }
        if (length === 0) return '';
        // Direct construction avoids species hooks in the native conversion
        // dependency. Public lastChar/text retain their upstream dispatch.
        const view = new Uint8Array(TypedArrayPrototypeGetBuffer(data),
            TypedArrayPrototypeGetByteOffset(data) + start, length);
        return platform.codecs.decodeBytes(view, encodings[encoding]);
    }
    function decode(storage, input) {
        const state = bytes(storage), data = bytes(input);
        const encoding = state[kEncodingField];
        let offset = 0, length = TypedArrayPrototypeGetByteLength(data), prepend = '';
        if (encoding !== encodingsMap.utf8 && encoding !== encodingsMap.utf16le &&
            encoding !== encodingsMap.base64 && encoding !== encodingsMap.base64url) {
            return makeString(data, offset, length, encoding);
        }
        if (state[kMissingBytes] > 0) {
            if (encoding === encodingsMap.utf8) {
                for (let i = 0; i < length && i < state[kMissingBytes]; i++) {
                    if ((data[i] & 0xc0) !== 0x80) {
                        state[kMissingBytes] = 0;
                        for (let j = 0; j < i; j++) state[state[kBufferedBytes] + j] = data[j];
                        state[kBufferedBytes] += i;
                        offset += i; length -= i;
                        break;
                    }
                }
            }
            const found = MathMin(length, state[kMissingBytes]);
            for (let i = 0; i < found; i++) state[state[kBufferedBytes] + i] = data[offset + i];
            offset += found; length -= found;
            state[kMissingBytes] -= found;
            state[kBufferedBytes] += found;
            if (state[kMissingBytes] === 0) {
                prepend = makeString(state, kIncompleteCharactersStart, state[kBufferedBytes], encoding);
                state[kBufferedBytes] = 0;
            }
        }
        if (length === 0) return prepend;
        if (encoding === encodingsMap.utf8 && (data[offset + length - 1] & 0x80)) {
            for (let i = length - 1; ; i--) {
                state[kBufferedBytes]++;
                const unit = data[offset + i];
                if ((unit & 0xc0) === 0x80) {
                    if (state[kBufferedBytes] >= 4 || i === 0) {
                        state[kBufferedBytes] = 0;
                        break;
                    }
                } else {
                    if ((unit & 0xe0) === 0xc0) state[kMissingBytes] = 2;
                    else if ((unit & 0xf0) === 0xe0) state[kMissingBytes] = 3;
                    else if ((unit & 0xf8) === 0xf0) state[kMissingBytes] = 4;
                    else { state[kBufferedBytes] = 0; break; }
                    if (state[kBufferedBytes] >= state[kMissingBytes]) {
                        state[kMissingBytes] = state[kBufferedBytes] = 0;
                    }
                    state[kMissingBytes] -= state[kBufferedBytes];
                    break;
                }
            }
        } else if (encoding === encodingsMap.utf16le) {
            if (length % 2 === 1) { state[kBufferedBytes] = state[kMissingBytes] = 1; }
            else if ((data[offset + length - 1] & 0xfc) === 0xd8) {
                state[kBufferedBytes] = state[kMissingBytes] = 2;
            }
        } else if (encoding === encodingsMap.base64 || encoding === encodingsMap.base64url) {
            state[kBufferedBytes] = length % 3;
            if (state[kBufferedBytes] > 0) state[kMissingBytes] = 3 - state[kBufferedBytes];
        }
        if (state[kBufferedBytes] > 0) {
            length -= state[kBufferedBytes];
            for (let i = 0; i < state[kBufferedBytes]; i++) state[i] = data[offset + length + i];
        }
        return prepend + makeString(data, offset, length, encoding);
    }
    function flush(storage) {
        const state = bytes(storage), encoding = state[kEncodingField];
        if (encoding === encodingsMap.utf16le && state[kBufferedBytes] % 2 === 1) {
            state[kMissingBytes]--;
            state[kBufferedBytes]--;
        }
        if (state[kBufferedBytes] === 0) return '';
        try { return makeString(state, kIncompleteCharactersStart, state[kBufferedBytes], encoding); }
        finally { state[kMissingBytes] = state[kBufferedBytes] = 0; }
    }
    function require(name) {
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === 'internal/util') return { normalizeEncoding, encodingsMap };
        if (name === 'internal/errors') return platform.values.errors;
        throw new platform.values.errors.codes.ERR_NOT_IMPLEMENTED('string_decoder dependency ' + name);
    }
    function internalBinding(name) {
        if (name === 'string_decoder') return { ...constants, decode, flush };
        throw new platform.values.errors.codes.ERR_NOT_IMPLEMENTED('string_decoder binding ' + name);
    }
    const module = { exports: {} };
    function initializePublic(module, exports, require, primordials, internalBinding) {
        /* NODE_STRING_DECODER_PUBLIC */
    }
    initializePublic(module, module.exports, require, primordials, internalBinding);
    return module.exports;
}
