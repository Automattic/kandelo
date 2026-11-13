import {readFileSync} from 'node:fs';
export const environmentFixture='tests/nodejs/upstream/environment-engine-controls.js';
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();`;
export const environmentCases=[
 {name:'native-environment-ownership-and-foreground-controls',source:readFileSync(environmentFixture,'utf8'),code:0},
 {name:'natural-exit-cleans-native-resources-and-drains-cleanup-work',source:setup+`api.environment('post',5);api.environment('armExit');`,code:0,stdout:'ENVIRONMENT_CLEANUP_DONE'},
 {name:'quit-preserves-status-and-cleans-native-resources',source:setup+`api.environment('postThreads',3);api.environment('armExit');quit(23);`,code:23,stdout:'ENVIRONMENT_CLEANUP_DONE'},
 {name:'uncaught-error-keeps-real-failure-and-cleans-native-resources',source:setup+`api.environment('armExit');throw Error('ENVIRONMENT_UNCAUGHT');`,code:3,stdout:'ENVIRONMENT_CLEANUP_DONE',stderr:'ENVIRONMENT_UNCAUGHT'},
];
export function verifyEnvironmentResult(control:typeof environmentCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if(result.exitCode!==control.code||result.hostDiagnostics.length!==0)throw Error(JSON.stringify({exitCode:result.exitCode,stderr:result.stderr,stdout:result.stdout,hostDiagnostics:result.hostDiagnostics}));
 if('stderr' in control){if(!result.stderr.includes(control.stderr!))throw Error(result.stderr)}else if(result.stderr!=='')throw Error(result.stderr);
 if('stdout' in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return {status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(detail.cases!==14||detail.observations.length!==14||detail.failures!==0||detail.observations.some((row:any)=>row.status!=='pass'))throw Error(JSON.stringify(detail));
 if(detail.originalBufferExercisedByThesePrerequisiteControls!==false||detail.upstreamStartup!==false)throw Error('environment prerequisite must not claim original Buffer/startup completion');
 return detail;
}
