import type {Page} from "@playwright/test";

/** Count real native programs in the disposable kernel realm. Query before
 * machine teardown: terminating the entire worker must not hide a leaked
 * context, capture or unsubmitted journal owner. No guest memory is relayed. */
export async function installProgramLifetimeProbe(page:Page):Promise<void> {
  await page.evaluate(bootstrap=>{
    const ActualWorker=globalThis.Worker,controls:MessagePort[]=[],urls:string[]=[];
    class ControlledWorker extends ActualWorker {
      port!:MessagePort;pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions) {
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href;
        const blob=URL.createObjectURL(new Blob(["const __programWorkerBase=",JSON.stringify(entry),";\n",
          bootstrap,"\nimport ",JSON.stringify(entry),";"],{type:"text/javascript"}));
        urls.push(blob);super(blob,options);
        const channel=new MessageChannel();this.port=channel.port1;this.pending=channel.port2;controls.push(this.port);
      }
      postMessage(message:any,transfer?:any) {
        if(this.pending&&message?.type==="init") {
          const port=this.pending;this.pending=null;
          super.postMessage({...message,__programLifetimeControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);
        }else super.postMessage(message,transfer);
      }
    }
    globalThis.Worker=ControlledWorker;
    (window as any).__programLifetimeStats=()=>new Promise<{created:number;deleted:number;live:number}>((resolve,reject)=>{
      if(controls.length!==1){reject(new Error(`program lifetime kernel count ${controls.length}`));return;}
      const port=controls[0]!,timer=setTimeout(()=>reject(new Error("program lifetime response timeout")),5000);
      port.onmessage=e=>{clearTimeout(timer);resolve(e.data);};port.start();port.postMessage("stats");
    });
    (window as any).__disposeProgramLifetimeProbe=()=>{
      for(const port of controls)port.close();globalThis.Worker=ActualWorker;
      for(const url of urls)URL.revokeObjectURL(url);
    };
  },`
const OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),__programWorkerBase),options);}};
const live=new Set();let created=0,deleted=0;
const proto=WebGL2RenderingContext.prototype,create=proto.createProgram,remove=proto.deleteProgram;
proto.createProgram=function(...xs){const program=Reflect.apply(create,this,xs);if(program){live.add(program);created++;}return program;};
proto.deleteProgram=function(program){Reflect.apply(remove,this,[program]);if(program&&live.delete(program))deleted++;};
addEventListener("message",event=>{if(event.data?.__programLifetimeControl){const port=event.data.__programLifetimeControl;port.onmessage=()=>port.postMessage({created,deleted,live:live.size});port.start();}});
`);
}
