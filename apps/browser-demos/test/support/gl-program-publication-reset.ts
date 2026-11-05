import type {Page} from "@playwright/test";

/** One pending native OOM at logical publication's cleanup pre-drain. Only
 * numeric ownership/progress observations leave the disposable kernel realm. */
export async function installProgramPublicationReset(page:Page,corruptSnapshot=false):Promise<void> {
  await page.evaluate(corruptSnapshot=>{
    const ActualWorker=globalThis.Worker,ports:MessagePort[]=[],urls:string[]=[];
    class ControlledWorker extends ActualWorker {
      pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions) {
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href,journal=new URL("./webgl/program-journal.ts",entry).href;
        const bootstrap=`
const entry=${JSON.stringify(entry)},journalUrl=${JSON.stringify(journal)},corruptSnapshot=${JSON.stringify(corruptSnapshot)},OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),entry),options);}};
const early=[],hold=e=>{e.stopImmediatePropagation();early.push(e.data);};addEventListener('message',hold);
let armed=false,publishing=false,observing=false,injections=0,errors=0,partial=null,entries=0,duplicates=0,reads=0,snapshots=0,readonlyDepth=0,readonlyErrors=0,readonlyDeletes=0,corrupted=0;const entered=new Set(),owners=new Set(),executions=[],publications=[],selectionNames=[];
const programs=new Set(),shaders=new Set();let created=0,deleted=0;
const proto=WebGL2RenderingContext.prototype;
for(const [create,remove,set] of [['createProgram','deleteProgram',programs],['createShader','deleteShader',shaders]]){
 const make=proto[create],drop=proto[remove];
 proto[create]=function(...xs){const object=Reflect.apply(make,this,xs);if(object){set.add(object);created++;}return object;};
 proto[remove]=function(object){if(readonlyDepth)readonlyDeletes++;Reflect.apply(drop,this,[object]);if(object&&set.delete(object))deleted++;
};
}
const getError=proto.getError;
proto.getError=function(){if(readonlyDepth)readonlyErrors++;if(armed&&publishing){armed=false;injections++;errors++;return 0x505;}return Reflect.apply(getError,this,[]);};
addEventListener('message',event=>{if(event.data?.__publicationResetControl){const port=event.data.__publicationResetControl;
 port.onmessage=event=>{if(event.data.command==='arm'){armed=true;observing=true;}
 port.postMessage({id:event.data.id,armed,injections,errors,created,deleted,live:programs.size+shaders.size,programs:programs.size,shaders:shaders.size,partial,entries,duplicates,reads,snapshots,readonlyErrors,readonlyDeletes,corrupted,owners:[...owners],executions,publications,selectionNames});};port.start();}});
const instantiate=WebAssembly.instantiate;
WebAssembly.instantiate=async function(source,imports){
 if(!imports?.env?.host_gl_query)return Reflect.apply(instantiate,WebAssembly,[source,imports]);
 let memory=imports.env.memory;const query=imports.env.host_gl_query;
 const env={...imports.env,host_gl_query(...args){
  const op=args[1],pointer=Number(args[2]);let readonly=false;
  if(memory&&op===0x3c&&Number(args[3])>=4){const action=new DataView(memory.buffer).getUint32(pointer,true);
   readonly=action===6||action===7;if(observing){if(action===6)reads++;if(action===7)snapshots++;}}
  if(readonly)readonlyDepth++;try{
   const result=Reflect.apply(query,imports.env,args);
   if(readonly&&observing&&corruptSnapshot&&!corrupted&&result===48&&new DataView(memory.buffer).getUint32(pointer,true)===7){
    const view=new DataView(memory.buffer),out=Number(args[4]);view.setUint32(out+28,view.getUint32(out+28,true)+1,true);corrupted++;
   }
   return result;
  }finally{if(readonly)readonlyDepth--;}
 }};
 const result=await Reflect.apply(instantiate,WebAssembly,[source,{...imports,env}]);memory=(result.instance??result).exports.memory??memory;return result;
};
await import(entry);
const {GlProgramJournal,programJournalSequence}=await import(journalUrl),publish=GlProgramJournal.prototype.publish;
GlProgramJournal.prototype.publish=function(...args){
 if(observing){owners.add(this.id);const key=[this.id,args[1],args[2],args[3]].join(':');if(entered.has(key))duplicates++;entered.add(key);entries++;publications.push({owner:this.id,ticket:args[2],sequence:args[3],name:args[4]});}
 publishing=true;try{return Reflect.apply(publish,this,args);}catch(error){
 if(injections&&!partial){const words=args[0].programJournalControl.receipt;
 partial={status:words[0],transaction:words[1],action:words[2],sequence:programJournalSequence(args[0]),ticket:this.publishedTicket};}
 throw error;
}finally{publishing=false;}};
const execute=GlProgramJournal.prototype.execute;
GlProgramJournal.prototype.execute=function(...args){if(observing){executions.push({owner:this.id,ticket:args[1]});selectionNames.push(this.slots[args[0]].name);}return Reflect.apply(execute,this,args);};
removeEventListener('message',hold);for(const data of early)dispatchEvent(new MessageEvent('message',{data}));
`;
        const blob=URL.createObjectURL(new Blob([bootstrap],{type:"text/javascript"}));urls.push(blob);super(blob,options);
        const channel=new MessageChannel();this.pending=channel.port2;ports.push(channel.port1);
      }
      postMessage(message:any,transfer?:any) {
        if(this.pending&&message?.type==="init") {
          const port=this.pending;this.pending=null;
          super.postMessage({...message,__publicationResetControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);
        }else super.postMessage(message,transfer);
      }
    }
    globalThis.Worker=ControlledWorker;let next=0;
    (window as any).__publicationResetRequest=(command:string)=>new Promise((resolve,reject)=>{
      if(ports.length!==1){reject(new Error(`publication reset control count ${ports.length}`));return;}
      const id=++next,port=ports[0]!,timer=setTimeout(()=>reject(new Error("publication reset control timeout")),5000);
      port.onmessage=event=>{if(event.data.id===id){clearTimeout(timer);resolve(event.data);}};
      port.start();port.postMessage({id,command});
    });
    (window as any).__disposePublicationReset=()=>{for(const port of ports)port.close();globalThis.Worker=ActualWorker;for(const url of urls)URL.revokeObjectURL(url);};
  },corruptSnapshot);
}
