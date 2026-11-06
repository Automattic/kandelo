'use strict';
// Actual candidate trust selections and portable OpenSSL owner, with real TCP
// peers. NAPI is a fixture boundary, never production SpiderMonkey proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),tls=require('node:tls'),util=require('node:util');
const addon=require(process.env.TLS_TRUST_ADDON),keys=process.env.TLS_TRUST_KEYS,out=process.env.TLS_TRUST_OUT;
assert.equal(process.version,'v26.13.0');assert.match(addon.context('version'),/^OpenSSL 3\.3\.2 /);
const bundle=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factory=Function(bundle+';return _createNodeTlsContextTrust;')();
const{values}=require('./node-buffer-pool.cjs').create();
const candidate=factory({values,types:util.types,native:{tlsContext:addon.context}});
const rootCA=fs.readFileSync(path.join(keys,'ca1-cert.pem'));
function error(fn){try{fn();return null;}catch(e){return{name:e.name,code:e.code,message:e.message};}}
function defaultStoreCases(){
 const rows=[];
 for(const ca of [undefined,null,false,0,NaN,'',[],Buffer.alloc(0),new Uint8Array(),new DataView(new ArrayBuffer(0))]){
  const context=candidate.create({ca});const info=addon.context('info',context);
  assert.equal(info.storeObjects,ca?0:1,'actual default file versus explicit empty custom store');
  addon.context('close',context);rows.push({type:typeof ca,defaultBranch:!ca,info});
 }
 return rows;
}
function validation(){
 const rows=[];const cases=[true,1,{},new ArrayBuffer(2),new SharedArrayBuffer(2),Symbol('ca'),()=>{},[undefined],[null],[1],[Buffer.alloc(0),{}]];
 for(const ca of cases){const actual=error(()=>candidate.create({ca})),expected=error(()=>tls.createSecureContext({ca}));assert.deepEqual(actual,expected);assert(actual);rows.push(actual);}
 return rows;
}
function view(make,width=1){const size=Math.ceil(rootCA.length/width)*width;const bytes=Buffer.alloc(size+16,10);rootCA.copy(bytes,8);return make(bytes.buffer,bytes.byteOffset+8,size);}
const specs={
 pemString:()=>({ca:rootCA.toString()}),pemBuffer:()=>({ca:Buffer.from(rootCA)}),
 array:()=>({ca:[Buffer.from(rootCA)]}),mixedBundle:()=>({ca:['not a certificate',Buffer.from(rootCA),'']}),
 duplicates:()=>({ca:[rootCA,rootCA]}),concatenated:()=>({ca:Buffer.concat([rootCA,rootCA])}),
 noPEM:()=>({ca:'not a certificate'}),emptyArray:()=>({ca:[]}),emptyBuffer:()=>({ca:Buffer.alloc(0)}),
 emptyString:()=>({ca:''}),missing:()=>({}),nullCA:()=>({ca:null}),
 dataView:()=>({ca:view((b,o,n)=>new DataView(b,o,n))}),
 typedHalf:()=>({ca:view((b,o,n)=>new Float16Array(b,o,n/2),2)}),
 detachedTyped:()=>{const buffer=new ArrayBuffer(16);const ca=new Uint8Array(buffer);structuredClone(buffer,{transfer:[buffer]});return{ca};},
 detachedDataView:()=>{const buffer=new ArrayBuffer(16);const ca=new DataView(buffer);structuredClone(buffer,{transfer:[buffer]});return{ca};},
 outOfBoundsTyped:()=>{const buffer=new ArrayBuffer(16,{maxByteLength:32});const ca=new Uint8Array(buffer,8,8);buffer.resize(0);return{ca};},
 outOfBoundsDataView:()=>{const buffer=new ArrayBuffer(16,{maxByteLength:32});const ca=new DataView(buffer,8,8);buffer.resize(0);return{ca};},
 typed16:()=>({ca:view((b,o,n)=>new Uint16Array(b,o,n/2),2)}),
 typed64:()=>({ca:view((b,o,n)=>new BigUint64Array(b,o,n/8),8)}),
 offsetBuffer:()=>{const b=Buffer.concat([Buffer.from('prefix'),rootCA,Buffer.from('suffix')]);return{ca:b.subarray(6,6+rootCA.length)};},
 sharedView:()=>{const b=new SharedArrayBuffer(rootCA.length+20);new Uint8Array(b,7,rootCA.length).set(rootCA);return{ca:new Uint8Array(b,7,rootCA.length)};},
 sparseArray:()=>{const a=[];a[2]=rootCA;return{ca:a};},
 nulBefore:()=>({ca:Buffer.concat([Buffer.from([0]),rootCA])}),
 nulAfter:()=>({ca:Buffer.concat([rootCA,Buffer.from([0])])}),
 trustedAux:()=>({ca:rootCA.toString().replace(/BEGIN CERTIFICATE/,'BEGIN TRUSTED CERTIFICATE').replace(/END CERTIFICATE/,'END TRUSTED CERTIFICATE')}),
 poisonedViewGetters:()=>{const ca=view((b,o,n)=>new DataView(b,o,n));for(const name of['buffer','byteOffset','byteLength'])Object.defineProperty(ca,name,{get(){throw Error('public getter '+name)}});return{ca};},
 partialAnchor:()=>({ca:fs.readFileSync(path.join(keys,'ca3-cert.pem')),allowPartialTrustChain:true,agent:6,caOnly:true}),
 incompleteAnchor:()=>({ca:fs.readFileSync(path.join(keys,'ca3-cert.pem')),agent:6,caOnly:true}),
 rejectUntrusted:()=>({ca:[],rejectUnauthorized:true}),
 rejectIncompleteAnchor:()=>({ca:fs.readFileSync(path.join(keys,'ca3-cert.pem')),agent:6,caOnly:true,rejectUnauthorized:true}),
 rejectMissingIssuer:()=>({ca:[],agent:2,caOnly:true,rejectUnauthorized:true}),
};
async function observe(spec,mode){
 const sockets=new Set();const options=spec();const agent=options.agent||1;delete options.agent;const caOnly=options.caOnly===true;delete options.caOnly;const hostname=caOnly?'':'agent'+agent;
 const server=tls.createServer({key:fs.readFileSync(path.join(keys,`agent${agent}-key.pem`)),cert:fs.readFileSync(path.join(keys,`agent${agent}-cert.pem`)),ca:agent===6?fs.readFileSync(path.join(keys,'ca3-cert.pem')):undefined},socket=>socket.resume());
 server.on('tlsClientError',()=>{});server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const reject=options.rejectUnauthorized===true;let socket,context;
 try{
  if(mode==='candidate'){
   context=candidate.create(options);const promise=addon.connect(context,server.address().port,reject,hostname);
   const result=await promise;return{connected:result.connected,authorized:result.authorized,code:result.code,protocol:result.connected?result.protocol:null,errorMessage:result.connected?null:result.verifyMessage};
  }
  context=tls.createSecureContext(options);
  return await new Promise((resolve,rejectObservation)=>{
   socket=tls.connect({host:'127.0.0.1',port:server.address().port,servername:hostname,checkServerIdentity:caOnly?()=>undefined:tls.checkServerIdentity,secureContext:context,rejectUnauthorized:reject});
   const timer=setTimeout(()=>{socket.destroy();rejectObservation(Error('native TLS observation deadline'));},5000);timer.unref();
   let result;socket.once('secureConnect',()=>{result={connected:true,authorized:socket.authorized,code:socket.authorizationError||'OK',protocol:socket.getProtocol(),errorMessage:null};socket.end();});
   socket.on('error',e=>{result={connected:false,authorized:socket.authorized,code:e.code,protocol:null,errorMessage:e.message};});
   socket.once('close',()=>{clearTimeout(timer);result?resolve(result):rejectObservation(Error('native TLS close without result'));});
  });
 }finally{
  socket?.destroy();if(mode==='candidate'&&context)addon.context('close',context);
  for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
 }
}
async function capturedMaterialAndNativeReference(){
 const bytes=Buffer.from(rootCA),context=candidate.create({ca:bytes});bytes.fill(0);
 const sockets=new Set();const server=tls.createServer({key:fs.readFileSync(path.join(keys,'agent1-key.pem')),cert:fs.readFileSync(path.join(keys,'agent1-cert.pem'))},s=>s.resume());
 server.on('tlsClientError',()=>{});server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const promise=addon.connect(context,server.address().port,true,'agent1');addon.context('close',context);
  const result=await promise;assert.equal(result.connected,true);assert.equal(result.authorized,true);
  return{actualCapturedCA:true,ownerReferenceReleasedBeforeWorkCompletion:true,handshake:result};
 }finally{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}
}
(async()=>{
 const report={scope:'Pinned candidate CA source and actual portable OpenSSL3.3.2 context via truthful NAPI fixture, real local TCP/TLS; no production JSAPI/guest/four-host evidence',backend:addon.context('version'),defaults:defaultStoreCases(),validation:validation(),cases:[],ownership:await capturedMaterialAndNativeReference()};
 for(const[name,spec]of Object.entries(specs)){
  const row={name};report.cases.push(row);
  try{row.candidate=await observe(spec,'candidate');row.native=await observe(spec,'native');assert.deepEqual(row.candidate,row.native);row.status='pass';}
  catch(e){row.status='nonpass';row.error=e.stack;}
 }
 report.pass=report.cases.filter(r=>r.status==='pass').length;report.nonpass=report.cases.length-report.pass;
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({wireCases:report.cases.length,pass:report.pass,nonpass:report.nonpass,defaultBranchCases:report.defaults.length,validationCases:report.validation.length,ownership:report.ownership}));
 process.exitCode=report.nonpass?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
