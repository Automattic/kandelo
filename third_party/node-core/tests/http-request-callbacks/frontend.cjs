"use strict";
// Actual candidate factory and curated forwarder over explicit native Node
// HTTPParser, IncomingMessage/Socket/Buffer dependencies; not guest JSAPI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {internalBinding}=require('internal/test/binding');const {HTTPParser,ConnectionsList}=internalBinding('http_parser');
const root=process.env.KANDELO_REPO,ev=process.env.HTTP_CALLBACK_EVIDENCE;assert.equal(process.version,'v26.13.0');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const adapter=fs.readFileSync(path.join(root,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
const begin=adapter.indexOf('    const _nodeNative = {'),end=adapter.indexOf('    const entryPath =',begin),asyncBegin=adapter.indexOf('    const asyncApply = Reflect.apply, asyncAssign = Object.assign;'),asyncEnd=adapter.indexOf('    // The deadline heap owns',asyncBegin);assert(begin>=0&&end>begin&&asyncBegin>=0&&asyncEnd>asyncBegin);
function subject(source){const states=new Map();const boundary={httpParser(op,...a){
 if(op==='allMethods')return HTTPParser.allMethods??internalBinding('http_parser').allMethods;
 if(op==='createRequest'){const p=new HTTPParser();p.initialize(HTTPParser.REQUEST,{type:'HTTPINCOMINGMESSAGE'},0,0,a[4]);states.set(p,{complete:false,events:[],trailers:[]});return p;}
 if(op==='remove'){Reflect.apply(HTTPParser.prototype.remove,a[0],[]);return;}
 if(!['feedRequest','feedRequestHeaders','finishRequest','finish'].includes(op))throw Error('Unadmitted fixture operation '+op);
 const[p,bytes,headers,body,complete]=a,state=states.get(p);state.events=[];
 if(op!=='finish'){
  p[HTTPParser.kOnHeaders]=items=>{state.trailers.push(...items);};
  p[HTTPParser.kOnHeadersComplete]=(major,minor,items,method,url,status,statusMessage,upgrade,keepAlive)=>headers({type:0,major,minor,headers:items,method,url,status,statusMessage,upgrade,keepAlive,request:true});
  p[HTTPParser.kOnBody]=b=>{const event={type:1,body:Buffer.from(b)};if(body)body(event);else state.events.push(event);};
  p[HTTPParser.kOnMessageComplete]=()=>{const event={type:2,headers:state.trailers,informational:false};state.trailers=[];if(complete)complete(event);else state.events.push(event);state.complete=true;};
 }
 const result=op.startsWith('finish')?p.finish():p.execute(bytes);const error=result instanceof Error?result:null;
 return{events:state.events,complete:state.complete,upgrade:false,remainder:Buffer.alloc(0),consumed:typeof result==='number'?result:0,code:error?.code??'',reason:error?.reason??''};
 }};
 const native=Function('native','workerEnvironment',adapter.slice(asyncBegin,asyncEnd)+adapter.slice(begin,end)+';return _nodeNative;')(boundary,null);
 return{factory:Function(bundle+'\n'+source+';return _createNodeHttpParser;')()({Buffer,FastBuffer:require('internal/buffer').FastBuffer,incoming:require('_http_incoming'),native}),close(){for(const p of states.keys())p.close();}};
}
const packet=Buffer.from('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-End: yes\r\n\r\n');
const rows=[];
for(const name of ['before','after']){const api=subject(fs.readFileSync(path.join(ev,name==='before'?'expanded-before.js':'expanded-adapter.js'),'utf8'));try{
 for(const mode of ['normal','throw-body','throw-complete','remove-body','fragmented']){const list=new ConnectionsList(),socket=new net.Socket(),marker=Error('original '+mode),calls=[];let inFeed=false,message,failed=false,errors=0;
 const parser=api.factory.request({socket,connections:list,onHeaders(m){message=m;const push=m.push;m.push=function(b){calls.push([b===null?'complete':'body',list.active().length,list.idle().length,inFeed]);if(b!==null&&mode==='throw-body'||b===null&&mode==='throw-complete')throw marker;if(b!==null&&mode==='remove-body')parser.remove();return Reflect.apply(push,this,[b]);};},onComplete(){calls.push(['onComplete',list.active().length,list.idle().length,inFeed]);},onError(){errors++;}});
 try{for(const bytes of mode==='fragmented'?[packet.subarray(0,60),packet.subarray(60)]:[packet]){inFeed=true;try{parser.feed(bytes);}catch(error){assert.equal(error,marker);failed=true;break;}finally{inFeed=false;}}const expectedFailed=mode.startsWith('throw');assert.equal(failed,expectedFailed);assert.equal(errors,0);let match=true;
 const firstBody=calls.find(row=>row[0]==='body');assert(firstBody);if(firstBody[1]!==1||firstBody[2]!==0)match=false;
 if(mode==='throw-body'||mode==='remove-body'){if(calls.some(row=>row[0]==='complete'||row[0]==='onComplete'))match=false;}
 else{const done=calls.find(row=>row[0]==='complete');assert(done);if(done[1]!==0||done[2]!==1)match=false;}
 if(mode==='normal'||mode==='fragmented'){assert.equal(message.complete,true);assert.deepEqual(message.trailers,{'x-end':'yes'});assert.equal(calls.filter(row=>row[0]==='onComplete').length,1);let body='';for(let chunk;(chunk=message.read())!==null;)body+=chunk.toString();assert.equal(body,'abc');}
 rows.push({subject:name,mode,calls,match,failed});fs.writeFileSync(path.join(ev,'frontend-r4-progress.json'),JSON.stringify(rows,null,2)+'\n');if(name==='after')assert.equal(match,true,JSON.stringify(rows.at(-1)));
 }finally{socket.destroy();}}
 }finally{api.close();}}
fs.writeFileSync(path.join(ev,'frontend-report.json'),JSON.stringify({rows,afterPassed:rows.filter(x=>x.subject==='after'&&x.match).length,beforeMatched:rows.filter(x=>x.subject==='before'&&x.match).length,productionJSAPICompiled:false},null,2)+'\n');console.log(JSON.stringify({groups:rows.length,afterPassed:rows.filter(x=>x.subject==='after'&&x.match).length,beforeMatched:rows.filter(x=>x.subject==='before'&&x.match).length}));
