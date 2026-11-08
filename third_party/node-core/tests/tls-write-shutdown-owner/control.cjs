const assert=require('node:assert/strict'),path=require('node:path');assert.equal(process.version,'v26.13.0');const addon=require(path.resolve(process.argv[2])),keys=path.resolve(process.cwd(),'.context/nodejs-lts-cache-v2/node-v26.13.0/test/fixtures/keys'),rows=[];
for(const version of [0x303,0x304])for(const mode of ['normal-clean','cancel-clean','fatal']){
 let value;try{value=addon.run(version,path.join(keys,'agent1-key.pem'),path.join(keys,'agent1-cert.pem'),mode);}catch(error){rows.push({version,mode,failed:true,error:{name:error.name,message:error.message}});continue;}assert.equal(value.passed,true);assert.equal(value.actualEarlierBytesMatch,true);
 if(mode==='fatal'){assert.equal(value.fatalRefusedBeforeShutdown,true);assert.equal(value.attempted,false);}else{assert.equal(value.actualAlertReceipt,true);assert.equal(value.queuePreserved,true);if(mode==='cancel-clean')assert.equal(value.canceledNotFlushed,true);}
 rows.push(value);
}
if(rows.some(x=>x.failed))process.exitCode=1;console.log(JSON.stringify({protocolSubjects:rows.length,failed:rows.filter(x=>x.failed).length,rows,scope:'Actual shared production TLS ShutdownOperation/socket/BIO owners against native OpenSSL on loopback. Callback ticket is explicit portable fixture dependency; no guest ShutdownWrap/JSAPI/AsyncWrap/frame/fourhost or public_final proof.'}));
