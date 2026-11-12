const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();const op=(name,...args)=>api.nativeOwners('persistent'+name,...args);function collect(){clearKeptObjects();gc(undefined,'shrinking')}function assert(value){if(!value)throw Error('persistent handle assertion')}`;
export const persistentHandleCases=[
 {name:'native-persistent-roots-outlive-local-frames-and-moving-gc',code:0,stdout:'PERSISTENT_ROOTS_OK:1:0',source:setup+`
 const sources=[undefined,null,NaN,-0,17,1n,'a\\0\\ud800\\ud83d\\ude42',Symbol('root'),{retained:42},new Uint8Array([3,8])];
 const roots=sources.map(value=>op('Create',value));
 collect();collect();
 roots.forEach((root,index)=>{assert(!op('Empty',root));assert(Object.is(op('Get',root),sources[index]));op('Move',root);assert(Object.is(op('Get',root),sources[index]));op('Drop',root)});
 function createOnlyNativeRoot(){return op('Create',{sole:71})}
 const only=createOnlyNativeRoot(),before=isNurseryAllocated(op('Get',only));assert(before);collect();collect();const after=isNurseryAllocated(op('Get',only));assert(!after&&op('Get',only).sole===71);op('Drop',only);
 print('PERSISTENT_ROOTS_OK:'+Number(before)+':'+Number(after));
 `},
 {name:'native-persistent-weak-edge-clears-and-strengthens-with-real-liveness',code:0,stdout:'PERSISTENT_WEAK_OK',source:setup+`
 function createWeak(){const token=op('Create',{collectible:true});op('Weak',token);return token}
 const weak=createWeak();collect();collect();assert(op('Empty',weak)&&op('Get',weak)===undefined);
 op('Strong',weak);assert(op('Empty',weak));op('Drop',weak);
 function promote(){const target={strong:39},token=op('Create',target);op('Weak',token);collect();assert(op('Get',token)===target);op('Strong',token);return token}
 const live=promote();collect();collect();assert(op('Get',live).strong===39);op('Move',live);assert(op('Get',live).strong===39);
 op('Weak',live);collect();collect();assert(op('Empty',live));op('Drop',live);
 print('PERSISTENT_WEAK_OK');
 `},
 {name:'native-persistent-call-survives-reentry-move-and-own-reset',code:0,stdout:'PERSISTENT_CALL_OK',source:setup+`
 let token,calls=0;
 token=op('Create',()=>{calls++;collect();op('Move',token);op('Drop',token);collect();return 93});
 collect();assert(op('Call',token)===93&&calls===1);
 let rejected=false;try{op('Get',token)}catch(error){rejected=error.message.includes('Unknown persistent control token')}assert(rejected);
 print('PERSISTENT_CALL_OK');
 `},
 {name:'native-persistent-foreign-realm-identity-and-exceptions',code:0,stdout:'PERSISTENT_FOREIGN_OK',source:setup+`
 const other=newGlobal({newCompartment:true});
 const target=other.eval('globalThis.target={foreign:61};target');
 const token=op('Create',target);collect();assert(op('Get',token)===target);op('Weak',token);collect();assert(op('Get',token)===target);op('Strong',token);op('Drop',token);
 const callback=op('Create',other.eval('()=>{gc(undefined,"shrinking");throw target}'));
 let caught;try{op('Call',callback)}catch(error){caught=error}assert(caught===target);op('Drop',callback);
 print('PERSISTENT_FOREIGN_OK');
 `},
];
