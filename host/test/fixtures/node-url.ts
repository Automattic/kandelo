/** URL validation and mutable query state used by HTTP clients. */
export const nodeUrlSource = `
const { URL: NodeURL, URLSearchParams: Params } = require('url');
const check = (value, message) => { if (!value) throw Error(message); };
check(URL === NodeURL && URLSearchParams === Params, 'global and module URL disagree');
const cases = [
  ['https://example.org/a', undefined, true],
  ['/a', undefined, false],
  ['/a', 'https://example.org/base', true],
  ['/a', '', false],
  ['https://example.org/', 'invalid', false],
  ['https://example.org:65536/', undefined, false],
  ['https://example.org:bad/', undefined, false],
  ['https://[::1]:443/', undefined, true],
  ['https://[::zzz]/', undefined, false],
  ['https://bad host/', undefined, false],
  ['mailto:a@example.org', undefined, true],
  ['file:///tmp/a', undefined, true],
  [undefined, undefined, false],
  [{ toString: () => 'https://example.org/' }, undefined, true],
];
for (const [input, base, expected] of cases) {
  check(URL.canParse(input, base) === expected, 'canParse: ' + String(input));
  let parsed = false;
  try { new URL(input, base); parsed = true; } catch (e) { check(e instanceof TypeError, 'invalid error type'); }
  check(parsed === expected, 'constructor: ' + String(input));
}
let coercionError;
try { URL.canParse(Symbol('url')); } catch (e) { coercionError = e; }
check(coercionError instanceof TypeError, 'coercion errors must escape canParse');
const u = new URL('../messages', 'http://EXAMPLE.org:80/v1/base/');
check(u.href === 'http://example.org/v1/messages', 'relative URL or default port');
u.search = 'beta=true';
check(u.href === 'http://example.org/v1/messages?beta=true', 'search assignment');
u.searchParams.append('tag', 'a b');
u.searchParams.append('tag', 'c+d');
check(u.search === '?beta=true&tag=a+b&tag=c%2Bd', 'live search params');
check(JSON.stringify(u.searchParams.getAll('tag')) === '["a b","c+d"]', 'duplicate params');
u.search = '?x=1&x=2';
check(u.searchParams.getAll('x').join(',') === '1,2', 'live search replacement');
u.pathname = '/new path';
u.hash = 'section';
check(u.toString() === 'http://example.org/new%20path?x=1&x=2#section', 'serialization');
check(JSON.stringify(u) === JSON.stringify(u.href), 'toJSON');
check(new URL('https://測試/').hostname === 'xn--g6w251d', 'IDNA host');
check(new Params('a=one+two&a=three').getAll('a').join(',') === 'one two,three', 'form query decoding');
console.log('node-url-ok');
`;
export const nodeUrlCommand = `set -eu\ncat > /tmp/node-url.cjs <<'JS'\n${nodeUrlSource}\nJS\nnode /tmp/node-url.cjs\n`;
