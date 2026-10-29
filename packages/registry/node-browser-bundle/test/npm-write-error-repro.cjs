// Standalone npm regression: no Kandelo runtime or source imports.
// Run with an unpacked npm CLI: node npm-write-error-repro.cjs /path/npm-cli.js [fixed]
// The preload redirects one entry write through a real readonly descriptor.
const {spawnSync,execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const cli=path.resolve(process.argv[2]);
const expectFixed=process.argv[3]==='fixed';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'npm-write-error-'));
try {
  const source=path.join(root,'source/package'),project=path.join(root,'project');
  fs.mkdirSync(source,{recursive:true});fs.mkdirSync(project);
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'write-error-fixture',version:'1.0.0'}));
  fs.writeFileSync(path.join(source,'blocked.txt'),'This entry must be completely written.');
  fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'write-error-project',version:'1.0.0',private:true}));
  const archive=path.join(root,'fixture.tgz');
  execFileSync('tar',['-czf',archive,'-C',path.join(root,'source'),'package']);
  const result=spawnSync(process.execPath,['--require',path.join(__dirname,'npm-write-error-preload.cjs'),cli,'install','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',path.join(root,'cache'),'--prefix',project,archive],{encoding:'utf8'});
  if(result.error)throw result.error;
  assert.equal(result.signal,null,'runtime crashed instead of reporting the write error');
  assert.equal(typeof result.status,'number');
  console.log('Node',process.version,'npm',require(path.join(path.dirname(path.dirname(cli)),'package.json')).version,'install status',result.status);
  console.log(result.stdout);console.log(result.stderr);
  assert.match(result.stderr,/readonly descriptor/);assert.match(result.stderr,/EBADF/);
  if(expectFixed){
    assert.notEqual(result.status,0,'installer accepted a failed extraction');
    console.log('PASS: installer rejects a real OS write error');
  } else {
    assert.equal(result.status,0,'behavior changed: installer now rejects the write error');
    assert.equal(fs.statSync(path.join(project,'node_modules/write-error-fixture/blocked.txt')).size,0);
    console.log('REPRODUCED: npm reports success after an OS write error leaves an empty package file');
  }
} finally {fs.rmSync(root,{recursive:true,force:true})}
