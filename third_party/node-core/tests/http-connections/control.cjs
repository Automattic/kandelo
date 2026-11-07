"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const {internalBinding}=require('internal/test/binding');const {HTTPParser,ConnectionsList}=internalBinding('http_parser');
assert.equal(process.version,'v26.13.0');
const F=(id,text)=>`feed ${id} ${Buffer.from(text).toString('hex')}`;
const cases=[
 ['initial active-idle overlap',['new 1','new 2','all','idle','active','expired 0 0','active']],
 ['message begin active ordering',['new 1','new 2',F(1,'G'),'all','idle','active']],
 ['completed connection idle',['new 1','new 2',F(1,'GET / HTTP/1.1\r\nHost: x\r\n\r\n'),'all','idle','active']],
 ['incomplete headers expire',['new 1',F(1,'GET / HTTP/1.1\r\nHost: '),'sleep 30','expired 1 0','all','idle','active','expired 1 0']],
 ['completed headers exclude header budget',['new 1',F(1,'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\na'),'sleep 30','expired 1 0','all','active','expired 0 1','all','idle','active']],
 ['swapped budgets apply header cutoff',['new 1',F(1,'G'),'sleep 30','expired 1000000 1','all','active']],
 ['expired connection never sent data remains idle',['new 1','sleep 30','expired 1 0','idle','all','active']],
 ['explicit removal and destruction',['new 1','new 2','remove 1','all','idle','active','close 2','all','active']],
 ['remove during genuine synchronous callback',['new 1','removeAtHeaders 1',F(1,'POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'),'all','idle','active']],
 ['large deadlines avoid unsigned underflow',['new 1','expired 4294967295 4294967295','all','active']],
];
function native(actions){const list=new ConnectionsList(),owners=new Map(),labels=new Map(),output=[];let removeAtHeaders=new Set();try{
 for(const action of actions){const[op,a,b]=action.split(' '),id=+a;
  if(op==='new'){const p=new HTTPParser();p.initialize(HTTPParser.REQUEST,{type:'HTTPINCOMINGMESSAGE'},0,0,list);p[HTTPParser.kOnHeaders]=()=>{};p[HTTPParser.kOnHeadersComplete]=()=>{if(removeAtHeaders.has(id))p.remove();return 0;};p[HTTPParser.kOnBody]=()=>{};p[HTTPParser.kOnMessageComplete]=()=>{};owners.set(id,p);labels.set(p,id);}
  else if(op==='feed'){const result=owners.get(id).execute(Buffer.from(b,'hex'));if(result instanceof Error)throw result;}
  else if(op==='remove')owners.get(id).remove();else if(op==='removeAtHeaders')removeAtHeaders.add(id);
  else if(op==='close'){owners.get(id).close();owners.delete(id);}
  else if(op==='sleep')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,id);
  else{const values=op==='expired'?list.expired(id,+b):list[op]();output.push(values.map(p=>{assert(labels.has(p));return labels.get(p);}));}
 }
 }finally{for(const p of owners.values())p.close();}return output;}
const rows=[];for(const[name,actions]of cases){const expected=native(actions),run=cp.spawnSync(process.env.HTTP_CONNECTIONS_OWNER,[],{input:actions.join('\n')+'\n',encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);const actual=run.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(actual,expected,name);rows.push({name,status:'pass',native:expected,candidate:actual});}
const own=cp.spawnSync(process.env.HTTP_CONNECTIONS_OWNER,[],{input:'new 1\nretained\n',encoding:'utf8',timeout:5000});assert.equal(own.status,0,own.stderr);assert.equal(own.stdout.trim(),'true');
const result={differentialGroups:rows,portableSharedOwnership:true,productionJSAPICompiled:false,guestConformance:false};fs.writeFileSync(process.env.HTTP_CONNECTIONS_REPORT,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
