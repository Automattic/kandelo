// This public subset consumes real native library/symbol owners. Generic call,
// callback, pointer-memory and event-loop APIs are still missing, not stubs.
function _createNodeFfiLibrary(platform) {
    'use strict';
    const { FunctionPrototypeCall, ReflectConstruct, ObjectDefineProperty, SymbolDispose } = _createNodePrimordials();
    const NativeDynamicLibrary = platform.native.DynamicLibrary;
    const getVfsLibraryReader = platform.getVfsLibraryReader;
    platform.values.util.emitExperimentalWarning('FFI');
    /* NODE_FFI_CONSTRUCTOR */
    // There is no fast-function registry in this implemented subset. Share the
    // actual native close operation with the exact public disposal descriptor.
    const close = NativeDynamicLibrary.prototype.close;
    /* NODE_FFI_DISPOSE */
    /* NODE_FFI_ALIASES */
    return { DynamicLibrary, dlclose, dlsym };
}
