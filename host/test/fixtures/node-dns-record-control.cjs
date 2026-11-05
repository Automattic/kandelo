'use strict';
// Focused native record-owner differential. No candidate guest or public API
// conformance claim: the Node reference supplies its actual internal ChannelWrap.
const assert = require('node:assert/strict');
const {createSocket} = require('node:dgram');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {cases, packet, questionName} = require('./node-dns-record-packets.cjs');
const {ChannelWrap, QueryReqWrap} = require('internal/test/binding').internalBinding('cares_wrap');
const exec = promisify(execFile);
const helper = process.env.KANDELO_DNS_RECORD_HELPER;
assert.ok(helper, 'Explicit native helper required; no boundary fallback');
const sha = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
function materialize(value) {
  if (Array.isArray(value)) {
    const array = new Array(value.length);
    for (let i = 0; i < value.length; i++) if (!value[i]?.$hole) array[i] = materialize(value[i]);
    return array;
  }
  if (value && typeof value === 'object') {
    if ('$undefined' in value) return undefined;
    if ('$arrayBuffer' in value) {
      const bytes = Buffer.from(value.$arrayBuffer, 'hex');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    }
    if ('$object' in value) {
      const object = {};
      for (const [key, field] of value.$object)
        Object.defineProperty(object, key, {value: materialize(field), writable: true, enumerable: true, configurable: true});
      for (const [key, field] of value.$assignments) object[key] = materialize(field);
      return object;
    }
  }
  return value;
}
function evidence(value) {
  if (value === undefined) return {$undefined: true};
  if (value instanceof ArrayBuffer) return {$arrayBuffer: Buffer.from(value).toString('hex')};
  if (Array.isArray(value)) return Array.from({length: value.length}, (_, i) => i in value ? evidence(value[i]) : {$hole: true});
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, evidence(v)]));
  return value;
}
(async () => {
  const server = createSocket('udp4');
  const received = [];
  server.on('message', (query, peer) => {
    const name = questionName(query);
    const scenario = cases.find(c => name === c.id + '.records.test');
    assert.ok(scenario, 'Unexpected loopback question ' + name);
    received.push(name);
    server.send(packet(query, scenario), peer.port, peer.address);
  });
  server.bind(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const channel = new ChannelWrap(500, 1, 1000);
  assert.equal(channel.setServers([[4, '127.0.0.1', port]]), 0);
  const report = {kind: 'Native portable DNS record-owner differential; no guest conformance',
    native: {version: process.version, executableSha256: sha(process.execPath)},
    helper: {path: helper, sha256: sha(helper)}, cases: [], received};
  try {
    for (const scenario of cases) {
      const reference = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Reference query deadline')), 4000);
        const request = new QueryReqWrap();
        request.oncomplete = (status, value, ttls) => {
          clearTimeout(timer);
          const result = {status};
          if (status === 0) { result.value = value; if (ttls !== undefined) result.ttls = ttls; }
          resolve(result);
        };
        const status = channel[scenario.method](request, scenario.id + '.records.test');
        if (status) { clearTimeout(timer); reject(Error('Reference submission ' + status)); }
      });
      const {stdout, stderr} = await exec(helper, [String(scenario.type), scenario.id + '.records.test', '127.0.0.1:' + port], {timeout: 5000});
      assert.equal(stderr, '');
      const encoded = JSON.parse(stdout), candidate = {status: encoded.status};
      if (encoded.status === 0) {
        candidate.value = materialize(encoded.value);
        if (encoded.ttls !== undefined) candidate.ttls = encoded.ttls;
      }
      const row = {id: scenario.id, type: scenario.type, native: evidence(reference), candidate: evidence(candidate)};
      try { assert.deepStrictEqual(candidate, reference); row.result = 'pass'; }
      catch (error) { row.result = 'fail'; row.error = error.stack; }
      report.cases.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    channel.cancel(); await new Promise(resolve => server.close(resolve));
    report.pass = report.cases.filter(c => c.result === 'pass').length;
    report.fail = report.cases.filter(c => c.result === 'fail').length;
    if (process.env.KANDELO_DNS_RECORD_REPORT) fs.writeFileSync(process.env.KANDELO_DNS_RECORD_REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.cases.length, cases.length);
  assert.equal(report.fail, 0, 'DNS record mismatches; raw evidence retained');
})().catch(error => { console.error(error); process.exitCode = 1; });
