// Public callable Buffer identity is separate from its internal typed-array
// allocator. Initialization binds actual process/error/warning owners before
// any user script runs; internal construction never calls the deprecated API.
function _createNodeBufferConstructor(platform) {
    'use strict';
    const { ObjectDefineProperty, ObjectGetOwnPropertyDescriptors, ReflectOwnKeys,
        ReflectDeleteProperty, ObjectSetPrototypeOf, Uint8Array, SymbolSpecies } = _createNodePrimordials();
    const FastBuffer = platform.FastBuffer;
    let process, ERR_INVALID_ARG_TYPE;
    const isInsideNodeModules = platform.isInsideNodeModules;
    function require(name) {
        if (name === 'internal/options') return { getOptionValue: platform.getOptionValue };
        throw new Error('Unknown Buffer constructor dependency: ' + name);
    }
    /* NODE_BUFFER_CONSTRUCTOR_WARNING */
    /* NODE_BUFFER_CONSTRUCTOR */
    const descriptors = ObjectGetOwnPropertyDescriptors(FastBuffer);
    for (const name of ReflectOwnKeys(descriptors)) {
        if (name === 'length' || name === 'name' || name === 'prototype') continue;
        ObjectDefineProperty(Buffer, name, descriptors[name]);
        ReflectDeleteProperty(FastBuffer, name);
    }
    ReflectDeleteProperty(Buffer, 'isBuffer');
    /* NODE_BUFFER_CONSTRUCTOR_IS_BUFFER */
    FastBuffer.prototype.constructor = Buffer;
    Buffer.prototype = FastBuffer.prototype;
    ObjectSetPrototypeOf(Buffer, Uint8Array);
    return { Buffer, initialize(owner) {
        process = owner.process;
        ERR_INVALID_ARG_TYPE = owner.values.errors.codes.ERR_INVALID_ARG_TYPE;
    } };
}

// One actual aligned, non-detachable pool is shared by Buffer allocation,
// string encoding and array-like conversion. The full target algorithms own
// thresholds, offsets and rollover; native code owns the backing storage.
function _createNodeBufferPool(platform) {
    'use strict';
    const { ReflectDeleteProperty, TypedArrayPrototypeGetByteOffset, TypedArrayPrototypeSet } = _createNodePrimordials();
    const { Buffer, FastBuffer } = platform;
    const { validateNumber } = platform.values.validators;
    const { createUnsafeBuffer, createUnsafeAlignedBuffer, validateAlignment } = platform.allocator;
    const kMaxLength = platform.kMaxLength;
    const markAsUntransferable = buffer => platform.native.markBufferUntransferable(buffer);
    const createFromString = (...args) => platform.getCodecs().createFromString(...args);
    /* NODE_BUFFER_POOL_INIT */
    /* NODE_BUFFER_POOL_ALIGN */
    /* NODE_BUFFER_POOL_ALLOCATE */
    /* NODE_BUFFER_POOL_ARRAY */
    ReflectDeleteProperty(Buffer, 'allocUnsafe');
    /* NODE_BUFFER_POOL_PUBLIC_ALLOC */
    return { allocate, fromArrayLike, fromStringFast };
}
