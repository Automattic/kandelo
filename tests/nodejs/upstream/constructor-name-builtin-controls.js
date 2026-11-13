const name=__constructorName;
const rows=[];const record=(key,object)=>rows.push({key,name:name(object)});
for(const Builtin of [Object,Array,Date,Map,Set,Error,TypeError,ArrayBuffer,Uint8Array]){
  const originalName=Object.getOwnPropertyDescriptor(Builtin,'name');
  const make=()=>Builtin===ArrayBuffer||Builtin===Uint8Array?new Builtin(3):new Builtin();
  const object=make();record('before-'+originalName.value,object);
  Object.defineProperty(Builtin,'name',{value:'Renamed'+originalName.value,configurable:true});
  record('after-name-'+originalName.value,object);record('after-name-new-'+originalName.value,make());
  if(Builtin===Object){record('renamed-object-literal',{});record('renamed-object-create-null',Object.create(null));record('renamed-object-create-proto',Object.create({}));}
  if(Builtin===Array)record('renamed-array-literal',[]);
  Object.defineProperty(Builtin,'name',originalName);
  Object.setPrototypeOf(object,null);record('null-prototype-'+originalName.value,object);
  function Other(){};Other.prototype.constructor=function Third(){};
  const reflected=Reflect.construct(Builtin,Builtin===ArrayBuffer||Builtin===Uint8Array?[3]:[],Other);record('different-newtarget-'+originalName.value,reflected);
}
for(const Base of [Object,Array,Date,Map,Set,Error,ArrayBuffer,Uint8Array]){
  class Derived extends Base{};const object=Reflect.construct(Derived,Base===ArrayBuffer||Base===Uint8Array?[3]:[]);Derived.prototype.constructor=function Third(){};record('derived-'+Base.name,object);
}
print(JSON.stringify({rows}));
