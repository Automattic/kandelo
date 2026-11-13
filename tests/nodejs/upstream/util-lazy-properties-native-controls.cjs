const {internalBinding}=require('internal/test/binding');
const {defineLazyProperties}=internalBinding('util');
const rows=[];
function outcome(fn){try{const value=fn();return{value:value===undefined?'undefined':value}}catch(error){return{error:{name:error.name,code:error.code,message:error.message}}}}
const missing='internal/kandelo_missing_lazy_probe';
for(const operation of ['keys','descriptor','read','write','delete','freeze']){
 const target={};defineLazyProperties(target,missing,['value']);
 const result=outcome(()=>{
  if(operation==='keys')return Object.keys(target);
  if(operation==='descriptor')return Object.getOwnPropertyDescriptor(target,'value');
  if(operation==='read')return target.value;
  if(operation==='write'){target.value=37;return Object.getOwnPropertyDescriptor(target,'value')}
  if(operation==='delete')return delete target.value;
  Object.freeze(target);return Object.isFrozen(target);
 });rows.push({operation,result});
}
const target={};defineLazyProperties(target,'internal/util/types',['isDate'],false);
rows.push({operation:'valid-nonenumerable-descriptor',result:outcome(()=>{const d=Object.getOwnPropertyDescriptor(target,'isDate');return{writable:d.writable,enumerable:d.enumerable,configurable:d.configurable,valueType:typeof d.value,getType:typeof d.get,same:d.value===require('internal/util/types').isDate,works:d.value(new Date(0))}})});
const assert=require('node:assert/strict');
assert.deepEqual(rows[0].result,{value:['value']});
for(const index of [1,2]){assert.equal(rows[index].result.error.name,'TypeError');assert.match(rows[index].result.error.message,/Missing internal module/)}
assert.deepEqual(rows[3].result,{value:{value:37,writable:true,enumerable:true,configurable:true}});
assert.deepEqual(rows[4].result,{value:true});assert.deepEqual(rows[5].result,{value:true});
assert.deepEqual(rows[6].result,{value:{writable:true,enumerable:false,configurable:true,valueType:'function',getType:'undefined',same:true,works:true}});
process.stdout.write(JSON.stringify({kind:'native-lazy-data-property-probe',cases:7,failures:0,rows})+'\n');
