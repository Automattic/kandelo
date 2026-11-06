'use strict';
// Host descriptors remain real. The helper exposes the directory entry-count
// size (zero) used by an empty guest rootfs/tmpfs directory. This control does
// not execute the guest kernel and does not establish Darwin errno parity.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const owner=process.argv[2];if(!owner)throw new Error('native copy owner executable required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'kandelo-copy-zero-dir-'));
const errno=os.constants.errno;
const controls=[
  {name:'new-destination',status:-errno.EISDIR},
  {name:'existing-destination',destination:'file',status:-errno.EISDIR},
  {name:'exclusive-new',flags:1,status:-errno.EISDIR},
  {name:'exclusive-existing',destination:'file',flags:1,status:-errno.EEXIST,keep:true,early:true},
  {name:'exclusive-dangling',destination:'dangling',flags:1,status:-errno.EEXIST,keep:true,early:true},
  {name:'missing-parent',destination:'missing-parent',status:-errno.ENOENT,early:true},
  {name:'directory-destination',destination:'directory',status:-errno.EISDIR,keep:true,early:true},
  {name:'same-directory',destination:'same',status:-errno.EISDIR,keep:true,early:true},
  {name:'source-symlink',source:'symlink',status:-errno.EISDIR},
  {name:'clone-best-effort',flags:2,fault:'clone-unsupported',status:-errno.EISDIR,clones:1},
  {name:'clone-force',flags:4,fault:'clone-unsupported',status:-errno.ENOSYS,clones:1},
  {name:'clone-force-existing',destination:'file',flags:4,fault:'clone-unsupported',status:-errno.ENOSYS,clones:1},
  {name:'exclusive-force-existing',destination:'file',flags:5,status:-errno.EEXIST,keep:true,early:true},
  {name:'exclusive-force-new',flags:5,fault:'clone-unsupported',status:-errno.ENOSYS,clones:1},
  {name:'chmod-before-force',flags:4,fault:'chmod',status:-errno.EPERM},
  {name:'stat-source',destination:'file',fault:'stat-source',status:-errno.EINTR,keep:true,early:true},
  {name:'stat-destination',fault:'stat-destination',status:-errno.EINTR,beforeMetadata:true},
  {name:'truncate-before-force',flags:4,fault:'truncate-interrupted',status:-errno.EINTR,beforeMetadata:true},
  {name:'empty-regular-file',source:'regular',status:0,keep:true},
  {name:'empty-regular-force',source:'regular',flags:4,fault:'clone-unsupported',status:-errno.ENOSYS,clones:1},
];
const results=[];
try {
  for(const control of controls) {
    const base=path.join(root,control.name);fs.mkdirSync(base);
    const directory=path.join(base,'directory');fs.mkdirSync(directory);
    let source=directory,dest=path.join(base,'destination');
    if(control.source==='symlink'){source=path.join(base,'link');fs.symlinkSync('directory',source);}
    if(control.source==='regular'){source=path.join(base,'regular');fs.writeFileSync(source,'');}
    if(control.destination==='file')fs.writeFileSync(dest,'retained');
    if(control.destination==='dangling')fs.symlinkSync('missing',dest);
    if(control.destination==='missing-parent')dest=path.join(base,'absent/destination');
    if(control.destination==='directory')fs.mkdirSync(dest);
    if(control.destination==='same')dest=directory;
    const result=JSON.parse(execFileSync(owner,['directory-zero',source,dest,String(control.flags||0),control.fault||'none'],
      {encoding:'utf8',timeout:10000,killSignal:'SIGKILL'}));
    assert.equal(result.status,control.status,control.name);
    assert.equal(result.closes,control.early?1:2,control.name+' fd ownership');
    assert.equal(result.reads,0,control.name+' no byte read');assert.equal(result.writes,0,control.name+' no byte write');
    assert.equal(result.clones,control.clones||0,control.name+' clone ordering');
    const metadata=control.early||control.beforeMetadata?0:1;
    assert.equal(result.metadata,metadata,control.name+' metadata ordering');
    assert.equal(result.permissions,metadata,control.name+' chmod ordering');
    if(control.fault!=='stat-source'){
      assert.equal(result.sourceSize,0,control.name+' true zero extent');
      assert.equal(result.sourceType,control.source==='regular'?fs.constants.S_IFREG:fs.constants.S_IFDIR,control.name+' actual inode type');
    }
    const present=(()=>{try{fs.lstatSync(dest);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}})();
    assert.equal(present,!!control.keep,control.name+' cleanup');
    if(control.keep&&control.destination==='file')assert.equal(fs.readFileSync(dest,'utf8'),'retained');
    if(control.destination==='dangling')assert.equal(fs.readlinkSync(dest),'missing');
    assert(fs.statSync(directory).isDirectory(),control.name+' source preserved');
    results.push({name:control.name,...result,destinationPreserved:present});
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,passed:true,
    scope:'zero-size guest-directory metadata over real host descriptor operations; no guest execution or native errno parity claim',results},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}
