'use strict';
const {internalBinding}=require('internal/test/binding'),{readFileSync,writeSync}=require('node:fs');
const binding=internalBinding('options'),collect=()=>gc();
const observations=[];let failures=0;
function assertEq(a,b){if(!Object.is(a,b))throw new Error(`actual=${String(a)} expected=${String(b)}`)}
function thrown(fn){try{fn()}catch(e){return e}throw new Error('expected failure')}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(e){failures++;observations.push({name,status:'fail',error:{name:e.name,message:e.message,stack:e.stack}})}}
eval(readFileSync(process.argv[2],'utf8'));writeSync(1,JSON.stringify({kind:'native-options-reference',cases:observations.length,failures,observations})+'\n');if(failures)process.exitCode=1;
