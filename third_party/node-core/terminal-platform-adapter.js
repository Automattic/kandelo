// Borrowed stdio mode ownership. This is not a public Socket/TTY constructor.
function _createNodeTerminalPlatform(platform) {
    'use strict';
    const { SafeWeakMap } = _createNodePrimordials();
    const { ErrnoException, codes: { ERR_INVALID_ARG_VALUE, ERR_TTY_INIT_FAILED } } = platform.values.errors;
    const entries = new SafeWeakMap();
    // Exact pinned uv_tty_mode_t values, not capability or terminal-state data.
    const UV_TTY_MODE_NORMAL = 0, UV_TTY_MODE_IO = 2, UV_TTY_MODE_RAW_VT = 3;
    function setMode(input, mode) {
        const owner = entries.get(input);
        // Match the target optional-handle path after close or when borrowed.
        if (owner === undefined) return undefined;
        return platform.native.operatingSystem('tty-mode', owner, mode).error;
    }
    function ReadStream() {}
    /* NODE_TERMINAL_SET_RAW */
    function bindInput(input, fd) {
        const packet = platform.native.operatingSystem('tty-open', fd);
        if (packet.error) throw new ERR_TTY_INIT_FAILED({
            errno: packet.error, code: platform.uv.getSystemErrorName(packet.error),
            message: platform.uv.getSystemErrorMessage(packet.error), syscall: 'uv_tty_init',
        });
        entries.set(input, packet.value);
        input.isRaw = false;input.rawMode = false;
        input.setRawMode = ReadStream.prototype.setRawMode;
        return function retireInputMode() {
            const owner = entries.get(input);entries.delete(input);
            if (owner !== undefined) platform.native.operatingSystem('tty-close', owner);
        };
    }
    return { bindInput };
}
