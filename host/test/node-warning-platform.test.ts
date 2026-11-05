import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-warning-controls.cjs', import.meta.url));
const normalize = (text: string) => text.replace(/\(node:\d+\)/g, '(node:PID)');
function run(mode: string, name: string, flags: string[] = [], environment: Record<string,string> = {}) {
  const env = {...process.env};delete env.NODE_OPTIONS;delete env.NODE_NO_WARNINGS;delete env.NODE_REDIRECT_WARNINGS;
  const result = spawnSync(process.execPath, ['--expose-internals', ...flags, fixture, mode, name], {
    encoding:'utf8', timeout:15_000, env:{...env,...environment},
  });
  expect({status:result.status,signal:result.signal,error:result.error?.message})
    .toEqual({status:0,signal:null,error:undefined});
  return {value:JSON.parse(result.stdout.trim()),stderr:normalize(result.stderr)};
}
describe.skipIf(process.versions.node !== target.version)('pinned warning owner over native process and I/O boundaries', () => {
  for (const [name,flags,env] of [
    ['overloads',[],{}],['formatting',[],{}],['ordering',[],{}],['syncDeprecator',[],{}],
    ['filtering',['--disable-warning=W_HIDDEN','--disable-warning=HiddenWarning'],{}],
    ['runtimeNoWarnings',[],{}],['suppressed',['--no-warnings'],{}],['suppressed',[],{NODE_NO_WARNINGS:'1'}],
    ['noDeprecation',['--no-deprecation'],{}],['aliases',[],{}],
    ['aliases',['--no-deprecation','--no-warnings','--trace-warnings','--throw-deprecation','--trace-deprecation'],{}],
    ['throwDeprecation',['--throw-deprecation'],{}],['noCapture',[],{}],
  ] as [string,string[],Record<string,string>][]) it(`${name} ${flags.join(' ')} ${JSON.stringify(env)}`, () => {
    expect(run('candidate',name,flags,env)).toEqual(run('native',name,flags,env));
  });
  for (const fallback of [false,true]) it(fallback?'failed redirect falls back to console':'redirect owns actual appended output', () => {
    const root=mkdtempSync(join(tmpdir(),'kandelo-warning-'));
    try {
      const outputs=[];
      for(const mode of ['candidate','native']) {
        const file=join(root, fallback?'missing/'+mode:mode);
        const result=run(mode,fallback?'redirectFallback':'redirect',['--redirect-warnings='+file]);
        outputs.push({...result,file:fallback?undefined:normalize(readFileSync(file,'utf8'))});
      }
      expect(outputs[0]).toEqual(outputs[1]);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it('tracing prints actual captured stacks', () => {
    const candidate=run('candidate','trace',['--trace-warnings']);
    const native=run('native','trace',['--trace-warnings']);
    expect(candidate.value).toEqual(native.value);
    expect(candidate.stderr).toContain('Warning: trace requested\n');
    expect(native.stderr).toContain('Warning: trace requested\n');
    expect(candidate.stderr).toContain('node-warning-controls.cjs');
    expect(native.stderr).toContain('node-warning-controls.cjs');
    // Stack bytes differ by loader/engine source; this does not certify frame filtering.
  });
});
