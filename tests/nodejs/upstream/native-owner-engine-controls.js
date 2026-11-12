'use strict';
const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();
const op=(name,...args)=>api.nativeOwners(name,...args),results=[];
function assert(value,message='native ownership assertion'){if(!value)throw Error(message)}
function check(name,run){const detail=run();results.push({name,status:'pass',detail});}
function collected(){gc();gc();}
check('private-profile-is-explicit-and-does-not-claim-process-startup',()=>{
 assert(op('inspect').diagnosticBuild===true);
 return true;
});
check('multiple-raw-native-references-have-one-deleting-owner',()=>{
 const before=op('inspect');const object=op('create'),a=op('hold',object),b=op('hold',object);
 op('detach',object);op('release',a);assert(op('alive',object));assert(op('inspect').destroyed===before.destroyed);
 op('release',b);assert(!op('alive',object));assert(op('inspect').destroyed===before.destroyed+1);
 assert(op('inspect').retiredBeforeDestructor===before.retiredBeforeDestructor+1);return true;
});
check('native-root-keeps-wrapper-through-gc-and-restores-requested-weakness',()=>{
 const before=op('inspect');let object=op('create');const ref=op('hold',object);object=null;collected();
 assert(op('inspect').destroyed===before.destroyed);op('release',ref);collected();assert(op('inspect').destroyed===before.destroyed+1);return true;
});
check('weakening-with-live-native-reference-cannot-collect-wrapper',()=>{
 const before=op('inspect');let object=op('create');const ref=op('hold',object);op('weak',object);object=null;collected();
 assert(op('inspect').destroyed===before.destroyed);op('release',ref);collected();assert(op('inspect').destroyed===before.destroyed+1);return true;
});
check('clearweak-persists-after-the-last-native-reference',()=>{
 let object=op('create');const ref=op('hold',object);op('strong',object);const weakRecords=op('inspect').weakRecords;
 op('release',ref);assert(op('inspect').weakRecords===weakRecords);collected();assert(op('alive',object));
 op('weak',object);object=null;collected();return true;
});
check('repeated-native-acquisition-does-not-accumulate-weak-records',()=>{
 let object=op('create');const count=op('inspect').weakRecords;
 for(let i=0;i<20;i++){const ref=op('hold',object);op('weak',object);op('release',ref);assert(op('inspect').weakRecords===count)}
 object=null;collected();return 20;
});
check('wrapper-is-retired-before-reentrant-derived-destruction',()=>{
 const before=op('inspect'),object=op('create'),ref=op('hold',object);let callbacks=0;
 op('onDestroy',object,()=>{assert(!op('alive',object));const nested=op('create'),held=op('hold',nested);op('detach',nested);op('release',held);callbacks++});
 op('detach',object);op('release',ref);assert(callbacks===1);assert(op('inspect').destroyed===before.destroyed+2);return callbacks;
});
check('destruction-preserves-the-real-callback-exception',()=>{
 const object=op('create'),ref=op('hold',object),sentinel={ownerFailure:11};op('onDestroy',object,()=>{throw sentinel});op('detach',object);
 let caught;try{op('release',ref)}catch(error){caught=error}assert(caught===sentinel);assert(!op('alive',object));return true;
});
check('gc-defers-native-uv-destruction-until-real-close-completion',()=>{
 const before=op('inspect');let object=op('create',true);object=null;collected();
 const pending=op('inspect');assert(pending.destroyed===before.destroyed);assert(pending.closeRequests===before.closeRequests+1);
 drainJobQueue();const done=op('inspect');assert(done.closed===before.closed+1&&done.destroyed===before.destroyed+1);return true;
});
check('derived-close-reference-aliases-an-existing-base-reference',()=>{
 const before=op('inspect'),object=op('create',true),ref=op('hold',object);op('close',object);drainJobQueue();
 assert(op('alive',object));assert(op('inspect').destroyed===before.destroyed);assert(op('inspect').closed===before.closed+1);
 op('release',ref);assert(!op('alive',object));assert(op('inspect').destroyed===before.destroyed+1);return true;
});
check('last-detached-reference-defers-live-resource-destruction',()=>{
 const before=op('inspect'),object=op('create',true),ref=op('hold',object);
 op('detach',object);op('detach',object);op('release',ref);
 assert(op('alive',object));assert(op('inspect').destroyed===before.destroyed);
 assert(op('inspect').closeRequests===before.closeRequests+1);
 drainJobQueue();assert(!op('alive',object));assert(op('inspect').destroyed===before.destroyed+1);return true;
});
check('retired-and-ordinary-objects-cannot-acquire-native-ownership',()=>{
 const object=op('create'),ref=op('hold',object);op('detach',object);op('release',ref);
 for(const value of [object,{},Object.create(null)]){let caught;try{op('hold',value)}catch(error){caught=error}assert(caught)}return true;
});
collected();const final=op('inspect');assert(final.objects===0&&final.references===0);print(JSON.stringify({results,final,failures:0,startupAccepted:false,diagnosticOnly:true}));
