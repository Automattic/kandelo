const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const op=(name,...args)=>api.nativeOwners('cleanup'+name,...args);function assert(value){if(!value)throw Error('original cleanup queue assertion')}function order(){return op('Inspect').order}`;
type Result={exitCode:number;stdout:string;stderr:string;hostDiagnostics:unknown[]};
export const cleanupQueueCases=[
 {name:'original-cleanup-queue-keeps-reverse-registration-order-and-removal',code:0,stdout:'CLEANUP_ORDER_OK',source:setup+`
 const first=op('Create','first'),second=op('Create','second'),third=op('Create','third');
 for(const id of [first,second,third])op('Arm',id);op('Remove',second);op('Remove',second);
 assert(!op('Inspect').empty&&order().length===0);op('Drain');assert(op('Inspect').empty&&JSON.stringify(order())===JSON.stringify([third,first]));
 op('Drain');assert(order().length===2);print('CLEANUP_ORDER_OK');`},
 {name:'original-cleanup-queue-honors-removal-by-an-earlier-cleanup-callback',code:0,stdout:'CLEANUP_CANCEL_DURING_DRAIN_OK',source:setup+`
 const first=op('Create','first'),second=op('Create','second'),remover=op('Create','remove');
 op('Arm',first);op('Arm',second);op('Arm',remover,'remove',first);op('Drain');
 assert(op('Inspect').empty&&JSON.stringify(order())===JSON.stringify([remover,second]));print('CLEANUP_CANCEL_DURING_DRAIN_OK');`},
 {name:'original-cleanup-queue-defers-new-callbacks-to-the-next-drain',code:0,stdout:'CLEANUP_REENTRY_OK',source:setup+`
 const first=op('Create','first'),late=op('Create','late'),adder=op('Create','add');
 op('Arm',first);op('Arm',adder,'add',late);op('Drain');
 assert(!op('Inspect').empty&&JSON.stringify(order())===JSON.stringify([adder,first]));gc(undefined,'shrinking');op('Drain');
 assert(op('Inspect').empty&&JSON.stringify(order())===JSON.stringify([adder,first,late]));print('CLEANUP_REENTRY_OK');`},
 ...[false,true].map(quit=>({name:'real-environment-'+(quit?'quit':'natural-exit')+'-drains-original-cleanup-hooks-until-empty',code:quit?23:0,stdout:'CLEANUP_PENDING\nCLEANUP_HOOK:late',source:setup+`
 const late=op('Create','late',true),adder=op('Create','adder');op('Arm',adder,'add',late);print('CLEANUP_PENDING');${quit?'quit(23);':''}`,
 })),
 {name:'real-environment-drains-native-hooks-registered-during-realm-object-retirement',code:0,stdout:'RETIREMENT_PENDING\nCLEANUP_HOOK:retired',source:setup+`
 const object=api.nativeOwners('create'),hook=op('Create','retired',true);op('OnDestroy',hook,object);print('RETIREMENT_PENDING');`},
 {name:'original-cleanup-queue-preserves-duplicate-registration-assertion',code:132,source:setup+`
 const hook=op('Create','duplicate');op('Arm',hook);op('Duplicate',hook);print('UNEXPECTED_RETURN');`,validate:(result:Result)=>{
  if(result.exitCode!==132||!result.stderr.includes('insertion_info.second')||result.hostDiagnostics.length!==1||result.stdout.includes('UNEXPECTED_RETURN'))throw Error(JSON.stringify(result));
  return {status:'expected-original-cleanup-assertion-trap'};
 }},
];
