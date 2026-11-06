'use strict';
// Run with the exact target Node and a freshly compiled node-copy-file-owner.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const owner=process.argv[2]; if(!owner)throw new Error('native owner executable required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-copy-native-'));
const binary=size=>Buffer.from(Array.from({length:size},(_,i)=>(i*73+(i>>>8))&255));
const call=(command,source,dest,flags,fault)=>JSON.parse(execFileSync(owner,[command,source,dest,String(flags),...(fault?[fault]:[])],{encoding:'utf8',timeout:10000,killSignal:'SIGKILL'}));
const native=(src,dst,mode)=>{try{fs.copyFileSync(src,dst,mode);return 0;}catch(e){return e.errno;}};
const results=[],nonpasses=[];
function fixture(name,size=32771) {
  const base=path.join(root,name);fs.mkdirSync(base);
  const source=path.join(base,'source'),dest=path.join(base,'dest');
  fs.writeFileSync(source,binary(size));fs.chmodSync(source,0o751);fs.utimesSync(source,1000.125,2000.25);
  return {base,source,dest};
}
function state(file) {
  if(!fs.existsSync(file))return {exists:false};
  const stat=fs.statSync(file);
  return {exists:true,mode:stat.mode&0o7777,uid:stat.uid,gid:stat.gid,size:stat.size,bytes:fs.readFileSync(file).toString('hex'),
    ...(stat.size===0?{mtime:stat.mtimeMs}: {})};
}
try {
  for(const size of [0,1,8191,8192,8193,262149,2097169]) {
    const a=fixture('binary-a-'+size,size),b=fixture('binary-b-'+size,size);
    fs.writeFileSync(a.dest,'long previous contents');fs.writeFileSync(b.dest,'long previous contents');
    const actual=call('copy',a.source,a.dest,0).status,expected=native(b.source,b.dest,0);
    assert.equal(actual,expected);assert.deepEqual(state(a.dest),state(b.dest));results.push({binary:size,status:actual});
  }
  for(const kind of ['missing-source','missing-parent','existing-excl','directory-source','directory-destination','same-path','hardlink','symlink',
    'same-force','same-exclusive','dangling-destination','exclusive-dangling','best-effort-clone','forced-clone','forced-existing','forced-symlink','exclusive-forced-existing',
    ...(process.getuid()!==0?['source-permission','destination-permission']:[])]) {
    const a=fixture('error-a-'+kind),b=fixture('error-b-'+kind);let mode=0;
    function prepare(v) {
      switch(kind) {
        case 'missing-source':fs.unlinkSync(v.source);fs.writeFileSync(v.dest,'retained');break;
        case 'missing-parent':v.dest=path.join(v.base,'missing/dest');break;
        case 'existing-excl':fs.writeFileSync(v.dest,'retained');mode=1;break;
        case 'directory-source':v.source=v.base;break;
        case 'directory-destination':v.dest=v.base;break;
        case 'same-path':v.dest=v.source;break;
        case 'hardlink':fs.linkSync(v.source,v.dest);break;
        case 'symlink':fs.symlinkSync('source',v.dest);break;
        case 'same-force':v.dest=v.source;mode=4;break;
        case 'same-exclusive':v.dest=v.source;mode=1;break;
        case 'dangling-destination':fs.symlinkSync('created-target',v.dest);break;
        case 'exclusive-dangling':fs.symlinkSync('missing-target',v.dest);mode=1;break;
        case 'source-permission':fs.chmodSync(v.source,0);break;
        case 'destination-permission':fs.writeFileSync(v.dest,'retained');fs.chmodSync(v.dest,0o400);break;
        case 'forced-symlink':fs.writeFileSync(path.join(v.base,'target'),'retained');fs.symlinkSync('target',v.dest);mode=4;break;
        case 'best-effort-clone':mode=2;break;
        case 'forced-clone':mode=4;break;
        case 'forced-existing':mode=4;fs.writeFileSync(v.dest,'previous');break;
        case 'exclusive-forced-existing':mode=5;fs.writeFileSync(v.dest,'retained');break;
      }
    }
    prepare(a);prepare(b);
    const actual=call('copy',a.source,a.dest,mode).status,expected=native(b.source,b.dest,mode);
    if(actual!==expected)nonpasses.push({kind,actual,expected,boundary:'source fstat directory-type rejection versus Darwin native sendfile; unresolved errno mismatch'});
    if(kind!=='directory-destination')assert.deepEqual(state(a.dest),state(b.dest),kind+' destination');
    if(kind==='forced-symlink')assert.deepEqual(state(path.join(a.base,'target')),state(path.join(b.base,'target')));
    if(kind==='exclusive-dangling'){assert(fs.lstatSync(a.dest).isSymbolicLink());assert.equal(fs.readlinkSync(a.dest),'missing-target');}
    assert.equal(fs.existsSync(a.source),fs.existsSync(b.source));results.push({kind,status:actual});
  }
  const race=fixture('race',2097169),statuses=call('race',race.source,race.dest,1).statuses;
  assert.equal(statuses.filter(status=>status===0).length,1);
  assert.equal(statuses.filter(status=>status===-os.constants.errno.EEXIST).length,23);
  assert.deepEqual(fs.readFileSync(race.dest),fs.readFileSync(race.source));results.push({race:24,successes:1,exclusiveLosers:23});
  for(const [fault,flags,expected,retained] of [
    ['stat-source',0,-os.constants.errno.EINTR,true],['stat-destination',0,-os.constants.errno.EINTR,false],
    ['truncate-interrupted',0,-os.constants.errno.EINTR,false],['truncate-access',0,-os.constants.errno.EACCES,false],
    ['truncate-empty',0,0,true],['read',0,-os.constants.errno.EIO,false],['write',0,-os.constants.errno.ENOSPC,false],
    ['write-zero',0,-os.constants.errno.EIO,false],['chmod',0,-os.constants.errno.EPERM,false],
    ['close-source',0,-os.constants.errno.EIO,false],['close-destination',0,-os.constants.errno.EBADF,false],
    ['short-write',0,0,true],['again',0,0,true],['clone-best-effort',2,0,true],
    ['clone-force',4,-os.constants.errno.ENOTSUP,false],['eof',0,0,true],
  ]) {
    const v=fixture('fault-'+fault);fs.writeFileSync(v.dest,fault==='truncate-empty'?'':'pre-existing destination');
    const result=call('fault',v.source,v.dest,flags,fault);assert.equal(result.status,expected,fault);
    assert.equal(result.closes,fault==='stat-source'?1:2,fault);assert(result.maximumRead<=8192);assert.equal(fs.existsSync(v.dest),retained,fault);
    if(fault==='stat-source')assert.equal(fs.readFileSync(v.dest,'utf8'),'pre-existing destination');
    else if(retained&&fault!=='eof')assert.deepEqual(fs.readFileSync(v.dest),fs.readFileSync(v.source));
    if(flags)assert.equal(result.clones,1);results.push({fault,...result});
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,portable:true,passed:nonpasses.length===0,nonpasses,results},null,2));
  if(nonpasses.length)process.exitCode=1;
} finally {fs.rmSync(root,{recursive:true,force:true});}
