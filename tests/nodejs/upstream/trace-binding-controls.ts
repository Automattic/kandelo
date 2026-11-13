import {readFileSync} from 'node:fs';

export const traceBindingSetup=String.raw`
const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();
api.configureOptions(['node','--trace-event-file-pattern=/tmp/trace-binding-\u0024{pid}-\u0024{rotation}.json'],'');
const binding=realm.internalBinding('trace_events'),collect=()=>gc('shrinking');
api.traceAgent('start');
`;
export const sharedFixturePath='tests/nodejs/upstream/trace-binding-shared-controls.js';
export const engineFixturePath='tests/nodejs/upstream/trace-binding-engine-controls.js';
export const traceBindingSource=traceBindingSetup+readFileSync(engineFixturePath,'utf8').replace(
  '// @shared-trace-binding-controls',readFileSync(sharedFixturePath,'utf8'));

function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message)}
export function verifyTraceBindingResult(result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}) {
  assert(result.exitCode===0&&result.stderr===''&&result.hostDiagnostics.length===0,JSON.stringify(result));
  const detail=JSON.parse(result.stdout);
  assert(detail.cases===29&&detail.sharedCases===21&&detail.failures===0&&detail.observations.every((row:any)=>row.status==='pass'),JSON.stringify(detail));
  const native=JSON.parse(readFileSync('tests/nodejs/upstream/trace-binding-native-reference.json','utf8'));
  assert(JSON.stringify(detail.observations.slice(0,detail.sharedCases))===JSON.stringify(native.detail.observations),'shared observations differ from pinned native Node');
  const projection=detail.traceFile.traceEvents.filter((event:any)=>event.cat.startsWith('trace.')).map((event:any)=>Object.fromEntries(
    ['cat','name','ph','id','args'].filter(key=>Object.hasOwn(event,key)).map(key=>[key,event[key]])));
  assert(JSON.stringify(projection)===JSON.stringify(native.traceProjection),'actual guest file events differ from pinned native Node');
  return detail;
}

export const traceBindingCases=[
  {name:'binding-and-ownership-controls',source:traceBindingSource,code:0},
  ...[
    ['source-constructor-array-check','new binding.CategorySet(3)','args[0]->IsArray()'],
    ['source-proxy-array-check',"new binding.CategorySet(new Proxy(['x'],{}))",'args[0]->IsArray()'],
    ['source-handler-function-check','binding.setTraceCategoryStateUpdateHandler(3)','args[0]->IsFunction()'],
    ['source-category-buffer-string-check','binding.getCategoryEnabledBuffer(3)','args[0]->IsString()'],
    ['original-json-undefined-result-cast',"const owner=new binding.CategorySet(['trace.json']);owner.enable();binding.trace(105,'trace.json','function-data',undefined,()=>{})",'value->IsString()'],
  ].map(([name,source,diagnostic])=>({name,source:traceBindingSetup+source+";print('UNEXPECTED_RETURN');",code:132,diagnostic})),
  ...[
    ['natural-exit',0,''],['quit-status',23,'quit(23);'],['uncaught-status',3,"throw Error('TRACE_BINDING_UNCAUGHT');"],
  ].map(([name,code,tail])=>({name:String(name),code:Number(code),source:traceBindingSetup+`
const owner=new binding.CategorySet(['engine.exit']);owner.enable();binding.trace(105,'engine.exit','exit-event',undefined,{value:7});owner.disable();
api.traceAgent('armExit');binding.setTraceCategoryStateUpdateHandler(()=>{throw Error('SHUTDOWN_CALLED_JS')});print('TRACE_BINDING_EXIT_READY');`+tail,
    lifecycle:true,...(name==='uncaught-status'?{stderr:'TRACE_BINDING_UNCAUGHT'}:{})})),
];
export function verifyTraceBindingCase(control:typeof traceBindingCases[number],result:{exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]}) {
  if(control.name==='binding-and-ownership-controls')return verifyTraceBindingResult(result);
  assert(result.exitCode===control.code,JSON.stringify(result));
  if('diagnostic' in control){
    assert(result.stderr.includes(control.diagnostic!)&&result.hostDiagnostics.length===1&&!result.stdout.includes('UNEXPECTED_RETURN'),JSON.stringify(result));
    return {fatal:true};
  }
  assert(result.hostDiagnostics.length===0,JSON.stringify(result));
  if('stderr' in control)assert(result.stderr.includes(control.stderr!),JSON.stringify(result));
  else assert(result.stderr==='',JSON.stringify(result));
  const lines=result.stdout.trim().split('\n');
  assert(lines.length===2&&lines[0]==='TRACE_BINDING_EXIT_READY'&&lines[1].startsWith('TRACE_AGENT_EXIT '),JSON.stringify(result));
  const trace=JSON.parse(lines[1].slice('TRACE_AGENT_EXIT '.length));
  const events=trace.traceEvents.filter((event:any)=>event.name==='exit-event');
  assert(events.length===1&&events[0].args.data.value===7,'shutdown did not flush the actual source event');
  return {events:events.length};
}
