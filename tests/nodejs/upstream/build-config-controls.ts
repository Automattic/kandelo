import {readFileSync} from 'node:fs';
export const buildConfigFixture='tests/nodejs/upstream/build-config-engine-controls.js',buildConfigSharedFixture='tests/nodejs/upstream/build-config-shared-controls.js';
const marker='// @shared-build-config-controls',prefix=readFileSync(buildConfigFixture,'utf8');if(prefix.split(marker).length!==2)throw Error('build config fixture marker must occur once');
const source=prefix.replace(marker,readFileSync(buildConfigSharedFixture,'utf8'));
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),builtins=realm.internalBinding('builtins');`;
const retained=setup+`globalThis.retainedBuildConfiguration=builtins;print('BUILD_CONFIG_ARMED');`;
export const buildConfigCases=[
 {name:'native-build-configuration-data-and-producer-facts',source,code:0},
 {name:'original-principal-freezes-real-build-config-before-next-gap',source:setup+`let error;try{api.runNodeBootstrap()}catch(caught){error={name:caught.name,code:caught.code,message:caught.message,stack:caught.stack}}const config=realm.process.config;print(JSON.stringify({error,phase:api.inspectRealm().nodeBootstrapPhase,configuration:config,descriptor:Object.getOwnPropertyDescriptor(realm.process,'config'),frozen:!!config&&Object.isFrozen(config),variablesFrozen:!!config&&Object.isFrozen(config.variables),libraryFilesFrozen:!!config&&Object.isFrozen(config.variables.node_library_files),startupAccepted:false}));`,code:0},
 {name:'configuration-read-in-real-promise-job-drains-naturally',source:setup+`Promise.resolve().then(()=>print('BUILD_CONFIG_JOB '+JSON.parse(builtins.config).variables.target_arch));`,code:0,stdout:'BUILD_CONFIG_JOB wasm32'},
 {name:'natural-exit-with-unread-native-configuration',source:retained,code:0,stdout:'BUILD_CONFIG_ARMED'},
 {name:'explicit-quit-with-unread-native-configuration',source:retained+'quit(23)',code:23,stdout:'BUILD_CONFIG_ARMED'},
 {name:'uncaught-error-with-unread-native-configuration',source:retained+`throw Error('BUILD_CONFIG_UNCAUGHT')`,code:3,stdout:'BUILD_CONFIG_ARMED',stderr:'BUILD_CONFIG_UNCAUGHT'},
];
export function verifyBuildConfigResult(control:typeof buildConfigCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}){
 if(result.exitCode!==control.code||result.hostDiagnostics.length)throw Error(JSON.stringify(result));
 if('stderr'in control){if(!result.stderr.includes(control.stderr!))throw Error(result.stderr)}else if(result.stderr)throw Error(result.stderr);
 if('stdout'in control){if(result.stdout.trim()!==control.stdout)throw Error(result.stdout);return{status:'pass'}}
 const detail=JSON.parse(result.stdout);
 if(control.name==='original-principal-freezes-real-build-config-before-next-gap'){
  if(detail.error?.name!=='Error'||detail.error?.code!=='ERR_KANDELO_NOT_IMPLEMENTED'||detail.error?.message!=="Native Node binding 'messaging' is not implemented"||!detail.error.stack.includes('node:internal/bootstrap/node:149:')||!detail.error.stack.includes('node:internal/worker/js_transferable:21:')||detail.phase!==3||!detail.frozen||!detail.variablesFrozen||!detail.libraryFilesFrozen||detail.startupAccepted!==false)throw Error(JSON.stringify(detail));
  if(detail.descriptor.writable!==false||detail.descriptor.enumerable!==true||detail.descriptor.configurable!==true)throw Error(JSON.stringify(detail));return detail;
 }
 if(detail.cases!==15||detail.sharedCases!==9||detail.failures||detail.upstreamStartup!==false||detail.observations.some((r:any)=>r.status!=='pass'))throw Error(JSON.stringify(detail));
 const native=JSON.parse(readFileSync('tests/nodejs/upstream/build-config-native-reference.json','utf8')).detail;
 if(JSON.stringify(detail.observations.slice(0,9))!==JSON.stringify(native.observations))throw Error('native build configuration property observations differ from authenticated reference');
 const manifest=JSON.parse(readFileSync('third_party/nodejs/sources.json','utf8'));
 const expected=manifest.files.filter((r:any)=>r.builtinId&&r.path.startsWith('lib/')).map((r:any)=>r.path).sort();
 if(JSON.stringify([...detail.configuration.variables.node_library_files].sort())!==JSON.stringify(expected))throw Error('runtime library inventory differs from authenticated build source manifest');
 detail.exactNativeGroups=9;return detail;
}
