// Pinned public URL/path algorithms over the actual shared URL parser, Buffer,
// path and error owners. Only the native EncodePathChars primitive is ported.
function _createNodeURLPathPlatform(embedding) {
    'use strict';
    const P = _createNodePrimordials();
    const { Boolean, Number, ObjectFreeze, StringPrototypeCharAt,
        StringPrototypeCharCodeAt, StringPrototypeCodePointAt,
        StringPrototypeIncludes, StringPrototypeIndexOf, StringPrototypeSlice,
        StringPrototypeStartsWith, StringPrototypeToWellFormed,
        TypedArrayPrototypeGetBuffer, TypedArrayPrototypeGetByteLength,
        TypedArrayPrototypeGetByteOffset, TypedArrayPrototypeSubarray,
        Uint8Array, decodeURIComponent } = P;
    const { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE,
        ERR_INVALID_FILE_URL_HOST, ERR_INVALID_FILE_URL_PATH,
        ERR_INVALID_URL, ERR_INVALID_URL_SCHEME } = embedding.values.errors.codes;
    const { validateObject, kValidateObjectAllowObjects } = embedding.values.validators;
    const { kEmptyObject, SideEffectFreeRegExpPrototypeSymbolReplace } = embedding.values.util;
    const path = embedding.path, Buffer = embedding.Buffer;
    const platform = embedding.process.platform;
    const isWindows = platform === 'win32';
    const domainToUnicode = embedding.domainToUnicode;
    const FORWARD_SLASH = /\//g;
    const CHAR_LOWERCASE_A = 97, CHAR_LOWERCASE_Z = 122;
    const CHAR_FORWARD_SLASH = 47, CHAR_BACKWARD_SLASH = 92, CHAR_COLON = 58;
    const kCreateURLFromPosixPathSymbol = P.Symbol('createURLFromPosixPath');
    const kCreateURLFromWindowsPathSymbol = P.Symbol('createURLFromWindowsPath');
    const { URL: PublicURL, parseURL, basicURLParse, serializeURL } = embedding.web;
    const pathEncodings = ObjectFreeze({ __proto__: null, /* NODE_PATH_ENCODING_TABLE */ });

    function encodePathChars(input, windows) {
        let encoded = 'file://';
        for (let i = 0; i < input.length; ++i) {
            const code = StringPrototypeCharCodeAt(input, i);
            encoded += windows && code === CHAR_BACKWARD_SLASH ? '/'
                : pathEncodings[code] ?? input[i];
        }
        return encoded;
    }
    // Node's private URL constructor modes enter a native encoding/parser
    // binding. Return an actual shared public URL, never a shadow href object.
    function URL(input, hostname, mode) {
        const text = StringPrototypeToWellFormed(input);
        const pathnameMode = mode === kCreateURLFromPosixPathSymbol || mode === kCreateURLFromWindowsPathSymbol;
        const record = parseURL(pathnameMode ? encodePathChars(text, mode === kCreateURLFromWindowsPathSymbol) : text);
        if (record === null) throw new ERR_INVALID_URL(input);
        if (mode === kCreateURLFromWindowsPathSymbol && hostname !== undefined) {
            // A null, uncommitted host makes rejected hostname assignments
            // observable instead of mistaking an unchanged old host for success.
            record.host = null;
            const accepted = basicURLParse(StringPrototypeToWellFormed(hostname), { url: record, stateOverride: 'hostname' });
            if (accepted === null || record.host === null) throw new ERR_INVALID_URL(input, hostname);
        }
        return new PublicURL(serializeURL(record));
    }
    /* NODE_URL_PERCENT_DECODE */
    function lazyPercentDecode(input) { return percentDecode(input); }
    /* NODE_URL_LIKE_PREDICATE */
    /* NODE_URL_HTTP_OPTIONS */
    /* NODE_URL_PATH_CONVERSIONS */
    /* NODE_URL_FS_PATH_CONVERSION */
    return { fileURLToPath, fileURLToPathBuffer, pathToFileURL, urlToHttpOptions, isURL, toPathIfFileURL };
}
