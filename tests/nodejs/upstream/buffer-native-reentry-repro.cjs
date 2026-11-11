// Standalone native Node package reproduction; no Kandelo code or APIs.
const {Buffer}=require('node:buffer');
const rows=[];
for(let i=0;i<8;i++){
 const value=Buffer.alloc(64,0x61);let read=0;
 try{
  const result=value.utf8Slice({valueOf(){read++;structuredClone(value.buffer,{transfer:[value.buffer]});gc();return 0}},4);
  rows.push({result,reads:read,detached:value.buffer.detached,safe:result==='aaaa'});
 }catch(error){rows.push({error:{name:error.name,message:error.message},reads:read,safe:true})}
}
const reproduced=rows.some(row=>!row.safe);console.log(JSON.stringify({reproduced,rows}));
