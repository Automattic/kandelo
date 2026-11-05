import NativeModule, { createRequire } from 'node:module';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
const fixture = createRequire(import.meta.url)('./fixtures/node-module-records.cjs');
const target = JSON.parse(fs.readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function outcome(fn: () => any) {
  try { return { value: fn() }; }
  catch (e: any) { return { name: e.name, code: e.code, message: e.message, requireStack: e.requireStack }; }
}
function directory(files: Record<string, string>, check: (root: string) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'kandelo-cjs-records-')));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), source);
    }
    check(root);
  } finally {
    for (const key of Object.keys(NativeModule._cache)) if (key.startsWith(root + path.sep)) delete NativeModule._cache[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
}
describe.skipIf(process.versions.node !== target.version)('actual CJS Module record and require owners', () => {
  it('uses target constructor/parent descriptors and hidden private storage', () => {
    const { Module: M } = fixture.create();
    function state(C: any) {
      const parent = new C('/parent.cjs'), child = new C('/dir/child.cjs', parent);
      const descriptor = Object.getOwnPropertyDescriptor(C.prototype, 'parent')!;
      return { keys: Reflect.ownKeys(child), id: child.id, path: child.path, filename: child.filename,
        loaded: child.loaded, ownRequire: Object.hasOwn(child, 'require'), ownPaths: Object.hasOwn(child, 'paths'),
        parent: child.parent === parent, child: parent.children[0] === child, constructor: child.constructor === C,
        getter: { enumerable: descriptor.enumerable, configurable: descriptor.configurable,
          getLength: descriptor.get?.length, setLength: descriptor.set?.length },
        isPreloading: child.isPreloading, length: C.length };
    }
    expect(state(M)).toEqual(state(NativeModule));
    for (const value of [null, 1, {}, Symbol('id')])
      expect(outcome(() => new M(value))).toEqual(outcome(() => new (NativeModule as any)(value)));
  });
  it('validates actual URL brands and createRequire file/directory/absolute bases', () => {
    const { Module: M } = fixture.create();
    for (const value of [undefined, null, 1, {}, { href: 'file:///tmp/a.cjs' },
      'relative.cjs', './relative.cjs', 'https://example.invalid/a', new URL('https://example.invalid/a'), Symbol('file')])
      expect(outcome(() => M.createRequire(value))).toEqual(outcome(() => NativeModule.createRequire(value as any)));
    directory({ 'a.cjs': 'module.exports=42', 'dir/child.cjs': 'module.exports=43' }, root => {
      for (const base of [path.join(root, 'entry.cjs'), pathToFileURL(path.join(root, 'entry.cjs')),
        pathToFileURL(path.join(root, 'entry.cjs')).href, root + path.sep]) {
        const a = M.createRequire(base), b = NativeModule.createRequire(base);
        expect(a('./a.cjs')).toBe(b('./a.cjs'));
        expect(a.resolve('./dir/child.cjs')).toBe(b.resolve('./dir/child.cjs'));
      }
    });
  });
  it('shares real Module instances, parent/child graph, JSON records and cached child identity', () => {
    directory({ 'a.cjs': 'exports.self=module;exports.child=require("./child.cjs");exports.data=require("./data.json")',
      'b.cjs': 'exports.self=module;exports.child=require("./child.cjs")',
      'child.cjs': 'module.exports={self:module}', 'data.json': '\ufeff{"value":3}' }, root => {
      const { Module: M } = fixture.create();
      const a = M.createRequire(path.join(root, 'entry.cjs'));
      const first = a('./a.cjs'), second = a('./b.cjs');
      expect(a('node:module')).toBe(M);
      expect(first.self instanceof M).toBe(true);
      expect(first.child.self.parent).toBe(first.self);
      expect(first.self.children).toContain(first.child.self);
      expect(second.self.children).toContain(first.child.self);
      expect(first.child).toBe(second.child);
      expect(second.self.children.filter((x: any) => x === first.child.self)).toHaveLength(1);
      const json = a.cache[path.join(root, 'data.json')];
      expect(json instanceof M).toBe(true); expect(json.loaded).toBe(true);
      expect(json.parent).toBe(first.self); expect(first.data.value).toBe(3);
      expect(first.self.require).toBe(M.prototype.require);
    });
  });
  it('removes a failed child from its parent and cache, allowing source repair', () => {
    directory({ 'parent.cjs': 'exports.self=module;exports.load=()=>require("./broken.cjs")', 'broken.cjs': 'const = ;' }, root => {
      const { Module: M } = fixture.create();
      const req = M.createRequire(path.join(root, 'entry.cjs')), parent = req('./parent.cjs');
      expect(() => parent.load()).toThrow();
      expect(parent.self.children).toEqual([]);
      expect(req.cache[path.join(root, 'broken.cjs')]).toBeUndefined();
      fs.writeFileSync(path.join(root, 'broken.cjs'), 'module.exports={ok:true}');
      expect(parent.load().ok).toBe(true); expect(parent.self.children).toHaveLength(1);
    });
  });
  it('honors actual extension handlers, longest suffix and compiler return/receiver contracts', () => {
    directory({ 'custom.foo': 'not JavaScript', 'custom.long.foo': 'not JavaScript',
      'plain.cjs': 'module.exports=9' }, root => {
      const { Module: M } = fixture.create(); const req = M.createRequire(path.join(root, 'entry.cjs'));
      expect(req.extensions).toBe(M._extensions); expect(req.cache).toBe(M._cache);
      req.extensions['.foo'] = (mod: any, filename: string) => { mod.exports = { instance: mod instanceof M, filename }; };
      req.extensions['.long.foo'] = (mod: any) => { mod.exports = 'longest'; };
      expect(req('./custom').instance).toBe(true);
      expect(req('./custom.long.foo')).toBe('longest');
      const module = new M(path.join(root, 'compiled.cjs'));
      expect(module._compile('exports.same=this===exports;return 37;', path.join(root, 'compiled.cjs'))).toBe(37);
      expect(module.exports.same).toBe(true);
      const explicit = new M('explicit'); explicit.load(path.join(root, 'plain.cjs'));
      expect(explicit.exports).toBe(9); expect(explicit.loaded).toBe(true);
      const native = NativeModule.createRequire(path.join(root, 'entry.cjs'));
      expect(outcome(() => req.resolve('./plain.cjs/'))).toEqual(outcome(() => native.resolve('./plain.cjs/')));
    });
  });
  it('keeps module.require and Module._load replacement on the actual loading path', () => {
    directory({ 'parent.cjs': 'exports.self=module;exports.load=()=>require("./child.cjs")',
      'child.cjs': 'module.exports=17' }, root => {
      const { Module: M } = fixture.create(); const req = M.createRequire(path.join(root, 'entry.cjs'));
      const parent = req('./parent.cjs'); parent.self.require = () => 'module-replacement';
      expect(parent.load()).toBe('module-replacement');
      const load = M._load; let calls = 0;
      M._load = (...args: any[]) => { calls++; return load(...args); };
      expect(req('./child.cjs')).toBe(17); expect(calls).toBe(1);
    });
  });
  it('uses global/parent/options lookup paths and the live resolution cache', () => {
    directory({ 'node_modules/pkg/index.js': 'module.exports=23', 'else/node_modules/other/index.js': 'module.exports=24',
      'relative.cjs': 'module.exports=25' }, root => {
      const { Module: M } = fixture.create(); const base = path.join(root, 'entry.cjs');
      const a = M.createRequire(base), b = NativeModule.createRequire(base);
      expect(M.globalPaths).toEqual(NativeModule.globalPaths);
      for (const from of [root, '.', '/', root + '/node_modules/pkg', root + '/node_modules'])
        expect(M._nodeModulePaths(from)).toEqual(NativeModule._nodeModulePaths(from));
      for (const request of ['pkg', './relative.cjs', 'node:fs', 'fs', 'missing'])
        expect(a.resolve.paths(request)).toEqual(b.resolve.paths(request));
      for (const options of [undefined, { paths: [] }, { paths: [root] }, { paths: [path.join(root, 'else')] },
        { paths: 1 }, { paths: null }])
        for (const request of ['pkg', 'other', './relative.cjs'])
          expect(outcome(() => a.resolve(request, options))).toEqual(outcome(() => b.resolve(request, options)));
      a.resolve('pkg'); expect(Object.keys(M._pathCache).length).toBeGreaterThan(0);
    });
  });
  it('distinguishes builtin cache overrides and unknown node-prefixed load/resolve errors', () => {
    const { Module: M } = fixture.create(); const base = path.join(process.cwd(), 'entry.cjs');
    const req = M.createRequire(base), native = NativeModule.createRequire(base);
    M._cache.fs = { exports: 'override' };
    expect(req('fs')).toBe('override'); expect(req('node:fs')).toBe(createRequire(import.meta.url)('node:fs'));
    for (const value of ['node:not-a-builtin', 'not-a-package-with-this-name', '', null, 1]) {
      expect(outcome(() => req(value))).toEqual(outcome(() => native(value as any)));
      expect(outcome(() => req.resolve(value))).toEqual(outcome(() => native.resolve(value as any)));
    }
  });
});
