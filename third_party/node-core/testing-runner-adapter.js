// Exact pinned public runner/discovery algorithms over the real test tree.
// Child report transport/watch/coverage remain missing owning dependencies.
function _createNodeTestingRunner(platform) {
    'use strict';
    const { require, primordials, process, internalBinding } = platform;
    /* NODE_RUNNER_PRIMORDIALS */
    const { statSync } = require('fs');
    const { resolve, sep, isAbsolute } = require('path');
    const { getOptionValue } = require('internal/options');
    const console = require('internal/console/global');
    const { codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } } = require('internal/errors');
    const esmLoader = require('internal/modules/esm/loader');
    const { validateArray, validateBoolean, validateFunction, validateObject, validateOneOf,
        validateInteger, validateUint32, validateString, validateStringArray } = require('internal/validators');
    const { isRegExp } = require('internal/util/types');
    const { pathToFileURL } = require('internal/url');
    const { emitExperimentalWarning, kEmptyObject } = require('internal/util');
    const { createTestTree, startSubtestAfterBootstrap } = require('internal/test_runner/harness');
    const { Test } = require('internal/test_runner/test');
    const { createRandomSeed, convertStringToRegExp, kDefaultPattern,
        parseCommandLine } = require('internal/test_runner/utils');
    const { parseTagFilterExpression } = require('internal/test_runner/tag_filter');
    const { Glob } = require('internal/fs/glob');
    const { validatePath } = require('internal/fs/utils');
    const { exitCodes: { kGenericUserError } } = internalBinding('errors');
    const debug = require('internal/util/debuglog').debuglog('test_runner');
    const kIsolatedProcessName = Symbol('kIsolatedProcessName');
    function missing(owner) {
        const error = new primordials.Error('Node test runner owner is not implemented: ' + owner);
        error.code = 'ERR_NOT_IMPLEMENTED'; throw error;
    }
    function admitRunner(isolation, watch, coverage, isTestRunner) {
        // Validate upstream options first, then fail before creating a root or
        // opening resources. These are implementation gaps, not platform limits.
        if (isolation === 'process') missing('process isolation and child report transport');
        if (watch) missing('watch restart and process lifecycle');
        if (coverage) missing('measured coverage instrumentation');
        if (isTestRunner) missing('test CLI preload/launcher');
    }
    function runTestFile() { return missing('process isolation and child report transport'); }
    function watchFiles() { return missing('watch restart and process lifecycle'); }
    function loadPreloadModules() { return missing('test CLI preload/launcher'); }
    /* NODE_RUNNER_POOL */
    /* NODE_RUNNER_DISCOVER */
    /* NODE_RUNNER_RUN */
    return { run };
}
