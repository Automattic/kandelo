const net=require('node:net'),fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.version,'v26.13.0');const fd=Number(process.argv[2]),kind=process.argv[3],order=[];
const server=net.createServer(),row={kind};let originalLive;try{originalLive=fs.fstatSync(fd).mode}catch{};
server.on('error',error=>{order.push('error');row.error={name:error.name,code:error.code,syscall:error.syscall,message:error.message};row.fdAfterError=(()=>{try{fs.fstatSync(fd);return'live'}catch(e){return e.code}})();row.order=order;console.log(JSON.stringify(row));});
try{server.listen({fd},()=>{
 order.push('listening');row.address=server.address();server.close(error=>{
  assert.equal(error,undefined);order.push('close');try{fs.fstatSync(fd);row.fdAfterClose='live'}catch(e){row.fdAfterClose=e.code}
  const replacement=fs.openSync('/dev/null','r');row.replacement=replacement;server.close(()=>{try{fs.fstatSync(replacement);row.replacementAfterSecondClose='live'}catch(e){row.replacementAfterSecondClose=e.code}fs.closeSync(replacement);row.order=order;console.log(JSON.stringify(row));});
 });
});order.push('return');}catch(error){row.throw={name:error.name,code:error.code,message:error.message};row.order=order;console.log(JSON.stringify(row));}
