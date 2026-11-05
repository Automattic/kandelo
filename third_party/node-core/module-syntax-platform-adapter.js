// Actual compiler admission shared by CJS loading, ESM format and entry paths.
function _createNodeModuleSyntax(platform) {
    'use strict';
    const { StringPrototypeEndsWith } = _createNodePrimordials();
    const path = platform.path, packageJsonReader = platform.packages;
    const getOptionValue = platform.getOptionValue;
    function initialCommonJsFormat(filename) {
        /* NODE_CJS_FORMAT_SETUP */
        return format;
    }
    const loaderMethods = { getNearestParentPackageJSONType(filename) {
        return packageJsonReader.getNearestParentPackageJSON(filename).data.type;
    } };
    /* NODE_ENTRY_FORMAT_SELECTION */
    function entryIsModule(filename, source) {
        return shouldUseESMLoader(filename) || commonJsFormat(filename, source) === 'module';
    }
    function contains(source, filename) {
        return platform.native.moduleSyntax('detect', platform.normalizeSource(source), filename);
    }
    function commonJsFormat(filename, source) {
        const format = initialCommonJsFormat(filename);
        if (format !== undefined) return format;
        // The patched CJS path compiles Module.wrap's actual script. It does
        // not use the ordinary native function compiler's ESM detection.
        if (platform.getRecords().isWrapperPatched()) return 'commonjs';
        return contains(source, filename) ? 'module' : 'commonjs';
    }
    function esmFormat(filename, source) {
        return platform.getFormat().defaultGetFormat(platform.pathToFileURL(filename), { source });
    }
    function compile(source, filename) {
        const records = platform.getRecords();
        if (records.isWrapperPatched())
            return platform.native.moduleSyntax('wrap', records.Module.wrap(source), filename);
        return platform.native.moduleSyntax('compile', platform.normalizeSource(source), filename);
    }
    return { contains, commonJsFormat, esmFormat, entryIsModule, compile };
}
