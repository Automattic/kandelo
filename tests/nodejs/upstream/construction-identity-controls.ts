// Actual construction records, not a GetConstructorName substitute. The latter
// remains undefined until all lookup and built-in construction paths are backed.
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);const identity=value=>op('constructionIdentity',value);function collect(){clearKeptObjects();gc(undefined,'shrinking')}function assert(value){if(!value)throw Error('construction identity assertion')}`;
export const constructionIdentityCases=[
 {name:'engine-construction-records-promote-and-coexist-with-debug-allocation-metadata',code:0,stdout:'CONSTRUCTION_METADATA_OK',source:setup+`
 enableShellAllocationMetadataBuilder();function Constructor(){}const object=new Constructor();
 const metadata=getAllocationMetadata(object);assert(metadata&&typeof metadata==='object'&&identity(object)===Constructor&&getAllocationMetadata(object)===metadata);
 assert(isNurseryAllocated(object));collect();assert(!isNurseryAllocated(object)&&identity(object)===Constructor&&getAllocationMetadata(object)===metadata);
 print('CONSTRUCTION_METADATA_OK');`},
 {name:'engine-records-actual-base-constructor-through-mutation-and-gc',code:0,stdout:'CONSTRUCTION_IDENTITY_OK',source:setup+`
 function Original(){}function Replacement(){}const object=new Original();
 assert(identity(object)===Original);object.constructor=Replacement;Original.prototype.constructor=Replacement;Object.setPrototypeOf(object,null);collect();
 assert(identity(object)===Original);Object.defineProperty(Original,'name',{value:'Changed'});assert(identity(object).name==='Changed');
 let calls=0;Object.defineProperty(Original,'name',{get(){calls++;throw Error('name getter')}});assert(identity(object)===Original&&calls===0);
 Object.freeze(object);collect();assert(identity(object)===Original);print('CONSTRUCTION_IDENTITY_OK');`},
 {name:'engine-does-not-invent-construction-records-for-literals-prototypes-or-newtarget',code:0,stdout:'CONSTRUCTION_SELECTION_OK',source:setup+`
 function Base(){}function Other(){}class Derived extends Base{}
 for(const object of [{},Object.create(Base.prototype),Base.prototype,Reflect.construct(Base,[],Other),new Derived()])assert(identity(object)===undefined);
 assert(identity(new Base())===Base&&identity(new Other())===Other);
 const original=new Other();function ReturnsExisting(){return original}function ReturnsLiteral(){return {}}
 assert(new ReturnsExisting()===original&&identity(original)===Other&&identity(new ReturnsLiteral())===undefined);
 let calls=0;const proxy=new Proxy(new Base(),{get(){calls++;throw Error('get')},getPrototypeOf(){calls++;throw Error('prototype')}});assert(identity(proxy)===undefined&&calls===0);
 print('CONSTRUCTION_SELECTION_OK');`},
 {name:'engine-construction-ephemeron-retains-constructor-only-while-instance-lives',code:0,stdout:'CONSTRUCTION_EPHEMERON_OK',source:setup+`
 let object,constructorRef;
 (()=>{let Constructor=function ActualOwner(){};constructorRef=new WeakRef(Constructor);object=new Constructor();Object.setPrototypeOf(object,null);Constructor=null})();
 collect();assert(constructorRef.deref()!==undefined);assert(identity(object)===constructorRef.deref());
 object=null;collect();collect();assert(constructorRef.deref()===undefined);
 let objectRef;const RootedConstructor=function RootedConstructor(){};
 (()=>{const value=new RootedConstructor();objectRef=new WeakRef(value)})();collect();assert(objectRef.deref()===undefined);
 let cycleRef;(()=>{let instance;class Cycle{self(){return instance}}instance=new Cycle();cycleRef=new WeakRef(instance)})();collect();collect();assert(cycleRef.deref()===undefined);
 print('CONSTRUCTION_EPHEMERON_OK');`},
 {name:'engine-construction-identity-crosses-real-compartments-with-original-function',code:0,stdout:'CONSTRUCTION_REALMS_OK',source:setup+`
 const other=newGlobal({newCompartment:true});const object=other.eval('globalThis.Constructor=class Foreign{};new Constructor');
 assert(identity(object)===other.Constructor);other.Object.setPrototypeOf(object,null);collect();assert(identity(object)===other.Constructor);
 const proxy=new other.Proxy(object,{});assert(identity(proxy)===undefined);print('CONSTRUCTION_REALMS_OK');`},
 {name:'native-template-allocation-records-its-actual-materialized-constructor',code:0,stdout:'CONSTRUCTION_TEMPLATE_OK',source:setup+`
 const token=op('templateCreate',{value:29}),Constructor=op('templateGet',token),object=new Constructor();
 assert(identity(object)===Constructor);Object.setPrototypeOf(object,null);op('templateDrop',token);collect();assert(identity(object)===Constructor);
 function Other(){}const derived=Reflect.construct(Constructor,[],Other);assert(identity(derived)===undefined);
 const other=newGlobal({newCompartment:true}),foreign=op('templateGet',op('templateCreate',11),other),foreignObject=new foreign();collect();assert(identity(foreignObject)===foreign);
 print('CONSTRUCTION_TEMPLATE_OK');`},
];
