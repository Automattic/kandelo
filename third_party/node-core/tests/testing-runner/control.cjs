'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../..');
const mode = process.argv[2]; const scenario = process.argv[3];
const candidate = mode === 'native' ? { api: require('node:test') } : require('./platform.cjs')(root);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kandelo-test-runner-'));
const order = [];
globalThis.__kandeloRunnerOrder = order;
function write(name, text) {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text); return file;
}
function testSource(name, more = '') {
  return `import {test} from 'node:test';globalThis.__kandeloRunnerOrder.push('import:${name}');test(${JSON.stringify(name)},async t=>{await new Promise(r=>setImmediate(r));globalThis.__kandeloRunnerOrder.push('run:${name}');t.assert.strictEqual(6*7,42);});${more}`;
}
function errorOf(fn) {try {fn(); return {threw:false};}catch(e){return {name:e.name,code:e.code,message:e.message};}}
async function main() {
  if (scenario === 'validation') {
    const outcomes = [null, 1, false, {files:'x'}, {watch:1}, {isolation:'invalid'},
      {files:['a'],globPatterns:['b']}, {shard:{index:0,total:2}}, {setup:1},
      {testNamePatterns:[1]}, {coverage:'yes'}, {lineCoverage:101}, {argv:[1]},
      {env:{},isolation:'none'}, {watch:true,randomSeed:1}].map(o=>errorOf(()=>candidate.api.run(o)));
    const marker = {}; let caught; let gets = [];
    try {candidate.api.run({get testNamePatterns(){gets.push('testNamePatterns');throw marker;}});}catch(e){caught=e;}
    assert.equal(caught,marker);
    console.log(JSON.stringify({scenario,outcomes,gets,identity:true})); return;
  }
  if (scenario === 'missing-owners') {
    if (mode === 'native') return;
    const eventNames = ['beforeExit','uncaughtException','unhandledRejection'];
    const listeners = eventNames.map(name=>process.listenerCount(name));
    const checks = [{}, {isolation:'none',watch:true}, {isolation:'none',coverage:true}].map(o=>errorOf(()=>candidate.api.run(o)));
    assert.deepEqual(eventNames.map(name=>process.listenerCount(name)),listeners);
    assert.ok(checks.every(e=>e.code==='ERR_NOT_IMPLEMENTED'));
    assert.equal(order.length,0);
    await assert.rejects(candidate.graph.importURL('./relative.mjs'),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
    await assert.rejects(candidate.graph.importURL(pathToFileURL(write('empty.mjs','')).href,{type:'json'}),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
    console.log(JSON.stringify({scenario,implementationFailures:checks,notConformancePass:true}));return;
  }
  let options = {isolation:'none',cwd:dir};
  if (scenario === 'explicit') {
    options.files = [write('second.mjs',testSource('second')),write('first.mjs',testSource('first'))];
    options.setup = async reporter => {assert.equal(typeof reporter.pipe,'function');await new Promise(r=>setImmediate(r));order.push('setup');};
  } else if (scenario === 'glob') {
    write('nested/z.test.mjs',testSource('z'));write('a-test.mjs',testSource('a'));
    write('ignored.mjs',"throw Error('nonmatch ran')");write('node_modules/dependency/test.mjs',"throw Error('dependency ran')");
  } else if (scenario === 'directory') {
    write('selected/b.test.mjs',testSource('b'));write('selected/a.test.mjs',testSource('a'));
    write('outside.test.mjs',"throw Error('outside ran')");options.globPatterns=['selected/'];
  } else if (scenario === 'shard') {
    options.files=['a','b','c','d'].map(n=>write(n+'.mjs',testSource(n)));options.shard={index:2,total:2};
  } else if (scenario === 'filter') {
    options.files=[write('filter.mjs',testSource('keep',"test('omit',()=>{throw Error('filtered ran')});test('skip',()=>{throw Error('skipped ran')});"))];
    options.testNamePatterns=['keep|skip'];options.testSkipPatterns=['skip'];
  } else if (scenario === 'empty') options.files=[write('empty.mjs',"globalThis.__kandeloRunnerOrder.push('empty');")];
  else if (scenario === 'load-failure') options.files=[write('bad.mjs',"throw Object.assign(new Error('deliberate load'),{code:'ERR_DELIBERATE'});")];
  else if (scenario === 'test-failure') options.files=[write('bad.mjs',"import {test} from 'node:test';test('actual failure',t=>t.assert.strictEqual(1,2));")];
  else if (scenario === 'hooks') {
    options.files=[write('hooks.mjs',`import {test,before,after,beforeEach,afterEach} from 'node:test';const q=globalThis.__kandeloRunnerOrder;before(()=>q.push('before'));after(()=>q.push('after'));beforeEach(()=>q.push('beforeEach'));afterEach(()=>q.push('afterEach'));test('parent',async t=>{q.push('parent');await t.test('child',c=>{q.push('child');c.assert.ok(true);});});`)];
  } else if (scenario === 'global-setup') {
    options.globalSetupPath=write('setup.mjs',`const q=globalThis.__kandeloRunnerOrder;export async function globalSetup(){await new Promise(r=>setImmediate(r));q.push('globalSetup');}export async function globalTeardown(){q.push('globalTeardown');}`);
    options.files=[write('global.mjs',testSource('global'))];
  } else throw Error('unknown scenario');
  const events=[];const reporter=candidate.api.run(options);
  for await (const event of reporter) {
    if (['test:pass','test:fail','test:summary','test:plan'].includes(event.type)) {
      const d=event.data;
      events.push({type:event.type,name:d.name,nesting:d.nesting,count:d.count,skip:d.skip,
        success:d.success,tests:d.counts?.tests,failed:d.counts?.failed,
        error:d.details?.error && {message:d.details.error.message,code:d.details.error.code}});
    }
  }
  assert.ok(events.some(e=>e.type==='test:summary'));
  if (scenario==='explicit') assert.deepEqual(order,['setup','import:second','import:first','run:second','run:first']);
  if (scenario==='glob') assert.deepEqual(order,['import:a','import:z','run:a','run:z']);
  if (scenario==='directory') assert.deepEqual(order,['import:a','import:b','run:a','run:b']);
  if (scenario==='shard') assert.deepEqual(order,['import:b','import:d','run:b','run:d']);
  if (scenario==='filter') assert.deepEqual(order,['import:keep','run:keep']);
  if (scenario==='hooks') assert.deepEqual(order,['before','beforeEach','parent','beforeEach','child','afterEach','afterEach','after']);
  if (scenario==='load-failure'||scenario==='test-failure') assert.equal(events.find(e=>e.type==='test:summary').success,false);
  else assert.equal(events.find(e=>e.type==='test:summary').success,true);
  console.log(JSON.stringify({scenario,order,events}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
