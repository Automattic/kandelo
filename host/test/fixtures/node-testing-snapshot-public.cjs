'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
assert.equal(process.version,'v26.13.0');
const [mode,base,scenario='ordinary']=process.argv.slice(2);assert(['native','candidate'].includes(mode));assert(path.isAbsolute(base));fs.mkdirSync(base,{recursive:true});
let api,options;
if(mode==='native'){api=require('node:test');options={updateSnapshots:require('internal/options').getOptionValue('--test-update-snapshots')}}
else{
 const parser=process.env.SNAPSHOT_CLI_PARSER;assert(parser);
 // --expose-internals exists solely to provide this native component boundary;
 // its guest support is not claimed. The public snapshot flag and remaining
 // actual CLI/user arguments are consumed by the actual compiled parser body.
 const args=process.execArgv.filter(x=>x!=='--expose-internals');
 const actual=JSON.parse(execFileSync(parser,[...args,__filename,...process.argv.slice(2)],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}}));
 ({api,options}=require('./node-testing-snapshot-platform.cjs').create(actual));
 console.log(JSON.stringify({componentParser:actual,guestJsapiExecuted:false,harnessFlagsExcluded:['--expose-internals']}));
}
console.log(JSON.stringify({mode,scenario,options}));
api.snapshot.setResolveSnapshotPath(()=>path.join(base,'values.snapshot'));
api.snapshot.setDefaultSnapshotSerializers([value=>JSON.stringify(value,null,2),text=>'prefix:'+text]);
if(scenario==='ordinary'||scenario==='changed'){
 api.test('snapshot values',t=>{
  t.assert.snapshot({value:scenario==='changed'?999:1,quoted:'` ${literal} \\ line\n'});
  t.assert.snapshot({value:2},{serializers:[value=>'custom:'+value.value]});
 });
 api.test('file snapshot',t=>t.assert.fileSnapshot('file value',path.join(base,'file.txt')));
}else if(scenario==='serializer-error'){
 api.snapshot.setDefaultSnapshotSerializers([()=>{throw Error('deliberate serializer')}]);
 api.test('serializer errors preserve cause',t=>t.assert.throws(()=>t.assert.snapshot({value:1}),error=>{assert.equal(error.code,'ERR_INVALID_STATE');assert.equal(error.cause.message,'deliberate serializer');assert.deepEqual(error.input,{value:1});return true}));
}else if(scenario==='invalid-path'){
 api.snapshot.setResolveSnapshotPath(()=>42);
 api.test('path errors preserve filename',t=>t.assert.throws(()=>t.assert.snapshot(1),{code:'ERR_INVALID_STATE',filename:42,message:'Invalid state: Invalid snapshot filename.'}));
}else if(scenario==='write-error'){
 const dir=path.join(base,'directory-as-file');fs.mkdirSync(dir,{recursive:true});
 api.test('real write errors preserve cause',t=>t.assert.throws(()=>t.assert.fileSnapshot(1,dir),error=>{assert.equal(error.code,'ERR_INVALID_STATE');assert.equal(error.cause.code,'EISDIR');assert.equal(error.filename,dir);return true}));
}else throw Error('Unknown snapshot scenario');
