// Full pinned Domain owner. Load lazily: EventEmitter/process/hook mutations
// belong to actual public domain loading, never unconditional bootstrap.
function _createNodeDomainPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { SafeWeakRef } = primordials;
    /* NODE_DOMAIN_WEAK_REFERENCE */
    const require = name => {
        if (name === 'events') return platform.events;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'async_hooks') return platform.async.api;
        if (name === 'internal/async_hooks') return platform.async.domain;
        if (name === 'internal/util') return { WeakReference };
        throw new primordials.Error('Unresolved Domain dependency: ' + name);
    };
    const module = { exports: {} };
    (function(module, exports, require, primordials, process) {
        /* NODE_DOMAIN_MODULE */
    })(module, module.exports, require, primordials, platform.process);
    return module.exports;
}
