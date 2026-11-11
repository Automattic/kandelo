import {readFileSync} from 'node:fs';
export const bufferMemoryFixture='tests/nodejs/upstream/buffer-memory-engine-controls.js';
export const bufferDetachSharedFixture='tests/nodejs/upstream/buffer-detach-shared-controls.js';
export const bufferMemorySource=readFileSync(bufferMemoryFixture,'utf8').replace('// @shared-buffer-detach-controls',readFileSync(bufferDetachSharedFixture,'utf8'));
export function verifyBufferMemoryResult(result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if(result.exitCode!==0||result.stderr!==''||result.hostDiagnostics.length!==0)throw Error(JSON.stringify({exitCode:result.exitCode,stderr:result.stderr,stdout:result.stdout,hostDiagnostics:result.hostDiagnostics}));
 const detail=JSON.parse(result.stdout);
 if(detail.cases!==23||detail.observations.length!==23||detail.sharedCases!==12||detail.failures!==0||detail.observations.some((row:any)=>row.status!=='pass'))throw Error(JSON.stringify(detail));
 const reference=JSON.parse(readFileSync('tests/nodejs/upstream/buffer-memory-native-reference.json','utf8')).detail;
 if(JSON.stringify(detail.observations.slice(0,12))!==JSON.stringify(reference.observations))throw Error('shared detach observations differ from authenticated native Node');
 if(detail.originalBufferExercisedByThesePrerequisiteControls!==false||detail.upstreamStartup!==false)throw Error('memory prerequisite must not claim Buffer or startup completion');
 return detail;
}
