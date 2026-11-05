// The public Node coercion/error contract over the actual vendored WHATWG
// special-host parser and IDNA dependency. Does not concatenate untrusted
// domain text into an authority (which would interpret userinfo/ports).
function _createNodeDomainHelpers(platform) {
    'use strict';
    const { ERR_MISSING_ARGS } = platform.values.errors.codes;
    const { basicURLParse, serializeHost, hostnameToUnicode } = platform.web;
    function specialHostname(input) {
        if (input === '') return '';
        // An uncommitted host makes early-aborted hostname assignments visible.
        // URL.hostname's public setter silently retains its previous host on
        // failure, so reading that old host would falsely validate bad input.
        const record = { scheme: 'ws', username: '', password: '', host: null,
            port: null, path: [], query: null, fragment: null };
        const result = basicURLParse(input, { url: record, stateOverride: 'hostname' });
        return result === null || result.host === null ? '' : serializeHost(result.host);
    }
    const bindingUrl = {
        domainToASCII: specialHostname,
        domainToUnicode(input) {
            const hostname = specialHostname(input);
            return hostname === '' ? '' : hostnameToUnicode(hostname);
        },
    };
    /* NODE_PUBLIC_DOMAIN_HELPERS */
    return { domainToASCII, domainToUnicode };
}
