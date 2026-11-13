import {readFileSync} from 'node:fs';
export const propertyCallbackFixture='tests/nodejs/upstream/property-callback-engine-controls.js';
const source=readFileSync(propertyCallbackFixture,'utf8').replace('// @shared-native-data-controls',readFileSync('tests/nodejs/upstream/native-data-shared-controls.js','utf8'));
const retained=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const target={};__kandeloUpstreamTest.defineNativeProperty(target,'value',()=>{throw Error('MUST_NOT_READ_ON_EXIT')},undefined);print('PROPERTY_CALLBACK_ARMED');`;
export const propertyCallbackCases=[
 {name:'live-property-callback-semantics-gc-and-reentrancy',source,code:0},
 {name:'property-callback-promise-jobs-drain-on-exit',source:`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const target={};__kandeloUpstreamTest.defineNativeProperty(target,'value',()=>Promise.resolve().then(()=>print('PROPERTY_CALLBACK_JOB_DONE')),undefined);target.value;`,code:0,stdout:'PROPERTY_CALLBACK_JOB_DONE'},
 {name:'natural-exit-does-not-read-property-callback',source:retained,code:0,stdout:'PROPERTY_CALLBACK_ARMED'},
 {name:'explicit-quit-does-not-read-property-callback',source:retained+'quit(23)',code:23,stdout:'PROPERTY_CALLBACK_ARMED'},
 {name:'uncaught-error-does-not-read-property-callback',source:retained+`throw Error('PROPERTY_CALLBACK_UNCAUGHT')`,code:3,stdout:'PROPERTY_CALLBACK_ARMED',stderr:'PROPERTY_CALLBACK_UNCAUGHT'},
];
export function verifyPropertyCallbackResult(control:typeof propertyCallbackCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(result.stderr)}else if(result.stderr!=='')throw Error(result.stderr);
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return{status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(detail.cases!==35||detail.sharedCases!==12||detail.failures||detail.observations.some((r:any)=>r.status!=='pass')||detail.upstreamStartup!==false)throw Error(JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/native-data-native-reference.json','utf8'));
 if(JSON.stringify(detail.observations.slice(0,12))!==JSON.stringify(native.observations))throw Error('native data property observations differ from authenticated Node reference');
 detail.exactNativeGroups=12;return detail;
}
