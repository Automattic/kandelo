'use strict';
const {internalBinding}=require('internal/test/binding'),{readFileSync,writeSync}=require('node:fs');const constants=internalBinding('constants');
const observations=[];let failures=0;
function assertEq(a,b){if(!Object.is(a,b))throw new Error(`actual=${String(a)} expected=${String(b)}`)}
function check(name,fn){try{fn();observations.push({name,status:'pass'})}catch(e){failures++;observations.push({name,status:'fail',error:{name:e.name,message:e.message,stack:e.stack}})}}
eval(readFileSync(process.argv[2],'utf8'));
function snapshot(object){return Object.fromEntries(Object.entries(object).map(([name,value])=>[name,value&&typeof value==='object'?snapshot(value):typeof value==='number'&&!Number.isFinite(value)?{nonfinite:String(value)}:value]))}
writeSync(1,JSON.stringify({kind:'native-constants-reference',cases:observations.length,failures,observations,constants:snapshot(constants)})+'\n');if(failures)process.exitCode=1;
