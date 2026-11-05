// Private dependencies for the unchanged, pinned Node inspection algorithm.
// Engine metadata is supplied by the embedding; no user properties or promise
// reactions are used to simulate proxy, promise, iterator or native brands.
let _nodeSharedPrimordials;
function _createNodePrimordials() {
    if (_nodeSharedPrimordials !== undefined) return _nodeSharedPrimordials;
    const primordials = Object.create(null);
    (function(primordials) {
        /* NODE_PRIMORDIALS */
    })(primordials);
    return _nodeSharedPrimordials = primordials;
}
function _createNodeInspection(platform) {
    'use strict';
    const primordials = _createNodePrimordials();
    const {
        ArrayIsArray, ArrayPrototypeFilter, FunctionPrototypeSymbolHasInstance,
        Number, NumberIsInteger, ObjectGetOwnPropertyDescriptor,
        ObjectPrototypePropertyIsEnumerable, ReflectOwnKeys, String,
        StringPrototypeReplace, SymbolFor, TypeError, Error,
    } = primordials;
    const types = _createNodeCoreTypes(platform.native);
    const ownNonIndexProperties = (object, filter) => ArrayPrototypeFilter(ReflectOwnKeys(object), key => {
        if (typeof key === 'symbol') return !(filter & 2) && (!(filter & 1) || ObjectPrototypePropertyIsEnumerable(object, key));
        const index = Number(key);
        if (String(index) === key && NumberIsInteger(index) && index >= 0 && index < 0xffffffff) return false;
        return !(filter & 1) || ObjectPrototypePropertyIsEnumerable(object, key);
    });
    function invalidType(name, expected) {
        const error = new TypeError('The "' + name + '" argument must be of type ' + expected);
        error.code = 'ERR_INVALID_ARG_TYPE';
        return error;
    }
    const modules = {
        'internal/util': {
            customInspectSymbol: SymbolFor('nodejs.util.inspect.custom'),
            isError: value => types.isNativeError(value) || FunctionPrototypeSymbolHasInstance(Error, value),
            join(output, separator) {
                let text = '';
                for (let i = 0; i < output.length; i++) text += (i ? separator : '') + output[i];
                return text;
            },
            removeColors: text => StringPrototypeReplace(text, /\u001b\[\d\d?m/g, ''),
        },
        'internal/util/types': types,
        'internal/errors': {
            isStackOverflowError: value => platform.native.hasObjectKind(value, 'StackOverflowError'),
        },
        'internal/validators': {
            kValidateObjectAllowArray: 1,
            validateObject(value, name, flags = 0) {
                if (value === null || typeof value !== 'object' || (!(flags & 1) && ArrayIsArray(value))) {
                    throw invalidType(name, 'Object');
                }
            },
            validateString(value, name) {
                if (typeof value !== 'string') throw invalidType(name, 'string');
            },
        },
        'internal/assert': value => { if (!value) throw new Error('Node inspection invariant failed'); },
        'internal/bootstrap/realm': { BuiltinModule: { exists: name => platform.isBuiltin(name) } },
        'buffer': { Buffer: platform.Buffer },
    };
    function require(name) {
        if (name === 'internal/url') return {
            URL: platform.getURL(), pathToFileURL: path => platform.pathToFileURL(path),
        };
        if (ObjectGetOwnPropertyDescriptor(modules, name)) return modules[name];
        throw new Error('Unsupported Node inspection dependency: ' + name);
    }
    function internalBinding(name) {
        // No native ICU terminal-width binding is exposed here yet. The
        // unchanged upstream algorithm supplies its own Unicode fallback;
        // this does not change the public Intl capability or platform identity.
        if (name === 'config') return { hasIntl: false };
        if (name === 'util') return {
            constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 1, kPending: 0, kRejected: 2 },
            getOwnNonIndexProperties: ownNonIndexProperties,
            getPromiseDetails: value => platform.native.getPromiseDetails(value),
            getProxyDetails: (value, full) => platform.native.getProxyDetails(value, full),
            getConstructorName: value => platform.native.getConstructorName(value),
            previewEntries: (value, pairs) => platform.native.previewEntries(value, pairs),
            getExternalValue() { throw new Error('No Node External values are represented by this embedding'); },
        };
        throw new Error('Unsupported Node inspection binding: ' + name);
    }
    const module = { exports: {} };
    (function(module, exports, require, primordials, internalBinding) {
        /* NODE_INSPECTION */
    })(module, module.exports, require, primordials, internalBinding);
    const {
        MathMin, StringPrototypeTrim, RegExpPrototypeSymbolReplace,
        ArrayPrototypeForEach, StringPrototypeSlice, ObjectPrototypeHasOwnProperty,
        ReflectApply,
    } = primordials;
    const Buffer = platform.Buffer;
    const utilInspect = module.exports.inspect;
    const customInspectSymbol = modules['internal/util'].customInspectSymbol;
    const ALL_PROPERTIES = 0, ONLY_ENUMERABLE = 1;
    const getOwnNonIndexProperties = ownNonIndexProperties;
    const bufferHexSlice = Buffer.prototype.hexSlice;
    const hexSlice = (value, start, end) => ReflectApply(bufferHexSlice, value, [start, end]);
    /* NODE_BUFFER_INSPECTION */
    return {
        ...module.exports,
        getBufferInspectMaxBytes: () => INSPECT_MAX_BYTES,
        setBufferInspectMaxBytes: value => { INSPECT_MAX_BYTES = value; },
    };
}
