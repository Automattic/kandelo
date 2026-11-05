// Pinned public allocator plus actual guest backing-store allocation/alignment.
function _installNodeBufferUnpooled(platform) {
    'use strict';
    const { MathMax } = _createNodePrimordials();
    const Buffer = platform.Buffer;
    const FastBuffer = platform.FastBuffer || Buffer;
    const kMaxLength = platform.kMaxLength;
    const { validateNumber, validateInteger } = platform.values.validators;
    const { codes: { ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE } } = platform.values.errors;
    const createUnsafeArrayBuffer = size => platform.native.createUnsafeArrayBuffer(size);
    const arrayBufferAlignedOffset = (buffer, alignment) => platform.native.arrayBufferAlignedOffset(buffer, alignment);
    /* NODE_BUFFER_UNPOOLED */
    return { createUnsafeBuffer, createUnsafeAlignedBuffer, validateAlignment };
}
