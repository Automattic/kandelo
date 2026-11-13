import {readFileSync} from 'node:fs';
export const nativeIsolateFixtureFiles=['tests/nodejs/upstream/native-isolate-controls.ts','tests/nodejs/upstream/options-engine-controls.js','tests/nodejs/upstream/options-shared-controls.js'];
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);function assert(value){if(!value)throw Error('native isolate ownership assertion')}function identity(value){for(const name of ['canonicalIsolateData','stableIdentity','sameIsolate','sameParsedOwner','sameEnvironmentOwner','sameProcessStorage','sameFatalProcessStorage','sameOptionsMutex'])assert(value[name]===true)}`;
const optionsSource=readFileSync(nativeIsolateFixtureFiles[1],'utf8').replace('// @shared-options-controls',readFileSync(nativeIsolateFixtureFiles[2],'utf8'));
const profileSetup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm(),binding=realm.internalBinding('options');`;
const profileErrors=[
 ['primitive-profile-arguments-reject-with-a-real-exception',`try{api.configureOptions(1);throw new Error('unexpected success')}catch(error){if(!error.message.includes('requires an argument array'))throw error}if(api.inspectOptions().configured)throw new Error('unexpected mutation');print('PROFILE_ARGUMENT_REJECTED')`,'PROFILE_ARGUMENT_REJECTED'],
 ['original-cpp-option-error-preserves-terminal-profile-failure',`try{api.configureOptions(['node','--input-type=incorrect']);throw new Error('unexpected success')}catch(error){if(!error.message.includes('--input-type must be'))throw error}if(!api.inspectOptions().failed)throw new Error('profile not failed');try{binding.parseNodeOptionsEnvVar('--x');throw new Error('unexpected reuse')}catch(error){if(!error.message.includes('Previous native options configuration failed'))throw error}print('ORIGINAL_CPP_ERROR_RETAINED')`,'ORIGINAL_CPP_ERROR_RETAINED'],
 ['unsupported-memory-accounting-cannot-publish-a-zero-value',`try{api.configureOptions(['node','--max-old-space-size-percentage=25']);throw new Error('unexpected success')}catch(error){if(error.code!=='ERR_KANDELO_NOT_IMPLEMENTED'||!error.message.includes('real libuv memory accounting'))throw error}if(!api.inspectOptions().failed||api.inspectOptions().serialized)throw new Error('false memory success');print('MEMORY_BOUNDARY_RETAINED')`,'MEMORY_BOUNDARY_RETAINED'],
 ['unimplemented-engine-option-adoption-is-an-error',`try{api.configureOptions(['node','--definitely-not-a-native-option']);throw new Error('unexpected success')}catch(error){if(error.code!=='ERR_KANDELO_NOT_IMPLEMENTED')throw error}if(!api.inspectOptions().failed)throw new Error('false engine success');print('ENGINE_OPTION_REJECTED')`,'ENGINE_OPTION_REJECTED'],
 ['unimplemented-env-file-adoption-is-an-error',`try{api.configureOptions(['node','--env-file=/tmp/missing-node-options.env']);throw new Error('unexpected success')}catch(error){if(error.code!=='ERR_KANDELO_NOT_IMPLEMENTED')throw error}if(!api.inspectOptions().failed)throw new Error('false env-file success');print('ENV_FILE_OPTION_REJECTED')`,'ENV_FILE_OPTION_REJECTED'],
];
const assertionCases=[
 ['original-method-setter-failure-retains-fatal-check',"throw new Error('REGISTRATION_SETTER')",'Original native options method property invariant'],
 ['unimplemented-late-name-inspection-is-an-explicit-fatal-boundary','void value.name','Native option method late naming after inspection is not implemented'],
];
type Result={exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]};
export const nativeIsolateCases=[
 {name:'native-isolate-options-share-real-records-before-and-after-parser-configuration',code:0,stdout:'ISOLATE_OWNER_OK',source:setup+`
 let first=op('isolateOptions');identity(first);assert(first.reportUncaught===false&&first.zeroFill===false&&first.pendingDeprecation===false&&first.hasRetained===false);
 op('isolateHoldOptions');api.configureOptions(['node','--report-uncaught-exception','--zero-fill-buffers','--pending-deprecation','--report-on-fatalerror'],'');gc(undefined,'shrinking');
 const next=op('isolateOptions');identity(next);assert(next.reportUncaught&&next.zeroFill&&next.pendingDeprecation&&next.reportOnFatal&&next.hasRetained&&!next.retainedSame&&next.retainedReport===false);
 let error;try{realm.internalBinding('options').getCLIOptionsValues()}catch(caught){error=caught}assert(error.code==='ERR_OPTIONS_BEFORE_BOOTSTRAPPING'&&api.inspectOptions().serialized===false);
 op('isolateClearOptions');gc(undefined,'shrinking');identity(op('isolateOptions'));assert(op('isolateOptions').hasRetained===false);print('ISOLATE_OWNER_OK');`},
 {name:'native-isolate-options-retain-original-owner-through-reentrant-configuration-and-active-realm',code:0,stdout:'ISOLATE_REENTRY_OK',source:setup+`
 op('isolateHoldOptions');const marker={same:true};
 const result=op('isolateCallOptions',()=>{identity(op('isolateOptions'));api.configureOptions(['node','--report-uncaught-exception'],'');gc(undefined,'shrinking');identity(op('isolateOptions'));return marker});
 identity(result);assert(result.callbackResult===marker&&result.replacedDuringCallback&&!result.beforeReport&&result.reportUncaught&&!result.retainedSame&&!result.retainedReport);
 identity(op('isolateOptionsLocked'));const other=newGlobal({newCompartment:true});api.initializeContext(other);api.initializeRealm(other);gc(undefined,'shrinking');const foreign=op('isolateOptionsForeign',other);identity(foreign);assert(foreign.foreignRestored&&foreign.reportUncaught);op('isolateClearOptions');print('ISOLATE_REENTRY_OK');`},
 {name:'native-isolate-options-preserve-failed-profile-error-without-default-records',code:0,stdout:'ISOLATE_FAILED_OPTIONS_OK',source:setup+`
 let error;try{api.configureOptions(['node','--input-type=incorrect'],'')}catch(caught){error=caught}assert(error&&api.inspectOptions().failed);
 error=undefined;try{op('isolateOptions')}catch(caught){error=caught}assert(error&&error.message.includes('Previous native options configuration failed'));assert(!api.inspectOptions().serialized);print('ISOLATE_FAILED_OPTIONS_OK');`},
 {name:'whole-original-options-parser-and-registration-regressions',code:0,source:optionsSource,validate:(result:Result)=>{
  if(result.exitCode!==0||result.stderr!==''||result.hostDiagnostics.length)throw Error(JSON.stringify(result));
  const d=JSON.parse(result.stdout);if(d.kind!=='native-options-controls'||d.cases!==14||d.failures!==0||d.observations.length!==14||d.observations.some((r:{status:string})=>r.status!=='pass'))throw Error(result.stdout);return d;
 }},
 ...profileErrors.map(([name,source,stdout])=>({name,source:profileSetup+source,code:0,stdout})),
 ...assertionCases.map(([name,setter,assertion])=>({name,source:`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();Object.defineProperty(Object.prototype,'getCLIOptionsValues',{set(value){${setter}},configurable:true});realm.internalBinding('options');print('UNEXPECTED_RETURN')`,code:132,validate:(result:Result)=>{
  if(result.exitCode!==132||!result.stderr.includes(assertion)||result.hostDiagnostics.length!==1||result.stdout.includes('UNEXPECTED_RETURN'))throw Error(JSON.stringify(result));return{status:'expected-source-assertion-trap'};
 }})),
];
