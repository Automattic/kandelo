const {internalBinding}=require('internal/test/binding');
const binding=internalBinding('util'),getTypes=()=>require('internal/util/types'),collect=()=>gc();
const observations=[];let failures=0;
function assert(value,message='native lazy data assertion failed'){if(!value)throw Error(message)}
function check(name,callback){try{observations.push({name,status:'pass',detail:callback()??true})}catch(error){failures++;observations.push({name,status:'fail',error:{name:error.name,message:error.message}})}}
// @shared-native-lazy-data-controls
console.log(JSON.stringify({kind:'native-lazy-data-reference',cases:observations.length,failures,observations}));if(failures)process.exitCode=1;
