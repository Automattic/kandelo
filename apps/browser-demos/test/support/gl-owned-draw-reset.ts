import type {Page} from "@playwright/test";

/** Inject one native OOM below the normal batch sampler, in the disposable
 * kernel realm. Independent control ports carry counters, never guest memory. */
export async function installOwnedDrawResetProbe(page:Page):Promise<void>{
  await page.evaluate(()=>{
    const ActualWorker=globalThis.Worker,ports:MessagePort[]=[],urls:string[]=[];
    class ControlledWorker extends ActualWorker{
      pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions){
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href;
        const bootstrap=`
const OrdinaryWorker=globalThis.Worker,base=${JSON.stringify(entry)};
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),base),options);}};
const programs=new Set(),buffers=new Set(),pending=new WeakSet();let armed=false,created=0,deleted=0,bufferCreated=0,bufferDeleted=0,injections=0,errors=0,draws=0;
const proto=WebGL2RenderingContext.prototype,create=proto.createProgram,remove=proto.deleteProgram,createBuffer=proto.createBuffer,removeBuffer=proto.deleteBuffer,draw=proto.drawArrays,error=proto.getError;
proto.createProgram=function(...xs){const value=Reflect.apply(create,this,xs);if(value){created++;programs.add(value);}return value;};
proto.deleteProgram=function(value){Reflect.apply(remove,this,[value]);if(value&&programs.delete(value))deleted++;};
proto.createBuffer=function(...xs){const value=Reflect.apply(createBuffer,this,xs);if(value){bufferCreated++;buffers.add(value);}return value;};
proto.deleteBuffer=function(value){Reflect.apply(removeBuffer,this,[value]);if(value&&buffers.delete(value))bufferDeleted++;};
proto.drawArrays=function(...xs){Reflect.apply(draw,this,xs);draws++;if(armed){armed=false;injections++;pending.add(this);}};
proto.getError=function(){if(pending.delete(this)){errors++;return 0x505;}return Reflect.apply(error,this,[]);};
addEventListener('message',event=>{if(event.data?.__ownedDrawResetControl){const port=event.data.__ownedDrawResetControl;port.onmessage=event=>{const {id,command}=event.data;if(command==='arm')armed=true;port.postMessage({id,armed,created,deleted,live:programs.size,bufferCreated,bufferDeleted,bufferLive:buffers.size,injections,errors,draws});};port.start();}});
`;
        const blob=URL.createObjectURL(new Blob([bootstrap,"\nimport ",JSON.stringify(entry),";"],{type:"text/javascript"}));urls.push(blob);super(blob,options);
        const channel=new MessageChannel();this.pending=channel.port2;ports.push(channel.port1);
      }
      postMessage(message:any,transfer?:any){
        if(this.pending&&message?.type==="init"){const port=this.pending;this.pending=null;super.postMessage({...message,__ownedDrawResetControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);}
        else super.postMessage(message,transfer);
      }
    }
    globalThis.Worker=ControlledWorker;let next=0;
    (window as any).__ownedDrawResetRequest=(command:string)=>new Promise((resolve,reject)=>{
      if(ports.length!==1){reject(new Error(`owned draw reset kernel count ${ports.length}`));return;}
      const id=++next,port=ports[0]!,timer=setTimeout(()=>reject(new Error("owned draw reset control timeout")),5000);
      port.onmessage=event=>{if(event.data.id===id){clearTimeout(timer);resolve(event.data);}};port.start();port.postMessage({id,command});
    });
    (window as any).__disposeOwnedDrawResetProbe=()=>{for(const port of ports)port.close();globalThis.Worker=ActualWorker;for(const url of urls)URL.revokeObjectURL(url);};
  });
}
