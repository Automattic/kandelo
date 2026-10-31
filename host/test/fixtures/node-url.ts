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
const urlModule = require('url');
const authenticated = new URL('https://u%40x:p%3Ass@xn--g6w251d:8443/a?b=1#frag');
for (const [options, expected] of [
  [undefined, 'https://u%40x:p%3Ass@xn--g6w251d:8443/a?b=1#frag'],
  [{auth:false}, 'https://xn--g6w251d:8443/a?b=1#frag'],
  [{search:false,fragment:false}, 'https://u%40x:p%3Ass@xn--g6w251d:8443/a'],
  [{unicode:true}, 'https://u%40x:p%3Ass@測試:8443/a?b=1#frag'],
]) check(urlModule.format(authenticated, options) === expected, 'WHATWG format: '+JSON.stringify(options));
check(authenticated.username === 'u%40x' && authenticated.hash === '#frag', 'format mutated input');
check(urlModule.format({protocol:'https:',hostname:'example.org',auth:'user:pass',pathname:'/a'}) === 'https://user:pass@example.org/a', 'legacy format');
check(urlModule.format(new URL('mailto:user@example.org')) === 'mailto:user@example.org', 'opaque format');
check(urlModule.format(new URL('https://example.org/?#')) === 'https://example.org/?#', 'empty delimiters');
const fs = require('fs');
for (const name of ['node URL space', 'node-測試', 'node-%20%#?']) {
  const filename = '/tmp/' + name;
  const file = urlModule.pathToFileURL(filename);
  check(urlModule.fileURLToPath(file) === filename, 'file URL round trip: ' + name);
  fs.writeFileSync(file, name);
  check(fs.readFileSync(filename, 'utf8') === name, 'filesystem URL conversion: ' + name);
  check(fs.statSync(file).size > 0, 'stat file URL');
  fs.unlinkSync(file);
}
check(urlModule.fileURLToPath('file://localhost/tmp/a?query#fragment') === '/tmp/a', 'localhost/query/fragment');
check(urlModule.fileURLToPath('file:///tmp/%5c') === '/tmp/\\\\', 'POSIX encoded backslash');
for (const [input, code] of [
  ['https://example.org/a', 'ERR_INVALID_URL_SCHEME'],
  ['file://example.org/tmp/a', 'ERR_INVALID_FILE_URL_HOST'],
  ['file:///tmp/a%2Fb', 'ERR_INVALID_FILE_URL_PATH'],
  ['file:///tmp/a%2fb', 'ERR_INVALID_FILE_URL_PATH'],
]) {
  for (const convert of [value => urlModule.fileURLToPath(value), value => fs.readFileSync(new URL(value))]) {
    let error;
    try { convert(input); } catch (e) { error = e; }
    check(error instanceof TypeError && error.code === code, 'invalid file URL: ' + input);
  }
}
for (const value of ['file:///tmp/%', 'file:///tmp/%FF']) {
  let error;
  try { urlModule.fileURLToPath(value); } catch (e) { error = e; }
  check(error instanceof URIError, 'malformed file URL escape');
}
let nulError;
try { fs.writeFileSync(new URL('file:///tmp/node-url%00truncated'), 'bad'); } catch (e) { nulError = e; }
check(nulError instanceof TypeError && nulError.code === 'ERR_INVALID_ARG_VALUE', 'NUL file URL');
console.log('node-url-ok');
`;
export const nodeUrlCommand = `set -eu\ncat > /tmp/node-url.cjs <<'JS'\n${nodeUrlSource}\nJS\nnode /tmp/node-url.cjs\n`;
