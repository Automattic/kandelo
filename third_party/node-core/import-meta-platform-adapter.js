// Actual native import.meta object initialization. Native lazy DATA cells own
// descriptor materialization, holder/realm tracing and overwrite/delete policy.
function _createNodeImportMetaPlatform(platform) {
    'use strict';
    const { ObjectCreate, ObjectDefineProperty, ObjectGetOwnPropertyDescriptor,
        ReflectApply, StringPrototypeLastIndexOf, StringPrototypeSlice } = _createNodePrimordials();
    const URL = platform.URL;
    const canonical = platform.canonical;
    const fileURLToPath = platform.fileURLToPath;
    const makeRequire = platform.makeRequire;
    const defineNativeLazy = platform.defineNativeLazyDataProperty;
    const separator = platform.process.platform === 'win32' ? '\\' : '/';
    // Capture actual getters before user code. The retained URL remains a real
    // branded instance; own immutable fields stop later public prototype edits
    // from replacing the private path-conversion input or invoking user getters.
    const fields = ['protocol', 'hostname', 'pathname', 'href'];
    const getters = fields.map(key => ObjectGetOwnPropertyDescriptor(URL.prototype, key).get);
    function capturedURL(href) {
        const value = new URL(href);
        for (let i = 0; i < fields.length; i++) {
            const actual = ReflectApply(getters[i], value, []);
            ObjectDefineProperty(value, fields[i], { __proto__: null, value: actual });
        }
        // The existing private URL-path owner's legacy-vs-WHATWG admission
        // reads these two properties. Keep inherited prototype pollution out.
        ObjectDefineProperty(value, 'auth', { __proto__: null, value: undefined });
        ObjectDefineProperty(value, 'path', { __proto__: null, value: undefined });
        return value;
    }
    function loadPath(value, key) {
        const filename = fileURLToPath(value);
        // Exact pinned PathHelpersLazyGetter substring semantics, including
        // empty dirname for a file directly under the root directory.
        return key === 'dirname'
            ? StringPrototypeSlice(filename, 0, StringPrototypeLastIndexOf(filename, separator))
            : filename;
    }
    function data(object, key, value) {
        ObjectDefineProperty(object, key, { __proto__: null, value,
            writable: true, enumerable: true, configurable: true });
    }
    return function initializeImportMeta(identifier, meta = ObjectCreate(null)) {
        if (typeof identifier !== 'string' || identifier.length === 0) return null;
        const href = canonical(identifier);
        const parsed = capturedURL(href);
        if (parsed.protocol === 'file:') {
            ReflectApply(defineNativeLazy, undefined, [meta, 'dirname', loadPath, parsed, 7]);
            ReflectApply(defineNativeLazy, undefined, [meta, 'filename', loadPath, parsed, 7]);
        }
        data(meta, 'url', href);
        if (parsed.protocol === 'file:') {
            // Preserve the existing non-Node require extension's eager owner.
            // This independent conversion does not materialize either DATA cell.
            data(meta, 'require', makeRequire(fileURLToPath(parsed)));
        }
        return meta;
    };
}
