// The actual pinned IncomingMessage owns its Readable/header/abort state.
// Transport framing and client/Agent/server ownership remain separate owners.
function _createNodeHttpIncoming(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const process = platform.process;
    const module = { exports: {} };
    function require(name) {
        if (name === 'stream') return platform.stream;
        if (name === 'internal/abort_controller') return platform.abort;
        throw new Error('Unsupported Node IncomingMessage dependency: ' + name);
    }
    /* NODE_HTTP_INCOMING */
    return module.exports;
}
