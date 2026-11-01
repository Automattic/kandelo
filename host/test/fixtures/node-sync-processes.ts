/** Programs shared unchanged by the exact native oracle and all guest hosts. */
export const nodeSyncProcessCases = [
  { name: 'bytes-and-argv', source: `
const assert = require('assert'), cp = require('child_process');
const args = ["single'quote", 'double"quote', 'line\\nbreak', '$HOME; echo unwanted', '', 'space value'];
const script = "const fs=require('fs');fs.writeSync(1,Buffer.from([0,255,10,13,128,65]));fs.writeSync(2,JSON.stringify(process.argv.slice(1)));";
const r = cp.spawnSync(process.execPath, ['-e',script,...args]);
assert.ifError(r.error); assert.strictEqual(r.status,0); assert.strictEqual(r.signal,null);
assert(r.pid > 0); assert(Buffer.isBuffer(r.stdout)); assert(Buffer.isBuffer(r.stderr));
assert.strictEqual(r.stdout.toString('hex'),'00ff0a0d8041');
assert.deepStrictEqual(JSON.parse(r.stderr.toString()),args);
const absolute = cp.spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(process.argv.slice(1)))",'/not/an/entry.cjs']);
assert.ifError(absolute.error); assert.strictEqual(absolute.status,0); assert.deepStrictEqual(JSON.parse(absolute.stdout.toString()),['/not/an/entry.cjs']);
assert.strictEqual(r.output[0],null); assert.strictEqual(r.output[1],r.stdout); assert.strictEqual(r.output[2],r.stderr);
const encoded = cp.spawnSync(process.execPath,['-e',"process.stdout.write('no newline');process.stderr.write('error text')"],{encoding:'utf8'});
assert.ifError(encoded.error); assert.strictEqual(encoded.stdout,'no newline'); assert.strictEqual(encoded.stderr,'error text');
console.log('node-sync-processes-bytes-and-argv-ok');
` },
  { name: 'status-and-errors', source: `
const assert = require('assert'), cp = require('child_process');
const source = "process.stdout.write(String(process.pid));process.stderr.write('failure');process.exit(7)";
const r = cp.spawnSync(process.execPath,['-e',source],{encoding:'utf8'});
assert.ifError(r.error); assert.strictEqual(r.status,7); assert.strictEqual(r.signal,null); assert.strictEqual(Number(r.stdout),r.pid); assert.strictEqual(r.stderr,'failure');
assert.throws(() => process.kill(r.pid,0),{code:'ESRCH'});
assert.throws(() => cp.execFileSync(process.execPath,['-e',source],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),e => e.status === 7 && e.stderr === 'failure' && Number(e.stdout) === e.pid);
assert.throws(() => cp.execSync('exit 9',{stdio:'ignore'}),e => e.status === 9 && e.stdout === null && e.stderr === null);
const signal = cp.spawnSync('/bin/sh',['-c','kill -TERM $$']);
assert.ifError(signal.error); assert.strictEqual(signal.status,null); assert.strictEqual(signal.signal,'SIGTERM'); assert(signal.pid > 0);
const missing = cp.spawnSync('/missing/node-sync-executable',[],{encoding:'utf8'});
assert.strictEqual(missing.status,null); assert.strictEqual(missing.signal,null); assert.strictEqual(missing.pid,0);
assert.strictEqual(missing.output,null); assert.strictEqual(missing.stdout,undefined); assert.strictEqual(missing.stderr,undefined);
assert.strictEqual(missing.error.code,'ENOENT'); assert(missing.error.errno < 0);
assert.strictEqual(missing.error.path,'/missing/node-sync-executable'); assert.deepStrictEqual(missing.error.spawnargs,[]);
console.log('node-sync-processes-status-and-errors-ok');
` },
  { name: 'input-and-dual-output', source: `
const assert = require('assert'), cp = require('child_process');
// Each write exceeds a pipe buffer; writing all stdin first would deadlock
// against this child, which writes both outputs before reading any input.
const length = 196608;
const script = "const fs=require('fs');function write(fd,b){let p=0;while(p<b.length)p+=fs.writeSync(fd,b,p,b.length-p);}write(1,Buffer.alloc("+length+",65));write(2,Buffer.alloc("+length+",66));const b=Buffer.alloc(65536);let n;while((n=fs.readSync(0,b,0,b.length,null))>0)write(1,b.subarray(0,n));";
const input = Buffer.alloc(length,67);
const r = cp.spawnSync(process.execPath,['-e',script],{input,maxBuffer:1024*1024,timeout:30000});
assert.ifError(r.error); assert.strictEqual(r.status,0);
assert.strictEqual(r.stdout.length,length*2); assert.strictEqual(r.stderr.length,length);
assert(r.stdout.subarray(0,length).equals(Buffer.alloc(length,65))); assert(r.stdout.subarray(length).equals(input)); assert(r.stderr.equals(Buffer.alloc(length,66)));
const bytes = new Uint8Array([100,0,255,101]);
const view = new DataView(bytes.buffer,1,2);
const echo = cp.spawnSync('/bin/cat',[],{input:view});
assert.ifError(echo.error); assert.strictEqual(echo.status,0); assert.strictEqual(echo.stdout.toString('hex'),'00ff');
if (typeof SharedArrayBuffer === 'function') {
  const shared = new Uint8Array(new SharedArrayBuffer(2)); shared.set([0,255]);
  const copied = cp.spawnSync('/bin/cat',[],{input:shared});
  assert.ifError(copied.error); assert.strictEqual(copied.stdout.toString('hex'),'00ff');
}
console.log('node-sync-processes-input-and-dual-output-ok');
` },
  { name: 'cwd-env-stdio', source: `
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), path = require('path');
const root = '/tmp/node-sync-process-' + process.pid; fs.mkdirSync(root);
try {
  fs.writeFileSync(root+'/tool',"#!/bin/sh\\nprintf '%s|%s|%s' \\\"$PWD\\\" \\\"$CUSTOM\\\" \\\"$1\\\"\\n"); fs.chmodSync(root+'/tool',0o755);
  const r = cp.spawnSync('tool',["a'b"],{cwd:root,env:{PATH:'.',CUSTOM:'child',UNSET:undefined},encoding:'utf8'});
  assert.ifError(r.error); assert.strictEqual(r.status,0); assert.strictEqual(r.stdout,fs.realpathSync(root)+"|child|a'b");
  const custom = cp.spawnSync('/bin/sh',['-c','printf %s "$0"'],{argv0:'custom-argv0',encoding:'utf8'});
  assert.ifError(custom.error); assert.strictEqual(custom.stdout,'custom-argv0');
  const extra = cp.spawnSync(process.execPath,['-e',"require('fs').writeSync(3,'extra-fd')"],{stdio:['ignore',null,null,'pipe'],encoding:'utf8'});
  assert.ifError(extra.error); assert.strictEqual(extra.status,0); assert.strictEqual(extra.output[3],'extra-fd');
  const fd = fs.openSync(root+'/output','w');
  try { const redirected = cp.spawnSync('/bin/sh',['-c','printf redirected'],{stdio:['ignore',fd,'ignore']}); assert.ifError(redirected.error); assert.strictEqual(redirected.status,0); assert.strictEqual(redirected.stdout,null); }
  finally { fs.closeSync(fd); }
  assert.strictEqual(fs.readFileSync(root+'/output','utf8'),'redirected');
  const closed=fs.openSync('/dev/null','r');fs.closeSync(closed);
  const invalid=cp.spawnSync('/bin/sh',['-c','printf incorrect'],{stdio:['ignore',closed,'pipe']});
  assert.strictEqual(invalid.error.code,'EBADF');assert.strictEqual(invalid.status,null);assert.strictEqual(invalid.pid,0);
  assert.strictEqual(cp.execFileSync('/bin/sh',['-c','printf exact'],{encoding:'utf8'}),'exact');
  assert.strictEqual(cp.execSync('printf shell',{encoding:'utf8'}),'shell');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
console.log('node-sync-processes-cwd-env-stdio-ok');
` },
  { name: 'limits-and-lifetime', source: `
const assert = require('assert'), cp = require('child_process');
assert.strictEqual(process.kill(process.pid,0),true);
const timed = cp.spawnSync(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:200,killSignal:'SIGKILL'});
assert(timed.pid > 0); assert.strictEqual(timed.error.code,'ETIMEDOUT'); assert.strictEqual(require('util').getSystemErrorName(timed.error.errno),'ETIMEDOUT'); assert.strictEqual(timed.status,null); assert.strictEqual(timed.signal,'SIGKILL');
assert.throws(() => process.kill(timed.pid,0),{code:'ESRCH'});
const limited = cp.spawnSync(process.execPath,['-e',"const fs=require('fs');fs.writeSync(1,Buffer.alloc(65536));fs.writeSync(2,Buffer.alloc(65536));"],{maxBuffer:70000,timeout:30000});
assert(limited.pid > 0); assert.strictEqual(limited.error.code,'ENOBUFS'); assert.strictEqual(require('util').getSystemErrorName(limited.error.errno),'ENOBUFS'); assert(limited.stdout.length+limited.stderr.length > 70000);
let microtask = false, timer = false;
Promise.resolve().then(() => microtask = true); const pending = setTimeout(() => timer = true,0);
const quiet = cp.spawnSync('/bin/sh',['-c','exit 0']);
assert.ifError(quiet.error); assert.strictEqual(quiet.status,0); assert.strictEqual(microtask,false); assert.strictEqual(timer,false); clearTimeout(pending);
console.log('node-sync-processes-limits-and-lifetime-ok');
` },
  { name: 'async-blocking-child-pipes', source: `
const assert = require('assert'), cp = require('child_process');
const length = 196608;
const script = "const fs=require('fs');function write(fd,b){let p=0;while(p<b.length)p+=fs.writeSync(fd,b,p,b.length-p);}write(1,Buffer.alloc("+length+",65));write(2,Buffer.alloc("+length+",66));const b=Buffer.alloc(65536);let n;while((n=fs.readSync(0,b,0,b.length,null))>0)write(1,b.subarray(0,n));";
const child = cp.spawn(process.execPath,['-e',script]);
const stdout=[],stderr=[];
child.on('error', error => { throw error; }); child.stdin.on('error', error => { throw error; });
child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
child.on('close', (status,signal) => {
  assert.strictEqual(status,0); assert.strictEqual(signal,null);
  const out=Buffer.concat(stdout),err=Buffer.concat(stderr);
  assert.strictEqual(out.length,length*2); assert.strictEqual(err.length,length);
  assert(out.subarray(0,length).equals(Buffer.alloc(length,65))); assert(out.subarray(length).equals(Buffer.alloc(length,67))); assert(err.equals(Buffer.alloc(length,66)));
  console.log('node-sync-processes-async-blocking-child-pipes-ok');
});
child.stdin.end(Buffer.alloc(length,67));
` },
  { name: 'credentials-and-errno', source: `
const assert=require('assert'),cp=require('child_process'),util=require('util');
const names=['getuid','geteuid','getgid','getegid'];
const parent=names.map(name => process[name]());
for(const id of parent) assert(Number.isInteger(id) && id >= 0);
const r=cp.spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(['getuid','geteuid','getgid','getegid'].map(name=>process[name]())))"],{encoding:'utf8'});
assert.ifError(r.error);assert.strictEqual(r.status,0);assert.deepStrictEqual(JSON.parse(r.stdout),parent);
const detached=cp.spawnSync('/bin/sh',['-c','printf detached'],{detached:true,encoding:'utf8'});
assert.ifError(detached.error);assert.strictEqual(detached.status,0);assert.strictEqual(detached.stdout,'detached');
assert.strictEqual(util.getSystemErrorName(-2),'ENOENT');
assert.strictEqual(util.getSystemErrorName(-9007199254740991),'Unknown system error -9007199254740991');
for(const value of [0,1,NaN,Infinity,-Infinity,1.5,-1.5]) assert.throws(()=>util.getSystemErrorName(value),{code:'ERR_OUT_OF_RANGE'});
for(const value of ['-2',null,{},true]) assert.throws(()=>util.getSystemErrorName(value),{code:'ERR_INVALID_ARG_TYPE'});
console.log('node-sync-processes-credentials-and-errno-ok');
` },
];
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export const nodeSyncProcessExpected = nodeSyncProcessCases.map(c => `node-sync-processes-${c.name}-ok`);
export const nodeSyncProcessCommand = 'set -eu\n' + nodeSyncProcessCases.map(c => `node -e ${quote(c.source)}\n`).join('');

/** An independent POSIX peer verifies real session and credential state. */
export const nodeSyncProcessPeerSource = `
const assert=require('assert'),cp=require('child_process');
const credentials=['getuid','geteuid','getgid','getegid'].map(name=>process[name]());
function verify(pid,output,detached) {
  const fields=output.trim().split(/\\s+/).map(Number);
  assert.strictEqual(fields.length,7);assert.strictEqual(fields[0],pid);
  assert.deepStrictEqual(fields.slice(3),credentials);
  if(detached) {assert.strictEqual(fields[1],pid);assert.strictEqual(fields[2],pid);}
  else {assert.notStrictEqual(fields[1],pid);assert.notStrictEqual(fields[2],pid);}
}
for(const detached of [false,true]) {
  const r=cp.spawnSync('/node-src/process-peer.wasm',[],{detached,encoding:'utf8'});
  assert.ifError(r.error);assert.strictEqual(r.status,0);verify(r.pid,r.stdout,detached);
}
const child=cp.spawn('/node-src/process-peer.wasm',[],{detached:true});let output='';
child.on('error',error=>{throw error;});child.stdout.on('data',b=>output+=b.toString());
child.on('close',(status,signal)=>{
  assert.strictEqual(status,0);assert.strictEqual(signal,null);verify(child.pid,output,true);
  console.log('node-sync-processes-independent-peer-ok');
});child.stdin.end();
`;
