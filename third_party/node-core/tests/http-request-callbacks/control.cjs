"use strict";
const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs');
const {internalBinding}=require('internal/test/binding');const {HTTPParser,ConnectionsList}=internalBinding('http_parser');
assert.equal(process.version,'v26.13.0');
const cases=[
 ['normal','POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'],
 ['fragmented','POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\na','bc'],
 ['trailers','POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-End: yes\r\n\r\n'],
 ['fragmented-trailers','POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-End:',' yes\r\n\r\n'],
 ['throw-body','POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'],
 ['throw-complete','POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'],
 ['remove-body','POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'],
 ['empty','GET / HTTP/1.1\r\nHost: x\r\n\r\n'],
 ['finish','POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\na'],
];
function native(mode,parts){const p=new HTTPParser(),list=new ConnectionsList(),rows=[],marker=Error('original callback'),out={rows,failed:false};let inFeed=false;
 p.initialize(HTTPParser.REQUEST,{type:'HTTPINCOMINGMESSAGE'},0,0,list);
 const log=(type,bytes)=>{rows.push([type,list.active().length,list.idle().length,inFeed,bytes?bytes.toString('hex'):'']);if(type==='body'&&mode==='remove-body')p.remove();if(type==='body'&&mode==='throw-body'||type==='complete'&&mode==='throw-complete')throw marker;};
 p[HTTPParser.kOnHeaders]=()=>{};p[HTTPParser.kOnHeadersComplete]=()=>{log('headers');return 0;};p[HTTPParser.kOnBody]=bytes=>log('body',bytes);p[HTTPParser.kOnMessageComplete]=()=>log('complete');
 try{for(const text of parts){inFeed=true;try{p.execute(Buffer.from(text));}catch(error){assert.equal(error,marker);out.failed=true;break;}finally{inFeed=false;}}if(mode==='finish'&&!out.failed){inFeed=true;p.finish();inFeed=false;}out.active=list.active().length;out.idle=list.idle().length;}finally{p.close();}return out;
}
const rows=[];let matches=0;
for(const[mode,...parts]of cases){const expected=native(mode,parts);const run=cp.spawnSync(process.env.HTTP_CALLBACK_OWNER,[mode,...parts.map(x=>Buffer.from(x).toString('hex'))],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);const actual=JSON.parse(run.stdout);let same=true;try{assert.deepEqual(actual,expected);}catch{same=false;}if(same)matches++;rows.push({mode,expected,actual,match:same});}
const report={groups:rows.length,matches,rows,productionJSAPICompiled:false,guestValidated:false};fs.writeFileSync(process.env.HTTP_CALLBACK_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({groups:rows.length,matches}));if(process.env.EXPECT_MATCH==='yes')assert.equal(matches,rows.length);
