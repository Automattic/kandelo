'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{primordials}=require('internal/test/binding');
const tree=process.argv[2];const source=fs.readFileSync(path.join(tree,'packages/registry/node-compat/bootstrap.js'),'utf8');
const begin=source.indexOf('function _initializeNodeWorkerStartup(data) {');const end=source.indexOf('\nif (_nodeNative.workerEnvironment) {',begin);assert(begin>=0&&end>begin);
const fn=source.slice(begin,end);const rows=[];
for(const mode of ['classic','file']){
 const targetGlobal={require(){},module:{},exports:{},__filename:'',__dirname:'',retained:23},proc={argv:['node']};const native={workerEnvironment:{env:{},cliOptions:{}}};
 const fixture=Function('_nodeNative','_nodeValues','_createNodePrimordials','process','globalThis','_moduleRealpath',`let _nodeWorkerStartupInitialized=false;let _mainScriptPath='';${fn};return{initialize:_initializeNodeWorkerStartup,path:()=>_mainScriptPath};`)(native,{errors:require('internal/errors')},()=>primordials,proc,targetGlobal,fs.realpathSync);
 const argv={0:'first',1:'second',length:2,[Symbol.iterator](){throw new Error('Startup argv is array-like, not iterable');}};
 const filename=mode==='classic'?'actual source payload':__filename;
 const data={argv,filename,doEval:mode==='classic'?'classic':false};const result=fixture.initialize(data);
 assert.deepEqual(proc.argv,['node',mode==='classic'?'[worker eval]':filename,'first','second']);assert.equal(result.eval,mode==='classic');
 if(mode==='classic'){assert.equal(result.source,filename);assert.equal(typeof targetGlobal.require,'function');}
 else{assert.equal(native.mainScriptPath,fs.realpathSync(filename));assert.equal(fixture.path(),fs.realpathSync(filename));for(const key of ['require','module','exports','__filename','__dirname'])assert.equal(key in targetGlobal,false);}
 assert.equal(targetGlobal.retained,23);assert.throws(()=>fixture.initialize(data),{code:'ERR_INVALID_STATE'});
 rows.push({mode,actualCapturedFilename:true,arrayLikeSuffix:true,noIteratorConversion:true,onceOnly:true,fileOwner:mode==='file'});
}
console.log(JSON.stringify({rows,scope:'Actual extracted startup initializer with native Node primordials/realpath/errors and isolated fixture globals; actual guest loader/realm/eval/Worker execution remains unproven.'}));
