'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { AsyncLocalStorage, createHook, executionAsyncId } = require('node:async_hooks');
const binary = size => Buffer.from(Array.from({ length:size }, (_, i) => (i * 73 + (i >>> 8)) & 255));
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kandelo-copy-file-'));
function outcome(fn, base) {
  try { return { value:fn() }; }
  catch (e) {
    const normalize = value => typeof value === 'string' ? value.replaceAll(base, '<root>') : value;
    return { name:e.name, code:e.code, errno:e.errno, syscall:e.syscall, message:normalize(e.message),
      path:normalize(e.path), dest:normalize(e.dest), keys:Object.keys(e) };
  }
}
module.exports = {
  syncBinaryIdentityAndMetadata(candidate) {
    const base = directory(), source = path.join(base, 'source'), dest = path.join(base, 'dest');
    try {
      const sizes = [0, 1, 8191, 8192, 8193, 262149, 2097169], checked = [];
      for (const size of sizes) {
        const bytes = binary(size); fs.writeFileSync(source, bytes); fs.chmodSync(source, 0o751);
        fs.utimesSync(source, 1000.125, 2000.25);
        fs.writeFileSync(dest, 'long previous destination'); fs.chmodSync(dest, 0o600);
        assert.equal(candidate.api.copyFileSync(pathToFileURL(source), Buffer.from(dest)), undefined);
        assert.deepEqual(fs.readFileSync(dest), bytes);
        const stat = fs.statSync(dest);
        assert.equal(stat.mode & 0o7777, 0o751);
        assert.equal(stat.uid, fs.statSync(source).uid); assert.equal(stat.gid, fs.statSync(source).gid);
        if (size === 0) assert.equal(stat.mtimeMs, 2000250);
        checked.push(size);
      }
      const inode = fs.statSync(source).ino, bytes = fs.readFileSync(source);
      assert.equal(candidate.api.copyFileSync(source, source, 0), undefined);
      assert.equal(fs.statSync(source).ino, inode); assert.deepEqual(fs.readFileSync(source), bytes);
      const hard = path.join(base, 'hard'), sym = path.join(base, 'sym');
      fs.linkSync(source, hard); fs.symlinkSync('source', sym);
      candidate.api.copyFileSync(source, hard, 4); candidate.api.copyFileSync(source, sym);
      assert.deepEqual(fs.readFileSync(source), bytes);
      return { checked, sameInode:true, mode:fs.statSync(dest).mode & 0o7777 };
    } finally { fs.rmSync(base, { recursive:true, force:true }); }
  },
  syncErrorsAndValidation(candidate) {
    const base = directory(), source = path.join(base, 'source'), dest = path.join(base, 'dest');
    fs.writeFileSync(source, 'source'); fs.writeFileSync(dest, 'keep');
    try {
      const errors = [];
      for (const mode of [undefined, null, -1, 8, 0.9, 1.9, -0.9, 7.9, 2 ** 32, NaN, Infinity, '1', true, {}, 1n]) {
        errors.push(outcome(() => candidate.api.copyFileSync(path.join(base, 'missing'), dest, mode), base));
      }
      const raw = Buffer.concat([Buffer.from(base + '/missing-'), Buffer.from([0xff, 0xfe])]);
      for (const args of [[source,dest,1], [source,source,1], [raw,dest], [source,path.join(base,'absent/dest')],
        [source,base], [base,path.join(base,'dir-copy')], ['',dest], [source,''], [null,dest], [source,null]]) {
        errors.push(outcome(() => candidate.api.copyFileSync(...args), base));
      }
      assert.equal(fs.readFileSync(dest, 'utf8'), 'keep');
      assert.equal(fs.existsSync(path.join(base, 'dir-copy')), false);
      errors.push(outcome(() => candidate.api.copyFile(null, null, {}, undefined), base));
      errors.push(outcome(() => candidate.api.copyFile(source, dest, {}, undefined), base));
      return errors;
    } finally { fs.rmSync(base, { recursive:true, force:true }); }
  },
  cloneAndDestinationCleanup(candidate) {
    const base = directory(), source = path.join(base, 'source'), dest = path.join(base, 'dest');
    fs.writeFileSync(source, binary(32771));
    try {
      candidate.api.copyFileSync(source, dest, 2);
      assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(source));
      const bestEffort = fs.statSync(dest).size;
      const force = outcome(() => candidate.api.copyFileSync(source, dest, 4), base);
      if (force.code) assert.equal(fs.existsSync(dest), false);
      else assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(source));
      fs.writeFileSync(dest, 'retained');
      const exclusive = outcome(() => candidate.api.copyFileSync(source, dest, 5), base);
      assert.equal(exclusive.code, 'EEXIST'); assert.equal(fs.readFileSync(dest, 'utf8'), 'retained');
      return { bestEffort, force, forceDestinationExists:!force.code, exclusive };
    } finally { fs.rmSync(base, { recursive:true, force:true }); }
  },
  async callbacksAndPromises(candidate) {
    const base = directory(), source = path.join(base, 'source'), dest = path.join(base, 'dest');
    const storage = new AsyncLocalStorage(), ids = new Set(); const observed = [];
    fs.writeFileSync(source, binary(8193));
    const hook = createHook({ init(id,type) { if (type === 'FSREQCALLBACK' || type === 'FSREQPROMISE') { ids.add(id); observed.push(type); } } }).enable();
    try {
      await storage.run('copy-context', () => new Promise((resolve,reject) => {
        let returned = false;
        candidate.api.copyFile(Buffer.from(source), pathToFileURL(dest), function(error) {
          try { assert.equal(returned,true); assert.equal(error,null); assert.equal(arguments.length,1);
            assert.equal(this,undefined); assert.equal(storage.getStore(),'copy-context');
            assert(ids.has(executionAsyncId())); resolve(); } catch(e) { reject(e); }
        }); returned = true;
      }));
      assert.equal(await candidate.promises.copyFile(source, dest), undefined);
      assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(source));
      const missing = path.join(base, 'missing');
      const callbackError = await new Promise(resolve => candidate.api.copyFile(missing,dest,error => resolve(error)));
      let promiseError; try { await candidate.promises.copyFile(missing,dest); } catch(e) { promiseError=e; }
      assert(callbackError); assert(promiseError);
      const results = [callbackError,promiseError].map(error => outcome(() => { throw error; },base));
      let validation; try { await candidate.promises.copyFile(null,null); } catch(e) { validation=e.code; }
      return { observed, errors:results, validation };
    } finally { hook.disable(); fs.rmSync(base, { recursive:true, force:true }); }
  },
  async exclusiveRace(candidate) {
    const base = directory(), source = path.join(base, 'source'), dest = path.join(base, 'dest');
    const bytes = binary(2097169); fs.writeFileSync(source, bytes);
    try {
      const statuses = await Promise.all(Array.from({length:24}, () => candidate.promises.copyFile(source,dest,1).then(() => 0,e => e.code)));
      assert.equal(statuses.filter(status => status === 0).length, 1);
      assert.equal(statuses.filter(status => status === 'EEXIST').length, 23);
      assert.deepEqual(fs.readFileSync(dest), bytes);
      return { successes:1, exclusiveLosers:23, bytes:bytes.length };
    } finally { fs.rmSync(base, { recursive:true, force:true }); }
  },
  async initPathSnapshots(candidate) {
    const base=directory(), source=path.join(base,'source'), alpha=path.join(base,'alpha'), bravo=path.join(base,'bravo');
    fs.writeFileSync(source,'snapshot'); let dest=Buffer.from(alpha), seen=0;
    let hook=createHook({init(_id,type){if(type==='FSREQCALLBACK'){seen++;dest.set(Buffer.from(bravo));}}}).enable();
    try {
      await new Promise((resolve,reject)=>{candidate.api.copyFile(source,dest,error=>error?reject(error):resolve());dest.fill(0x78);});
      assert.equal(seen,1); assert.equal(fs.existsSync(alpha),false); assert.equal(fs.readFileSync(bravo,'utf8'),'snapshot');
    } finally {hook.disable();}
    fs.unlinkSync(bravo); dest=Buffer.from(alpha); seen=0;
    hook=createHook({init(_id,type){if(type==='FSREQPROMISE'){seen++;dest.set(Buffer.from(bravo));}}}).enable();
    try {
      const promise=candidate.promises.copyFile(source,dest);dest.fill(0x78);await promise;
      assert.equal(seen,1); assert.equal(fs.readFileSync(alpha,'utf8'),'snapshot'); assert.equal(fs.existsSync(bravo),false);
      return ['callback-after-init','promise-before-init','queue-owned-bytes'];
    } finally {hook.disable();fs.rmSync(base,{recursive:true,force:true});}
  },
};
