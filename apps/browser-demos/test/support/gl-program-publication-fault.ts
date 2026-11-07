import type {Page} from "@playwright/test";

/** Inject after real metadata effects, not before admission. Only a bounded
 * numeric receipt snapshot leaves the disposable kernel realm. */
export async function installProgramPublicationFault(page:Page,kind:"publication"|"receipt"):Promise<void> {
  await page.evaluate(kind=>{
    const ActualWorker=globalThis.Worker,ports:MessagePort[]=[],urls:string[]=[],faults:any[]=[];
    let observe:((value:any)=>void)|undefined;
    class ControlledWorker extends ActualWorker {
      pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions) {
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href,journal=new URL("./webgl/program-journal.ts",entry).href;
        const bootstrap=`
const entry=${JSON.stringify(entry)},journalUrl=${JSON.stringify(journal)},kind=${JSON.stringify(kind)};
const OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),entry),options);}};
const early=[];const hold=event=>{event.stopImmediatePropagation();early.push(event.data);};
let control,published=0,injected=false;
addEventListener('message',event=>{if(event.data?.__publicationFaultControl)control=event.data.__publicationFaultControl;});
addEventListener('message',hold);
await import(entry);
const {GlProgramJournal}=await import(journalUrl);
const prototype=GlProgramJournal.prototype,publish=prototype.publish,getTicket=Object.getOwnPropertyDescriptor(prototype,'publishedTicket').get;
function fail(owner){
 injected=true;
 const words=owner.binding.programJournalControl.receipt;
 control.postMessage({kind,published,status:words[0],transaction:words[1],action:words[2],ticket:Reflect.apply(getTicket,owner,[])});
 throw new Error('controlled journal '+kind+' failure after metadata effects');
}
prototype.publish=function(...args){const accepted=Reflect.apply(publish,this,args);if(accepted){published++;if(kind==='publication'&&!injected)fail(this);}return accepted;};
Object.defineProperty(prototype,'publishedTicket',{configurable:true,get(){if(kind==='receipt'&&published&&!injected)fail(this);return Reflect.apply(getTicket,this,[]);}});
removeEventListener('message',hold);for(const data of early)dispatchEvent(new MessageEvent('message',{data}));
`;
        const blob=URL.createObjectURL(new Blob([bootstrap],{type:"text/javascript"}));urls.push(blob);super(blob,options);
        const channel=new MessageChannel();this.pending=channel.port2;ports.push(channel.port1);
        channel.port1.onmessage=event=>{faults.push(event.data);observe?.(event.data);};channel.port1.start();
      }
      postMessage(message:any,transfer?:any) {
        if(this.pending&&message?.type==="init") {
          const port=this.pending;this.pending=null;
          super.postMessage({...message,__publicationFaultControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);
        }else super.postMessage(message,transfer);
      }
    }
    globalThis.Worker=ControlledWorker;
    (window as any).__programPublicationFault=()=>faults.length?Promise.resolve(faults[0]):new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("publication fault was not observed")),5000);
      observe=value=>{clearTimeout(timer);observe=undefined;resolve(value);};
    });
    (window as any).__disposeProgramPublicationFault=()=>{
      for(const port of ports)port.close();globalThis.Worker=ActualWorker;
      for(const url of urls)URL.revokeObjectURL(url);
    };
  },kind);
}
