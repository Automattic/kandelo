'use strict';
// Candidate portable C++/llhttp owner versus actual native HTTPParser; candidate
// request JS factory over an explicit pinned native parser dependency. Neither
// boundary executes production JSAPI/GC/backing/async/fatal paths.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {internalBinding}=require('internal/test/binding'),binding=internalBinding('http_parser'),{HTTPParser}=binding;
const Incoming=require('_http_incoming'),net=require('node:net');assert.equal(process.version,'v26.13.0');
const core=path.resolve(__dirname,'../..');let groups=0;
function create(){
 const parser=new HTTPParser();parser.initialize(HTTPParser.REQUEST,{type:'HTTPINCOMINGMESSAGE'},0,0);let complete=false,upgrade=false,current;
 parser[HTTPParser.kOnHeaders]=()=>{throw Error('These focused fixtures do not overflow native field slots');};
 parser[HTTPParser.kOnBody]=bytes=>{const event={type:1,body:Buffer.from(bytes)};if(current.bodyCallback)current.bodyCallback(event);else current.events.push(event);};
 parser[HTTPParser.kOnMessageComplete]=()=>{const event={type:2,headers:[],informational:false};if(current.completeCallback)current.completeCallback(event);else current.events.push(event);complete=true;};
 function feed(bytes,callback,bodyCallback,completeCallback){
  let headers=0,inFeed=false,url='',code='';current={events:[],consumed:0,bodyCallback,completeCallback};
  parser[HTTPParser.kOnHeadersComplete]=function(major,minor,items,method,target,status,statusMessage,isUpgrade,keepAlive){
   headers++;inFeed=true;url=target;upgrade=!!isUpgrade;
   return callback({major,minor,headers:items,method,url:target,status,statusMessage,upgrade,keepAlive,request:true});
  };
  for(let at=0;at<bytes.length&&!complete&&!code&&!upgrade;at++){
   const result=parser.execute(bytes.subarray(at,at+1));
   if(typeof result==='number')current.consumed+=result;
   else{current.consumed+=result.bytesParsed;code=result.code;}
  }
  return{...current,complete:complete||upgrade,upgrade,headers,inFeed,url,code,remainder:complete||upgrade?bytes.subarray(current.consumed):Buffer.alloc(0)};
 }
 function finish(callback,bodyCallback,completeCallback){
  current={events:[],consumed:0,bodyCallback,completeCallback};
  const result=parser.finish();const error=result instanceof Error?result:null;
  return{...current,complete,upgrade,code:error?.code||'',reason:error?.reason||'',remainder:Buffer.alloc(0)};
 }
 return{parser,feed,finish,close(){parser.close();}};
}
const cases=[
 ['ordinary',0,0,'POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc'],
 ['original allocation mutation',0,1,'POST /mutate HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc'],
 ['skip body before native consumption',1,0,'POST /skip HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc'],
 ['actual upgrade head',2,0,'GET /upgrade HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nHEAD'],
 ['header syntax failure stays native',0,0,'GET /bad HTTP/1.1\r\nBad Name: x\r\n\r\n'],
 ['empty request',0,0,'GET /empty HTTP/1.1\r\nHost: localhost\r\n\r\n'],
 ...[NaN,Infinity,-Infinity,4294967297,2**63].map(decision=>['pinned integer conversion '+String(decision),decision,0,'POST /integer HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nabc']),
];
const rows=[];
for(const[name,decision,mode,text]of cases){
 const raw=Buffer.from(text),native=create();let expected;
 try{expected=native.feed(raw,event=>{if(mode===1)raw[raw.indexOf('\r\n\r\n')+4]=90;return decision;});}finally{native.close();}
 const input=Buffer.from(text),result=spawnSync(process.env.HTTP_HEADERS_OWNER,[String(decision),String(mode),input.toString('hex')],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);const actual=JSON.parse(result.stdout);
 const canonical={consumed:expected.consumed,complete:expected.complete,upgrade:expected.upgrade,headers:expected.headers,inFeed:expected.inFeed,deferredHeaders:0,reentryBlocked:false,url:expected.url,body:Buffer.concat(expected.events.filter(event=>event.type===1).map(event=>event.body)).toString('hex'),remainder:expected.remainder.toString('hex'),code:expected.code};
 assert.deepEqual(actual,canonical,name);rows.push({name,status:'pass'});groups++;
}
{
 const text=cases[0][3];const result=spawnSync(process.env.HTTP_HEADERS_OWNER,['0','2',Buffer.from(text).toString('hex')],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);const actual=JSON.parse(result.stdout);assert.equal(actual.reentryBlocked,true);assert.equal(actual.body,Buffer.from('abc').toString('hex'));groups++;
}
const bundle=fs.readFileSync(path.join(core,'node-core.js'),'utf8');const factory=Function(bundle+';return _createNodeHttpParser;')();const created=[];const nativeRequests=new WeakMap();
const boundary={httpParser(operation,...args){
 if(operation==='allMethods')return binding.allMethods;
 if(operation==='createRequest'){const owner=create();created.push(owner);nativeRequests.set(owner.parser,owner);return owner.parser;}
 if(operation==='feedRequestHeaders'||operation==='feedRequest'){const[owner,bytes,...callbacks]=args;return nativeRequests.get(owner).feed(bytes,...callbacks);}
 if(operation==='finishRequest'){const[owner,_bytes,...callbacks]=args;return nativeRequests.get(owner).finish(...callbacks);}
 throw Error('Outside focused native request boundary: '+operation);
}};
const adapter=fs.readFileSync(path.resolve(core,'../../packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const begin=adapter.indexOf('    const _nodeNative = {'),end=adapter.indexOf('    const entryPath =',begin);assert(begin>=0&&end>begin);
const asyncBegin=adapter.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;'),asyncEnd=adapter.indexOf('    // The deadline heap owns',asyncBegin);assert(asyncBegin>=0&&asyncEnd>asyncBegin);
const routed=Function('native','workerEnvironment',adapter.slice(asyncBegin,asyncEnd)+adapter.slice(begin,end)+';return _nodeNative;')(boundary,null);
const request=factory({Buffer,FastBuffer:require('internal/buffer').FastBuffer,incoming:Incoming,native:routed}).request;
try{
 for(const decision of [0,1]){
  const raw=Buffer.from(cases[0][3]),socket=new net.Socket();let headers=0,complete=0;
  const parser=request({socket,onHeaders(message){headers++;assert.equal(message.method,'POST');assert.equal(message.url,'/body');assert.equal(message.headers.host,'localhost');raw[raw.indexOf('\r\n\r\n')+4]=90;return decision;},onComplete(){complete++;}});
  parser.feed(raw);assert.equal(headers,1);assert.equal(complete,1);assert.equal(parser.completed,true);assert.equal(parser.message.complete,true);const pieces=[];for(let body;(body=parser.message.read())!==null;)pieces.push(body);assert.equal(pieces.length?Buffer.concat(pieces).toString():null,decision===1?null:'Zbc');if(decision===1)assert.equal(parser.getRemainder().toString(),'Zbc');socket.destroy();groups++;
 }
 {
  const marker=Error('original onHeaders failure'),socket=new net.Socket();let errors=0;
  const parser=request({socket,onHeaders(){throw marker;},onError(){errors++;}});assert.throws(()=>parser.feed(Buffer.from(cases[0][3])),error=>error===marker);assert.equal(errors,0);socket.destroy();groups++;
 }
 {
  const marker=Error('original integer coercion failure'),socket=new net.Socket();let errors=0;
  const parser=request({socket,onHeaders(){return{valueOf(){throw marker;}};},onError(){errors++;}});assert.throws(()=>parser.feed(Buffer.from(cases[0][3])),error=>error===marker);assert.equal(errors,0);socket.destroy();groups++;
 }
 { // Real request EOF validation through the new private finish protocol.
  const socket=new net.Socket();let failure;
  const parser=request({socket,onError(error){failure=error;}});
  try{parser.feed(Buffer.from('POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\na'));parser.end();assert.equal(failure.code,'HPE_INVALID_EOF_STATE');assert.equal(parser.message.complete,false);groups++;}finally{socket.destroy();}
 }
}finally{for(const owner of created)owner.close();}
const report={groups,portableNativeDifferential:rows,actualOriginalInputMutation:true,requestFactoryExecuted:true,productionForwarderExecuted:true,newAsyncResourceShadows:0,productionJSAPICompiled:false,scope:'Actual portable llhttp headers decision and candidate JS request consumer over native HTTPParser/IncomingMessage dependencies; no guest/fullServer/GC/engine backing/async/fatal/ConnectionsList conformance'};
fs.writeFileSync(process.env.HTTP_HEADERS_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
