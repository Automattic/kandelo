// Pinned timeline/entry/observer state over actual clock/clone/event owners.
// Native milestones, loop metrics, histograms and GC/network producers remain
// separate prerequisites; missing measurements never become zero statistics.
function _createNodePerformanceObserverPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayFrom, ArrayIsArray, ArrayPrototypeFilter, ArrayPrototypeIncludes,
        ArrayPrototypePush, ArrayPrototypeSlice, ArrayPrototypeSort, Error,
        MathMax, MathMin, ObjectDefineProperties, ObjectFreeze,
        SafeArrayPrototypePushApply, SafeMap, SafeSet, Symbol, SymbolToStringTag,
        Uint32Array, ReflectApply, FunctionPrototypeCall, ObjectDefineProperty } = primordials;
    const { codes: { ERR_ILLEGAL_CONSTRUCTOR, ERR_INVALID_ARG_TYPE,
        ERR_INVALID_ARG_VALUE, ERR_MISSING_ARGS, ERR_METHOD_NOT_IMPLEMENTED } } = platform.values.errors;
    const { validateFunction, validateObject, validateThisInternalField } = platform.values.validators;
    const { customInspectSymbol: kInspect, lazyDOMException, kEmptyObject,
        kEnumerableProperty } = platform.values.util;
    const process = platform.process;
    const inspect = platform.util.inspect;
    const setImmediate = platform.setImmediate;
    const performanceNow = platform.native.performanceNow;
    const now = () => ReflectApply(performanceNow, platform.native, []);
    const entryModule = { exports: {} };
    (function(module, require) {
        /* NODE_PERFORMANCE_ENTRY */
    })(entryModule, name => {
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'util') return platform.util;
        throw new ERR_METHOD_NOT_IMPLEMENTED(name);
    });
    const { isPerformanceEntry, createPerformanceNodeEntry } = entryModule.exports;
    /* NODE_PERFORMANCE_ENTRY_TYPES */
    const observerCounts = new Uint32Array(6);
    const updateGarbageCollectionTracking = () => {
        throw new ERR_METHOD_NOT_IMPLEMENTED('performance GC tracking');
    };
    /* NODE_PERFORMANCE_OBSERVER_BODY */
    /* NODE_PERFORMANCE_OBSERVER_PRODUCER */
    function unavailable(name) { throw new ERR_METHOD_NOT_IMPLEMENTED(name); }
    const observation = { PerformanceObserver, PerformanceObserverEntryList, enqueue, hasObserver,
        startPerf, stopPerf, clearEntriesFromBuffer, filterBufferMapByNameAndType,
        bufferUserTiming, bufferResourceTiming, setResourceTimingBufferSize, setDispatchBufferFull };
    const constants = {
        /* NODE_PERFORMANCE_MILESTONE_CONSTANTS */
    };
    const binding = {
        constants,
        loopIdleTime() {
            if (platform.native.performanceIdleTime === undefined) return unavailable('performance loop idle measurement');
            return platform.native.performanceIdleTime();
        },
        uvMetricsInfo() { return unavailable('performance loop metric ownership'); },
    };
    const modules = new SafeMap([
        ['internal/perf/performance_entry', entryModule.exports],
        ['internal/perf/observe', observation],
        ['internal/perf/utils', { now,
            getTimeOriginTimestamp: () => platform.native.performanceTimeOrigin(),
            getMilestoneTimestamp(index) {
                if (platform.native.performanceMilestone === undefined) return unavailable('performance milestone measurement');
                return platform.native.performanceMilestone(index);
            } }],
        ['internal/perf/event_loop_utilization', { eventLoopUtilization() {
            return unavailable('performance event-loop utilization measurement');
        } }],
        ['internal/histogram', { isHistogram(value) {
            if (platform.histogram === undefined) return unavailable('performance histogram branding/ownership');
            return platform.histogram.isHistogram(value);
        } }],
        ['internal/errors', platform.values.errors],
        ['internal/validators', platform.values.validators],
        ['internal/util', platform.values.util],
        ['util', platform.util],
        ['internal/assert', platform.values.require('internal/assert')],
        ['internal/worker/js_transferable', { structuredClone: platform.structuredClone }],
    ]);
    const factories = {
        /* NODE_PERFORMANCE_TIMELINE_MODULES */
    };
    function require(name) {
        if (modules.has(name)) return modules.get(name);
        if (name === 'internal/event_target') return platform.event.eventTarget;
        if (name === 'internal/webidl') return platform.event.require('internal/webidl');
        if (!primordials.ObjectPrototypeHasOwnProperty(factories, name)) return unavailable(name);
        const module = { exports: {} };
        modules.set(name, module.exports);
        try { factories[name](module, module.exports, require, primordials, name => {
            if (name === 'performance') return binding;
            return unavailable('performance native binding ' + name);
        }); } catch (error) { modules.delete(name); throw error; }
        modules.set(name, module.exports); return module.exports;
    }
    const { performance, Performance } = require('internal/perf/performance');
    const { PerformanceMark, PerformanceMeasure } = require('internal/perf/usertiming');
    const { PerformanceResourceTiming } = require('internal/perf/resource_timing');
    const api = { performance, Performance, PerformanceMark, PerformanceMeasure, PerformanceResourceTiming,
        PerformanceObserver, PerformanceObserverEntryList, PerformanceEntry: entryModule.exports.PerformanceEntry,
        timerify: require('internal/perf/timerify'), eventLoopUtilization: require('internal/perf/event_loop_utilization').eventLoopUtilization };
    for (const name of ['monitorEventLoopDelay', 'createHistogram', 'createSlidingWindowHistogram', 'importHistogram'])
        api[name] = function() { return unavailable('performance ' + name + ' native ownership'); };
    modules.set('perf_hooks', api);
    /* NODE_PERFORMANCE_REPLACEABLE_GLOBAL */
    function installGlobals(target) {
        defineReplaceableLazyAttribute(target, 'perf_hooks', ['performance']);
        for (const name of ['Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure',
            'PerformanceObserver', 'PerformanceObserverEntryList', 'PerformanceResourceTiming']) {
            ObjectDefineProperty(target, name, { __proto__: null, configurable: true, writable: true, value: api[name] });
        }
    }
    return {
        installGlobals,
        api, observation: { hasObserver, startPerf, stopPerf },
    };
}
