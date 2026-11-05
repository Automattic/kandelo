import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
const control=fileURLToPath(new URL('./fixtures/node-module-wrapper-controls.cjs',import.meta.url));
// Actual candidate record/compiler routes; native26 supplies parser/VM/fs/URL.
// This frontend control does not compile or execute the guest C++ operation.
describe.skipIf(process.versions.node!==target.version)('public CommonJS wrapper ownership',()=>{
 for(const name of ['metadata','functionOverride','wrapperMutation','failureAndCache','rawSourceAndDetection','wholeScriptAndBytes','exportsGetterOwnership','proxyDeleteAndStickyState'])
  it(name,()=>{
   const outcomes=[];
   for(const mode of ['native','candidate']){
    const run=spawnSync(process.execPath,['--expose-internals',control,mode,name],{encoding:'utf8',timeout:15000});
    expect({exit:run.status,signal:run.signal,error:run.error?.message,stderr:run.status?run.stderr:undefined})
      .toEqual({exit:0,signal:null,error:undefined,stderr:undefined});
    outcomes.push(JSON.parse(run.stdout.trim()));
   }
   expect(outcomes[1]).toEqual(outcomes[0]);
  });
});
