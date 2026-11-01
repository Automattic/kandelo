import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { nodeSyncProcessCases } from './fixtures/node-sync-processes';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));

describe.skipIf(process.versions.node !== target.version)('exact native synchronous child-process controls', () => {
  for (const c of nodeSyncProcessCases) it(c.name, () => {
    const result = spawnSync(process.execPath, ['-e', c.source], {encoding:'utf8', timeout:40000});
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`node-sync-processes-${c.name}-ok`);
  }, 45000);
});

const bootstrap = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
function subject(failPipe = Infinity, pipeFailure: Error = Object.assign(new Error('pipe exhausted'), {code:'EMFILE',errno:24})) {
  const closed: number[] = []; let pipes = 0, spawns = 0;
  const native = {
    __kandeloPipe() {
      if (++pipes === failPipe) throw pipeFailure;
      return [100 + pipes * 2, 101 + pipes * 2];
    },
    __kandeloFdClose(fd: number) { closed.push(fd); },
    __kandeloSpawn() { spawns++; throw Object.assign(new Error('missing'), {code:'ENOENT',errno:2}); },
    __kandeloRunChildSync() { throw Error('must not enter controller after failed spawn'); },
  };
  const a = bootstrap.indexOf('const child_process = (() => {');
  const b = bootstrap.indexOf('// child_process.ChildProcess', a);
  if (a < 0 || b < 0) throw Error('Missing child-process source boundary');
  const api = Function('_nodeNative','Buffer','os','nodeOs','process',bootstrap.slice(a,b) + ';return child_process;')
    (native, Buffer, {timerNow:() => 1}, {constants:{signals:{SIGTERM:15}}}, {env:{PATH:'/bin'},cwd:() => '/tmp'});
  return {api, closed, get spawns() { return spawns; }, get pipes() { return pipes; }};
}

describe('actual synchronous child-process source rollback', () => {
  it('preserves unexpected native exceptions while closing already allocated pipes', () => {
    const error = new Error('native allocation failed'); const s = subject(3,error);
    expect(() => s.api.spawnSync('/missing',[])).toThrow(error);
    expect(s.closed.sort((a,b) => a-b)).toEqual([102,103,104,105]);
  });
  it('closes both ends of every pipe when a later allocation fails', () => {
    const s = subject(3), r = s.api.spawnSync('/missing',[]);
    expect(r.error.code).toBe('EMFILE'); expect(s.spawns).toBe(0);
    expect(s.closed.sort((a,b) => a-b)).toEqual([102,103,104,105]);
    expect(new Set(s.closed).size).toBe(s.closed.length);
  });
  it('closes every endpoint when posix_spawn fails', () => {
    const s = subject(), r = s.api.spawnSync('/missing',[]);
    expect(r.error).toMatchObject({code:'ENOENT',errno:-2,path:'/missing',spawnargs:[]});
    expect(s.spawns).toBe(1); expect(r.status).toBe(null); expect(r.pid).toBe(0);
    expect(s.closed.sort((a,b) => a-b)).toEqual([102,103,104,105,106,107]);
  });
  it('rejects invalid inputs before allocating any pipes or child', () => {
    const s = subject();
    for (const options of [{timeout:-1},{timeout:1.2},{maxBuffer:-1},{input:{}},{stdio:'invalid'},{killSignal:'SIGINVALID'}]) {
      expect(() => s.api.spawnSync('/bin/sh',[],options)).toThrow();
    }
    expect(s.pipes).toBe(0); expect(s.spawns).toBe(0); expect(s.closed).toEqual([]);
  });
});

function killSubject() {
  const calls: Array<[number,number]> = [];
  const a = bootstrap.indexOf('        _kill(pid, signum) {');
  const b = bootstrap.indexOf('\n        hrtime:',a);
  const e = bootstrap.slice(bootstrap.indexOf('function _errnoToCode('),bootstrap.indexOf('function _notImpl('));
  if (a < 0 || b < 0) throw Error('Missing process kill source boundary');
  const proc = Function('_nodeNative','nodeOs',e + ';const proc={' + bootstrap.slice(a,b) + '};return proc;')
    ({__kandeloKill(pid: number,sig: number) { calls.push([pid,sig]); if(pid===43) throw Object.assign(new Error('missing'),{errno:3,code:'ESRCH'}); }},
      {constants:{signals:{SIGTERM:15,SIGKILL:9}}});
  return {proc,calls};
}
describe('actual process kill source', () => {
  it('preserves signal zero, numeric pid conversion and the success result', () => {
    const {proc,calls} = killSubject();
    expect(proc.kill('42',0)).toBe(true); expect(proc.kill(42)).toBe(true);
    expect(calls).toEqual([[42,0],[42,15]]);
  });
  it('reports the real native errno and supports the Node kill hook', () => {
    const {proc} = killSubject();
    expect(() => proc.kill(43,0)).toThrow(expect.objectContaining({code:'ESRCH',errno:-3,syscall:'kill'}));
    proc._kill = () => -3;
    expect(() => proc.kill(42,0)).toThrow(expect.objectContaining({code:'ESRCH'}));
  });
  it('rejects unknown signal names without substituting SIGTERM', () => {
    const {proc,calls} = killSubject();
    expect(() => proc.kill(42,'sigterm')).toThrow(expect.objectContaining({code:'ERR_UNKNOWN_SIGNAL'}));
    expect(calls).toEqual([]);
  });
});

describe('actual guest system error names', () => {
  const a = bootstrap.indexOf('util.getSystemErrorName = function (err) {');
  const b = bootstrap.indexOf('\n};',a)+3;
  const e = bootstrap.slice(bootstrap.indexOf('function _errnoToCode('),bootstrap.indexOf('function _notImpl('));
  if(a < 0 || b < a) throw Error('Missing errno-name source boundary');
  const name = Function(e + ';const util={};' + bootstrap.slice(a,b) + ';return util.getSystemErrorName;')();
  it('uses the shared guest errno namespace without int32 truncation', () => {
    expect(name(-105)).toBe('ENOBUFS');expect(name(-110)).toBe('ETIMEDOUT');expect(name(-38)).toBe('ENOSYS');
    expect(name(-9007199254740991)).toBe('Unknown system error -9007199254740991');
  });
  it('rejects nonnumbers and nonnegative or nonintegral values', () => {
    for(const x of ['-2',null,true,{}]) expect(()=>name(x)).toThrow(expect.objectContaining({code:'ERR_INVALID_ARG_TYPE'}));
    for(const x of [0,1,NaN,Infinity,-Infinity,-1.2]) expect(()=>name(x)).toThrow(expect.objectContaining({code:'ERR_OUT_OF_RANGE'}));
  });
});
