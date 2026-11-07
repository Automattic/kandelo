'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),tty=require('node:tty');
const helper=require(process.env.TTY_OUTPUT_COMPONENT),mode=process.argv[2],report=Number(process.env.REPORT_FD);
assert.equal(process.version,'v26.13.0');
const flags=fd=>{const packet=helper.nonblocking(fd);assert.equal(packet.error,0);return packet.value;};
const set=(fd,value)=>assert.equal(helper.nonblocking(fd,value).error,0);
(async()=>{
 assert(tty.isatty(0)&&tty.isatty(1));set(0,true);assert.equal(flags(1),1);
 let owner,stream,owned;
 if(mode==='candidate'){const packet=helper.openOutput(1);assert.equal(packet.error,0);owner=packet.value;owned=helper.descriptor(owner);}
 else{stream=new tty.WriteStream(1);owned=stream._handle.fd;}
 assert(owned>2);assert.equal(flags(0),1);assert.equal(flags(1),0);assert.equal(flags(owned),0);
 const rows=[{name:'actual inherited alias isolated on reopen',stdinNonblocking:flags(0),stdoutNonblocking:flags(1),ownedNonblocking:flags(owned),ownedOutsideStdio:owned>2}];
 set(0,false);assert.equal(flags(1),0);set(0,true);assert.equal(flags(1),0);
 rows.push({name:'later input flag changes leave owned output blocking',stdinNonblocking:flags(0),stdoutNonblocking:flags(1),ownedNonblocking:flags(owned)});
 const bytes=Buffer.from('xxABCzz').subarray(2,5);
 let written;
 if(mode==='candidate'){const result=helper.writeOutput(owner,bytes);assert.equal(result.error,0);written=result.value;}
 else{await new Promise((resolve,reject)=>stream.write(bytes,error=>error?reject(error):resolve()));written=stream.bytesWritten;}
 assert.equal(written,3);rows.push({name:'actual offset view writes exact bytes',written});
 // Reuse the public number for another inode. The captured extra descriptor
 // must continue to designate the original terminal and not this new target.
 fs.closeSync(1);const replacement=fs.openSync('/dev/null','w');assert.equal(replacement,1);
 if(mode==='candidate'){const result=helper.writeOutput(owner,Buffer.from('D'));assert.equal(result.error,0);assert.equal(result.value,1);}
 else await new Promise((resolve,reject)=>stream.write(Buffer.from('D'),error=>error?reject(error):resolve()));
 rows.push({name:'owned output survives public fd close/reuse',publicReplacementStillOpen:!!fs.fstatSync(1),ownedStillTty:tty.isatty(owned)});
 if(mode==='candidate')assert.equal(helper.closeOutput(owner).error,0);
 else await new Promise(resolve=>stream._handle.close(resolve));
 assert.equal(helper.nonblocking(owned).error,-9);fs.fstatSync(1);
 rows.push({name:'teardown closes only extra owner',ownedClosed:true,publicReplacementStillOpen:true});
 if(mode==='candidate'){assert.equal(helper.closeOutput(owner).error,0);const result=helper.writeOutput(owner,Buffer.from('x'));assert.equal(result.error,-9);assert.equal(result.value,0);}
 else assert.throws(()=>fs.writeSync(owned,Buffer.from('x')),{code:'EBADF'});
 rows.push({name:'closed owner reports actual EBADF',error:'EBADF',zeroTransferred:true});
 const invalid=helper.openOutput(-1);assert.equal(invalid.error,-9);
 const nonterminal=helper.openOutput(1);assert.notEqual(nonterminal.error,0);assert.equal(nonterminal.value,undefined);
 rows.push({name:'invalid/nonterminal never publish an owner',invalidError:'EBADF',nonterminalRejected:true});
 fs.writeSync(report,JSON.stringify({mode,rows})+'\n');
 // Retain the slave until the controller acknowledges the observed bytes.
 set(0,false);fs.readSync(0,Buffer.alloc(1),0,1,null);
})().catch(error=>{fs.writeSync(report,JSON.stringify({fatal:{name:error.name,message:error.message,stack:error.stack}})+'\n');process.exitCode=1;});
