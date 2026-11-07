// Public Promise timer algorithms over the actual shared timer/resource owner.
function _createNodeTimersPromisesPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const module = { exports: {} };
    function require(name) {
        if (name === 'internal/timers') return platform.internals;
        if (name === 'timers') return platform.timers;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/util') return platform.values.util;
        // Loaded only when an actual signal needs its protected listener.
        if (name === 'internal/event_target') return platform.getEventTarget();
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Promise timer dependency ' + name);
    }
    (function(module, exports, require, primordials) {
        /* NODE_TIMERS_PROMISES */
    })(module, module.exports, require, primordials);
    return module.exports;
}
