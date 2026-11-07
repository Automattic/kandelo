// Pinned process capture algorithms consume actual environment-owned state.
// The native toggle is consulted by the owning fatal/abort path, not metadata.
function _installNodeProcessExceptions(platform) {
    'use strict';
    const { ArrayPrototypePush, Error } = _createNodePrimordials();
    const process = platform.process;
    const { ERR_INVALID_ARG_TYPE, ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET } = platform.values.errors.codes;
    const { validateFunction } = platform.values.validators;
    const { executionAsyncId, clearDefaultTriggerAsyncId, clearAsyncIdStack,
        hasAsyncIdStack, afterHooksExist, emitAfter, popAsyncContext } = platform.async.uncaught;
    const shouldAbortOnUncaughtToggle = platform.native.uncaughtExceptionCaptureToggle();
    const kGenericUserError = 1;
    function require(name) {
        if (name === 'timers') return platform.timers;
        throw new Error('Unexpected exception-handler dependency: ' + name);
    }
    /* NODE_GLOBAL_UNCAUGHT_EXCEPTION */
    process._fatalException = createOnGlobalUncaughtException();
    process.setUncaughtExceptionCaptureCallback = setUncaughtExceptionCaptureCallback;
    process.addUncaughtExceptionCaptureCallback = addUncaughtExceptionCaptureCallback;
    process.hasUncaughtExceptionCaptureCallback = hasUncaughtExceptionCaptureCallback;
    platform.native.setUncaughtProcess(process);
}
