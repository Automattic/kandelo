const {internalBinding}=require('internal/test/binding'),{readFileSync,writeSync}=require('node:fs');
const binding=internalBinding('string_decoder'),collect=()=>gc(),detachBuffer=buffer=>structuredClone(buffer,{transfer:[buffer]});
const code=readFileSync(process.argv[2],'utf8')+'\nJSON.stringify({kind:"native-decoder-reference",cases:observations.length,failures,observations,matrix})';
const result=eval(code);writeSync(1,result+'\n');if(JSON.parse(result).failures)process.exitCode=1;
