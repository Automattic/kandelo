const {internalBinding}=require('internal/test/binding'),{readFileSync,writeSync}=require('node:fs');
const binding=internalBinding('icu'),collect=()=>gc();
const source=readFileSync(process.argv[2],'utf8')+'\nJSON.stringify({kind:"native-icu-reference",cases:observations.length,failures,observations,widthMatrix,decodeMatrix,legacyConverterAvailability})';
const result=eval(source);writeSync(1,result+'\n');if(JSON.parse(result).failures)process.exitCode=1;
