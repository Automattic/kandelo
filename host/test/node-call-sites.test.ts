import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getCallSites as native } from 'node:util';
import { describe, expect, it } from 'vitest';
import { nodeCallSiteFiles, nodeCallSiteEvalSource } from './fixtures/node-call-sites';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const start = source.indexOf('    const _callSiteIntrinsics ='), end = source.indexOf('\n    return {\n', start);
if (start < 0 || end < 0) throw Error('Missing call-site source boundary');
function subject(captureCallSites: (count: number) => any[]) {
  return Function('_nodeNative', source.slice(start, end) + ';return getCallSites;')({ captureCallSites });
}
function outcome(fn: () => unknown) {
  try { fn(); return { ok:true }; } catch (e:any) { return {name:e.name,code:e.code}; }
}

describe.skipIf(process.versions.node !== target.version)('Node call-site validation', () => {
  it('matches native argument and option validation before capturing a stack', () => {
    const subjectFn = subject(() => []);
    const cases = [[],[undefined],[null],[false],[true],['1'],[1n],[Symbol('x')],[NaN],[Infinity],
      [-1],[0],[0.5],[1],[3.6],[200],[201],[{}],[[]],[{},{}],[1,null],[1,[]],[1,1],
      [1,{}],[{sourceMap:false}],[1,{sourceMap:false}],[{sourceMap:1}],[1,{sourceMap:'yes'}]];
    for (const args of cases) expect(outcome(() => subjectFn(...args)), String(args[0]))
      .toEqual(outcome(() => (native as any)(...args)));
  });

  it('forwards the validated count and honors option getter failures', () => {
    const calls:number[] = [], result:any[] = [];
    const fn = subject(count => {calls.push(count);return result;});
    expect(fn(200)).toBe(result); expect(fn({sourceMap:false})).toBe(result);
    expect(calls).toEqual([200,10]);
    const error = Error('option getter');
    expect(() => fn({get sourceMap(){throw error;}})).toThrow(error);
    expect(calls).toEqual([200,10]);
  });

  it('reports the unimplemented source-map operation without capturing misleading locations', () => {
    const fn = subject(() => {throw Error('must not capture');});
    expect(outcome(() => fn({sourceMap:true}))).toEqual({name:'Error',code:'ERR_NOT_IMPLEMENTED'});
  });

  for (const [name, contents] of Object.entries(nodeCallSiteFiles)) {
    it(`checks actual ${name} coordinates on the pinned native reference`, () => {
      const dir = mkdtempSync(join(tmpdir(),'node-call-sites-'));
      try {
        const file = join(dir,name);writeFileSync(file,contents);
        const result = spawnSync(process.execPath,[file],{encoding:'utf8',timeout:5000});
        expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
        expect(result.stdout).toContain('node-call-sites-');
      } finally {rmSync(dir,{recursive:true,force:true});}
    });
  }

  it('checks the native eval label', () => {
    const result = spawnSync(process.execPath,['-e',nodeCallSiteEvalSource],{encoding:'utf8',timeout:5000});
    expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('node-call-sites-eval-ok');
  });
});
