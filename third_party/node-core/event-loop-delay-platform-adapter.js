// Exact public ELD lifecycle over a native sampler and real histogram material.
function _createNodeEventLoopDelayPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectCreate, ObjectDefineProperty, ObjectGetOwnPropertyNames,
        ReflectApply, Error, RangeError, TypeError, ObjectPrototypeHasOwnProperty } = primordials;
    function call(name, owner, ...args) {
        const packet = platform.native.eventLoopDelayOperation(name, owner, ...args);
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
    const histogram = platform.histogram;
    const nativeHistogramPrototype = histogram.binding.Histogram.prototype;
    const prototype = ObjectCreate(nativeHistogramPrototype);
    for (const name of ObjectGetOwnPropertyNames(nativeHistogramPrototype)) {
        if (name === 'constructor' || typeof nativeHistogramPrototype[name] !== 'function') continue;
        const method = nativeHistogramPrototype[name];
        ObjectDefineProperty(prototype, name, { __proto__: null, configurable: true, writable: true,
            value: function(...args) { return ReflectApply(method, call('material', this), args); } });
    }
    for (const name of ['start', 'stop']) {
        ObjectDefineProperty(prototype, name, { __proto__: null, configurable: true, writable: true,
            value: function(reset) { call(name, this, reset === true); } });
    }
    const binding = { createELDHistogram(resolution, iteration, lowest, highest, figures) {
        return call('create', prototype, resolution, iteration, lowest, highest, figures);
    } };
    const module = { exports: {} };
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_EVENT_LOOP_DELAY_PUBLIC_WRAPPER */
    })(module, module.exports, name => {
        if (name === 'internal/histogram') return histogram;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/worker/js_transferable') return platform.cloneProtocol;
        throw new Error('Unexpected event-loop-delay dependency: ' + name);
    }, primordials, name => {
        if (name === 'performance') return binding;
        throw new Error('Unexpected event-loop-delay binding: ' + name);
    });
    return { monitorEventLoopDelay: module.exports, binding };
}
