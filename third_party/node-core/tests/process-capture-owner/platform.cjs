'use strict';
// Explicit native control boundary: Node owns its actual process, aliased native
// toggle, async stack and fatal dispatch. Production uses Kandelo JSAPI instead.
exports.install = function install(tree) {
  const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os'),assert=require('node:assert/strict');
  assert.equal(process.version,'v26.13.0');
  const code=fs.readFileSync(path.join(tree,'third_party/node-core/node-core.js'),'utf8');
  const factory=Function(code+';return {values:_createNodeValuesPlatform,install:_installNodeProcessExceptions};')();
  const values=factory.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
  const before=['internalBinding','primordials'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  let binding;
  try{binding=require('internal/test/binding').internalBinding;}
  finally{for(const[name,descriptor]of before){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
  const toggle=binding('util').shouldAbortOnUncaughtToggle;
  assert(toggle instanceof Uint32Array);assert.equal(toggle.length,1);
  const uncaught=require('internal/async_hooks');
  for(const name of ['executionAsyncId','clearDefaultTriggerAsyncId','clearAsyncIdStack','hasAsyncIdStack','afterHooksExist','emitAfter','popAsyncContext'])assert.equal(typeof uncaught[name],'function',name);
  let admitted=false;
  factory.install({process,values,async:{uncaught},timers:require('node:timers'),native:{
    uncaughtExceptionCaptureToggle(){return toggle;},
    // The actual Node environment already roots this same process and looks up
    // its mutable _fatalException at fatal delivery. No fake process is used.
    setUncaughtProcess(owner){assert.equal(owner,process);admitted=true;},
  }});
  assert(admitted);
  if (!require('node:worker_threads').isMainThread) {
    // Preserve the real native Worker publication owner around the candidate
    // global handler. This is unchanged target code over actual private native
    // port/serializer/process owners, not a fabricated parent error message.
    const reference=fs.readFileSync(path.join(__dirname,'worker-reference.cjs'),'utf8');
    const metadata=JSON.parse(fs.readFileSync(path.join(__dirname,'worker-reference.json'),'utf8'));
    const digest=s=>require('node:crypto').createHash('sha256').update(s).digest('hex');
    assert.equal(digest(reference),metadata.sourceSha256);
    const body=reference.slice(metadata.start,metadata.start+metadata.length);
    assert.equal(digest(body),metadata.selectionSha256);
    const worker=binding('worker');
    const {ERROR_MESSAGE,COULD_NOT_SERIALIZE_ERROR}=require('internal/worker/io').messageTypes;
    const debug=require('internal/util/debuglog').debuglog('worker');
    process._fatalException=Function('onGlobalUncaughtException','debug','threadId','port','ERROR_MESSAGE','COULD_NOT_SERIALIZE_ERROR','kGenericUserError','require','process',body+';return workerOnGlobalUncaughtException;')(
      process._fatalException,debug,worker.threadId,worker.getEnvMessagePort(),ERROR_MESSAGE,COULD_NOT_SERIALIZE_ERROR,binding('errors').exitCodes.kGenericUserError,require,process);
  }
  return {toggle};
};
