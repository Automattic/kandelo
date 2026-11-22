const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const op=(mode,target)=>api.nativeOwners('executionPolicy',mode,target);function assert(value){if(!value)throw Error('execution scope assertion')}function denied(callback){let error;try{callback()}catch(caught){error=caught}assert(error==='illegal access')}`;
type Result={exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]};
export const executionScopeCases=[
 {name:'engine-execution-scope-rejects-raw-call-construction-getter-and-script-entry',code:0,stdout:'EXECUTION_DENIAL_OK',source:setup+`
 let effects=0;const callback=()=>++effects;
 denied(()=>op('throw-call',callback));denied(()=>op('throw-call',Date.now));
 denied(()=>op('throw-call',new Proxy(callback,{apply(){effects++;return 17}})));
 denied(()=>op('throw-construct',new Proxy(function Target(){effects++},{construct(){effects++;return {}}})));
 denied(()=>op('throw-getter',{get value(){effects++;return 19}}));
 assert(op('throw-getter',{value:93})===93);
 delete globalThis.__executionScopeReached;denied(()=>op('throw-script'));
 assert(effects===0&&!Object.prototype.hasOwnProperty.call(globalThis,'__executionScopeReached'));
 assert(op('call',callback)===1&&effects===1);print('EXECUTION_DENIAL_OK');`},
 {name:'engine-execution-scopes-compose-allow-reentry-and-restore-after-errors',code:0,stdout:'EXECUTION_NESTING_OK',source:setup+`
 let effects=0;const marker={same:true},callback=()=>{effects++;gc();return marker};
 assert(op('allow-call',callback)===marker&&effects===1);
 denied(()=>op('allow-then-throw',callback));assert(effects===2);
 assert(op('allow-call',()=>{denied(()=>op('nested-throw',callback));return op('allow-call',()=>marker)})===marker&&effects===2);
 let error;try{op('allow-call',()=>{throw marker})}catch(caught){error=caught}assert(error===marker);
 denied(()=>op('nested-throw',callback));assert(effects===2&&op('call',callback)===marker&&effects===3);
 assert(op('allow-crash',callback)===marker&&effects===4);print('EXECUTION_NESTING_OK');`},
 {name:'engine-execution-policy-covers-foreign-realms-and-native-entry-without-frame',code:0,stdout:'EXECUTION_CONTEXT_OK',source:setup+`
 const other=newGlobal({newCompartment:true});other.eval('globalThis.effects=0;globalThis.marker={foreign:true}');
 const foreign=other.eval('()=>{effects++;return marker}'),marker=other.marker;
 denied(()=>op('throw-call',foreign));assert(other.effects===0);
 assert(op('allow-call',foreign)===marker&&other.effects===1);
 let effects=0;denied(()=>op('throw-no-frame',()=>++effects));assert(effects===0);
 assert(op('call',()=>++effects)===1);gc(undefined,'shrinking');assert(op('allow-call',foreign)===marker&&other.effects===2);
 print('EXECUTION_CONTEXT_OK');`},
 // Focused diagnostics only: exit status 134 is insufficient SIGABRT evidence.
 // The formal gate must also observe the real guest wait/signal result.
 {name:'engine-execution-crash-scope-aborts-before-running-javascript',code:134,source:setup+`
 op('crash',()=>print('UNEXPECTED_EXECUTION'));print('UNEXPECTED_RETURN');`,validate:(result:Result)=>{
  if(result.exitCode!==134||!result.stderr.includes('Invoke in DisallowJavascriptExecutionScope')||result.hostDiagnostics.length!==0||result.stdout.includes('UNEXPECTED_'))throw Error(JSON.stringify(result));
  return {status:'expected-native-fatal-abort-status',diagnosticOnly:true,guestSignalAccepted:false};
 }},
];
