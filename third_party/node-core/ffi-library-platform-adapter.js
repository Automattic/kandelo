// This public subset consumes real library/symbol and guest-memory owners.
// Generic calls, callbacks and current-event-loop APIs remain missing, not stubs.
function _createNodeFfiLibrary(platform) {
    'use strict';
    const { FunctionPrototypeCall, ReflectConstruct, ObjectDefineProperty, ObjectFreeze, SymbolDispose,
        ArrayBufferPrototypeGetDetached, DataViewPrototypeGetBuffer, TypedArrayPrototypeGetBuffer } = _createNodePrimordials();
    const { Buffer, FastBuffer, process, permission } = platform;
    const { validateInteger, validateString } = platform.values.validators;
    const { ERR_ACCESS_DENIED, ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE } = platform.values.errors.codes;
    const { isArrayBuffer, isDataView, isArrayBufferView, isSharedArrayBuffer } = platform.types;
    const memory = platform.native.ffiMemory;
    const { getInt8, getUint8, getInt16, getUint16, getInt32, getUint32, getInt64, getUint64, getFloat32, getFloat64, setInt8, setUint8, setInt16, setUint16, setInt32, setUint32, setInt64, setUint64, setFloat32, setFloat64,
        getRawPointer, exportBytes, toString, toArrayBuffer } = memory;
    // The actual native function traces this environment's private prototype
    // in its own reserved slot. No public factory/property is called at delivery.
    const toBuffer = memory.createToBuffer(FastBuffer.prototype);
    /* NODE_FFI_PERMISSION */
    /* NODE_FFI_EXPORTSMEMORY */
    /* NODE_FFI_METADATA */
    const NativeDynamicLibrary = platform.native.DynamicLibrary;
    const getVfsLibraryReader = platform.getVfsLibraryReader;
    platform.values.util.emitExperimentalWarning('FFI');
    /* NODE_FFI_CONSTRUCTOR */
    // There is no fast-function registry in this implemented subset. Share the
    // actual native close operation with the exact public disposal descriptor.
    const close = NativeDynamicLibrary.prototype.close;
    /* NODE_FFI_DISPOSE */
    /* NODE_FFI_ALIASES */
    return { DynamicLibrary, dlclose, dlsym,
        exportArrayBuffer, exportArrayBufferView, exportString, exportBuffer,
        getInt8, getUint8, getInt16, getUint16, getInt32, getUint32,
        getInt64, getUint64, getFloat32, getFloat64, getRawPointer,
        setInt8, setUint8, setInt16, setUint16, setInt32, setUint32,
        setInt64, setUint64, setFloat32, setFloat64,
        suffix, toString, toArrayBuffer, toBuffer, types };
}
