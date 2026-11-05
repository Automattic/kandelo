// A real native ReadFileJob owns the pathname, FSREQCALLBACK identity and
// read allocation. The JS wrapper only prepares its actual callback packet.
function _createNodeFileJobs(platform) {
    'use strict';
    const { ObjectDefineProperty, ReflectApply, TypeError } = _createNodePrimordials();
    const Buffer = platform.Buffer;
    const makeError = platform.truncation.makeError;
    function complete(status, syscall, packet, path) {
        let error = null, buffer, fd = -1, size, closeError;
        if (status < 0) error = makeError(status, syscall, path);
        else {
            fd = packet[1]; size = packet[2];
            buffer = packet[0];
            if (packet[3] < 0) closeError = makeError(packet[3], 'close');
        }
        return ReflectApply(this.ondone, this, [error, buffer, fd, size, closeError]);
    }
    function ReadFileJob(path, flags, limit, trackFd = false) {
        if (new.target === undefined) throw new TypeError('ReadFileJob requires new');
        const prototype = new.target.prototype;
        return platform.native.createReadFileJob(
            prototype !== null && (typeof prototype === 'object' || typeof prototype === 'function') ? prototype : ReadFileJob.prototype,
            path, flags, limit, trackFd, complete, Buffer.prototype);
    }
    ObjectDefineProperty(ReadFileJob.prototype, 'run', {
        value: function run(path) { return platform.native.runReadFileJob(this); },
        writable: true, configurable: true,
    });
    function writeComplete(status, syscall, ignored, path) {
        return ReflectApply(this.ondone, this, [status < 0 ? makeError(status, syscall, path) : null]);
    }
    function WriteFileJob(path, flags, mode, data) {
        if (new.target === undefined) throw new TypeError('WriteFileJob requires new');
        const prototype = new.target.prototype;
        return platform.native.createWriteFileJob(
            prototype !== null && (typeof prototype === 'object' || typeof prototype === 'function') ? prototype : WriteFileJob.prototype,
            path, flags, mode, data, writeComplete);
    }
    ObjectDefineProperty(WriteFileJob.prototype, 'run', {
        value: function run(path) { return platform.native.runWriteFileJob(this); },
        writable: true, configurable: true,
    });
    return { ReadFileJob, WriteFileJob };
}
