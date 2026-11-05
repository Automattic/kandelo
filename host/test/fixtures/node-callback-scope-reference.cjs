'use strict';
const assert = require('node:assert/strict');
const { AsyncLocalStorage, createHook } = require('node:async_hooks');
const binding = require(process.argv[2]);
const mode = process.argv[3];
const storage = new AsyncLocalStorage();
const labels = new Map();
const trace = [];
const outer = { label: 'outer', retired: false };
const log = text => trace.push(text);
const hooks = createHook({
  init(id, type, trigger, resource) {
    if (type === 'KandeloCallbackScopeControl') labels.set(id, resource.label);
  },
  before(id) {
    const label = labels.get(id);
    if (!label) return;
    if (mode === 'fatal') {
      process.stdout.write('before-fatal\n');
      throw Error('callback-scope-before-fatal-control');
    }
    log(`before:${label}:${storage.getStore()}`);
  },
  after(id) {
    const label = labels.get(id);
    if (label) log(`after:${label}:${storage.getStore()}`);
  },
  destroy(id) { labels.delete(id); },
}).enable();
function queue(label) {
  const live = () => outer.retired ? 'retired' : 'live';
  process.nextTick(() => {
    log(`tick:${label}:${storage.getStore()}:${live()}`);
    Promise.resolve().then(() => log(`job-from-tick:${label}:${storage.getStore()}:${live()}`));
  });
  Promise.resolve().then(() => {
    log(`job:${label}:${storage.getStore()}:${live()}`);
    process.nextTick(() => log(`tick-from-job:${label}:${storage.getStore()}:${live()}`));
  });
}
if (['js-entry', 'job-entry', 'timer-entry'].includes(mode)) {
  const enter = () => {
    storage.run('outer-store', () => binding.run(outer, () => {
      log(`body:outer:${storage.getStore()}`); queue('outer');
    }));
    assert.equal(outer.retired, true);
    log('retire:outer'); log('continued:js');
    setImmediate(() => { hooks.disable(); console.log(JSON.stringify({ mode, trace })); });
  };
  if (mode === 'job-entry') Promise.resolve().then(enter);
  else if (mode === 'timer-entry') setImmediate(enter);
  else enter();
  return;
}
storage.run('outer-store', () => binding.start(outer, () => {
  if (mode === 'fatal') { process.stdout.write('body-must-not-run\n'); return; }
  log(`body:outer:${storage.getStore()}`);
  queue('outer');
  if (mode === 'exit') {
    log('process-exit:17');
    require('node:fs').writeSync(1, JSON.stringify({ mode, trace }) + '\n');
    process.exit(17);
  }
  if (mode === 'nested' || mode === 'throw') {
    storage.run('inner-store', () => {
      try {
        binding.run({ label: 'inner' }, () => {
          log(`body:inner:${storage.getStore()}`);
          queue('inner');
          if (mode === 'throw') throw Error('inner-original');
        });
      } catch (error) {
        assert.equal(mode, 'throw');
        assert.equal(error.message, 'inner-original');
        log(`caught:${storage.getStore()}`);
      }
    });
    log(`continued:outer:${storage.getStore()}`);
  }
}, () => {
  hooks.disable();
  assert.equal(outer.retired, true);
  log('retire:outer');
  console.log(JSON.stringify({ mode, trace }));
}));
