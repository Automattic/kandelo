// Borrowed stdio mode ownership. This is not a public Socket/TTY constructor.
function _createNodeTerminalPlatform(platform) {
    'use strict';
    const { SafeWeakMap, ObjectAssign } = _createNodePrimordials();
    const { ErrnoException, codes: { ERR_INVALID_ARG_VALUE, ERR_TTY_INIT_FAILED } } = platform.values.errors;
    const entries = new SafeWeakMap();
    const outputOwners = new SafeWeakMap();
    const { getColorDepth, hasColors } = platform.values.require('internal/tty');
    // Reopened writes and size queries share the same captured native owner.
    // Unsupported borrowed transports retain their explicit raw-fd fallback.
    function getWindowSize(output, result) {
        const binding = outputOwners.get(output);
        if (binding === undefined) throw new platform.values.errors.codes.ERR_INVALID_THIS('TTY output');
        const packet = binding.owner === undefined
            ? platform.native.operatingSystem('tty-size', binding.fd)
            : platform.native.operatingSystem('tty-output-size', binding.owner);
        if (packet.error) return packet.error;
        result[0] = packet.value[0];result[1] = packet.value[1];return 0;
    }
    let readline;
    function require(name) {
        if (name === 'readline') return platform.getReadline();
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Terminal dependency ' + name);
    }
    function WriteStream() {}
    /* NODE_TERMINAL_OUTPUT_METHODS */
    function bindOutput(output, fd) {
        // Pipes/files keep their actual fd stream and never acquire TTY fields.
        if (!outputOwners.has(output)) {
            if (!platform.isTTY(fd)) return false;
            outputOwners.set(output, { fd });
        }
        ObjectAssign(output, WriteStream.prototype);
        const dimensions = [0, 0];
        if (!getWindowSize(output, dimensions)) {
            output.columns = dimensions[0];output.rows = dimensions[1];
        }
        return true;
    }
    function openOutput(fd) {
        if (!platform.isTTY(fd)) return null;
        const packet = platform.native.operatingSystem('tty-output-open', fd);
        if (packet.error) {
            const code = platform.uv.getSystemErrorName(packet.error);
            // Unsupported reopen/alias paths retain the real borrowed async
            // transport. Their blocking/HWM mismatch remains an explicit gap.
            if (code === 'ENOTSUP' || code === 'EOPNOTSUPP') return null;
            throw new ERR_TTY_INIT_FAILED({ errno: packet.error, code,
                message: platform.uv.getSystemErrorMessage(packet.error), syscall: 'uv_tty_init' });
        }
        const owner = packet.value;
        return {
            // Bind by output object, never by a public descriptor number that
            // can be closed/reused after native initialization.
            bind(output) { outputOwners.set(output, { owner }); },
            write(chunk) {
                const result = platform.native.operatingSystem('tty-output-write', owner, chunk);
                // Writable owns callback/drain/HWM behavior after the actual
                // full synchronous native write/error.
                return result.error ? new ErrnoException(result.error, 'write') : undefined;
            },
        };
    }
    function openInput(fd) {
        if (!platform.isTTY(fd)) return null;
        const packet = platform.native.operatingSystem('tty-input-open', fd);
        if (packet.error) {
            const code = platform.uv.getSystemErrorName(packet.error);
            // Preserve existing master/unreopenable fallback as an explicit gap.
            if (code === 'ENOTSUP' || code === 'EOPNOTSUPP') return null;
            throw new ERR_TTY_INIT_FAILED({ errno: packet.error, code,
                message: platform.uv.getSystemErrorMessage(packet.error), syscall: 'uv_tty_init' });
        }
        const owner = packet.value;
        return {
            bind(input) { entries.set(input, owner); },
            read(length) { return platform.native.operatingSystem('tty-input-read', owner, length); },
            control(promise, value) { return platform.native.operatingSystem('tty-input-control', owner, promise, value).value; },
            close() { platform.native.operatingSystem('tty-input-close', owner); },
        };
    }
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
        const packet = entries.has(input) ? { error: 0, value: entries.get(input) } :
            platform.native.operatingSystem('tty-open', fd);
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
    function refreshOutput(output) {
        // Actual binding identity, not the mutable public isTTY convenience flag.
        if (outputOwners.has(output)) output._refreshSize();
    }
    return { bindInput, bindOutput, refreshOutput, openOutput, openInput };
}
