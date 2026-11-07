// Actual CSPRNG work is owned by native requests, not synchronous fill deferred
// behind a microtask. Public helpers are exact pinned source sections.
function _createNodeCryptoRandomJobs(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Array, ArrayBufferPrototypeGetByteLength, ArrayPrototypeForEach,
        ArrayPrototypePush, ArrayPrototypeShift, ArrayPrototypeSplice, DateNow,
        FunctionPrototypeBind, FunctionPrototypeCall, MathMin, NumberIsNaN, NumberIsSafeInteger,
        NumberPrototypeToString, ObjectDefineProperty, ReflectApply,
        StringPrototypePadStart, TypedArrayPrototypeFill, TypedArrayPrototypeGetBuffer,
        TypedArrayPrototypeGetByteLength, TypedArrayPrototypeGetLength,
        TypedArrayPrototypeGetSymbolToStringTag, DataViewPrototypeGetByteLength,
        Uint8Array } = primordials;
    const { isArrayBufferView, isAnyArrayBuffer, isDataView,
        isSharedArrayBuffer, isTypedArray } = platform.types;
    const { validateNumber, validateFunction, validateObject, validateBoolean } = platform.values.validators;
    const { ERR_INVALID_ARG_TYPE, ERR_OPERATION_FAILED, ERR_OUT_OF_RANGE } = platform.values.errors.codes;
    const kEmptyObject = platform.values.util.kEmptyObject;
    const kMaxLength = platform.kMaxLength;
    const process = platform.process;
    const randomFillSync = platform.sync.randomFillSync;
    const FastBuffer = function FastBuffer(size) { return platform.allocate(size); };
    const secureBuffer = size => {
        const result = platform.native.secureRandomBuffer(size);
        if (result === undefined) throw new ERR_OPERATION_FAILED('Allocation failed');
        return result;
    };
    const kCryptoJobAsync = /* NODE_RANDOM_ASYNC_MODE */;
    function complete(status, syscall, packet) {
        const error = status < 0 ? platform.makeError(status, syscall) : packet;
        return ReflectApply(this.ondone, this, [error]);
    }
    function RandomBytesJob(mode, buffer, offset, size) {
        return platform.native.createRandomBytesJob(RandomBytesJob.prototype,
            mode, buffer, offset, size, complete);
    }
    ObjectDefineProperty(RandomBytesJob.prototype, 'run', { configurable: true, writable: true,
        value: function run() { return platform.native.runRandomBytesJob(this); } });
    const isBuildingSnapshot = () => false; // Actual embedding never builds a V8 startup snapshot.
    function addAfterUserSerializeCallback() { throw new ERR_OPERATION_FAILED('Startup snapshots are not implemented'); }
    function addBeforeUserDeserializeCallback() { throw new ERR_OPERATION_FAILED('Startup snapshots are not implemented'); }
    /* NODE_RANDOM_JOB_FUNCTIONS */
    return { randomBytes, randomFill, randomInt, randomUUID, randomUUIDv7 };
}
