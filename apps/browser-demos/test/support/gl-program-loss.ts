import type {Page} from "@playwright/test";

/** Native OOM below the audit wrapper, controlled in the disposable kernel
 * realm. Only counters cross the independent port; guest memory stays there. */
export async function installProgramLossProbe(page:Page):Promise<void> {
  await page.evaluate(()=>{
    const ActualWorker=globalThis.Worker,controls:MessagePort[]=[],urls:string[]=[];
    class ControlledWorker extends ActualWorker {
      pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions) {
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href;
        const bootstrap=`
const WorkerBase=${JSON.stringify(entry)},OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),WorkerBase),options);}};
const live=new Set(),pending=new WeakSet();let armed=false,created=0,deleted=0,injections=0,errors=0;
const proto=WebGL2RenderingContext.prototype,create=proto.createProgram,remove=proto.deleteProgram,use=proto.useProgram,error=proto.getError;
proto.createProgram=function(...xs){const p=Reflect.apply(create,this,xs);if(p){created++;live.add(p);}return p;};
proto.deleteProgram=function(p){Reflect.apply(remove,this,[p]);if(p&&live.delete(p))deleted++;};
proto.useProgram=function(p){Reflect.apply(use,this,[p]);if(armed&&p===null){armed=false;pending.add(this);injections++;}};
proto.getError=function(){if(pending.delete(this)){errors++;return 0x505;}return Reflect.apply(error,this,[]);};
addEventListener('message',event=>{if(event.data?.__programLossControl){const port=event.data.__programLossControl;
port.onmessage=event=>{const request=event.data;if(request.command==='arm')armed=true;
port.postMessage({id:request.id,armed,created,deleted,live:live.size,injections,errors});};port.start();}});
`;
        const blob=URL.createObjectURL(new Blob([bootstrap,"\nimport ",JSON.stringify(entry),";"],{type:"text/javascript"}));
        urls.push(blob);super(blob,options);
        const channel=new MessageChannel();this.pending=channel.port2;controls.push(channel.port1);
      }
      postMessage(message:any,transfer?:any) {
        if(this.pending&&message?.type==="init") {
          const port=this.pending;this.pending=null;
          super.postMessage({...message,__programLossControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);
        }else super.postMessage(message,transfer);
      }
    }
    globalThis.Worker=ControlledWorker;let next=0;
    (window as any).__programLossRequest=(command:string)=>new Promise((resolve,reject)=>{
      if(controls.length!==1){reject(new Error(`program loss control count ${controls.length}`));return;}
      const id=++next,port=controls[0]!,timer=setTimeout(()=>reject(new Error("program loss control timeout")),5000);
      port.onmessage=event=>{if(event.data.id===id){clearTimeout(timer);resolve(event.data);}};
      port.start();port.postMessage({id,command});
    });
    (window as any).__disposeProgramLossProbe=()=>{
      for(const port of controls)port.close();globalThis.Worker=ActualWorker;
      for(const url of urls)URL.revokeObjectURL(url);
    };
  });
}
