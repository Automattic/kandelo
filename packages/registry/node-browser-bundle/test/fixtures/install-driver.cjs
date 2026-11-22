'use strict';
// Consumer test. Run only after the native/CLI and distinct file gates pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const [mode, npmCli, archivePath, projectRoot] = process.argv.slice(2);
assert.ok(['local-tarball', 'controlled-registry'].includes(mode));
assert.equal(process.env.NODE_OPTIONS, '--no-addons'); // Explicit selected profile, including lifecycle children.
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'npm-consumer-project', version: '1.0.0', private: true }));
const archive = fs.readFileSync(archivePath);
const packageManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(archivePath),'fixture-package.json'),'utf8'));
const integrity = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
const children = [];
async function npm(args) {
  const child = spawn(process.execPath, [...process.execArgv, npmCli, ...args], {
    cwd: projectRoot,
    env: { ...process.env, npm_config_cache: path.join(projectRoot, '.npm-cache'), npm_config_update_notifier: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { argv: [...process.execArgv, npmCli, ...args], pid: child.pid, stdout: '', stderr: '' };
  children.push(record);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { record.stdout += data; });
  child.stderr.on('data', data => { record.stderr += data; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      Object.assign(record, { status, signal });
      if (status === 0 && signal === null) resolve();
      else reject(new Error('npm child failed: ' + JSON.stringify(record)));
    });
  });
}
(async () => {
  const requests = [];
  let server;
  try {
    let specifier = archivePath;
    const args = ['install', '--no-audit', '--no-fund', '--foreground-scripts'];
    if (mode === 'local-tarball') args.push('--offline');
    else {
      server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        if (request.method === 'GET' && request.url === '/kandelo-install-fixture') {
          const origin = 'http://127.0.0.1:' + server.address().port;
          const data = JSON.stringify({ name: 'kandelo-install-fixture', 'dist-tags': { latest: '0.0.1' }, versions: {
            '0.0.1': { ...packageManifest, dist: {
              tarball: origin + '/kandelo-install-fixture/-/fixture-0.0.1.tgz', integrity,
            } },
          } });
          response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
          response.end(data);
        } else if (request.method === 'GET' && request.url === '/kandelo-install-fixture/-/fixture-0.0.1.tgz') {
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length });
          response.end(archive);
        } else { response.writeHead(404); response.end('Unknown controlled-registry request'); }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      args.push('--registry=http://127.0.0.1:' + server.address().port);
      specifier = 'kandelo-install-fixture@0.0.1';
    }
    await npm([...args, specifier]);
    const installed = path.join(projectRoot, 'node_modules/kandelo-install-fixture');
    assert.equal(fs.readFileSync(path.join(installed, 'installed.marker'), 'utf8'), 'real-npm-lifecycle\n');
    assert.deepEqual(require(installed), { answer: 42, kind: 'ordinary-js-package' });
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/kandelo-install-fixture'].version, '0.0.1');
    assert.equal(lock.packages['node_modules/kandelo-install-fixture'].integrity, integrity);
    assert.equal(fs.lstatSync(path.join(projectRoot, 'node_modules/.bin/fixture-hello')).isSymbolicLink(), true);
    if (mode === 'controlled-registry') {
      assert.ok(requests.some(row => row.url === '/kandelo-install-fixture'));
      assert.ok(requests.some(row => row.url.endsWith('/fixture-0.0.1.tgz')));
      await npm(['exec', '--offline', '--no', '--', 'fixture-hello']);
      assert.equal(children.at(-1).stdout, 'fixture-bin:42\n');
    }
    fs.writeFileSync(path.join(projectRoot, 'OBSERVATIONS.json'), JSON.stringify({ mode, integrity, children, requests, installed, lock }, null, 2));
    console.log('NPM ' + mode + ' installation PASS');
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
