import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import * as util from 'node:util';
import * as tls from 'node:tls';
import * as net from 'node:net';
import * as url from 'node:url';
import { describe, expect, it } from 'vitest';

const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const webBundle = readFileSync(new URL('../../third_party/node-web-platform/node-web-platform.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const factories = Function(`${bundle};${webBundle};return { ip:_createNodeNetworkIP, domain:_createNodeDomainHelpers,
  tls:_createNodeTlsIdentity, values:_createNodeValuesPlatform, web:_createNodeWebPlatform,
  urlPath:_createNodeURLPathPlatform };`)();
function subject() {
  const values = factories.values({ process, Buffer, util, inspection: util, os: {},
    signals: constants.signals, getDOMException: () => DOMException });
  const web = factories.web(), ip = factories.ip();
  const domain = factories.domain({ values, web });
  const checkServerIdentity = factories.tls({ values, net: ip,
    domainToASCII: domain.domainToASCII, canonicalizeIP: ip.canonicalizeIP });
  return { ip, domain, checkServerIdentity };
}
function outcome(fn: () => unknown) {
  try {
    const result = fn();
    return result instanceof Error ? { returned: errorFields(result) } : { value: result };
  } catch (error) { return { thrown: errorFields(error) }; }
}
function errorFields(error: any) {
  return { name: error.name, code: error.code, message: error.message,
    reason: error.reason, host: error.host, cert: error.cert };
}
function runUnchanged(name: string, replacements: Record<string, unknown>) {
  const path = fileURLToPath(new URL(`../../.context/nodejs-lts-cache-v2/node-v26.13.0/test/parallel/${name}`, import.meta.url));
  const nativeRequire = createRequire(path);
  const require = (name: string) => replacements[name] ?? nativeRequire(name);
  // Unchanged upstream assertions, native common/assert/util, candidate API
  // factory source. This is an in-process source control, not a guest run.
  Function('require', '__filename', '__dirname', readFileSync(path, 'utf8'))(require, path, dirname(path));
}

describe.skipIf(process.versions.node !== target.version)('pinned TLS identity and shared domain/IP owners', () => {
  it('executes the unchanged upstream certificate-identity assertions', () => {
    const api = subject();
    runUnchanged('test-tls-check-server-identity.js', { tls: api });
    runUnchanged('test-tls-check-server-identity.js', { tls });
  });

  it('executes unchanged upstream net IP grammar assertions with both owners', () => {
    const { ip } = subject();
    for (const name of ['test-net-isip.js', 'test-net-isipv4.js', 'test-net-isipv6.js']) {
      runUnchanged(name, { net: ip }); runUnchanged(name, { net });
    }
  });

  it('matches domain coercion, invalid host assignment, IDNA and IP normalization', () => {
    const { domain } = subject();
    const inputs = [undefined, null, false, 12, {}, [], Symbol('domain'),
      { toString() { return 'BÜCHER.example'; } }, '', 'Example.COM.', 'bücher.example', 'faß.de',
      'ς.gr', 'ıíd', 'يٴ', 'www.ϧƽəʐ.com', 'новини.com', '名がドメイン.com',
      'افغانستا.icom.museum', 'الجزائر.icom.fake', 'भारत.org', 'xn--bcher-kva.example',
      'bad host', 'x:80', 'x:', 'user@host', '/host', 'host/path', 'host?query', 'host#hash',
      'host\\path', 'a..b', 'host\tname', '\nhost\r', ' host ', '\0host', 'host\0',
      '127.1', '0x7f000001', '0177.0.0.1', '127.0.0.1', '０１２７.０.０.１',
      '[2001:0DB8::0001]', '[::ffff:192.0.2.1]', '2001:db8::1', 'fe80::1%eth0',
      '%E2%98%83.example', '%FF', '\uD800.example', 'xn--', 'xn--a', '💩.la',
      'xn--.xn--bcher-kva.example', 'xn--a.xn--bcher-kva.example', '%78%6e--'];
    for (const name of ['domainToASCII', 'domainToUnicode'] as const) {
      expect(outcome(() => domain[name]())).toEqual(outcome(() => (url[name] as any)()));
      for (const input of inputs) {
        expect(outcome(() => domain[name](input)), `${name}(${String(input)})`)
          .toEqual(outcome(() => url[name](input as any)));
      }
    }
  });

  it('uses the same non-strict ASCII host rule for actual WHATWG URL parsing', () => {
    const web = factories.web();
    for (const host of ['xn--', 'xn--a', 'xn--.xn--bcher-kva.example', '%78%6e--',
      'BÜCHER.example', '127.1', '[2001:0DB8::0001]']) {
      expect(new web.URL('http://' + host + '/path').href)
        .toBe(new url.URL('http://' + host + '/path').href);
    }
  });

  it('matches returned mismatch errors, malformed SAN throws and certificate ownership', () => {
    const { checkServerIdentity } = subject();
    const certs = [{}, { subject: { CN: 'example.com' } }, { subject: { CN: ['a.test', '*.example.com'] } },
      { subject: { CN: 'right.test' }, subjectaltname: 'DNS:wrong.test' },
      { subjectaltname: 'DNS:*.example.com, DNS:bücher.example' },
      { subjectaltname: 'DNS:"a, b.example", DNS:good.example' },
      { subjectaltname: 'DNS:"bad\\q"' }, { subjectaltname: 'DNS:"unclosed' },
      { subjectaltname: 'DNS:exa\0mple.com' },
      { subjectaltname: 'IP Address:2001:0DB8:0:0:0:0:0:1, IP Address:::ffff:c000:0201' }];
    for (const cert of certs) for (const host of ['example.com', 'a.example.com', 'bücher.example',
      'good.example', 'a, b.example', 'right.test', '2001:db8::1', '::ffff:192.0.2.1',
      '127.1', '０１２７.０.０.１', false, undefined]) {
      expect(outcome(() => checkServerIdentity(host, cert)))
        .toEqual(outcome(() => tls.checkServerIdentity(host as any, cert as any)));
    }
    const cert = { subjectaltname: 'DNS:other.test' };
    const error = checkServerIdentity('target.test', cert);
    expect(error.cert).toBe(cert); expect(error.host).toBe('target.test');
    expect(Object.keys(error)).toEqual(Object.keys(tls.checkServerIdentity('target.test', cert as any)!));
    for (const cert of [null, undefined, { subjectaltname: 1 }]) {
      expect(outcome(() => checkServerIdentity('target.test', cert)))
        .toEqual(outcome(() => tls.checkServerIdentity('target.test', cert as any)));
    }
  });

  it('matches libuv canonical IP spellings through public certificate diagnostics', () => {
    const { checkServerIdentity } = subject();
    const addresses = ['127.0.0.1', '127.00.0.1', 'bad', '::', '::1', '::2', '::0.0.2.1',
      '::192.0.2.1', '::ffff:192.0.2.1', '::FFFF:C000:0201', '2001:DB8:0:0:1:0:0:1',
      'fe80::1%eth0', 'fe80::1%anything@all', '127.0.0.1\0ignored', '::ffff:c000:201\0ignored'];
    for (let i = 0; i < 160; i++) {
      const a = (i * 7919) & 65535, b = (i * 3571) & 65535;
      addresses.push(`${a.toString(16)}:0:0:${b.toString(16)}:0:0:0:1`,
        `::ffff:${a.toString(16)}:${b.toString(16)}`);
    }
    for (const address of addresses) {
      const cert = { subjectaltname: 'IP Address:' + address };
      for (const host of ['203.0.113.10', address]) {
        expect(outcome(() => checkServerIdentity(host, cert)), `${host} / ${address}`)
          .toEqual(outcome(() => tls.checkServerIdentity(host, cert as any)));
      }
    }
  });

  it('wires the real bootstrap public exports to the same shared owners', () => {
    const api = subject();
    const a = bootstrap.indexOf('const _nodeDomainHelpers =');
    const b = bootstrap.indexOf('// ============================================================', a);
    const publicURL = Function('_createNodeDomainHelpers', '_nodeValues', '_nodeWebPlatform',
      '_createNodeURLPathPlatform', 'process', 'path', 'Buffer',
      bootstrap.slice(a, b) + ';return url;')(factories.domain,
        factories.values({ process, Buffer, util, inspection: util, os: {}, signals: constants.signals }),
        factories.web(), factories.urlPath, process, path, Buffer);
    expect(publicURL.domainToASCII('BÜCHER.example')).toBe(url.domainToASCII('BÜCHER.example'));
    expect(publicURL.domainToUnicode('xn--bcher-kva.example')).toBe(url.domainToUnicode('xn--bcher-kva.example'));
    const start = bootstrap.indexOf('tls.checkServerIdentity =');
    const end = bootstrap.indexOf('tls.createSecureContext', start);
    const publicTLS = Function('tls', '_createNodeTlsIdentity', '_nodeValues', 'net', '_nodeDomainHelpers', '_nodeNetworkIP',
      bootstrap.slice(start, end) + ';return tls;')({}, factories.tls,
        factories.values({ process, Buffer, util, inspection: util, os: {}, signals: constants.signals }), api.ip, api.domain, api.ip);
    expect(publicTLS.checkServerIdentity('a.test', { subject: { CN: 'a.test' } })).toBeUndefined();
    expect(publicTLS.checkServerIdentity('b.test', { subject: { CN: 'a.test' } }).code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });
});
