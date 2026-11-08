// Complete pinned public tty.js over the genuine native constructor/Socket
// owners. Captured process stdio retains its independent publication policy.
function _createNodePublicTerminalPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const module = { exports: {} };
    function require(name) {
        if (name === 'net') return platform.net;
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/tty') return platform.values.require(name);
        if (name === 'readline') return platform.getReadline();
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Public TTY dependency: ' + name);
    }
    function internalBinding(name) {
        if (name !== 'tty_wrap')
            throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Public TTY binding: ' + name);
        // The OS owner publishes this constructor in its ordinary result
        // envelope. Its private native prototype/cache already owns identity.
        const packet = platform.native.operatingSystem('tty-constructor');
        if (packet.error)
            throw new platform.values.errors.ErrnoException(packet.error, 'tty-constructor');
        return { TTY: packet.value, isTTY: platform.isTTY,
            // Exact pinned uv_tty_mode_t values, not measured terminal state.
            UV_TTY_MODE_NORMAL: 0, UV_TTY_MODE_IO: 2, UV_TTY_MODE_RAW_VT: 3 };
    }
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_PUBLIC_TTY_MODULE */
    })(module, module.exports, require, primordials, internalBinding);
    return module.exports;
}
