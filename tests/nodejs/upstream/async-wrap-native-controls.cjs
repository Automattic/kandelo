'use strict';
const {internalBinding}=require('internal/test/binding'),{readFileSync,writeSync}=require('node:fs');
const binding=internalBinding('async_wrap'),internalHooks=require('internal/async_hooks');
const symbols=internalBinding('symbols'),rejectionQueue=internalBinding('task_queue');
const observations=[];let failures=0;
function assertEq(actual,expected){if(!Object.is(actual,expected))throw new Error(`actual=${String(actual)} expected=${String(expected)}`)}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
// The same assertions exercise native bindings and the whole native module.
eval(readFileSync(process.argv[2],'utf8'));
binding.clearAsyncIdStack();
writeSync(1,JSON.stringify({kind:'native-async-wrap-reference',cases:observations.length,failures,observations,constants:binding.constants,providers:binding.Providers})+'\n');
if(failures)process.exitCode=1;
