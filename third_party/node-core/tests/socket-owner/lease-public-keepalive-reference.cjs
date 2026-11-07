'use strict';
const net=require('node:net'),assert=require('node:assert/strict'),{once}=require('node:events');
assert.equal(process.versions.node,'26.13.0');let accepted;
const incoming=new Promise(resolve=>accepted=resolve),server=net.createServer(socket=>accepted(socket));
const timer=setTimeout(()=>{console.error('native keepalive reference deadline');process.exitCode=1;server.close()},2500);
server.listen(0,'127.0.0.1',async()=>{const client=net.connect(server.address().port,'127.0.0.1');client.on('error',()=>{});const [,peer]=await Promise.all([once(client,'connect'),incoming]);let coerced=false;const result=client.setKeepAlive(true,{valueOf(){coerced=true;client.destroy();return 1000}});assert(coerced);assert.equal(result,client);assert(client.destroyed);peer.destroy();server.close(()=>{clearTimeout(timer);console.log(JSON.stringify({version:process.versions.node,publicDelayCoercionBeforeHandleUse:true,returnsSocket:true}))})});
