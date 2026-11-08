"use strict";
// Actual public Buffer.from poisoning over native HTTPParser and actual parser
// factory. The native boundary makes independent bytes, as production JSAPI
// KandeloNewUint8ArrayCopy does; it does not call public Buffer.from.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {internalBinding}=require('internal/test/binding');const {HTTPParser}=internalBinding('http_parser');const {FastBuffer}=require('internal/buffer');
const typedProto=Object.getPrototypeOf(Uint8Array.prototype),getLength=Object.getOwnPropertyDescriptor(typedProto,'length').get,typedSet=typedProto.set;
assert.equal(process.version,'v26.13.0');
const root=process.env.KANDELO_REPO,ev=process.env.HTTP_BUFFER_EVIDENCE;
const rootBundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const packetText='POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc';
const intrinsicFrom=Buffer.from,descriptor=Object.getOwnPropertyDescriptor(Buffer,'from');
const packet=()=>Reflect.apply(intrinsicFrom,Buffer,[packetText]);
function poison(run,mode){let lookups=0,error;const marker=Error('mutable byte publication hook');const saved=[];const trap=()=>{lookups++;throw marker;};
 const install=(object,key)=>{saved.push([object,key,Object.getOwnPropertyDescriptor(object,key)]);Object.defineProperty(object,key,{configurable:true,get:trap});};
 if(mode==='public-from')install(Buffer,'from');else{install(Uint8Array.prototype,'valueOf');install(Uint8Array.prototype,Symbol.iterator);}
 try{run();}catch(e){error=e;}finally{for(const[object,key,desc]of saved)if(desc)Object.defineProperty(object,key,desc);else delete object[key];}return{lookups,error,marker};}
function native(mode){const p=new HTTPParser();p.initialize(HTTPParser.REQUEST,{type:'HTTPINCOMINGMESSAGE'},0,0);let body,complete=0;const input=packet();p[HTTPParser.kOnHeadersComplete]=()=>0;p[HTTPParser.kOnBody]=b=>{body=b;};p[HTTPParser.kOnMessageComplete]=()=>{complete++;};const outcome=poison(()=>p.execute(input),mode);p.close();assert.equal(outcome.error,undefined);assert.equal(outcome.lookups,0);assert.equal(complete,1);assert(Buffer.isBuffer(body));input[input.length-1]=90;assert.equal(body.toString(),'abc');body[0]=88;assert.equal(input[input.length-3],97);return{lookups:outcome.lookups,complete,independentCopy:true};}
function candidate(source,mode){let owner,done=false;const native={httpParser(op,...a){if(op==='allMethods')return internalBinding('http_parser').allMethods;if(op==='createRequest'){owner=new HTTPParser();owner.initialize(HTTPParser.REQUEST,{type:'HTTPINCOMINGMESSAGE'},0,0);return owner;}
 if(op!=='feedRequest')throw Error('Outside body-publication control: '+op);
 const[p,bytes,headers,body,complete]=a;p[HTTPParser.kOnHeadersComplete]=(major,minor,items,method,url,status,statusMessage,upgrade,keepAlive)=>headers({type:0,major,minor,headers:items,method,url,status,statusMessage,upgrade,keepAlive,request:true});
 p[HTTPParser.kOnBody]=b=>{const bytes=new Uint8Array(Reflect.apply(getLength,b,[]));Reflect.apply(typedSet,bytes,[b]);body({type:1,body:bytes});};p[HTTPParser.kOnMessageComplete]=()=>{complete({type:2,headers:[],informational:false});done=true;};p.execute(bytes);return{events:[],remainder:new Uint8Array(0),complete:done,upgrade:false,code:''};}};
 const factory=Function(rootBundle+'\n'+source+';return _createNodeHttpParser;')()({Buffer,FastBuffer,incoming:require('_http_incoming'),native});const socket=new net.Socket();let message,delivered,complete=0;
 const parser=factory.request({socket,onHeaders(m){message=m;const original=m.push;m.push=function(b){if(b!==null)delivered=b;return Reflect.apply(original,this,[b]);};},onComplete(){complete++;}});const input=packet();
 const outcome=poison(()=>parser.feed(input),mode);try{if(outcome.error){assert.equal(outcome.error,outcome.marker);assert.equal(outcome.lookups,1);assert.equal(complete,0);return{lookups:outcome.lookups,complete,independentCopy:false,error:'mutable-publication-hook'};}
 assert.equal(outcome.lookups,0);assert.equal(complete,1);assert.equal(message.complete,true);assert(Buffer.isBuffer(delivered));input[input.length-1]=90;assert.equal(delivered.toString(),'abc');delivered[0]=88;assert.equal(input[input.length-3],97);return{lookups:0,complete,independentCopy:true};}finally{owner.close();socket.destroy();}}
const rows=[];
for(const mode of ['public-from','conversion-hooks']){const expected=native(mode),before=candidate(fs.readFileSync(path.join(ev,'expanded-before.js'),'utf8'),mode),capturedFrom=candidate(fs.readFileSync(path.join(ev,'captured-from-only-attempt/expanded-after.js'),'utf8'),mode),after=candidate(fs.readFileSync(path.join(ev,'expanded-after.js'),'utf8'),mode);
 assert.deepEqual(after,expected);assert.equal(before.error,'mutable-publication-hook');if(mode==='conversion-hooks')assert.equal(capturedFrom.error,'mutable-publication-hook');
 rows.push({mode,native:expected,before,capturedFrom,after});}
const report={cases:2,subjectsPerCase:4,rows,priorOwnerMatched:0,correctedMatched:2,capturedFromConversionCaseMatched:0,newCompiles:0,productionJSAPICompiled:false,guestValidated:false};fs.writeFileSync(path.join(ev,'report-final.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
