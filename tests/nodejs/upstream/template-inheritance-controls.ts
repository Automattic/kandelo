const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const op=(name,...args)=>api.nativeOwners(name,...args);function assert(value){if(!value)throw Error('template inheritance assertion')}function collect(){clearKeptObjects();gc(undefined,'shrinking')}const make=value=>op('templateCreate',value),get=(token,global)=>op('templateGet',token,global),inherit=(child,parent)=>op('templateInherit',child,parent),drop=token=>op('templateDrop',token);`;
export const templateInheritanceCases=[
 {name:'native-template-inheritance-preserves-real-ancestry-and-signatures-through-prototype-mutation',code:0,stdout:'INHERITANCE_ANCESTRY_OK',source:setup+`
 const p=make(10),c=make(20),g=make(30);inherit(c,p);inherit(g,c);const Parent=get(p),Child=get(c),Grandchild=get(g);
 assert(Object.getPrototypeOf(Child.prototype)===Parent.prototype&&Object.getPrototypeOf(Grandchild.prototype)===Child.prototype&&Object.getPrototypeOf(Child)===Function.prototype);
 const parent=new Parent(),child=new Child(),grandchild=new Grandchild();assert(child instanceof Parent&&grandchild instanceof Child&&grandchild instanceof Parent);
 const read=Parent.prototype.read;assert(read.call(child)===20&&read.call(grandchild)===30&&Child.prototype.read.call(grandchild)===30);
 for(const value of [{},Object.create(Child.prototype),new Proxy(child,{})]){let error;try{read.call(value)}catch(caught){error=caught}assert(error instanceof TypeError&&error.message==='Illegal invocation')}
 let error;try{Grandchild.prototype.read.call(parent)}catch(caught){error=caught}assert(error instanceof TypeError);
 Object.setPrototypeOf(child,null);Object.setPrototypeOf(grandchild,null);collect();assert(read.call(child)===20&&read.call(grandchild)===30);
 class JavaScriptChild extends Grandchild{}assert(read.call(new JavaScriptChild())===30);drop(p);drop(c);drop(g);collect();assert(read.call(child)===20);print('INHERITANCE_ANCESTRY_OK');`},
 {name:'native-template-inheritance-materializes-context-local-parent-prototypes-with-shared-native-signatures',code:0,stdout:'INHERITANCE_REALMS_OK',source:setup+`
 const p=make(41),c=make(43);inherit(c,p);const other=newGlobal({newCompartment:true});const Parent=get(p),Child=get(c),ForeignParent=get(p,other),ForeignChild=get(c,other);
 assert(Child!==ForeignChild&&ForeignChild===get(c,other)&&Object.getPrototypeOf(ForeignChild.prototype)===ForeignParent.prototype&&Object.getPrototypeOf(ForeignChild)===other.Function.prototype);
 const local=new Child(),foreign=new ForeignChild();collect();assert(Parent.prototype.read.call(foreign)===43&&ForeignParent.prototype.read.call(local)===43);
 let error;try{ForeignParent.prototype.read.call({})}catch(caught){error=caught}assert(error instanceof other.TypeError);drop(p);drop(c);collect();assert(ForeignParent.prototype.read.call(foreign)===43);print('INHERITANCE_REALMS_OK');`},
 {name:'native-template-inheritance-uses-current-parent-prototype-without-copying-static-or-instance-data',code:0,stdout:'INHERITANCE_PROPERTIES_OK',source:setup+`
 const p=make(51),unused=make(52),c=make(53);op('templateSetData',p,'parentStatic',1);op('templateSetData',p,'parentInstance',2,'instance');op('templateSetData',c,'childInstance',3,'instance');
 inherit(c,unused);inherit(c,p);const Parent=get(p),read=Parent.prototype.read,replacement=Object.create(null);replacement.marker=7;Parent.prototype=replacement;const Child=get(c);
 assert(Object.getPrototypeOf(Child.prototype)===replacement&&Object.getPrototypeOf(Child)===Function.prototype&&Child.parentStatic===undefined);
 const child=new Child();assert(child.childInstance===3&&child.parentInstance===undefined&&child.marker===7&&read.call(child)===53);
 let calls=[];Object.defineProperty(Child.prototype,'payload',{set(value){calls.push(value);collect()},configurable:true});new Child();assert(JSON.stringify(calls)==='[53]');drop(p);drop(unused);drop(c);print('INHERITANCE_PROPERTIES_OK');`},
 {name:'native-template-inheritance-traces-unmaterialized-parent-and-releases-dead-hierarchy',code:0,stdout:'INHERITANCE_ROOTS_OK',source:setup+`
 const held=(()=>{const payload={parent:true},weak=new WeakRef(payload),p=make(payload),c=make(61);inherit(c,p);drop(p);return{token:c,weak}})();collect();assert(held.weak.deref().parent===true);drop(held.token);collect();assert(held.weak.deref()===undefined);print('INHERITANCE_ROOTS_OK');`},
 {name:'native-template-inherited-callback-preserves-reentrant-gc-and-exact-thrown-value',code:0,stdout:'INHERITANCE_REENTRY_OK',source:setup+`
 const p=make(71),c=make(73);inherit(c,p);const Parent=get(p),Child=get(c),object=new Child(),marker={same:true};let calls=0;
 Object.defineProperty(object,'payload',{get(){calls++;drop(p);drop(c);collect();throw marker}});let error;try{Parent.prototype.read.call(object)}catch(caught){error=caught}assert(error===marker&&calls===1);
 collect();assert(Parent.prototype.read.call(new Child())===73);print('INHERITANCE_REENTRY_OK');`},
];
