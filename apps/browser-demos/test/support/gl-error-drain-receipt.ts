import type {Page} from "@playwright/test";
/** Hold the kernel's initialization until its realm-local import wrapper is
 * installed. No live guest memory, renderer or binding leaves that realm. */
export async function installErrorDrainReceiptFault(page:Page,mode:string):Promise<void>{
 await page.evaluate(mode=>{
  const ActualWorker=globalThis.Worker,ports:MessagePort[]=[],urls:string[]=[];
  class ControlledWorker extends ActualWorker{
   pending!:MessagePort|null;
   constructor(url:string|URL,options?:WorkerOptions){
    if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
    const entry=new URL(String(url),location.href).href;
    const source=`
const entry=${JSON.stringify(entry)},mode=${JSON.stringify(mode)},OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),entry),options);}};
const early=[],hold=e=>{e.stopImmediatePropagation();early.push(e.data);};addEventListener('message',hold);
let armed=false,observing=false,injections=0,recoveryFaults=0,reads=0,drains=0,requestMode=0;const transactions=[];
addEventListener('message',event=>{if(event.data?.__errorDrainControl){const port=event.data.__errorDrainControl;
 port.onmessage=event=>{if(event.data.command==='arm'){armed=true;observing=true;}
 port.postMessage({id:event.data.id,armed,injections,recoveryFaults,reads,drains,requestMode,transactions});};port.start();}});
const instantiate=WebAssembly.instantiate;
WebAssembly.instantiate=async function(source,imports){
 if(!imports?.env?.host_gl_query)return Reflect.apply(instantiate,WebAssembly,[source,imports]);
 let memory=imports.env.memory;const query=imports.env.host_gl_query;
 const env={...imports.env,host_gl_query(...args){
  const op=args[1],input=Number(args[2]),length=Number(args[3]),out=Number(args[4]);
  if(op===0x3d){reads++;const result=Reflect.apply(query,imports.env,args);
   if(mode==='read-lost'&&injections&&!recoveryFaults){recoveryFaults++;return -5;}return result;}
  const result=Reflect.apply(query,imports.env,args);
  if(observing&&op===1&&length>=8&&result>0){
   drains++;if(length===12)transactions.push(new DataView(memory.buffer).getUint32(input+8,true));
  }
  if(armed&&op===1&&length>=8&&result>0){
   const view=new DataView(memory.buffer);requestMode=view.getUint32(input+4,true);armed=false;
   if(mode==='none')return result;
   injections++;const offset=result===52?8:0;
   if(mode==='magic')view.setUint32(out+result-4,0,true);
   else if(mode==='duplicate')view.setUint32(out+offset+12,view.getUint32(out+offset+8,true),true);
   else return -5;
  }
  return result;
 }};
 const result=await Reflect.apply(instantiate,WebAssembly,[source,{...imports,env}]);memory=(result.instance??result).exports.memory??memory;return result;
};
await import(entry);removeEventListener('message',hold);for(const data of early)dispatchEvent(new MessageEvent('message',{data}));
`;
    const blob=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));urls.push(blob);super(blob,options);
    const channel=new MessageChannel();this.pending=channel.port2;ports.push(channel.port1);
   }
   postMessage(message:any,transfer?:any){
    if(this.pending&&message?.type==="init"){const port=this.pending;this.pending=null;
     super.postMessage({...message,__errorDrainControl:port},[...(Array.isArray(transfer)?transfer:transfer?.transfer??[]),port]);
    }else super.postMessage(message,transfer);
   }
  }
  globalThis.Worker=ControlledWorker;let next=0;
  (window as any).__errorDrainRequest=(command:string)=>new Promise((resolve,reject)=>{
   if(ports.length!==1){reject(new Error(`error-drain control count ${ports.length}`));return;}
   const id=++next,port=ports[0]!,timer=setTimeout(()=>reject(new Error("error-drain control timeout")),5000);
   port.onmessage=event=>{if(event.data.id===id){clearTimeout(timer);resolve(event.data);}};
   port.start();port.postMessage({id,command});
  });
  (window as any).__disposeErrorDrain=()=>{for(const port of ports)port.close();globalThis.Worker=ActualWorker;for(const url of urls)URL.revokeObjectURL(url);};
 },mode);
}
