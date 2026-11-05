import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const { createProcessState, environment, rawUmask } = createRequire(import.meta.url)('./fixtures/node-process-state.cjs');
const lifetimeControls = createRequire(import.meta.url)('./fixtures/node-process-lifetime-controls.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function outcome(fn: () => unknown) {
  try { return { value: fn() }; }
  catch (error: any) { return { name: error.name, code: error.code, message: error.message }; }
}
// Candidate frontends with real native environment and mask dependencies.
// These do not execute the guest C++/libc/kernel bridge or worker bootstrap.
describe.skipIf(process.versions.node !== target.version)('process state with native owners', () => {
  it('reports actual dependency versions with native metadata descriptors', () => {
    const candidate: any = {};
    createProcessState().installVersions(candidate, target.version, '140.11.0esr');
    for (const name of ['node', 'openssl', 'ares', 'sqlite', 'zlib', 'brotli', 'zstd']) {
      expect(Object.getOwnPropertyDescriptor(candidate.versions, name))
        .toEqual(Object.getOwnPropertyDescriptor(process.versions, name));
    }
    expect(Object.getOwnPropertyDescriptor(candidate, 'version'))
      .toEqual(Object.getOwnPropertyDescriptor(process, 'version'));
    const { value: _nativeVersions, ...descriptor } = Object.getOwnPropertyDescriptor(process, 'versions')!;
    const { value: _guestVersions, ...candidateDescriptor } = Object.getOwnPropertyDescriptor(candidate, 'versions')!;
    expect(candidateDescriptor).toEqual(descriptor);
    expect(candidate.versions.spidermonkey).toBe('140.11.0esr');
    for (const absent of ['v8', 'uv', 'modules', 'napi']) expect(Object.hasOwn(candidate.versions, absent)).toBe(false);
    expect(Reflect.set(candidate.versions, 'openssl', 'invented')).toBe(false);
    expect(Reflect.set(candidate, 'versions', {})).toBe(false);
    expect(Reflect.defineProperty(candidate.versions, 'openssl', { value: 'explicit replacement' })).toBe(true);
    expect(candidate.versions.openssl).toBe('explicit replacement');
    expect(Object.isExtensible(candidate.versions)).toBe(true);
  });

  it('forwards the OpenSSL version through the production native adapter', () => {
    const { createNativeAdapter } = createRequire(import.meta.url)('./fixtures/node-native-adapter.cjs');
    const { nativeBoundary } = createRequire(import.meta.url)('./fixtures/node-process-state.cjs');
    expect(createNativeAdapter(nativeBoundary).getOpenSSLVersion()).toBe(process.versions.openssl);
  });

  it('observes live native writes, complete own keys and deletion without resurrection', () => {
    const state = createProcessState(), env = state.createEnvironment();
    const key = `KANDELO_PROCESS_CONTROL_${process.pid}`;
    const inherited = environment[key];
    try {
      environment[key] = 'external';
      expect(env[key]).toBe('external');
      expect(Object.keys(env)).toContain(key);
      environment[key] = 'changed';
      expect(env[key]).toBe('changed');
      expect(key in env).toBe(true);
      expect(Object.getOwnPropertyDescriptor(env, key)).toEqual(Object.getOwnPropertyDescriptor(environment, key));
      env[key] = null;
      expect(environment[key]).toBe('null');
      env[key] = undefined;
      expect(environment[key]).toBe('undefined');
      delete env[key];
      expect(env[key]).toBeUndefined();
      expect(key in env).toBe(false);
      expect(Object.keys(env)).not.toContain(key);
      expect(state.parentPid()).toBe(process.ppid);
    } finally {
      if (inherited === undefined) delete environment[key]; else environment[key] = inherited;
    }
  });

  it('retains descriptor restrictions and symbol conversion semantics', () => {
    const env = createProcessState().createEnvironment();
    const key = `KANDELO_PROCESS_DESCRIPTOR_${process.pid}`;
    const sym = Symbol('env');
    try {
      for (const descriptor of [{ value: 'x' }, { get: () => 'x' }, { set: () => {} },
        { value: 'x', writable: true, enumerable: true, configurable: false }]) {
        expect(outcome(() => Object.defineProperty(env, key, descriptor)))
          .toEqual(outcome(() => Object.defineProperty(environment, key, descriptor)));
      }
      Object.defineProperty(env, key, { value: 'actual', writable: true, enumerable: true, configurable: true });
      expect(environment[key]).toBe('actual');
      expect(env[sym]).toBeUndefined();
      expect(sym in env).toBe(false);
      expect(delete env[sym]).toBe(true);
      expect(outcome(() => { env[sym] = 'x'; })).toEqual(outcome(() => { environment[sym] = 'x'; }));
      expect(outcome(() => { env[key] = sym; })).toEqual(outcome(() => { environment[key] = sym; }));
    } finally { delete environment[key]; }
  });

  it('owns native environment identity, private marks and a real clone snapshot', () => {
    const wt = createRequire(import.meta.url)('node:worker_threads');
    const util = createRequire(import.meta.url)('node:util');
    const env = createProcessState().createEnvironment();
    const key = `KANDELO_ENV_NATIVE_MARK_${process.pid}`;
    const previous = environment[key];
    try {
      expect(util.types.isProxy(env)).toBe(false);
      env[key] = 'live snapshot';
      const snapshot = structuredClone(env);
      expect(snapshot[key]).toBe('live snapshot');
      env[key] = 'changed'; expect(snapshot[key]).toBe('live snapshot');
      const before = Reflect.ownKeys(env);
      expect(wt.isMarkedAsUntransferable(env)).toBe(false);
      wt.markAsUntransferable(env); expect(wt.isMarkedAsUntransferable(env)).toBe(true);
      expect(Reflect.ownKeys(env)).toEqual(before);
      wt.markAsUncloneable(env);
      expect(outcome(() => { structuredClone(env); return true; })).toMatchObject({ name: 'DataCloneError', code: 25 });
      expect(Reflect.ownKeys(env)).toEqual(before);
    } finally { if (previous === undefined) delete environment[key]; else environment[key] = previous; }
  });

  it('keeps inherited receiver writes on their actual receiver', () => {
    const env = createProcessState().createEnvironment();
    const native = new (Object.getPrototypeOf(environment).constructor)();
    const key = `KANDELO_ENV_RECEIVER_${process.pid}`;
    const previous = environment[key];
    function run(value: any) {
      delete environment[key];
      const child = Object.create(value); child[key] = 'own child';
      const absent = { env: environment[key], value: child[key], own: Object.hasOwn(child, key) };
      environment[key] = 'store';
      const other = Object.create(value); other[key] = 'other child';
      const present = { env: environment[key], value: other[key], own: Object.hasOwn(other, key) };
      return { absent, present, refused: Reflect.set(value, key, 'no write', Object.preventExtensions({})), after: environment[key] };
    }
    try { expect(run(env)).toEqual(run(native)); }
    finally { if (previous === undefined) delete environment[key]; else environment[key] = previous; }
  });

  it('accepts private environment marks without a Proxy exemption', () => {
    const wt = createRequire(import.meta.url)('node:worker_threads');
    const util = createRequire(import.meta.url)('node:util');
    const env = createProcessState().createEnvironment();
    const keys = Reflect.ownKeys(env);
    expect(util.types.isProxy(env)).toBe(false);
    expect(wt.isMarkedAsUntransferable(env)).toBe(false);
    expect(wt.markAsUntransferable(env)).toBeUndefined();
    expect(wt.isMarkedAsUntransferable(env)).toBe(true);
    expect(wt.markAsUncloneable(env)).toBeUndefined();
    expect(Reflect.ownKeys(env)).toEqual(keys);
    // This fixture's custom V8 host class is not Node's env template. A
    // rejected clone cannot prove clone-mark enforcement; the independent
    // snapshot assertion above remains a recorded nonpass, not a skip.
  });

  it('distinguishes symbol get interception from prototype membership', () => {
    const env = createProcessState().createEnvironment();
    const native = new (Object.getPrototypeOf(environment).constructor)();
    const key = Symbol('environment prototype');
    const parent = { [key]: 7, fallback: 5, get receiver() { return this; } };
    function run(value: any) {
      Object.setPrototypeOf(value, parent);
      return { has: key in value, read: value[key], own: Object.hasOwn(value, key),
        fallback: value.fallback, receiver: value.receiver === value };
    }
    expect(run(env)).toEqual(run(native));
  });

  it('refuses sealing a live externally mutable key set', () => {
    const env = createProcessState().createEnvironment();
    expect(Reflect.preventExtensions(env)).toBe(false);
    for (const name of ['preventExtensions', 'seal', 'freeze'] as const) {
      expect(outcome(() => { Object[name](env); return true; })).toMatchObject({ name: 'TypeError' });
      expect(Object.isExtensible(env)).toBe(true);
    }
    const key = `KANDELO_ENV_AFTER_FREEZE_${process.pid}`, previous = environment[key];
    try { env[key] = 'still live'; expect(environment[key]).toBe('still live'); }
    finally { if (previous === undefined) delete environment[key]; else environment[key] = previous; }
  });

  it('uses target mask validation and real prior-mask/read-only worker policy', () => {
    const state = createProcessState(), umask = state.createUmask();
    const original = rawUmask();
    try {
      expect(umask(0o027)).toBe(original);
      expect(rawUmask()).toBe(0o027);
      expect(umask()).toBe(0o027);
      expect(umask()).toBe(0o027);
      for (const mask of [{}, null, -1, 2 ** 32, NaN, 1.5, '999', '123x', 'abc', Symbol('mask')]) {
        expect(outcome(() => umask(mask))).toEqual(outcome(() => rawUmask(mask)));
      }
      const workerUmask = state.createUmask(false);
      expect(workerUmask()).toBe(0o027);
      expect(outcome(() => workerUmask('022'))).toMatchObject({ code: 'ERR_WORKER_UNSUPPORTED_OPERATION' });
      expect(rawUmask()).toBe(0o027);
      expect(umask('0022')).toBe(0o027);
      expect(rawUmask()).toBe(0o022);
    } finally { rawUmask(original); }
  });
});

// Natural process exit and GC owners must run in independent native processes.
// This verifies candidate JS/native dependencies, not the guest event loop.
describe.skipIf(process.versions.node !== target.version)('process lifetime with native owners', () => {
  const preload = fileURLToPath(new URL('./fixtures/node-process-lifetime-preload.cjs', import.meta.url));
  for (const [name, fixture] of Object.entries(lifetimeControls) as [string, {
    source: string; stdout: string; exitCode: number; stderr?: string;
  }][]) {
    it(name, () => {
      for (const candidate of [false, true]) {
        const result = spawnSync(process.execPath, ['-e', fixture.source], {
          env: { ...process.env, NODE_OPTIONS: candidate ? `--require=${JSON.stringify(preload)}` : '',
            KANDELO_PROCESS_LIFETIME_RECEIPTS: '' },
          encoding: 'utf8', timeout: 15000,
        });
        expect(result.error, candidate ? 'candidate' : 'native').toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(fixture.exitCode);
        expect(result.stdout).toBe(fixture.stdout);
        if (fixture.stderr) expect(result.stderr).toContain(fixture.stderr);
      }
    });
  }
});
