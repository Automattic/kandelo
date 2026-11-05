'use strict';
const assert = require('node:assert/strict');
const dns = require('node:dns');
const { createSocket } = require('node:dgram');
const { once } = require('node:events');
const { cases, packet, questionName } = require('./node-dns-record-packets.cjs');
const { createDnsPlatform } = require('./node-dns-platform.cjs');
const fs = require('node:fs');
const subject = createDnsPlatform();
function error(e) { return { name: e.name, code: e.code, message: e.message, errno: e.errno,
  syscall: e.syscall, hostname: e.hostname, keys: Object.keys(e) }; }
function thrown(fn) { try { fn(); } catch (e) { return error(e); } throw Error('Expected rejection'); }
const methodNames = { queryAny: 'resolveAny', queryA: 'resolve4', queryAaaa: 'resolve6',
  queryCaa: 'resolveCaa', queryCname: 'resolveCname', queryMx: 'resolveMx', queryNs: 'resolveNs',
  queryTlsa: 'resolveTlsa', queryTxt: 'resolveTxt', querySrv: 'resolveSrv', queryPtr: 'resolvePtr',
  queryNaptr: 'resolveNaptr', querySoa: 'resolveSoa' };
async function result(fn) { try { return { value: await fn() }; } catch (e) { return { error: error(e) }; } }
(async () => {
  const server = createSocket('udp4');
  const requests = [];
  server.on('message', (query, peer) => {
    const name = questionName(query); requests.push(name);
    if (name === 'silent.records.test') return;
    let scenario;
    if (name.endsWith('.in-addr.arpa')) scenario = { type: 12, records: [{ type: 12, ttl: 90, value: 'reverse.records.test' }] };
    else scenario = cases.find(c => name === c.id + '.records.test');
    assert(scenario, 'Unexpected actual DNS question ' + name);
    server.send(packet(query, scenario), peer.port, peer.address);
  });
  server.bind(0, '127.0.0.1'); await once(server, 'listening');
  const address = '127.0.0.1:' + server.address().port;
  const candidate = new subject.promises.Resolver({ timeout: 300, tries: 1 });
  const reference = new dns.promises.Resolver({ timeout: 300, tries: 1 });
  candidate.setServers([address]); reference.setServers([address]);
  const callbackCandidate = new subject.api.Resolver({ timeout: 300, tries: 1 });
  const callbackReference = new dns.Resolver({ timeout: 300, tries: 1 });
  callbackCandidate.setServers([address]); callbackReference.setServers([address]);
  const report = { kind: 'Full pinned public DNS resolver algorithms over actual native Node ChannelWrap/request/OS boundaries; no guest conformance',
    native: process.version, cases: [], requests };
  async function check(name, run) {
    try { await run(); report.cases.push({ name, result: 'pass' }); }
    catch (e) { report.cases.push({ name, result: 'fail', error: e.stack }); }
  }
  try {
    for (const scenario of cases) await check('record:' + scenario.id, async () => {
      const method = methodNames[scenario.method], name = scenario.id + '.records.test';
      assert.deepStrictEqual(await result(() => candidate[method](name, { ttl: true })),
        await result(() => reference[method](name, { ttl: true })));
      function callback(owner) { return new Promise((resolve, reject) => {
        let returned = false;
        const request = owner[method](name, { ttl: true }, (e, value) => {
          try { assert(returned, 'Actual callback must be asynchronous'); assert(request.getAsyncId() > 0);
            resolve(e ? { error: error(e) } : { value }); } catch (e) { reject(e); }
        });
        returned = true;
      }); }
      assert.deepStrictEqual(await callback(callbackCandidate), await callback(callbackReference));
    });
    await check('reverse', async () => {
      assert.deepStrictEqual(await candidate.reverse('192.0.2.9'), await reference.reverse('192.0.2.9'));
      assert.deepStrictEqual(await result(() => candidate.reverse('invalid')), await result(() => reference.reverse('invalid')));
    });
    await check('validation-and-servers', async () => {
      assert.deepStrictEqual(candidate.getServers(), reference.getServers());
      for (const options of [{ timeout: -2 }, { tries: 0 }, { maxTimeout: -1 }])
        assert.deepStrictEqual(thrown(() => new subject.api.Resolver(options)), thrown(() => new dns.Resolver(options)));
      for (const servers of ['bad', ['bad'], ['127.0.0.1:65536'], [1]])
        assert.deepStrictEqual(thrown(() => candidate.setServers(servers)), thrown(() => reference.setServers(servers)));
      assert.deepStrictEqual(thrown(() => candidate.resolve('a.records.test', 'INVALID')),
        thrown(() => reference.resolve('a.records.test', 'INVALID')));
      assert.deepStrictEqual(thrown(() => callbackCandidate.resolve4('x\0y', () => {})),
        thrown(() => callbackReference.resolve4('x\0y', () => {})));
    });
    await check('cancel-and-pending-server-replacement', async () => {
      async function run(owner) {
        const pending = result(() => owner.resolve4('silent.records.test'));
        const replacement = thrown(() => owner.setServers([]));
        owner.cancel();
        const settled = await pending;
        owner.setServers([address]);
        return { replacement, settled, after: owner.getServers() };
      }
      assert.deepStrictEqual(await run(candidate), await run(reference));
    });
    await check('default-resolver-sharing-and-descriptors', async () => {
      assert.equal(Object.getOwnPropertyDescriptor(subject.api, 'promises').get.name, 'get');
      subject.api.setServers([address]);
      assert.deepStrictEqual(subject.api.getServers(), subject.promises.getServers());
      assert.deepStrictEqual(await subject.promises.resolve('a.records.test'), await reference.resolve('a.records.test'));
      for (const name of Object.keys(dns).filter(name => /^[A-Z_]+$/.test(name)))
        assert.equal(subject.api[name], dns[name], name);
      assert.deepStrictEqual(Object.keys(subject.api), Object.keys(dns));
      assert.deepStrictEqual(Object.keys(subject.promises), Object.keys(dns.promises));
    });
  } finally {
    candidate.cancel(); reference.cancel(); callbackCandidate.cancel(); callbackReference.cancel();
    subject.close(); await new Promise(resolve => server.close(resolve));
    report.pass = report.cases.filter(c => c.result === 'pass').length;
    report.fail = report.cases.filter(c => c.result === 'fail').length;
    if (process.env.KANDELO_DNS_RESOLVER_REPORT) fs.writeFileSync(process.env.KANDELO_DNS_RESOLVER_REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
  assert.equal(report.fail, 0, 'Resolver differences; raw results retained');
})().catch(e => { console.error(e); process.exitCode = 1; });
