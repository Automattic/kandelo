// IP representation is adapted from libuv; ISC license: licenses/uv-inet.txt.
// One IP grammar/canonicalizer for net and certificate identity. No resolver,
// peer lookup, or fabricated network state is involved in these conversions.
function _createNodeNetworkIP() {
    'use strict';
    const primordials = _createNodePrimordials();
    const { RegExp, RegExpPrototypeTest, StringPrototypeIndexOf,
        StringPrototypeSlice, StringPrototypeSplit, ArrayPrototypeJoin,
        NumberParseInt, NumberPrototypeToString } = primordials;
    /* NODE_NETWORK_IP_GRAMMAR */

    // Port of the pinned libuv inet_pton/inet_ntop representation rules.
    // In particular, URL IPv6 serialization alone would lose libuv's dotted
    // IPv4-compatible/mapped spelling in certificate mismatch diagnostics.
    function canonicalizeIP(input) {
        const nul = StringPrototypeIndexOf(input, '\0');
        if (nul !== -1) input = StringPrototypeSlice(input, 0, nul);
        if (isIPv4(input)) return input;
        const zone = StringPrototypeIndexOf(input, '%');
        if (zone !== -1) input = StringPrototypeSlice(input, 0, zone);
        if (!isIPv6(input)) return undefined;
        const halves = StringPrototypeSplit(input, '::');
        const words = [];
        function append(part) {
            if (!part) return;
            for (const field of StringPrototypeSplit(part, ':')) {
                if (StringPrototypeIndexOf(field, '.') === -1) {
                    words[words.length] = NumberParseInt(field, 16);
                } else {
                    const bytes = StringPrototypeSplit(field, '.');
                    words[words.length] = NumberParseInt(bytes[0], 10) * 256 + NumberParseInt(bytes[1], 10);
                    words[words.length] = NumberParseInt(bytes[2], 10) * 256 + NumberParseInt(bytes[3], 10);
                }
            }
        }
        append(halves[0]);
        if (halves.length === 2) {
            const tail = [];
            // Count the right-hand groups before filling the compressed run.
            if (halves[1]) for (const field of StringPrototypeSplit(halves[1], ':')) {
                tail[tail.length] = field;
            }
            let tailLength = tail.length;
            if (tailLength && StringPrototypeIndexOf(tail[tailLength - 1], '.') !== -1) tailLength++;
            while (words.length < 8 - tailLength) words[words.length] = 0;
            append(halves[1]);
        }
        let bestBase = -1, bestLength = 0, currentBase = -1;
        for (let i = 0; i <= 8; i++) {
            if (i < 8 && words[i] === 0) {
                if (currentBase === -1) currentBase = i;
            } else if (currentBase !== -1) {
                if (i - currentBase > bestLength) {
                    bestBase = currentBase; bestLength = i - currentBase;
                }
                currentBase = -1;
            }
        }
        if (bestLength < 2) bestBase = -1;
        let output = '';
        for (let i = 0; i < 8; i++) {
            if (bestBase !== -1 && i >= bestBase && i < bestBase + bestLength) {
                if (i === bestBase) output += ':';
                continue;
            }
            if (i !== 0) output += ':';
            if (i === 6 && bestBase === 0 && (bestLength === 6 ||
                (bestLength === 7 && words[7] !== 1) ||
                (bestLength === 5 && words[5] === 0xffff))) {
                output += ArrayPrototypeJoin([words[6] >>> 8, words[6] & 255,
                    words[7] >>> 8, words[7] & 255], '.');
                break;
            }
            output += NumberPrototypeToString(words[i], 16);
        }
        if (bestBase !== -1 && bestBase + bestLength === 8) output += ':';
        return output;
    }
    return { isIP, isIPv4, isIPv6, canonicalizeIP };
}
