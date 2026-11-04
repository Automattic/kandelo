import type {Page} from "@playwright/test";

/** Count real native programs in the disposable kernel realm. Query before
 * machine teardown: terminating the entire worker must not hide a leaked
 * context, capture or unsubmitted journal owner. No guest memory is relayed. */
export async function installProgramLifetimeProbe(page:Page,recoverPublication:false|"lost-publication"|"refuse-registration"|"malformed-reserve"|"indeterminate-publication"=false):Promise<void> {
  await page.evaluate(({bootstrap,recoverPublication})=>{
    const ActualWorker=globalThis.Worker,controls:MessagePort[]=[],urls:string[]=[];
    class ControlledWorker extends ActualWorker {
      port!:MessagePort;pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions) {
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href;
        // Fault injection must precede the runtime's captured Wasm intrinsics.
        // Retain init messages until dynamic import installs its real handler.
        const hold=recoverPublication?"const __early=[];const __hold=e=>{e.stopImmediatePropagation();__early.push(e.data);};addEventListener('message',__hold);\n":"";
        const load=recoverPublication?"\nawait import("+JSON.stringify(entry)+");removeEventListener('message',__hold);for(const data of __early)dispatchEvent(new MessageEvent('message',{data}));":"\nimport "+JSON.stringify(entry)+";";
        const blob=URL.createObjectURL(new Blob(["const __programWorkerBase=",JSON.stringify(entry),";\n",hold,
          bootstrap,load],{type:"text/javascript"}));
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
    (window as any).__programLifetimeStats=()=>new Promise<{created:number;deleted:number;live:number;recovery:{dropped:number;duplicates:number;reads:number;refused:number;corrupted:number;unreleasedCaptures:number;publications:number;refusedReads:number;duplicateIntents:number}}>((resolve,reject)=>{
      if(controls.length!==1){reject(new Error(`program lifetime kernel count ${controls.length}`));return;}
      const port=controls[0]!,timer=setTimeout(()=>reject(new Error("program lifetime response timeout")),5000);
      port.onmessage=e=>{clearTimeout(timer);resolve(e.data);};port.start();port.postMessage("stats");
    });
    (window as any).__disposeProgramLifetimeProbe=()=>{
      for(const port of controls)port.close();globalThis.Worker=ActualWorker;
      for(const url of urls)URL.revokeObjectURL(url);
    };
  },{recoverPublication,bootstrap:`
const OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),__programWorkerBase),options);}};
const live=new Set();let created=0,deleted=0;
const recovery={dropped:0,duplicates:0,reads:0,refused:0,corrupted:0,publications:0,refusedReads:0,duplicateIntents:0},entered=new Set(),captures=new Set(),intents=new Set();
const faultMode=${JSON.stringify(recoverPublication)};
if(faultMode){
  const instantiate=WebAssembly.instantiate;
  WebAssembly.instantiate=async function(source,imports){
    if(!imports?.env?.host_gl_query)return Reflect.apply(instantiate,WebAssembly,[source,imports]);
    let memory=imports.env.memory;const query=imports.env.host_gl_query;
    const env={...imports.env,host_gl_query(...args){
      const op=args[1],pointer=Number(args[2]),length=Number(args[3]);
      const journal=memory&&(op===0x3a||op===0x3b||op===0x3c)&&length>=4;
      const view=journal?new DataView(memory.buffer):null;
      const action=view?.getUint32(pointer,true);
      if(action===6)recovery.reads++;
      if(action===3&&op!==0x3a){
        recovery.publications++;
        for(let i=0;i<view.getUint32(pointer+8,true);i++){
          const row=pointer+12+i*32,key=[args[0],view.getUint32(row,true),view.getUint32(row+4,true),view.getUint32(row+8,true),view.getUint32(row+12,true)].join(':');
          if(intents.has(key))recovery.duplicateIntents++;intents.add(key);
        }
      }
      if(faultMode==='indeterminate-publication'&&action===6&&recovery.dropped&&!recovery.refusedReads){recovery.refusedReads++;return -5;}
      const tx=journal&&length>=8?view.getUint32(pointer+4,true):0;
      if(op!==0x3a&&action===2&&faultMode==='refuse-registration'&&!recovery.refused){recovery.refused++;return -5;}
      const result=Reflect.apply(query,imports.env,args);
      if(op===0x3a&&result===16&&view.getUint32(Number(args[4]),true)===0&&view.getUint32(Number(args[4])+4,true)===1){
        if(action===1)captures.add([args[0],args[6],view.getUint32(Number(args[4])+8,true)].join(':'));
        if(action===3)captures.delete([args[0],args[6],view.getUint32(pointer+4,true)].join(':'));
      }
      if(journal&&op!==0x3a&&action!==6&&action!==7&&result===48){
        const key=[args[0],args[6],tx].join(':');
        if(entered.has(key))recovery.duplicates++;entered.add(key);
      }
      // The real operation and retained ledger complete, but its success
      // response is lost before the kernel copies anything to the guest.
      if((faultMode==='lost-publication'||faultMode==='indeterminate-publication')&&action===3&&result===48&&!recovery.dropped&&view.getUint32(Number(args[4]),true)===0){
        recovery.dropped++;return -5;
      }
      if(faultMode==='malformed-reserve'&&op!==0x3a&&result===48){
        if(action===1&&!recovery.corrupted){recovery.corrupted++;view.setUint32(Number(args[4])+16,17,true);}
        else if(action===2&&recovery.corrupted===1){recovery.corrupted++;view.setUint32(Number(args[4]),1,true);}
      }
      return result;
    }};
    const result=await Reflect.apply(instantiate,WebAssembly,[source,{...imports,env}]);
    memory=(result.instance??result).exports.memory??memory;return result;
  };
}
const proto=WebGL2RenderingContext.prototype,create=proto.createProgram,remove=proto.deleteProgram;
proto.createProgram=function(...xs){const program=Reflect.apply(create,this,xs);if(program){live.add(program);created++;}return program;};
proto.deleteProgram=function(program){Reflect.apply(remove,this,[program]);if(program&&live.delete(program))deleted++;};
addEventListener("message",event=>{if(event.data?.__programLifetimeControl){const port=event.data.__programLifetimeControl;port.onmessage=()=>port.postMessage({created,deleted,live:live.size,recovery:{...recovery,unreleasedCaptures:captures.size}});port.start();}});
`});
}
