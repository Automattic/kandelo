import { createRequire } from 'node:module';
import * as nativeUrl from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { create } = require('./fixtures/node-url-path-platform.cjs');
const subject = create();
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function outcome(fn: () => any) {
  try { const value = fn(); return { value: typeof value === 'object' && value?.href ? value.href
    : ArrayBuffer.isView(value) ? Array.from(value as any) : value }; }
  catch (error: any) { return { name: error.name, code: error.code, message: error.message, input: error.input, base: error.base }; }
}

describe.skipIf(process.versions.node !== target.version)('pinned URL path and HTTP options algorithms', () => {
  it('matches POSIX decoding, validation and actual URIError behavior', () => {
    for (const value of ['file:///tmp/a%20b', 'file:///tmp/%E6%B8%AC%E8%A9%A6', 'file://localhost/a',
      'file://host/a', 'https://example.org/a', 'not a URL', 'http://%', 'file:///%2f', 'file:///%2F',
      'file:///%5C', 'file:///%FF', 'file:///%C0%AF', 'file:///%', 'file:///%ZZ', 'file:///a?query#hash',
      undefined, null, 1, {}, [], Symbol('input')]) {
      expect(outcome(() => subject.fileURLToPath(value, { windows: false })), String(value))
        .toEqual(outcome(() => nativeUrl.fileURLToPath(value as any, { windows: false })));
    }
    expect(outcome(() => subject.fileURLToPath('file:///%FF')).name).toBe('URIError');
  });

  it('uses Windows drive, UNC, IDNA and encoded-separator algorithms', () => {
    for (const value of ['file:///C:/a%20b', 'file:///c:/', 'file:///C|/a', 'file:///relative',
      'file://server/share/a', 'file://xn--mnich-kva/share', 'file://localhost/C:/a',
      'file:///C:/%2F', 'file:///C:/%5c', 'file:///C:/%FF', 'file:///C:/%']) {
      expect(outcome(() => subject.fileURLToPath(value, { windows: true })), value)
        .toEqual(outcome(() => nativeUrl.fileURLToPath(value, { windows: true })));
    }
  });

  it('preserves decoded filename bytes and malformed escapes in real Buffers', () => {
    const storage = require('./fixtures/node-buffer-codecs.cjs').create();
    const candidate = create({ Buffer: storage.Buffer });
    for (const windows of [false, true]) {
      for (const value of ['file:///C:/%FF%FE%80%00', 'file:///C:/%2f%5c', 'file:///C:/%ZZ%',
        'file:///C:/snow-%E9%9B%AA', 'file://host/share/%FF', 'not a URL', 'https://host/a']) {
        const expected = outcome(() => (nativeUrl as any).fileURLToPathBuffer(value, { windows }));
        expect(outcome(() => candidate.fileURLToPathBuffer(value, { windows })), `${windows} ${value}`).toEqual(expected);
        if ('value' in expected) {
          const result = candidate.fileURLToPathBuffer(value, { windows });
          expect(candidate.Buffer.isBuffer(result)).toBe(true);
          expect(result instanceof candidate.Buffer).toBe(true);
        }
      }
    }
  });

  it('encodes actual POSIX paths using the pinned native table and shared parser', () => {
    for (const value of ['/tmp/a b', '/tmp/%20#?', '/tmp/a\\b', '/tmp/[x]^|~', '/tmp/\0', '/tmp/line\n\r\t',
      '/tmp/雪/😀', '/tmp/\ud800', '/tmp/\udfff', '/tmp/dir/', 'relative', '.', '..', '//tmp/a',
      ...Array.from({ length: 128 }, (_, code) => '/tmp/p-' + String.fromCharCode(code) + '-s')]) {
      const actual = subject.pathToFileURL(value, { windows: false });
      expect(actual.href, value).toBe(nativeUrl.pathToFileURL(value, { windows: false }).href);
      expect(Object.getPrototypeOf(actual)).toBe(subject.URL.prototype);
      actual.searchParams.set('live', 'yes'); expect(actual.href).toContain('live=yes');
    }
  });

  it('encodes Windows paths and rejects invalid UNC hosts through real parser state', () => {
    for (const value of ['C:\\a b\\x', 'C:\\', 'C:relative', '\\root\\dir\\', 'relative',
      '\\\\server\\share\\a#?%~', '\\\\münich\\share', '\\\\?\\UNC\\server\\share\\a',
      '\\\\server', '\\\\bad host\\share', '\\\\server:80\\share', '\\\\[bad]\\share',
      '\\\\localhost\\share', '\\\\127.0.0.1\\share', '\\\\?\\UNC\\\\share']) {
      expect(outcome(() => subject.pathToFileURL(value, { windows: true })), value)
        .toEqual(outcome(() => nativeUrl.pathToFileURL(value, { windows: true })));
    }
  });

  it('preserves option/predicate property-read order and target URL-like acceptance', () => {
    function run(owner: any, method: string) {
      const order: string[] = [];
      const source: any = {};
      for (const [key, value] of Object.entries({ href: 'file:///a%20b', protocol: 'file:', auth: undefined,
        path: undefined, hostname: '', pathname: '/a%20b' })) Object.defineProperty(source, key, { get() { order.push(key); return value; } });
      const options = { get windows() { order.push('windows'); return false; } };
      const result = outcome(() => owner[method](source, options));
      return { order, result };
    }
    for (const method of ['fileURLToPath', 'fileURLToPathBuffer']) expect(run(subject, method)).toEqual(run(nativeUrl, method));
    for (const options of [undefined, null, false, 1, 'options', { windows: 'truthy' }, { windows: 0 }]) {
      for (const method of ['fileURLToPath', 'fileURLToPathBuffer', 'pathToFileURL']) {
        const value = method === 'pathToFileURL' ? 'C:\\path' : 'file:///C:/path';
        expect(outcome(() => subject[method](value, options))).toEqual(outcome(() => (nativeUrl as any)[method](value, options)));
      }
    }
  });

  it('converts HTTP options with a null prototype, user properties and exact getter order', () => {
    const key = Symbol('custom');
    for (const value of ['https://user:p%40ss@[::1]:8443/a?q#hash', 'http://example.org/', 'file:///a']) {
      const actualURL = new subject.URL(value), expectedURL = new nativeUrl.URL(value);
      actualURL.extra = (expectedURL as any).extra = 'user'; actualURL[key] = (expectedURL as any)[key] = 'symbol';
      const actual = subject.urlToHttpOptions(actualURL), expected = nativeUrl.urlToHttpOptions(expectedURL);
      expect(Object.getPrototypeOf(actual)).toBeNull();
      expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(expected));
      expect({ ...actual }).toEqual({ ...expected });
    }
    for (const value of [null, 1, 'url', undefined]) expect(outcome(() => subject.urlToHttpOptions(value)))
      .toEqual(outcome(() => nativeUrl.urlToHttpOptions(value as any)));
    function observe(owner: any) {
      const order: string[] = [];
      const input: any = {};
      const fields = { hostname: '[::1]', pathname: '/a', port: '80', username: 'user', password: 'p%40ss',
        search: '?q', protocol: 'http:', hash: '#hash', href: 'http://[::1]/a?q#hash', extra: 'user' };
      for (const [name, value] of Object.entries(fields)) Object.defineProperty(input, name, {
        enumerable: true, get() { order.push(name); return value; },
      });
      const result = owner.urlToHttpOptions(input);
      return { order, result: { ...result }, nullPrototype: Object.getPrototypeOf(result) === null };
    }
    expect(observe(subject)).toEqual(observe(nativeUrl));
    for (const value of [[], () => {}]) expect({ ...subject.urlToHttpOptions(value) })
      .toEqual({ ...nativeUrl.urlToHttpOptions(value as any) });
  });

  it('retains the actual guest platform in POSIX host rejection diagnostics', () => {
    const candidate = create({ process: { ...process, platform: 'kandelo' } });
    const result = outcome(() => candidate.fileURLToPath('file://server/share', { windows: false }));
    expect(result.code).toBe('ERR_INVALID_FILE_URL_HOST');
    expect(result.message).toContain('kandelo');
  });
});
