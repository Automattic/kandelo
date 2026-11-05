// Pinned warning creation, event/throw scheduling, filtering and file ownership.
// The real process/console/fs owners supply I/O and lifecycle dependencies.
function _createNodeWarningPlatform(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const { ObjectDefineProperty } = primordials;
    const process = platform.process;
    const cli = platform.cliOptions;
    function getOptionValue(name) {
        switch (name) {
            case '--warnings': return cli.noWarnings !== true;
            case '--no-warnings': return cli.noWarnings === true;
            case '--no-deprecation': return cli.noDeprecation === true;
            case '--throw-deprecation': return cli.throwDeprecation === true;
            case '--trace-deprecation': return cli.traceDeprecation === true;
            case '--trace-warnings': return cli.traceWarnings === true;
            case '--diagnostic-dir': return cli.diagnosticDir || '';
            case '--redirect-warnings': return cli.redirectWarnings || '';
            case '--disable-warning': return cli.disableWarnings || [];
            default: throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Warning option ' + name);
        }
    }
    function require(name) {
        if (name === 'internal/options') return { getOptionValue };
        if (name === 'internal/assert') return platform.values.require(name);
        if (name === 'internal/errors') return platform.values.errors;
        if (name === 'internal/validators') return platform.values.validators;
        if (name === 'internal/console/global') return platform.getConsole();
        if (name === 'fs') return platform.fs;
        if (name === 'path') return platform.path;
        throw new platform.values.errors.codes.ERR_METHOD_NOT_IMPLEMENTED('Warning dependency ' + name);
    }
    const module = { exports: {} };
    (function(module, exports, require, primordials, process) {
        /* NODE_WARNING_MODULE */
    })(module, module.exports, require, primordials, process);
    return {
        ...module.exports,
        install() {
            // Exact startup policy: only truthy options create these mutable-
            // by-redefinition, nonwritable public process aliases.
            for (const [name, option] of [
                ['noDeprecation', '--no-deprecation'], ['noProcessWarnings', '--no-warnings'],
                ['traceProcessWarnings', '--trace-warnings'], ['throwDeprecation', '--throw-deprecation'],
                ['traceDeprecation', '--trace-deprecation'],
            ]) {
                const value = getOptionValue(option);
                if (value) ObjectDefineProperty(process, name, {
                    __proto__: null, value, writable: false, configurable: true, enumerable: true,
                });
            }
            process.emitWarning = module.exports.emitWarning;
            if (getOptionValue('--warnings') && process.env.NODE_NO_WARNINGS !== '1')
                process.on('warning', module.exports.onWarning);
        },
    };
}
