'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), Module = require('node:module');
const filename = process.env.NODE26_SOURCE + '/test/parallel/test-sys.js';
if (process.argv[2] === 'child') {
  if (process.argv[3] === 'native') require(filename);
  else {
    const candidate = require('./control.cjs').candidate({});
    const nativeRequire = Module.createRequire(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const wrapper = vm.compileFunction(source, ['exports','require','module','__filename','__dirname'], { filename });
    const module = { exports: {} };
    // The complete unchanged test and its real upstream common harness run.
    // Only this declared harness dependency stays native; public builtins go
    // through the actual candidate CJS/sys/policy/cache owner.
    const req = id => id === '../common' ? nativeRequire(id) : candidate.req(id);
    wrapper(module.exports, req, module, filename, path.dirname(filename));
  }
} else {
  const out = path.resolve(process.argv[2]); fs.mkdirSync(out,{recursive:true});
  const results=[];
  for (const mode of ['native','candidate']) {
    const command=[process.execPath,'--expose-internals',__filename,'child',mode];
    const run=cp.spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:10000});
    fs.writeFileSync(path.join(out,mode+'.stdout'),run.stdout||'');fs.writeFileSync(path.join(out,mode+'.stderr'),run.stderr||'');
    results.push({mode,command,exit:run.status,signal:run.signal,error:run.error?.message});
  }
  const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report={scope:'Unchanged pinned test-sys.js with real upstream common harness; explicit native VM/util/fs/EventEmitter/tick boundaries, no guest or ESM evidence',test:filename,testSha256:sha(filename),nodeSha256:sha(process.execPath),results,compilations:0,productSetup:0,overallSuites:0};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  process.exitCode=results.some(row=>row.exit!==0)?1:0;
}
