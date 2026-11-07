// Real Console state/stream/clock consumers. The internal trace collector owns
// actual subscriptions; public trace_events/file/inspector support is separate.
function _createNodeConsolePlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ArrayFrom, ObjectDefineProperty, ObjectFreeze, SafeMap, SafeSet,
        StringPrototypeSplit, Error, ReflectApply } = primordials;
    const process = platform.process;
    const sessions = new SafeSet();
    const tracing = platform.tracing;
    function enabled(session, category) {
        const names = StringPrototypeSplit(category, ',');
        for (let i = 0; i < names.length; i++) if (session.categories.has(names[i])) return true;
        return false;
    }
    const traceBinding = {
        // This collector uses classic Node trace phases; no Perfetto backend
        // or shared native category-flag buffer is represented by this owner.
        usePerfetto: false,
        getCategoryEnabledBuffer() { return undefined; },
        isTraceCategoryEnabled(category) {
            if (tracing && tracing.isTraceCategoryEnabled(category)) return true;
            for (const session of sessions) if (session.active && enabled(session, category)) return true;
            return false;
        },
        trace(phase, category, name, id, value) {
            // Native process state is shared by every Worker/realm; private
            // callback subscriptions remain separate per-realm consumers.
            const published = tracing ? tracing.trace(phase, category, name, id, value) : false;
            let record;
            // Snapshot consumers so reentrant registration does not acquire
            // this in-flight event. Stop retires its owner immediately.
            for (const session of ArrayFrom(sessions)) {
                if (!session.active || !enabled(session, category)) continue;
                record ??= ObjectFreeze({ phase, category, name, id, value,
                    timestamp: platform.monotonicNanoseconds() });
                ReflectApply(session.collect, undefined, [record]);
            }
            return published || record !== undefined;
        },
    };
    if (tracing) {
        traceBinding.CategorySet = tracing.CategorySet;
        traceBinding.getEnabledCategories = tracing.getEnabledCategories;
        traceBinding.hasAgent = tracing.hasAgent;
    }
    function collect(categories, callback) {
        platform.values.validators.validateArray(categories, 'categories');
        platform.values.validators.validateFunction(callback, 'callback');
        const selected = new SafeSet();
        for (let i = 0; i < categories.length; i++) {
            platform.values.validators.validateString(categories[i], 'categories[' + i + ']');
            selected.add(categories[i]);
        }
        const session = { categories: selected, collect: callback, active: true };
        sessions.add(session);
        return ObjectFreeze({ stop() { session.active = false; sessions.delete(session); } });
    }
    const factories = {
        __proto__: null,
        /* NODE_CONSOLE_MODULES */
    };
    const modules = new SafeMap();
    function require(name) {
        if (modules.has(name)) return modules.get(name);
        if (factories[name]) {
            const module = { exports: {} };
            modules.set(name, module.exports);
            try { factories[name](module, module.exports, require, primordials, internalBinding, process); }
            catch (error) { modules.delete(name); throw error; }
            modules.set(name, module.exports); return module.exports;
        }
        if (name === 'internal/worker') return { ownsProcessState: platform.ownsProcessState };
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/util/types') return platform.types;
        if (name === 'internal/util/colors') return platform.values.require(name);
        if (name === 'internal/readline/callbacks') return platform.readline.callbacks;
        if (name === 'internal/v8/startup_snapshot') return platform.values.require(name);
        if (name === 'buffer') return { Buffer: platform.Buffer };
        if (name === 'diagnostics_channel') return platform.diagnostics.api;
        throw new Error('Unsupported Console dependency: ' + name);
    }
    function internalBinding(name) {
        if (name === 'trace_events') return traceBinding;
        if (name === 'util') return { previewEntries: platform.previewEntries };
        if (name === 'config') return { hasInspector: false, hasTracing: tracing !== undefined && tracing.hasAgent() };
        throw new Error('Unsupported Console binding: ' + name);
    }
    for (const name of ['log', 'info', 'debug', 'warn', 'error'])
        platform.diagnostics.registerProducer('console.' + name);
    require('internal/util/debuglog').initializeDebugEnv(process.env.NODE_DEBUG);
    const api = require('console');
    require('internal/console/constructor').initializeGlobalConsole(api);
    /* NODE_CONSOLE_EXPOSE_NAMESPACE */
    return { api, collect, traceBinding, trace: require('internal/trace_events'),
        get tracing() { return require('trace_events'); },
        install(target) { exposeNamespace(target, 'console', api); } };
}
