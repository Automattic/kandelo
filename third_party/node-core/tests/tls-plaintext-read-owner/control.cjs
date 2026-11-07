'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.version,'v26.13.0');
const mode=process.argv[2];assert(['orderly','abrupt','reentry'].includes(mode));
const source=path.resolve(process.argv[4]);
const key=name=>fs.readFileSync(path.join(source,'test/fixtures/keys',name),'utf8');
const result=require(path.resolve(process.argv[3])).run(key('agent1-cert.pem'),key('agent1-key.pem'),mode);
assert.equal(result.contextFreeCallbacks,1);assert.equal(result.sslFreeCallbacks,1);
assert.equal(result.plaintextBytes,24);
// Retry counts vary with actual TLS scheduling. Require the completed semantic
// checks themselves; a busy retry loop cannot substitute for any of them.
const required = [
 'active read refuses transfer', 'descriptor commit', 'TLS adopts original lease',
 'source retirement cannot close recipient', 'real handshake/generation admission',
 'real plaintext identity/count', 'real read reservation',
 'control-only/no-data is not plaintext', 'actual encrypted TCP readiness',
 'encrypted readiness is not buffered plaintext', 'stopped read does not consume',
 'resume preserves actual ticket', 'actual plaintext count', 'actual plaintext bytes',
 'complete material retained through stop/restart', 'actual completed material is ready',
 'failed publication retains exact allocation', 'retry same result',
 'published material retained until acknowledgement', 'acknowledge actual read',
 'stale acknowledgement cannot retire new read', 'closed authority retired',
 'actual context/SSL freed exactly once', 'original fd closed',
 'same fd distinct authority', 'old close cannot close reused descriptor',
 'old SSL/context no second free',
 ...({
  orderly: ['real peer close_notify', 'actual clean EOF', 'EOF publication',
   'EOF acknowledgement', 'actual cached EOF requires no extra SSL read'],
  abrupt: ['abrupt TLS termination is an actual error, never clean EOF'],
  reentry: ['second real plaintext write', 'real second delivery',
   'close detaches SSL but in-flight material survives',
   'retry material after close without SSL replay', 'retained bytes survive close/reentry'],
 }[mode]),
];
assert(Array.isArray(result.completedChecks));
for (const check of required) assert(result.completedChecks.includes(check), check);
assert.equal(result.terminalRead,{orderly:'eof',abrupt:'error',reentry:'retained-data'}[mode]);
console.log(JSON.stringify({passed:true,mode,scope:'Real portable plaintext read/material owner and native Node OpenSSL/TCP only; native bridge/Promise hooks/onread/AsyncWrap/guest unexecuted',result}));
