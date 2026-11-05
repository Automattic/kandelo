// Pinned cursor, callback/promise interface, key decoder and history owners.
// Actual terminal modes, stream/decoder/width and filesystem activation remain
// their shared owners; source loading alone is not terminal conformance.
function _createNodeReadlinePlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { NumberIsInteger, SafeMap } = primordials;
    const process = platform.process;
    const isTTY = platform.isTTY;
    /* NODE_TTY_ISATTY */
    const factories = {
        __proto__: null,
        /* NODE_READLINE_MODULES */
    };
    const modules = new SafeMap();
    function require(name) {
        if (modules.has(name)) return modules.get(name);
        if (factories[name]) {
            const module = { exports: {} };
            // Claim before evaluating imports so circular symbol/class users
            // share the actual module owner. Failed evaluation is retryable.
            modules.set(name, module.exports);
            try { factories[name](module, module.exports, require, primordials, process); }
            catch (error) { modules.delete(name); throw error; }
            modules.set(name, module.exports);
            return module.exports;
        }
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        if (name === 'internal/util/inspect') return platform.inspection;
        if (name === 'internal/util/debuglog') return platform.values.require(name);
        if (name === 'internal/streams/utils') return platform.streamUtils;
        if (name === 'internal/events/abort_listener' || name === 'internal/events/symbols')
            return platform.requireEvent(name);
        if (name === 'internal/process/permission') return platform.permission;
        if (name === 'events') return platform.events;
        if (name === 'string_decoder') return platform.stringDecoder;
        if (name === 'path') return platform.path;
        if (name === 'fs') return platform.fs;
        if (name === 'os') return platform.os;
        if (name === 'timers') return platform.timers;
        throw new primordials.Error('Unsupported readline dependency: ' + name);
    }
    return { callbacks: require('internal/readline/callbacks'),
        api: require('readline'), promises: require('readline/promises'), isatty };
}
