import {readFileSync} from 'node:fs';
export const aliasedFixture='tests/nodejs/upstream/aliased-engine-controls.js';
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const a=api.aliased('create','Uint8Array',32);api.aliased('write',a,1,37);const b=api.aliased('create','Float64Array',8);globalThis.liveAlias=api.aliased('array',b);api.aliased('weaken',b);print('ALIASED_OWNERS_ARMED');`;
const assertionSetup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const a=api.aliased('create','Uint8Array',32);`;
export const aliasedCases=[
 {name:'whole-original-headers-live-memory-and-gc',source:readFileSync(aliasedFixture,'utf8'),code:0},
 {name:'original-subview-alignment-assertion',source:assertionSetup+`api.aliased('subview',a,'Uint32Array',1,1)`,code:132,trap:true,stderr:'byte_offset'},
 {name:'original-subview-bounds-assertion',source:assertionSetup+`api.aliased('subview',a,'Uint32Array',0,9)`,code:132,trap:true,stderr:'MultiplyWithOverflowCheck'},
 {name:'natural-exit-with-native-alias-owners',source:setup,code:0,stdout:'ALIASED_OWNERS_ARMED'},
 {name:'explicit-quit-with-native-alias-owners',source:setup+'quit(23)',code:23,stdout:'ALIASED_OWNERS_ARMED'},
 {name:'uncaught-error-with-native-alias-owners',source:setup+`throw Error('ALIASED_UNCAUGHT')`,code:3,stdout:'ALIASED_OWNERS_ARMED',stderr:'ALIASED_UNCAUGHT'},
];
export function verifyAliasedResult(control:typeof aliasedCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if('trap'in control){if(result.exitCode!==control.code||!result.stderr.includes(control.stderr!)||result.hostDiagnostics.length!==1)throw Error(JSON.stringify(result));return {status:'expected-source-assertion-trap'}}
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(JSON.stringify(result))}else if(result.stderr!=='')throw Error(JSON.stringify(result));
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(JSON.stringify(result));return {status:'pass'}}
 const detail=JSON.parse(result.stdout);if(detail.failures!==0||detail.cases!==21||detail.observations.length!==21||detail.observations.some((row:any)=>row.status!=='pass')||detail.upstreamStartup!==false)throw Error(JSON.stringify(detail));return detail;
}
