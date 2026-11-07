import type {Page} from "@playwright/test";
/** Only scalar observations cross this owned control port. Renderer, registry
 * and guest memory stay inside the disposable kernel realm. */
export async function installResetRetirementProbe(page:Page,mode:string):Promise<void>{
 await page.evaluate(mode=>{
  const ActualWorker=globalThis.Worker,ports:MessagePort[]=[],urls:string[]=[];
  class ControlledWorker extends ActualWorker{
   pending!:MessagePort|null;
   constructor(url:string|URL,options?:WorkerOptions){
    if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
    const entry=new URL(String(url),location.href).href,registryUrl=new URL("./webgl/registry.ts",entry).href;
    const source=`
const entry=${JSON.stringify(entry)},registryUrl=${JSON.stringify(registryUrl)},mode=${JSON.stringify(mode)},OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),entry),options);}};
const early=[],hold=e=>{e.stopImmediatePropagation();early.push(e.data);};addEventListener('message',hold);
let registry=null,destroyCalls=0,lost=false,oom=false,injections=0,unavailable=false,scopeRefusals=0,publishing=false;
const programs=new Map(),shaders=new Map();let created=0,deleted=0;
const proto=WebGL2RenderingContext.prototype,getError=proto.getError,isProgram=proto.isProgram,isShader=proto.isShader;
for(const [makeName,dropName,objects] of [['createProgram','deleteProgram',programs],['createShader','deleteShader',shaders]]){
 const make=proto[makeName],drop=proto[dropName];
 proto[makeName]=function(...args){const object=Reflect.apply(make,this,args);if(object){objects.set(object,this);created++;}return object;};
 proto[dropName]=function(object){Reflect.apply(drop,this,[object]);if(objects.delete(object))deleted++;};
}
proto.getError=function(){if(oom&&publishing){oom=false;injections++;return 0x505;}return Reflect.apply(getError,this,[]);};
const {GlProgramJournal}=await import(new URL('./program-journal.ts',registryUrl).href),publish=GlProgramJournal.prototype.publish;
GlProgramJournal.prototype.publish=function(...args){publishing=true;try{return Reflect.apply(publish,this,args);}finally{publishing=false;}};
const {GlContextRegistry}=await import(registryUrl),get=GlContextRegistry.prototype.get,drop=GlContextRegistry.prototype.destroyContext;
GlContextRegistry.prototype.get=function(...args){registry=this;return Reflect.apply(get,this,args);};
GlContextRegistry.prototype.destroyContext=function(...args){destroyCalls++;return Reflect.apply(drop,this,args);};
const instantiate=WebAssembly.instantiate;
WebAssembly.instantiate=async function(source,imports){
 if(!imports?.env?.host_gl_query)return Reflect.apply(instantiate,WebAssembly,[source,imports]);
 const query=imports.env.host_gl_query,env={...imports.env,host_gl_query(...args){
  if(args[1]===0x37&&unavailable){scopeRefusals++;return -5;}return Reflect.apply(query,imports.env,args);
 }};return Reflect.apply(instantiate,WebAssembly,[source,{...imports,env}]);
};
addEventListener('message',event=>{const port=event.data?.__resetRetirementControl;if(!port)return;
 port.onmessage=event=>{if(event.data.command==='lose'){
   if(mode.startsWith('logical-'))oom=true;
   else{const binding=registry?.list().find(b=>b.gl&&b.contextId!==null),gl=binding?.gl,extension=gl?.getExtension('WEBGL_lose_context');
    if(extension){extension.loseContext();lost=gl.isContextLost();}}
   if(mode==='proof-retry')unavailable=true;
  }else if(event.data.command==='release-proof')unavailable=false;
  // Observe only after guest cleanup, through pre-audit getters. Control
  // probes must not consume native errors or trigger the armed OOM.
  let nativeLive=-1;if(event.data.command==='stats'){
   nativeLive=0;for(const [object,gl]of programs)if(Reflect.apply(isProgram,gl,[object]))nativeLive++;
   for(const [object,gl]of shaders)if(Reflect.apply(isShader,gl,[object]))nativeLive++;
  }
  port.postMessage({id:event.data.id,lost,oom,injections,scopeRefusals,destroyCalls,created,deleted,nativeLive,
   bindings:registry?.list().length??-1,publicContexts:registry?.list().filter(b=>b.contextId!==null).length??-1,executions:registry?.executionRecords.size??-1});
 };port.start();});
await import(entry);removeEventListener('message',hold);for(const data of early)dispatchEvent(new MessageEvent('message',{data}));
`;
    const blob=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));urls.push(blob);super(blob,options);
    const channel=new MessageChannel();this.pending=channel.port2;ports.push(channel.port1);
   }
   postMessage(message:any,transfer?:any){if(this.pending&&message?.type==="init"){
    const port=this.pending;this.pending=null;super.postMessage({...message,__resetRetirementControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);
   }else super.postMessage(message,transfer);}
  }
  globalThis.Worker=ControlledWorker;let next=0;
  (window as any).__resetRetirementRequest=(command:string)=>new Promise((resolve,reject)=>{
   if(ports.length!==1){reject(new Error("missing owned retirement control"));return;}
   const port=ports[0]!,id=++next,timer=setTimeout(()=>reject(new Error("retirement control timeout")),5000);
   port.onmessage=event=>{if(event.data.id===id){clearTimeout(timer);resolve(event.data);}};port.start();port.postMessage({id,command});
  });
  (window as any).__disposeResetRetirement=()=>{for(const port of ports)port.close();globalThis.Worker=ActualWorker;for(const url of urls)URL.revokeObjectURL(url);};
 },mode);
}
