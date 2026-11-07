// Pinned exec/execFile collection over the existing real child/stdio owner.
function _createNodeChildExecPlatform(platform) {
    'use strict';
    const { ArrayIsArray, ArrayPrototypeSlice, ArrayPrototypeJoin,
        ArrayPrototypePush, ObjectDefineProperty, PromiseWithResolvers,
        StringPrototypeIncludes, StringPrototypeSlice } = _createNodePrimordials();
    const { assignFunctionName, convertToValidSignal, getSystemErrorName,
        kEmptyObject, promisify } = platform.values.util;
    const { genericNodeError, codes: { ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
        ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } } = platform.values.errors;
    const { validateObject, validateFunction, validateString, validateInteger,
        validateNumber } = platform.values.validators;
    const { Buffer, spawn } = platform;
    const { clearTimeout, setTimeout } = platform.timers;
    const MAX_BUFFER = 1024 * 1024;
    // Keep exec's public module.exports.execFile lookup live and receiver-local.
    const module = { exports: platform.api };
    /* NODE_CHILD_EXEC_COLLECTOR */
    /* NODE_CHILD_EXEC_VALIDATORS */
    module.exports.exec = exec;
    module.exports.execFile = execFile;
    return module.exports;
}
