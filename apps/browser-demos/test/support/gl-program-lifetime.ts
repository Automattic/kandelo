import type {Page} from "@playwright/test";

/** Count real native programs in the disposable kernel realm. Query before
 * machine teardown: terminating the entire worker must not hide a leaked
 * context, capture or unsubmitted journal owner. No guest memory is relayed. */
export async function installProgramLifetimeProbe(page:Page,recoverPublication:false|"lost-publication"|"refuse-registration"|"malformed-reserve"|"indeterminate-publication"=false,captureFault?:{action:1|3;failure:number},coldFault?:{action:10|11|12|13}):Promise<void> {
  await page.evaluate(({bootstrap,recoverPublication,captureFault,coldFault})=>{
    const ActualWorker=globalThis.Worker,controls:MessagePort[]=[],urls:string[]=[];
    class ControlledWorker extends ActualWorker {
      port!:MessagePort;pending!:MessagePort|null;
      constructor(url:string|URL,options?:WorkerOptions) {
        if(!String(url).includes("browser-kernel-worker-entry"))return new ActualWorker(url,options) as ControlledWorker;
        const entry=new URL(String(url),location.href).href;
        // Fault injection must precede the runtime's captured Wasm intrinsics.
        // Retain init messages until dynamic import installs its real handler.
        const hold=(recoverPublication||captureFault||coldFault)?"const __early=[];const __hold=e=>{e.stopImmediatePropagation();__early.push(e.data);};addEventListener('message',__hold);\n":"";
        const load=(recoverPublication||captureFault||coldFault)?"\nawait import("+JSON.stringify(entry)+");removeEventListener('message',__hold);for(const data of __early)dispatchEvent(new MessageEvent('message',{data}));":"\nimport "+JSON.stringify(entry)+";";
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
    (window as any).__programLifetimeStats=()=>new Promise<{created:number;deleted:number;live:number;recovery:{dropped:number;duplicates:number;reads:number;refused:number;corrupted:number;unreleasedCaptures:number;publications:number;refusedReads:number;duplicateIntents:number};captureFault:{armed:boolean;injected:number;acquires:number;releases:number}}>((resolve,reject)=>{
      if(controls.length!==1){reject(new Error(`program lifetime kernel count ${controls.length}`));return;}
      const port=controls[0]!,timer=setTimeout(()=>reject(new Error("program lifetime response timeout")),5000);
      port.onmessage=e=>{clearTimeout(timer);resolve(e.data);};port.start();port.postMessage("stats");
    });
    (window as any).__disposeProgramLifetimeProbe=()=>{
      for(const port of controls)port.close();globalThis.Worker=ActualWorker;
      for(const url of urls)URL.revokeObjectURL(url);
    };
  },{recoverPublication,captureFault,coldFault,bootstrap:`
const OrdinaryWorker=globalThis.Worker;
globalThis.Worker=class extends OrdinaryWorker{constructor(url,options){super(new URL(String(url),__programWorkerBase),options);}};
const live=new Set();let created=0,deleted=0;
const recovery={dropped:0,duplicates:0,reads:0,refused:0,corrupted:0,publications:0,refusedReads:0,duplicateIntents:0},entered=new Set(),captures=new Set(),intents=new Set();
const faultMode=${JSON.stringify(recoverPublication)},captureFault=${JSON.stringify(captureFault)??"null"};
const captureFaultStats={armed:false,injected:0,acquires:0,releases:0};
const coldFault=${JSON.stringify(coldFault)??"null"},coldFaultStats={injected:0,receiptStatus:-1,attempts:0,accepted:0};
if(faultMode||captureFault||coldFault){
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
      if(coldFault&&op===0x3b&&action===coldFault.action)coldFaultStats.attempts++;
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
      const captureAttempt=op===0x3a&&captureFaultStats.armed;
      if(captureAttempt){if(action===1)captureFaultStats.acquires++;if(action===3)captureFaultStats.releases++;}
      const failure=captureAttempt&&captureFault&&action===captureFault.action&&!captureFaultStats.injected?captureFault.failure:0;
      if(failure){captureFaultStats.injected++;}
      if(failure===1)return -5; // Definite nonentry.
      if(failure===2){ // Canonical private refusal, with no invented GL error.
        const output=Number(args[4]);[1,0,0,0x47514c33].forEach((word,i)=>view.setUint32(output+i*4,word,true));return 16;
      }
      let result;
      if(coldFault&&op===0x3b&&action===coldFault.action&&!coldFaultStats.injected){
        const map=Array.prototype.map;
        // Refuse real host metadata before native effects. The normal query
        // seals its actual receipt; no fabricated reply bypasses recovery.
        Array.prototype.map=function(callback,thisArg){
          const metadata=action===10?this[0]?.ready===false&&this[0]?.token===0:!!this[0]?.restore;
          if(metadata&&!coldFaultStats.injected){
            coldFaultStats.injected++;Array.prototype.map=map;
            throw new RangeError("cold owned receiver metadata refused");
          }
          return Reflect.apply(map,this,[callback,thisArg]);
        };
        try{result=Reflect.apply(query,imports.env,args);}finally{Array.prototype.map=map;}
        if(result===48)coldFaultStats.receiptStatus=view.getUint32(Number(args[4]),true);
      }else result=Reflect.apply(query,imports.env,args);
      if(coldFault&&op===0x3b&&action===coldFault.action&&result===48&&view.getUint32(Number(args[4]),true)===0)coldFaultStats.accepted++;
      if(op===0x3a&&result===16&&view.getUint32(Number(args[4]),true)===0&&view.getUint32(Number(args[4])+4,true)===1){
        if(action===1)captures.add([args[0],args[6],view.getUint32(Number(args[4])+8,true)].join(':'));
        if(action===3)captures.delete([args[0],args[6],view.getUint32(pointer+4,true)].join(':'));
      }
      // Read-only actions use word1 as a journal identity, not a transaction.
      // Counting them as mutations invents duplicate-replay reports.
      if(journal&&op!==0x3a&&action!==6&&action!==7&&action!==8&&action!==9&&result===48){
        const key=[args[0],args[6],tx].join(':');
        if(entered.has(key))recovery.duplicates++;entered.add(key);
      }
      if(captureFault&&op===0x3b&&action===1&&result===48&&view.getUint32(Number(args[4]),true)===0)captureFaultStats.armed=true;
      if(failure&&result===16){
        const output=Number(args[4]);
        if(failure===3)return -5; // Effect happened; the response was lost.
        if(failure===4)view.setUint32(output+12,0,true);
        if(failure===5)view.setUint32(output,9,true);
        if(failure===6)view.setUint32(output,1,true); // Contradictory acceptance.
        if(failure===7)view.setUint32(output+8,action===1?0:17,true);
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
addEventListener("message",event=>{if(event.data?.__programLifetimeControl){const port=event.data.__programLifetimeControl;port.onmessage=()=>port.postMessage({created,deleted,live:live.size,recovery:{...recovery,unreleasedCaptures:captures.size},captureFault:captureFaultStats,coldFault:coldFaultStats});port.start();}});
`});
}
