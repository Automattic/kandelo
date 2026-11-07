'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const events = require('node:events');
const { AsyncResource, AsyncLocalStorage, createHook } = require('node:async_hooks');
assert.equal(process.version, 'v26.13.0');
assert.equal(process.versions.openssl, '3.5.9');
assert.equal(typeof global.gc, 'function');
const privateRoot = fs.realpathSync(process.env.TLS_ASYNC_OWNER_DIR);
const rows = [], destroys = new Set();
const store = new AsyncLocalStorage();
let creating = false, wrap, init, initCount = 0;
const hook = createHook({
  init(id, type, trigger, resource) {
    if (creating && type === 'TLSWRAP') {
      ++initCount;
      wrap = resource;
      init = { id, type, trigger, store: store.getStore(), execution: require('node:async_hooks').executionAsyncId(), nativeId: resource.getAsyncId() };
    }
  },
  destroy(id) { destroys.add(id); },
});
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(Error('bounded native TLS control timed out')), 3000))]).finally(() => clearTimeout(timer));
}
async function group(name, body) {
  try { rows.push({ name, pass: true, result: await body() }); }
  catch (error) { rows.push({ name, pass: false, error: error.stack }); }
}
(async () => {
  const component = require(path.join(privateRoot, 'header-component.node'));
  await group('actual portable owner defers SSL allocation and refuses replacement/closed/invalid admission', () => {
    const facts = component.check();
    assert.deepEqual(facts, Array(9).fill(true));
    return { facts: facts.length, scope: 'Actual production portable header; host Node OpenSSL, not guest JSAPI' };
  });
  const keys = path.resolve(privateRoot, '../nodejs-lts-cache-v2/node-v26.13.0/test/fixtures/keys');
  const peers = new Set();
  const server = tls.createServer({ key: fs.readFileSync(path.join(keys, 'rsa_private.pem')), cert: fs.readFileSync(path.join(keys, 'rsa_cert.crt')) });
  server.on('secureConnection', peer => { peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer)); peer.resume(); });
  await bounded(new Promise(resolve => server.listen(0, '127.0.0.1', resolve)));
  const source = store.run('actual-init-frame', () => new AsyncResource('tls-provider-reference'));
  const sourceId = source.asyncId();
  let socket;
  hook.enable();
  try {
    await group('native TLSWRAP init uses its actual wrapper and caller trigger/frame before handshake', async () => {
      store.run('actual-init-frame', () => source.runInAsyncScope(() => {
        creating = true;
        try { socket = tls.connect({ host: '127.0.0.1', port: server.address().port, rejectUnauthorized: false }); }
        finally { creating = false; }
      }));
      socket.on('error', () => {});
      assert(init);
      assert.equal(initCount, 1);
      assert.equal(init.trigger, sourceId);
      assert.equal(init.execution, sourceId);
      assert.equal(init.nativeId, init.id);
      assert.equal(init.store, 'actual-init-frame');
      assert.equal(socket._handle, wrap);
      assert.equal(socket.secureConnecting, true);
      await bounded(events.once(socket, 'secureConnect'));
      return init;
    });
    await group('native close/SSL retirement preserves retained wrapper async identity', async () => {
      assert(socket && wrap && init);
      const closed = events.once(socket, 'close');
      socket.destroy();
      await bounded(closed);
      await new Promise(setImmediate);
      assert.equal(wrap.getAsyncId(), init.id);
      assert.equal(destroys.has(init.id), false);
      return { id: init.id, destroyWhileWrapperRetained: false };
    });
    await group('native TLSWRAP destroy follows actual wrapper release and collection', async () => {
      assert(init);
      wrap = null;
      socket = null;
      for (let i = 0; i < 8 && !destroys.has(init.id); ++i) {
        global.gc();
        await new Promise(setImmediate);
      }
      assert.equal(destroys.has(init.id), true);
      return { id: init.id, actualNativeDestroyObserved: true };
    });
  } finally {
    if (socket) socket.destroy();
    for (const peer of peers) peer.destroy();
    await bounded(new Promise(resolve => server.close(resolve)));
    hook.disable(); source.emitDestroy();
  }
  const report = { rows, passed: rows.filter(x => x.pass).length, failed: rows.filter(x => !x.pass).length,
    scope: 'Actual portable header + native Node lifecycle reference. New Kandelo native TLSWRAP JSAPI/state/GC/init/realm/Worker integration is uncompiled and unexecuted.' };
  console.log(JSON.stringify(report));
  process.exitCode = report.failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
