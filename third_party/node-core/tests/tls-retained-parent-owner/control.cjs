'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.version,'v26.13.0');
const mode=process.argv[2];assert(['orderly','abrupt','reentry'].includes(mode));
const source=path.resolve(process.argv[4]);
const key=name=>fs.readFileSync(path.join(source,'test/fixtures/keys',name),'utf8');
const result=require(path.resolve(process.argv[3])).run(key('agent1-cert.pem'),key('agent1-key.pem'),mode);
assert.equal(result.contextFreeCallbacks,1);assert.equal(result.sslFreeCallbacks,1);assert.equal(result.plaintextBytes,24);
const required=[
 'actual empty TCP birth','actual retained-parent attachment before connect',
 'real SSL birth before descriptor/connect','real initial parent ref',
 'TLS unref delegates actual parent','TLS ref delegates actual parent',
 'actual TCP owner adoption after SSL birth','retained parent refuses descriptor transfer',
 'exclusive TLS transport refuses raw TCP reads','exclusive TLS transport refuses raw TCP writes without consuming bytes',
 'SSL binds actual live retained parent descriptor','no second SSL fd binding',
 'real native TLS request holds parent close barrier','real handshake/generation admission',
 'real plaintext identity/count','actual plaintext count','actual plaintext bytes',
 'failed publication retains exact allocation','acknowledge actual read',
 'stale acknowledgement cannot retire new read','closed SSL authority retired',
 'parent close waits for actual TLS request retirement',
 'actual TLS request retirement releases parent close barrier','terminal parent attachment cleared',
 'actual context/SSL freed exactly once','original fd closed by actual parent',
 'same fd distinct authority','old close cannot close reused descriptor',
 'actual parent close invalidates later SSL','old SSL/context no second free',
 'actual preconnect cancellation attachment','preconnect parent close releases real SSL without creating fd',
 ...(mode==='reentry'?['parent close invalidates SSL but in-flight material survives','retained bytes survive close/reentry']:['SSL release preserves actual parent fd until native close']),
 ...({orderly:['actual clean EOF'],abrupt:['abrupt TLS termination is an actual error, never clean EOF'],reentry:['real second delivery']}[mode]),
];
for(const name of required)assert(result.completedChecks.includes(name),name);
assert.equal(result.terminalRead,{orderly:'eof',abrupt:'error',reentry:'retained-data'}[mode]);
console.log(JSON.stringify({passed:true,mode,requiredSemanticChecks:required.length,scope:'Actual portable retained TCP/SSL/ref/request/bytes/close owner only; native JSAPI/AsyncWrap/Socket/guest/four-host unexecuted',result}));
