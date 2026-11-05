// Pinned public validation/delta/field algorithms. Native counters require
// actual providers; absent measurement never becomes a zero/elapsed sample.
function _createNodeProcessUsage(platform) {
    'use strict';
    const { Float64Array, NumberMAX_SAFE_INTEGER } = _createNodePrimordials();
    const { validateObject, validateNumber } = platform.values.validators;
    const { ERR_INVALID_ARG_VALUE, ERR_OPERATION_FAILED } = platform.values.errors.codes;
    const process = platform.process;
    const { cpuUsage: _cpuUsage, threadCpuUsage: _threadCpuUsage,
        memoryUsage: _memoryUsage, rss, resourceUsage: _resourceUsage } = platform.binding;
    /* NODE_PROCESS_USAGE */
    /* NODE_PROCESS_RESOURCE */
    return { cpuUsage, threadCpuUsage, memoryUsage, resourceUsage };
}

function _createNodeUnavailableProcessUsage(values) {
    const { ERR_METHOD_NOT_IMPLEMENTED } = values.errors.codes;
    return {
        cpuUsage() { throw new ERR_METHOD_NOT_IMPLEMENTED('process.cpuUsage measurement'); },
        threadCpuUsage() { throw new ERR_METHOD_NOT_IMPLEMENTED('process.threadCpuUsage measurement'); },
        memoryUsage() { throw new ERR_METHOD_NOT_IMPLEMENTED('process.memoryUsage measurement'); },
        rss() { throw new ERR_METHOD_NOT_IMPLEMENTED('process.memoryUsage.rss measurement'); },
        resourceUsage() { throw new ERR_METHOD_NOT_IMPLEMENTED('process.resourceUsage measurement'); },
    };
}
