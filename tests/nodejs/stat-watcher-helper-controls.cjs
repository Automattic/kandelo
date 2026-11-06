'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const make=Function(fs.readFileSync(path.resolve(__dirname,'../../third_party/node-core/node-core.js'),'utf8')+';return _createNodeValuesPlatform;')();
const values=make({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
for(const [name,set]of[['native',require('internal/util').setOwnProperty],['candidate',values.util.setOwnProperty]]){
 let inherited=0;const object=Object.create({set field(value){inherited++;}}),value={sentinel:true};
 assert.equal(set(object,'field',value),value);assert.equal(inherited,0);
 assert.deepEqual(Object.getOwnPropertyDescriptor(object,'field'),{value,writable:true,enumerable:true,configurable:true});
 const failure={sentinel:'define-failed'};const proxy=new Proxy({}, {defineProperty(){throw failure;}});
 assert.throws(()=>set(proxy,'field',value),error=>error===failure);
 assert.throws(()=>set(Object.preventExtensions({}),'field',value),TypeError);
 console.log(JSON.stringify({name,returnedIdentity:true,ownDescriptor:true,inheritedSetters:inherited,originalThrow:true}));
}
