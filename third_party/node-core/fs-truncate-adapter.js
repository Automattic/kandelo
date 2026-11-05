// Pinned public descriptor operations and native FileHandle lifetime bridge.
// Experimental Node VFS handlers share their own registration state; the
// ordinary filesystem still runs through Kandelo's kernel VFS, not a JS VFS.
function _createNodeFsTruncation(platform) {
    'use strict';
    const { MathMax, ReflectApply, PromisePrototypeThen, ObjectDefineProperty, TypeError } = _createNodePrimordials();
    const { validateInteger, validateFunction, validateInt32 } = platform.values.validators;
    const { aggregateTwoErrors, codes: { ERR_INVALID_STATE } } = platform.values.errors;
    const fs = platform.fs;
    /* NODE_FS_VFS_STATE */
    function makeError(status, syscall, path, dest) {
        try { platform.throwErrno(-status, syscall, path, dest); }
        catch (error) { return error; }
    }
    function complete(status, syscall, value, path) {
        let error = null;
        if (status < 0) {
            error = makeError(status, syscall, path);
        }
        // FSReqCallback::Resolve passes only null for an undefined result;
        // Reject passes just its error. The native job supplies real values.
        return ReflectApply(this.oncomplete, this,
            error !== null || value === undefined ? [error] : [null, value]);
    }
    function FSReqCallback() {
        if (new.target === undefined) throw new TypeError('Filesystem request requires new');
        const prototype = new.target.prototype;
        return platform.native.createFsRequest(
            prototype !== null && (typeof prototype === 'object' || typeof prototype === 'function') ? prototype : FSReqCallback.prototype,
            complete);
    }
    ObjectDefineProperty(FSReqCallback.prototype, 'cancel', {
        value: function cancel() { return platform.native.cancelFsRequest(this); },
        writable: true, configurable: true,
    });
    const binding = {
        close(fd, request) {
            validateInt32(fd, 'fd', 0);
            const status = platform.native.closeDescriptor(fd, request);
            if (status < 0) platform.throwErrno(-status, 'close');
        },
        ftruncate(fd, length, request) {
            validateInt32(fd, 'fd', 0);
            const status = platform.native.ftruncate(fd, length, request);
            if (status < 0) platform.throwErrno(-status, 'ftruncate');
        },
    };
    /* NODE_FS_TRUNCATION_FUNCTIONS */
    let runningGcError = false;
    function runGcCloseError() {
        if (runningGcError) return 0;
        const record = platform.native.peekFsGcCloseError();
        if (record === null) return 0;
        runningGcError = true;
        try {
            const fd = record[0], status = record[1], path = record[2] || '<unknown path>';
            return platform.runInternalImmediate(() => {
                // The native queue remains owning until preparation succeeds.
                // No public Immediate, TickObject or AsyncResource is created.
                platform.native.ackFsGcCloseError();
                if (record[3] === true) {
                    if (status < 0) {
                        const error = makeError(status, 'close');
                        error.message = 'Closing directory handle on garbage collection failed';
                        throw error;
                    }
                    platform.process.emitWarning('Closing directory handle on garbage collection');
                    return 1;
                }
                if (status < 0) {
                    const error = makeError(status, 'close');
                    error.message = `Closing file descriptor ${fd} on garbage collection failed (${path})`;
                    throw error;
                }
                throw new ERR_INVALID_STATE(
                    'A FileHandle object was closed during garbage collection. ' +
                    'This used to be allowed with a deprecation warning but is now ' +
                    'considered an error. Please close FileHandle objects explicitly. ' +
                    `File descriptor: ${fd} (${path})`);
            });
        } finally { runningGcError = false; }
    }
    return { truncate, truncateSync, ftruncate, ftruncateSync, close, closeSync,
        vfsState, setVfsHandlers, runGcCloseError, makeError, FSReqCallback,
        adoptFileHandle: (fd, path) => platform.native.adoptFileHandle(fd, path, makeError) };

}
