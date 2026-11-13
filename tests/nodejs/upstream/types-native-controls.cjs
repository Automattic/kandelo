'use strict';
const {internalBinding}=require('internal/test/binding'),{readFileSync,writeSync}=require('node:fs'),vm=require('node:vm');
const types=internalBinding('types'),addon=require(process.argv[2]),external=addon.external,DOMExceptionForTest=DOMException;
const detach=value=>structuredClone(value,{transfer:[value]}),collect=()=>gc(),readExternal=value=>addon.read(value);
const observations=[];let failures=0;
function assertEq(a,b){if(!Object.is(a,b))throw new Error(`actual=${String(a)} expected=${String(b)}`)}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(e){failures++;observations.push({name,status:'fail',error:{name:e.name,message:e.message,stack:e.stack}})}}
(async()=>{const module=new vm.SourceTextModule('export const value=7');await module.link(()=>{throw new Error('unexpected import')});await module.evaluate();const namespace=module.namespace;
const code=readFileSync(process.argv[3],'utf8')+'\nJSON.stringify({kind:"native-types-reference",cases:observations.length,failures,observations,classificationMatrix})';const result=eval(code);writeSync(1,result+'\n');if(failures)process.exitCode=1;})();
