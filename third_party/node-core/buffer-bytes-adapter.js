// Portable byte primitives for the pinned public Buffer algorithms. Storage
// belongs to actual typed-array/ArrayBuffer owners, never object properties
// that merely resemble byte views. Pool/transfer and codecs have separate owners.
function _installNodeBufferBytes(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ArrayBufferIsView, ArrayIsArray, MathFloor, MathMin,
        NumberIsInteger, NumberIsNaN, NumberMAX_SAFE_INTEGER, NumberMIN_SAFE_INTEGER,
        ObjectDefineProperty, ReflectApply, ReflectDeleteProperty, SymbolToPrimitive,
        TypedArrayPrototypeFill, TypedArrayPrototypeGetBuffer,
        TypedArrayPrototypeGetByteLength, TypedArrayPrototypeGetByteOffset,
        TypedArrayPrototypeGetLength, TypedArrayPrototypeSet,
        TypedArrayPrototypeSubarray, Uint8Array, uncurryThis,
    } = primordials;
    const Buffer = platform.Buffer;
    const FastBuffer = platform.FastBuffer || Buffer;
    const { isAnyArrayBuffer, isDataView, isTypedArray, isUint8Array } = platform.values.require('internal/util/types');
    const { normalizeEncoding } = platform.values.util;
    const { validateArray, validateInteger } = platform.values.validators;
    const { codes: { ERR_BUFFER_OUT_OF_BOUNDS, ERR_INVALID_ARG_TYPE,
        ERR_INVALID_BUFFER_SIZE, ERR_OUT_OF_RANGE } } = platform.values.errors;
    const kMaxLength = platform.kMaxLength;
    const validateOffset = (value, name, min = 0, max = kMaxLength) =>
        validateInteger(value, name, min, max);
    const fromString = platform.codecs.fromString;
    const allocate = platform.pool ? platform.pool.allocate : size => Buffer.allocUnsafeSlow(size);
    const fromArrayLike = platform.pool ? platform.pool.fromArrayLike : function(object) {
        const length = object.length;
        if (length <= 0) return new FastBuffer();
        return new FastBuffer(object);
    };

    const dataViewBuffer = uncurryThis(Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get);
    const dataViewOffset = uncurryThis(Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get);
    const dataViewLength = uncurryThis(Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get);
    function bytes(view) {
        const dataView = isDataView(view);
        const length = dataView ? dataViewLength(view) : TypedArrayPrototypeGetByteLength(view);
        // Detached and out-of-bounds typed-array spans have zero accessible
        // bytes. Constructing another view over their buffer would throw.
        if (length === 0) return new Uint8Array(0);
        return new Uint8Array(dataView ? dataViewBuffer(view) : TypedArrayPrototypeGetBuffer(view),
            dataView ? dataViewOffset(view) : TypedArrayPrototypeGetByteOffset(view), length);
    }
    function _compare(left, right) {
        const a = bytes(left), b = bytes(right);
        const al = TypedArrayPrototypeGetLength(a), bl = TypedArrayPrototypeGetLength(b);
        const end = MathMin(al, bl);
        for (let i = 0; i < end; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
        return al === bl ? 0 : al < bl ? -1 : 1;
    }
    function byteSpan(data, start, end) {
        const length = TypedArrayPrototypeGetLength(data);
        const size = MathMin(end, length) - start;
        if (size <= 0) return new Uint8Array(0);
        // Native byte bindings never consult a user-controlled species.
        // Construct the exact backing-store span without TypedArray.subarray.
        return new Uint8Array(TypedArrayPrototypeGetBuffer(data),
            TypedArrayPrototypeGetByteOffset(data) + start, size);
    }
    function compareOffset(source, target, targetStart, sourceStart, targetEnd, sourceEnd) {
        return _compare(byteSpan(bytes(source), sourceStart, sourceEnd),
            byteSpan(bytes(target), targetStart, targetEnd));
    }
    function _copy(source, target, targetStart, sourceStart, count) {
        const src = bytes(source), dest = bytes(target);
        count = MathMin(count, TypedArrayPrototypeGetLength(src) - sourceStart,
            TypedArrayPrototypeGetLength(dest) - targetStart);
        if (count <= 0) return 0;
        // TypedArray.set owns overlap-safe copying, including two views of
        // the same backing store. Offsets and counts here are byte units.
        TypedArrayPrototypeSet(dest, byteSpan(src, sourceStart, sourceStart + count), targetStart);
        return count;
    }
    function swapBytes(view, width) {
        const data = bytes(view), length = TypedArrayPrototypeGetLength(data);
        for (let i = 0; i < length; i += width) {
            for (let j = 0; j < width / 2; j++) {
                const other = i + width - j - 1, value = data[i + j];
                data[i + j] = data[other]; data[other] = value;
            }
        }
    }
    const _swap16 = value => swapBytes(value, 2);
    const _swap32 = value => swapBytes(value, 4);
    const _swap64 = value => swapBytes(value, 8);
    // Old class methods were non-enumerable. The target creates these public
    // methods by assignment, so recreate their descriptors as well as values.
    for (const name of ['from', 'copyBytesFrom', 'of', 'compare', 'concat', 'isEncoding'])
        ReflectDeleteProperty(Buffer, name);
    for (const name of ['copy', 'equals', 'compare', 'swap16', 'swap32', 'swap64'])
        ReflectDeleteProperty(Buffer.prototype, name);
    /* NODE_BUFFER_BYTE_ALGORITHMS */
}
