// Process-level recovery uses the pinned unchanged handler and the actual
// native execution stack. Reporting measurements and abort CLI remain gaps.
function _installNodeProcessExceptions(platform) {
    'use strict';
    const { Error } = _createNodePrimordials();
    const process = platform.process;
    const { ERR_INVALID_ARG_TYPE, ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET } = platform.values.errors.codes;
    const { executionAsyncId, clearDefaultTriggerAsyncId, clearAsyncIdStack,
        hasAsyncIdStack, afterHooksExist, emitAfter, popAsyncContext } = platform.async.uncaught;
    const kGenericUserError = 1;
    const exceptionHandlerState = { captureFn: null, auxiliaryCallbacks: [], reportFlag: false };
    function require(name) {
        if (name === 'timers') return platform.timers;
        throw new Error('Unexpected exception-handler dependency: ' + name);
    }
    /* NODE_GLOBAL_UNCAUGHT_EXCEPTION */
    process._fatalException = createOnGlobalUncaughtException();
    process.setUncaughtExceptionCaptureCallback = function setUncaughtExceptionCaptureCallback(fn) {
        if (fn === null) {
            exceptionHandlerState.captureFn = null;
            process.report.reportOnUncaughtException = exceptionHandlerState.reportFlag;
            return;
        }
        if (typeof fn !== 'function') throw new ERR_INVALID_ARG_TYPE('fn', ['Function', 'null'], fn);
        if (exceptionHandlerState.captureFn !== null) throw new ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET();
        exceptionHandlerState.captureFn = fn;
        exceptionHandlerState.reportFlag = process.report.reportOnUncaughtException === true;
        process.report.reportOnUncaughtException = false;
    };
    process.hasUncaughtExceptionCaptureCallback = function hasUncaughtExceptionCaptureCallback() {
        return exceptionHandlerState.captureFn !== null;
    };
    platform.native.setUncaughtProcess(process);
}
