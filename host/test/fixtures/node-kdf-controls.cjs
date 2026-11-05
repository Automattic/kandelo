'use strict';
const assert = require('node:assert/strict');
const { AsyncLocalStorage, createHook, executionAsyncId } = require('node:async_hooks');
module.exports = {
  poisonedPacketPrototype(api) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'error');
    try {
      Object.defineProperty(Object.prototype, 'error', { configurable:true,
        get() { throw Error('Native packet must not read inherited error'); } });
      return [api.pbkdf2Sync('p','s',2,16,'sha256').toString('hex'),
        api.scryptSync('p','s',16,{N:16,r:1,p:1}).toString('hex')];
    } finally {
      if (descriptor) Object.defineProperty(Object.prototype,'error',descriptor);
      else delete Object.prototype.error;
    }
  },
  synchronousBytes(api) {
    const values = [Buffer.from('pass\0word'), 'é\0word', new Uint16Array([0x1234, 0x5678]),
      new DataView(Uint8Array.from([9, 1, 2, 3, 8]).buffer, 1, 3),
      Uint8Array.from([1, 2, 3]).buffer, new Uint8Array(new SharedArrayBuffer(4))];
    return values.map(input => {
      const salt = new DataView(Uint8Array.from([7, 4, 0, 6]).buffer, 1, 3);
      const p = api.pbkdf2Sync(input, salt, 2, 33, 'sha256');
      const s = api.scryptSync(input, salt, 33, { N: 16, r: 1, p: 1 });
      assert(Buffer.isBuffer(p) && Buffer.isBuffer(s));
      assert.equal(p.buffer.byteLength, 33); assert.equal(s.buffer.byteLength, 33);
      return [p.toString('hex'), s.toString('hex')];
    });
  },
  validationAndOptionOrder(api) {
    const result = [];
    function error(fn) {
      try { fn(); return { returned: true }; }
      catch (e) { return { name: e.name, code: e.code, message: e.message }; }
    }
    for (const args of [[], [null, null, 0, -1, null], ['p', 's', 0, 1, 'sha256'],
      ['p','s',1,2 ** 31,'sha256'], ['p','s',1,1,'invalid-digest'], ['p','s',1,1,'sha256'],
      ['p','s',1,1,() => {}], [new ArrayBuffer(0),'s',1,1,'sha256',null]]) {
      result.push(error(() => api.pbkdf2(...args)));
    }
    for (const options of [{ N: 16, cost: 16 }, { r: 1, blockSize: 1 }, { p: 1, parallelization: 1 },
      { N: 1 }, { N: 3 }, { N: 1024, r: 8, maxmem: 1024 }, { N: -1 }, { maxmem: 1.1 }]) {
      result.push(error(() => api.scryptSync('p', 's', 1, options)));
    }
    const trace = [], options = {};
    for (const [key, value] of [['N',16],['r',1],['p',1],['maxmem',32 << 20]]) {
      Object.defineProperty(options, key, { get() { trace.push(key); return value; } });
    }
    result.push(api.scryptSync('p','s',8,options).toString('hex'), trace);
    return result;
  },
  scryptAliasesAndZeroOutput(api) {
    const a = api.scryptSync('p','s',16,{ N:16,r:1,p:1 });
    const b = api.scryptSync('p','s',16,{ cost:16,blockSize:1,parallelization:1 });
    assert.deepEqual(a,b);
    const results = [a.toString('hex')];
    const bytes = api.scryptSync('','',-0,{ N:16,r:1,p:1 });
    assert(Buffer.isBuffer(bytes)); assert.equal(bytes.length,0); results.push(bytes.toString('hex'));
    // Public validation accepts zero, but the target provider rejects its
    // PBKDF2 derivation. Keep that actual failure distinct from scrypt's empty result.
    assert.throws(() => api.pbkdf2Sync('','',1,-0,'sha256'), { message:'PBKDF2 derivation failed' });
    return results;
  },
  asyncSnapshotAndResourceScope: async function(api) {
    const store = new AsyncLocalStorage(), resources = new Map();
    const hook = createHook({ init(id,type,_trigger,resource) {
      if (type === 'PBKDF2REQUEST' || type === 'SCRYPTREQUEST') resources.set(id,resource);
    } }).enable();
    try {
      return await store.run('actual-scope', async () => {
        const results = [];
        for (const kind of ['pbkdf2','scrypt']) {
          const password=Buffer.from('password'),salt=Buffer.from('salt');
          let returned=false;
          const result = await new Promise((resolve,reject) => {
            function done(error, bytes) {
              try {
                assert.equal(returned,true); assert.equal(error,null);
                assert.equal(store.getStore(),'actual-scope');
                assert.equal(resources.get(executionAsyncId()),this);
                assert.equal(this.constructor.name,kind === 'pbkdf2' ? 'PBKDF2Job' : 'ScryptJob');
                assert(Buffer.isBuffer(bytes)); assert.equal(bytes.buffer.byteLength,32);
                resolve(bytes.toString('hex'));
              } catch(e) { reject(e); }
            }
            if (kind === 'pbkdf2') api.pbkdf2(password,salt,8,32,'sha256',done);
            else api.scrypt(password,salt,32,{ N:16,r:1,p:1 },done);
            password.fill(0);salt.fill(0);returned=true;
          });
          results.push(result);
        }
        return results;
      });
    } finally { hook.disable(); }
  },
  constructorSnapshotOrder: async function(api) {
    const results=[];
    for (const async of [false,true]) {
      const password=Buffer.from('p'), salt=Buffer.from('s'); let seen=0;
      const hook=createHook({ init(_id,type) {
        if (type !== 'PBKDF2REQUEST') return;
        seen++;password[0]=0x71;salt[0]=0x74;
      } }).enable();
      try {
        const result=async ? await new Promise((resolve,reject) => api.pbkdf2(password,salt,8,16,'sha256',
          (e,bytes) => e ? reject(e) : resolve(bytes))) : api.pbkdf2Sync(password,salt,8,16,'sha256');
        assert.equal(seen,1);results.push(result.toString('hex'));
      } finally { hook.disable(); }
    }
    assert.notEqual(results[0],results[1]);
    return results;
  },
  asyncZeroAndProviderFailure: async function(api) {
    const results=[];
    for (const [method,args] of [['pbkdf2',['','',1,0,'sha256']],
      ['scrypt',['','',0,{N:16,r:1,p:1}]], ['pbkdf2',['p','s',8,8,'md4']]]) {
      let returned=false;
      const result=await new Promise((resolve,reject) => {
        try { api[method](...args,function(error,bytes) {
          try {
            assert.equal(returned,true);
            resolve(error ? { name:error.name,message:error.message,code:error.code,result:bytes } : {hex:bytes.toString('hex')});
          } catch(e) { reject(e); }
        }); returned=true; } catch(e) { reject(e); }
      });
      results.push(result);
    }
    return results;
  },
};
