// These controls require a linked private engine. Compilation is not execution.
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const op=(name,...args)=>api.nativeOwners('template'+name,...args);function collect(){clearKeptObjects();gc(undefined,'shrinking')}function assert(value){if(!value)throw Error('native template assertion')}`;
export const nativeTemplateCases=[
 {name:'native-template-data-and-original-persistent-helper-survive-scopes',code:0,stdout:'TEMPLATE_ROOTS_OK',source:setup+`
 function create(){return op('Create',{value:71})}
 const token=create();collect();collect();const Constructor=op('Get',token);assert(Constructor===op('Get',token));
 assert(Constructor.name==='NativeTemplateProbe'&&Constructor.length===2&&Constructor.echo.name==='echo'&&Constructor.echo.length===0);
 const object=new Constructor();assert(object.read().value===71&&Constructor.echo(object)===object);
 op('Drop',token);collect();assert(object.read().value===71&&new Constructor().read().value===71);
 print('TEMPLATE_ROOTS_OK');`},
 {name:'native-template-signature-rejects-forged-receivers-and-method-construction',code:0,stdout:'TEMPLATE_SIGNATURE_OK',source:setup+`
 const token=op('Create','payload'),Constructor=op('Get',token),object=new Constructor();
 assert(object.read()==='payload'&&object.read.name==='read');
 for(const receiver of [null,undefined,{},Object.create(Constructor.prototype),new Proxy(object,{})]){
   let caught;try{Reflect.apply(object.read,receiver,[])}catch(error){caught=error}assert(caught instanceof TypeError&&caught.message==='Illegal invocation');
 }
 let caught;try{new object.read()}catch(error){caught=error}assert(caught instanceof TypeError);
 const read=object.read;Object.setPrototypeOf(object,null);assert(read.call(object)==='payload');op('Drop',token);
 print('TEMPLATE_SIGNATURE_OK');`},
 {name:'native-template-materializes-per-context-functions-and-shares-explicit-data',code:0,stdout:'TEMPLATE_CONTEXTS_OK',source:setup+`
 const payload={value:83},token=op('Create',payload),other=newGlobal({newCompartment:true});
 const local=op('Get',token),foreign=op('Get',token,other);collect();
 assert(local===op('Get',token)&&foreign===op('Get',token,other)&&local!==foreign&&local.prototype!==foreign.prototype);
 assert(Object.getPrototypeOf(foreign)===other.Function.prototype);
 const object=new foreign();assert(object.read()===payload&&foreign.echo(object)===object);
 const own=new local();let caught;try{Reflect.apply(foreign.prototype.read,{},[])}catch(error){caught=error}assert(caught instanceof other.TypeError);
 assert(foreign.prototype.read.call(own)===payload);op('Drop',token);collect();assert(object.read()===payload);
 print('TEMPLATE_CONTEXTS_OK');`},
 {name:'native-template-callback-propagates-getter-reentry-and-thrown-value',code:0,stdout:'TEMPLATE_REENTRY_OK',source:setup+`
 const token=op('Create',19),Constructor=op('Get',token),object=new Constructor(),thrown={original:true};
 Object.defineProperty(object,'payload',{get(){collect();op('Drop',token);throw thrown}});
 let caught;try{object.read()}catch(error){caught=error}assert(caught===thrown);
 assert(Constructor.echo(thrown)===thrown);print('TEMPLATE_REENTRY_OK');`},
];
