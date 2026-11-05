import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {types} from 'node:util';
const require=createRequire(import.meta.url);
const {create}=require('./fixtures/node-module-records.cjs');
const {internalBinding}=require('internal/test/binding');
const referenceFormat=require('internal/modules/esm/get_format').defaultGetFormat;
function syntaxError(run:()=>unknown){
  let error:unknown;try{run()}catch(e){error=e}
  expect(types.isNativeError(error)).toBe(true);
  expect((error as Error)?.name).toBe('SyntaxError');
}
const target=JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json',import.meta.url),'utf8'));
// Candidate source owners over actual native26 parser/compiler/VM/fs/URL
// dependencies. The SpiderMonkey classifier itself needs guest evidence.
describe.skipIf(process.versions.node!==target.version)('module source compiler and format admission',()=>{
  const cases=[
    'module.exports = 1;', '"export const fake = 1";', '/*\nexport const fake = 1\n*/ module.exports=2;',
    'import "node:fs";', 'export const actual = 1;', 'void import.meta.url;',
    'await Promise.resolve();', 'const require = 1;', 'let exports = 1;',
    'return 7;', 'function f(){return import("node:fs");}',
    'function f(){ await Promise.resolve(); }', 'export definitely invalid',
    'const require = 1; export definitely invalid', '#!/usr/bin/env node\nmodule.exports=1;',
    'module.exports="😀";\0throw Error("must not execute");',
  ];
  it('classifies ambiguous sources without executing source or imports',()=>{
    const c=create({files:{'/control/package.json':'{}','/control/main.js':''}});
    for(const code of cases)expect(c.syntax.contains(code,'/control/main.js')).toBe(internalBinding('contextify').containsModuleSyntax(code,'/control/main.js'));
    expect(c.context.__executed).toBeUndefined();
    expect(c.syntax.contains('globalThis.__executed=1; export {};','/control/main.js')).toBe(true);
    expect(c.context.__executed).toBeUndefined();
  });
  it('uses actual file/package format policy for ESM consumers',()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'kandelo-module-format-'));
    try{
      const c=create();
      for(const type of [undefined,'module','commonjs']){
        const root=path.join(dir,String(type));mkdirSync(root);writeFileSync(path.join(root,'package.json'),JSON.stringify({type}));
        for(const [ext,code] of [['.js','export const x=1;'],['.cjs','export {};'],['.mjs','module.exports=1;'],['','export {};'],['.json','{}'],['.other','export {};']]){
          const file=path.join(root,'main'+ext);writeFileSync(file,code);
          const outcome=(run:()=>unknown)=>{try{return {format:run()}}catch(e){return {name:(e as Error).name,code:(e as {code?:string}).code}}};
          expect(outcome(()=>c.syntax.esmFormat(file,code))).toEqual(outcome(()=>referenceFormat(pathToFileURL(file),{source:code})));
        }
      }
    }finally{rmSync(dir,{recursive:true,force:true})}
  });
  it('compiles real CJS function bodies without executing wrapper escapes',()=>{
    const c=create({files:{'/control/escape.cjs':'}); globalThis.__escaped = 1; (function(){'}});
    const run=c.make('/control/main.cjs');
    syntaxError(()=>run('./escape.cjs'));
    expect(c.context.__escaped).toBeUndefined();expect(c.Module._cache['/control/escape.cjs']).toBeUndefined();
  });
  it('keeps lexical wrapper bindings, return, receiver and source bytes',()=>{
    const c=create({files:{'/control/body.cjs':'"use strict"; module.exports={same:this===exports,args:arguments.length,name:__filename,dir:__dirname};return 9;',
      '/control/shebang.cjs':'#!/usr/bin/env node\nmodule.exports="😀";',
      '/control/nul.cjs':'module.exports=1;\0throw Error("unreachable");'}});
    const run=c.make('/control/main.cjs');
    expect(JSON.parse(JSON.stringify(run('./body.cjs')))).toEqual({same:true,args:5,name:'/control/body.cjs',dir:'/control'});
    expect(run('./shebang.cjs')).toBe('😀');syntaxError(()=>run('./nul.cjs'));
    expect(c.Module._cache['/control/nul.cjs']).toBeUndefined();
  });
  it('explicit CJS stays CJS and ambiguous syntax reaches actual ESM owner',()=>{
    const c=create({files:{'/control/package.json':'{}','/control/ambiguous.js':'import "node:fs";',
      '/control/plain.js':'/*\nexport const fake=1;\n*/module.exports=8;',
      '/control/cjs/package.json':'{"type":"commonjs"}','/control/cjs/explicit.js':'export {};'}});
    const run=c.make('/control/main.cjs');
    expect(run('./plain.js')).toBe(8);
    expect(()=>run('./ambiguous.js')).toThrow('Native ESM bridge is outside this CJS control');
    syntaxError(()=>run('./cjs/explicit.js'));
    expect(c.Module._cache['/control/ambiguous.js']).toBeUndefined();
  });
  it('compile construction alone cannot execute a valid body',()=>{
    const c=create({files:{}});const fn=c.syntax.compile('globalThis.__compiledBody=1;return 23;','/control/direct.cjs');
    expect(c.context.__compiledBody).toBeUndefined();expect(Reflect.apply(fn,{},[{},()=>{}, {},'/control/direct.cjs','/control'])).toBe(23);
    expect(c.context.__compiledBody).toBe(1);
  });
});
