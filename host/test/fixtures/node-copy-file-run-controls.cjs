'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {create}=require('./node-copy-file-platform.cjs');
const controls=require('./node-copy-file-controls.cjs');
(async()=>{
  const results=[];
  for(const [name,run] of Object.entries(controls)) {
    const actual=await run(create()),expected=await run({api:fs,promises:fs.promises});
    assert.deepEqual(actual,expected,name);results.push({name,result:actual});
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,frontend:true,results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
