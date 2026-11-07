// Actual pinned test tree/harness, mocks and reporters over the shared process,
// async, stream and caller-location owners. Discovery/isolation/coverage remain
// separate owners; no successful runner stream is fabricated for missing work.
function _createNodeTestingPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { Error, ObjectPrototypeHasOwnProperty, SafeMap } = primordials;
    const process = platform.process;
    const factories = { /* NODE_TESTING_MODULES */ };
    const modules = new SafeMap();
    function unavailable(name) {
        const error = new Error('Node testing owner is not implemented: ' + name);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    const { getDeprecationWarningEmitter } = platform.values.util;
    /* NODE_TEST_DEPRECATE_PROPERTY */
    const helpers = { ...platform.values.util, deprecateProperty,
        getStructuredStack: function getStructuredStack() {
            return platform.getStructuredStack();
        } };
    const bindings = new SafeMap([
        ['internal/errors', platform.values.errors],
        ['internal/util', helpers],
        ['internal/util/types', platform.types],
        ['internal/util/comparisons', platform.comparisons],
        ['internal/util/inspect', platform.inspection],
        ['internal/util/debuglog', platform.values.require('internal/util/debuglog')],
        ['internal/validators', platform.values.validators],
        ['internal/events/abort_listener', { addAbortListener: platform.events.addAbortListener }],
        ['internal/event_target', platform.eventTarget],
        ['internal/abort_controller', platform.abort],
        ['internal/assert/utils', platform.assertUtils],
        ['internal/timers', { TIMEOUT_MAX: 2147483647 }],
        ['internal/fs/utils', platform.fsUtils],
        ['internal/fs/glob', platform.glob],
        ['internal/console/global', platform.console],
        ['internal/options', { getOptionValue: platform.getOptionValue }],
        ['internal/url', platform.url],
        ['internal/modules/cjs/loader', { Module: platform.Module }],
        ['internal/modules/esm/loader', { getOrInitializeCascadedLoader() {
            const resolver = platform.getModuleResolver();
            return { resolveSync: (...args) => resolver.resolveSync(...args),
                import: platform.importModule };
        } }],
        ['internal/modules/customization_hooks', { registerHooks: platform.Module.registerHooks }],
        ['internal/process/task_queues', { queueMicrotask: platform.queueMicrotask }],
        ['process', process], ['assert', platform.assert], ['path', platform.path], ['fs', platform.fs],
        ['os', platform.os], ['events', platform.events], ['async_hooks', platform.async],
        ['stream', platform.stream],
        ['timers', platform.timers], ['timers/promises', platform.timerPromises],
        ['vm', platform.vm], ['diagnostics_channel', platform.diagnostics],
    ]);
    function require(name) {
        if (bindings.has(name)) return bindings.get(name);
        if (modules.has(name)) return modules.get(name).exports;
        if (name === 'internal/test_runner/runner') {
            const exports = _createNodeTestingRunner({ require, primordials, internalBinding, process });
            modules.set(name, { exports }); return exports;
        }
        if (name === 'test') name = 'test-public';
        if (name === 'test/reporters') name = 'test-reporters-public';
        if (modules.has(name)) return modules.get(name).exports;
        if (name === 'internal/streams/readable' || name === 'internal/streams/transform')
            return platform.streamRequire(name);
        if (!ObjectPrototypeHasOwnProperty(factories, name)) return unavailable(name);
        const module = { exports: {} };
        modules.set(name, module);
        try { factories[name](module, module.exports, require, primordials, internalBinding, process); }
        catch (error) { modules.delete(name); throw error; }
        return module.exports;
    }
    function internalBinding(name) {
        if (name === 'types') return platform.types;
        if (name === 'util') return { getCallerLocation: platform.getCallerLocation };
        // Source-verified against the retained pinned node_exit_code.h. This is
        // an exit policy constant, not a successful outcome or resource metric.
        if (name === 'errors') return { exitCodes: { kGenericUserError: 1 } };
        return unavailable('binding ' + name);
    }
    return { get api() { return require('test'); },
        get reporters() { return require('test/reporters'); }, require };
}

// The normal Node argument parser currently rejects test/watch/coverage flags.
// Default node:test imports still need their actual unactivated option state.
// Generate that state from the exact target's C++ field declarations, retaining
// arrays across reads like the target option cache. This does not activate CLI
// discovery, coverage, source maps, watching or any unavailable runner feature.
function _createNodeTestOptionReader(platform) {
    const { Error, SafeMap } = _createNodePrimordials();
    const defaults = new SafeMap(/* NODE_TEST_OPTION_DEFAULTS */);
    const options = platform.cliOptions;
    return function getOptionValue(name) {
        if (name === '--experimental-test-module-mocks') return options.experimentalTestModuleMocks === true;
        if (name === '--test-update-snapshots') return options.testUpdateSnapshots === true;
        if (name === '--strip-types') return options.stripTypes === true;
        if (defaults.has(name)) return defaults.get(name);
        const error = new Error('Test option ownership is not implemented: ' + name);
        error.code = 'ERR_NOT_IMPLEMENTED';
        throw error;
    };
}
