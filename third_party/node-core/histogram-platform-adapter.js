// Full pinned public histogram wrapper over actual native owner operations.
// Event-loop-delay scheduling is a separate native producer dependency.
function _createNodeHistogramPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, RangeError, TypeError, Promise, ObjectDefineProperty,
        ObjectPrototypeHasOwnProperty, ReflectApply } = primordials;
    function unwrap(packet) {
        if (!ObjectPrototypeHasOwnProperty(packet, 'error')) return packet.value;
        const record = packet.error;
        const Constructor = record.name === 'RangeError' ? RangeError : record.name === 'TypeError' ? TypeError : Error;
        const error = new Constructor(record.message);
        if (ObjectPrototypeHasOwnProperty(record, 'code')) {
            ObjectDefineProperty(error, 'code', { __proto__: null, value: record.code,
                writable: true, configurable: true, enumerable: true });
        }
        throw error;
    }
    function call(name, owner, ...args) {
        return unwrap(ReflectApply(platform.native.histogramOperation, platform.native, [name, owner, ...args]));
    }
    function Histogram(lowest, highest, figures, halfLife, threshold) {
        return call('create', Histogram.prototype, lowest, highest, figures, halfLife, threshold);
    }
    function SlidingWindowHistogram(lowest, highest, figures, chunks, timeBased, rotateAt) {
        return call('createWindow', SlidingWindowHistogram.prototype, lowest, highest,
            figures, chunks, timeBased, rotateAt);
    }
    Histogram.import = data => call('import', Histogram.prototype, data);
    const methods = ['count', 'countBigInt', 'min', 'minBigInt', 'max', 'maxBigInt',
        'mean', 'stddev', 'exceeds', 'exceedsBigInt', 'skewness', 'kurtosis',
        'ewmaMean', 'ewmaStddev', 'ewmaErrorRate', 'countAt', 'cdf', 'resetCount',
        'record', 'recordDelta', 'recordCorrected', 'reset', 'add', 'subtract',
        'percentile', 'percentileBigInt', 'percentiles', 'percentilesBigInt',
        'percentilesAt', 'linearBuckets', 'logBuckets', 'meanCI', 'percentileCI',
        'ksTest', 'cohensD', 'cliffsD', 'welchTest', 'mannWhitneyTest', 'export',
        'snapshot', 'diff'];
    for (const name of methods) {
        ObjectDefineProperty(Histogram.prototype, name, { __proto__: null,
            configurable: true, writable: true,
            value: function(...args) { return call(name, this, ...args); } });
    }
    ObjectDefineProperty(Histogram.prototype, 'qrde', { __proto__: null,
        configurable: true, writable: true,
        value: function(probabilities, mode, cache) {
            let resolve, reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            // Submission errors remain synchronous, as in GetQrde; actual work
            // and delivery belong to the native queue, never a JS timer job.
            call('qrde', this, probabilities, mode, cache, packet => {
                try { resolve(unwrap(packet)); } catch (error) { reject(error); }
            });
            return promise;
        } });
    for (const name of ['record', 'reset', 'snapshot']) {
        ObjectDefineProperty(SlidingWindowHistogram.prototype, name, { __proto__: null,
            configurable: true, writable: true,
            value: function(...args) { return call(name, this, ...args); } });
    }
    const binding = { Histogram, SlidingWindowHistogram };
    const module = { exports: {} };
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_HISTOGRAM_PUBLIC_WRAPPER */
    })(module, module.exports, name => {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'util') return platform.util;
        if (name === 'internal/worker/js_transferable') return platform.cloneProtocol;
        throw new Error('Unexpected histogram dependency: ' + name);
    }, primordials, name => {
        if (name === 'performance') return binding;
        throw new Error('Unexpected histogram binding: ' + name);
    });
    // Clone readers use the recipient context's actual native prototype.
    call('configure', Histogram.prototype);
    return { ...module.exports, binding };
}
